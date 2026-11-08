# Step AW: PRODUCTION data-load runbook (Ryne runs this himself)

Production = Amplify app `d3dejqzs77khq6`, branch `main`, stages 0-3 deployed (110 tables, `BCAT_SCHEMA_STAGE=3`).
Table suffix `5ucwdyvwivelbo4k4jomvrwel4-NONE` (CLI flag takes the fragment `5ucwdyvwivelbo4k4jomvrwel4`). Staff pool `us-east-1_IbPKPNJC9`.
Files bucket `amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg`. Source files: `/Users/adminoid/aljex-export/` (PII, outside repo).

Legend: **[VERIFIED]** = read from code/docs in this repo while writing. **[UNVERIFIED]** = could not be checked without touching production (or not exercised): confirm on the dry run before trusting it. Nothing in this document was run against production.

> STAGE 4 (TruckLocationHistory TTL) is NOT deployed: do not deploy it during the load.
> The encrypted tax-ID vault (`CarrierTaxVault` table + 2 KMS keys, "TaxVault" stack) IS deployed on production: it is created when `BCAT_SCHEMA_STAGE >= 1` (`amplify/backend.ts:2800` `TAX_VAULT_STAGE = 1`; `AW_STAGED_DEPLOY.md` stage-1 row). [VERIFIED in code]. The vault table is NOT an Amplify model, so it is not one of the 110 tables counted by `verify` unless ProdWrapper counts it; it is also absent from the backup script's list (AW_TAXID_BUILD.md "Backup script").

## 0. Rules for the whole load

