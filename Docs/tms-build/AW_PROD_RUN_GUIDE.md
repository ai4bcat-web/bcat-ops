# AW production run guide (Ryne)

One command runs the whole data load with a stop at every wrong number. Companion to `AW_PROD_DATA_RUNBOOK.md` (the source of every expected number) and `AW_STAGED_DEPLOY.md`.

## Before you start
- Your own terminal, normal AWS creds for account 273354631837 (`export AWS_PROFILE=<prod admin profile> AWS_REGION=us-east-1`).
- A fresh backup finished and `~/bcat-ops-backups/LATEST_BACKUP_STAMP` is < 6 h old (if not, the runner asks for the exact path of the backup you made and stamps it; it never stamps on its own).
- Source files in `/Users/adminoid/aljex-export/`. No Amplify job running; do not deploy while it runs.
- You need an ADMIN e-mail + password of the production staff pool.

## The command
```sh
cd /Users/adminoid/bcat-ops
scripts/awProdRun.sh --suffix 5ucwdyvwivelbo4k4jomvrwel4
```
Options: `--yes-if-all-pass` (apply automatically when every number of a step passes; the table is still printed and the log says `auto-applied`; tax IDs still ask, default N), `--dry-only` (dry runs and the summary, never applies; safe any time), `--from <step>`, `--only <step>`, `--files-dir <dir>`, `--fresh-step <step>` (re-run one step), `--resume` (default), `--expect <step>.<metric>=<value>` (restate a soft expected number on purpose; recorded in results.tsv; stop conditions cannot be restated).
Steps: `preflight settings backfill-check customers carriers tax-ids loads backfill ap-aging ap-expected ar reconcile`, plus the selectable `backfill-emergency` (usable with `--only backfill-emergency` / `--from backfill-emergency`; never part of the default walk, and `steps=all` does not cover it).

## What you see
1. `Type the word PRODUCTION to continue:`, then admin e-mail (visible) and password (hidden). They live only in `BCAT_EMAIL` / `BCAT_PASSWORD` of the child processes and are unset on exit. A sign-in is checked; wrong credentials stop the run.
2. Preflight table: backup age, root stack `UPDATE_COMPLETE`, no running Amplify job, `BCAT_SCHEMA_STAGE >= 3`, 110 tables, no dev-only env vars on main, Jenny exists (found / not found only), six input files with row counts (761 / 2462 / 67 / 36 / 296 / 8347) and "sensitive headers present: yes/no, refused by importer".
3. For every step: the dry-run output, then a PASS / FAIL / INFO table (green / red on a terminal) against the encoded expected table. Any FAIL stops the run (exit 1) and prints the failed numbers, the runbook section and the rollback pointer. When all pass: `Apply <step>? [y/N]`. After the apply it verifies (table item counts before/after, totals to the cent, importer `reconciled YES`) and prints a second table.
4. Order: preflight, settings, backfill-check (`--evaluate` + dry run; its APPLY is deferred), customers, carriers, tax-ids (asks `Import tax IDs now? [y/N]`, default N; skipped when the vault is not deployed), loads (stage-export, `prodpre-importAljex` backup offer, plan, live pass), backfill (leftovers), ap-aging, ap-expected, ar, reconcile (five entities), final checks (FactoringItem count unchanged, ShipmentNotice rows since start = 0), summary.
5. If the importer says a LIVE apply needs a RECONCILED rehearsal for this stageHash, the runner prints that exact message and stops.

## Files and resume
`~/bcat-ops-backups/aw-prod-logs/run-<timestamp>/` (mode 700): `transcript.log` (scrubbed: e-mails, phones, long digit runs, anything after "password"), `results.tsv` (step, metric, expected, actual, PASS/FAIL), `state.tsv`, raw per-step outputs. Global `STATE.tsv` (step, status, timestamp) and `JOBS.tsv` (job ids for reconcile) sit one level up.
Just start it again: DONE steps are skipped (state file or the awProd checkpoint), and it continues at the first step not DONE. `--fresh-step carriers` re-runs one step. After a crash inside `loads`, resume the importer with the command in the STOP message (`node scripts/awProd.mjs loads --suffix ... --live-tag awprodMMDD --resume <JOBID> --apply`).

