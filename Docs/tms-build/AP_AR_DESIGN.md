# AP / AR design: carrier remittance batches, finance KPIs, factored-invoice closing, Pending with OTR

Design only. Nothing here is built. Facts below were read from the repo at `origin/merge/main-into-dev`; anything not read is marked [UNVERIFIED].

## SCHEMA CHANGES REQUIRED (read first: staged deploys)

Production is at `BCAT_SCHEMA_STAGE=3` (all 110 tables live; `AW_PROD_DATA_RUNBOOK.md`). So every field below is an additive attribute on an ALREADY-DEPLOYED model: one AppSync schema update plus a Lambda redeploy, no new table, no GSI, nothing near the 1,500-resource stage cap. It does NOT ride free with a model stage. Measure each with `node scripts/stageDeployCheck.mjs` before it ships. Never lower the stage.

Minimum set (all additive, all optional, no backfill needed):

| # | Model | Field | Needed by | Zero-schema fallback |
|---|---|---|---|---|
| S1 | `TmsSettings` | `factoringFeeBps: integer` (null means 200) | item 2c fee setting | none clean (do not hide it in the `factorRemitTo` JSON) |
| S2 | `ApPayment` | `batchId: string` | item 1 one e-mail per pay-to per batch | share `reference` across the batch (weaker: `reference` is the check or ACH number a person types) |
| S3 | `CarrierBill` | `payHoldReason: string` (non-empty means on hold) | item 1 bulk release of PAY HOLD | none: see "pay hold today" |

Not needed (decided): no new `Invoice` field, no `ArPayment.kind` enum value, no new GSI, no new status enum value for "Pending with OTR". Each of those would touch the balance math or add an index; the zero-schema model in 2c ties out without them. Optional later: enum value `ArPayment.kind = FACTOR_FEE` for cleaner reports (one more additive change, can follow).

AppSync/Lambda wiring without schema: add `ArPayment` and `ApPayment` to `ROLLUP_SOURCE_TABLES` in `src/lib/dashboardRollup.ts:261` (stream mapping + read IAM in `amplify/backend.ts`). That is a backend change, not a data-model change.

## 1. Current state (what exists today)

AR
- Order `arStatus` enum: DOCS_NEEDED, UNBILLED, UNPAID, PAID, INVOICE_NOT_NEEDED, LEGACY (`amplify/data/resource.ts:2131`). Tabs on `/ar` (`ArPage.tsx:286-293`): Docs needed, Ready for billing, Unbilled, Unpaid, Paid, Payments and credits, Aging.
- `Invoice.status` ISSUED, PARTIAL, PAID, VOID; `balanceCents`; sparse `arOpen='OPEN'` (GSI `arOpen+dueAt`); `factored`, `factoringItemId`; `writtenOffCents` counts toward closing (`invoiceStatusAfter`, `paymentApply.ts:142`: PAID when `paid + writtenOff >= total`).
- `ArPayment` kinds PAYMENT, CREDIT_MEMO, WRITE_OFF, REVERSAL; method includes FACTOR; `unappliedCents`; only index is `customerId+receivedAt`. Actions in `tms-finance-actions/payments.ts`: RECORD_PAYMENT, CREATE_CREDIT, WRITE_OFF (`writeOffInvoice`, line 402), REVERSE_PAYMENT. Rows are immutable; a reversal row undoes. Ids are deterministic via `clientRequestId` (idempotent retry).
- Generate Invoice / batch generate (limit 25, 60 s Lambda) / E-mail / Send to Factor on the Unpaid row (`ArPage.tsx:763-766`). Send to Factor (`factor.ts`) only writes a `FactoringItem` row (id = PRO) and sets `Invoice.factored`; it never calls OTR.
- Factored invoices are NOT auto-closed in AR. OTR "Approved" only flips `FactoringItem.status` to FACTORED (`otr-actions/sync.ts`, `localStatusFor`). Someone must still Receive payment (method FACTOR) by hand.
- `FactoringItem.status`: NEED_TO_FACTOR, PENDING_WITH_OTR, FACTORED, ARCHIVED, MANUAL_INVOICE, INVOICED_MANUALLY. UI label for MANUAL_INVOICE is already "Invoice manually" (`FactoringPage.tsx:40`). Server actions already exist in `otr-actions/handler.ts`: `manualInvoice` (line 1072, also auto-set on No Buy), `returnToOtr` (1093, reversible), `manualStep`, `setApEmail`. The button exists in `OtrPanel.tsx` (`markManualInvoice`). Gap: these actions write no AuditLog row (grep: no `writeAudit` in `otr-actions/handler.ts`).
- KPIs today: `AgingStrip` (open, late, delivered-not-invoiced, avg days to invoice, avg days to pay for the selected month only) fed by `arAging.ts` (`ageInvoices`, `avgDaysToPay`, `deliveredNotInvoiced`); `factoringTotals.ts` (queue $ per bucket, uses `otrAmount` or load rate, not the invoice); dashboard catalog `ar.summary|aging|byCustomer|list` (`lib/dashboards/catalog.ts:107-126`); `tms-dashboard-rollup` keeps open AR and AP cents per shipment from Invoice and CarrierBill streams (`dashboardRollup.ts:226-246, 260`). `listOpenInvoices` pages through the `arOpen` index, so open-AR size is not a limit.