1. **No deploys while loading.** No Amplify job (`start-job`, a push to `main`, a console redeploy), no CloudFormation update, no `BCAT_SCHEMA_STAGE` change until step 7 is done and Ryne says so. A deploy mid-load can replace Lambdas that are running an import. If a deploy starts by itself (webhook on `main`): STOP, wait for SUCCEED, re-run preflight (step 0), then resume from the last checkpoint. NEVER lower `BCAT_SCHEMA_STAGE` (it deletes tables).
2. **Every step is dry run first.** `awProd.mjs` defaults to dry run; `--apply` additionally needs `AW_PROD_CONFIRM=<today YYYY-MM-DD>-<step>` (e.g. `2026-11-09-customers`). Read the dry-run numbers against the "Expect" block BEFORE applying.
3. **One step at a time, in order.** Later steps read what earlier ones wrote (loads need customers + carriers; AR needs the loads' Orders/Shipments; AP needs loads + carriers).
4. **Stop conditions** (section "Stop conditions") override everything.
5. Never print or paste: Web Password, Fed/SS #, Bank Account, Routing #, passwords. Logs hold counts/status only.
6. Nothing in this load sends e-mail: carried-over invoices/bills are marked sent (`markedSentAt`, note "Carried over from Aljex") so release/send/queue actions refuse them [VERIFIED arFile.ts:4-14, AW-CDE-plan C.5].

## Common setup (once per terminal)

```sh
cd /Users/adminoid/bcat-ops
export AWS_PROFILE=<your prod admin profile>            # NORMAL AWS creds, account 273354631837, us-east-1
export AWS_REGION=us-east-1
SFX=5ucwdyvwivelbo4k4jomvrwel4
FILES=/Users/adminoid/aljex-export
LOGS=~/bcat-ops-backups/aw-prod-logs; mkdir -p $LOGS
STAMP=$(date +%F)                                       # confirm token prefix: AW_PROD_CONFIRM=$STAMP-<step>
read -s BCAT_PASSWORD; export BCAT_PASSWORD             # typed, never in a file/history
export BCAT_EMAIL=<an ADMIN staff user of pool us-east-1_IbPKPNJC9>
```
- CLI (ProdWrapper, final): `node scripts/awProd.mjs <step> --suffix $SFX [--apply] [step flags]`.
- Auth for Lambda steps: `BCAT_EMAIL` + `BCAT_PASSWORD` of an ADMIN in the production staff pool. Outputs are auto-discovered (no outputs file).
- Log for every step: `~/bcat-ops-backups/aw-prod-logs/<step>-<timestamp>.log` and `<step>.checkpoint.json` beside it (re-running the same step resumes). Logs = counts/status, before/after ItemCount per written table.
- `awProd.mjs` apply preconditions it checks itself: `~/bcat-ops-backups/LATEST_BACKUP_STAMP` exists and is < 6 h old; root CFN stack `UPDATE_COMPLETE`; no Amplify job RUNNING on `main`; deployed stage >= the step's need.
- Per-file steps additionally need `--live-tag <TAG>` on apply (typed confirmation, recorded in AuditLog). Use `AW-PROD-<MMDD>` (3-12 chars a-z0-9 for the loads tag: use `awprod1109`; the importAljex tag pattern is `^[a-z0-9]{3,12}$` [VERIFIED engine/tables.ts:9]).

### Where today's scripts REFUSE production, and what ProdWrapper does

| Script / guard | Today | Handled by |
|---|---|---|
| `scripts/awImport.mjs` `assertTarget` (needs `BCAT_STACK=dev|rehearsal`, refuses a stack resolving to prod, refuses repo-root `amplify_outputs.json`) | REFUSES production | `awProd.mjs customers|carriers|ap-aging|ap-expected|ar|stage-export|reconcile` do NOT use it any more: they run OFFLINE through `importAljex.mjs file|stage|reconcile-entity --target prod:<tag>` (below); `awImport.mjs` itself is NOT loosened. |
| `scripts/seedSeries20000.mjs` `assertSeriesSuffix` | REFUSES the production suffix, even dry run | `awProd.mjs settings` (same logic: 19999 + NUMERIC + 1 AuditLog). Script not loosened. |
| `scripts/grantJenny.mjs` (needs `BCAT_STACK`, refuses prod pool/suffix) | REFUSES production | `awProd.mjs jenny`. |
| `scripts/awBackfillShipments.mjs` `resolveTarget` (refuses prod suffix, `--apply` needs selected-stack outputs) | REFUSES production | `awProd.mjs backfill`. |
| `scripts/importCarrierTaxIds.mjs` (exits 2 on `--target`/`--i-mean-production`; replaces values with SYNTHETIC ids outside prod) | REFUSES production; also never reads real values | `awProd.mjs tax-ids --source` (real values batched 100/row-call straight to the Lambda, never printed). Script not loosened. If vault table missing it prints "vault not deployed: skipping tax IDs", exit 0. |
| `scripts/importAljex.mjs` + `scripts/lib/prodGate.mjs` (`requireProd`) | Production allowed ONLY via `--target prod:<TAG> --i-mean-production`, env `BCAT_ALLOW_PROD=<today>`, fresh (< 6 h) `prodpre-importAljex-*` on-demand backups of the 17 engine tables, typed `<account>:<suffix>` | `awProd.mjs loads` passes the flags/env/typed confirm for you, but YOU must create the `prodpre-importAljex-*` backups first (step 4c, `scripts/prodBackup.mjs`). Gate NOT loosened. |
| `scripts/lib/stackConfig.mjs` | production is never a `BCAT_STACK` value | unchanged; `awProd.mjs` does not use it. |
| Engine `tables.ts` | Lambda refuses production table names for offline/rehearsal use; the offline CLI uses `productionPolicy(suffix)` after the gate | `loads` AND every per-file step go through the offline CLI gate. **The Lambda cannot do per-file imports on production**: `router.ts assertNotProduction()` refuses the production tables in EVERY Lambda mode (first production dry run of `customers` failed with `Refusing to import into a production table`; the earlier note that the Lambda could write its own production tables was wrong). Route: `awProd.mjs customers|carriers|ap-aging|ap-expected|ar` -> `importAljex.mjs file --kind ... --target prod:<tag> --i-mean-production [--apply --confirm-prod <acct>:<suffix>]` (BCAT_ALLOW_PROD, fresh `prodpre-importAljex-*` backups before any apply, typed confirmation, dry run default writing nothing: PLAN runs over an in-memory overlay, no S3 object, no AljexImportJob row). `stage-export` -> `importAljex.mjs stage` (local STAGE of the big export, nothing uploaded). `reconcile` -> `importAljex.mjs reconcile-entity` (report computed locally; `--apply` publishes the RECONCILE job row + report files to the files bucket, needs `prodpre-importAljexRecon-AljexImportJob` backup). Job ids of these steps live in the local job book (`$TMPDIR/aljex-cli-jobs.json`) with the stripped source copy in `$TMPDIR/aljex-run-<id>/` (0600). Sensitive columns are stripped locally before the engine reads a row. These steps need AWS credentials only; the staff password is asked only for `backfill-check --evaluate` / `backfill` (Lambda API). |
| Other `PROD_WRITE_SETS` scripts (backfillRevDivision, backfillCustomers, ...) | gated `--target prod` | NOT part of this runbook. |

---

## Step 0: Preflight (read-only)

**Purpose:** prove the stack, backup, secrets and Jenny are in place before anything is written.

```sh
# 0.1 stack healthy, stage 3, no job running
APP=d3dejqzs77khq6
aws amplify get-branch --app-id $APP --branch-name main --query 'branch.environmentVariables.BCAT_SCHEMA_STAGE' --output text     # expect 3
aws amplify list-jobs --app-id $APP --branch-name main --max-results 5 --query 'jobSummaries[].[jobId,status,jobType]' --output table   # none RUNNING/PENDING
aws cloudformation list-stacks --stack-status-filter UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE UPDATE_IN_PROGRESS UPDATE_ROLLBACK_FAILED \
  --query "StackSummaries[?starts_with(StackName,'amplify-$APP-main')&&!contains(StackName,'-data')&&!contains(StackName,'-auth')].[StackName,StackStatus]" --output text   # root: UPDATE_COMPLETE
# 0.2 110 tables (metadata only)
aws dynamodb list-tables --query "length(TableNames[?contains(@,'$SFX')])"                      # expect 110
# 0.3 BCAT_DEV_STACK / BCAT_ISOLATED_PREVIEW / PORTAL_ORIGIN must NOT be set on main
aws amplify get-branch --app-id $APP --branch-name main --query 'keys(branch.environmentVariables)'   # must not list BCAT_DEV_STACK, BCAT_ISOLATED_PREVIEW
# 0.4 Jenny exists in the prod staff pool (read-only; prints no password)
aws cognito-idp list-users --user-pool-id us-east-1_IbPKPNJC9 --filter 'email = "Jenny@bcatcorp.com"' --query 'Users[].[Username,UserStatus,Enabled]' --output text   # exactly 1 row, Enabled True
#   (Cognito's filter is case-sensitive: if empty, list all and match case-insensitively; grantJenny does that itself.)
# 0.5 dry-run verify of the wrapper (read-only)
node scripts/awProd.mjs verify --suffix $SFX
```
**Fresh backup (Ryne is taking it now).** When it finishes: `date -u +%FT%TZ > ~/bcat-ops-backups/LATEST_BACKUP_STAMP` (apply steps refuse a stamp older than 6 h; rewrite the stamp only after a NEW backup finished). The backup must include all 110 tables + `CarrierTaxVault-<apiId>` (add it to the backup list: AW_TAXID_BUILD.md) + the files bucket. The 2026-11-08 backup has only the 60 pre-merge tables [VERIFIED RESTORE.md]; the 50 tables created by stages 1-3 are NOT in it.

**Secrets / degrade list** (AW_SECRETS_ENV_AUDIT.md): the load needs none of them. Known degraded: `GOOGLE_MAPS_API_KEY` and `GEOCODE_TOKEN_SECRET` (missing in SSM; geocode/route-miles features off, deploy unaffected), MyCarrierPackets/OPENAPI/GMAIL_REP_OAUTH not set for pool IbPKPNJC9 (carrier invites/sync, Gmail AP inbox off). Present: ANTHROPIC, SLACK_*, INTAKE_WEBHOOK_SECRET, MOTIVE, OTR_*, PAYCHEX_*, BLUE_INK. Do not enter them during the load (secrets set = `npx ampx secret set` which can trigger a redeploy: see step 7).

**Files check (counts):** `wc -l` is not row count (quoted newlines possible): the dry runs report the row counts. File names expected:
`aljex-customers-2026-11-08.csv` (761 rows), `aljex-carriers-2026-11-08.csv` (2,462), `aljex-full-export-2026-11-07.csv` (8,347), `aljex-ap-aging-2026-11-08.csv` (67), `aljex-ap-expected-2026-11-08.csv` (36), `aljex-ar-2026-11-07.csv` (296), `aljex-active-shipments-2026-11-08.csv` (10), `billing-method-draft-2026-11-08.csv`.

**Writes:** nothing. **SAFE ABORT:** yes (nothing written). **Pass:** every command above as annotated. Anything else = stop.

---

## Step 1: Settings (TmsSettings `default` row)

**Purpose:** numbering floor, Ryne's company settings and the ownership/division seed, before any data exists. The `TmsSettings#default` row must already exist (the app creates it on first use; `seedSeries20000` REFUSES to create it) [VERIFIED seedSeries20000.mjs:47].

**Check what exists first (read-only; prints only the non-sensitive keys):**
```sh
aws dynamodb get-item --table-name TmsSettings-$SFX-NONE --key '{"id":{"S":"default"}}' \
  --projection-expression 'nextShipmentNumber,proScheme,invoiceAlwaysCopyEmails,defaultPaymentTermsDays,aljexCutoffAt,divisionSalesReps,invoiceSeriesStart,factorRemitTo' --output json
```
(single-item get of a settings row: allowed, it is metadata/config; the `--projection-expression` avoids other columns.) Production's TmsSettings was EMPTY in the 2026-11-08 backup (`TmsSettings.jsonl` empty) [VERIFIED AW_PRO_LINK_FINDINGS §3, but that table did not exist then: stage 0 added the fields; whether the `default` row exists now is UNVERIFIED]. If `Item` is absent: open the app once as ADMIN (Settings > Shipments or any settings page saving defaults) so the row is created, then re-check. Do not create it by hand.

**1a. Numbering floor (script):**
```sh
node scripts/awProd.mjs settings --suffix $SFX                       # dry run: expect "SET ... counter <n> -> 19999, scheme NUMERIC; next PRO 20000"
AW_PROD_CONFIRM=$STAMP-settings node scripts/awProd.mjs settings --suffix $SFX --apply
```
Semantics (seedSeries20000): `nextShipmentNumber = 19999` ("last issued", so the next PRO is **20000**), `proScheme = NUMERIC` (counter IS the PRO), PRO = invoice number (no separate series; `invoiceSeriesStart` untouched). REFUSES (exit 2) if counter already >= 19999 (not rewound), or a numeric PRO >= 20000 is already in `ProClaim`. NOOP if already 19999 + NUMERIC. Writes: `TmsSettings` 1 row (2 fields), `AuditLog` 1 row (`SEED_SERIES_20000`). Aljex PROs top out at 14,939; production loads at 14,939 (+ outlier 99001: below 20000 so no collision) [VERIFIED PRO_LINK_FINDINGS].

**1b. Company settings (UI, signed in as ADMIN; no script):**
| Setting | Where | Value |
|---|---|---|
| Always-copy invoice e-mails | Settings > AR / Invoicing (action `SAVE_AR_SETTINGS`, field `invoiceAlwaysCopyEmails`) | `invoices@bcatcorp.com` |
| Default payment terms | same (`defaultPaymentTermsDays`) | `30` |
| Aljex cutoff | Settings > Company > Data > "Aljex cutoff" (`aljexCutoffAt`) | `2026-11-07 00:00` America/Chicago (stored as `2026-11-07T06:00:00.000Z`: CST is UTC-6 on 11-07; DST ended 2026-11-01) [UNVERIFIED which UI field; the import reads the Chicago day of this instant: engine/stage.ts:31-42] |
| Division sales reps | Settings > Divisions (`divisionSalesReps`) | BROKERAGE = Ryne Bandolik; ASSETS = "Ivan Cartage" profile (`ivan-cartage`, non-login); CAR_SHIPPING = Ruben Vargas; OWNER_OPERATOR = Ruben Vargas [VERIFIED AW-CDE-plan C.5]. The picker uses user profiles; if the `ivan-cartage` profile doesn't exist the save fails: report, don't create ad hoc [UNVERIFIED that it is seeded on prod]. |
| Ownership divisions + rules (incl. the four Rev Type rules `REFERENCE_MATCHES ALJEX_REV_TYPE = B|I|A|O`) | Settings > Divisions > "Seed" button = directory action `ENSURE_OWNERSHIP_SEED` (idempotent; writes only missing rows; second run reports 0 created) | run once, then run again: second must report 0 created [VERIFIED handler.test.ts:2141-2160]. Rule mapping B=BCAT Logistics, I=Ivan Cartage, A=Bestcare Auto Transport, O=owner operators [VERIFIED STEP_AW round 1 #4]. Whether the four Rev Type rules are part of the current `SEED_RULES` is UNVERIFIED: after seeding, open Divisions and confirm 4 rules with ALJEX_REV_TYPE B/I/A/O exist; if not, STOP (importer divisions depend on them). |

(ProdWrapper's `settings` step covers only 1a; 1b is UI/Lambda actions as listed. Order within 1b: cutoff first, then ownership seed, then reps.)

**Expected:** after 1a `verify` shows `nextShipmentNumber 19999, proScheme NUMERIC`; after 1b the get-item above shows the always-copy list, 30, cutoff, reps.
**Verification:** re-run the `get-item` above and `node scripts/awProd.mjs verify --suffix $SFX`.
**SAFE ABORT:** yes, after 1a or after 1b (settings only).
**Rollback (per table):** `TmsSettings` + `AuditLog` only. Revert the counter: `aws dynamodb update-item --table-name TmsSettings-$SFX-NONE --key '{"id":{"S":"default"}}' --update-expression 'SET nextShipmentNumber = :n' --expression-attribute-values '{":n":{"N":"<value before, from the log>"}}'` (the numbering is forward-only in the app, but a raw revert before any PRO is minted is safe). Otherwise restore the TmsSettings row from the fresh backup jsonl/`restore-table-from-backup` into `TmsSettings-RESTORED` and copy the `default` item back (never overwrite a live table in place without a diff). Settings-UI changes are re-editable.
**Log:** `$LOGS/settings-<ts>.log`.

---

## Step 2: Jenny grant

**Purpose:** Jenny@bcatcorp.com is the ONLY holder of `page-billingRelease` (Release to billing, Send invoice, factoring queue changes) and `page-aljexSignoff` (reconciliation decisions + sign-off). ADMIN and owner do NOT have them by role.
```sh
node scripts/awProd.mjs jenny --suffix $SFX                          # dry run: plan "groups to add: page-billingRelease, page-aljexSignoff"
AW_PROD_CONFIRM=$STAMP-jenny node scripts/awProd.mjs jenny --suffix $SFX --apply
```
**Fails loudly** (exit 2) if no/duplicate Cognito user has that e-mail (nobody is created). Missing groups are created. Also adds `extraPages` to Jenny's `UserProfile` row if present; if no profile row, it WARNS: groups are added but a Users-page save would strip them: create/confirm her profile (Users page) and re-run [VERIFIED grantJenny.mjs:73-135]. (Note: ProdWrapper's `jenny` says "no table", yet grantJenny updates `UserProfile.extraPages`: UNVERIFIED whether the wrapper keeps that write; check the dry-run output "UserProfile.extraPages to add".)
**Verify nobody else holds the groups (read-only):**
```sh
for G in page-billingRelease page-aljexSignoff; do
  echo $G; aws cognito-idp list-users-in-group --user-pool-id us-east-1_IbPKPNJC9 --group-name $G --query 'Users[].Attributes[?Name==`email`].Value[]' --output text
done        # each prints exactly: Jenny@bcatcorp.com
```
If another user is listed: STOP, report (do not remove without Ryne). A "ResourceNotFoundException" for a group before the apply is normal.
**Writes:** Cognito group membership; `UserProfile` (1 row). **SAFE ABORT:** yes. **Rollback:** `aws cognito-idp admin-remove-user-from-group --user-pool-id us-east-1_IbPKPNJC9 --username <Jenny's username> --group-name page-billingRelease` (and `page-aljexSignoff`); restore her `UserProfile` row from the backup jsonl (`tables-main/UserProfile.jsonl` is not in the 2026-11-08 backup: UserProfile is a stage-1 table, so the fresh backup is the source). **Log:** `$LOGS/jenny-<ts>.log`.

---

## Step 3: Shipments for the 958 production Loads: order and what each tool creates

**Facts (production backup, counts only) [VERIFIED AW_PRO_LINK_FINDINGS.md]:** 958 Loads, all with a 5-digit PRO in `Load.aljexId` (696 padded, 2 as `Pro# NNNNN`), 0 duplicates, 0 without PRO, 0 Shipments, 0 linked. Range 13171..14939 + outlier 99001. 933 of 958 PROs match the dev Aljex import (Nov 3 file); the 25 unmatched are PROs 14913..14939 (minted after the Nov 3 export). The **2026-11-07 export contains 27 new loads PRO 14913..14939** (the 25 + 2) [VERIFIED STEP_AW round 3 note], so against THIS file expect ~957 matched-by-PRO and 1 (99001) by ID: **UNVERIFIED, the dry run decides**.

**Two tools, two different things:**
- **Importer `LINK` class** (`awProd.mjs loads`, step 4c): for each export PRO whose normalised key equals a production Load's `aljexId`, builds Shipment/Order/LoadFinancials/LoadCharge/LoadCarrier/ProClaim from the Aljex row but REUSES the existing Load: one conditional `UpdateItem` on the Load setting ONLY `shipmentId, orderId, loadNumber, leg` (`attribute_not_exists(shipmentId)`). Never edits other Load fields [VERIFIED AW-CDE-plan C.2, engine/load.ts:72-73,236].
- **`BACKFILL_SHIPMENT`** (`awProd.mjs backfill`): for each in-window Load NOT matched by the export, creates Shipment + Order + financials/charges/LoadCarrier + ProClaim (origin BACKFILL) from the LOAD itself, number `L<aljexId>`, ids `stableId('shp'|'ord'|'chg', loadId)`; skips ALREADY_LINKED / SHIPMENT_VOIDED / PRO_CLAIMED_BY_OTHER_LOAD. **THE CUTOFF MEANS BOOKED (2026-11-08, Ryne): Aljex is final as of the cutoff, so a Load booked before it but shipping after it is CARRIED (Monday's work).** Window = ship date (pickupAppt, else deliveryAppt, else createdAt) on or after cutoff-24 months = 2024-11-07, with NO upper bound. Loads shipping on/after the cutoff that were created before it are reported as **`carriedOver`** (informational; expected 17 on 2026-11-08, PRO 14811..14939) and ARE classified/linked. **`afterCutoff` = Loads CREATED (`Load.createdAt` day) on/after the cutoff** (no createdAt: ship date on/after the cutoff): booked after Aljex was final, never classified or linked, and STOP (script exit 3). Same rule for the importer STAGE: Aljex export rows have only the lower bound (every row in the snapshot was booked before the cutoff), recorded in `history-skipped.csv` as BEFORE_WINDOW only; `stage-index.json` history has no `afterCutoff`. [VERIFIED awBackfillShipments.mjs partitionByWindow, engine/stage.ts].

**Order that never duplicates (decision):** (a) backfill DRY RUN first (3a, read-only, gives the buckets); (b) the **big-export importer LINK runs FIRST** (step 4c); (c) `backfill --apply` runs LAST for whatever is left (the linked-by-ID bucket, expected ~1 + any no-PRO loads). Reason: if the backfill ran first it would create `L<pro>` Shipments + ProClaims for all 958, then the importer would find each PRO's ProClaim held by that Load and classify AMBIGUOUS (or create a second digits-only Shipment): duplicates [INFERENCE from C.2 step order + engine/load.ts:72]. Both steps are idempotent and resumable (deterministic ids, conditional writes, checkpoint file).

**3a. Dry run (read-only; do it now, before step 4):**
```sh
# PRO list from the big export (first column only; no PII). Keep outside the repo.
python3 - <<'PY' > /tmp/aw-export-pros.txt
import csv
r=csv.reader(open('/Users/adminoid/aljex-export/aljex-full-export-2026-11-07.csv',newline='',encoding='utf-8-sig'))
h=next(r); i=[c.strip().lower() for c in h].index('pro #') if 'pro #' in [c.strip().lower() for c in h] else 0
for row in r: print(row[i].strip())
PY
wc -l /tmp/aw-export-pros.txt                         # expect 8347 lines
node scripts/awProd.mjs backfill --suffix $SFX --cutoff 2026-11-07 --export-keys /tmp/aw-export-pros.txt
```
(The `pro #` header name is UNVERIFIED: check the header of the file's first column before running; `--export-keys` reads the first CSV column of the file, so you may pass the CSV itself.) Note ProdWrapper's `backfill` is read-only without `--apply`.
**Expect:** counts add up to the in-window Load count: matched-by-PRO ~957, linked-by-ID ~1, ambiguous 0, unmappable 0, already linked 0; window block: beforeWindow 0, **carriedOver = 17** (informational: booked before 2026-11-07, shipping 11-07..11-16), **afterCutoff = 0** (Loads CREATED on/after the cutoff). **If afterCutoff > 0: STOP and report to Ryne** (a Load booked after Aljex was final is not in the export and is not linked; Ryne decides). **If ambiguous > 0: STOP** (Ryne decides each; never guessed).
**3b. Apply** is run AFTER step 4c, see 4c-bis.
**Verification:** link counts after 4c-bis: `Shipment` count >= 958 matched; every Load has `shipmentId`: second `backfill` dry run reports "already linked 958/..., LINK candidates 0".
**Rollback:** see 4c / 4c-bis (tables Shipment, Order, Load [only 4 fields], LoadCarrier, LoadFinancials, LoadCharge, ProClaim, AuditLog).

---

## Step 4: Imports (in this order)

Pre-step for ALL of step 4: fresh backup stamp (step 0), still no deploy. Each file import is: dry run → compare to Expect → apply with `--live-tag`. Record the printed **job id** of each (needed for step 5). `<TAG>` = `AW-PROD-1109` style for per-file imports.

### 4a. Customers
```sh
node scripts/awProd.mjs customers --suffix $SFX --file $FILES/aljex-customers-2026-11-08.csv
AW_PROD_CONFIRM=$STAMP-customers node scripts/awProd.mjs customers --suffix $SFX --file $FILES/aljex-customers-2026-11-08.csv --apply --live-tag AW-PROD-1109
```
**Rules [VERIFIED STEP_AW answers 1-4, AW-CDE-plan D.1, AW_IMPORT_RUNBOOK]:** key = Aljex `Account #` (stored `Customer.aljexCode`), never name. Exclude TEST CUSTOMER (acct 100003) and `^ZZ|test` names. GUEST SUPPLY IS imported. **Status N (245) become Locations**, not customers. Division from Rev Type B/I/A/O (`defaultDivisionKey`); sales rep by division, NOT Aljex rep code (rep/dispatcher codes not imported). Billing seed: `FACTOR` iff E-Billing Email is `ivanfactoring@bcatcorp.com` or `invoicefactoring@bcatcorp.com`; `MANUAL` otherwise with `apEmail` = that address; 7 customers on `invoices@bcatcorp.com` (internal) are MANUAL with AP e-mail unset + `billingNeedsReview` (not applied until Ryne confirms; `billing-method-draft-2026-11-08.csv` is the review list). Danisco accounts 100338 and 100629 (+ "DANISCO US, INC." variants) = Net 120. Default terms Net 30. 32 duplicate-name groups are imported, each its own customer, flagged "Possible duplicate" in the UI. Web Password column: stripped locally; never uploaded.
**Expect (real file, parser counts, AW_IMPORT_RUNBOOK §1 row 1 [VERIFIED by the rehearsal docs, not on prod]):** 761 rows (516 active Status Y + 245 Status N); **515 customers** (516 active minus TEST CUSTOMER 100003 = 515: consistent) + **245 Locations**; **479 FACTOR / 36 MANUAL** by e-billing address; **10 flagged "needs review"**; 32 duplicate-name groups; 2 Danisco accounts at 120 days. `customersCreated + customersMatched + customersEnriched = 515` on a first run into an empty target. (Older readiness text says 478 factor/38 manual/24 name groups/9 flagged: superseded by round 2-3 decisions and the real-file recount: trust the dry run; tolerance below.) Whether ZZ/test rows beyond TEST CUSTOMER exist: the dry run lists exclusions: UNVERIFIED.
**Writes:** `Customer` (515 new), `Location` (245 new), `AljexImportJob` (1+), `AuditLog` (counts only). Tables touched by the engine write set also include `TmsSettings`: UNVERIFIED if customers writes it.
**Verify:** `node scripts/awProd.mjs verify --suffix $SFX` (ItemCount for Customer/Location; DescribeTable ItemCount is refreshed ~6-hourly, so for exact counts use the app: Customers list total, Billing setup header "N factor / N manual / N not set"). Expect Billing setup: 479 factor, 36 manual (of which ~10 "needs review"/Missing), ~0 not set outside the flagged.
**SAFE ABORT:** before `--apply`. After apply, abort here = rollback below.
**Rollback:** tables `Customer`, `Location`, `AljexImportJob`, `AuditLog`. They were empty/new for these rows: delete the import's items by job: items carry `legacyImported`/`importRunId` [VERIFIED AW-CDE-plan C.5]. Simplest exact path: restore `Customer-$SFX-NONE` and `Location-$SFX-NONE` from the pre-step backup into `Customer-RESTORED`/`Location-RESTORED`, diff, and re-put the pre-import items (Customer and Location existed on prod BEFORE this load: production had customers: see "Existing production data" below) and delete the rest by `importRunId`. Never overwrite in place without a diff.
`aws dynamodb restore-table-from-backup --target-table-name Customer-RESTORED --backup-arn <arn from the fresh backup's dynamodb_backups.json>`.
**Log:** `$LOGS/customers-<ts>.log`.

> **Existing production data:** production already has Customer/Location/Load/Driver etc. from 2026-05..11 (60 pre-merge tables, 99,349 items in the 2026-11-08 backup). The importer MATCHES existing rows (created / matched / enriched). If the dry run shows `customersMatched` > 0, that's expected; confirm none of the matched is a surprise.

### 4b. Carriers
```sh
node scripts/awProd.mjs carriers --suffix $SFX --file $FILES/aljex-carriers-2026-11-08.csv
AW_PROD_CONFIRM=$STAMP-carriers node scripts/awProd.mjs carriers --suffix $SFX --file $FILES/aljex-carriers-2026-11-08.csv --apply --live-tag AW-PROD-1109
```
**Rules:** match MC/DOT first, then `Aljex Carrier ID`, never name alone; duplicates (the repeated MC, 17 repeated names) merge, other Aljex ids kept in `aljexAliases`; inactive imported INACTIVE (never active); `Factor Id` mapped to remit-to/factor; Quick Pay kept; `Fed/SS #`, `Bank Account`, `Routing #` (and the tax-id-shaped `Account #`) stripped locally BEFORE upload, only counts printed; **bank/routing never imported**.
**Expect [VERIFIED AW_IMPORT_RUNBOOK row 2, real file]:** 2,462 rows; **19 other vendors skipped**; repeated MC merges two rows → **2,442 carriers** (2,443 flagged carriers before the merge), **252 inactive**, 183 with Factor Id, 14 Quick Pay, 12 with terms. (Readiness doc's first read: 2,191 active/260 inactive: superseded.) 
**Writes:** `Carrier` (~2,442; merged with any existing), `CarrierPaymentMethod`? (UNVERIFIED), `AljexImportJob`, `AuditLog`. Tax-ID mirror fields are NOT set here.
**Verify:** dry run numbers; app Carrier directory count; `reconcile --entity CARRIERS` (step 5).
**SAFE ABORT:** before apply. **Rollback:** `Carrier` (and `CarrierPaymentMethod`) via the fresh backup as for 4a. Production had NO carrier directory table before stage 1 [VERIFIED STEP_AW carrier note], so after-load rollback of `Carrier` can simply empty the table items created by this run (`importRunId`), plus `AljexImportJob`, `AuditLog` rows. **Log:** `$LOGS/carriers-<ts>.log`.

**4b-tax. Carrier tax IDs (Fed/SS #) → encrypted vault, OPTIONAL: recommendation = SKIP now, run later with Ryne present.**
Why: `importCarrierTaxIds.mjs` refuses production on purpose (design Q7: "a production flag is added later, deliberately, when Ryne is present"); its non-prod path substitutes SYNTHETIC ids, so it can never be pointed at prod. What `awProd.mjs tax-ids --source $FILES/aljex-carriers-2026-11-08.csv` changes: it reads the column in-process, sends it 100 rows at a time as a direct `IMPORT_TAX_IDS` invoke of `tms-carrier-actions` with your AWS creds, never printing/logging values; prod rejects IRS-impossible synthetic ids by design [VERIFIED AW_TAXID_BUILD.md decisions 3, 7]. Preconditions: stage >= 1 (vault deployed: yes), carriers imported (4b). Production real-value import is irreversible-ish (values are encrypted; `CLEAR_TAX_ID` per carrier). Dry run first (counts only): `node scripts/awProd.mjs tax-ids --suffix $SFX --source $FILES/aljex-carriers-2026-11-08.csv`. Recommend: run the dry run to get counts; apply ONLY if Ryne explicitly says so after Jenny's sign-off; NEVER required for go-live. Bank/routing are never imported.
**Rollback:** table `CarrierTaxVault-<apiId>` (ciphertext) + Carrier mirror fields (`taxIdLast4`, `taxIdType`, `taxIdOnFileAt`); `CLEAR_TAX_ID` per carrier or delete vault items; a restore into the same stack works as-is.

### 4c. Big export: the loads (two passes)
Source: `aljex-full-export-2026-11-07.csv` — **8,347 rows, PRO 6000..14939**, deliveries through 2026-11-06, 4 repeated PROs (reported). 24-month window from the cutoff: ship dates from **2024-11-07**; older loads are skipped and counted (`history-skipped.csv`). **No upper bound: the cutoff means BOOKED**; the file is a snapshot at the cutoff so every row was booked before it, and the 21 rows with ship date on/after 2026-11-07 are KEPT (carried over). Real-file numbers (STAGE + PLAN run locally on this file, counts only): 7,944 LOAD rows (7,940 + 4 identical duplicates) + 403 memo rows; **LOAD skipped = 2,605** (2,601 before 2024-11-07 + 4 duplicates; was 2,626 when the 21 were skipped); **LOAD created + matched = 5,339** (was 5,318). The 11-03 file stays as history only.

**4c-0. Stage the file (writes only S3; used by SHIPMENTS and AR reconciliation):**
```sh
node scripts/awProd.mjs stage-export --suffix $SFX --file $FILES/aljex-full-export-2026-11-07.csv       # dry run
AW_PROD_CONFIRM=$STAMP-stage-export node scripts/awProd.mjs stage-export --suffix $SFX --file $FILES/aljex-full-export-2026-11-07.csv --apply
```
Expect "staged: job <id>, **8347 rows**, stage hash …; no table written". Record the **staged job id**.

**4c-1. Pre-write backups required by the importAljex gate (in addition to LATEST_BACKUP_STAMP):**
```sh
export BCAT_ALLOW_PROD=$(date +%F)
node scripts/prodBackup.mjs --target prod --i-mean-production --script importAljex            # dry run lists the 17 tables
node scripts/prodBackup.mjs --target prod --i-mean-production --script importAljex --apply    # creates prodpre-importAljex-<Model>-<stamp> backups (valid 6 h; re-run skips fresh ones) [VERIFIED prodBackup.mjs:5-11]
```
(The 17 tables: Shipment, Order, Load, LoadCarrier, LoadFinancials, LoadCharge, Customer, Location, Carrier, Invoice, ArPayment, CarrierBill, ApPayment, ProClaim, TmsSettings, AuditLog, LegacyAljexRow [VERIFIED prodWriteSets.mjs].) `prodBackup` creates backups only (on-demand `CreateBackup`: it is a production AWS write, but non-destructive).

**4c-2. PASS 1: PLAN (writes nothing; dry run):**
```sh
node scripts/awProd.mjs loads --suffix $SFX --source $FILES/aljex-full-export-2026-11-07.csv --live-tag awprod1109
```
Reads the plan classes: **CREATE / ENRICH / LINK / AMBIGUOUS / CONFLICT** [VERIFIED engine types.ts:23]. **Expect:** LOAD staged 7,944, **skipped 2,605**, created + matched 5,339 (LINK ≈ the matched PROs, ≈957 with this file now that the 17 carried-over Loads are in the window: UNVERIFIED); AMBIGUOUS 0; CONFLICT 0; CREATE ≈ 5,339 − LINK; 4 repeated PROs reported; skipped-by-window count reported. **AMBIGUOUS or CONFLICT > 0 → STOP.** The plan also stages and prints the **job id** for the apply.
**4c-3. PASS 2 (LIVE):**
```sh
AW_PROD_CONFIRM=$STAMP-loads node scripts/awProd.mjs loads --suffix $SFX --source $FILES/aljex-full-export-2026-11-07.csv --live-tag awprod1109 --apply
#   resume after an interruption (same tag): ... loads --suffix $SFX --live-tag awprod1109 --resume <JOBID> --apply
```
The wrapper passes `BCAT_ALLOW_PROD`, `--i-mean-production`, `--confirm-prod <account>:<suffix>` (typed confirmation). It delegates to `importAljex.mjs run --target prod:awprod1109`; with `--prod-mode-rehearsal-suffix` NOT used. NOTE: the offline docs (AW_IMPORT_RUNBOOK §1a) require "a reconciled rehearsal copy of the same file" before LIVE (`runSlice.ts:93-101`: live apply needs a RECONCILED rehearsal of the same stageHash). For production the offline CLI's own gate applies; if it refuses with "no reconciled rehearsal for this stage hash": STOP and report (Ryne's rehearsal on the `rehearsal` branch must have reconciled the identical file: UNVERIFIED that the 2026-11-07 file was reconciled there).
**What it creates (per in-window export row):** `Shipment`, `Order`, `LoadFinancials`, `LoadCharge`, `LoadCarrier`, `ProClaim` (+ `Invoice`/`ArPayment`/`CarrierBill`/`ApPayment` where the row shows invoiced/paid), `LegacyAljexRow`, `Customer`/`Location`/`Carrier` enrichment, `AuditLog`; for LINK rows: NO new Load, one conditional update of 4 fields on the existing Load. Carried-over marking on imported invoices/bills. Aljex rep/dispatcher codes not imported.
**Then the numbering counter:** `importAljex.mjs seed-counter` is NOT needed: step 1 already set 19999/NUMERIC. Do not run `seed-counter --enable-numeric` on prod.
**4c-4. Verify:** `verify`; the importer prints `reconciled YES` (counts); reconcile SHIPMENTS in step 5; **958 production Loads** each carry `shipmentId` after 4c-bis.
**Production existing counts:** Loads before = 958; after = **958 + (CREATE count)** (LINK adds no Load). Expect Loads to grow by about (in-window export rows − LINK) UNVERIFIED.
**SAFE ABORT:** before 4c-3 apply (pass 1 only). After apply, abort = rollback.
**Rollback (tables: Shipment, Order, Load, LoadCarrier, LoadFinancials, LoadCharge, Customer, Location, Carrier, Invoice, ArPayment, CarrierBill, ApPayment, ProClaim, TmsSettings, AuditLog, LegacyAljexRow):** (1) preferred, importer's own rollback by run: `BCAT_ALLOW_PROD=$(date +%F) node scripts/importAljex.mjs rollback --run <applyJobId> --target prod:awprod1109 --i-mean-production [--apply]` (production form shown in the script header; deletes what the run created, dry run by default) [VERIFIED importAljex.mjs header lines 21-26]; (2) per table from the `prodpre-importAljex-*` backups: `aws dynamodb restore-table-from-backup --target-table-name <Model>-RESTORED --backup-arn <arn>` then diff/copy-back; (3) the 60 pre-merge tables from `~/bcat-ops-backups/2026-11-08-pre-aljex-migration/tables-main/<Model>.jsonl` (re-put chosen items) per RESTORE.md path 2/3; tables created by stages 1-3 are not in that backup: use the FRESH backup, or empty them (they were empty before the load). `Load`: the four link fields (`shipmentId`, `orderId`, `loadNumber`, `leg`) are the only change to existing Loads: `REMOVE` them to undo a LINK. **Log:** `$LOGS/loads-<ts>.log`.

**4c-bis. Backfill apply (the leftover Loads; after 4c-3):**
```sh
node scripts/awProd.mjs backfill --suffix $SFX --cutoff 2026-11-07 --export-keys /tmp/aw-export-pros.txt        # dry run again: matched-by-PRO should be 0 left, linked-by-ID ~1
AW_PROD_CONFIRM=$STAMP-backfill node scripts/awProd.mjs backfill --suffix $SFX --cutoff 2026-11-07 --export-keys /tmp/aw-export-pros.txt --apply
```
Writes `Shipment/Order/Load[link fields]/LoadCarrier/LoadFinancials/LoadCharge/ProClaim/AuditLog` for the linked-by-ID bucket only (stage >= 2). Exit 2 on conflicts. Idempotent: a second run reports 0. **Expect** applied = linked-by-ID count; after: every in-window Load linked. **Rollback:** the same tables; deterministic ids `stableId('shp'|'ord'|'chg', loadId)`: delete those Shipment/Order/LoadCharge items and their ProClaim (origin BACKFILL), and `REMOVE shipmentId, orderId, loadNumber, leg` from the Load; or restore from the backup. **Log:** `$LOGS/backfill-<ts>.log`.

### 4d. AP aging
```sh
node scripts/awProd.mjs ap-aging --suffix $SFX --file $FILES/aljex-ap-aging-2026-11-08.csv
AW_PROD_CONFIRM=$STAMP-ap-aging node scripts/awProd.mjs ap-aging --suffix $SFX --file $FILES/aljex-ap-aging-2026-11-08.csv --apply --live-tag AW-PROD-1109
```
**Rules:** key = Pro # + Vendor ID (= Aljex Carrier ID); bill number `<PRO>-<vendor>`; `Vend Invoice #` kept as reference only; **`Amount Paid` is NOT a payment: it is the bill amount** (balance = open amount); `C` = check, `D` = direct deposit (stored `aljexPayMethod`); pay-to ≠ vendor on 40 rows → carrier remit-to/factor; carried over (never resent, never re-paid), status TO_BE_PAID with LEGACY_IMPORT warning.
**Expect [VERIFIED docs]:** **67 bills, $83,407.20** (0-30 $66,642.20; 31-60 $16,765.00; nothing older); tie-out lines `diff $0.00`; any bill whose PRO or carrier is not in BCAT shows as `unresolved` (Aljex-only): STOP if >0 beyond what Ryne accepts.
**Writes:** `CarrierBill` (67), `LoadCarrier` (apStatus), `ApPayment`? (none expected), `AljexImportJob`, `AuditLog`. **Verify:** open AP in the app = $83,407.20; `reconcile --entity AP`. **SAFE ABORT:** before apply. **Rollback:** tables `CarrierBill`, `LoadCarrier`, `AljexImportJob`, `AuditLog` (+`ApPayment` if any): backup restore + delete by `importRunId`; `CarrierBill` is a stage-3 table (empty before): empty it. **Log:** `$LOGS/ap-aging-<ts>.log`.

### 4e. AP expected
```sh
node scripts/awProd.mjs ap-expected --suffix $SFX --file $FILES/aljex-ap-expected-2026-11-08.csv
AW_PROD_CONFIRM=$STAMP-ap-expected node scripts/awProd.mjs ap-expected --suffix $SFX --file $FILES/aljex-ap-expected-2026-11-08.csv --apply --live-tag AW-PROD-1109
```
**Expect:** 36 rows $35,269.18 in the file; **12 stale 2024/2025 rows ($7,562.71) DROPPED** (Ryne round 3 #3) → **24 rows / $27,706.47** kept; PRO 6269 (3 vendor-name variants) kept once and listed. Kept as its own report line, NEVER payables: matching `LoadCarrier.apStatus = AWAITING_INVOICE`. **Writes:** `LoadCarrier` (apStatus), `AljexImportJob`, `AuditLog`; no `CarrierBill`. **Rollback:** `LoadCarrier` `apStatus` reverted from backup. **Log:** `$LOGS/ap-expected-<ts>.log`. (Whether the drop-12 rule is applied automatically by the importer or listed for manual action: the AW_IMPORT_RUNBOOK says dropped; UNVERIFIED: confirm the dry run says 24.)

### 4f. AR
```sh
node scripts/awProd.mjs ar --suffix $SFX --file $FILES/aljex-ar-2026-11-07.csv
AW_PROD_CONFIRM=$STAMP-ar node scripts/awProd.mjs ar --suffix $SFX --file $FILES/aljex-ar-2026-11-07.csv --apply --live-tag AW-PROD-1109
```
(Run AFTER 4c: each invoice links to the Order/Shipment of the same PRO [VERIFIED arFile.ts:4-9].)
**Rules:** one carried-over `Invoice` per open invoice (`markedSentAt` = invoice date, note "Carried over from Aljex (cutoff 2026-11-07)": never resent); Invoice Date kept; **open = sum of the five aging buckets** (NEVER `Balance Due`/`Total Exposure`/`Unbilled`); bill-to party kept (62 invoices bill another party); **3 partial payments ($3,450.00) become `ArPayment` rows**; **Danisco (accounts 100338, 100629 and variants resolving to them): due date = invoice date + 120 days** for ALL Danisco invoices incl. the 54 at Aljex 90 days; `aljexDueDate`/`aljexTerms` stored + audit `ALJEX_AR_REDATE` [VERIFIED arFile.ts:10-12,116-117,430-461]; every other invoice keeps its Aljex due date. (Ryne's brief said "55 Danisco"; the AR docs say 54 rows at 90 days: the dry run line `redated: count N` is the truth, UNVERIFIED which.)
**Expect:** **296 invoices, $357,753.44** (0-30 $216,416.34; 31-60 $62,201.30; 61-90 $30,005.50; 91-120 $14,874.95; 120+ $34,255.35) in the Aljex aging; BCAT buckets differ ONLY for redated Danisco rows (`byBucketBcat`), total unchanged; invoice amount $361,203.44 − payments $3,450.00; 50 factored $40,553.06 / 246 manual $317,200.38; 8 invoices from 2024 ($25,786.91). **Any invoice whose PRO or customer is not in BCAT is listed: STOP if >0.** No FactoringItem/queue row is created for a carried-over invoice [VERIFIED arFile.ts:13-14].
**Writes:** `Invoice` (296), `ArPayment` (3), `AljexImportJob`, `AuditLog` (+ ~Danisco redate lines). **Verify:** app AR total = $357,753.44; `reconcile --entity AR`. **Rollback:** tables `Invoice`, `ArPayment`, `AljexImportJob`, `AuditLog` (+ `Order.invoiceId` if enriched: restore Order from backup): stage-3 tables were empty: empty them by `importRunId`; Order from the `prodpre-importAljex-*` backup. **Log:** `$LOGS/ar-<ts>.log`.

### 4g. Active-shipments check (read-only; recommended, writes nothing)
`node scripts/awProd.mjs ...`: UNVERIFIED that the wrapper exposes `active-check` (not in ProdWrapper's list). Done by hand in step 6 (spot checks) instead.

---

## Step 5: Reconciliation (read-only reports; Jenny decides and signs off)

```sh
node scripts/awProd.mjs reconcile --suffix $SFX --entity CUSTOMERS --source-job <customers job id>
node scripts/awProd.mjs reconcile --suffix $SFX --entity CARRIERS  --source-job <carriers job id>
node scripts/awProd.mjs reconcile --suffix $SFX --entity AP        --source-job <ap-aging job id>
node scripts/awProd.mjs reconcile --suffix $SFX --entity AR        --source-job <ar job id> --customers-job <customers job id>
node scripts/awProd.mjs reconcile --suffix $SFX --entity SHIPMENTS --source-job <staged big export job id from 4c-0>
```
(= router action `IMPORT_RECONCILE_ENTITY`; the report job is an `AljexImportJob` of kind `RECONCILE` + files under `imports/runs/<id>/` in the files bucket.) Each prints Aljex rows / BCAT rows / matched / Aljex-only / BCAT-only / mismatched / differences, and money side by side. **Expect:** AR Aljex $357,753.44 vs BCAT $357,753.44 diff $0.00 (Danisco due-date differences listed as approved-type differences, amounts equal); AP $83,407.20 diff $0.00; customers matched 515 (+245 locations); carriers 2,442.
**Decisions:** Ryne/Jenny open Settings > Data > Aljex reconciliation (`/tms/brokerage/company/data/aljex-reconciliation`). Equality is NOT required: **Jenny only** (group `page-aljexSignoff`; ADMIN without the group is refused) sets each difference to *Open balance* or *Approved* (reason recorded: approver, time) then signs off. Sign-off of AR and SHIPMENTS marks the load reconciled.
**Writes:** `AljexImportJob` (RECONCILE kind) + `decisions` JSON + report files + `AuditLog`. **SAFE ABORT:** always safe (reports only). **Rollback:** delete the RECONCILE jobs (`AljexImportJob` items of kind RECONCILE) / re-run. **Log:** `$LOGS/reconcile-<entity>-<ts>.log`.

---

## Step 6: Post-load verification

1. **Counts per table vs expected** (`node scripts/awProd.mjs verify --suffix $SFX`: DescribeTable `ItemCount` for all 110 tables; refreshed about every 6 hours: use app counts or the importer's own report for same-hour exactness): Customer ≈ pre-existing + 515 − matched; Location + 245; Carrier ≈ 2,442; Shipment ≥ 958 + new; Load ≥ 958; CarrierBill 67; Invoice 296 (+ any invoices from the big export); ArPayment ≥ 3; ProClaim ≥ Shipments; AuditLog grows. 110 tables still present.
2. **Spot check 10 active shipments** from `aljex-active-shipments-2026-11-08.csv` (10 rows: OPEN, COVERED, DEPARTED 1/2, DELIVERED 2/2) end to end: for each PRO open the Shipment page and compare customer, carrier, customer and carrier rates, stops, status, the Load row (dispatch/calendar) and, if invoiced, the invoice; AP/AR rows tie. 99 of the 110 PROs across the AP/active files were in dev; the 11 newer ones must now exist (27 new loads in the 11-07 export) [VERIFIED docs].
3. **AR/AP totals to the cent:** AR open $357,753.44; AP open $83,407.20 (0-30 $66,642.20; 31-60 $16,765.00); AP expected as its own line $27,706.47 (24 rows). Compare in Finance > AR/AP aging and in the reconciliation money lines.
4. **Billing setup page** (Customers > Billing setup): header counts N factor / N manual / N not set = 479 / 36 / (≈10 flagged Missing).
5. **No outbound e-mail was sent** during the load:
   - `ShipmentMessage`/`ShipmentNotice` rows created since the load start: expect 0 new outbound; check via the app (Shipments > Messages) or `aws dynamodb scan --table-name ShipmentNotice-$SFX-NONE --select COUNT --filter-expression 'createdAt >= :t' --expression-attribute-values '{":t":{"S":"<load start ISO>"}}'` (COUNT only, no item data; this is a production READ of a table: allowed only as count, UNVERIFIED that `createdAt` is the right attribute).
   - SES: `aws sesv2 get-account` / CloudWatch SES `Send` metric for the window: expect 0 additional sends attributable to the load (production SES also sends normal ops mail: compare against a normal day): `aws cloudwatch get-metric-statistics --namespace AWS/SES --metric-name Send --start-time <load start> --end-time <now> --period 3600 --statistics Sum`.
   - FactoringItem count unchanged by the load (carried-over invoices never queue).
6. Existing functionality smoke: log in, open Dispatch, Calendar, Shipments (old `/loads` URLs redirect), Driver pay, Factoring queue (existing rows still render), Customers.
7. Reconciliation signed off by Jenny (step 5).

---

## Step 7: Go-live switches (what must stay OFF until Ryne says)

- **Old factoring e-mail bridge stays RUNNING** (ivanfactoring@ → Apps Script → `factoring-intake`) until Ryne confirms Aljex is fully cut over: do NOT disable or alter any intake mailbox [VERIFIED STEP_AW §1, answer 15].
- **No customer e-mail for factored customers**, ever (release pushes straight to the factoring queue; no e-mail). Carried-over invoices NEVER resend or re-queue (refused by Send/queue actions). Do not bulk "Mark sent"/"Send" anything carried-over.
- **Release to billing / Send invoice**: Jenny only (step 2). Do not grant anyone else.
- Aljex remains readable until the revert deadline **December 1** (Ryne round 2, #22).
- Settings > Integrations (admin) is where Ryne enters keys himself, **after the load, never during it**: MyCarrierPackets (+webhook), OPENAPI, GMAIL_REP_OAUTH (SSM `/bcat/integrations/us-east-1_IbPKPNJC9/<PROVIDER>`); DAT (provider entry may not exist yet: UNVERIFIED); `GOOGLE_MAPS_API_KEY` and `GEOCODE_TOKEN_SECRET` are Amplify secrets (`npx ampx secret set <NAME> --branch main`): setting them can trigger a redeploy: do it only after the load, with Ryne's go [VERIFIED AW_SECRETS_ENV_AUDIT §4].
- Nothing to flip for stage 4 (TTL) now.
- Final: record in the log folder the stop/go, the job ids, the live tags.

---

## Stop conditions (stop, do not proceed, report to Ryne with the numbers)

Tolerance for every documented count = **exact (0)** unless stated:
- Preflight: stack not `UPDATE_COMPLETE`; table count ≠ 110; stage ≠ 3; any Amplify job RUNNING; `BCAT_DEV_STACK` on main; fresh backup missing/ > 6 h; Jenny absent or duplicated; anyone but Jenny in either grant group.
- Customers: rows ≠ 761; customers+matched+enriched ≠ 515 (±0), Locations ≠ 245, factor/manual ≠ 479/36 by more than ±2 (explain each), flagged > 10, TEST CUSTOMER 100003 imported, a ZZ/test row imported, GUEST SUPPLY missing.
- Carriers: rows ≠ 2,462; carriers ≠ 2,442 (±0) or vendors skipped ≠ 19; any Fed/SS/Bank/Routing value anywhere in output.
- Loads: rows ≠ 8,347; AMBIGUOUS/CONFLICT > 0; backfill afterCutoff > 0 (Loads CREATED on/after the cutoff; `carriedOver` is informational, expected 17); ambiguous > 0; unmappable > 0; a Load count that DEcreases; gate refusal for "no reconciled rehearsal".
- AP: bills ≠ 67 or total ≠ $83,407.20; any `unresolved`; expected rows kept ≠ 24 or ≠ $27,706.47.
- AR: invoices ≠ 296 or total ≠ $357,753.44 (cent-exact); partial payments ≠ 3 / $3,450.00; unresolved PRO/customer > 0; any invoice or FactoringItem created that is not carried-over.
- Any email send, any 5xx/GraphQL error burst, any CloudFormation/Amplify deploy event, any throttling errors (pause 60 s, re-run: the checkpoints make it resumable; if the same error twice, stop).
- Any step prints a name, e-mail, tax ID, bank/routing or password.

## What to do on a CloudFormation/Amplify deploy during the load

**None. No deploys while loading.** Do not push to `main`, do not click Redeploy, do not set `BCAT_SCHEMA_STAGE`, do not run `ampx secret set`. If one starts anyway: stop applying, wait for SUCCEED/FAILED, re-run step 0, resume from the checkpoint (`<step>.checkpoint.json`). A failed deploy: follow AW_STAGED_DEPLOY.md "A stage failed" (never lower the stage).

## Whole-load rollback summary (per table)

| Step | Tables touched | Undo |
|---|---|---|
| 1 | TmsSettings, AuditLog | UpdateItem revert / restore row |
| 2 | Cognito groups, UserProfile | `admin-remove-user-from-group`; restore row |
| 4a | Customer, Location, AljexImportJob, AuditLog | restore from fresh backup (`restore-table-from-backup` → `-RESTORED`, diff, copy back) or delete by `importRunId` |
| 4b | Carrier (+CarrierPaymentMethod?), AljexImportJob, AuditLog | same (tables new in stage 1: empty them) |
| 4b-tax | CarrierTaxVault-<apiId>, Carrier mirror fields | `CLEAR_TAX_ID` / delete vault items |
| 4c, 4c-bis | Shipment, Order, Load (4 link fields), LoadCarrier, LoadFinancials, LoadCharge, Customer, Location, Carrier, Invoice, ArPayment, CarrierBill, ApPayment, ProClaim, TmsSettings, AuditLog, LegacyAljexRow | `importAljex.mjs rollback --run <applyJobId> --target prod:<tag> --i-mean-production`; or per-table restore from `prodpre-importAljex-*` backups; 60 pre-merge tables also from `2026-11-08-pre-aljex-migration/tables-main/<Model>.jsonl` (RESTORE.md path 2/3); Load: `REMOVE shipmentId, orderId, loadNumber, leg` |
| 4d | CarrierBill, LoadCarrier, AljexImportJob, AuditLog | restore/empty by `importRunId` |
| 4e | LoadCarrier (apStatus), AljexImportJob, AuditLog | restore LoadCarrier |
| 4f | Invoice, ArPayment, Order (invoice link), AljexImportJob, AuditLog | restore/empty |
| 5 | AljexImportJob (RECONCILE) | delete jobs |
Files bucket is not written by any step except reports under `imports/runs/` and `imports/source/` (DataSafety area): RESTORE.md path 4 (`aws s3 sync` back) only if needed.
Restores always create a NEW table (`-RESTORED`); compare, then copy back or swap: never overwrite a live table in place without a diff. A full revert of production code is Ryne's decision (RESTORE.md path 1).

## Reconcile-with-ProdWrapper notes (open)
- `awProd.mjs` names used here are ProdWrapper's final surface: settings, jenny, backfill, customers, carriers, ap-aging, ap-expected, ar, stage-export, loads, tax-ids, reconcile, verify. Missing from the wrapper (done by UI/other scripts here): Settings 1b, ownership seed, prodBackup for `prodpre-importAljex-*`, active-check.
- Items asked of ProdWrapper: print backfill afterCutoff count; refuse/warn `backfill --apply` before `loads`.

## awProd.mjs behaviour (final, from ProdWrapper; supersedes any conflicting line above)
- customers/carriers/ap-aging/ap-expected/ar/stage-export: the DEFAULT dry run is LOCAL ONLY (parses the file, prints row counts and stripped columns; no login, no upload). Add `--plan` to log in (BCAT_EMAIL/BCAT_PASSWORD) and run the Lambda PLAN (writes one AljexImportJob row + one S3 object, no business table): THIS is the dry run whose numbers you compare to "Expect" before `--apply --live-tag TAG` (which does PLAN then APPLY). Re-applying the same file is skipped via the checkpoint.
- backfill: logs beforeWindow/afterCutoff/carriedOver and a loud WARNING if afterCutoff>0 (Loads created on/after the cutoff: stop condition; `carriedOver` = booked before the cutoff, shipping after it: informational). `--evaluate` logs in and runs the BACKFILL_SHIPMENT dry run to list refusals. `--apply` is REFUSED while the Shipment table is empty (override `--allow-empty-shipments`: NEVER use it): run `loads` first.
- Confirm token: `AW_PROD_CONFIRM=$(date +%F)-<step>`, e.g. `AW_PROD_CONFIRM=$(date +%F)-loads`.
- Resume after a crash: re-run the same command (checkpoint); `--fresh` ignores the checkpoint.
- `tax-ids` dry run prints counts and how many rows resolve to a carrier. `verify` prints table count vs 110, per-table ItemCount, series/Jenny/vault flags.
- The UI settings (SAVE_AR_SETTINGS, divisionSalesReps, ENSURE_OWNERSHIP_SEED) are NOT wrapped: step 1b stays UI.
