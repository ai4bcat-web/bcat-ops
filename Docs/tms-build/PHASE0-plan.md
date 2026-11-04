# PHASE 0 plan — Aljex import hardening, legacy-docs flag, PITR + nightly export + export-all CSV

Written 2026-11-03 on `dev`. **Planning only; no code changed.** Dev only. No main merge, no merge-to-main
prep, never production. Implements `ALJEX_EXIT_PLAN.md` §3 "Phase 0" and the "Gaps for a realistic large load"
list in BUILD_LOG ("PLAN: the two dev-only tests after S4"). The demo-shipment plan (brokered + Ivan Cartage +
driver) stays Phase 2 and is untouched here. QuickBooks is not in Phase 0.

Everything below was checked against the code (file:line citations are to `dev` at `ec0d8e8`), not just the log.
`[INFERENCE]` marks anything I could not confirm from the repo. The Aljex sample file has not arrived; the column
dictionary is therefore built from (a) the 31 columns in code, (b) `scripts/fixtures/aljex-sample.csv`, (c) the
statuses in `TMS_BUILD_BRIEF.md` Step R2, and is designed so the real headers only change a *saved mapping*, not code.

## 0. Summary — the design in twelve lines

1. **One engine, three drivers.** A pure, store-injected import engine (`amplify/functions/tms-aljex-import/engine/`)
   runs (a) inside the Lambda as a server-driven, self-re-invoking worker (default; UI-run, resumable, 15-min
   invocations), (b) from `scripts/importAljex.mjs` against DynamoDB (volume tests, rehearsal copies, prod cutover),
   (c) against an in-memory store in vitest. Not Step Functions, not SQS, not browser-driven chunking (§2.3).
2. **Pipeline:** STAGE (parse once → normalized JSONL chunks in S3) → PLAN (dry-run through the *same* code on an
   overlay store; accurate because state carries across rows) → APPLY (phases CUSTOMER → CARRIER → LOCATION → LOAD →
   AR/AP LEDGER → FINALIZE) → RECONCILE (numbers read back from the tables, not from engine memory).
3. **One transaction per PRO** writes ProClaim + Shipment + Order + Load + LoadFinancials + charges + LoadCarrier +
   Invoice(s) + CarrierBill(s) in their *final* state (joined in memory during staging). Load rows are INSERTed once and never
   updated (every stream consumer except two acts only on MODIFY, §1.6).
4. **Masters first, by normalized key, via Maps.** Customers/carriers/locations are created before loads using the
   *same* normalization the `UPSERT_*` actions use (shared `_shared/directoryKeys.ts`), found by `aljexCode`, MC/DOT,
   normalized name (+city/address for locations). No linear scans; no per-call table scans.
5. **PROs are preserved** as `Load.aljexId`; `Shipment.number`/`loadNumber` follow the existing backfill convention
   (`L<PRO>`, `L<PRO>-1`), no counter is burned, ProClaim `origin:'LEGACY'` (the enum has no `ALJEX_IMPORT`).
   Counter seeding is an atomic forward-only action run at FINALIZE and on demand.
6. **Real statuses, real terms.** A persisted, editable status map (unmapped values block APPLY instead of defaulting
   to OPEN). Shipment/Load status come from the map; AR/AP state comes from invoice/bill/payment rows, not from the
   load's status text. Invoice terms come from the file → customer → org default, never "Net 0".
7. **Money reconciles by construction and is pinned by tests:** imported invoices carry `ArPayment` ledger rows so
   `paidCents == Σ applications`; open AR = Σ `balanceCents` of `arOpen='OPEN'` invoices; open AP likewise; per-customer
   and per-carrier balances; all compared with an oracle emitted by the fixture generator.
8. **Documents:** new `Shipment.legacyDocsInArchive` (+ `legacySource`). `evaluateReleaseGate` and `evaluateDocGate`
   (both scopes) skip *paperwork* checks for flagged shipments and nothing else. No fake `ShipmentDocument` rows.
   UI badge "Legacy - documents in Aljex archive". The existing `arStatus:'LEGACY'` rung is a *worklist exclusion*,
   not a gate waiver (§1.5) and is reused only for aged, never-invoiced freight.
9. **Imported carriers** are `PENDING` with `mcpStatus` null and no payment method: history is intact, but they cannot be
   booked (`allowedCarrierStatuses=['ACTIVE']`) and a rate con is refused (`rateConMcpRefusal`).