AP
- `CarrierBill.status` IN_REVIEW, TO_BE_PAID, PARTIAL, PAID, VOID; `payeeKind` CARRIER|FACTOR; `remitTo` snapshot `{name, factorName, method, accountLast4, payeeEmail, address}` frozen at RECORD_BILL (`billPayee`, `carrierBill.ts:175`); `apOpen` sparse marker; `LoadCarrier.apStatus` AWAITING_INVOICE...PAID. Tabs on `/ap`: Awaiting invoice, In review, To be paid, Paid, Payments and credits, Aging, AP inbox.
- Pay: `RECORD_AP_PAYMENT` (`apPayments.ts:353`): ONE carrier per payment ("one payment per carrier, whatever its remit-to says", header comment), must be allocated in full, bills must be TO_BE_PAID/PARTIAL, one payment can cover many bills of that carrier. `ApPayment` has `remitTo`, `remittanceSentAt/To/Count/Attempts`, `markedSent*`, `pdfKey`; index `carrierId+paidAt` only. The UI selection refuses a mix of carriers (`selectionCarrierId`, `apViews.ts:161`; "Pay selected" disabled).
- Remittance: `SEND_REMITTANCE` (`apPayments.ts:667`) is one e-mail per ONE payment: recipients from `remittanceRecipients` (`shipmentNotices.ts:502`): payment method `payeeEmail`, else carrier ACCOUNTING contacts, else `Carrier.email`; PDF attached; deterministic notice id `remit:<payment>:<attempt>` through `deliverNotice`; `COPY` mode and `MARK_REMITTANCE_SENT` (needs a note) for off-system sends. Renders only after the payment is posted.
- MyCarrierPackets: `CarrierPaymentMethod` has `source='MCP'`, `recipientType` CARRIER|FACTOR, `factorName`, `payeeEmail`; `Carrier.factorPaymentMethodId`. How many carriers actually carry an MCP `payeeEmail` is [UNVERIFIED]: needs a read-only production count before promising "every carrier".
- PAY HOLD today: there is no hold concept on CarrierBill, LoadCarrier or Carrier. The Aljex AP aging file has `PJ Hold`, `Super Hold`, `Peding Claim` columns, parsed by `layouts/apAging.ts:193,247` but only emitted as `AP_HOLD` findings (line 277); `engine/apFiles.ts:175` creates every carried-over bill as `TO_BE_PAID`, so the holds were dropped. (`src/lib/payHold.ts` is DRIVER pay and unrelated.)
- Quick-pay fee already exists on bills (`quickPayFeeBps`, `netCents`); do not confuse it with the OTR factoring fee below.

## 2. Proposed design

### 2a. Queue 35: carrier remittance and AP workflow like AR

