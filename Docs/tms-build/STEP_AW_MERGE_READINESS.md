# Step AW — Merge dev into production BCAT Ops: readiness, billing mode, Aljex cross-check

Ryne, 2026-11-08: "lets prepare to merge everything in dev with everything in bcat ops. We want to make
sure that any existing functionality in bcat ops does not break. The new shipments should replace loads
in bcat ops. We'll need a list of all customers that we factor and all customers that we invoice manually.
The functionality previously was to have invoices come to specific emails so it arrives in the factoring
queue or actually invoices from aljex. We'll need to change it so it just does it programmatically in our
new bcat ops system by a status in the customer profile that says factor or invoice manually and ask for
the ap email and who should be copied. Factors should just push straight to factoring queue once a load
is reviewed and released to billing. We'll also need to ultimately cross reference everything in aljex to
make sure it matches everything in our new bcat ops system. This will involve uploading spreadsheets from
aljex for customer profiles, carrier profiles, ar, ap, and a big export 500."

## Ryne's decisions (2026-11-08)
1. **Shipment on top of Load.** Every existing production Load gets a matching Shipment (backfill). Shipments
   are the screen and workflow everyone uses; the Load record stays underneath so dispatch, calendar, driver
   pay, settlements, Ivan and the driver app keep working unchanged. `/loads` becomes Shipments in the nav
   (old URLs redirect, nothing 404s).
2. **Dress rehearsal first.** Nothing merges to production until the full merge has run on a copy of
   production data and the checks below pass. The real merge needs Ryne's explicit go.
3. **Factor customers: queue only.** Release to billing creates the invoice and pushes it straight into the
   factoring queue. The system sends no e-mail to the customer for factored invoices.
4. **Manual customers: create invoice, hold for send.** Release creates the invoice in Invoicing; someone
   reviews and clicks Send; it goes to the customer's AP e-mail with the copied contacts.

## 1. Rules that never change
Dev and the rehearsal stack only. No push to `main`, no production writes, no cutover steps without Ryne's
go. Backup taken 2026-11-08 (RESTORE.md in ~/bcat-ops-backups/2026-11-08-pre-aljex-migration) is the revert.
Do not disable or alter the production factoring e-mail bridge (ivanfactoring@ -> Apps Script ->
factoring-intake) or any intake mailbox: Ivan Cartage depends on them. The new programmatic path runs
alongside until Ryne approves retiring the old one at cutover.

## 2. Merge readiness (do first)
- Production `main` is ahead of dev by the work shipped 2026-11-04..06 (Feedback page; driver-app batch:
  time-off requests/PTO, load reorder, location notes, trailer/bobtail, DOT Save; Employee Hours view and
  hourly rates). Merge `origin/main` INTO `dev` on a branch `merge/main-into-dev`, resolve conflicts
  (expect `amplify/data/resource.ts`, `amplify/backend.ts`, `handler.ts`, `navSections.ts`, `App.tsx`),
  keep both feature sets, and run the FULL gate (typecheck, lint, full tests, build). Every test that exists
  on main must pass on the merged tree; list any that had to change and why.
- Write `Docs/tms-build/MERGE_REGRESSION.md`: an inventory of every production feature (read CONTEXT.md and
  the nav: Dispatch, Calendar, Driver info, driver app + driver-app-api routes, Driver pay, Amazon/box truck/
  owner-operator pay, settlements, factoring queue + Ivan factoring e-mail, Fleet maintenance, Files/Truck
  docs, Hours, Time off, Fuel, Insurance, Appts, Tasks, Reddit queue, Feedback, Compliance, Finances, etc.)
  with, for each: how it is verified (existing test names, new test, or a scripted live check) and its status.
  Gaps become tests before the rehearsal.
- Schema safety: diff the production AppSync schema against the merged one. List every added/changed table,
  GSI and enum. Anything that changes a key, removes a field, or turns an optional field required is a
  blocker to flag to Ryne, never to ship silently. Check the CloudFormation resource count and template
  size on the merged tree stays under the caps (dev is at ~460 of 500 resources, 963,479 of 1,000,000 bytes;
  the merge adds more: report the number and, if over, split into nested stacks).