10. **Data safety:** PITR on every Amplify table via `amplifyDynamoDbTables[…].pointInTimeRecoveryEnabled`; a new
    `tms-data-safety` Lambda does nightly `ExportTableToPointInTime` → a new versioned private S3 bucket, and the
    admin "Export everything to CSV" action; the nightly rule is the one EventBridge rule allow-listed *enabled* on dev.
11. **Rehearsal without residue:** the real file goes first into a PITR-restored *copy* of the dev tables
    (`…-rh<tag>`); shipments are void-only and ProClaims are forever, so nothing real is ever rehearsed on live dev tables.
    Synthetic `ZZ` data on live dev is deterministic and reused, so residue is bounded (§9.5).
12. **Schema:** additive only; **forces a data deploy** (new fields/models, 2 enum members, PITR flip). One deploy, §8.

## Section index
1. Recon: what the code does today (facts + the defect list)
2. Import architecture
3. Carrier / Customer / Location creation
4. PRO preservation and the counter
5. Real statuses, invoice terms, AR/AP state and reconciliation
6. Documents strategy (legacy flag)
7. Data safety: PITR, nightly export, export-all CSV
8. Schema, IAM/env/backend.ts, API surface, UI
9. Fixture generator, tests, devVerifyAljex.mjs, cleanup honesty
10. Slices, interfaces, landing order
11. Risks
12. Decisions for Ryne (with defaults)

---

## 1. Recon: what the code does today

### 1.1 The current importer (`amplify/functions/tms-aljex-import/*`, `src/lib/aljexImport.ts`, `AljexImportPage.tsx`)

Shape: AppSync mutation `tmsAljexImport` (`data/resource.ts` ~4536) → Lambda `tms-aljex-import` (60 s, `resource.ts`);
actions `ALJEX_IMPORT_PREVIEW | ALJEX_IMPORT_APPLY | LIST_ALJEX_IMPORT_JOBS`; owner/ADMIN only (`handler.ts authorize`).
The browser uploads the CSV to S3 `imports/…`, sends `{s3Key,fileName,fileHash,mapping}`; the Lambda reads the *whole* file,
`parseCsvRows` (two passes, `src/lib/aljexImport.ts`), `mapAljexRow` per row, then `processRow` serially. One
`TransactWriteItems` per row: ProClaim (conditional), Shipment, Order, Load, LoadFinancials, 2×LoadCharge, optional Invoice, optional
LoadCarrier+CarrierBill. Job row `aljex:<sha256>` is written once at the end.

