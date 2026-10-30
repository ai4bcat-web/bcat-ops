# Step N1 — Aljex bulk import plan

## Goal
Deliver My Brokerage → Settings → Company → **Import from Aljex**: a CSV upload that maps Aljex export rows into shipments, receivables, payables, customers and locations, with dry-run preview, per-row errors, idempotent re-runs, an audit row per import, and owner/ADMIN-only access.

## Out of scope for N1
- XLSX parsing: no existing dependency; CSV is the supported format. XLSX can be added later by converting to CSV or installing `xlsx`.
- Historical/closed loads: N1 imports open/active shipments plus their AR/AP. Historical loads remain a future archive import.
- Real-time Aljex API: this is a one-time bulk file import.
- Carrier directory import: N1 resolves carrier by name only (snapshot on the load). A full carrier directory import stays with the existing Import page.

## Expected Aljex CSV columns (documented, best-effort mapping)

The importer accepts these headers and common aliases. Columns not listed are ignored.

| Aljex concept | Accepted headers | Maps to |
|---|---|---|
| PRO # | `Pro #`, `PRO`, `ProNumber`, `Pro No` | Shipment.number seed / Load.aljexId |
| PO / TMS ID | `PO #`, `TMS ID`, `TmsId`, `Order #` | Load.tmsId |
| PU # | `PU #`, `Pickup #`, `PuNumber` | Load.pickupNumber |
| Customer | `Customer`, `Shipper`, `Customer Name` | Customer name (resolved/created) |
| Customer MC | `Customer MC`, `Shipper MC`, `Cust MC` | Customer.mcNumber |
| Origin name | `Origin`, `Shipper Name`, `Pickup Name` | Stop[0].name / Load.originName |
| Origin city | `Origin City`, `From City` | Stop[0].city / Load.originCity |
| Origin state | `Origin State`, `From State` | Stop[0].state |
| Origin zip | `Origin Zip`, `From Zip` | Stop[0].zip |
| Destination name | `Destination`, `Consignee Name`, `Delivery Name` | Stop[last].name / Load.destinationName |
| Destination city | `Destination City`, `To City` | Stop[last].city / Load.destinationCity |
| Destination state | `Destination State`, `To State` | Stop[last].state |
| Destination zip | `Destination Zip`, `To Zip` | Stop[last].zip |
| Pickup date | `Pickup Date`, `Ship Date`, `Pickup At` | Stop[0].appt |
| Delivery date | `Delivery Date`, `Deliver By`, `Delivery At` | Stop[last].appt |
| Equipment | `Equipment`, `Equip Type`, `Trailer Type` | Load.equipmentType / Order.equipmentType |
| Commodity | `Commodity`, `Description`, `Freight Desc` | Load.commodity |
| Weight | `Weight`, `Weight Lbs`, `Total Weight` | Load.weight |
| Pieces | `Pieces`, `Qty`, `Pallets` | Load.pieces |
| Miles | `Miles`, `Trip Miles`, `Distance` | Load.miles |
| Customer rate | `Customer Rate`, `Revenue`, `Sell Rate`, `Total Rate` | Customer LINEHAUL charge (cents) |
| Carrier rate | `Carrier Rate`, `Cost`, `Buy Rate`, `Pay Rate` | Carrier LINEHAUL charge (cents) |
| Carrier name | `Carrier`, `Carrier Name`, `Booked Carrier` | Load.carrierName / LoadCarrier carrier snapshot |
| Carrier MC | `Carrier MC`, `Carrier MC #` | Carrier lookup (not full directory write) |
| Invoice # | `Invoice #`, `Invoice Number`, `AR Invoice` | Invoice.id |
| Invoice date | `Invoice Date`, `Invoiced At` | Invoice.issuedAt |
| Invoice paid date | `Paid Date`, `Paid At`, `Payment Date` | Invoice.paidAt / Payment |
| Invoice amount | `Invoice Amount`, `AR Amount` | Invoice.totalCents |
| Carrier bill # | `Bill #`, `Carrier Bill #`, `AP Invoice` | CarrierBill.billNumber |
| Carrier bill amount | `Bill Amount`, `AP Amount` | CarrierBill.amountCents |
| Status | `Status`, `Shipment Status`, `Load Status` | Shipment.status / Load.status mapping |

## Status mapping (Aljex → Shipment.status / Load.status)

| Aljex status | Shipment / Load status |
|---|---|
| Open, New, Available, Building | `OPEN` / `SOURCING` |
| Covered, Booked | `BOOKED` |
| Dispatched, Assigned | `DISPATCHED` |
| Loading, At Pickup | `LOADING` |
| Picked Up, En Route, In Transit | `IN_TRANSIT` |
| Arrived At Delivery, Unloading | `UNLOADING` |
| Delivered | `DELIVERED` |
| On Hold, Hold | `ON_HOLD` |
| Canceled, Cancelled | `CANCELED` |
| Invoiced, Billed | `DELIVERED` + Order.arStatus `UNPAID` |
| Paid | `DELIVERED` + Order.arStatus `PAID` |

Unknown status values are accepted as `OPEN` with a warning in the per-row note.

## Architecture