## 3. Rehearsal stack (copy of production)
- Create an Amplify branch `rehearsal` on app d3dejqzs77khq6 (new backend stack, separate tables) from the
  merged tree. Load production data into it from the backup export `tables-main/*.jsonl` (batch-write) and
  copy the prod files bucket from `s3://bcat-ops-backup-273354631837-20261108/prod/files-bucket/`.
  Never point the rehearsal at production tables, the production driver pool, or live Twilio/Slack/e-mail
  (stub or test-recipient only; live e-mail tests go only to ai4bcat@gmail.com).
- On the rehearsal: run the regression inventory (scripted live checks where possible), then run steps 4-6.
  Report failures with evidence; fix on the merged branch; re-run until clean.

## 4. Shipments replace loads
- Backfill: one Shipment per existing production Load (idempotent, keyed by loadId), carrying customer,
  stops, carrier(s), financials and status mapped to the shipment stages. Dry-run report first: counts,
  loads that could not map, duplicates.
- Nav and routes: Loads entries become Shipments (the dev Shipments/Active page); `/loads`, `/loads/:id`
  and any bookmarked load URL redirect to the shipment. Dispatch, calendar and driver app keep reading Load.
- Two-way consistency: edits through the shipment update the underlying Load fields that dispatch/pay read
  (the existing Step-N/AH bridge); add tests that a shipment edit shows on dispatch, the calendar and the
  driver app, and that a driver-app change (reorder, trailer, arrival) shows on the shipment.

## 5. Customer billing mode: Factor or Invoice manually
- Customer profile gets **Billing method** (FACTOR | MANUAL, required before any load for that customer can
  be released to billing), **AP e-mail** (required for MANUAL, optional note for FACTOR), and **Copy on
  invoices** (list of contacts/e-mails, may be empty). For FACTOR also show the factor (existing factors list).
- **Billing setup screen** (Customers > Billing setup): table of every customer with method, AP e-mail,
  copied contacts, loads in the last 12 months; filter "Missing"; inline edit; CSV export and CSV import
  (customer, method, AP e-mail, copy list) with a preview before applying. Header counts: N factor, N manual,
  N not set. Seed method/AP e-mail from the Aljex customer export where it carries them; never guess: unset
  stays unset and is listed in a "needs your answer" report that is Ryne's list to fill in.
- **Release to billing** (Load Review "Move to billing"): refuses with a clear reason if the customer's
  method is unset or MANUAL has no AP e-mail. FACTOR -> create the invoice and push it into the existing
  factoring queue immediately (same queue record the e-mail bridge produces today), audit line "Pushed to
  factoring queue on release", no customer e-mail. MANUAL -> create the invoice in Invoicing with status
  Ready to send; the Send action e-mails the PDF to the AP e-mail with the copy list and logs it on the
  invoice and shipment. Both paths are idempotent (re-release never double-invoices or double-queues).
- Replaces "invoices arrive at specific e-mails": the e-mail-address routing is no longer used for
  brokerage invoices in the new flow. Do not delete the old bridge (see Rules).
- Tests: each path, missing-method refusal, missing-AP refusal, idempotency, copy list on the e-mail,
  factoring queue record shape equals what the queue UI already renders.

## 6. Aljex cross-reference
Five uploads from Aljex: customer profiles, carrier profiles, AR, AP, and the big export (the "500"). Ryne
drops each file in `/Users/adminoid/aljex-export/` (outside the repo, PII) and names which is which.
- Import wizard/CLI per file with a dry run first (counts, new vs matching, errors) and an apply step;
  reuse the existing Step X importer for the big export.
- **Reconciliation report** per entity (customers, carriers, AR, AP, loads/shipments), generated in the app
  (Settings > Data > Aljex reconciliation) and as CSV: matched; in Aljex but missing in BCAT; in BCAT but
  not Aljex; field mismatches (name, MC/DOT, terms, rates, e-mails, status); and money totals side by side
  (AR open $, AP open $, per customer / per carrier / aging bucket, by invoice number and due date).
  Zero-tolerance rows (dollars, invoice numbers) are listed individually; each has a "resolved: how" note.