## Safety
Refuses root, a non-tty stdin, any suffix but the production one, and anything but the typed word PRODUCTION. Every apply needs the dry run of the same invocation to have passed and sets `AW_PROD_CONFIRM=$(date +%F)-<step>` itself. Test mode for rehearsal checks only: `--target dev|rehearsal` (dry-only is the supported use; applies only for the per-file steps). Test-only `AW_PROD_NONINTERACTIVE=1` reads answers from stdin and credentials from the environment; Ryne uses the prompt.

## Unattended run
`--unattended` is ADDITIVE: the interactive run above is unchanged. It runs with no TTY and no prompt: credentials come from the macOS Keychain and every "yes" comes from an approval file only you create. Production only (`--target` is refused).

**One-time setup (Ryne).** The Keychain account name IS the sign-in e-mail, and it must be an admin staff user of the production pool (the runner's login), in the page-billingRelease-agnostic admin group (any admin; it needs no billing-release page group):
```sh
security add-generic-password -s bcat-migration -a migration-bot@bcatcorp.com -w   # prompts for the password, hidden
```
**Approval file (create it only when you approve; the runner never creates it).** One line, today's date in your local timezone; other lines and `#` comments are ignored:
```sh
printf 'APPROVED %s steps=all by=ryne\n' "$(date +%F)" > ~/bcat-ops-backups/APPROVAL.production-load && chmod 600 ~/bcat-ops-backups/APPROVAL.production-load
# only specific steps, e.g. the emergency backfill:
printf 'APPROVED %s steps=backfill-emergency by=ryne\n' "$(date +%F)" > ~/bcat-ops-backups/APPROVAL.production-load && chmod 600 ~/bcat-ops-backups/APPROVAL.production-load
```
`steps=` is a comma list of the runner's step names or `all` (= `settings customers carriers loads backfill ap-aging ap-expected ar reconcile`; `all` never includes `tax-ids` or `backfill-emergency`: list them explicitly, e.g. `steps=all,tax-ids`). `loads` also covers its `stage-export` part.

**Launch.**
```sh
scripts/awProdRun.sh --suffix 5ucwdyvwivelbo4k4jomvrwel4 --unattended [--only STEP | --from STEP]
scripts/awProdRun.sh --status        # run state, PASS/FAIL counts, approval file state, log dir; no credentials, no network; exit 0
```
**What it enforces (nothing is weakened).**
- A missing/empty Keychain item, a missing `security` tool, or a missing/invalid approval is a refusal: exit 2, before any apply (`--dry-only` still works without an approval). The approval must be owned by you and not group/world-writable (`chmod 600`), dated today, with `by=ryne`; any deviation refuses.
- A STOP CONDITION ALWAYS OVERRIDES THE FILE: the dry run must pass first and every PASS/FAIL expected number is compared exactly as in the interactive run; an approved step with a failing number is not applied (exit 1). `--unattended` only replaces the `y` of `--yes-if-all-pass` for approved steps. `tax-ids` is applied only when listed explicitly AND all numbers pass.
- It supplies the dated `AW_PROD_CONFIRM` tokens, `BCAT_ALLOW_PROD` and `--confirm-prod` programmatically from today's date, but never creates `LATEST_BACKUP_STAMP`: a missing/stale stamp is a refusal (exit 2). The `prodpre-importAljex*` backups are created automatically only after an approved `customers/carriers/loads/ap-*/ar/reconcile` step needs them.
- Consumption: each apply is recorded in `~/bcat-ops-backups/aw-prod-logs/APPROVAL.consumed` (step, timestamp, sha256 of the approval line) BEFORE it runs, so a step is applied under one approval line at most once (a crash mid-apply therefore needs a new approval line; re-use the importer/awProd checkpoint to resume). A re-created file with the identical line is still consumed: write the line differently (e.g. another step order). When every listed step is DONE the file is renamed `APPROVAL.production-load.used-<timestamp>`.
- The password is read into a variable only (`security ... -w`), exported to the child processes only, unset on exit, never put in argv, a file or a log; the transcript scrubber still hides it and the e-mail. `set -x` is turned off.
- Exit codes: 0 every approved step done and PASS; 1 a stop condition / failed number / failed final check; 2 refusal (credential, approval, backup stamp or sign-in); 3 internal error.

**`backfill-emergency`.** `scripts/awProdRun.sh --suffix 5ucwdyvwivelbo4k4jomvrwel4 --unattended --only backfill-emergency` runs the backfill dry run, then (approved, numbers passing) `node scripts/awProd.mjs backfill --suffix 5ucwdyvwivelbo4k4jomvrwel4 --cutoff 2026-11-07 --allow-empty-shipments --apply` with `AW_PROD_CONFIRM=<today>-backfill`, through the same login. Expected: afterCutoff 0, unmappable 0, ambiguous 0 (hard STOPs); totalLoads 958, carriedOver 17 (soft); verified by the `backfill_after` counts. Resumable via the awProd checkpoint. Afterwards the normal `backfill` step tolerates the already-linked Loads (`alreadyLinked`), and the `loads` step may report ENRICH instead of LINK for them (engine rules are unchanged).

## UI-only steps (not scripted; verified against `src/App.tsx`, `src/lib/navSections.ts` and the pages)
Sidebar: Settings = `/tms/brokerage`. Do these signed in as ADMIN, in this order around the load:
1. **Aljex cutoff** (before the data steps): Settings > Company > "Data & backups" tab (`/tms/brokerage/company/data`) > card "Aljex cutoff", field "Cutoff (America/Chicago time)" = `2026-11-07 00:00` > Save. (The runner also passes `--cutoff 2026-11-07` to every file step.)
2. **Always-copy invoices**: Settings > "General & automation" (`/tms/brokerage`) > card "Always-copy invoice e-mails" > "Always copy" = `invoices@bcatcorp.com` > Save.
3. **Default terms Net 30**: Settings > "General & automation" > card "TMS defaults" > "Default payment terms (days)" = `30` > Save. Also check Settings > Company > "Billing" tab > "Payment terms" table shows Net 30 (org-level terms).
4. **Divisions & ownership**: Settings > "Divisions & ownership" (`/tms/brokerage/divisions`). If it shows "Nothing configured yet", press "Create the seed rows" (the ownership seed; it appears only while the tables are empty; the code has no second button). Then in "Tagging rules" confirm the four Rev Type rules (B, I, A, O) exist: if not, STOP and report. Card "Sales rep by division": BROKERAGE = Ryne Bandolik, ASSETS = Ivan Cartage, CAR_SHIPPING = Ruben Vargas, OWNER_OPERATOR = Ruben Vargas.
5. **Users**: Settings > "Users & roles" (`/tms/brokerage/users`): verify Jenny's groups `page-billingRelease` and `page-aljexSignoff` (run `node scripts/awProd.mjs jenny --suffix 5ucwdyvwivelbo4k4jomvrwel4 --apply` with `AW_PROD_CONFIRM` first if not granted; runbook Step 2; not part of this runner). Nobody else holds them.
6. **Customers > Billing setup** (`/tms/customers/billing-setup`; the page is gated by the dormant-page stage-2 check): review the "needs review" rows (about 10) and Save each. Expect 479 factor / 36 manual.
7. **Reconciliation sign-off**: Settings > Company > "Data & backups" > card "Aljex reconciliation" > "Open reconciliation" (`/tms/brokerage/company/data/aljex-reconciliation`). Jenny only: decide each difference, then sign off.
8. **Integrations** (after the load, never during): Settings > "Integrations" (`/tms/brokerage/integrations`): enter the Maps / DAT / MyCarrierPackets / OPENAPI / Gmail keys yourself. Amplify secrets (`GOOGLE_MAPS_API_KEY`, `GEOCODE_TOKEN_SECRET`) can trigger a redeploy: only with the load finished.
