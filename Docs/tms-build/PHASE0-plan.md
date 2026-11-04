# PHASE 0 plan — Aljex import (real 486-column export), legacy flag, PITR + nightly export + export-all CSV

Written 2026-11-03 on `dev`, revised the same day after Ryne's real export arrived. **Planning only; no code changed.**
Dev only. No main merge, no merge-to-main prep, never production. Implements `ALJEX_EXIT_PLAN.md` §3 Phase 0.
The demo-shipment plan (brokered + Ivan Cartage + driver) stays Phase 2. QuickBooks is not in Phase 0 (DECIDED).

**Data-handling contract (Main, 2026-11-03).** The export lives at an absolute path outside the repo
(`/Users/adminoid/aljex-export/aljex-full-export-2026-11-03.csv`, 17.9 MB, contains customer/carrier PII). It is never copied into
`bcat-ops`, never committed, and referenced by path only. This document, tests, fixtures, logs and screenshots contain **column names
and aggregates only — no cell values.** Every fixture specified here is synthetic. The aggregates quoted below came from throwaway
read-only scripts under `/tmp` (not in the repo) and must be re-confirmed by the profiler builder's `scripts/aljexProfile.mjs`
(owner of `scripts/aljexProfile.mjs`, `scripts/lib/aljexColumns.mjs`, `Docs/tms-build/ALJEX_MAPPING.md`; **this plan references those
files and does not duplicate them** — field-by-field mapping lives in `ALJEX_MAPPING.md`; this plan owns architecture, safety, gates,
reconciliation and slices).

Everything below was checked against the code (file:line are on `dev` at `ec0d8e8`). `[INFERENCE]` marks anything not confirmed.

## 0. Decisions already made (Ryne, via Main, 2026-11-03) — DECIDED, not defaults
- **DECIDED-1  Preserve Aljex PRO numbers and continue the numeric scheme above 14912.** Imported `Load.aljexId` = the Aljex `Pro #`;
  the counter is seeded atomically (forward-only) to the max imported/known numeric PRO (≥ 14912) so the next new shipment is `max+1`, and an admin
  "Seed counter" action exists. New shipments mint numeric PROs (`TmsSettings.proScheme = 'NUMERIC'`, §5).
- **DECIDED-2  No QuickBooks for now.** The AR/AP ledger lives in BCAT Ops. "Export everything to CSV" therefore ALSO emits four
  accountant-ready CSVs with stable headers — invoices, AR payments/credits, carrier bills, AP payments — in addition to the raw per-table dumps (§8.4).
- **DECIDED-3  Cutoff/freeze is a weekend, date TBD after Phase 1 reconciles.** Nothing in Phase 0 assumes a date: `cutoffDate` is an optional
  import option defaulting to null, "as-of" in reports defaults to the run date, no constant, cron or default anywhere encodes a cutoff.
- **DECIDED-4  The 403 blank-status rows (DEBT/CRED memos) import as VOIDED history**, each a voided shipment/order carrying an "Aljex memo (DEBT|CRED)"
  marker with the memo amount preserved **as a note only**; no invoice, no ledger row, excluded from open AR, so the reconciliation targets hold (§7.5). Reported.
- **DECIDED-5  Only NEW loads carry documents in BCAT Ops.** Every imported load carries the `legacyImported` flag ("Legacy - docs in Aljex"), which satisfies the
  release gate, the bill-approval document checks **and** the Step W driver gates (historical Ivan rows have no driver) and is excluded from the Needs-driver report (§8).
- **DECIDED-6  Invoice numbering.** Imported invoices keep their Aljex number (= PRO). A new series starts at **20000** at cutover; the start is a validated, atomic,
  admin-configurable `TmsSettings` setting (`invoiceSeriesStart`) that must exceed the highest imported invoice number (§7.8).
- **DECIDED-7  Carriers: import only those used in the last 12 months** (window anchored on the export's newest plausible ship date, or an explicit configurable
  `carrierCutoffDate`; §5.2). Others are skipped and listed; their loads still import with a carrier-name snapshot and no directory row (§5.2). Safety rule added by this plan: a carrier with an
  unpaid bill or an in-flight load is imported regardless of the window (otherwise an open payable would have no payee record).
- **DECIDED-8  MyCarrierPackets is a separate builder's live adapter; Ryne enters credentials himself at Integrations > MyCarrierPackets.** Nothing in Phase 0 asks for,
  reads or stores them. Phase 0 designs a batched, resumable "sync imported carriers" step that only runs when the integration reports LIVE (§5.7); the adapter is not built here.
- **DECIDED-9  Revenue divisions are exactly four: Ivan Cartage, BCAT Logistics, Auto Shipping, Owner Operators.** Seeded on dev through the existing ownership-seed mechanism by
  renaming (never duplicating, deleting or voiding); intake e-mail per division is TBD → placeholders `tenders-<division>@bcatcorp.com` marked UNCONFIRMED and listed in the build log (§5.6).

## 1. Summary of the design
1. **One engine, three drivers** (Lambda worker, `scripts/importAljex.mjs`, vitest in-memory). Not Step Functions/SQS/browser-chunking (§3.3).
   The real file is **8,320 rows**, so a full run is minutes, not hours; the chunk/cursor/resume machinery stays (AppSync caps a call at 30 s) but is
   sized for that, with 50k-row fixtures only as headroom.
2. **A new positional mapper for this layout** (not the 31-column mapper): fixed column indexes and repeated groups (12 stop blocks, 21 charge lines,
   8 accessorial pairs, 3 customer payments, 9 projected expenses, 8 paid-expense blocks, 3 commission reps); **rows are right-truncated** so missing
   trailing cells are blank; **header names repeat**, so nothing is looked up by name.
3. **403 of the 8,320 rows are DEBT/CRED memos, not loads.** They import as VOIDED history with an "Aljex memo" marker and amounts as a note only (DECIDED-4, §7.5).
4. Pipeline: STAGE → PLAN (dry-run on an overlay store, same code path) → APPLY → RECONCILE; **one DynamoDB transaction per PRO** writes the final
   state of Shipment/Order/Load/LoadFinancials/LoadCharges/LoadCarrier/Invoice/CarrierBill/ProClaim/LegacyAljexRow. Load rows are INSERTed once and never updated.
5. **Dedupe against dev first:** a PRO that already exists on dev (`Load.aljexId` or `ProClaim`) is classified CREATE / ENRICH / UNLINKED; live records are never rewritten (§5.8).
6. **Masters by normalized key through Maps**, using the same helpers the `UPSERT_*` actions use (shared `_shared/directoryKeys.ts`).
7. **Real statuses, terms and money.** Persisted status map (unknown values block APPLY); AR from the Invoice/Paid/Credits/Debits columns; AP from
   Projected/Actual carrier expense and the Paid-Exp blocks. AR reconciles to the file by an exact bridge (§6.4): open AR **358,893.85**.
8. **One legacy flag** (`legacyImported`) exempts imported history from the *paperwork* gates (release gate + doc gate, both scopes) **and from the
   Step W driver gates and the Needs-driver report**, and nothing else (§7). No fake documents; no driver fields are written for history.
9. **Throwaway table copy for rehearsal:** on-demand backup → restore to `…-rh<tag>` tables; an importer that takes a table-suffix target, guarded against production and
   against live dev unless explicitly tagged (and, for real data, unless a reconciled rehearsal exists) (§10.2).
10. **Data safety:** PITR on every Amplify table, nightly `ExportTableToPointInTime` Lambda → a new private versioned bucket, and the admin export-all-CSV
    action including the accountant CSVs. Schema is additive and **forces one data deploy** (§9).

## Section index
1. Design summary · 2. Recon (code facts, importer defects) · 3. The real export: layout and aggregates · 4. Import architecture ·
5. Entities (customers, carriers, locations, loads, divisions, MCP sync, dedupe vs dev) · 6. PRO and counter · 7. Statuses, AR/AP, memos, invoice series, reconciliation ·
8. Legacy flag (docs + Step W + needs-driver) · 9. Data safety · 10. Schema, IAM, backend.ts, API, UI · 11. Fixtures, tests, rehearsal copy, 1k run, devVerify ·
12. Slices and landing order · 13. Risks · 14. Open decisions for Ryne

---

## 2. Recon: what the code does today (verified against source)

### 2.1 The current importer (`amplify/functions/tms-aljex-import/*`, `src/lib/aljexImport.ts`, `AljexImportPage.tsx`) — written for a 31-column assumption; superseded by the real export (§3) but its defects (§2.2, §2.9) all still apply to any rewrite

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

### 2.2 Defects in the current importer (all verified in source; each has a fix in §4–§8 and a test in §11)

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
| D11 | A PRO already claimed by a non-import origin is `conflicts` and skipped. On dev the Load table is a *copy of production* whose own-fleet loads already hold ProClaims from `backfillProClaims.mjs` | `processRow` | the overlap between the Aljex export and existing BCAT loads is silently "conflict"; no policy, no report (§5.8) |
| D12 | `Shipment.searchKey`, `revDivision`, `salesRepId`, `trackerId`, references (PO/PU), `divisionKey` never set | `processRow` | "find 12345" misses imports; division filters/dashboards miss them |
| D13 | Reads whole `Customer` and `Location` tables with `Scan` on every preview and every apply | `previewImport`/`applyImport` | cost/time; no reuse across chunks |
| D14 | `normalizeName` exists in **three** variants: `directory-actions/handler.ts:755` (strips llc/inc/ltd/llp/corp/co/company/enterprises *anywhere*, used for Customer/Location `normalizedName`), `import.ts` (verbatim copy of that), `src/lib/tmsDirectory.ts:4` (NFKD, strips only a *trailing* suffix; used by `tms-carrier-actions` and `locationAutoSave`) | grep | a customer's key depends on who wrote it; the importer must use the one the model's writer uses (§5.1) |

### 2.3 What Customer / Location / Carrier need (the writers the import must match)
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

### 2.4 PRO, numbering and `aljexId`
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

### 2.5 The release gate and the LEGACY rung — exactly what happens to imported/backfilled rows today
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
- **Consequence for Phase 0:** (a) freight that must flow through BCAT after import (recent delivered-unbilled, a re-issued invoice, a factor hand-off, an open carrier bill) needs a real waiver of the *paperwork* checks → new `legacyDocsInArchive` flag (§8);
  (b) importing real `Invoice` rows *reverses* the Step F stance ("no Invoice rows from Aljex"); that is required by Ryne's reconciliation goal and is recorded as **Decision O-1** (§14); factored invoices must be linked to the existing OTR `FactoringItem` (id = PRO), not duplicated (§7.3).

### 2.6 Stream consumers that an import could wake (checked)
`shipment-notifier` and `load-tracking-projector` handle **MODIFY only** (`handler.ts:398`, `:263`); `ratecon-assigned-text` and `broker-load-alert` handle INSERT+MODIFY but act on a driver/owner-operator assignment
(imports carry no driver). Rule that follows: **write every Load row once, complete, as an INSERT; no import phase updates a Load** (Order, LoadCarrier, Carrier updates are fine — they are not stream sources of these consumers).
`brokerLoadAlert` and `rateconAssignedText` mappings are *created disabled* on dev (`backend.ts:2992`). Before a production import these four must be re-read (Decision O-6, §14).

### 2.7 AR / AP screens and what they read
- AR aging, open book, customer balances: `Invoice` GSI `arOpen`(+`dueAt`) = **sparse 'OPEN' marker, REMOVEd (never nulled) when PAID/VOID**; `listInvoiceByArOpenAndDueAt` (`apiClient.ts:6142`, paged), `ageInvoices` → `ageOpenItems` (`arAging.ts`),
  buckets CURRENT/1–30/31–60/61–90/91+ by `dueAt` vs as-of. Invoice states `ISSUED|PARTIAL|PAID|VOID`; `balanceCents = total − paid − writtenOff`. Cash is `ArPayment` (`PAYMENT|CREDIT_MEMO|WRITE_OFF|REVERSAL`, `receivedAt` at noon UTC,
  `applications:[{invoiceId,amountCents}]`, `appliedCents`, `unappliedCents`); id from `paymentId(prefix, customerId, clientRequestId)` = `prefix-` + sha256 digest[0:32].
- Credit exposure (`customerCredit.ts`): `Order.arStatus UNPAID → INVOICED` bucket counts toward the limit; `PAID/INVOICE_NOT_NEEDED/LEGACY` do not. So *open imported invoices must sit on `UNPAID`* for credit math to be right.
- AP: `CarrierBill` GSI `apOpen`(+`dueAt`) sparse 'OPEN' while `IN_REVIEW|TO_BE_PAID|PARTIAL`; `listCarrierBillByApOpenAndDueAt`; `LoadCarrier.apOpen/apStatus/apBalanceCents/apPaidAt` (`AWAITING_INVOICE|IN_REVIEW|TO_BE_PAID|PAID`);
  `ApPayment` (`PAYMENT|CREDIT_MEMO|REVERSAL`, `applications:[{billId,amountCents}]`); id `cb:<loadCarrierId>:<n>`. `RECORD_AP_PAYMENT` tolerates a null bill `remitTo` (`apPayments.ts remitToOf`), so open imported bills are payable once the carrier has a payment method chosen at pay time.
- Terms: `invoiceTermsDays(customer, billTo, settings)` (billTo → customer.paymentTermsDays → `TmsSettings.defaultPaymentTermsDays`), `dueDateFor` (UTC date add); `billTermsDays(loadCarrier, carrier, settings)`; `nextInvoiceNumber` ADDs `TmsSettings.nextInvoiceNumber` (absent counter → 1).

### 2.8 Backend wiring facts
- Importer permissions in `backend.ts:2850-2993` (explicit table ARNs, `BUCKET_NAME`, `grantRead('imports/*')`, `grantPut('imports/errors/*')`); `allow.resource(tmsAljexImport).to(['query','mutate'])` (`data/resource.ts:4575`).
- **Dev guard** (`backend.ts:3533`): walks the whole root stack and sets **every `CfnRule` DISABLED**, denies `ses:*` on every Lambda, neuters seven secrets. A new nightly rule is disabled unless allow-listed (§9.3).
- Precedent for table tweaks: `backend.data.resources.cfnResources.amplifyDynamoDbTables['Integration'].timeToLiveAttribute` (`backend.ts:2165`). The wrapper has a typed setter
  `pointInTimeRecoveryEnabled` (`node_modules/@aws-amplify/graphql-api-construct/lib/amplify-dynamodb-table-wrapper.d.ts:126`).
