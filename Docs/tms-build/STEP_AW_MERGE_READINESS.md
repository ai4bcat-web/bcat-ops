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