- Remit e-mail on every carrier: new read-only report (script or Lambda action) listing carriers with open or recent bills and NO resolved remittance recipient (apply `remittanceRecipients` to payment method, contacts, `Carrier.email`). Fill gaps from MCP: `mcpReview.ts` already normalizes MCP contacts/profile e-mails; write a gated enrich (same pattern as `awCarriers.mjs`: dry default, `prodGate`, backup, AuditLog per row, only while empty) that sets `CarrierPaymentMethod.payeeEmail` for MCP-sourced methods. No schema.
- Pay hold (S3): add `CarrierBill.payHoldReason`. Phase 1 loads real holds from the Aljex AP aging file by gated enrich (flags `PJ_HOLD`, `SUPER_HOLD`, `PENDING_CLAIM` become reason text; matched on PRO + vendor like `awProd` AP enrich). Before that, a bulk release would release nothing, so confirm with Ryne that these three flags are the "PAY HOLD" he means.
- Hold semantics: a bill with `payHoldReason` set is excluded from "Pay selected / Pay all" and shown with a badge; recording a payment on it is refused server-side in `recordApPayment` (same place that already checks TO_BE_PAID/PARTIAL). New action `SET_PAY_HOLD {billIds[], reason|null}` (admin/AP-posting grant, `apPostingAdminOnly` honored), audited per bill with previous value. Bulk release = select held bills (or a filter chip "On hold") then Release hold.
- POST ALL as paid: new action `RECORD_AP_PAYMENT_BATCH {batchId, items:[{carrierId, billIds, method, reference, paidAt}]}`. The Lambda loops the existing `recordApPayment` core per carrier (one payment per carrier is kept: the payee stays the carrier; ledger rules unchanged), idempotent per item via `clientRequestId = <batchId>:<carrierId>`, stamps `ApPayment.batchId` (S2). Cap about 25 carriers per call (60 s Lambda limit, as `BATCH_GENERATE_LIMIT`), UI chunks larger batches and reports per-item refusals like `RefusalsCard` does on AR. All-or-nothing across carriers is NOT promised: each carrier is its own transaction; the response lists done and refused.
- One remittance e-mail per PAY-TO per batch: group the batch's payments by pay-to key = `(payeeKind, factorName or remitTo.name, payeeEmail)` from the frozen `remitTo`. New action `SEND_REMITTANCE_BATCH {batchId}`: for each group build ONE e-mail whose body and PDF list every payment, carrier and shipment in the group (extend `remittanceData`/`remittancePdf.ts` to take N payments; today it takes one), recipients from the group's `payeeEmail` else the existing fallback chain. Notice id `remit:batch:<batchId>:<groupKey>:<attempt>`, so a retry cannot double send (reuse `deliverNotice`'s claim). On SES acceptance stamp `remittanceSentAt/To/Count` on every payment in the group. A group with no recipient is listed, not sent.
- Pay-to shown = factoring company: already carried: `billPayee` sets `remitTo.name = factorName` and `payeeKind=FACTOR`, snapshot at RECORD. The To-be-paid table and the batch preview show `remitTo.name` (`payeeLabel`, `apViews.ts:72`) with a "Factor" tag and "carrier: X" beneath; a carrier whose MCP method is FACTOR but whose bill snapshot predates it needs unapprove and re-record (bills are snapshots, never edited).
- Guards: e-mail sending stays behind the existing send path (`deliverNotice`, SES identity, `FROM_ADDRESS`); no new switch. Batch send needs an explicit confirm dialog showing recipient count and pay-to names.

### 2b. Queues 27a/27: totals and KPI cards (AR and AP)

Counts and dollars per status (one `StatusTotals` projection, pure, in a new `src/lib/finKpis.ts`; amounts always integer cents):
- AR: Docs needed and Unbilled (orders, revenue from `deliveredNotInvoiced`), Unpaid split into manual, factoring queue (NEED_TO_FACTOR), Pending with OTR, Factored awaiting OTR cash, plus Paid and Void. Unpaid sub-splits come from `Invoice.balanceCents` joined to `FactoringItem` by `Invoice.factoringItemId` (NOT from `factoringTotals`, which values rows by `otrAmount`/load rate and ignores partial payments).
- AP: Awaiting invoice (`awaitingInvoiceTotals`), In review, To be paid, On hold (S3), Partial, Paid, Void; split by payee kind CARRIER vs FACTOR.
- Manual vs factoring queue: `Invoice.factored` true or false for AR dollars; FactoringItem status for queue stage counts.

KPI cards and the data each needs (read cost: all of these are one Invoice/CarrierBill open-index read plus the rollup below):
- Aging buckets: `ageInvoices` / bill equivalent on `dueAt` (exists, `arAging.ts`).
- DSO / average days to pay: AR exists (`avgDaysToPay`, `issuedAt` to `paidAt` over PAID, month-scoped today); extend to trailing 90 days and exclude `LEGACY`/carried-over invoices whose `paidAt` is not a real receipt [UNVERIFIED how carried-over invoices set `paidAt`]. AP: `avgDaysToPayBills` exists.
- Factored vs manual outstanding: `Invoice.balanceCents` grouped by `factored`.
- Factoring fees YTD: sum of fee rows (see 2c) with `receivedAt` in the year.
- Top customers owed: `ageInvoices(...).byCustomer` (exists), top 10.
- Overdue and due this week: open invoices/bills by `dueAt` vs today and today+7 (indexes `arOpen+dueAt`, `apOpen+dueAt` give this directly).
- Unapplied credits: AR `ArPayment.unappliedCents > 0` where not reversed; AP the same on `ApPayment` CREDIT_MEMO rows.
- Paid this month: `Invoice.paidAt` in month and `ApPayment` PAYMENT rows by `paidAt` in month.

Where it is computed: NOT in the browser. `ArPayment` and `ApPayment` have no global date index (only `customerId`/`carrierId`), `Invoice` has no `paidAt` index (`invoiceMonth` is the issue month), and adding a GSI is one per table per deploy. So extend `tms-dashboard-rollup` (already recomputes whole rows idempotently from source tables on stream events and a 5-minute sweep) with a `finance` payload in the live row, computed by scanning Invoice/ArPayment/CarrierBill/ApPayment (low thousands of rows each; scan cost [UNVERIFIED] to be measured on production in the dry run). Add the two payment tables to `ROLLUP_SOURCE_TABLES` and `COMPARED` (line 265). Surfaces: a KPI card row above the `/ar` and `/ap` tabs (reuse `TmsStatRow` as `AgingStrip` does), and dashboard catalog entries `ar.kpis`, `ap.kpis`. Browser-side fallback for aging/overdue/due-this-week only, from the existing open lists.

### 2c. Factored invoice paid = invoice minus fee, closing at $0

- Fee setting S1: `TmsSettings.factoringFeeBps`, default 200 (2.00%) when null. Edited on the Invoicing settings card (`ArSettingsCard.tsx`) through `SAVE_AR_SETTINGS`; validate 0..10000. Per-invoice override allowed at mark-paid time (OTR's real fee) with a required reason.
- Model with no new schema: one action `MARK_FACTORED_PAID {invoiceIds[], feeBps?, paidAt, reference}`; per invoice, in ONE transaction (`postOnce`), post two `ArPayment` rows:
  1. `kind=PAYMENT, method=FACTOR`, amount = `total - fee` (fee = round half up of `balanceCents * bps / 10000`), `applications=[{invoiceId, amount}]`, `reference` = OTR schedule or typed reference, id `arp:fp:<invoice>` (deterministic, idempotent).
  2. `kind=WRITE_OFF, method=FACTOR, reference='FACTOR_FEE'` (method on a write-off is new use of an existing field), amount = fee, `invoiceId` set, id `arp:ff:<invoice>`, note names the bps and the PAYMENT row.
  The invoice then has `paidCents + writtenOffCents = totalCents`, `balanceCents = 0`, status PAID, `arOpen` removed: closes at exactly $0 through the existing `planPayment`/`writeOffPlan` with no change to balance math.
- Commission trap: `writeOffInvoice` calls `runCommissionsAfter(..., 'WRITE_OFF')`, which lowers the commission basis. A financing fee must NOT reduce commission, so the fee write-off must bypass that call (explicit flag, tested). Likewise the existing `/ar` "write-off" reports and any bad-debt number must exclude `method=FACTOR` write-offs.
- How reports tie out: invoice total = FACTOR PAYMENT + FACTOR_FEE write-off. Bad debt (true write-offs) = WRITE_OFF rows with method not FACTOR. Factoring fees YTD = WRITE_OFF rows `method=FACTOR`. Cash received from OTR = FACTOR PAYMENT rows. `Invoice.writtenOffCents` on a factored invoice therefore contains the fee: per-invoice bad debt = `writtenOffCents` minus its FACTOR_FEE row. AR aging, DSO and open AR need no change (the invoice leaves `arOpen`).
- Mark-paid and remittance events: reversal uses the existing REVERSE_PAYMENT on both rows (a new `REVERSE_FACTORED_PAID` convenience reverses the pair together; each reversal row is audited with reason). `Invoice.paidAt`, `FactoringItem.status=FACTORED` (OTR sync) and the mark-paid are linked: show a "Approved at OTR, not yet recorded paid" chip on Factoring and Unpaid rows (derived, no field), with a bulk "Record factored payments" action. OTR remittance/schedule number goes in `ArPayment.reference`; no OTR cash reconciliation file is read today [UNVERIFIED whether OTR API exposes the funded amount: check `OtrClient.getInvoice` fields before auto-filling the fee from OTR].
- Audit: AuditLog `MARK_FACTORED_PAID` per invoice with `{feeBps, feeCents, paymentId, feeRowId}`.

### 2d. Queue 28: "Pending with OTR" and "Invoice manually"

- Pending with OTR: no new AR enum. It is derived: `Invoice.factored && FactoringItem(factoringItemId).status === 'PENDING_WITH_OTR'`. `ArPage` already loads `factoringItems` and `factorByItemId` (`ArPage.tsx:114,149`). Add a status chip on the Unpaid row and a filter option "Factored: Pending with OTR / Factored / Manual / Not factored" in `UnpaidFilters`, plus a count on the Unpaid tab sub-strip. Factored invoices must keep showing in Unpaid until MARK_FACTORED_PAID closes them.
- Invoice manually: the Factoring queue button and server action exist. Required fixes only: (1) add `writeAudit('FactoringItem', id, 'MANUAL_INVOICE', ...)` with previous status, reason, apEmail to `manualInvoice`, `returnToOtr`, `manualStep` and `setApEmail` in `otr-actions/handler.ts` (needs the audit helper that action Lambda does not import today [UNVERIFIED which helper]); (2) block `manualInvoice` when `otrInvoiceId` is set and OTR status is non-terminal unless the person confirms (today only FACTORED is refused); (3) when a row goes manual, flip `Invoice.factored` back to false or label it "manual" so the AR split matches the queue (today `Invoice.factored` stays true) and flip it back in `returnToOtr`; (4) keep `returnToOtr` as the reversal, exposed on the AR row too.

## 3. Build plan: small deployable slices, in order

1. S-A (no schema, no Lambda change): AR Unpaid chips and filters for Pending with OTR / Factored / Manual; pure `finKpis.ts` status totals and tests. Frontend only.
2. S-B (Lambda, no schema): audit rows for the four `otr-actions` manual-invoice actions; keep `Invoice.factored` in step; tests.
3. S-C (schema S1 + Lambda): `factoringFeeBps` setting and `MARK_FACTORED_PAID` (+ reversal) with the commission bypass; Factoring and AR bulk "Record factored payments". Tests for rounding, idempotency, $0 close, reversal, commission untouched.
4. S-D (backend wiring, no model change): rollup `finance` payload, `ROLLUP_SOURCE_TABLES` + stream mappings for `ArPayment`/`ApPayment`; KPI cards on `/ar` and `/ap`; dashboard catalog entries. Read-only production dry run of scan cost first.
5. S-E (read-only + gated enrich, no schema): carrier remittance-recipient gap report, MCP `payeeEmail` enrich script (dry by default, gate, backup, AuditLog).
6. S-F (schema S3 + Lambda + gated enrich): `CarrierBill.payHoldReason`, `SET_PAY_HOLD`, block in `recordApPayment`, import of real Aljex hold flags, bulk release UI.
7. S-G (schema S2 + Lambda): `ApPayment.batchId`, `RECORD_AP_PAYMENT_BATCH`, multi-payment `remittancePdf`, `SEND_REMITTANCE_BATCH`, grouped preview UI. Ships last: it is the only one that sends e-mail.

Schema changes batch into as few deploys as the order allows: S1 with S-C, S3 with S-F, S2 with S-G (three small additive deploys), or all three together in S-C if one staged deploy is cheaper than three; decide after `stageDeployCheck` measures one additive field.

## 4. Risks

- Commission side effect of a fee write-off (see 2c): must be bypassed and tested, or every factored invoice silently reduces commission.
- Fee on an invoice with a partial prior payment: compute fee on `balanceCents`, not `totalCents`, and refuse when `balanceCents` is 0; decide with Ryne whether OTR's 2% is on total invoice (then use total and allow only fully open invoices).
- Pay hold meaning is unconfirmed (Aljex PJ/Super/Pending-claim flags vs a new manual hold); the hold block must be server-side, not UI-only, or POST ALL bypasses it.
- Batch POST ALL partial failure: per-carrier transactions, not atomic; idempotent `clientRequestId` makes re-run safe but the UI must show what posted and what was refused.
- Double e-mail: batch notice id must be deterministic per group and attempt; per-payment `remittanceSentAt` set only on SES acceptance; never send in a dry run or mark-paid.
- Bills are snapshots: a carrier whose MCP method changed to FACTOR after a bill was recorded keeps the old `remitTo`; grouping by the frozen pay-to is correct but may show the old payee until unapprove and re-record.
- Rollup scan cost and 300 KB payload cap (`MAX_PAYLOAD_BYTES`): keep `finance` payload to aggregates and top-N lists, never row lists.
- `listOpenInvoices` is paged, but the dashboard KPI must not depend on the browser holding every invoice.
- Fee precision: integer cents, half-up rounding in one function; a rounding difference of 1 cent vs OTR's own figure must be allowed via the override, otherwise the invoice cannot close at $0.
- OTR "Approved" is not cash received: do not auto-close invoices on Approved; require an explicit mark-paid.