- Pass criterion for the cutover: every row matched or explained, totals equal to the cent, signed off by
  Ryne in the report screen.

## 7. Order of work and reporting
A. Merge main into dev + regression inventory + schema/size report (report to Ryne before B).
B. Rehearsal stack + data load + regression run.
C. Shipments replace loads (backfill dry run, nav, consistency tests).
D. Billing method + Billing setup screen + release logic.
E. Aljex importers + reconciliation report; run on the rehearsal with whatever uploads exist.
Report after each stage with counts and failures. Log under "Step AW" in BUILD_LOG. Tracker id `AW`.

## Ryne's clarification 1 (2026-11-08): match on the Aljex PRO number first
> "can't we just match the aljex pro numbers and do it that way without breaking anything?"

Yes. The load<->shipment link rule becomes, in this order: (1) **Aljex PRO match**: if a production Load
carries the Aljex PRO (check Load.pickupNumber / tmsId / loadNumber and the shipment PRO field the Aljex
import stored), link the Aljex-imported shipment to that Load instead of creating a duplicate; (2) **ID
link** for every Load that has no Aljex PRO (Ivan Cartage, Amazon, box truck, local work): create its
Shipment keyed by loadId. Matching only ever adds a link; it never edits or deletes a Load. Net-new
shipments after cutover need no matching: the shipment creates its own Load underneath.
In the stage A report, give counts from the production export (`tables-main/Load.jsonl`) and the dev
Aljex import: Loads with an Aljex-style PRO, how many of those match an imported Aljex shipment exactly,
how many match more than once or not at all, and how many have no PRO. Confirm whether the Aljex "PRO" is
the same value as the shipment number the dev importer stored. The dry-run backfill report lists
matched-by-PRO, linked-by-ID, ambiguous (needs Ryne) and unmappable separately.

## Aljex customer list received (2026-11-08) and how factor/manual is derived
File: `/Users/adminoid/aljex-export/aljex-customers-2026-11-08.csv` (761 rows, 92 columns, outside the repo; it
contains a Web Password column: never read, print, log or import that column). Findings: 516 rows are
Status Y (active), 245 are N. In Aljex the **E-Billing Email** routes the invoice:
`ivanfactoring@bcatcorp.com` = factored (478 active customers); any other address = invoiced manually
(38 active, of which 7 use invoices@bcatcorp.com and 2 use invoicefactoring@bcatcorp.com, internal addresses
flagged for Ryne). No active row has a blank address or more than one address. `Invoice by` / `Billing Pref`
is 1 (504) or P (257, paper?); treat as informational and list the 12 active P rows for Ryne.
Draft list for Ryne to confirm: `/Users/adminoid/aljex-export/billing-method-draft-2026-11-08.csv`.
- Seed rule (Billing setup import, stage D): FACTOR when the e-billing address is exactly the factoring
  address; MANUAL + AP e-mail = that address otherwise; flagged rows stay "needs review" and are NOT applied
  until Ryne confirms. Inactive (Status N) customers import as inactive with no method required.
- Customer import maps the other useful fields: Name, address, phone, contacts and e-mails, Account #
  (store as the Aljex key for the cross-check), Salesrep code, Rev Type, Invoice Terms Days, Credit Limit,
  Balance Due (reconciliation only), Customer Type, Shipments counts, first/last shipment, Status.
- 24 names repeat (e.g. MANCHESTER MILLS LLC, TRAFFIX, FOX LOGISTICS): key on Account #, never on name; list
  the duplicate groups for Ryne.