- 95 `a.model` declarations (`grep`) → ~95 tables (plus join tables). Lambda env limit is 4 KB, so a list of all table ARNs cannot be passed as an env var (§9).
- Storage (`amplify/storage/resource.ts`): `imports/*` is staff-writable and authenticated-readable; no lifecycle rules exist on the Amplify bucket.
- Dev identifiers: `Docs/DEV_STACK.md`; dev suffix `nc3jsnxdmjhkpequimypiatkma-NONE`, prod suffix `5ucwdyvwivelbo4k4jomvrwel4-NONE` (also pinned in `scripts/devStack.mjs`, which does **not** reject `--to <prod suffix>`: gap #8 in the log; fixed in slice B2).

### 2.9 Additional defects that matter for the real file
| # | Defect | Evidence | Consequence |
|---|---|---|---|
| D15 | `getCell` resolves a mapped header with `headers.indexOf(header)` (first match) and `guessAljexMapping` is keyed by header text | `src/lib/aljexImport.ts getCell` | the export repeats `Name`, `Address`, `City`, `State`, `Zip`, `Phone`, `Ref #`, `Code`, `Description`, `Weight`, `Rate`, `Extension`, `Paid Exp *`, `Additional Ref #` dozens of times; every duplicate silently reads the first occurrence |
| D16 | The parser assumes rectangular input; `parseCsvRows` builds a `lines` array then re-splits every line | `parseCsvRows`/`splitCsvLine` | works on ragged rows (pads/truncates) but triples memory and cannot stream; the profiler builder already ships a streaming parser `scripts/lib/csvStream.mjs` (reuse its tests/behaviour; the engine needs a TS twin or a shared pure module) |
| D17 | Only three statuses-by-text exist; blank/unknown → OPEN with a note | `normalizeStatus` | the file has `VOID`, `VOID WEB`, `CONSIGNEE` and 403 blank-status memo rows; blank must not become OPEN |

---

## 3. The real export: layout and aggregates (column names and counts only)

Source: `/Users/adminoid/aljex-export/aljex-full-export-2026-11-03.csv`; 486 header columns; 8,320 data rows; UTF-8, no non-ASCII bytes observed, LF line ends,
**every field double-quoted** (≈7.9 M quote characters), max field length 40. All counts below are from read-only scratch scripts and are re-verifiable with
`node scripts/aljexProfile.mjs`.

### 3.1 Structure (1-based column numbers = header order)
| Group | Columns | Notes |
|---|---|---|
| Identity | 1 `Office` · 2 `Pro #` · 3 `Master Invoice` · 4 `Customer Account #` · 5–9 `Customer Name/Address/City/State/Zip` · 10 `Type of Shipment` · 11 `TONU` (Y/N) · 12 `Salesrep ID` · 13 `Reference #` · 14 `Dispatch Status` | `Office` has 1 distinct value; `Master Invoice` is **blank on all rows** (no consolidated invoices) |
| Dates | 15 `Invoice Date` · 16 `Ship Date` · 17 `ETA Date` · 18–21 delivery appt date/time/note, `Must Deliver Date` · 22 `Delivered Date` · 50 `Entered` · 51 `Covered` · 91/95/99 `Paid Date 1–3` · 118–120 `Release Date/Time/By` · 419–420 `Created Date/Time` · 437–438 `Covered Date/Time` · 446–447 `Conf Rec'd` | all dates are `MM/DD/YY` (two-digit year), times `HH:MM` |
| Bill-to | 25–30 `Bill To Account/Name/Address/City/State/Zip` | present on 8,316 rows; differs from the customer account on 7 rows |
| Stops (summary) | 31–34 `Pickup Name/City/State/Zip` · 35–38 `Consignee Name/City/State/Zip` · 421 `Pick Up Address` · 422 `Final Consignee Address` · 443/444 contacts · 459/460 `Pickup/Consignee Ref #` | two-stop loads: 7,508 |
| Carrier | 39 `Line Haul Carrier ID` · 40 `Carrier Name` · 41 `Carrier Ref #` · 42 `Carrier Dispatcher` · 423 `Carrier Email` · 424 `Tractor #` · **425 `Driver Name`** · 426 `Carrier MC# Prefix` · 427 `Carrier MC #` · 428 `Carrier DOT #` · 429 `Carrier SCAC Code` · 430–433 CA intrastate / TX PUC (+expiry) · 434 `Carrier Safety Rating` · 435–436 Mexican/Canadian authority · 469–473 phones/emails | **no insurance columns** |
| Freight facts | 43 `Description` · 44 `Weight` · 45 `Footage` · 46 `Manifest` · 47 `Customer Ref #` · 48 `Container #` · 49 `Miles/Class` · 175–194 flags (`Hazmat`, `Temp Control`, `Seal`, pallets, `Hot`, `Team`, …) | no equipment column |
| Money summary | 53 `LH Revenue` · 54 `Acc Revenue` · 122 `FSC Revenue` · 123 `Invoice Amount` · 60 `Payments Received` · 63 `Credits` · 64 `Debits` · 65 `Bal Due` · 55 `Projected Carrier Expense` · 56 `Carrier LH` · 57 `Carrier Accessorial` · 61 `Actual Carrier Exp` · 67 `Advance Fees` · 68 `Quick Pay Fees` · 58–59,62,66 projected profit | |
| Commissions ×3 | 70–76, 77–83, 84–90 (`Commission Rep n`, `Amt`, `GNF`, `%`, `Flat $`, `Posted`) | |
| Customer payments ×3 | 91–94 (`Paid Date/Amount/Days to Pay/Paid Ck#` 1), 95–98 (2), 99–101 (3, no check #) | |
| Projected expenses ×9 | 102–116 (1–5: `Proj Exp/Proj Amt/Type`), 475–486 (6–9) | |
| Accessorials ×8 | `Acc Charge n` / `Acc n`: 124–131 (1–4), 461–468 (5–8) | 157 distinct accessorial names |
| Paid carrier expense ×8 | 135–174: `Paid Exp Name/Amt/Date/Ck#/GL` | |
| Stop blocks ×12 | 195–290: 8 columns each = marker (`ps1`, `PS2`…`PS`, `PS8`…) + `Name/Address/City/State/Zip/Phone/Ref #` (stride 8; the marker text is irregular: `ps1`, `PS`, lowercase `ref`) | marker values `P`/`S` |
| Charge lines ×21 | 291–416: 6 columns each = `Code`, `Description`, `Units`, `Weight`, `Rate`, `Extension` (stride 6; first group's units column is named `Miles/Units/Code/Class`) | |
| Misc | 417 `smartway` · 418 `Created by` · 439–440,474 `Future Use` · 441 `Office Covered By` · 442 `Customer Contact` · 445 `Currency` (blank) · 448–450 `Service Rep/Assigned Dispatcher/Actual Dispatcher` · 451–458 `Additional Ref #` ×8 | |

**Positional rule.** Mapping is by column index within a *layout*, keyed by a fingerprint (header count 486 + the header text at ~20 sentinel
indexes: 2, 4, 14, 53, 123, 195, 291, 417, 425, 427, 486). A different export (renamed/added columns) is a new layout version and refuses to run until a profile exists.
`scripts/lib/aljexColumns.mjs` (profiler builder; exports `scalarColumns`, `groupColumns`) is the single source of the index tables; slice B1 mirrors it in typed form
`src/lib/aljex/layout.ts` and a vitest parity test imports both and fails on drift.

### 3.2 Row shape facts that drive the design (aggregate counts)
- **Ragged rows (quote-aware parse):** 474 fields on 7,883 rows, 473 on the 403 memo rows, 477 on 22, 480 on 10, 486 on 2; i.e. trailing groups (Proj Exp 6–9, …) are simply omitted. Missing trailing cells = blank.
  Column alignment holds (the `Created Date/Time` pair sits at columns 419–420 on 6,907 rows; where `Created` is empty the next date/time pair found is `Covered Date/Time` at 437–438).
- **403 memo rows (imported as voided history, §7.5)** = 122 `DEBT` + 281 `CRED` (`Type of Shipment`), blank `Dispatch Status`/`Mode`, no carrier, no pickup, charge code `2`, Bal Due 0, all with an Invoice Date and a customer account.
  Σ CRED Invoice Amount = −22,167.40 = Σ `Credits` column over the load rows (275 loads); Σ DEBT = +9,098.81 = Σ `Debits` column (118 loads).
- **7,917 load rows.** `Dispatch Status`: DELIVERED 7,856 · OPEN 21 · COVERED 15 · LOADED 13 · DISPATCHED 5 · VOID 5 · `VOID WEB` 1 · `CONSIGNEE` 1. `Mode` = BROKERAGE on all 7,917.
  `Type of Shipment` has 27 codes (FTL 3,019, V 1,520, TL 879, AIR 720, STRA 568, LTL 378, OCN 366, ZAK 134, DEBT 122, R 109, F 81, CRED 281 …).
- **PRO:** numeric on all rows, 6000..14912, 8,316 distinct → **4 PROs appear twice, byte-identical rows**. Highest memo PRO 14797 (memos consume PRO numbers).
- **Dates:** `Ship Date` years (two-digit): 24 → 3,148 · 25 → 2,849 · 26 → 2,304 · `70` (= 1970 under the 2-digit pivot) → 7 · `20` → 1 · `23` → 2 · blank 9. `Created Date` range 2024-01-04..2026-11-03.
  31 load rows ship after their `Delivered Date`. 63 load rows have no Delivered Date (non-delivered statuses + a few).
- **AR:** `Invoice Amount` = Σ of the 21 charge-line `Extension`s on **all 8,320 rows**; `Invoice Amount` = `LH Revenue` + `Acc Revenue` exactly in total
  (9,106,729.69 + 922,529.21 = 10,029,258.90; `FSC Revenue` 69,361.41 is a component, not an addition; 644 rows carry FSC). `Payments Received` = Σ `Paid Amount 1..3` on every row
  (Σ 9,587,205.30); a 2nd payment exists on 11 rows, a 3rd on none; Paid Date 1 on 7,476 rows. `Bal Due` = `Invoice Amount − Payments Received − Credits + Debits` on every load row **except 81 loads**
  whose `Invoice Date` is blank (Invoice Amount total 83,159.75, Bal Due 0 — not yet invoiced; statuses COVERED 12, DELIVERED 32, LOADED 12, OPEN 19, DISPATCHED 5, CONSIGNEE 1). 30 rows have an Invoice Date and a zero Invoice Amount.
  Open balances: 294 loads positive (288 unpaid, 6 partial; Σ 360,148.53) and 6 negative/overpaid (Σ −1,254.68); Σ `Bal Due` = **358,893.85**; open rows by invoice year: 2024 → 8, 2025 → 2, 2026 → 284. There is **no terms column and no invoice-number column.**
- **AP:** `Actual Carrier Exp` Σ 5,097,611.53 vs Σ of the eight `Paid Exp Amt` 5,097,633.53 (equal on 7,915 rows); `Projected Carrier Expense` Σ 5,264,094.13; `Carrier LH` Σ 4,494,181.30; 3,759 rows have ≥1 paid-exp block, 2,262 ≥2, up to 8;
  `Quick Pay Fees` ≠ 0 on 158 rows; `Advance Fees` always 0. 4,125 load rows have a carrier name and `Actual Carrier Exp` = 0 (3,654 of them are Ivan Cartage, 471 are not). **There is no carrier-bill number and no AP balance column**:
  open AP cannot be read from the file; it is derived (§7.3) and must be checked against Ryne's Aljex AP aging report (Open Decision O-3).
- **Commissions:** rep ids on 3,794 rows (rep 2 on 17); every `Commission Amt` is 0 and nothing is `Posted` → config, not money. Not imported as `Commission` rows (§7.6).
- **Customers:** 486 distinct accounts (+9 rows with a blank account: 5 VOID, 3 DELIVERED without invoice, 1 OPEN); 3 accounts appear under more than one name (max 3). Customer address on 8,309 rows; `Customer Contact` on 39; no MC/DOT/e-mail/phone/terms/credit.
- **Carriers:** 1,673 distinct `Line Haul Carrier ID`s (1,672 non-Ivan + Ivan Cartage), 1:1 with MC/DOT (no ID has two MCs; no MC or DOT is shared by two IDs); 2 names are shared by two IDs; 60 non-Ivan IDs have no MC; MC prefix `MC` on 1,168 rows, `MX` on 2, blank 7,150; SCAC on 1,352 rows; safety rating on 7,870 rows; e-mail on ~1,150–1,342 rows, phones on ~4,085.
- **Ivan Cartage:** 3,658 rows (one carrier ID, one MC), 3,633 DELIVERED; `Actual Dispatcher` on all 3,658, `Assigned Dispatcher` on 1,186; **`Driver Name` on only 4**; `Carrier LH` Σ 41,523.16, `Actual Carrier Exp` Σ 450.00.
  `Driver Name` is populated on 2,288 rows in total, **2,284 of them non-Ivan rows** (carrier's driver; free text — names, initials, phone numbers); `Tractor #` on 357 rows. This corrects the earlier profile.
- **Stops:** `PS1` block populated on 404 loads, `PS2` on 165 (= Ryne's "165 rows have a second stop"), `PS3` 111, `PS4` 2, `PS5` 2, `PS6–12` none. Charge lines per row: 0 on 9, 1 on 6,678, 2 on 1,270, 3+ on 363;
  codes `F` (9,996 lines), `2` (403, the memos), blank code with an amount (153); descriptions are free text (several hundred distinct strings; the profile's charge-description map classifies them, §5.4).

### 3.3 Reconciliation targets and the exact bridge (all aggregates, all from the file)
| Quantity | File total | Bridge to what BCAT will hold |
|---|---|---|
| Σ `LH Revenue` (all 8,320 rows) | **9,106,729.69** | = load rows 9,119,798.28 + memo rows (−13,068.59) |
| Σ `Invoice Amount` (all rows) | **10,029,258.90** | = **invoiced loads 9,959,167.74** + 81 not-yet-invoiced loads 83,159.75 + memos −13,068.59 |
| Σ `Bal Due` | **358,893.85** | = invoiced loads 9,959,167.74 − payments 9,587,205.30 − credits 22,167.40 + debits 9,098.81 |
| Open AR in BCAT (`arOpen='OPEN'` invoices) | 360,148.53 (294 invoices) | − unapplied customer credit from the 6 overpaid loads 1,254.68 = **358,893.85** |
The memo rows are **not** posted a second time: the load-level `Credits`/`Debits` already carry them (Σ equal). The report prints the memo totals as a cross-check
(`Σ CRED = −Σ load Credits`, `Σ DEBT = Σ load Debits`, both exact) and any inequality is a blocking finding.
Invariant to pin per load: `invoice.total − Σ payment applications − Σ credit applications = balance`, with `balance = max(0, BalDue)` and overpayment kept as unapplied customer credit.
The 1k-row timed run (§11.3) reconciles against the **same quantities computed on the same slice** (and the full-file targets above when the full run happens in Phase 1).

---


## 4. Import architecture

### 4.1 Pipeline and phases
```
UPLOAD (browser → presigned PUT to the DataSafety bucket, sha256 in the browser)
  → STAGE    parse once (streaming, quote-aware, ragged-tolerant) → classify each row (LOAD | MEMO | JUNK) → write canonical JSONL chunks + indexes
  → PLAN     dry-run: the SAME engine over an overlay store (reads real tables, "writes" only to in-memory maps) → counts, conflicts, warnings, bridge totals
  → APPLY    phases in order, each resumable:
               P1 CUSTOMER  P2 CARRIER  P3 LOCATION   (masters, Map-resolved, deterministic ids, BatchWrite)
               P4 LOAD      one TransactWriteItems per PRO (final state of the whole load aggregate)
               P5 AR_LEDGER ArPayment rows grouped by (customer, check #, date); P6 AP_LEDGER ApPayment rows grouped by (carrier, check #, date)
               P7 FINALIZE  carrier loadCount/lastLoadAt, customer lastActivity, seed counter (forward-only), RETAG dry-run report, reconcile
  → RECONCILE reads the TABLES back (never engine memory) and writes the report (§7.7)
```
Each phase boundary writes the job cursor; any phase can be re-entered; every write is idempotent (§4.5).

### 4.2 Input format handling
- **Files:** one wide export is the primary input (this layout). A multi-file package is not needed for this export, but the STAGE stage is entity-oriented
  (`LOAD`, `MEMO`, plus derived `CUSTOMER`, `CARRIER`, `LOCATION`, `INVOICE`, `PAYMENT`, `BILL`, `AP_PAYMENT`, `STOP`, `CHARGE`) so a later per-entity export (customer master with terms/credit — Open Decision O-4) plugs in as an *overlay* file keyed by `Customer Account #` without touching the engine.
- **Layout detection & mapping profile.** `AljexMappingProfile` (new model, §10.1) stores, per layout fingerprint: status map, type-of-shipment→mode map, rep map (Aljex `Salesrep ID` → Cognito username),
  dispatcher map (`Assigned/Actual Dispatcher` id → `UserProfile`/Cognito, optional), charge-description→charge-code map, payment-method map (check # shape → CHECK/ACH/OTHER), plausible date window, ownAsset policy, memo policy, org-default terms. It is created pre-filled from `ALJEX_MAPPING.md` defaults, edited in the UI, persisted, versioned (`version` + `updatedBy`).
  Distinct values found in staging for every mapped categorical column are listed; **any value without a mapping blocks APPLY** until mapped or explicitly accepted ("treat as OPEN" is no longer a silent default).
- **Encoding/shape:** UTF-8 (BOM stripped); detect UTF-16 BOM and fall back to Windows-1252 if UTF-8 decoding fails (`TextDecoder` fatal); delimiter comma/tab/pipe sniffed from the header; CRLF/LF/CR; quoted fields with embedded newlines/quotes; rows shorter than the header are right-padded with blanks; rows *longer* than the header are an error row. Files > 200 MB are refused.
- **Dates:** `MM/DD/YY` (US). Two-digit-year pivot is the existing rule (`<50 → 20xx`, else 19xx) so `70` → 1970 (kept as a flagged junk date, not coerced). A date is *plausible* inside `[windowStart, windowEnd]` stored in the profile (defaults derived from the file: min/max of `Created Date`, ±1 year — not wall-clock, not a cutoff). Out-of-window `Ship Date` is junk: the pickup falls back to, in order,
  plausible `Delivered Date`, `Delivery Appt Date`, `Created Date`; if none, the shipment is **undated** (attribute omitted, §4.9 index-key rule). Date-only appointments are stored as **Chicago midnight** (`fromDateInput`, `src/lib/date.ts:272`) with `apptType` as the app writes date-only stops; invoice/paid dates are `YYYY-MM-DD` strings and ledger `receivedAt`/`paidAt` use noon UTC (the `ArPayment` precedent). `31` rows ship after delivery: kept, flagged.
- **Money:** string-exact decimal → integer cents (no `Number()*100`): accepts `$`, `,`, `(1.00)`, trailing `-`, leading `-`; >2 decimals rounds half-up and is flagged; values above 2,147,483,647 cents are row errors (AppSync Int). Money fields are `…Cents` integers like every new field.
- **Text:** NFC-normalize, collapse whitespace, strip control characters, cap lengths to the model limits used by the `UPSERT_*` validators (name 255, city 100, …); nothing is upper-cased on write (display as-is), keys are normalized separately.

### 4.3 Execution model decision (with reasoning)
| Option | Verdict | Why |
|---|---|---|
| **Server-driven async worker** (AppSync action returns in <1 s after an `InvocationType:'Event'` self-invoke; worker runs ≤ 900 s, checkpoints the cursor, re-invokes itself when < 90 s remain) | **Chosen for UI-run imports** | AppSync caps a resolver at 30 s regardless of the Lambda timeout; browser stays closed-tab-safe; no new infrastructure beyond raising `timeoutSeconds` to 900 and one `lambda:InvokeFunction` statement. Self-ARN comes from `AWS_LAMBDA_FUNCTION_NAME` at runtime (an env var holding the function's own ARN is a CloudFormation cycle); the policy resource is a name-pattern ARN built from the stack's account/region [INFERENCE: pattern verified at synth]. |
| Client-driven chunking (browser loops calls ≤ 25 s) | rejected as the default | needs the tab open for the whole run, ~dozens of calls, each re-reading S3/Maps; token refresh mid-run; no value over the worker once a cursor exists. (Still available: the router exposes `IMPORT_STEP` for the CLI/tests, which calls the same `runSlice()`.) |
| Step Functions Map / SQS | rejected | extra infra (state machine, queue, DLQ, visibility timeouts) for an 8,320-row, one-time-per-cutover job; a single ordered chain also gives deterministic entity order and no write races on masters. SQS's one real advantage (automatic crash redelivery) is replaced by `heartbeatAt` + a Resume button and Lambda's own async retry (2). |
| **Offline script** `scripts/importAljex.mjs` (same engine bundled with esbuild, DynamoDB store, run from a laptop with AWS credentials) | **Also built — it is the tool for rehearsal copies, the 1k timed run, volume tests and the production cutover** | no Lambda ceilings, direct throughput control, can target a rehearsal table set, no app deploy needed to iterate. The cutover rehearsal and the production run use the *same* bundle so what was rehearsed is what runs. Production use remains a Phase 4 decision, not Phase 0. |
Throughput reasoning: a full load aggregate is ~9–14 transaction items (≤ 100 allowed) ≈ 25 WCU; 8,320 PROs ≈ 0.2 M WCU ≈ $0.26 on-demand; at 8-way concurrency and ~40 ms per transaction a run is 1–3 minutes [INFERENCE: measured by the 1k run, §11.3]. Throttle handling: exponential back-off on `TransactionCanceledException` with `ThrottlingError`/`ProvisionedThroughputExceeded`; conditional-check cancellations are classified, not retried.

### 4.4 The job record (`AljexImportJob`, extended — §10.1)
`id = aljexrun:<ulid>` (a run, not a file hash). Fields added: `phase`, `cursor` (json `{phase, entity, chunk, offset}`), `heartbeatAt`, `startedAt`, `finishedAt`, `stageHash` (sha256 of the source), `layoutId`, `profileVersion`,
`target` (`LIVE|REHEARSAL`), `targetTag`, `liveTag`, `options` (json), `entityCounts` (json per entity: staged/created/matched/enriched/skipped/conflict/error), `reportPrefix`, `error`, `parentJobId` (the PLAN a run applies), `synthetic`. `status` enum gains
`STAGING | READY | PLANNING | PLANNED | RUNNING | PAUSED | CANCELED` beside `DRY_RUN | APPLIED | FAILED` (additive enum members). The cursor is written after every batch of ≤ 100 PROs (not per row). A job whose `heartbeatAt` is > 3 minutes old while `RUNNING` is shown as **Stalled — Resume**; `IMPORT_RESUME` re-enters at the cursor. `IMPORT_PAUSE` is graceful (checked between batches); `IMPORT_CANCEL` stops further phases and never deletes anything.
`APPLY` requires `parentJobId` = a PLANNED run with the same `stageHash`+`profileVersion`+`targetTag`; the UI sends `expectedRows`, the server refuses on mismatch; the final counts are compared with the plan's and any difference is a finding.

### 4.5 Idempotency keys (nothing is random; re-running adds nothing)
| Row | Key |
|---|---|
| ProClaim | `normalizePro(Pro #)` (the app's single PRO identity, `src/lib/proNumber.ts`; the importer's private copy is deleted — D10); conditional `attribute_not_exists(id)`; `origin:'LEGACY'`, `claimedBy:'aljex-import'`, `loadId` = the deterministic load id, so a re-run recognises its own claim (same `loadId`) and a foreign claim (different `loadId`) is a conflict |
| Shipment / Order / Load / LoadFinancials / LoadCarrier / LoadCharge | `stableId(prefix, 'aljex:'+proKey)` = `prefix-` + first 16 hex of sha256 (`shp`,`ord`,`lod`,`lcr`,`chg`; same helper as `planBackfill`, `handler.ts:6357`) |
| Invoice | `id = number = Pro #` (Master Invoice is blank on all rows; the documented "id is the number" invariant holds); conditional put; if the id exists and is not ours → `ALJ-<pro>` id, `number` unchanged, and the row is reported |
| ArPayment / ApPayment | `arp-aljex-`/`app-aljex-` + sha16 of `customerId\|check#\|date` (or `carrierId\|check#\|date`); with a blank check # the key is `pro\|n` (one payment per load); applications are merged on re-entry only if the id is new |
| CarrierBill | `cb:<loadCarrierId>:1` (the app's own id shape) |
| Customer / Carrier | `stableId('cus'\|'car', 'aljex:'+account / carrierId)` + `aljexCode` field; matched to an existing record first (§5.1/§5.2) |
| Location | `stableId('loc', normalizedName\|normalizedAddress)` after matching existing rows by the `UPSERT_LOCATION` rules |
| LegacyAljexRow | `aljex:<pro>` and `aljex:memo:<pro>` (full non-empty source row, §8.5) |
Identical duplicate rows (the 4 PROs that appear twice) collapse to one with a `DUPLICATE_ROW_IDENTICAL` skip; non-identical duplicates are conflicts (first wins, both row numbers in `conflicts.csv`).

### 4.6 Dry-run accuracy
PLAN runs `runSlice()` unchanged with `OverlayStore`: reads come from the real tables (preloaded once into Maps: ProClaim ids, `Load.aljexId`→shipment/order, Customer/Carrier/Location rows, FactoringItem ids, Driver roster, UserProfile, Division, TmsSettings, OwnershipRule) and every write lands in the overlay maps, so row N sees what rows 1..N-1 created (the preview's D7 bug cannot exist). PLAN output = APPLY output minus I/O; an automated test asserts plan counts == apply counts (§11.2).

### 4.7 Table targets and guards (rehearsal copy vs live dev vs production)
`TableSet = resolveTables(liveNames, target)`: writes go to `target.tables`, reads of reference tables (Division, Driver, UserProfile, OwnershipRule, FactoringItem) always to live. `assertTargets()` runs before every phase and throws unless:
1. no table name (read or write) ends with the production suffix `5ucwdyvwivelbo4k4jomvrwel4-NONE`, and every table name ends with the dev suffix, optionally followed by `-rh<tag>` (`^[a-z0-9]{3,12}$`);
2. a **LIVE** target requires a non-empty `liveTag` typed by the owner/ADMIN (UI confirm dialog) and recorded in the job + AuditLog; additionally for **real data** (not `synthetic`) a LIVE `APPLY` requires a `RECONCILED` REHEARSAL job with the same `stageHash` and `profileVersion`;
3. `synthetic:true` is accepted only if every staged PRO is in the reserved fixture band `900000–999999` and every staged customer/carrier name starts with `ZZ ` — then LIVE needs only the `liveTag`; a non-synthetic file can never be tagged synthetic, and a synthetic file can never be applied with seeding of the counter;
4. the Lambda's IAM policy lists the live table ARNs and the pattern `table/*-<apiId>-NONE-rh*` only. It cannot touch production tables because they have a different API id, independent of the code guard.

### 4.8 Why a bad import is recoverable although shipments are void-only
1. **Primary:** the real file never goes to live dev first. It goes to a REHEARSAL copy (§11.2): nothing to undo; the copy is dropped.
2. A LIVE dev import (the one that must happen after the rehearsal reconciles) is preceded by an on-demand backup of the ~20 touched tables (`aws dynamodb create-backup`) and by PITR (§9). If it must be undone: `scripts/importAljex.mjs rollback --run <id>` deletes exactly the rows whose `createdBy = 'aljex-import'` **and** `importRunId`/id-prefix belong to that run **and** that have `version = 1` and no later edit — a deliberate **dev-only** exception to the void-only rule (suffix-guarded, refuses production, requires `--i-understand-dev-only`; not reachable from any Lambda or UI, so the "no delete in any router" hard rule stays true). Catastrophic corruption: restore the table(s) from PITR to a new table and copy back with the same script.
3. **Production** has no rollback by deletion: its safety is the rehearsal on a restored copy of *production*, a backup immediately before, and (for enriched live records) finance-only writes with previous values stored in the audit row.

### 4.9 Index-key and field-encoding rules the engine enforces (regression guards)
- A GSI key attribute is **omitted** when empty/unknown, never `''` or NULL (Shipment: `status`, `pickupAppt`, `customerId`, `pickupMonth`, `number`; Load: `customerId`, `shipmentId`, `status`, `checkCallOpen`; Order: `shipmentId`, `customerId`, `arStatus`+`arStatusChangedAt`; Invoice: `customerId`, `arOpen`+`dueAt`, `invoiceMonth`; CarrierBill: `carrierId`, `apOpen`+`dueAt`, `billMonth`; ArPayment/ApPayment: `customerId`/`carrierId` + date; Customer/Location/Carrier: `normalizedName`, `normalizedAddress`, `mcNumber`, `dotNumber`, `status`+`name`). `arOpen`/`apOpen` are written `'OPEN'` only while open and **omitted** (not nulled) otherwise.
- JSON-typed model fields (`Order.references`, `Invoice.lines`, `billTo`, `remitTo`, Customer/Carrier `address`) are written as native arrays/objects exactly as `CREATE_SHIPMENT`/`GENERATE_INVOICE` do; `Load.stops` stays `JSON.stringify` (that is what `buildLoadInput` writes and `readStops` tolerates).
- The in-memory fake store used by the tests **rejects** empty/NULL GSI keys the way DynamoDB does (a per-table index-key map), so D1 cannot regress silently.

---

## 5. Entities

### 5.1 Customers (from columns 4–9, 25–30, 442)
- Source per row: `Customer Account #` (→ `aljexCode`), `Customer Name`, address/city/state/zip, `Customer Contact`; bill-to account/name/address when different.
- **Normalization:** `Customer.normalizedName` = the *directory* `normalizeName` (strips llc/inc/ltd/llp/corp/co/company/enterprises anywhere), imported from a new `amplify/functions/_shared/directoryKeys.ts` that **replaces the private copies** in `tms-directory-actions/handler.ts:755` and the importer (behaviour-preserving move; the directory handler's existing tests are the guard). Carriers keep `src/lib/tmsDirectory.normalizeName` (D14); the module exports both under explicit names (`customerKey`, `locationKey`, `locationAddressKey`, `carrierKey`) and a golden-corpus test pins each to its historical output.
- **Match order:** (1) existing record with the same `aljexCode`; (2) active existing customer whose `normalizedName` or any alias key equals the key (the dev tables are a production copy, so most of the 486 will already exist); (3) none → create. Two existing candidates, or a candidate with `mergedIntoId`, → conflict row, no write. A match gets only `aljexCode` set (conditional `attribute_not_exists(aljexCode)`, audited) and, for a differing spelling, an alias appended; no other field of a live customer is touched.
- **Account with several names (3 accounts, ≤3 names):** canonical = most frequent name (ties: the latest `Created Date`); the others become `aliases`.
- **Created customers:** `name`, `normalizedName`, `aliases`, `status` `ACTIVE` (→ `DORMANT` when the account's last `Ship Date` is > 365 days before the *file's* newest ship date — relative to the data, not to a cutoff; `active = deriveActiveFromStatus`), `billingAddress` (native object from columns 6–9), `contactName` from 442 (39 rows), `notes: 'Imported from Aljex acct <code>'`, `aljexCode`, `createdBy/updatedBy:'aljex-import'`. **Not invented:** MC/DOT, terms, credit limit, billing e-mail (none in the file). `paymentTermsDays` stays null so the org default applies; `creditLimitCents` null; `freeCreditRequired` untouched — customers that the org default would block from new orders ("requires an approved credit limit", `CREATE_SHIPMENT`) are listed in `customers-needing-credit.csv` (Open Decision O-4).
- **Rows with a blank account (9 rows: 5 VOID, 3 DELIVERED w/o invoice, 1 OPEN):** imported as shipments with typed `customerName` and **no `customerId`** (the Step R "unresolved" shape, `isCustomerUnresolved`); never a fabricated customer. A blank-account row that also carries an invoice is a conflict (`INVOICE_NO_CUSTOMER`) — none expected (all 9 have no invoice).
- **Not used:** `UPSERT_CUSTOMER` (it scans every active customer per call, O(n²) at 486+ and requires per-field admin rights); the engine writes rows with the same shape and keys directly.

### 5.2 Carriers (columns 39–42, 423–436, 469–473)
- **Which carriers are imported (DECIDED-7).** A carrier id is *used* when any of its loads has a plausible pickup (`Ship Date` after the junk-date rule) on or after
  `carrierWindowStart`, where `carrierWindowStart = (carrierCutoffDate ?? newest plausible Ship Date in the file) − 12 months` (`carrierWindowMonths` option, default 12). The anchor is derived from the data unless an explicit
  `carrierCutoffDate` is supplied, so the rule contains no wall-clock date and no assumed cutoff (DECIDED-3). **Promoted regardless of the window:** a carrier with any bill that would be open (delivered, unpaid) and a carrier with an in-flight load
  (`OPEN`..`CONSIGNEE`), so no open payable or live load ever points at a missing directory row. Everything else is **skipped and listed** in `carriers-skipped.csv`
  (id, name, MC, loads, newest ship date, Σ carrier cost) with the counts in the entity table.
  *Loads of a skipped carrier still import:* `LoadCarrier` (kind `CARRIER`, `status:'ACTIVE'`) carries the snapshot — `carrierName`, `carrierMc`, dispatcher/driver text, costs — and **no `carrierId`** (attribute omitted; `carrierId` is a sparse index key),
  `Load.carrierName` mirrors the name, `chargesFinalizedAt` is set (so the release gate's `CARRIER_CHARGES_UNSETTLED` stays quiet), `apStatus:'PAID'`/`apPaidAt` set, and **no CarrierBill/ApPayment** is written (they are fully paid history; Σ is reported as "paid AP history for skipped carriers"). The skipped carrier can be
  created later from the Carriers page; a follow-up `LINK_SKIPPED_CARRIERS` step in FINALIZE (also runnable on demand after a wider-window re-run) re-points `LoadCarrier.carrierId` for snapshot rows whose MC/`aljexCode` now matches a directory carrier (conditional on `carrierId` unset).
- One Carrier per *imported* `Line Haul Carrier ID`, `aljexCode` = that id. **Ivan Cartage (the one id whose name is Ivan Cartage) is not created as a Carrier**: those legs are `kind:'OWN_ASSET'` (the app defines own-asset by kind, `isOwnAssetLoad`, §8.3). The built-in own-fleet directory carrier, if one exists, is matched by name and left alone.
- Fields: `name`, `normalizedName` (`carrierKey`), `type:'TL'` (the file has no carrier type), `mcNumber` = digits of `Carrier MC #` (prefix `MC`/`MX` kept in `internalNotes`; `MX` flagged), `dotNumber`, `scac`, `authorityStatus:'UNKNOWN'`, `safetyRating` mapped from `Carrier Safety Rating` through a profile map (`SATISFACTORY|CONDITIONAL|UNSATISFACTORY|NONE|UNKNOWN`, unknown text → `UNKNOWN` + noted), `phone`, `email` (first non-blank of 423/472/473), `dispatcherName/Phone/Email` from 42 and 470, `address` null (no carrier address columns), `paymentTermsDays` null, `loadCount`/`lastLoadAt` set at FINALIZE, `aljexCode`, `internalNotes: 'Imported from Aljex <id>. Not vetted in BCAT Ops: send a MyCarrierPackets packet before booking.'`.
- **Status and gating (history intact, new rate cons still gated):** `status:'PENDING'`, `mcpStatus` **null**, `insurancePolicies` `[]` (no insurance columns), `highwayStatus`/`rmisStatus` null, **no `CarrierPaymentMethod`**. Consequences, all from existing code: not bookable (`allowedCarrierStatuses` default `['ACTIVE']`), rate con refused by `rateConMcpRefusal` ("has no MyCarrierPackets status on file, so no completed packet"), cannot be paid via the quick path until a payment method is added (bills import with `remitTo:null`; `RECORD_AP_PAYMENT` tolerates that, `apPayments.ts remitToOf`). `DO_NOT_USE`/`INACTIVE` are never inferred (nothing in the file says so). `carriers-by-activity.csv` (loads in the last 12 months of data, MC present, safety rating) is the activation worklist; bulk activation is out of Phase 0.
- **Duplicate rules (the `assertNoDuplicateCarrier` triple):** same `aljexCode` → same carrier; MC or DOT equal to an existing dev carrier → link (set `aljexCode`, nothing else); normalized-name equal and (MC equal or both MC-less) → link; normalized-name equal but MC/DOT differ → create both and flag `NAME_COLLISION` (2 such names in the file). GSI key attributes (`normalizedName,mcNumber,dotNumber,status,name`) omitted when empty (`marshallCarrierRow` rule).

### 5.3 Locations (from pickup/consignee columns + `Pick Up Address`/`Final Consignee Address` + stop blocks)
- Each stop yields `{name, street, city, state, zip, phone, contact, ref}`. Street comes from 421/422 for the two summary stops and from the block's `Address` for `PS*` stops.
- **Keys exactly as `UPSERT_LOCATION`:** `normalizedName = locationKey(name)`, `normalizedAddress = locationAddressKey({street,city,state,zip,country:'US'})` only when any address part exists; duplicate = same normalized name **and** normalized city, or same normalized address. Existing dev locations (production copy) are matched first through Maps built once per phase (no `find()` per row — D6), then created rows are added to the same Maps (so two same-named sites in different cities stay two rows, and the same address under two names collapses to the first).
- Created fields: `name`, `city`, `state`, `zip`, `street`, `country:'US'`, `normalizedName`, `normalizedAddress`, `facilityType` (`SHIPPER` if only ever a pickup, `RECEIVER` if only a delivery, `BOTH`), `active:true`, `aljexCode` unset (no location id in the file), `notes:'Imported from Aljex'`. **Deferred by design:** `lat/lng/placeId/geocodedAt/geocodeExpiresAt/timezone/geohash6` stay null (they may only come from a signed `tmsGeocode` token); the report counts locations without geocode (the geocode backlog is a later admin job).
- Contacts: stop `Phone` and `Pickup/Consignee Contact` go to `apptContactPhone/Name` only when blank on the record; nothing is overwritten on a matched location.

### 5.4 Loads, stops, charges (the per-PRO aggregate; field rules in `ALJEX_MAPPING.md`)
- **Shipment:** `id=stableId('shp')`, `number` = PRO (§6), `status` from the map, `previousStatus:null`, `customerId?/customerName`, `mode` from `Type of Shipment` map (default FTL; `AIR→AIR`, `OCN→OCEAN`, `R→RAIL`, `LTL→LTL`; every other code to a mode via the profile, unmapped blocks), `orderIds/loadIds`, `pickupAppt/deliveryAppt/pickupMonth/originCity/destinationCity` (omitted when undated), `searchKey` (lower-cased: number, PRO, customer, cities, `Reference #`, `Customer Ref #`, pickup/consignee ref), `source:'BACKFILL'`, `salesRepId` via rep map, `legacyImported:true`, `legacySource:'ALJEX'`, `importRunId`, `createdAt` = the `Created Date/Time` (Chicago→UTC) when plausible else run time, `createdBy/updatedBy:'aljex-import'`, `version:1`. No `buildState` (treated as built, `effectiveBuildState`). `voidedAt/voidedBy/voidReason` for VOID (§7.1).
- **Order:** `arStatus`/cache from §7.2, `references` (native `OrderReference[]` from `Reference #`, `Customer Ref #`, pickup/consignee refs, the 8 `Additional Ref #`; reference codes are taken from the customer's/org's `requiredReferences` code names where one matches, else `REF`), `equipmentType` null (no column), `billToId` null with the Bill-To snapshot on the invoice, `revenueCents`/`customerRateCents` from the charge sum.
- **Load:** the legacy identity columns (`aljexId = Pro #`, `tmsId = Reference # or PRO`, `pickupNumber = Pickup Ref # or PRO`, as `buildLoadInput` falls back), `customer`, `customerId?`, `stops` (`JSON.stringify`), `pickupAppt/deliveryAppt` (`''` is allowed on Load: no Load GSI sorts by it), origin/destination name+city, `rate` = revenue cents, `status` via `mapLoadStatus`, `statusSource:'BACKFILL'`, `assignmentType`, `activeLoadCarrierId`, `carrierName`, `divisionKey` + `revDivision`/`revSubdivision` (§5.6), `miles` (`Miles/Class` numeric only), `weight`, `commodity` = `Description`, `pieces` (from a `N PALLETS/SKIDS` description when parseable, else null), `deliveredAt` = `Delivered Date`, `legacyImported:true`, **no driver fields** (§8.3). Written once as an INSERT.
- **Stops:** pickup = `Pickup *` + 421 + 443 + 459; consignee = `Consignee *` + 422 + 444 + 460; `PS1..PS12` blocks add stops in block order with the marker `P`→pickup/`S`→delivery; the exact ordering/dedupe rule when a `PS` block repeats the summary stop is specified in `ALJEX_MAPPING.md`. Every stop carries `locationId`, `appt` (Chicago midnight), `apptType`, `refs`, `driverId:null`.
- **Charges:** one `LoadCharge` (CUSTOMER) per non-zero charge line (≤ 21), `code` via the profile's charge-description map (the first freight-coded line → `LINEHAUL`; a description matching the profile's fuel-surcharge pattern → `FSC`; everything else `ACC` plus the accessorial name from the `Acc Charge n` pairs, 157 distinct names), `isRate` true for LINEHAUL/FSC, `amountCents` = `Extension`, `rateCents`/`count` from `Rate`/`Units` when they multiply out, else FLAT. **Invariant (tested): Σ customer charges = `Invoice Amount` on every row** (true for all 8,320 in the file). Carrier side: CARRIER `LoadCharge` rows from `Proj Exp n/Proj Amt n/Type n` (≤ 9), `loadCarrierId` = the leg's id (D5), summing to `Projected Carrier Expense`; `LoadFinancials` computed by the same pure `computeFinancials` that `priceFor` uses.
- **LoadCarrier:** one ACTIVE leg per load that names a carrier: `kind:'CARRIER'` (non-Ivan) with `carrierId` (the created/matched directory row), `carrierName`, `carrierMc`, `dispatcherName/Phone/Email`, `driverName`/`driverPhone` from `Driver Name` (free text; a phone-shaped value goes to `driverPhone`), `truckNumber` from `Tractor #`, `quickPay`/`quickPayFeeCents` from `Quick Pay Fees`, `carrierRateCents`/`costCents`, `rateConStatus:'NOT_SENT'`, `chargesFinalizedAt` = bill date when a bill is written (the delivered date on a skipped carrier's snapshot leg), `apStatus/apOpen/apBalanceCents/apPaidAt` (§7.3), `bookedAt` = `Covered Date/Time`. `kind:'OWN_ASSET'` for Ivan rows (§8.3).

### 5.5 Reps and dispatchers
`Salesrep ID` (12 distinct incl. blank) → `Shipment.salesRepId` via the profile's rep map (Aljex id → Cognito username); `Assigned Dispatcher`/`Actual Dispatcher` (8 / 14 distinct) → `Load.carrierRepId` via the dispatcher map. **Unmapped ids leave the field null and are listed** (never guessed). `trackerId` is left unassigned (the addendum in BUILD_LOG: map or leave unassigned). Neither field picks a division (§5.6).

### 5.6 Revenue divisions (DECIDED-9) — seeding and how a row picks its division
**What exists.** Two different things are called "division": `Division` (billing entity, key `BCAT_LOGISTICS|IVAN_CARTAGE|AMAZON_DSP`, seeded by `scripts/seedDivisions.mjs` through `SAVE_DIVISION`) and `OwnershipDivision` (the *revenue* tag the board, dashboards and rules use; codes `BROKERAGE` "BCAT Logistics", `ASSETS` "Ivan Cartage" with children `OWNER_OPERATOR` "Owner Operators", `BOX_TRUCK`, `LOCAL`, then `CAR_SHIPPING` "Best Care Auto Transport" and `COMPANY`; `src/lib/ownership.ts SEED_DIVISIONS`, written with `putIfAbsent` by the seed action at `tms-directory-actions/handler.ts:3151`, edited by `SAVE_OWNERSHIP_DIVISION`, where `code` is immutable). Ryne's four are revenue divisions, so this section is about `OwnershipDivision`.
**Target state (dev):** exactly four *active* divisions — `ASSETS` named **Ivan Cartage**, `BROKERAGE` named **BCAT Logistics**, `CAR_SHIPPING` **renamed to Auto Shipping** (name and brand; same row, same code, so every rule/shipment tag keeps working), and `OWNER_OPERATOR` named **Owner Operators**.
**Mechanism (new script, dev-only, idempotent, dry-run by default): `scripts/seedRevDivisions.mjs`** using `scripts/lib/devIdentity.mjs` (`routerAs`) and the existing `SAVE_OWNERSHIP_DIVISION`, never raw deletes: (1) rename `CAR_SHIPPING` → "Auto Shipping" via `SAVE_OWNERSHIP_DIVISION` (a rename, not a new row); (2) fill `intakeEmail` only where blank with the UNCONFIRMED placeholders below; (3) **archive** (`active:false`, never delete) anything not in the list — `COMPANY`, and `BOX_TRUCK`/`LOCAL` *only after* the ownership rules that reference them are re-pointed or archived with the dry-run listing exactly which rules/shipments/drivers reference each (an archived division that a live rule still names would break `validateRules`/the tag preview; the script refuses to archive a referenced division and prints the reference list for Ryne — **Open Decision O-7**); (4) `OWNER_OPERATOR` is a child of `ASSETS` today with `owners:null, flows:null` (inherits). Making it a top-level division means copying `ASSETS`'s `owners`/`flows` onto it and setting `parentId:null` so its behaviour does not change (**O-7**: Ryne confirms top-level vs. child).
**Intake e-mail placeholders (UNCONFIRMED):** `tenders-ivan-cartage@bcatcorp.com`, `tenders-bcat-logistics@bcatcorp.com`, `tenders-auto-shipping@bcatcorp.com`, `tenders-owner-operators@bcatcorp.com`. New optional field `OwnershipDivision.intakeEmailConfirmed: boolean` (written `false` with the placeholder; `true` when an admin saves the address in the Divisions settings page); the Divisions & ownership page shows an **UNCONFIRMED** badge beside any address with `intakeEmailConfirmed !== true`; the seed script prints the list and the slice's BUILD_LOG entry lists the four addresses for Ryne. Existing non-blank `intakeEmail` values (e.g. the production copy's) are never overwritten. Dev inbound mail is not live, so a placeholder routes nothing; on a real stack an unconfirmed address must not be treated as a tender mailbox (the intake matcher `src/lib/intakeMail.ts` is told to ignore divisions with `intakeEmailConfirmed === false`, B6).
**How a row picks its division** (ordered, first match wins; stored in the profile as `divisionRules`, written by the engine as `revDivision`, `revSubdivision`, `revTagSource:'RULE'`, `revRuleId:'aljex-import'`, mirrored on Load; `Load.divisionKey` = `IVAN_CARTAGE` for Ivan rows else `BCAT_LOGISTICS`):
1. **Carrier is Ivan Cartage → `ASSETS`** (3,658 rows). This also matches the app's own seed rule (Ivan carrier → ASSETS).
2. **`Type of Shipment` in a vehicle code set → `CAR_SHIPPING` (Auto Shipping).** *Proposed, not confirmed:* `V`, `VA`, `VH`, `VM`, `VZ` (≈ 1,583 rows; `V` alone 1,520) look like vehicle transport; `ZAK` (134), `STRA` (568), `CRGO`, `W2W`/`W2H` are unknown. The profile lists every type code with its count and a division dropdown; unmapped codes fall to rule 4 and are listed.
3. **Carrier id/MC in an `ownerOperatorCarrierIds` list → `OWNER_OPERATOR`.** The file has no owner-operator marker; the list starts empty and Ryne supplies it, or it is derived from the roster (a `Driver` with `driverType:'OWNER_OPERATOR'` whose name matches the carrier name) and shown for confirmation. Until then nothing is tagged Owner Operators.
4. **Otherwise `BROKERAGE` (BCAT Logistics)**, which is also what `Mode` says on every non-blank row.
`Salesrep ID` and the dispatcher columns never pick a division (they map to people, §5.5). The existing `RETAG_SHIPMENTS` dry-run report is attached to FINALIZE so an admin can compare the engine's tags with the app's own rules before applying anything (**O-7** also asks Ryne to confirm rules 2–3). Memo shipments are tagged `BROKERAGE`.

### 5.7 "Sync imported carriers" with MyCarrierPackets (design only; DECIDED-8)
Not built in Phase 0, and Phase 0 **never asks for, reads or stores MyCarrierPackets credentials**: Ryne enters them at Integrations > MyCarrierPackets; a separate builder owns the live adapter (`https://mycarrierpackets.com/IntegrationGuide`), `Integration` row/mode (`modeOf`: `STUB` vs `LIVE`, set by Validate) and `mcp-sync`.
The step this plan reserves (action `IMPORT_SYNC_CARRIERS` in the import router, job `kind:'MCP_SYNC'`, cursor-driven like any phase):
1. **Precondition:** read the `Integration` row for `MYCARRIERPACKETS` (mode only, never its secret). If not `LIVE` → the action returns `{ ready:false, reason:'MyCarrierPackets is not LIVE (Integrations > MyCarrierPackets > Validate)' }` and writes nothing; the Import page shows the button disabled with that reason.
2. **Selection:** carriers with `aljexCode` set and `mcNumber` present and `mcpStatus` null (60 carrier ids have no MC and are listed as `no-mc`), ordered by recent-load activity (`carriers-by-activity.csv`), batches of 25 per invocation, one cursor `{lastCarrierId}`; resumable and idempotent (a carrier already carrying an `mcpStatus` is skipped).
3. **Call path:** the router invokes the mcp-sync Lambda's single-carrier entry (its `syncOne(mcNumber)` → `applyMcpToCarriers`) with `{mcNumber}` and lets *that* Lambda write the `mcp*` fields; the import never writes `mcpStatus` itself (so the rate-con gate keeps meaning "MCP says a packet exists"). Back-off on MCP rate limits; per-carrier result (`SYNCED|NO_PACKET|ERROR`) is stored in the job counts and `mcp-sync.csv`.
4. **Effect on gating:** a carrier whose sync returns a completed packet becomes eligible for a rate con (`mcpPacketStanding().completed`) — it is still `PENDING` until a person promotes it to `ACTIVE` (the booking gate), so syncing never auto-books anyone.
Interface to agree with the adapter builder (message them before B3 codes it): the mcp-sync handler must expose `{ action:'SYNC_CARRIERS', mcNumbers:string[] }` (or the router calls the existing scheduled entry per carrier); until it does, B3 implements only steps 1–2 and the job shell.

### 5.8 Overlap with loads already on dev (dedupe by `Load.aljexId == Pro #`)
The dev `Load` table is a copy of production, so own-fleet history already exists with `ProClaim`s (`backfillProClaims.mjs`). STAGE preloads two Maps: `ProClaim` ids and `Load` rows (`id, aljexId, shipmentId, orderId`, projection scan). Classification per PRO (normalized key):
| Class | Condition | Action |
|---|---|---|
| **CREATE** | no ProClaim and no Load with that PRO | full aggregate |
| **ENRICH** | a Load exists with a `shipmentId` (so a Shipment/Order exist) | **finance only**: if the order has no invoice and the file has one, write Invoice + ledger rows and set `Order.arStatus/invoiceId/invoiceNumber/invoicedAt/paidAt/arBalanceCents`; if the active leg is a CARRIER whose MC equals the file's and no bill exists, write the bill; **never** touch status, stops, driver, carrier, rates, documents, or `legacyImported` of a live record. A disagreement on revenue/carrier is a reported `ENRICH_MISMATCH`, no write. Pre-image of every touched Order/LoadCarrier is stored in the AuditLog row. |
| **UNLINKED** | a Load exists with no `shipmentId` | not touched; reported (`UNLINKED_EXISTING`) — run the existing `BACKFILL_SHIPMENT` action first, then re-PLAN |
| **CONFLICT** | ProClaim exists with a different `loadId`, or derived-shape PRO (§6.3) | skipped, in `conflicts.csv` |
PLAN prints the class counts before anything is written; they are the first thing Ryne checks in Phase 1. Ivan rows that already exist on dev (own-fleet history with drivers) are ENRICHed, never re-created.

---

---


## 6. PRO preservation and the counter (DECIDED-1)

### 6.1 What is preserved
`Load.aljexId` = `Pro #` exactly as exported (numeric, 6000..14912); `tmsId`/`pickupNumber` per §5.4; `ProClaim.id = normalizePro(Pro #)`. **`Shipment.number` and `Load.loadNumber` = the PRO** (not the backfill's `L<PRO>`):
under the numeric scheme the shipment number *is* the PRO, so imported and future shipments read the same on the board and in search. The old backfilled shipments keep their `L<aljexId>` numbers (untouched). No `nextShipmentNumber` is consumed by an import (D2).
The 403 memo PROs are imported as voided shipments (§7.5), so each holds a real `ProClaim` (`origin:'LEGACY'`, `loadId` = the memo's Load) and its number can never be re-issued.

### 6.2 The counter (verified semantics) and the seed action
`TmsSettings.nextShipmentNumber` is "last issued": `nextShipmentNumber()` does `ADD nextShipmentNumber 1` and reads the new value (`tms-shipment-actions/handler.ts:1272-1294`). So seeding to `N` makes the next new shipment `N+1`.
`IMPORT_SEED_COUNTER {apply, enableNumericScheme}` (owner/ADMIN; also run automatically at FINALIZE of a non-synthetic LIVE APPLY):
- `target = max(14912-or-staged-max, max numeric ProClaim id on the target, max numeric Load.aljexId on the target)`;
- one `UpdateItem` on `TmsSettings(id='default')`: `SET nextShipmentNumber = :target` (and `proScheme = :NUMERIC` when requested) with `ConditionExpression: attribute_not_exists(nextShipmentNumber) OR nextShipmentNumber < :target` — **forward-only and atomic**; a failed condition means the counter is already ≥ target (reported, not an error);
- preview mode returns `{current, target, wouldChange}` without writing; every apply writes an AuditLog row. The seed is **refused for `synthetic` runs and on REHEARSAL targets other than their own settings copy**.
For the real file `target` is 14912 unless dev already holds a larger numeric PRO; the first new shipment is `target+1`.

### 6.3 Collision proofing (three layers)
1. **ProClaim** conditional put is the only authority (never read-then-write). The importer uses the app's `normalizePro`, deleting its private copy (D10), so `PRO 14547`, `14547 ` and `14547` are one key.
2. **Derived-shape guard.** Today `assertNotDerivedPro` refuses typed PROs shaped like the counter's `S000123-1` (`handler.ts:1367`). The engine applies the same predicate (shared pure function moved to `src/lib/proNumber.ts`) to every staged PRO and the configured prefix; none of the file's numeric PROs match, but a future file that did is a `DERIVED_SHAPE` conflict instead of a pre-empted counter.
3. **Numeric-scheme collision loop** (below): if the counter hands out a number that is already claimed (an import with a PRO above the seed, a typed PRO), `CREATE_SHIPMENT` advances the counter (`ADD` again, up to 25 tries) before it builds the transaction, so a claimed number is never burned as an error.

### 6.4 `TmsSettings.proScheme` — the numeric scheme (additive; default `DERIVED` keeps today's behaviour)
New optional enum `proScheme: 'DERIVED' | 'NUMERIC'`. Behaviour when `NUMERIC` (slice B4, `tms-shipment-actions`):
| Site | Today | `NUMERIC` |
|---|---|---|
| `nextShipmentNumber()` `:1272` | `${prefix}${pad6(counter)}` | `String(counter)` (no prefix, no padding); `shipmentPrefix` ignored |
| `CREATE_SHIPMENT` derived PRO `:1829`, `duplicateShipment` `:3493` | `${number}-1` | `${number}` (leg 1), `${number}-${n}` for later legs (`buildLoadInput` `:1465` same) |
| `assertNotDerivedPro` `:1367` | refuses `S######-n` shapes | refuses an all-digit typed PRO whose value is ≥ the counter (it would pre-empt the counter); lower unclaimed digits stay allowed |
| `saveShipmentSettings` `:1391` | prefix/counter patch | also accepts `proScheme` (owner/ADMIN; switching to NUMERIC requires `nextShipmentNumber ≥ max claimed numeric PRO`, checked server-side) |
B4 must grep for code that parses the shape (`-1` suffixes, `S\d{6}`, `split('-')` on `loadNumber`/`aljexId`: rate-con numbers, `tracking+<shipmentId>` thread keys, search, factoring `FactoringItem.id = aljexId`, `intakeMatch`) and fix or list each before the setting is enabled. The setting is switched on dev by `IMPORT_SEED_COUNTER {enableNumericScheme:true}`, never by deploy. Fallback if Ryne ever reverses DECIDED-1 for new loads: leave `DERIVED`; imported PROs are unaffected.

---

## 7. Real statuses, invoice terms, AR/AP state, memos and reconciliation

### 7.1 Status map (persisted in the profile; unmapped blocks APPLY)
| `Dispatch Status` | Shipment.status | Load.status | Notes |
|---|---|---|---|
| `OPEN` | `OPEN` | `SOURCING` | `arStatus` `DOCS_NEEDED` |
| `COVERED` | `BOOKED` | `BOOKED` | |
| `DISPATCHED` | `DISPATCHED` | `DISPATCHED` | |
| `LOADED` | `PICKED_UP` | `PICKED_UP` | |
| `CONSIGNEE` (1 row) | `UNLOADING` | `UNLOADING` | **proposed; Ryne confirms** — not in the code's old map |
| `DELIVERED` | `DELIVERED` | `DELIVERED` | `deliveredAt` = `Delivered Date` (plausible) else the invoice/release date; `Shipment.deliveredAt` likewise |
| `VOID`, `VOID WEB` (6) | `CANCELED` + void mirror | `CANCELED` | `voidedAt` = `Created Date` (or run time), `voidedBy:'aljex-import'`, `voidReason:'Voided in Aljex'`, `Load.previousStatus` snapshot as `VOID_SHIPMENT` writes it so `UNVOID_SHIPMENT` works; arStatus `INVOICE_NOT_NEEDED`; a void row with money is a conflict (none: all 6 have no invoice and no LH) |
| blank (all 403 are DEBT/CRED) | **memo → VOIDED history** (§7.5, DECIDED-4); a blank status on a row that is *not* DEBT/CRED is a blocking `BLANK_STATUS` finding (0 in this file) |
`TONU = 'Y'` rows: `LoadCarrier.status:'TONU'`, note on the shipment. Derived overrides (reported): a load with an invoice but a pre-delivery status is forced to `DELIVERED` (an invoiced load was delivered); `Delivered Date` present with a non-delivered status keeps the file's status.

### 7.2 AR per load (Invoice, payments, credits, debits)
- **Invoice exists** iff `Invoice Date` is non-blank **and** `Invoice Amount ≠ 0` (7,816 dated load rows − 30 zero-amount rows (`ZERO_INVOICE` findings, no row) = **7,786 invoices**; the 81 undated loads with an amount are *not invoiced*; the 403 memos are never invoices).
- Fields: `number = id = Pro #`; `orderId/shipmentId/shipmentNumber`; `customerId` (required: a load without a resolvable customer cannot have an invoice — conflict); `customerName`; `billTo` (native `{name,address,email:null}` from the Bill-To columns when present else customer); `divisionKey`;
  `invoiceDate` = `Invoice Date` (`YYYY-MM-DD`); `issuedAt` = that date at noon UTC; `issuedBy:'aljex-import'`; `termsDays`/`dueAt`: **the export has no terms column** → `customer.paymentTermsDays` if the customer already has one (existing record) else the org default `TmsSettings.defaultPaymentTermsDays` (via the app's own `invoiceTermsDays`/`dueDateFor`), `termsText = Net <n>` and the invoice carries `note:'Aljex import — terms not in export; org default'`. Only the *aging buckets* depend on this, never the open balance; Open Decision O-4 asks for the Aljex customer terms/credit master;
  `invoiceMonth`, `lines` (native; the charge lines, plus a "Debit (Aljex)" line for load-level Debits), `references` (native `customerReferences(order)` shape), `subtotalCents`, `totalCents` = `Invoice Amount + Debits`, `paidCents` = Σ payment applications, `writtenOffCents:0`, `balanceCents`, `status` `PAID | PARTIAL | ISSUED`, `arOpen:'OPEN'` only for ISSUED/PARTIAL, `paidAt` = last payment date (noon UTC), `remitTo:null`, `pdfKey:null`, `factored`/`factoringItemId` (§7.3), `markedSentAt = issuedAt`, `markedSentBy:'aljex-import'`, `markedSentNote:'Sent from Aljex'` (so "not yet sent" worklists do not list 8k imported invoices), `attachDocumentIds:[]`, `sentCount:0`, `version:1`.
- **Balance rule:** `balanceCents = max(0, Bal Due)`; the load's payments (`Paid Amount 1–3`) and `Credits` are applications; `Bal Due < 0` (6 loads, −1,254.68) keeps the invoice `PAID` and records the surplus as `unappliedCents` on that payment (customer credit). Identity checked per load in the reconcile (`total − payments − credits = balance`); the 81 un-invoiced loads and the 403 memos are outside it by definition.
- **Order cache:** `arStatus` `PAID` (balance 0) / `UNPAID` (open) — never `LEGACY` when an invoice exists (credit exposure must see open AR), `invoiceId`, `invoiceNumber`, `invoicedAt`, `paidAt`, `arBalanceCents`, `arStatusChangedAt = issuedAt`.
- **No invoice:** `DELIVERED` and the 81-load/other un-invoiced set → `arStatus:'DOCS_NEEDED'` (+ `legacyImported`, so READY_TO_INVOICE can pass the gate, §8) so Ryne can bill them in BCAT; `VOID`/`CANCELED` → `INVOICE_NOT_NEEDED`; non-delivered → `DOCS_NEEDED`. A delivered, un-invoiced load older than an optional `unbilledLegacyBefore` option (default null — **no date is assumed**) goes to `LEGACY` instead.
- **Payments (P5):** per load, up to 2 `ArPayment`s (`Paid Date 1/2`, `Paid Amount 1/2`, `Paid Ck# 1/2`; the 3rd group has no check #). P5 regroups by `(customerId, check #, paid date)` when the check # is present so one remittance covering several PROs is one `ArPayment` with several `applications` (and one `unappliedCents`), else one payment per load; `kind:'PAYMENT'`, `method` from the profile map (numeric check # → `CHECK`, text such as an ACH/wire reference → `ACH`/`WIRE`/`OTHER`; a factor remittance → `FACTOR`), `receivedAt` noon UTC, `reference` = check #, `createdBy:'aljex-import'`. Load-level `Credits` become `CREDIT_MEMO` rows applied to that invoice (`reference:'ALJEX credit <pro>'`).
  Σ over all ledger rows must equal the file: PAYMENT amounts 9,587,205.30, CREDIT_MEMO 22,167.40.

### 7.3 Factoring, AP and carrier bills
- **Factored:** the file has no factoring column. Where a `FactoringItem` with `id = PRO` already exists on the target (OTR queue, production copy) the invoice is `factored:true` + `factoringItemId = PRO`; `FactoringItem` is read-only to the import. The count of invoices with a FactoringItem is in the report; `factored` otherwise false. (The Step F stance "Aljex bills live in the factoring queue" is why this link exists — O-1.)
- **Bill per load** (non-Ivan rows whose carrier is in the imported set (§5.2) and with `Projected Carrier Expense > 0` or `Actual Carrier Exp > 0`; loads of skipped carriers carry the snapshot leg and no bill): `id = cb:<loadCarrierId>:1`; `loadCarrierId/loadId/shipmentId/shipmentNumber/loadNumber`; `carrierId` (directory row from §5.2); `billNumber` = `Carrier Ref #` else the PRO; `billDate` = `Delivered Date` (plausible) else `Release Date` else `Created Date`; `dueAt = billDate + carrier terms` (carrier `paymentTermsDays` → `defaultCarrierTermsDays` → 30; nothing in the file); `grossCents`/`billedCents`/`netCents` = **the carrier's total** (`Projected Carrier Expense`, which equals `Carrier LH + Carrier Accessorial` — checked in the plan, mismatches reported) minus `quickPayFeeCents` (`Quick Pay Fees`), `varianceCents` 0; `lines` native from the carrier charge rows; `payeeKind:'CARRIER'`, `remitTo:null`, `docsOverride*` unused (the legacy flag covers the doc gate).
  `paidCents` = Σ the load's `Paid Exp Amt` blocks attributed to the carrier; `status`: `PAID` when `balance ≤ 0`; `PARTIAL`; otherwise for a **delivered** load `TO_BE_PAID` with `approvedAt = billDate`, `approvedBy:'aljex-import'`, `approvalWarnings:['LEGACY_IMPORT']` (importing them `IN_REVIEW` would flood `useApToReviewCount` and force every one through the approval blocks); a **non-delivered** load gets `LoadCarrier.apStatus:'AWAITING_INVOICE'` and no bill. `apOpen:'OPEN'` only while IN_REVIEW/TO_BE_PAID/PARTIAL.
- **Paid-expense blocks (8):** which payee an entry belongs to is the unresolved part: 3,698 block names equal the load's carrier name, 2,960 are other strings (likely expense types or other payees; 2 look like fees). Rule (to be confirmed in `ALJEX_MAPPING.md` before B2 codes it): entries naming the carrier are payments to the carrier; any other entry is an *additional bill line* (`label` = the name, GL kept in the line note) that is also paid, so bill gross = carrier total + those lines and Σ paid ties to `Actual Carrier Exp`. The pure function `apFromRow()` encodes whichever rule is confirmed and its tests pin it.
- **P6 `ApPayment`s:** grouped by `(carrierId, check #, paid date)`; `method` CHECK for numeric check #, else per map; `paidAt` noon UTC; `applications:[{billId,amountCents}]`; overpayment → `unappliedCents`. Σ equals Σ `Paid Exp Amt` (5,097,633.53) **or** the reported difference (22.00 across 405 rows vs `Actual Carrier Exp` 5,097,611.53 is a finding, not hidden).
- **Open AP (derived, not in the file):** Σ `balanceCents` over `apOpen='OPEN'` bills. The file carries no AP balance or carrier-invoice number, so this cannot be proven from the file alone; Phase 1 compares it with Ryne's Aljex AP aging report (O-3). The report also lists "delivered carrier loads with `Actual Carrier Exp = 0`" (471 non-Ivan rows) as the unpaid set.
- Ivan Cartage legs never get a bill (`billReadiness`: own-fleet legs are paid through settlements).

### 7.4 Credit exposure and aging effects
Open imported invoices sit on `UNPAID`, so `creditExposure` counts them toward limits; paid ones on `PAID`; history without an invoice on `INVOICE_NOT_NEEDED`/`LEGACY`. Aging is `ageInvoices` over the `arOpen` index (the same function the AR page uses), so the reconciliation's aging table and the screen cannot disagree.

### 7.5 Memo rows (403 DEBT/CRED) — DECIDED-4: imported as VOIDED history
A row with `Type of Shipment ∈ {DEBT, CRED}` (and blank status) is *not a load* and is never priced, invoiced, paid or shown as open. Ryne's decision is to keep each as a **voided shipment** so the number, customer and date survive in the system and in search, with the amount as a note only:
- `Shipment`: `number` = PRO, `status:'CANCELED'`, `voidedAt` = the memo's `Invoice Date` (noon UTC; run time if blank), `voidedBy:'aljex-import'`, `voidReason:'Aljex memo (DEBT)'` / `'Aljex memo (CRED)'`, `customerId?/customerName`, `legacyImported:true`, `legacySource:'ALJEX_MEMO_DEBT' | 'ALJEX_MEMO_CRED'` (the marker the UI badges as **"Aljex memo (DEBT)"** / **"(CRED)"**), `searchKey` includes `memo debt|cred`, `source:'BACKFILL'`, `revDivision:'BROKERAGE'`. No stops, no pickup/delivery dates, no `pickupMonth`/`pickupAppt` (undated shipments leave the date indexes — exactly right for a memo).
- `Order`: `arStatus:'INVOICE_NOT_NEEDED'`, `revenueCents:0`, `customerRateCents:0`, no `invoiceId`; `internalNotes: 'Aljex memo CRED: <signed amount text> on <Invoice Date> (credit already applied at load level)'` — **the amount is text in a note, not a number a report can sum** (a `memoAmountText` string; no `…Cents` field is written). The same text sits in the `LegacyAljexRow`.
- `Load`: the minimum legacy identity (`aljexId`=PRO, `tmsId`, `pickupNumber`, `customer`, `readyToInvoice:false`, `pickupAppt:''`, `deliveryAppt:''`), `status:'CANCELED'`, `voidedAt` mirrored, `previousStatus`/`previousReadyToInvoice` snapshots as `VOID_SHIPMENT` writes them, `statusSource:'BACKFILL'`, `legacyImported:true`. No `LoadFinancials`, no `LoadCharge`, no `LoadCarrier`.
- Excluded everywhere money is read: voided shipments are out of every working set and out of `deliveredNotInvoiced`; there is no Invoice or ArPayment, so open AR is untouched and the targets in §3.3 hold. Their credits/debits are already inside the load-level `Credits`/`Debits` columns (Σ equal, asserted); the report prints the memo count and net (−13,068.59) as a cross-check and `memos.csv` lists them (PRO, customer account, type, date, amount, shipment id).
- Un-voiding one is possible in principle (`UNVOID_SHIPMENT`) but would not make it a load; the marker stays so a person is told what it is.
Open question for Ryne (O-2, low priority): whether memos should additionally become customer-level `CREDIT_MEMO` ledger documents; doing so would require removing the load-level credit applications (double counting), so the default stays "note only".

### 7.6 Commissions
`Commission Rep/Amt/GNF/%/Flat/Posted ×3`: every amount is 0 and none is posted → **not** written to `Commission`/`CommissionPeriod`; preserved in the `LegacyAljexRow`. The engine writes bills directly, so `runCommissionsForOrder` (`bills.ts` RECORD_BILL path) is never invoked and nothing is paid twice.

### 7.7 The reconciliation report (what Ryne compares to Aljex in Phase 1)
Written to `imports/runs/<jobId>/` in the DataSafety bucket and shown in the UI; every number is computed by scanning the target tables after the run:
- `summary.json` + **entity table** (file rows / staged / created / matched / enriched / skipped (reason) / conflicts / errors; the invariant `staged = created+matched+enriched+skipped+conflicts+errors` per entity is asserted and a violation fails the job).
- **Money bridge** (§3.3): Σ LH revenue, Σ Invoice Amount → invoiced-load total / un-invoiced total / memo total; Σ payments, credits, debits; open AR (invoices) and unapplied credit → **358,893.85**; open AP (derived). Each line shows *file value · BCAT value · difference*; non-zero differences are listed per PRO in `variances.csv`.
- `ar-by-customer.csv` (customer, open invoices, balance, aging buckets as-of the run date or an `asOf` option, unapplied credit), `ap-by-carrier.csv`, `shipments-by-status.csv`, `charges-by-code.csv`.
- Findings CSVs: `conflicts.csv` (PRO, rows, reason), `errors.csv`, `skipped.csv` (duplicate identical rows, memos, overlap), `implied-masters.csv`, `junk-dates.csv` (PRO, which date, replacement), `unmapped-values.csv`, `ivan-driver.csv` (the 4 rows: matched/unmatched; counts of driverless Ivan rows), `customers-needing-credit.csv`, `carriers-by-activity.csv`, `enrich-mismatch.csv`, `unlinked-existing.csv`, `locations-without-geocode.csv`.
- Optional inputs typed by Ryne for the as-of date: "Aljex open AR total", "Aljex open AP total", "Aljex AR aging by customer" (CSV) — the report diffs them. No input is required to run.

### 7.8 Invoice numbering (DECIDED-6)
- Imported invoices: `number = id = Pro #` (6000..14912; no Master Invoice values exist), so the numbers staff quote from Aljex keep working in search and on the PDF.
- **New series from 20000, configurable.** Today the number comes from `nextInvoiceNumber(caller, prefix, invoiceDate)` (`finance-actions/store.ts:390`): `ADD nextInvoiceNumber 1` on `TmsSettings`, then `formatInvoiceNumber(format, {prefix, n, date})` with `TmsSettings.invoiceNumberFormat` (`invoiceNumberFormatError` requires a `{n}` token; division `invoicePrefix` defaults to `INV-`). Like the shipment counter it is "last issued". Plan (slice B4, `invoices.ts saveArSettings` `:852`):
  - new input `invoiceSeriesStart` (integer) on `SAVE_AR_SETTINGS` (owner/ADMIN; the existing `arPostingAdminOnly` rule applies); effect: `nextInvoiceNumber := start − 1` so the first new invoice is `start`;
  - validation, server-side: `start > TmsSettings.maxImportedInvoiceNumber` (new additive int written by the import's FINALIZE = max numeric imported invoice number, 14912 for this file; null when nothing was imported) **and** `start − 1 ≥` the current counter (forward-only) **and** `start ≤ 2,147,483,647`; the write is a single conditional `UpdateItem` (`nextInvoiceNumber < :new OR attribute_not_exists`), so two admins cannot move it backwards or race;
  - the setting stores `invoiceSeriesStartedAt` and `invoiceSeriesStart` for display ("Next invoice number: 20000"); the AR settings screen (existing `SAVE_AR_SETTINGS` UI; B6 finds it by grep) shows the field with the validation text; default empty → nothing changes until Ryne sets it at cutover (DECIDED-3: no date is assumed, so Phase 0 never sets it automatically; on dev the harness exercises it on a settings copy only);
  - to read as plain numbers the format is set to `{n}` (permitted by `invoiceNumberFormatError`) and no prefix; the setting action offers "Use plain numbers" which sets that format in the same write, and the preview shows the next number.
- Collisions are impossible by construction (new numbers > every imported number) and still guarded by the conditional put on `Invoice.id`.

---

## 8. The legacy flag: documents, Step W drivers, Needs-driver (replaces the "docs strategy" of the exit plan)

**DECIDED-5:** only NEW loads carry documents in BCAT Ops; every imported load (and memo) carries the flag. It satisfies the release gate, bill approval's document checks and the Step W driver gates, and keeps imported rows out of the Needs-driver report.

### 8.1 Field
`Shipment.legacyImported: boolean` + `legacySource: string` (`'ALJEX'`) and the same two on `Load`. Both are **read-only to clients** (the `voidedAt` pattern: field-level `allow.authenticated().to(['read'])` on `Load`; `Shipment` is already client-read-only) so nobody can flag a live load to dodge the gate; `apiClient.updateLoad` already strips read-only fields (`apiClient.ts:339-349`, pinned by `apiClient.loadWrite.test.ts`) and gains these two names. Written only by the import engine; no action ever clears it.

### 8.2 What it waives — paperwork only, enumerated
| Check | File:site | Legacy shipment |
|---|---|---|
| Required documents (BOL, POD, RATE_CON, customer list) | `evaluateReleaseGate` `DOC_MISSING` loop (`releaseGate.ts`); `evaluateDocGate` CUSTOMER and CARRIER scope (`shipmentDocuments.ts:425`, used by `documents.ts:243,297`, `invoices.ts:203`, `bills.ts:160`, `useShipmentDocuments.ts:84,105`) | skipped; `evaluateDocGate` returns `ready:true, missing:[]` with `legacy:true` so every strip, cached `docsMissing`, invoice preview and **bill approval** (`approvalReadiness` block "Carrier paperwork is missing") agree |
| Required references | `REFERENCE_MISSING` loop | skipped |
| **Step W driver gates** | `isOwnAssetLoad` (`ownAssetDriver.ts:44`) → `ownAssetDriverGap` at DISPATCH/DELIVERED (`handler.ts:4104-4109`), the release gate's `DRIVER_MISSING` (`releaseGate.ts:192-199`), `needsDriver` (`shipmentViews.ts:546`) and the "Own fleet · no driver" label | `isOwnAssetLoad` returns false when `legacyImported`; the release gate skips `DRIVER_MISSING`; `needsDriver` is false; the label reads "Own fleet (history)" |
**Not waived:** `VOIDED`, `CANCELED`, `NOT_DELIVERED`, `CARRIER_NOT_ASSIGNED`, `CARRIER_CHARGES_UNSETTLED` (imports set `chargesFinalizedAt` when a bill is written), `OPEN_EXCEPTIONS`, the unresolved-customer refusal, `assertBuilt`, credit checks, and the carrier gates (`mcpStatus`, status, insurance, payment method) — a legacy shipment's *carrier* is still not bookable for new work.

### 8.3 Ivan Cartage history (3,658 rows, 4 with a driver)
- Not on dev → imported as `assignmentType:'OWN_ASSET'`, one `LoadCarrier kind:'OWN_ASSET' status:'ACTIVE'`, `driverId:null`, **and no driver fields anywhere**: `Load.pickupDriverId/deliveryDriverId`, stop `driverId`, `truckId` stay null. Settlements and pay read the delivery-stop driver (`releaseGate.ts` comment on `deliveryDriverId`), so imported history cannot move a pay week; the legacy flag keeps the gates and the Needs-driver report quiet.
- The 4 rows with `Driver Name`: matched to the roster by normalized name (`Driver.name`, active, not a broker placeholder, exactly one match). A match sets `LoadCarrier.driverId`/`driverName` **on the leg only** (still no Load/stop mirror, so no pay effect) — the "Step W link". No match → `ivan-driver.csv` (`driverName` text, nothing guessed).
- 2,284 non-Ivan rows with `Driver Name`: carrier's driver, free text → `LoadCarrier.driverName` (and `driverPhone` when phone-shaped); no roster lookup (they are not our drivers).
- Already on dev (the usual case for fleet history) → ENRICH finance only; their existing drivers are untouched.
- `scripts/backfillOwnAssetDrivers.mjs` (the Needs-driver report) skips `legacyImported` loads (small edit + its existing test file).
- Pay-lock invariant checked in devVerify (§11.4): settlement totals for the last N closed weeks before and after the import are identical.

### 8.4 UI
A `TmsBadge` "Legacy - documents in Aljex archive" on the shipment header and in the Documents tab strip (tooltip: imported from Aljex on <date>, run id); the gate lists show "Waived (legacy import)" for DOC rows instead of "Missing". Owner/ADMIN link "View original Aljex record" opens the `LegacyAljexRow` (non-empty source columns as a two-column table).

### 8.5 Later (design only): importing the documents archive
If Aljex documents arrive: upload to `shipment-docs/<shipmentId>/…`, write `ShipmentDocument` rows with `source:'LEGACY'` (pointer rows already exist as a concept: `isPointerDocument`, `legacyRateConDocumentId`) keyed `ldoc:<pro>:<type>:<n>`, then recache gates; `legacyImported` stays true (history stays history) but the real documents now satisfy the gate on their own. No Phase 0 work.

### 8.6 Relationship to `arStatus:'LEGACY'`
`LEGACY` (Order) = "excluded from AR worklists and credit exposure", set by `backfillLegacyAr.mjs` and by factoring-sourced shipments. It is reused here only for aged un-invoiced freight and only if `unbilledLegacyBefore` is set. The new flag is orthogonal: it says nothing about the AR rung and everything about which *paperwork/driver* checks apply.

---


## 9. Data safety: PITR, nightly export, export-all CSV (all dev; code is stack-agnostic)

### 9.1 PITR on every table (`amplify/backend.ts`, slice B3)
Supported API, with in-repo precedent (`amplifyDynamoDbTables['Integration'].timeToLiveAttribute`, `backend.ts:2165`) and a typed setter (`pointInTimeRecoveryEnabled`, `amplify-dynamodb-table-wrapper.d.ts:126`):
```ts
for (const table of Object.values(backend.data.resources.cfnResources.amplifyDynamoDbTables)) {
  table.pointInTimeRecoveryEnabled = true
}
```
placed after `defineBackend` and before the dev guard. This flips `PointInTimeRecoverySpecification` in place on ~95 tables (no replacement, no data movement, no GSI change). PITR keeps 35 days; cost ≈ $0.20 per GB-month of table data (dev sizes unknown: B3 prints `TableSizeBytes` of every dev table before the deploy and records the monthly estimate in the build log). PITR is also what makes `ExportTableToPointInTime` and `RestoreTableToPointInTime` usable. Because the file is shared, merging `dev` → `main` later would also enable PITR on production tables — a benefit, and no action is taken toward main here.

### 9.2 Nightly export to S3: the simplest thing that works in Amplify Gen 2 branch stacks
Chosen: **a scheduled Lambda calling `ExportTableToPointInTime`** (DynamoDB-JSON, gzip, to a private bucket). Why not AWS Backup: it is restore-oriented (opaque recovery points, vault + plan + IAM role + cross-service CDK), nothing human-readable, and the stated goal is "data never locked in"; Export gives portable files (Athena/Glue/replay) with one API call per table. Why not a stream: a Scan-based copy is slower and costs RCUs; Export reads the PITR snapshot without touching table capacity.
- **Lambda `tms-data-safety`** (new, `amplify/functions/tms-data-safety/`, `resourceGroupName:'data'`, 900 s, 1024 MB). Invoked by (1) EventBridge `{kind:'NIGHTLY'}`, (2) AppSync mutation `tmsDataSafety` (owner/ADMIN), (3) itself (`Event`) to continue a long CSV job. Dispatch rule: an event with `arguments` is **always** AppSync (never honours `kind`); an event with `kind` and no `arguments` is EventBridge/self only (the Lambda resource policy admits nothing else).
- **Table discovery without a 4 KB env var:** `ListTables` filtered by the stack's suffix. `API_SUFFIX` is derived at runtime from `SHIPMENT_TABLE_NAME` (strip `Shipment-`); the IAM resource is `arn:aws:dynamodb:<region>:<account>:table/*-<apiId>-NONE` (+ `/index/*`, `/export/*`) built from `backend.data.resources.graphqlApi.apiId`, so the role physically cannot name a production table (different apiId).
- **Run:** for each table in the list, `DescribeContinuousBackups` → if PITR is off record `SKIPPED_NO_PITR`, else `ExportTableToPointInTime({TableArn, S3Bucket, S3Prefix:'exports/nightly/<YYYY-MM-DD>/<Table>/', ExportFormat:'DYNAMODB_JSON'})`, 10 at a time, record `exportArn` in a `DataExportJob` row; a second EventBridge invocation 3 h later (`{kind:'NIGHTLY_CHECK'}`) `DescribeExport`s every ARN, marks `COMPLETED|FAILED`, and writes `latestNightly` on the settings-free status read. Nightly scope: the TMS business tables daily; **all** tables on Sundays (cost control).
- **Schedule:** `cron(15 7 * * ? *)` UTC (01:15 Central standard), `Rule` `DataSafetyNightlyExportRule` in the Lambda's stack, plus `DataSafetyNightlyCheckRule`.
- **Bucket (new, not the Amplify storage bucket — its `imports/*` prefix is readable by every authenticated user and has CORS for browser PUT/GET, wrong for PII backups):** `backend.createStack('DataSafety')` → `s3.Bucket` with `blockPublicAccess: BLOCK_ALL`, `enforceSSL`, `encryption: S3_MANAGED`, `versioned:true`, `removalPolicy: RETAIN`, `objectOwnership: BUCKET_OWNER_ENFORCED`; lifecycle: `exports/nightly/` expire 35 d, `exports/csv/` expire 7 d, `imports/jobs/` (stage chunks) expire 30 d, `imports/runs/` (reports) expire 365 d, `imports/source/` (the raw Aljex files) **no expiry** (it is the lossless archive of every column the model does not map), noncurrent versions expire 90 d, abort incomplete multipart 7 d. CORS: PUT/GET from `PORTAL_ORIGINS` only (browser uploads the Aljex file and downloads reports with presigned URLs). Access only through the Lambda role (`grantReadWrite`) and presigned URLs the Lambda mints; no bucket policy for IAM users. The bucket also holds import staging/reports (§4), so PII lives in exactly one private place.
- **Enabled on dev, on purpose.** The dev guard (`backend.ts:3533`) disables **every** `CfnRule` it finds. The guard's own rule is "nothing may act on the outside world by itself": this rule reads dev tables and writes a dev S3 bucket, nothing external. Mechanism: a `KEEP_ENABLED_ON_DEV = new Set(['DataSafetyNightlyExportRule','DataSafetyNightlyCheckRule'])` allow-list consulted in the guard loop (`if (construct instanceof CfnRule && !KEEP_ENABLED_ON_DEV.has(construct.node.scope?.node.id ?? '')) construct.state = 'DISABLED'`); the `BCAT_ISOLATED_PREVIEW` loop (`backend.ts:3349`) must still list both rules so preview stacks never export. The alternative (a custom stack outside the root the guard walks) was rejected: whether `backend.createStack` stacks sit under that root is unverified [INFERENCE] and a silent guard bypass is worse than an explicit, reviewed allow-list. A manual "Run export now" button covers the case where Ryne prefers no schedule.
- **Cost (formulae; sizes measured at build time):** export $0.10/GB read; S3 $0.023/GB-month; so a nightly 5 GB scope ≈ $0.50/night plus 35 days × 5 GB × $0.023 ≈ $4/month storage, PITR ≈ $1/month per 5 GB. Weekly full + nightly TMS-only keeps it to a few dollars a month at expected dev sizes. Lambda cost is negligible.

### 9.3 Restore procedures (documented in the runbook section of the build-log entry; scripted in `scripts/importAljex.mjs`)
`pitr-restore --table <Model> --time <ISO> --as <Model>-<suffix>-rhNNN` (`RestoreTableToPointInTime` to a new table: never in place); `backup-create --tag` / `backup-restore` (on-demand backups do not depend on PITR being on yet, which matters for the first rehearsal before the PITR deploy has aged); `drop-copy --tag` deletes only tables whose names end in `-rh<tag>`. Restored tables carry no streams or triggers, so a rehearsal can never wake `shipment-notifier` & co.

### 9.4 "Export everything to CSV" — owner/ADMIN only
- **UI:** My Brokerage > Company > **Data & backups** (`/tms/brokerage/company/data`, new `DataSafetyPage.tsx`, route added in `CompanyTab.tsx`): backup status (PITR enabled count, earliest restorable time, last nightly export + result), "Run export now", **Export everything to CSV** (scope TMS | ALL, PII acknowledgement checkbox, typed `EXPORT ALL` for ALL), job progress per table, per-file Download (presigned, 15 min), "Download manifest", and the equivalent `aws s3 sync` command. Gate: the existing `CompanyTab` owner/ADMIN gate **and** the Lambda's `authorize` (owner e-mail or `ADMIN` group, as `tms-aljex-import` does) — the UI gate is cosmetic.
- **Actions** (`tmsDataSafety` mutation → `tms-data-safety`): `DATA_STATUS`, `EXPORT_NOW` (S3 DynamoDB export), `CSV_EXPORT_START {scope, tables?, acknowledgePii, confirmText}`, `CSV_EXPORT_STATUS {jobId}`, `CSV_EXPORT_LINKS {jobId}`, `EXPORT_LIST`. Each start/link action writes an `AuditLog` row (who, scope, tables, PII flag, file count).
- **Raw dumps:** one folder per table `exports/csv/<jobId>/raw/<Table>/<Table>-0001.csv…`; RFC-4180 CSV, UTF-8, header = union of attributes (`id` first, then alphabetical; found by a first scan pass), nested maps/lists as JSON text, numbers/booleans as-is (cents stay cents), no value rewriting (faithful, re-importable). Parallel scan (4 segments) in 1 MB pages; part files roll at ~40 MB; the cursor `{table, part, lastKey[]}` is saved to the job every ~20 s so a 900 s timeout resumes via a self-`Event` invoke. Very large tables are therefore bounded by S3 and time, not memory. Nested-JSON and PII notes go in `manifest.json` with row counts and SHA-256 per file.
- **Table list:** TMS scope = Shipment, Order, Load, LoadCarrier, LoadFinancials, LoadCharge, Invoice, ArPayment, CarrierBill, ApPayment, Customer, Location, Carrier, CarrierContact, CarrierPaymentMethod, CarrierDocument, ShipmentDocument, ShipmentNotice, ProClaim, Quote, TmsSettings, Division, OwnershipDivision, OwnershipRule, FactoringItem, Commission*, LegacyAljexRow, AljexImportJob, AljexMappingProfile, AuditLog. ALL = every table in the stack minus the denylist `['Integration']` (settings rows that may hold secrets). **PII tables** (flagged in the manifest and the UI before download): Driver, DriverSubmission, DriverSubmissionDoc, UserProfile, CarrierContact, Customer, Location, LegacyAljexRow, CarrierPaymentMethod (last-4 only). Presigned links are never persisted, expire in 15 minutes, and `exports/csv/` objects expire in 7 days.

### 9.5 Accountant-ready CSVs (DECIDED-2) — always part of an export-all job, also runnable alone (`ACCOUNTING_EXPORT {from?, to?, status?}`)
Four files under `exports/csv/<jobId>/accounting/`, **stable headers** (a change is a new file name suffix `-v2`, never a silent edit), UTF-8 with BOM (Excel), money as decimal dollars with two places and a leading `-` for negatives, dates `YYYY-MM-DD`, one row per record (ledger files: one row per *application*), sorted by date then id, voided rows included with their status, `source` = `ALJEX_IMPORT` when `createdBy='aljex-import'` else `BCAT`. Text cells that begin with `=`, `+`, `@` (or `-` followed by a non-digit) get a leading apostrophe so a spreadsheet cannot execute them; numbers are never altered.
| File | Headers (exact order) |
|---|---|
| `invoices.csv` | `invoice_number,pro,shipment_number,customer_id,customer_name,invoice_date,due_date,terms_days,terms_text,total,paid,written_off,balance,status,factored,factoring_item_id,division_key,issued_by,paid_date,voided_date,void_reason,source` |
| `ar-payments.csv` | `payment_id,kind,received_date,customer_id,customer_name,method,reference,payment_amount,applied_amount,unapplied_amount,applied_to_invoice_number,applied_to_pro,application_amount,reverses_payment_id,reversed_by_payment_id,note,source` |
| `carrier-bills.csv` | `bill_id,bill_number,pro,shipment_number,load_number,carrier_id,carrier_name,carrier_mc,bill_date,due_date,terms_days,gross,quick_pay_fee,net,billed,variance,paid,credited,balance,status,approved_date,approved_by,payee_kind,voided_date,void_reason,source` |
| `ap-payments.csv` | `payment_id,kind,paid_date,carrier_id,carrier_name,carrier_mc,method,reference,payment_amount,applied_amount,unapplied_amount,applied_to_bill_id,applied_to_bill_number,applied_to_pro,application_amount,reverses_payment_id,reversed_by_payment_id,note,source` |
Built by joining Invoice/ArPayment/CarrierBill/ApPayment with Customer/Carrier/Shipment/Load in memory Maps (no per-row reads). `pro` is `Load.aljexId` of the invoice's order's load. A payment with no applications emits one row with the `applied_to_*` columns blank (so unapplied credits are visible). Tests pin the header strings, the money formatting and that `Σ invoices.balance (open statuses)` equals the `arOpen` index total.

---


## 10. Schema, IAM/env/backend.ts, API surface, UI

### 10.1 Schema (`amplify/data/resource.ts`, single owner B3) — additive only; **a data deploy is forced**
| Model | Change |
|---|---|
| `AljexImportJob` | + `kind` (`IMPORT|MCP_SYNC`), `phase`, `cursor` (json), `heartbeatAt`, `startedAt`, `finishedAt`, `stageHash`, `layoutId`, `profileVersion`, `target` (`LIVE|REHEARSAL`), `targetTag`, `liveTag`, `options` (json), `entityCounts` (json), `reportPrefix`, `error`, `parentJobId`, `synthetic`; `status` enum + `STAGING, READY, PLANNING, PLANNED, RUNNING, PAUSED, CANCELED` (existing `DRY_RUN, APPLIED, FAILED` stay). Still no GSI (small table; list = scan). The old `ALJEX_IMPORT_PREVIEW/APPLY` rows stay readable. |
| `AljexMappingProfile` (new) | `id` (= `layoutId`), `fingerprint`, `headerCount`, `version`, `profile` (json: status/mode/rep/dispatcher/charge/payment maps, divisionRules, date window, carrier window, policies), `createdBy/updatedBy`. `.disableOperations(['subscriptions','delete'])`, authenticated read, Lambda write. |
| `LegacyAljexRow` (new) | `id` (`aljex:<pro>` / `aljex:memo:<pro>`), `pro`, `kind` (`LOAD|MEMO_DEBT|MEMO_CRED`), `shipmentId`, `importRunId`, `sourceSha256`, `rowNumber`, `fields` (json: only non-empty source columns keyed `c<index>`; header text kept in the profile, not repeated per row), `importedAt`. `.disableOperations(['subscriptions','delete'])`, authenticated read (UI shows it to owner/ADMIN/`page-invoicing` only — same class of data as Customer/Load). Holds every unmapped column (commissions, projected profit, flags, …): the lossless record. |
| `DataExportJob` (new) | `id`, `kind` (`NIGHTLY|NIGHTLY_CHECK|S3_EXPORT|CSV_ALL|ACCOUNTING`), `status`, `scope`, `tables` (json progress incl. exportArn/rows/bytes), `prefix`, `cursor`, `heartbeatAt`, `includesPii`, `startedBy`, `startedAt`, `finishedAt`, `error`. No subscriptions/delete. |
| `Shipment` | + `legacyImported` (boolean), `legacySource` (string: `ALJEX`, `ALJEX_MEMO_DEBT`, `ALJEX_MEMO_CRED`), `importRunId` (string). Shipment is already client-read-only. |
| `Load` | + `legacyImported` (boolean), `legacySource` (string), **both with field-level `allow.authenticated().to(['read'])`** (the `voidedAt` pattern) so a client cannot set them; add to the `updateLoad` strip list (`apiClient.ts:346`) + its test. |
| `Customer`, `Carrier`, `Location`… | + `aljexCode` (string; Location: unused for now). No GSI. |
| `TmsSettings` | + `proScheme` (`DERIVED|NUMERIC`), `invoiceSeriesStart` (int), `invoiceSeriesStartedAt` (datetime), `maxImportedInvoiceNumber` (int). |
| `OwnershipDivision` | + `intakeEmailConfirmed` (boolean). |
No existing field is renamed, removed or retyped; `ProClaim.origin` needs no change (`LEGACY`). **No new GSI** (so no table backfill). New models use `.disableOperations(['subscriptions'])` (CloudFormation resolver cap, per the brief). Net: 3 new tables, ~20 new optional fields, 8 enum members, PITR flag on ~95 tables, one new bucket, one new Lambda, two rules → one deploy; Amplify runs one job per branch, so builders do not push independently (Main deploys once after all slices land).

### 10.2 IAM / env / `amplify/backend.ts` (single owner B3)
- **`tms-aljex-import`** (`resource.ts`: `timeoutSeconds: 900`, `memoryMB: 1536`): table ARNs extended with Carrier, ArPayment, ApPayment, LegacyAljexRow, AljexMappingProfile (write) and FactoringItem, Driver, UserProfile, OwnershipDivision, OwnershipRule (read); actions add `BatchWriteItem, BatchGetItem, Scan`; **plus** the rehearsal pattern `…table/*-<apiId>-NONE-rh*` (+ `/index/*`); `lambda:InvokeFunction` on its own name pattern; S3 `grantReadWrite` on the DataSafety bucket (`imports/*`) — and **drop** the Amplify-bucket grants (`grantRead('imports/*')`, `grantPut('imports/errors/*')`) for this Lambda; env `DATA_SAFETY_BUCKET`, the new `*_TABLE_NAME`s, `MCP_INTEGRATION_TABLE_NAME` (read mode only), `USER_POOL_ID` (existing). `previewCallable` set (`backend.ts:3357`) already includes `tmsAljexImport`; add `tmsDataSafety`.
- **`tms-data-safety`**: as §9.2 (`dynamodb:ListTables, DescribeTable, DescribeContinuousBackups, ExportTableToPointInTime, DescribeExport, Scan, Query` on the apiId-pinned ARNs; `s3` on the bucket; `lambda:InvokeFunction` self; `cognito-idp:AdminGetUser` like the other routers); schema grant `allow.resource(tmsDataSafety).to(['query','mutate'])` only if it reads through AppSync (it does not — DynamoDB direct), so **no** schema-wide grant is added (smaller blast radius than `allow.resource(tmsAljexImport)`).
- **Dev guard:** allow-list + preview list (§9.2). Everything else in the guard is untouched (SES deny applies to the new Lambdas automatically).
- **Shipment/finance routers:** no new permissions (B4's edits are pure logic + `SAVE_AR_SETTINGS`/`saveShipmentSettings`).

### 10.3 API surface (`src/lib/apiClient.ts` + `src/types/tms.ts`, single owner B3)
`aljexImportAction()` (existing wrapper, `apiClient.ts:1340`) gains typed functions: `prepareAljexImport`, `getAljexImport`, `listAljexImports`, `saveAljexProfile`, `getAljexProfile`, `planAljexImport`, `applyAljexImport`, `pauseAljexImport`, `resumeAljexImport`, `cancelAljexImport`, `reconcileAljexImport`, `getAljexReportLinks`, `seedProCounter`, `syncImportedCarriers`; and a `dataSafetyAction()` wrapper with `getDataStatus`, `exportNow`, `startCsvExport`, `getCsvExport`, `getCsvExportLinks`, `listExports`. The old `previewAljexImport/applyAljexImport(input)` signatures are removed (clean cutover: `AljexImportPage.tsx` is the only caller). Types: `AljexImportJob` extended, `AljexImportCounts` replaced by `EntityCount` records, `AljexMappingProfile`, `ImportReportSummary`, `DataExportJob`.

### 10.4 UI
- **`/tms/brokerage/company/aljex-import` (rewritten, owner/ADMIN, B6):** stepper — 1 *File* (pick file, SHA-256 in the browser, layout detection "Aljex full export · 486 columns · matches/does not match the saved layout", presigned upload with progress) → 2 *Profile* (status map, type→mode/division map, rep + dispatcher maps, charge-description map, payment-method map, date window, carrier window, ivan policy; distinct-value tables with counts; unmapped values highlighted red and blocking; Save profile = persisted, versioned) → 3 *Review* (STAGE results: rows, loads, memos, junk dates, duplicate PROs, ragged rows, parse errors; row-level sample table showing **mapped fields only for 5 rows chosen by the user, masked by default**) → 4 *Plan* (class counts CREATE/ENRICH/UNLINKED/CONFLICT, per-entity table, warnings, bridge totals; "Plan again" after a profile change) → 5 *Apply* (target selector LIVE | REHEARSAL tag; LIVE requires the typed tag and shows the rehearsal gate result; live progress bar by phase/entity, rows/s, ETA, Pause/Resume/Cancel, Stalled banner) → 6 *Reconcile* (the §7.7 report tables, download links, optional "Aljex reported totals" inputs, "Seed PRO counter" card with preview, "Sync imported carriers" card disabled unless MyCarrierPackets is LIVE). A job list (status badges, phase, counts, who/when) sits above; every job is resumable from it.
- **Data & backups page** (§9.4).
- **Shipment surfaces (B4/B6):** legacy badge, "Own fleet (history)" label, waived-docs rows, "View original Aljex record" (owner/ADMIN), Documents tab strip; Needs-driver filters exclude legacy; AR settings gets `invoiceSeriesStart` + "plain numbers" (§7.8); Divisions & ownership page gets the UNCONFIRMED badge (§5.6).
- Tests: component tests for the stepper gates (APPLY disabled until PLAN ready and no unmapped values; LIVE needs the tag), the stalled/resume affordance, and the Data page's PII acknowledgement.

---

## 11. Fixtures, tests, rehearsal copy, the 1k timed run, devVerify

### 11.1 Synthetic generator (no real value ever enters the repo)
`scripts/lib/aljexFixture.mjs` + CLI `scripts/genAljexFixture.mjs --rows 1000|8320|50000 --seed N --out <dir>`: emits the **486-column layout** with the exact header strings from `scripts/lib/aljexColumns.mjs`, every field double-quoted, rows right-truncated the way the real ones are, `MM/DD/YY` dates, synthetic names/addresses/phones drawn from word lists, carrier ids/MC/DOT/SCAC as consistent 1:1 tuples, PROs in the reserved band **900000–999999**, customer and carrier names prefixed `ZZ `, a seeded RNG (reproducible) and an `expected.json` **oracle computed from the generator's own model, not from the engine** (entity counts by outcome; Σ LH/Acc/Invoice/Payments/Credits/Debits/Bal Due; open AR; unapplied credit; per-customer open balances; per-carrier open AP; bridge numbers; counts per anomaly). Realism knobs mirror the real profile: ~4.8% memo rows (DEBT/CRED with the credit/debit totals tied to load-level columns), ~44% Ivan carrier rows with a dispatcher and no driver (+0.05% with a driver), 3,000+ distinct accessorial strings, 1–3 charge lines (21 supported), up to 12 stop blocks, 2nd payment on 0.13% of rows, ~3.5% open balances (unpaid, partial, overpaid), un-invoiced loads (1%), zero-amount invoices, FSC components, quick-pay fees.
Anomalies injected (each counted in the oracle): identical duplicate PRO rows; a conflicting duplicate; junk dates (`70`, `20`, `23`, blank) and ship-after-delivery; unknown/odd statuses (`VOID WEB`, `CONSIGNEE`, lowercase, trailing spaces, a truly unknown one); blank customer account rows; an account under three names; two carrier ids with one name; carriers with no MC; `MC`/`MX` prefixes and leading-zero MCs; derived-shape PRO (`S000123`), non-numeric PRO, over-long PRO; Unicode (accents, CJK, emoji, NBSP, smart quotes), commas/quotes/newlines inside quoted fields; BOM and CRLF variants; a row longer than the header; money in `$1,234.50`, `(12.00)`, `12.00-`, three-decimal; a charge-sum ≠ invoice row; credits/debits on a load without an invoice; Bal Due not matching the identity; a carrier whose only loads are old and paid (skipped) and one whose only open bill is old (promoted); an Ivan row with a roster-matching driver and one with an unmatched driver.
Committed: the generator, its tests, and a 40-row golden file + oracle (`scripts/fixtures/aljex-synth-40.csv`, `.expected.json`). 1k/8.3k/50k are generated on demand into a temp dir; the existing `aljex-sample.csv` (31-col) and its tests are deleted with the old mapper (clean cutover).

### 11.2 Tests (behavioural; each defends a stated invariant) — vitest, in-memory store that enforces the DynamoDB index-key rule
`src/lib/aljex/*.test.ts` — parser: BOM/UTF-16/Windows-1252, delimiters, embedded newlines, chunk boundaries inside a quoted field or a CRLF, ragged rows blank-filled, over-long row rejected; **layout parity** with `aljexColumns.mjs`; positional extraction never reads a duplicated header by name; money (table of strings → exact cents, no float drift); dates (pivot, Chicago midnight across both DST changes, junk window, fallback chain); statuses (unmapped must surface); charge-line classification; terms resolution order.
`amplify/functions/tms-aljex-import/engine/*.test.ts` on the generated 1k fixture:
1. **Outcome conservation** per entity: `staged = created + matched + enriched + skipped + conflicts + errors`.
2. **Idempotency:** a second APPLY changes no row (table checksum equal) and reports 0 created; a different `runId` over the same data likewise.
3. **Plan == apply** counts, and the plan wrote nothing.
4. **Kill and resume:** a store that throws at transaction N, then a restart from the persisted cursor, ends byte-identical to an uninterrupted run (any N, including inside P4 and between P4/P5).
5. **Reconciliation invariants vs the oracle (to the cent):** open AR = Σ `arOpen` balances = oracle; unapplied credit; per-customer balances; open AP; `invoice.total − Σ payment apps − Σ credit apps = balance` for every invoice; Σ customer charges = invoice amount per row; aging buckets from `ageInvoices` equal the report; memo bridge exact.
6. **PRO invariants:** every `Load.aljexId` has a ProClaim whose `loadId` is that load; no two loads share a claim key; derived-shape and non-numeric PROs are conflicts; `PRO 14547`/`14547 ` collapse; seed counter = max numeric, forward-only, atomic under concurrent seeds; memo PROs claimed.
7. **Keys:** every Customer/Location written has `normalizedName`/`normalizedAddress` equal to the directory helper's output (golden corpus shared with `directory-actions` tests after the move); Carrier index keys omitted when empty; no `''`/NULL GSI key anywhere (the fake rejects it); undated shipments omit `pickupAppt`/`pickupMonth`.
8. **Encoding:** `Array.isArray(order.references)` and `invoice.lines` after unmarshall; `Load.stops` readable by `readStops`.
9. **Carrier window:** skipped carriers have no directory row, their loads keep the snapshot leg with `chargesFinalizedAt`, an old carrier with an open bill is promoted; window anchor comes from the data.
10. **Dedupe vs dev:** CREATE/ENRICH/UNLINKED/CONFLICT classification; ENRICH writes finance only and a live record's status/stops/driver/carrier are byte-identical afterwards; ENRICH pre-image audited.
11. **Targets/guards:** production suffix refused; LIVE without `liveTag` refused; real-data LIVE without a reconciled rehearsal refused; `synthetic` refused when a non-`ZZ` name or PRO < 900000 is present; counter seed refused for synthetic.
12. **Memos:** imported as voided shipments with the marker, no Invoice/ArPayment/charge, no open AR; Σ memo = −Σ load credits + Σ load debits cross-check passes and a perturbed oracle fails the job.
`legacyImported` gate tests (B4): flagged shipment passes `evaluateReleaseGate`, `evaluateDocGate` (both scopes), `approvalReadiness` document block and the Step W gap functions; the same shipment unflagged fails; **flag does not waive** `VOIDED/CANCELED/NOT_DELIVERED/CARRIER_*`/open exceptions; `needsDriver` false; a client `updateLoad` carrying the flag is stripped. Numeric scheme tests: `nextShipmentNumber`, derived PRO for legs 1/2, duplicate, `assertNotDerivedPro`, the collision loop (claimed number skipped, not burned), switch refused when counter < max claimed. Invoice series tests: `start ≤ maxImported` rejected, backwards rejected, race (two concurrent saves) resolves forward. Data-safety tests: authorization (non-admin refused, PII ack and `EXPORT ALL` phrase required), apiId/suffix guard, table list vs denylist, resume from cursor at a part boundary, header union, CSV escaping, the four accountant headers pinned, money formatting, formula-injection guard on text only, nightly dispatch ignores `kind` on an AppSync event.
Existing tests changed: `aljexImport.test.ts` (rewritten for the new library), the `apiClient.loadWrite` strip-list test, `ownAssetDriver.test.ts` (+legacy), `releaseGate`/`shipmentDocuments` tests (+legacy), `handler.test.ts` of shipment-actions/finance-actions/directory-actions where the moved helpers or new inputs are touched.

### 11.3 The throwaway table copy and the timed 1k-row run on the real file (Main's requirement)
**How a throwaway copy of Amplify-managed tables is made.** The tables belong to CloudFormation, so the copy must be *unmanaged siblings*: for each table in the touched set (Shipment, Order, Load, LoadCarrier, LoadFinancials, LoadCharge, Customer, Location, Carrier, Invoice, ArPayment, CarrierBill, ApPayment, ProClaim, TmsSettings, AuditLog, LegacyAljexRow) `aws dynamodb create-backup` (on-demand, point-in-time-independent) then `restore-table-from-backup --target-table-name <Model>-<devSuffix>-rh<tag>`; restores include GSIs, exclude streams/TTL/PITR/tags. Script: `node scripts/importAljex.mjs rehearsal-create --tag rh1103 [--tables …]` (waits until every table is ACTIVE, writes a manifest to `/tmp/aljex-rehearsal-<tag>.json`), `rehearsal-drop --tag rh1103` (deletes only names ending exactly `-rh1103`). Reference tables (Division, Driver, UserProfile, OwnershipRule/Division, FactoringItem, Integration, TmsSettings for reads of org defaults) are read from live; the **copy's own TmsSettings** is where the counter seed and series start land. Cost: a restore of dev-sized tables is minutes and cents; the copy is deleted after use.
**The importer takes a table-suffix target** (`--target rehearsal:<tag>` | `live:<liveTag>`; in the Lambda `options.target`), validated by `assertTargets()` (§4.7): never production (suffix + apiId), never live dev unless explicitly tagged, and real data never live without a reconciled rehearsal.
**1k timed run (Phase 0 exit):** `node scripts/importAljex.mjs run --source /Users/adminoid/aljex-export/aljex-full-export-2026-11-03.csv --slice every:8 --target rehearsal:rh1103`.
- `--slice every:8` = every 8th data row (≈1,040 rows; deterministic, spreads dates and statuses; keeps the same memo proportion). `aljexProfile.mjs` accepts the same selector so the **expected values are computed independently on the same slice** (rows, loads, memos, Σ LH, Σ Invoice, Σ payments/credits/debits, Σ Bal Due, open AR, statuses, distinct customers/carriers) — the full-file targets (9,106,729.69 / 10,029,258.90 / 358,893.85) are compared when the **full** run happens in Phase 1, using the identical bridge (§3.3).
- The script prints **stage / plan / apply wall times and rows·s⁻¹**, then the reconciliation as *aggregates only* (counts, sums, differences). Reports with row-level PII are written to `/tmp/aljex-run-<id>/` (outside the repo, mode 0600) and deleted after review; nothing row-level is printed, logged or committed. BUILD_LOG gets counts + timings + pass/fail, never values.
- Exit criteria: every oracle line equals; conflicts/errors explained; second run adds nothing; kill-and-resume equals uninterrupted; open AR slice total equals the slice's `Bal Due` sum; memo bridge holds; no `''`/NULL index errors; throughput extrapolates to the full 8,320 rows within the Lambda budget (≤ 15 min per invocation).
The same run on the synthetic fixture (1k) is the version that goes through the Lambda/UI on **live dev** under the `ZZ` tag.

### 11.4 `scripts/devVerifyAljex.mjs` (dev only; modelled on `devVerifyW.mjs`: dev-suffix guards, temp ADMIN identity from `scripts/lib/devIdentity.mjs`, ZZ naming, cleanup in `finally`)
A01 preflight: dev AppSync/pool/suffix guards, bucket exists, PITR enabled on every table (`DescribeContinuousBackups` over the apiId-suffixed list), nightly rule state ENABLED, no production table reachable. A02 generate synthetic 1k (seed 1) and upload. A03 STAGE counts == file == oracle; profile persisted and reloaded after a page reload. A04 PLAN (class counts, conflicts, no writes: table counts unchanged). A05 APPLY under `liveTag ZZ-IMPORT-1k` with timing; cursor advances in the job row every batch. A06 **fault + resume:** `options.faultAfterRows` (honoured only when `BCAT_DEV_STACK==='true'` and `synthetic`) crashes the worker mid-P4; job shows Stalled/Paused; Resume finishes; final state equals a clean run (checksum of ZZ rows). A07 **reconcile** report == oracle (every bridge line) and the AR page's aging total for ZZ customers equals the oracle; customer profile balance; AP page. A08 **idempotent re-run** adds nothing (per-table counts + checksum). A09 shipments board: All tab finds a ZZ PRO by search; imported rows absent from Active; imported Ivan rows not in the Needs-driver filter. A10 **gates:** a legacy delivered-unbilled shipment passes `READY_TO_INVOICE` → `GENERATE_INVOICE` preview; a legacy carrier bill approves with no documents; a control shipment created normally is still gated; a client `updateLoad` with `legacyImported` is refused/stripped; imported ZZ carrier gets `rateConMcpRefusal` and cannot be booked. A11 **no side effects:** zero `ShipmentNotice`, `LoadCheckCall`, `Commission` rows created for ZZ loads; stream consumers' CloudWatch error counts unchanged. A12 **pay lock:** settlement totals for the last closed pay weeks identical before/after (Ivan history wrote no driver fields). A13 Data & backups: `EXPORT_NOW` for 2 small tables completes; CSV export of Customer/Carrier/Location + accounting files: row counts equal table counts, headers equal the pinned strings, non-admin refused, link expires. A14 counter: seed preview shows target; apply refused for synthetic; a lower value is refused. A15 invoice series: below-max refused, above accepted on a settings copy. A16 divisions: dry-run of `seedRevDivisions.mjs` lists renames/archives/placeholders, no deletes. A17 UI walk (light/dark): import stepper, reconcile page, Data page, shipment legacy badge, Divisions UNCONFIRMED badge. A18 cleanup.
**Cleanup honesty.** Shipments are void-only and ProClaims are forever, so a LIVE ZZ run leaves permanent residue: ≈1k voided shipments/orders/loads, their charges/invoices (voided) / ledger rows (immutable; reversed), ProClaims, `ZZ` customers (archived), carriers (`INACTIVE`/DO_NOT_USE with reason), locations (archived), `LegacyAljexRow`s. It is **bounded** because the ZZ dataset is deterministic and reused (re-running adds nothing) and the PRO band 900000+ is reserved; and the large/real-data tests never touch live dev (rehearsal copy, dropped afterwards). The harness reports the residue counts. A completely clean live-dev state is available only by restoring from PITR/backup to a new table and copying back, which is a manual operation, not part of the harness.

---

## 12. Slices (≤ 6 builders, disjoint file ownership) and landing order

**Not mine to build (reference only):** `scripts/aljexProfile.mjs`, `scripts/lib/aljexColumns.mjs`(+test), `scripts/lib/csvStream.mjs`, `Docs/tms-build/ALJEX_MAPPING.md` (profiler builder); the MyCarrierPackets live adapter / `mcp-sync` changes (adapter builder).

| Slice | Owns (only this builder edits) | Delivers | Depends on |
|---|---|---|---|
| **B1 Library + fixtures** | new `src/lib/aljex/{layout,canonical,csv,money,dates,status,terms,charges,stops,classify,profile}.ts` + tests; delete `src/lib/aljexImport.ts`, its test, `tms-aljex-import/{mapper,parser}.ts`, `scripts/fixtures/aljex-sample.csv`; `scripts/lib/aljexFixture.mjs`, `scripts/genAljexFixture.mjs`, `scripts/fixtures/aljex-synth-40.*`; `src/lib/proNumber.ts` (+ `isDerivedPro`) | pure mapper `mapAljexRow(cells, layout) → CanonicalRow`, layout parity test, generator + oracle | profiler builder's `aljexColumns.mjs` (reads it) |
| **B2 Engine + CLI** | `amplify/functions/tms-aljex-import/engine/*` (+tests), `_shared/directoryKeys.ts` (+test) and the one-line imports in `tms-directory-actions/handler.ts` (delete private `normalizeName/normalizeAddress`), `scripts/importAljex.mjs`, `scripts/devStack.mjs` (`to !== PROD_SUFFIX` guard only) | `runSlice(store, job, profile)`, `OverlayStore`, `DynamoStore`, `MemoryStore`, reconcile, seed counter fn, rehearsal create/drop/restore, slice/rollback commands | B1 interfaces |
| **B3 Wiring + router + worker** | `tms-aljex-import/{handler.ts,resource.ts,handler.test.ts}`; `amplify/data/resource.ts`; `amplify/backend.ts`; `src/lib/apiClient.ts` (+loadWrite test strip list); `src/types/tms.ts`; new `amplify/functions/tms-data-safety/resource.ts` + the bucket/rule/PITR/guard edits | AppSync actions (§10.3), async worker + self-invoke + heartbeat, schema, IAM, PITR, bucket, rules, dev-guard allow-list, `IMPORT_SYNC_CARRIERS` shell | B2 `runSlice`, B5 handler export name, B6 needs the types |
| **B4 Gates, numeric PRO, invoice series** | `src/lib/{releaseGate,shipmentDocuments,ownAssetDriver}.ts` (+tests), `_shared/releaseGateInput.ts`, `tms-finance-actions/{bills,invoices}.ts` (docGate input; `saveArSettings` series start), `tms-shipment-actions/{documents.ts,handler.ts}` (docGate/legacy facts at `:243,:297,:4104`; numeric scheme at `:1272,:1367,:1391,:1829,:3493,:1465`), `src/features/shipments/{shipmentViews.ts,…}` + `src/hooks/{useShipments,useShipmentDocuments}.ts` (needsDriver, label, badge data), `scripts/backfillOwnAssetDrivers.mjs` (skip legacy) | the flag everywhere it matters, `proScheme`, `invoiceSeriesStart` | schema names (contract below) |
| **B5 Data-safety Lambda** | `amplify/functions/tms-data-safety/{handler,export,csv,accounting,authorize}.ts` + tests | nightly + manual S3 export, CSV export with resume, four accounting CSVs, status | B3 owns `resource.ts`/backend wiring; B5 exports `handler` |
| **B6 UI + verification + divisions** | `src/features/tms/brokerage/company/{AljexImportPage.tsx, DataSafetyPage.tsx, CompanyTab.tsx, components/*}` + tests, AR settings UI field, shipment legacy badge components, Divisions page badge, `src/lib/intakeMail.ts` (+test), `scripts/devVerifyAljex.mjs`, `scripts/seedRevDivisions.mjs` (+test) | stepper UI, Data page, badges, harness, seed script | B3 types/api |
Contracts fixed up front (so slices can run in parallel, no negotiation):
```ts
// shared types live in src/types/tms.ts (B3 writes them first, in the first 30 minutes)
type AljexEntity = 'LOAD'|'MEMO_DEBT'|'MEMO_CRED'|'CUSTOMER'|'CARRIER'|'LOCATION'|'INVOICE'|'AR_PAYMENT'|'BILL'|'AP_PAYMENT'
interface EngineStore { now(): string; tables: TableSet; getMany(t,ids): Promise<Row[]>; scanAll(t,proj?): AsyncIterable<Row[]>;
  transact(items: TxItem[], label: string): Promise<TxResult>; batchPut(t, rows): Promise<void>; update(t, id, patch, cond): Promise<boolean>;
  putJob(job): Promise<void>; putObject(key, body): Promise<void>; getObject(key): AsyncIterable<Uint8Array> }
function runSlice(store: EngineStore, jobId: string, deadlineMs: number): Promise<{ done: boolean; job: AljexImportJob }>
const LEGACY_FIELDS = { legacyImported: true, legacySource: 'ALJEX' | 'ALJEX_MEMO_DEBT' | 'ALJEX_MEMO_CRED' }   // names fixed
```
**Landing order:** B1 → (B2 ∥ B4 ∥ B5) → B3 → B6 → Main runs `typecheck && lint && test` once → **one push/deploy** (wait for no RUNNING Amplify job, per the brief) → `devVerifyAljex.mjs` → the 1k timed run on a rehearsal copy → BUILD_LOG entry. Hub coordination points: B1↔profiler builder (layout export names), B2↔B3 (`runSlice`), B3↔B5 (handler names), B3↔MCP adapter builder (§5.7).

---

## 13. Risks

| # | Risk | Mitigation / check |
|---|---|---|
| R1 | **Client-side full reads:** the legacy Load readers page `listLoads` for the *whole table* (`apiClient.ts:225`); +≈8k Load rows (stops JSON) grows every calendar/dispatch/PODs/settlement load several-fold [INFERENCE: payload not measured] | Measure `listLoads` payload and time before/after the LIVE import (A12); Open Decision O-9 (import horizon); any windowing fix is out of Phase 0 but is a Phase-1 gate before prod |
| R2 | Imported history leaks into legacy pages (calendar Unscheduled lane, dispatch "need to cover", Schedule) | imported loads set `unscheduled:false`, no driver fields, `assignmentType` `OWN_ASSET`/`CARRIER`; A09/A12 walk those pages and count |
| R3 | **Stream consumers** on production (not dev): `rateconAssignedText`/`brokerLoadAlert` act on INSERT; `shipmentNotifier`/projector on later MODIFY of imported loads | Load rows are INSERT-once with no driver; before any prod import re-read the four handlers (O-6); a later bulk edit of imported loads (e.g. a backfill) could fire notices — avoid `MODIFY` of Load in any follow-up step |
| R4 | Open AP cannot be proven from the file (no AP balance/bill number column) | derived rule + Ryne's Aljex AP aging report as a Phase 1 input (O-3); the report labels it "derived" |
| R5 | Customer terms/credit absent → aging buckets and credit blocks off | org default + `customers-needing-credit.csv`; O-4 asks for the Aljex customer master |
| R6 | Reversing the Step F stance (real Invoice rows from Aljex) could double-count factored invoices already in `FactoringItem` | link by PRO, never write FactoringItem; count in the report (O-1) |
| R7 | Numeric PRO scheme parsed somewhere as `S\d{6}`/`-1` | B4 greps and fixes before enabling; setting default `DERIVED`; flip only via the seed action |
| R8 | Dev guard allow-list is a hole in a safety mechanism | exact node-id match, listed in the guard comment and in tests (`backend` synth test asserts only the two rule ids are enabled) |
| R9 | PII: the raw export, staged JSONL and reports contain customer/carrier data | private bucket (not the Amplify bucket), lifecycle on staging, presigned 15-min links, `/tmp` only for CLI reports, no values in Docs/logs/tests; `LegacyAljexRow` is as sensitive as `Customer` |
| R10 | Lambda self-invoke ARN/cycle and 900 s on a stack that also has `BCAT_DEV_STACK` SES deny | `AWS_LAMBDA_FUNCTION_NAME` at runtime + name-pattern policy; verify at synth (`cdk` template assertion in B3) |
| R11 | A `PITR` flip on ~95 tables in one CloudFormation update could hit a per-table limit/timeout | it is an in-place property; if the stack update fails the deploy is retried (the brief: a failed deploy is fixed next); B3 may stage it as the first commit of the deploy |
| R12 | Second-stop semantics, PS-block ordering, paid-expense payee rule are unconfirmed | `ALJEX_MAPPING.md` owns them; engine functions are pure and tested per rule |
| R13 | Existing backfilled loads (prod copy) with `LEGACY` orders get Invoice rows via ENRICH, changing credit exposure | intended; the ENRICH report lists every order whose `arStatus` changes with before/after |

---

## 14. Decisions

### Already decided (see §0): DECIDED-1 … DECIDED-9.

### Open — Ryne, with the default the plan uses if he does not answer
| # | Question | Default |
|---|---|---|
| O-1 | Confirm that importing real `Invoice`/`ArPayment` rows reverses the Step F stance ("no Aljex Invoice rows") — required for the reconciliation | Yes; factored invoices linked to `FactoringItem` by PRO |
| O-2 | Memos: keep as voided history with the amount as a note (DECIDED-4) — also post them as customer-level credit/debit ledger documents? | No (would double count the load-level credits/debits) |
| O-3 | Send the Aljex **AP aging** (and AR aging by customer) for the same as-of date; the export has no AP balance | Report AP as "derived"; Phase 1 compares |
| O-4 | Send the Aljex **customer master** (terms, credit limit, MC/DOT, billing e-mail) | Org default terms; customers without credit limits listed |
| O-5 | Confirm status `CONSIGNEE`→`UNLOADING`, `LOADED`→`PICKED_UP`, `VOID WEB`→void, and the 27 `Type of Shipment` codes → mode/division | Defaults in §7.1/§5.6 |
| O-6 | Before any production import: re-read the four Load-stream consumers | Required gate, not a Phase 0 task |
| O-7 | Divisions: Owner Operators as a **top-level** division (copying Ivan's owners/flows) vs child of Ivan Cartage; archive Box Trucks, Local Drivers, Company only after their rules are re-pointed; rule 2 (`V*` → Auto Shipping) and rule 3 (owner-operator carrier list) | Keep `OWNER_OPERATOR` as is until answered; script lists references and refuses to archive a referenced division; rule 3 empty |
| O-8 | Imported Ivan Cartage history without a driver: import as history (no driver fields, flagged) vs skip entirely | History (DECIDED-5 implies this); the 4 with a driver link on the leg only |
| O-9 | Import horizon: all 8,320 rows vs only the last N months of loads (Load-table size/perf); keep older as invoices/`LegacyAljexRow` only | All rows on the rehearsal copy; decide for live dev after measuring R1 |
| O-10 | Carrier window = 12 months before the newest ship date (DECIDED-7) — anchor on file data (default) or on a date Ryne gives | File data; no date assumed |
| O-11 | Reserve PRO band 900000–999999 for fixtures | Yes |
| O-12 | Use `Shipment.number = PRO` (numeric) for imported shipments rather than the backfill's `L<PRO>` | Yes (numeric scheme) |
| O-13 | Nightly export on dev enabled by allow-list (cost ≈ a few dollars/month) vs run-on-demand only | Enabled |
