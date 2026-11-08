# Step AW: Aljex import runbook (rehearsal)

Dev and the rehearsal stack only. Never production (the engine refuses its table names in every mode; the CLIs refuse the
repo-root `amplify_outputs.json`). Files stay in `/Users/adminoid/aljex-export/` (outside the repo, mode 600). Output of every
command is counts, dollars and Aljex keys: no names, e-mails or identifiers. Nothing here sends e-mail.

## 0. Setup (once)

```
export BCAT_STACK=rehearsal                       # dev|rehearsal; production is not a value (scripts/lib/stackConfig.mjs)
export BCAT_EMAIL=<an ADMIN user of the rehearsal pool>  BCAT_PASSWORD=...   # never in the repo or a shell history file
OUT=~/aw-rehearsal/amplify_outputs.json           # the REHEARSAL branch's outputs file, not the repo-root one
FILES=/Users/adminoid/aljex-export
```
- Set the cutoff first: Settings > Data > Aljex cutoff = **2026-11-07 00:00** (Chicago). The 24-month window then starts
  **2024-11-07**; older loads/invoices are not imported.
- The wizard (My Brokerage > Company > Aljex import) does the same per-file steps as the commands below: choose the CSV, upload,
  **Dry run**, then **Apply** (type a live tag). Use whichever is easier; both call the same router actions
  (`IMPORT_CUSTOMERS_MASTER`, `IMPORT_CARRIERS_MASTER`, `IMPORT_AP_FILES`, `IMPORT_AR_FILE`, `IMPORT_ACTIVE_SHIPMENTS_CHECK`).
- Every per-file command runs the **dry run first** (overlay, writes no table) and prints it. Add `--apply --live-tag <TAG>` to
  apply. Both are idempotent: running either again creates nothing new (the apply says "again: nothing new to write").
  Every run is an AuditLog line (counts only). Apply needs the dry run of the same job first.
- Files with a `Web Password`, `Fed/SS #`, `Bank Account` or `Routing #` column (and, for the carrier list, the tax-id-shaped
  `Account #`) are refused by the wizard and by STAGE; the CLI removes those columns from the copy it uploads and prints only
  the column names. The raw file never leaves the laptop.

## 1. Run order and expected numbers

Run in this order (later steps read what earlier ones wrote). `<TAG>` is a typed confirmation such as `AW-REH-1109`.

| # | Step | Command | Expect |
|---|------|---------|--------|
| 1 | Customers | `node scripts/awImport.mjs customers --file $FILES/aljex-customers-2026-11-08.csv --outputs $OUT [--apply --live-tag <TAG>]` | **761 rows, 516 active** in the file. Verified on the real file with the parser (counts only): **515 customers** (TEST CUSTOMER 100003 excluded: 1), **245 Status N rows become Locations**, 479 FACTOR / 36 MANUAL by the e-billing address, 10 flagged "needs review", 32 duplicate-name groups listed (all imported), 2 Danisco accounts at 120 days. `customersCreated + customersMatched + customersEnriched` = 515 on a first run into an empty target. |
| 2 | Carriers | `node scripts/awImport.mjs carriers --file $FILES/aljex-carriers-2026-11-08.csv --outputs $OUT ...` | **2,462 rows** (19 other vendors skipped; the repeated MC merges two rows into one: **2,442 carriers**, 252 inactive, 183 with a Factor Id, 14 Quick Pay, 12 with terms). Match order MC/DOT, then Aljex Carrier ID, never name. The repeated MC merges; its other Aljex ids go to `aljexAliases`. The CLI prints how many rows carried a value in Fed/SS #, Bank Account and Routing # before it strips those columns (counts only); none is imported. |
| 3 | Big export (loads) | see 1a below | **8,347 rows, PRO 6000..14939**, 4 repeated PROs (reported), 24-month window from the 2026-11-07 cutoff (ship dates from 2024-11-07). |
| 4 | AP aging | `node scripts/awImport.mjs ap --aging-file $FILES/aljex-ap-aging-2026-11-08.csv --outputs $OUT ...` | **67 bills, $83,407.20** (0-30 $66,642.20; 31-60 $16,765.00; nothing older). Key PRO + Vendor ID, bill number `<PRO>-<vendor>`, `Amount Paid` ignored (it is the bill amount), C = check, D = direct deposit, carried over (never resent). The tie-out lines print `diff $0.00` when every bill resolves; a bill whose PRO or carrier is not in BCAT is listed (`unresolved`) and shows as Aljex-only. |
| 5 | AP expected | `node scripts/awImport.mjs ap --expected-file $FILES/aljex-ap-expected-2026-11-08.csv --outputs $OUT ...` | **36 rows, $35,269.18**; the **12 stale 2024/2025 rows ($7,562.71) are dropped** (Ryne), leaving 24 rows / $27,706.47; PRO 6269 (3 rows) kept once, listed. Never payables: matching legs get `apStatus AWAITING_INVOICE`. |
| 6 | AR | `node scripts/awImport.mjs ar --file $FILES/aljex-ar-2026-11-07.csv --outputs $OUT ...` | **296 open invoices, $357,753.44** (0-30 $216,416.34; 31-60 $62,201.30; 61-90 $30,005.50; 91-120 $14,874.95; 120+ $34,255.35). Open amount = the five aging columns (never `Balance Due`, `Total Exposure`, `Unbilled`); 3 partial payments ($3,450.00) become ArPayments; 62 invoices bill another party; 50 factored $40,553.06 / 246 manual $317,200.38; 8 invoices from 2024 ($25,786.91). Carried over, Aljex due dates kept (the Danisco 120-day rule is in the AR report line "redated"). |
| 7 | Active-shipments check | `node scripts/awImport.mjs active-check --file $FILES/aljex-active-shipments-2026-11-08.csv --outputs $OUT ...` | **10 rows**, writes nothing: OK / DIFFERS / MISSING per PRO (customer, carrier, rates, stops). 99 of the 110 PROs across the AP and active files are in dev; the 11 newer ones show as MISSING (report them). |
| 8 | Reconcile | see 1b below | Per entity: matched / Aljex-only / BCAT-only / mismatched; money side by side to the cent; Jenny decides and signs off. |