The 31 target columns (`AljexColumnTarget`): pro, po, pickupNumber, customer, customerMc, origin{Name,City,State,Zip},
destination{Name,City,State,Zip}, pickupDate, deliveryDate, equipment, commodity, weight, pieces, miles, customerRate, carrierRate,
carrierName, carrierMc, invoiceNumber, invoiceDate, invoicePaidDate, invoiceAmount, carrierBillNumber, carrierBillAmount, status.
`HEADER_ALIASES` gives 2–4 aliases each (`Pro #`, `PRO`, `ProNumber`, `Pro No`, …); matching is case/punctuation-insensitive.
Status map (`normalizeStatus`): open/new/available/building→OPEN, covered/booked→BOOKED, dispatched/assigned→DISPATCHED,
loading/at pickup→LOADING, picked up/en route/in transit→IN_TRANSIT, arrived at delivery/unloading→UNLOADING,
delivered/invoiced/billed/**paid**→DELIVERED, hold→ON_HOLD, canceled→CANCELED, **anything else→OPEN with a note**.
Only sample in the repo: `scripts/fixtures/aljex-sample.csv` (4 rows + 1 exact duplicate; headers == the 31 columns).
`AljexImportPage.tsx` re-implements its own `parseCsv`, `ALIASES` and `guessTarget` (a second copy of the lib), holds the mapping in
React state only (not persisted), and uploads then calls preview/apply synchronously.

### 1.2 Defects in the current importer (all verified in source; each has a fix in §2–§6 and a test in §9)

| # | Defect | Evidence | Consequence |
|---|---|---|---|
| D1 | **Empty/NULL GSI keys.** `Shipment.pickupAppt = legacy.pickupAppt` (`''` when undated) and `pickupMonth = monthOf(..)` (`null`). `marshallRow` keeps `null` as a DynamoDB NULL (`_shared/shipmentStore.ts:165`). Shipment GSIs are `status`+`pickupAppt`, `customerId`+`pickupAppt`, `pickupMonth`+`pickupAppt` (`data/resource.ts` Shipment) | `tms-shipment-actions/handler.ts:1855-1857` documents exactly this ("DynamoDB refuses… takes the whole transaction down") | every row with no pickup date fails its whole transaction; counted as an error |
| D2 | Shipment `status` hard-coded `'DRAFT'`; `number` burns `nextShipmentNumber` per row; Order `arStatus:'LEGACY'` even with no invoice | `processRow` | imported freight is neither in boards by status nor in AR; 50k imports burn 50k numbers on one hot settings item |
| D3 | **Appointments shifted a day.** Stops use `` `${date}T00:00:00.000Z` `` | app convention is Chicago midnight: `fromDateInput` (`src/lib/date.ts:272`) | every imported pickup/delivery shows the previous evening in Central time |
| D4 | **Invoices:** `termsDays:0`, `dueAt=invoiceDate`; `Invoice.paidAt` never set; a paid invoice gets `paidCents` but **no `ArPayment` row**; `Order.arBalanceCents` not set; Invoice `lines`/`billTo` and Order `references` are `JSON.stringify`'d strings while `shipment-actions`/`finance-actions` write native arrays/objects and Lambda readers do `Array.isArray(order.references)` (`_shared/releaseGateInput.ts`) | `processRow` vs `invoices.ts buildSnapshot`; `loadReleaseGateInput` | aging is wrong (everything overdue), customer receipts ledger empty, references invisible to the gate [JSON-encoding effect on PDF render = INFERENCE] |
| D5 | **Bills:** `carrierId:'imported-<mc|name>'` (no Carrier row); `LoadCarrier` created only when a bill exists and has no `carrierId`; the CARRIER `LoadCharge` has `loadCarrierId:null`; `chargesFinalizedAt` missing; bill status always `IN_REVIEW`, `billDate=import day`, `dueAt=billDate`; no paid state | `processRow`; `bills.ts readAssignmentContext` (`carrier` null) / `billReadiness` ("not in the carrier directory") / `billLinesFor(charges, loadCarrier.id)` finds no lines | bills cannot be approved, re-recorded or paid sensibly; release gate says `CARRIER_CHARGES_UNSETTLED`; every imported bill floods the "AP to review" badge (`useApToReviewCount`) |
| D6 | Customers/locations written *before* the row's transaction, by plain `PutItem`; customers carry no `normalizedName`/`aliases`; locations carry no `normalizedName`/`normalizedAddress`/`street`/`facilityType`; resolution is `existing.find(...)` per row, and `resolveLocation` runs `normalizeAddress` over **every existing location for every row** | `ensureLocation`, `resolveLocation`, `resolveCustomer` | O(rows×locations) ≈ 50k×20k = 10⁹ normalizations → timeouts; imported customers/locations later look unmatched or duplicate; a failed transaction leaves orphan customers |
| D7 | `previewImport` never appends created customers/locations to its state | dry-run branch returns before the push | preview over-counts `customersCreated`/`locationsCreated`, and (with no cross-row state) cannot show conflicts that depend on earlier rows |
| D8 | Job record: id `aljex:<hash>` is shared by DRY_RUN and APPLIED; `runPreview` returns the existing job for *any* prior job of that hash (a changed mapping is ignored); written only at the end | `getExistingJob`, `writeJob` | a timeout leaves nothing; no resume; no progress |
| D9 | `ProClaim.origin:'ALJEX_IMPORT'` is not in the enum (`CREATE|DUPLICATE|BACKFILL|SET_LOAD_PRO|LEGACY`) | `data/resource.ts` ProClaim | reading those rows through AppSync can fail enum serialization [INFERENCE: AppSync nulls/errors on an out-of-enum value]; use `'LEGACY'` |
| D10 | The importer's PRO key (`toUpperCase().replace(/[^A-Z0-9]/g,'')`, ≥3 chars) is a *copy* that differs from `src/lib/proNumber.ts normalizePro` (strips a leading "PRO", rejects `N/A`) | `import.ts proClaimKey` | `PRO 14547` and `14547` get different claim keys → duplicates |
| D11 | A PRO already claimed by a non-import origin is `conflicts` and skipped. On dev the Load table is a *copy of production* whose own-fleet loads already hold ProClaims from `backfillProClaims.mjs` | `processRow` | the overlap between the Aljex export and existing BCAT loads is silently "conflict"; no policy, no report (§2.8) |
| D12 | `Shipment.searchKey`, `revDivision`, `salesRepId`, `trackerId`, references (PO/PU), `divisionKey` never set | `processRow` | "find 12345" misses imports; division filters/dashboards miss them |
| D13 | Reads whole `Customer` and `Location` tables with `Scan` on every preview and every apply | `previewImport`/`applyImport` | cost/time; no reuse across chunks |
| D14 | `normalizeName` exists in **three** variants: `directory-actions/handler.ts:755` (strips llc/inc/ltd/llp/corp/co/company/enterprises *anywhere*, used for Customer/Location `normalizedName`), `import.ts` (verbatim copy of that), `src/lib/tmsDirectory.ts:4` (NFKD, strips only a *trailing* suffix; used by `tms-carrier-actions` and `locationAutoSave`) | grep | a customer's key depends on who wrote it; the importer must use the one the model's writer uses (§3.1) |

### 1.3 What Customer / Location / Carrier need (the writers the import must match)
- **Customer** (`upsertCustomer`, `directory-actions/handler.ts:985`): `normalizedName` = directory `normalizeName(name)`, duplicate test against
  *every active customer's* name and aliases via `scanActiveCustomers()` (so UPSERT_CUSTOMER is O(n) per call → unusable as a bulk path); status default `ACTIVE`
  (or `PENDING` if `requireCustomerApproval` and non-admin); `active = deriveActiveFromStatus(status)`; credit fields owner/ADMIN-only; GSI `normalizedName`.
- **Location** (`upsertLocation`, `:1362`): `normalizedName`, `normalizedAddress` only when any of street/city/state/zip exists (a GSI key may not be `''`/NULL),
  duplicate if same normalized name **and** normalized city, or same normalized address; geocode fields only from a signed `tmsGeocode` token (so import leaves
  `lat/lng/placeId/geocodedAt/timezone/geohash6` null — deferred by design); `country` default `'US'`; GSIs `normalizedName`, `normalizedAddress`, `mergedIntoId`.
- **Carrier** (`upsertCarrier`, `tms-carrier-actions/handler.ts:648`): requires `type` (`TL|LTL|CARTAGE|LINEHAUL|AIR|OCEAN|RAIL|AGENT`); `status` on create is `PENDING`
  unless an admin asks for `ACTIVE`; `normalizedName` via `src/lib/tmsDirectory.normalizeName`; duplicate refusal by normalizedName, MC, or DOT through
  GSIs `normalizedName`, `mcNumber`, `dotNumber`; GSI key attributes (`normalizedName, mcNumber, dotNumber, status, name`) **must be omitted when null/''**
  (`marshallCarrierRow`, `CARRIER_INDEX_KEYS`). A bookable carrier additionally needs `insurancePolicies` (expiry vs pickup is checked), an active
  `CarrierPaymentMethod` (to be payable), and `mcpStatus ∈ {PENDING_REVIEW, ACCEPTABLE, MODERATE, UNACCEPTABLE, UNACCEPTABLE_REVIEW}` for a rate con
  (`src/lib/mcpPacket.ts`; `null` → "has no MyCarrierPackets status on file, so no completed packet").

### 1.4 PRO, numbering and `aljexId`
- `ProClaim.id` = `normalizePro(pro)` (`src/lib/proNumber.ts`: strip leading `PRO`, alphanumerics only, upper-case, ≥3 chars, `N/A`→null). A claim is conditional-put
  inside the shipment transaction and **never released** (void keeps it). `ProClaim.origin` enum: `CREATE|DUPLICATE|BACKFILL|SET_LOAD_PRO|LEGACY`.
- `CREATE_SHIPMENT` (`tms-shipment-actions/handler.ts:1822-1829`): `number = nextShipmentNumber()`; `pro = suppliedPro ?? \`${number}-1\``; a *typed* PRO is refused if it has the
  shape the counter hands out (`assertNotDerivedPro` `:1367`: `^<prefix>\d{6}-\d+$` raw, or key `^<prefix-key>\d{7,}$`). `duplicateShipment` derives `${number}-1` at `:3493`.
- **`nextShipmentNumber` is "last issued", not "next"**: `ADD nextShipmentNumber 1` then read the new value (`:1272-1294`); prefix = `shipmentPrefixOf(settings)` and a blank prefix
  falls back to `'S'`, so *numeric-only shipment numbers are impossible today*. `saveShipmentSettings` (`:1391-1405`) lets the counter only go forward; prefix `≤8 [A-Z0-9-]`.
- Backfill convention for legacy loads (`planBackfill` `:6479`, `:6698`): `Shipment.number = L<aljexId>`, `loadNumber = L<aljexId>-1`, ids `stableId('shp'|'ord'|'lcr'|'chg', loadId)`
  = `prefix-` + first 16 hex of sha256, ProClaim `origin:'BACKFILL'`, `source:'BACKFILL'`, `searchKey` lower-cased "number customer cities pickupNumber".
- Consumers of `Load.aljexId`: PRO column on the board, `FactoringItem.id` = PRO (`factorHandoff.ts`: submit scans `Load.aljexId`), `intakeMatch.ts` (matches tender text to `aljexId`/`tmsId`/`pickupNumber`),
  appointment queue/CSV, Schedule/driver pages, `notifyApptNeeded`. All read the string as typed; `aljexId`, `tmsId`, `pickupNumber` are **field-level read-only to clients** (only the Lambda writes them).

### 1.5 The release gate and the LEGACY rung — exactly what happens to imported/backfilled rows today
- `evaluateReleaseGate` (`src/lib/releaseGate.ts`) **never reads `order.arStatus`.** It returns missing reasons for: voided/canceled (short-circuit), not `DELIVERED`, each required document type
  (`customer list ∪ BOL ∪ POD ∪ RATE_CON-if-a-carrier-leg`; a signed rate con counts as RATE_CON), required references, no ACTIVE leg, own-asset driver missing, a CARRIER leg without
  `chargesFinalizedAt`, open exceptions. It is built by `loadReleaseGateInput` for four callers: `READY_TO_INVOICE` (`documents.ts:866`; also `handler.ts:6233`), `GENERATE_INVOICE`/preview/batch (`invoices.ts:221,394`),
  and Send-to-factor (`factor.ts:78`). `evaluateDocGate` (`src/lib/shipmentDocuments.ts:425`) is the second, document-only gate used by the Documents tab (`useShipmentDocuments.ts:84,105`), the cached
  `Order.docsMissing`/`LoadCarrier.docsMissing` (`documents.ts:243,297`), invoice preview (`invoices.ts:203`) and **bill approval** (`bills.ts:160 carrierGateFor`, then `approvalReadiness` blocks on `gate.missing`
  unless the bill has `docsOverrideAt`, and warns `RATE_CON_UNSIGNED`).
- `READY_TO_INVOICE` only runs for `arStatus === 'DOCS_NEEDED'` (`documents.ts` "That order is already X, not waiting on documents").
- **Rows the current importer writes** (`arStatus:'LEGACY'`, Shipment `DRAFT`): never in a worklist, never evaluated; if anyone tried the gate they would fail `NOT_DELIVERED`, `DOC_MISSING BOL/POD/(RATE_CON)`,
  `CARRIER_NOT_ASSIGNED` or `CARRIER_CHARGES_UNSETTLED`. Imported `UNPAID/PAID` orders skip the gate until their invoice is voided (`VOID_INVOICE` returns the order to `UNBILLED`, `invoices.ts:805`) and re-issued, or sent to factor.
- **Backfilled legacy loads** (`planBackfill`, Step B): start at `DOCS_NEEDED` and are *parked* by `scripts/backfillLegacyAr.mjs` on `LEGACY` ("not ours to invoice"; it explicitly refuses to invent Invoice rows because the Aljex-era
  bills live in the factoring queue). `LEGACY` is therefore a **worklist/credit exclusion**: `arAging.deliveredNotInvoiced`, `customerCredit.creditBucketForOrder` (returns null) and `shipmentLists.isReleasedToInvoicing` treat it that way. It is not a gate waiver.
- **Consequence for Phase 0:** (a) freight that must flow through BCAT after import (recent delivered-unbilled, a re-issued invoice, a factor hand-off, an open carrier bill) needs a real waiver of the *paperwork* checks → new `legacyDocsInArchive` flag (§6);
  (b) importing real `Invoice` rows *reverses* the Step F stance ("no Invoice rows from Aljex"); that is required by Ryne's reconciliation goal and is recorded as **Decision D9**; factored invoices must be linked to the existing OTR `FactoringItem` (id = PRO), not duplicated (§5.4).

### 1.6 Stream consumers that an import could wake (checked)
`shipment-notifier` and `load-tracking-projector` handle **MODIFY only** (`handler.ts:398`, `:263`); `ratecon-assigned-text` and `broker-load-alert` handle INSERT+MODIFY but act on a driver/owner-operator assignment
(imports carry no driver). Rule that follows: **write every Load row once, complete, as an INSERT; no import phase updates a Load** (Order, LoadCarrier, Carrier updates are fine — they are not stream sources of these consumers).
`brokerLoadAlert` and `rateconAssignedText` mappings are *created disabled* on dev (`backend.ts:2992`). Before a production import these four must be re-read (Decision D6).

### 1.7 AR / AP screens and what they read
- AR aging, open book, customer balances: `Invoice` GSI `arOpen`(+`dueAt`) = **sparse 'OPEN' marker, REMOVEd (never nulled) when PAID/VOID**; `listInvoiceByArOpenAndDueAt` (`apiClient.ts:6142`, paged), `ageInvoices` → `ageOpenItems` (`arAging.ts`),
  buckets CURRENT/1–30/31–60/61–90/91+ by `dueAt` vs as-of. Invoice states `ISSUED|PARTIAL|PAID|VOID`; `balanceCents = total − paid − writtenOff`. Cash is `ArPayment` (`PAYMENT|CREDIT_MEMO|WRITE_OFF|REVERSAL`, `receivedAt` at noon UTC,
  `applications:[{invoiceId,amountCents}]`, `appliedCents`, `unappliedCents`); id from `paymentId(prefix, customerId, clientRequestId)` = `prefix-` + sha256 digest[0:32].
- Credit exposure (`customerCredit.ts`): `Order.arStatus UNPAID → INVOICED` bucket counts toward the limit; `PAID/INVOICE_NOT_NEEDED/LEGACY` do not. So *open imported invoices must sit on `UNPAID`* for credit math to be right.
- AP: `CarrierBill` GSI `apOpen`(+`dueAt`) sparse 'OPEN' while `IN_REVIEW|TO_BE_PAID|PARTIAL`; `listCarrierBillByApOpenAndDueAt`; `LoadCarrier.apOpen/apStatus/apBalanceCents/apPaidAt` (`AWAITING_INVOICE|IN_REVIEW|TO_BE_PAID|PAID`);
  `ApPayment` (`PAYMENT|CREDIT_MEMO|REVERSAL`, `applications:[{billId,amountCents}]`); id `cb:<loadCarrierId>:<n>`. `RECORD_AP_PAYMENT` tolerates a null bill `remitTo` (`apPayments.ts remitToOf`), so open imported bills are payable once the carrier has a payment method chosen at pay time.
- Terms: `invoiceTermsDays(customer, billTo, settings)` (billTo → customer.paymentTermsDays → `TmsSettings.defaultPaymentTermsDays`), `dueDateFor` (UTC date add); `billTermsDays(loadCarrier, carrier, settings)`; `nextInvoiceNumber` ADDs `TmsSettings.nextInvoiceNumber` (absent counter → 1).

### 1.8 Backend wiring facts
- Importer permissions in `backend.ts:2850-2993` (explicit table ARNs, `BUCKET_NAME`, `grantRead('imports/*')`, `grantPut('imports/errors/*')`); `allow.resource(tmsAljexImport).to(['query','mutate'])` (`data/resource.ts:4575`).
- **Dev guard** (`backend.ts:3533`): walks the whole root stack and sets **every `CfnRule` DISABLED**, denies `ses:*` on every Lambda, neuters seven secrets. A new nightly rule is disabled unless allow-listed (§7.3).
- Precedent for table tweaks: `backend.data.resources.cfnResources.amplifyDynamoDbTables['Integration'].timeToLiveAttribute` (`backend.ts:2165`). The wrapper has a typed setter
  `pointInTimeRecoveryEnabled` (`node_modules/@aws-amplify/graphql-api-construct/lib/amplify-dynamodb-table-wrapper.d.ts:126`).
- 95 `a.model` declarations (`grep`) → ~95 tables (plus join tables). Lambda env limit is 4 KB, so a list of all table ARNs cannot be passed as an env var (§7).
- Storage (`amplify/storage/resource.ts`): `imports/*` is staff-writable and authenticated-readable; no lifecycle rules exist on the Amplify bucket.
- Dev identifiers: `Docs/DEV_STACK.md`; dev suffix `nc3jsnxdmjhkpequimypiatkma-NONE`, prod suffix `5ucwdyvwivelbo4k4jomvrwel4-NONE` (also pinned in `scripts/devStack.mjs`, which does **not** reject `--to <prod suffix>`: gap #8 in the log; fixed in slice B2).
