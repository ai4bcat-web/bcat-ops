# Step AW stages C, D, E: architecture and slice plan (shipments replace loads · billing method · Aljex importers + reconciliation)

Written 2026-11-07 on `merge/main-into-dev` (planning only; no source, git or AWS change). Inputs: `STEP_AW_MERGE_READINESS.md`
(incl. clarification 1 and Ryne's 30 answers), `MERGE_REGRESSION.md`, `AW_SCHEMA_DIFF.md`, `AW_PRO_LINK_FINDINGS.md`,
`AW_CREATELOAD_AUDIT.md`, `AW_SECRETS_ENV_AUDIT.md`, `PHASE0-plan.md`, `ALJEX_IMPORT_REPORT.md`, and the merged code (cited by
file:line). Ryne's answers are referenced as **R1..R30**; every one is folded in below; the OPEN ones are collected in §5.

## 0. Budget rule for all three stages (the hard constraint)
Prod-shape data stack: **968,579 / 1,000,000 B, 460 / 500 resources** (`AW_SCHEMA_DIFF.md` §6), guard 995,000 B. Decisions:
- **Zero new models, zero new GSIs, zero new Lambdas, zero new Lambda env vars or secrets.** Every need below is met with optional
  fields on existing models (JSON where the shape is a list/map), new `case` branches in existing Lambdas, and AuditLog rows
  (its `entityType+entityId` GSI already exists, `resource.ts:3894-3910`).
- Additions (all optional, all additive): Customer +4 (`billingMethod` enum FACTOR|MANUAL, `apEmail`, `invoiceCopyEmails` string[],
  `billingNeedsReview` string), TmsSettings +3 (`invoiceAlwaysCopyEmails` string[], `aljexCutoffAt` datetime, `divisionSalesReps` json),
  Carrier +1 (`aljexAliases` string[]), CarrierBill +2 (`aljexPayMethod`, `aljexVendorInvoiceRef`), AljexImportJob +1 (`decisions` json)
  and `kind` enum +`RECONCILE`, FactoringItem +0, Invoice +0, Shipment +0, Load +0. Total **11 fields, 1 enum member**.
- Expected template delta: fields live in the GraphQL schema asset, not in CloudFormation resources, so ≈0 B / 0 resources
  [INFERENCE: confirm in slice S0 with `node scripts/measureDataTemplate.mjs --prod-shape`; exit 4/2/5 = stop]. If the measure
  moves above 995,000 B, do NOT add anything: execute `AW_SCHEMA_DIFF.md` §6 contingency step 5 first (consolidate duplicate
  `PolicyStatement`s into one managed policy per Lambda; 221 statements drive the size), then step 2 (`ops` resource group for
  `tmsDataSafety`+bucket, `mcpSync`, `trackingAutomation`, `checkCallNotifier`, `loadTrackingProjector`, `shipmentNotifier`), on dev
  first, never inside the cutover deploy. `tms-directory-actions` env is at 3,495 / 3,900 est.: no slice adds an env var to it.
- GSI rule: no existing table gains a GSI in C/D/E, so the one-GSI-per-table-per-deploy question does not arise (the three Load
  GSIs are the stage A/B prep push, `CUTOVER_PLAN.md` P3).

Shared contracts for every builder: PRO key = `normalizePro` (`src/lib/proNumber.ts`); audit = `writeAudit(entityType, entityId,
action, caller, changes)` (`tms-finance-actions/store.ts:189-222`) and its shipment-actions twin; settings row `TmsSettings#default`;
Lambda-side permission = caller's Cognito groups contain `page-<key>` (`src/lib/roles.ts:144`); CSV = `src/lib/aljex/csv.ts`.

---
## 1. Stage C: Shipments replace loads

### C.1 Facts the design rests on (`AW_PRO_LINK_FINDINGS.md`)
Prod: 958 Loads, 958 with a 5-digit PRO in `Load.aljexId` (696 padded with trailing spaces, 2 written `Pro# NNNNN`), 0 duplicates,
0 without PRO, 0 Shipments, 0 `shipmentId`. Dev Aljex import matches 933 by `trim + one leading 'L' + normalizePro`; the 25
unmatched are PROs 14913..14939 (minted after the Nov 3 export) plus outlier 99001. Rehearsal = a copy of prod, so Shipments exist
there only after the 500-export import runs (§3 E.1).

### C.2 Link rule (clarification 1), order of operations on the rehearsal
1. **Aljex import first, with the new LINK class.** `tms-aljex-import` classifies a PRO today as CREATE / ENRICH / UNLINKED /
   CONFLICT (`PHASE0-plan.md` §5.8); UNLINKED (a Load with that PRO and no `shipmentId`) is "run BACKFILL first". New class
   **LINK** replaces that: build the Shipment/Order/LoadFinancials/LoadCharge/LoadCarrier/ProClaim aggregate from the Aljex row as
   CREATE does, but **reuse the existing Load row**: `Shipment.loadIds=[load.id]`, no Load INSERT, one `UpdateItem` on the Load
   setting ONLY `shipmentId, orderId, loadNumber (= PRO), leg (= 1)` with `ConditionExpression attribute_not_exists(shipmentId)`.
   Nothing else on the Load is written (not `aljexId`, status, stops, driver, rate: "link adds only, never edits/deletes").
   Key: `normalizePro(load.aljexId)` == `normalizePro(shipment number with ONE leading 'L' removed when the rest still normalises to
   ≥3 chars)`; trim and `Pro#` stripping come from `normalizePro`; **no leading-zero stripping** (`factoring-intake/handler.ts:140`
   preserves them). `S######` / `L...` counter shapes never match through `-1` parsing (`isDerivedPro`).
2. **ID-link fallback** for every Load still without `shipmentId` after step 1 (the 25 post-export PROs, 99001, and any no-PRO
   load: 0 today, still coded): existing `BACKFILL_SHIPMENT` (`tms-shipment-actions/handler.ts:7948-8083`, ids
   `stableId('shp'|'ord'|'chg', loadId)`, ProClaim origin BACKFILL, skip reasons ALREADY_LINKED / SHIPMENT_VOIDED /
   PRO_CLAIMED_BY_OTHER_LOAD) via `scripts/backfillShipments.mjs` (plan → apply, fingerprint-validated).
3. **Dry-run report** (one Markdown + CSV, `imports/runs/<job>/link-report.*`): `matched-by-PRO` (LINK), `linked-by-ID` (backfill),
   `ambiguous (needs Ryne)` (PRO resolves to >1 Shipment, or ProClaim held by a different loadId, or `L<pro>` and digits-only rows
   both present), `unmappable` (no PRO and backfill skip). Counts must add up to the Load count; nothing is written on dry run.
4. **Idempotent:** the conditional link, deterministic ids and ProClaim make re-runs no-ops; a second PLAN shows 0 LINK candidates.
   Stream note: the link `UpdateItem` is a MODIFY on Load; `shipment-notifier` and `load-tracking-projector` handle MODIFY
   (`PHASE0-plan.md` §2.6) and must ignore a change touching only link fields (test in C4).

### C.3 Nav and routes
`/loads` → `/tms/shipments` exists (`App.tsx:196`); `/grid` (`:276`), `/shipments/:id` (`:198`) exist. **Missing: `/loads/:id`** (not
found). Add `LoadRedirect`: reads `Load` by id (`getLoad`, client-readable), redirects to `/tms/shipments/<shipmentId>`; if the Load
has no `shipmentId` yet → `/tms/shipments?q=<normalizePro(aljexId)>`; unknown id → `/tms/shipments` with a toast. Also
`/loads?id=…`, `/calendar?load=…` style bookmarks: keep query params through the redirect. Nav label stays "Active shipments"
(`navSections.ts:126`, pageKey `loads`); "Loads" never appears. Pin all of it in `src/App.routes.test.tsx` (MERGE_REGRESSION T1/T14).

### C.4 Two-way consistency
Today Shipment→Load mirroring lives inside `tms-shipment-actions` (dates/cities 2084, stops `updateStop` 4440, rep 3335, tag 3181,
void ~2898, carrier ladder 5364); Load→Shipment propagation from the driver app **does not exist** (`driver-app-api` writes `stops`,
`trailerNumber`, `paperworkLocation`, `sortOrder/daySlot` straight to Load, 1524/3291/3339/3396; grep `shipmentId` there: none).
Design: extend `load-tracking-projector` (already a Load-stream MODIFY consumer that stamps LoadCheckCall and Load.status) to mirror
onto the parent Shipment when `shipmentId` is set: `stops[].arrivedAt/departedAt` → `Shipment.status` via the existing status
ladder (PICKED_UP / IN_TRANSIT / DELIVERED, `deliveredAt`), `trailerNumber` → Shipment equipment note, `sortOrder/daySlot` → no
shipment field (dispatch-only), `paperworkLocation` → Shipment reference. Idempotent (compare before write), ignores link-only
MODIFYs (C.2 step 4), never writes a voided shipment.
Tests (both directions, in-memory fake tables as `handler.test.ts` does): (a) shipment edit (stop appt, customer, carrier) → the
Load fields the calendar (`PlannerView`), dispatch (`driverWhereabouts`) and `GET /paperwork` read; (b) driver `POST
/paperwork/stop-event`, `/paperwork/reorder`, `/me/trailer` → projector → Shipment status/deliveredAt and ShipmentPage shows it.

### C.5 Division and sales rep (R4), codes not imported, history window (R19-R21)
- Rev Type map **B=BCAT Logistics (BROKERAGE), I=Ivan Cartage (ASSETS), A=Bestcare Auto Transport (CAR_SHIPPING), O=owner
  operators (ASSETS/OWNER_OPERATOR)**. Aljex Rev Type is already stored as ShipmentReference `ALJEX_REV_TYPE`
  (`engine/aggregate.ts:169`), and `OwnershipRule.condition.kind` already has `REFERENCE_MATCHES` (`resource.ts:3232`,
  `src/lib/ownership.ts:122-140`). So: four seeded OwnershipRules `REFERENCE_MATCHES ALJEX_REV_TYPE=B|I|A|O` placed after the
  existing own-asset/owner-operator carrier rules (so a specific owner-operator driver/carrier attached still wins, matching "a load
  is owner operator when an owner-operator driver/carrier is attached") and before the BROKERAGE default. Importer `divisionRules`
  (`src/lib/aljex/profile.ts:208-213`) get the same four entries. Customers get `defaultDivisionKey` from their Rev Type where present.
- **Sales rep by division, not by Aljex rep code:** `TmsSettings.divisionSalesReps` json `{BROKERAGE, ASSETS, CAR_SHIPPING,
  OWNER_OPERATOR} → salesRepId`, edited on the Divisions settings page with a user picker (no e-mail or username in code). Seed
  values: BROKERAGE = Ryne Bandolik's login, CAR_SHIPPING and OWNER_OPERATOR = Ruben Vargas's login, ASSETS = a non-login
  `UserProfile` row `ivan-cartage` (displayName "Ivan Cartage", role NONE, status ACTIVE) so `assertRepProfile` (`handler.ts:3335`)
  accepts it. `applyTag`/`RETAG_SHIPMENTS` set `salesRepId` from the map when the shipment has none or its rep came from a rule
  (never over a HAND-set rep). `SET_SALES_REP` mirrors to Load.salesRepId and Order.customerRepId as today.
- **Not imported:** `salesRepCode`, `createdByCode`, `serviceRepCode`, `dispatcherCode` stay unset by the importer (`aggregate.ts:453-458`
  branch removed); `Load.carrierRepId` is never set from the dispatcher columns; `AljexCodeMap` reassignment loop becomes a no-op.
- **24-month window, cutoff 2026-11-07 00:00 America/Chicago** (R19, R20): `TmsSettings.aljexCutoffAt` is written once by the admin
  (Settings > Company > Data) and read by every stage-E layout: loads/invoices/bills with ship date < cutoff − 24 months are
  skipped and counted (`history-skipped.csv`), nothing after the cutoff is imported (delta import is OPEN-19). Carried-over marking
  (R21) uses existing fields: `legacyImported:true`, `legacySource:'ALJEX'`, `importRunId`, and on Invoice/CarrierBill
  `markedSentAt = issuedAt`, `markedSentNote = 'Carried over from Aljex (cutoff 2026-11-07)'`. Shipment/Invoice/Bill pages show a
  "Carried over" badge from those; the Send/queue actions refuse carried-over invoices (`whyNotFactorable` + `emailInvoice` guard).

### C.6 Numbering from 20000 (R9, OPEN on scope)
Design (not wired): both counters are "last issued" (`handler.ts:1490-1516`, `store.ts:390-412`) with forward-only admin setters
(`SAVE_SHIPMENT_SETTINGS` 1629-1647 incl. `proScheme` NUMERIC switch; `SAVE_AR_SETTINGS invoiceSeriesStart` 903-924 validated
against `maxImportedInvoiceNumber`). The floor is therefore `nextShipmentNumber = 19999` + `proScheme = NUMERIC` and/or
`invoiceSeriesStart = 20000`. **The exact switch:** `node scripts/seedSeries20000.mjs --scope shipments|invoices|both --apply`
(new, prod-gated like the 18 gated scripts, dry-run default, refuses when the current counter ≥ 19999, writes an AuditLog row).
**Do not wire until Ryne confirms shipment/PRO and invoice scope** (dev rehearsals already minted voided 20000/20001 invoices,
`BUILD_LOG.md:552`). Safe default meanwhile: counters continue from the imported maximum (`IMPORT_SEED_COUNTER`).

### C.7 Data, libs, actions, UI, tests, risks
- Data: none beyond §0 (`aljexCutoffAt`, `divisionSalesReps`). Pure libs: `src/lib/shipmentLink.ts` (`linkKeyForShipmentNumber`,
  `classifyLinkCandidates` → the four report buckets), `src/lib/divisionSalesRep.ts` (`salesRepForDivision(settings, shipment)`).
- Lambda: importer LINK class + report; `load-tracking-projector` Shipment mirror; `applyTag` rep assignment.
- UI: `LoadRedirect`, Divisions page rep picker, Carried-over badge, cutoff field on Data page.
- Tests: link classifier unit (padded/`Pro#`/`L`-prefixed/digits/`S######`/duplicates/no-PRO), importer LINK plan==apply counts,
  backfill fallback, projector both directions, App routes, division rules precedence (owner-operator carrier beats Rev Type O).
- Risks: ProClaims from `backfillProClaims.mjs` on prod loads make LINK rows ENRICH-like conflicts if `loadId` differs → report as
  ambiguous, never guess; stream consumers waking on the link MODIFY (tested); the 25 post-export PROs get `L<pro>` backfill
  numbers while imported ones are digits (accepted: search handles both; OPEN-19 delta may replace them, hence idempotency).

---
## 2. Stage D: Customer billing method, Billing setup, release to billing

### D.1 Data (Customer +4, TmsSettings +1) and seeding (R1-R3, R6, R10, R16)
- `billingMethod` FACTOR|MANUAL (unset = not set), `apEmail` (required when MANUAL; shown as note for FACTOR), `invoiceCopyEmails`
  string[] (per-customer copy list), `billingNeedsReview` (text reason; cleared when a human saves the row). Terms stay
  `paymentTermsDays` (R10: Net 30 default = `TmsSettings.defaultPaymentTermsDays=30`; Danisco = 120 as a per-customer override;
  candidates DANISCO US INC. 100338, DANISCO USA INC. 100629 and any "DANISCO US, INC." variant: OPEN-10, none set until Ryne picks).
  The factor is the single `TmsSettings.factorRemitTo` record (R16); FACTOR customers display it read-only. Credit limit:
  existing `creditLimitCents`; over-limit is a flag, never a block (R14).
- `TmsSettings.invoiceAlwaysCopyEmails` seeded `['invoices@bcatcorp.com']` (R3), editable in Settings; applied on every MANUAL send
  in addition to the per-customer list; never on FACTOR (no customer e-mail at all).
- **Seed rule** (pure `src/lib/billingMethod.ts: seedFromAljexRow`), applied through the stage-E customers layout preview: FACTOR iff
  `E-Billing Email` is exactly `ivanfactoring@bcatcorp.com`; MANUAL + `apEmail` = that address otherwise; rows whose address is
  an internal BCAT address (`@bcatcorp.com`) are MANUAL never FACTOR (R1) with `billingNeedsReview='internal billing address'`
  except the 7 on `invoices@bcatcorp.com` which are MANUAL with `apEmail` unset and the review note; the 2 on
  `invoicefactoring@bcatcorp.com` are MANUAL, `apEmail` unset, flagged OPEN-1; Batory Foods MANUAL; `Invoice by = P` rows
  e-mail like the rest (R2, informational only); **flagged rows are listed as "needs review" and NOT applied** (only `billingNeedsReview`
  is written so the Missing filter finds them). Inactive (Status N) customers get no method (they become Locations, R29).
  Exclusions R6: TEST CUSTOMER acct 100003 and names matching `^ZZ|test` skipped; GUEST SUPPLY imported.

### D.2 Billing setup screen (Customers > Billing setup, `/tms/customers/billing-setup`, page key `customers`)
Table of every active customer: method, AP e-mail, copy list, terms, loads last 12 months (from `Shipment` by customer), review
note; header counts N factor / N manual / N not set; filter **Missing** (method unset OR MANUAL without apEmail OR needs review);
inline edit (writes through `UPSERT_CUSTOMER` in `tms-directory-actions`, audited `BILLING_METHOD_SET` with before/after); **CSV
export** (customer, aljexCode, method, apEmail, copyList, termsDays, note) and **CSV import** with a preview (new/changed/invalid
rows, duplicate account numbers, unknown customers) before apply; parser = `src/lib/aljex/csv.ts`. Also surfaced on the Customer
form Billing tab (`CustomerForm.tsx:16`).

### D.3 Release to billing (R3/R4 of 11-08, R15, R17) — one finance action
New `tms-finance-actions` action **`RELEASE_TO_BILLING {orderId, clientRequestId}`** (Load Review "Move to billing",
`LoadReviewDrawer.tsx:93`, and the AR worklist both call it; the shipment-actions batch task keeps only its review bookkeeping):
1. **Permission:** caller must hold Cognito group `page-billingRelease` (new OFF_NAV grant key `billingRelease`, label "Release to
   billing / Send invoice", `navItems.ts:142`). No role bypass, ADMIN included (R17 "permission, not role-wide"). Assignment: Users
   page checkbox → `setPageGroups` → `UserProfile.extraPages` (`userManagement/handler.ts:700-715`); Ryne ticks Jenny's login; no
   e-mail or username anywhere in code. `EMAIL_INVOICE`, `BATCH_EMAIL`, `SEND_TO_FACTOR`, `MARK_SENT` require the same group.
2. **Gate:** `evaluateReleaseGate` as today (legacy rows exempt), then refusals with reasons: `BILLING_METHOD_UNSET`,
   `AP_EMAIL_MISSING` (MANUAL), `CARRIED_OVER` (never re-bill Aljex history), `CUSTOMER_UNRESOLVED`. Over credit limit →
   `warnings:['OVER_CREDIT_LIMIT']`, audit line, badge; never a refusal (R14).
3. **Invoice:** `generateInvoice` (idempotent: `Order.invoiceId` set → reuse; `Invoice.id` conditional put).
4. **FACTOR:** `sendToFactor` (`factor.ts`) with `factoringRowFor` (`src/lib/factorHandoff.ts:178-203`): `id=proNumber=PRO`,
   status `NEED_TO_FACTOR`, `source:'TMS'`, subject/fromEmail/receivedAt/messageId `tms:<invoiceId>`, loadId/customerId/invoiceId/
   orderId/shipmentId, `otrManualFields` — the same row the e-mail bridge produces (`factoring-intake/handler.ts:252-272` writes the
   subset; the queue UI renders both, MERGE_REGRESSION T8). Existing merge-into-unsubmitted-row path keeps it idempotent. Audit
   `PUSHED_TO_FACTORING_QUEUE_ON_RELEASE` on Invoice and Shipment. **No customer e-mail.** Old bridge untouched (R15).
5. **MANUAL:** invoice stays `ISSUED` with `sentAt` null = "Ready to send" (computed, no field). **Send** = `EMAIL_INVOICE` with
   recipients `to=[apEmail]`, `cc = invoiceCopyEmails ∪ invoiceAlwaysCopyEmails` (deduped), PDF via `RENDER_INVOICE_PDF`, logged on
   the invoice (`sentAt/sentTo/sentCount`, ShipmentNotice) and as audit on the Shipment. Re-send allowed, counted.
6. **Idempotency:** re-release returns the existing invoice/queue row and `alreadyReleased:true`; never a second invoice or row.
Payments (R11): `RECORD_PAYMENT` already stores `method` CHECK|ACH|WIRE|CARD|FACTOR|OTHER + `reference` (`resource.ts:2417-2442`);
`RECORD_AP_PAYMENT` must carry the same two (verify `ApPayment`; add `method`/`reference` if absent: +2 fields). No execution.
Quick pay (R13): `LoadCarrier.quickPay/quickPayFeeCents` and the carrier setting are kept and keep adjusting the bill.

### D.4 Post-invoice change rule and timeline (R18)
Edit actions in `tms-shipment-actions` (`SAVE_ORDER_FORM`, `UPDATE_ORDER_DETAILS`, `UPDATE_STOP`, `UPDATE_LOAD_CARRIER_DETAILS`,
charge edits) and finance adjustments: when the order has an invoice (`arStatus` UNPAID/PAID/PARTIAL or `invoiceId` set) the
action **requires `changeReason`** (refusal `REASON_REQUIRED`), succeeds, and writes AuditLog on the Shipment AND the Invoice
`{action:'POST_INVOICE_CHANGE', reason, before, after, user, at}`. A change made in the factoring queue (FactoringPage manual
fields / amount) calls finance `SYNC_FACTORING_CHANGE {proNumber, changes, changeReason}` which updates Invoice lines/total,
Order revenue and LoadCharge in one transaction and writes the same audit on all three (propagates system-wide). UI:
`ChangeTimeline` ("What happened") on ShipmentPage and InvoiceDetail reading `listAuditLogsFor(entityType, id)` (GSI exists),
merged chronologically with release/send/queue/payment events.

### D.5 Tests and risks
Tests: seed rule table (ivanfactoring / invoices@ / invoicefactoring@ / external / internal-other / P rows / inactive / TEST /
ZZ / GUEST SUPPLY); refusals (unset, MANUAL no AP, carried-over, no grant incl. ADMIN); FACTOR path row shape deep-equals what the
queue renders; MANUAL send recipient set incl. always-copy dedupe; idempotency (double release); over-limit warns not blocks;
reason required only once invoiced; timeline order; CSV preview invalid rows; Billing setup counts. Risks: grant check must be
Lambda-side (UI hiding is not security); `tms-directory-actions` UPSERT_CUSTOMER is O(n) per call (fine for inline edit; CSV
apply writes rows directly like the importer); sender identity for MANUAL mail is `FROM_ADDRESS` (`store.ts:70`): live tests only
to ai4bcat@gmail.com.

---
## 3. Stage E: Aljex importers per file + reconciliation + Integrations

### E.1 One engine, per-file layouts (dry-run then apply)
Reuse `tms-aljex-import` (router actions `IMPORT_PREPARE … IMPORT_STEP`, `router.ts:51-70`; CLI `scripts/importAljex.mjs`;
`AljexMappingProfile.layoutId`). The **500 export** keeps the Step X path (`layoutId FULL_EXPORT`, + LINK class from C.2). New
layouts, each a module under `src/lib/aljex/layouts/`: `CUSTOMERS_MASTER`, `CARRIERS_MASTER`, `AP_AGING`, `AP_EXPECTED`,
`ACTIVE_SHIPMENTS`. STAGE drops the sensitive columns **by header before anything is written** (`Web Password`, `Bank Account`,
`Routing #` are never staged; counts only), and `Fed/SS #` is routed exclusively through the encrypted admin-only path in
**`AW_TAXID_DESIGN.md`** (KMS field encryption, Lambda-only read, masked UI, audited Reveal; R12) and never appears in chunks,
reports, logs, fixtures or tests. PLAN = dry run on the overlay store (counts, new vs matching, conflicts, errors); APPLY on
REHEARSAL first, LIVE only with a RECONCILED rehearsal of the same `stageHash` (`runSlice.ts:93-101`), production refused.
- **Customers** (R6, R28, R29): key `Account #` → `Customer.aljexCode`; name never a key; duplicate-name groups (24) listed in
  `customer-duplicates.csv` (OPEN-28; default: import every account as its own customer, no merge); exclude TEST CUSTOMER 100003
  and `^ZZ|test` names; GUEST SUPPLY imported; **Status N rows become `Location` rows** (`aljexCode`, address, `facilityType`
  from history, note "Inactive Aljex customer") not customers; active rows map Name/address/phone/contacts/e-mails/Rev Type →
  `defaultDivisionKey`/terms/credit limit/Balance Due (reconcile only)/type/shipment counts/first-last/status, plus the D.1
  billing seed (flagged rows not applied).
- **Carriers** (R30, R12, R13): match **MC/DOT first, then `Aljex Carrier ID`, never name alone**; duplicates (the repeated MC, 17
  repeated names) **merge** into one Carrier keeping every other Aljex Carrier ID in `Carrier.aljexAliases`; inactive import
  inactive; `Factor Id` → the carrier's factor / remit-to (existing CARRIER_FACTOR target in `ImportPage.tsx:37`); Quick Pay kept;
  bank/routing never imported (counts only); tax ID per AW_TAXID_DESIGN.md. Dry run: new vs matching by MC/DOT, conflicts (same MC
  different name/e-mail), duplicate-MC pair, inactive, factored.
- **AP aging** (67 bills, $83,407.20; R7 OPEN): key PRO + Vendor ID (= Aljex Carrier ID) → `CarrierBill` with `billNumber =
  <PRO>-<vendor>`, `aljexVendorInvoiceRef` = `Vend Invoice #` (reference only), `aljexPayMethod` = C/D (meaning unconfirmed),
  **`Amount Paid` NOT treated as paid** (balance = open amount; OPEN-7), pay-to ≠ vendor → carrier remit-to/factor, status
  `TO_BE_PAID` with `approvalWarnings:['LEGACY_IMPORT']`, carried-over marking (C.5), aging buckets must equal the file to the cent.
- **AP expected** (36 rows, $35,269.18): its own report line; **not carried as payables**: rows become `LoadCarrier.apStatus
  AWAITING_INVOICE` on matching shipments only; the 12 stale 2024/2025 rows ($7,562.71) and the PRO 6269 triplicate are listed in
  `ap-expected-review.csv` and skipped (OPEN-7).
- **Active shipments** (10 rows): no writes; the end-to-end check: each PRO must exist with the same customer, carrier, rates and
  stops; differences go to the reconciliation screen. 99 of the 110 PROs across these files exist on dev; the 11 newer ones are
  reported (OPEN-19).
- Open AR/AP imported at cutover are carried-over (C.5) so nothing is resent; the Send/queue actions refuse them.

### E.2 Reconciliation report (R23) — Settings > Data > Aljex reconciliation
Route `/tms/brokerage/company/data/aljex-reconciliation` (beside `DataSafetyPage`, admin tab). Router action
`IMPORT_RECONCILE_ENTITY {entity, jobId}` writes an `AljexImportJob` row `kind:'RECONCILE'` per entity (customers, carriers, AR,
AP, loads/shipments) whose report (S3 `imports/runs/<id>/reconcile-<entity>.{json,csv}`, links via `IMPORT_REPORT_LINKS`) holds:
matched; Aljex-only; BCAT-only; field mismatches (name, MC/DOT, terms, rates, e-mails, status, remit-to, quick pay, factor);
**money totals side by side to the cent** (AR open, AP open by carrier / pay-to / aging bucket, per customer, by invoice number and
due date). **Equality is not required:** each difference row has a decision stored in `AljexImportJob.decisions` json
`[{key, outcome:'OPEN_BALANCE'|'APPROVED', approver, at, reason}]` via `IMPORT_DECIDE` (requires group `page-aljexSignoff`, new
OFF_NAV key, Jenny ticked on the Users page: same mechanism as D.3). Sign-off = every row matched or decided; the screen shows the
signer, time and the CSV. Decisions over ~300 KB spill to S3 with the key list kept in the row (DynamoDB 400 KB item limit).

### E.3 Settings > Integrations (R24)
Exists: `/tms/brokerage/integrations` (`IntegrationsTab`, admin) with the provider registry writing SSM
`/bcat/integrations/<pool>/<PROVIDER>` through `VALIDATE_INTEGRATION`; providers today: MYCARRIERPACKETS (+webhook), OPENAPI,
GMAIL_REP_OAUTH (`AW_SECRETS_ENV_AUDIT.md` §3). **Gap:** DAT (no provider entry), Google Maps server key and `GEOCODE_TOKEN_SECRET`
(Amplify `secret()`s, not SSM-registry values: cannot be entered in the UI). Design: add a `DAT` registry provider (STUB mode until
an adapter exists; stores the key in SSM like MCP), and a read-only **Deployment secrets** card listing `GOOGLE_MAPS_API_KEY` and
`GEOCODE_TOKEN_SECRET` as set/missing (presence of the env in the Lambda, never the value) with the exact command Ryne runs
(`npx ampx secret set <NAME> --branch main`). End-of-step note to Ryne: where and when (after the main deploy, before cutover).

### E.4 Tests and risks
Tests: layout parsers on synthetic fixtures (ZZ names, PRO band 900000+; never real rows), sensitive-column drop asserted by header
and by grep of staged output, carrier match precedence (MC/DOT > Aljex ID > never name), merge aliases, Status N → Location, AP
`Amount Paid` ignored, stale/duplicate expected rows excluded, money totals equal file aggregates, decisions persist and gate
sign-off, reconciliation CSV columns. Risks: importer engine files are shared with C1 (ownership below); tax-ID path depends on
AW_TAXID_DESIGN.md landing (import that column last; everything else proceeds); `tms-directory-actions` env budget (no new env).

---
## 4. Live verification on the rehearsal stack (`BCAT_STACK=rehearsal`, `scripts/lib/stackConfig.mjs`)
New `scripts/devVerifyAW.mjs` (harness: `devIdentity.mjs` temp staff identities, `cdpBrowser.mjs`, ZZ rows only, refuses prod and
refuses dev unless `BCAT_STACK` selects it; e-mail only to ai4bcat@gmail.com). Order:
1. `measureDataTemplate.mjs --prod-shape` ≤ 995,000 B / ≤ 500 resources (gate before any deploy to rehearsal).
2. Stage E first on the rehearsal (prod copy): 500-export PLAN with LINK → counts (matched-by-PRO ≈ 933, ID-fallback ≈ 26,
   ambiguous 0, unmappable 0) → APPLY → `backfillShipments.mjs` plan/apply for the remainder → re-PLAN shows 0 candidates.
3. Routes: `/loads`, `/loads/<id>`, `/grid`, `/shipments/<id>` land on the shipment; sidebar has no "Loads".
4. Consistency: edit a ZZ shipment stop → calendar/dispatch/`GET /paperwork` show it; driver `POST /paperwork/stop-event` and
   `/me/trailer` → ShipmentPage shows status/trailer (T5 harness).
5. Divisions: sample B/I/A/O shipments carry the right division and rep; no shipment has `salesRepCode`/`dispatcherCode`.
6. Billing: customers layout preview counts (≈478 FACTOR, ≈29 MANUAL, 9 flagged, 245 inactive→Locations); Billing setup counts
   match; release a ZZ FACTOR order → FactoringItem row deep-equals the bridge shape, no e-mail; release a ZZ MANUAL order →
   invoice Ready to send → Send → one e-mail to ai4bcat@gmail.com with cc = copy list + invoices@ (asserted on the notice row,
   SES still denied on dev/rehearsal); unset method / missing AP / no grant / ADMIN without grant refused; double release idempotent.
7. Post-invoice edit without reason refused; with reason → timeline on shipment and invoice; factoring-queue change propagates.
8. AP aging apply → open AP equals $83,407.20 by bucket (0-30 $66,642.20, 31-60 $16,765.00); expected list its own line; the 10
   active shipments all match or appear as differences; a difference approved with a note shows approver/time/reason; sign-off
   refused without `page-aljexSignoff`.
9. Regression: `devVerifyS3`, `devVerifyAA`, `devVerifyPerf`, `smokeProdReadOnly` on the rehearsal; factoring intake T6 unchanged
   (`git diff origin/main -- amplify/functions/factoring-intake/handler.ts` empty).

---
## 5. OPEN items (Ryne decides) and the safe default the build uses meanwhile
| # | Question | Safe default in the build |
|---|---|---|
| 1 | Real AP addresses for the 2 customers on invoicefactoring@bcatcorp.com | MANUAL, `apEmail` unset, `billingNeedsReview` set; release refuses `AP_EMAIL_MISSING` until filled |
| 7 | AP `Amount Paid` (= open amount on all 67), the 12 stale expected rows, C/D code meaning | Not treated as paid (bills import open); stale + PRO 6269 duplicates listed and skipped; C/D stored as `aljexPayMethod` only |
| 9 | Does 20000 apply to shipment/PRO numbers, invoice numbers, or both | Nothing wired; counters continue from the imported max; switch = `scripts/seedSeries20000.mjs --scope …` (C.6) |
| 10 | Which Danisco accounts get 120-day terms (100338, 100629, "DANISCO US, INC." variants) | All customers Net 30; no override written; candidates listed in the customers preview |
| 19 | Loads created in Aljex after the 2026-11-07 00:00 cutoff: delta import at go-live? | Importer is idempotent and LINK/CREATE-safe so a later export re-runs cleanly; post-cutoff rows are counted, not imported |
| 28 | 24 duplicate customer names (MANCHESTER MILLS, TRAFFIX, FOX LOGISTICS, …) | One customer per Account #, no merge; groups in `customer-duplicates.csv` for Ryne |

---
## 6. Slices (disjoint file ownership; "asks" go through hub to the named owner, never a second edit of the same file)
Landing order: S0 → {C1, C3, C4, C6, D1, D2, D3, D4, D5, E1, E2, E3, E4} in parallel → C2 after C1 → E5 after D3/E2/E3 → V last.

| Slice | Owner scope (files) | Depends on | Deliverable |
|---|---|---|---|
| **S0 Schema + budget** | `amplify/data/resource.ts` (the 11 fields + enum member), `scripts/measureDataTemplate.mjs` run | — | fields per §0; `--prod-shape` numbers recorded; stop if guard exceeded |
| **C1 LINK class** | `amplify/functions/tms-aljex-import/engine/{runSlice,aggregate,load,stage}.ts` + tests, `src/lib/shipmentLink.ts` | S0 | LINK class, link-only UpdateItem, codes-not-imported, link report buckets |
| **C2 ID fallback + report** | `scripts/awBackfillShipments.mjs` (+test) wrapping `backfillShipments.mjs` | C1 | combined matched/linked/ambiguous/unmappable report, idempotent |
| **C3 Routes/nav** | `src/App.tsx`, `src/components/LoadRedirect.tsx`, `src/lib/navSections.ts`, `src/App.routes.test.tsx` | — | `/loads/:id` + bookmark redirects; owns every App.tsx route line (D2, E2, E3 send route asks) |
| **C4 Projector mirror** | `amplify/functions/load-tracking-projector/*`, `amplify/functions/driver-app-api/*.test.ts` (new files only) | S0 | Load→Shipment mirror, link-MODIFY ignored, both-direction tests |
| **C6 Division + rep** | `src/lib/ownership.ts` seeds, `src/lib/aljex/profile.ts`, `src/lib/divisionSalesRep.ts`, `scripts/seedRevDivisions.mjs`, `src/features/tms/settings/DivisionsPage.tsx` | S0 | Rev Type rules, `divisionSalesReps` picker, ivan-cartage profile seed; asks D4 for the `applyTag` call |
| **D1 Billing fields** | `src/lib/billingMethod.ts` (+test), `amplify/functions/tms-directory-actions/*` (customer section), `src/features/directory/components/{CustomerForm,useCustomerForm}.ts(x)` | S0 | seed rule, validation, UPSERT_CUSTOMER fields, audited |
| **D2 Billing setup page** | `src/features/directory/BillingSetupPage.tsx` (+test), `src/lib/billingSetupCsv.ts` | D1 (contract only) | table, counts, Missing, inline edit, CSV export/import preview; route ask → C3; api ask → D3 |
| **D3 Release + grants (Lambda)** | `amplify/functions/tms-finance-actions/*`, `src/lib/apiClient.ts` (sole owner), `src/features/tms/loadReview/*`, `src/features/ar/*` | S0 | `RELEASE_TO_BILLING`, `SYNC_FACTORING_CHANGE`, grant checks, always-copy, refusals, idempotency |
| **D4 Post-invoice rule + timeline** | `amplify/functions/tms-shipment-actions/*` (sole owner), `src/components/ChangeTimeline.tsx`, ShipmentPage/InvoiceDetail hooks, `src/features/factoring/*` | S0 | reason gate, audits, timeline, queue-change propagation call; applies C6's `applyTag` ask |
| **D5 Grant keys + Settings UI** | `src/lib/navItems.ts`, `src/lib/roles*.ts` tests, `src/features/settings/SettingsPage.tsx`, `src/features/tms/brokerage/company/DataSafetyPage.tsx` (cutoff field) | — | `billingRelease`, `aljexSignoff` keys; always-copy + cutoff settings UI; save ask → D3 |
| **E1 Customers/carriers layouts** | `src/lib/aljex/layouts/{customers,carriers}.ts` (+tests), `amplify/functions/tms-aljex-import/engine/directory.ts`, `src/features/tms/brokerage/company/AljexImportPage.tsx` | S0, AW_TAXID_DESIGN.md | layouts, sensitive-column drop, MC/DOT match, merge aliases, Status N → Location, billing seed hand-off to D1 lib |
| **E2 AP/active layouts** | `src/lib/aljex/layouts/{apAging,apExpected,activeShipments}.ts`, `amplify/functions/tms-aljex-import/engine/apFiles.ts` (new), `engine/reconcile.ts` | S0 | bills keyed PRO+vendor, carried-over marks, expected line, 10-shipment check |
| **E3 Reconciliation + router** | `amplify/functions/tms-aljex-import/router.ts` (sole owner), `src/features/tms/brokerage/company/AljexReconciliationPage.tsx`, `src/lib/aljexReconcile.ts` | S0 | `IMPORT_RECONCILE_ENTITY`, `IMPORT_DECIDE`, decisions, CSV, sign-off; applies C1/E1/E2 router asks |
| **E4 Integrations gap** | `src/features/tms/integrations/*`, `amplify/functions/_shared/integrationValidate.ts`, `integrationSecrets.ts` | — | DAT provider (STUB), Deployment-secrets card, Ryne's where/when note |
| **E5 Live harness** | `scripts/devVerifyAW.mjs`, `scripts/lib/awChecks.mjs` | D3, E2, E3 | §4 steps 2-8 scripted on `BCAT_STACK=rehearsal` |
| **V Validation (lead)** | — | all | typecheck, lint, full tests, build, `measureDataTemplate --prod-shape`, §4 run, BUILD_LOG "Step AW" entry |

Rules for builders: no formatter/lint/full-test runs mid-flight (lead runs V once); scoped tests only; never read the Aljex CSVs'
sensitive columns; nothing sensitive in docs, fixtures or logs; dev/rehearsal only; `BUILD_LOG.md` entries only through the lead.