- **Dedicated Lambda**: `amplify/functions/tms-aljex-import/`. It touches Shipment, Order, Load, LoadFinancials, LoadCharge, Customer, Location, Invoice, InvoiceLine, CarrierBill, ProClaim, AuditLog, and AljexImportJob. A dedicated Lambda avoids bloating `tms-directory-actions` and keeps the import's idempotency logic in one place.
- **Schema**: add `AljexImportJob` model (id, status, fileName, fileHash, mapping, rowCount, counts, errorKey, dryRun, note, createdBy, appliedAt, appliedBy).
- **Storage**: uploads land under `imports/aljex/{fileHash}-{timestamp}-{safeName}`; no new prefix needed (`imports/*` already exists from Step L).
- **Idempotency**: `id = aljex:{fileHash}`. A conditional PutItem on `AljexImportJob` makes re-running the same file a no-op that returns the first result. Per-PRO idempotency: check `ProClaim`; if claimed by a different origin, report conflict.
- **Customer resolution**: match by MC → by normalized exact name → create. A create is only done on apply, not on dry-run.
- **Location resolution**: match by normalized name + city, or by normalized street address if present. Create on apply if not found.
- **Shipment creation**: uses the same row shapes as `tms-shipment-actions` `CREATE_SHIPMENT`, but written directly via DynamoDB SDK inside the import Lambda. The import Lambda owns the transaction so it can create Shipment + Order + Load + LoadFinancials + LoadCharge + ProClaim + (Invoice/InvoiceLine) + (CarrierBill) in one `TransactWriteItems` per row, falling back to sequential writes where row count exceeds the 100-item transaction cap.
- **AR import**: rows with `Invoice #` and amount create `Invoice` (id = invoice number, conditional put) + `InvoiceLine` snapshotting the customer linehaul charge. If `Paid Date` is present, create an `ArPayment` that applies to the invoice and set Order.arStatus `PAID` / Invoice.status `PAID`.
- **AP import**: rows with `Carrier bill #` and amount create `CarrierBill` for the shipment's active carrier. If paid, create `ApPayment`.
- **Audit**: one `AuditLog` row per apply (`entityType: 'ALJEX_IMPORT'`, `entityId: jobId`).

## API contract

AppSync custom mutation exposed via the existing `tmsDirectoryActions` query pattern:

```ts
// Lambda name: tms-aljex-import
// AppSync field generated by Amplify from data/resource.ts custom mutation.
```

Actions:
- `ALJEX_IMPORT_PREVIEW` — input: `{ s3Key, fileName, fileHash, mapping? }` → returns `AljexImportJob` with status `DRY_RUN` and counts.
- `ALJEX_IMPORT_APPLY` — input: `{ s3Key, fileName, fileHash, mapping? }` → returns `AljexImportJob` with status `APPLIED` and counts.
- `LIST_ALJEX_IMPORT_JOBS` — input: `{}` → returns `AljexImportJob[]`.

Client helpers in `src/lib/apiClient.ts`:
- `previewAljexImport(input)`
- `applyAljexImport(input)`
- `listAljexImportJobs()`

## UI

- New inner tab **Aljex import** under My Brokerage → Company (beside Import).
- Route: `/tms/brokerage/company/aljex-import`.
- Page:
  1. Upload CSV.
  2. Column mapping table with guessed targets.
  3. Preview / dry-run button.
  4. Result card: counts (shipments created, customers created, locations created, invoices created, bills created, skipped, conflicts, errors).
  5. Per-row error list (first 100).
  6. Run import button (enabled after preview).
  7. Job history table.

## Verification

- Synthetic CSV `scripts/fixtures/aljex-sample.csv` with 5 rows covering:
  - new customer + new locations (ACME PRODUCE CO; ACME Packing Shed, Fresno CA → Midwest Grocery DC, Joliet IL)
  - existing customer (BATORY FOODS, present in the dev directory)
  - invoice paid (INV-5001, status `Paid`)
  - carrier bill (CB-7001, status `Delivered`)
  - duplicate PRO (90001, conflict on second run)
- `npm run test` green.
- `npx tsc --noEmit` for both tsconfigs green.
- `npx eslint .` green.
- Dev deploy succeeds.
- Browser smoke test on dev: upload sample, preview, apply, list jobs.

## Files expected to change

- `amplify/data/resource.ts` — add `AljexImportJob` model, custom mutation for `tmsAljexImport`.
- `amplify/storage/resource.ts` — no change (existing `imports/*` prefix).
- `amplify/backend.ts` — wire `tmsAljexImport` Lambda, grants, environment variables.
- `amplify/functions/tms-aljex-import/resource.ts` — Lambda definition.
- `amplify/functions/tms-aljex-import/handler.ts` — main handler.
- `amplify/functions/tms-aljex-import/parser.ts` — CSV parsing.
- `amplify/functions/tms-aljex-import/mapper.ts` — Aljex → entity mapping.
- `amplify/functions/tms-aljex-import/import.ts` — dry-run / apply engine.
- `src/lib/aljexImport.ts` — shared parser/mapper (`parseCsvRows`, `normalizeHeader`, `guessAljexMapping`, `mapAljexRow`). The UI uses `guessAljexMapping` for the mapping table; the unit tests target this module. Correction vs. the original plan: the parser/mapper live here as a shared module rather than only inside the Lambda, so both the UI and tests can import them without pulling in Lambda code.
- `src/types/tms.ts` — `AljexImportJob`, `AljexImportInput`, `AljexImportCounts` types.
- `src/lib/apiClient.ts` — client helpers.
- `src/features/tms/brokerage/company/CompanyTab.tsx` — add tab/route.
- `src/features/tms/brokerage/company/AljexImportPage.tsx` — new page.
- `scripts/fixtures/aljex-sample.csv` — synthetic sample.
- `src/lib/aljexImport.test.ts` — parser/mapper tests.
- `Docs/tms-build/N1-plan.md` — this file.
- `Docs/tms-build/BUILD_LOG.md` — deploy log entry.