## Aljex carrier list received (2026-11-08)
File: `/Users/adminoid/aljex-export/aljex-carriers-2026-11-08.csv` (2,462 rows, 40 columns, outside the repo,
mode 600). **Sensitive columns: `Fed/SS #`, `Bank Account`, `Routing #`.** Never read, print, log, or put them
in any report, test, fixture, screenshot or BUILD_LOG. Default: do NOT import them into BCAT; the importer
skips those three columns (decision for Ryne later; if he wants ACH details in BCAT they go in an encrypted
field, not plain Carrier columns). Report only counts of how many rows have each.
Findings: 2,443 rows are carriers (Carrier Y/N = Y), 19 are other vendors; 2,191 carriers active (Status Y),
260 inactive. MC filled on 2,361, DOT on 2,373; 1 MC appears on more than one carrier row; 17 vendor names
repeat. 187 rows have a Factor Id (carrier paid via a factor: map to the carrier's factor / remit-to),
14 have Quick Pay (days 10 or 2, % 6.00 or 2.00), 11 have terms (30). Remit-to address on 2,437. Safety rating
mostly NONE (2,144), 253 SATISFACTORY, 40 CONDITIONAL, 6 UNSATISFACTORY. `Aljex Carrier ID` is on every row:
store it as the cross-reference key (match on MC/DOT first, then Aljex Carrier ID, never on name alone).
Dev already holds 933 carrier rows across two tables, and 378 of the 2,360 distinct Aljex MCs are already
there; production has no carrier directory table. Dry run: new vs matching by MC/DOT, conflicts (same MC
different name or e-mail), the duplicate-MC pair, inactive carriers (import inactive, never active), and
carriers with a Factor Id. Reconciliation (stage E) compares name, MC, DOT, remit-to, terms, quick pay,
status, factor.

## Aljex AP and active-shipment files received (2026-11-08)
Files in `/Users/adminoid/aljex-export/` (outside the repo, mode 600):
- `aljex-ap-aging-2026-11-08.csv`: open carrier bills (AP aging). 67 bills, $83,407.20 (0-30: $66,642.20,
  31-60: $16,765.00, nothing older). Key = Pro # + Vendor ID (Vendor ID is the Aljex Carrier ID, same value as
  `Aljex Carrier ID` in the carrier list). Pay to differs from Vendor on 40 rows (factored carriers: map to
  the carrier's remit-to/factor). **`Amount Paid` equals the open amount on all 67 rows, so it is the bill
  amount mislabeled, not a payment: do not treat it as paid; confirm with Ryne.** `Voucher #` is blank,
  `Vend Invoice #` is just the PRO on 38 rows and a placeholder word (LINE, MAC, a driver name) on 29: BCAT
  bill number = PRO + vendor, keep the Aljex text as a reference only. Check/Draft code C or D: record as
  `aljexPayMethod`, meaning unconfirmed. No PJ hold, super hold or claim holds.
- `aljex-ap-expected-2026-11-08.csv`: 36 loads whose carrier cost is expected but not yet billed,
  $35,269.18. 12 rows ($7,562.71) are dated 2024 and 2025 and look stale; PRO 6269 appears three times
  (vendor name variants). List stale and duplicate rows for Ryne; do not carry them as payables.
- `aljex-active-shipments-2026-11-08.csv`: 10 currently active shipments with customer and carrier rates and
  status (OPEN, COVERED, DEPARTED 1/2, DELIVERED 2/2). Use as the first end-to-end cross-check: each PRO must
  exist in BCAT with the same customer, carrier, rates and stops. 99 of the 110 Aljex PROs across these files
  are already in dev (the other 11 are probably newer than the Nov 3 import): report them.
Reconciliation (stage E) for AP: open bills by carrier, by pay-to and by aging bucket equal to the cent
($83,407.20 total), plus the expected list as its own line. AR is NOT in these files yet.

## Ryne's answers (2026-11-07), final unless marked OPEN
Billing and customers
1. The 9 customers with internal BCAT billing addresses are **invoiced manually, never factored**. Batory Foods
   is manual. (OPEN: the 2 on invoicefactoring@ need a real customer AP address.)
2. Invoice-by "P" customers: **e-mail like the rest**; no paper/mail option.
3. **invoices@bcatcorp.com is always copied** on every manually invoiced invoice: a company-wide always-copy
   setting (Settings), in addition to any per-customer copy list.
4. Aljex Rev Type map: **B = BCAT Logistics (brokerage), I = Ivan Cartage (assets), A = Bestcare Auto
   Transport, O = owner operators** (new system: a load is classified owner operator when a specific
   owner-operator driver/carrier is attached to it). Sales rep is set by division, not by Aljex rep code:
   BCAT Logistics = Ryne Bandolik; Ivan Cartage = "Ivan Cartage"; Bestcare Auto = Ruben Vargas; owner
   operator = Ruben Vargas. Aljex salesrep codes and dispatcher codes are NOT imported (start tracking
   forward in BCAT). Customers also get a default division from their Rev Type where present.
6. Exclude test/junk customers from the import: TEST CUSTOMER (acct 100003) and any ZZ/test names.
   GUEST SUPPLY is a REAL customer (1,827 shipments, last 09/15/25): import it.
7. AP "Amount Paid" / stale expected rows / C-D code: OPEN, Ryne needs examples (files prepared).
8. Accounting stays inside BCAT Ops for now; QuickBooks integration is a later step.
9. **Numbering starts at 20000** so the cutover is visible. OPEN: confirm it applies to both shipment/PRO
   numbers and invoice numbers (in Aljex the invoice number is the PRO). Aljex numbers top out at 14,9xx.
10. Default invoice terms **Net 30**; **Danisco = 120 days** (OPEN: which of DANISCO US INC. 100338, DANISCO
    USA INC. 100629 and any "DANISCO US, INC." variants).
11. Carriers are paid by ACH, Zelle or credit card. Goal: pay directly from BCAT Ops and track it there
    (a later step: record every payment now with method + reference; no payment execution yet).
12. **Carrier tax IDs (Fed/SS #) live in BCAT Ops**: import them, but ONLY into an encrypted,
    admin-only store: field-level encryption with a KMS key, written and read only through a Lambda (no
    GraphQL read of the clear value by any staff user), UI shows masked last 4 + "on file", an ADMIN-only
    Reveal action that writes an audit line, never in logs/exports/tests/fixtures. Bank account and routing
    numbers still NOT imported until the payments step (they stay in the source file).
13. Quick-pay carrier terms are kept (carrier setting that adjusts the bill).
14. Over the credit limit: **flag, do not block**. Later step (record as backlog AX): an AI follow-up agent
    that e-mails customers automatically once an invoice passes 35 days unpaid.
Factoring and invoicing
15. New customer billing-method setting pushes an approved shipment straight to the factoring queue when the
    payment type is Factor; the e-mail bridge is removed only after Aljex is confirmed completely cut over
    (keep it running until Ryne says so).
16. Every factored customer goes to the same factor (one factor record).
17. Release to billing and Send invoice: **Jenny only for now** (permission, not role-wide).
18. A change to a shipment in the factoring queue updates the whole system. If the load is already invoiced
    or paid, the change is allowed but needs a required reason, an audit entry (who, when, before/after) and a
    visible "what happened" timeline on the shipment and invoice so the change can be understood.
Cutover
19. Cutoff for carried-over data: **2026-11-07 00:00** (OPEN: confirm what happens to loads created in Aljex
    after that moment: delta import at go-live?).
20. Import the **last 24 months** of loads and invoices/bills; older history stays only in the Aljex files.
21. Open AR and AP at cutover are imported **marked "carried over"** so nobody resends them.
22. Revert decision deadline **December 1**; revert only if something is lost or broken beyond repair. Aljex
    stays readable until then.
23. Reconciliation sign-off: **Jenny**. The report must not require equality: each difference can be left
    as an **open balance** or **approved with a note** (approver, time, reason recorded).
24. Secrets/keys (DAT, Maps, MCP etc.): leave a clear place in production (Settings > Integrations) for Ryne
    to enter them himself; tell Ryne exactly where and when at the end.
25. Ivan LOCAL driver pay (D-W10): see CUTOVER_PLAN RD4; default stays hourly via Employee Hours.
26. Users: the existing BCAT Ops logins carry over unchanged (staff pool us-east-1_IbPKPNJC9; list each
    user's access to the brokerage pages for Ryne to confirm).
27. Commissions: ignored for now; later configured per owner operator in the driver profile.
28. 24 duplicate customer names: OPEN, Ryne needs details (file prepared).
29. Inactive Aljex customers import as **Locations**, not customers (they have no active billing).
30. Duplicate carriers (the repeated MC, 17 repeated names): **merge**, keep the Aljex Carrier IDs of the
    merged rows as aliases.