### 1a. Big export (loads)

The load import is the existing engine through `scripts/importAljex.mjs`, which now follows `BCAT_STACK=rehearsal` (the engine's
own-stack rule: `engine/tables.ts` accepts the Lambda's/CLI's own stack suffix only with `BCAT_DEV_STACK=true`, production is
refused by name in every mode). Real data goes LIVE only after a **reconciled rehearsal copy of the same file**, so two passes:

```
BIG=$FILES/aljex-full-export-2026-11-07.csv
node scripts/importAljex.mjs rehearsal-create --tag rh1109                     # backup + restore of the 17 written tables to <Table>-<suffix>-rh1109
node scripts/importAljex.mjs run --source $BIG --target rehearsal:rh1109      # stage, plan, apply, reconcile on the copy: must end "reconciled YES"
node scripts/importAljex.mjs run --source $BIG --target live:<TAG>            # the same file into the stack's own tables
node scripts/importAljex.mjs seed-counter --target live:<TAG> --apply --enable-numeric   # numbering starts at 20000 (Ryne round 2)
node scripts/importAljex.mjs rehearsal-drop --tag rh1109                       # deletes only the -rh1109 tables and that tag's backups
```
Then stage the same file in the stack's bucket so the SHIPMENTS and AR reconciliations can read it (no table is written):
`node scripts/awImport.mjs stage-export --file $BIG --outputs $OUT` (prints the staged **job id**).

### 1b. Reconcile (R23), then sign-off

```
node scripts/awImport.mjs reconcile --entity CUSTOMERS --source-job <customers job id> --outputs $OUT
node scripts/awImport.mjs reconcile --entity CARRIERS  --source-job <carriers job id>  --outputs $OUT
node scripts/awImport.mjs reconcile --entity AP        --source-job <ap aging job id>  --outputs $OUT
node scripts/awImport.mjs reconcile --entity AR        --source-job <ar job id> --customers-job <customers job id> --outputs $OUT
node scripts/awImport.mjs reconcile --entity SHIPMENTS --source-job <staged big export job id> --outputs $OUT
```
Each prints the counts and money; the report (CSV and JSON) is under `imports/runs/<id>/` in the stack's bucket and in
Settings > Data > Aljex reconciliation. **Equality is not required**: Jenny (group `page-aljexSignoff`, only she, admins
included) sets each difference to *Open balance* or *Approved* with a reason, then signs off. The sign-off of AR and SHIPMENTS
marks the rehearsal reconciled. Decide/sign-off are the only actions that need the grant; every import action is ADMIN.

## 2. Authorization and safety recap
- Import actions: ADMIN (or the owner) only. Decide / sign-off: the `aljexSignoff` grant only.
- The Lambda writes only its own stack's tables and refuses any production table; APPLY needs the typed live tag.
- A dry run reads the target and writes no table; report files go to the DataSafety bucket under `imports/runs/<job>[-plan]/`.
- Source files live at `imports/source/<job>/<file>` in the same bucket. A file with a refused column is blanked at STAGE.

## 3. What to tell Ryne
- The customer, carrier, AP, AR and active-shipment files are loaded one by one with a dry run first; the numbers above are
  what we expect and what each step prints. Nothing is sent to anyone (carried-over invoices and bills are marked so nobody resends).
- Carriers' tax IDs, bank accounts and routing numbers, and customers' web passwords, are **not** imported or stored; they stay in
  the Aljex files (tax IDs go through the separate encrypted admin-only path).
- AP: `Amount Paid` is treated as the bill amount (open), C = check, D = direct deposit, the 12 stale expected rows are dropped, and
  the expected list is only a report line (never payables).
- AR: per-invoice open = the five aging columns; Aljex due dates are kept on carried-over invoices.
- Differences between Aljex and BCAT are expected and are Jenny's to mark *Open balance* or *Approved* with a note; the report
  shows both ledgers to the cent. A bill or invoice whose PRO or customer/carrier is not in BCAT is listed and never guessed.
- The 11 PROs newer than the dev data show as missing in the active-shipments check until the big export covers them.
- Go/no-go for the full merge still needs every ledger difference matched or decided and signed off.
