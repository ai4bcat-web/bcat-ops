# AW: reconciled production rehearsal on COPIES of the production tables

Purpose: the LIVE Aljex loads apply refuses real data unless a REHEARSAL job exists with status APPLIED, the same `stageHash`
and `profileVersion`, and `options.reconciled=true` (`runSlice.applyGuards`, unchanged). This runs that rehearsal against
`<Model>-5ucwdyvwivelbo4k4jomvrwel4-NONE-rh<tag>` copies of the 17 written production tables. No live data table is written.

## Where the rehearsal job row lives (read this first)

The offline CLI never writes job rows to the production `AljexImportJob` table: `AwsCliStore` keeps every job in the
local job book `os.tmpdir()/aljex-cli-jobs.json` (macOS: `$TMPDIR/aljex-cli-jobs.json`), and `applyGuards` scans that same
book (`store.scanAll('aljexImportJob')`). So the REHEARSAL job written by `run --target prod-rehearsal:<tag>` is found by the later
`run --target prod:<liveTag> --apply` **on the same machine and user** with no production write at all.
Consequences: run both steps from the same laptop/user; do not delete that file between them; nothing needs cleaning up in DynamoDB.
(`reconcile-entity --apply` is the only CLI path that writes a job row to the production table; it is not used here.)

Everything else a REHEARSAL run writes goes to the `-rh` copies (all 17 written tables, including AuditLog, TmsSettings counters,
ProClaim) or to the local run directory (`os.tmpdir()/aljex-run-aljexrun-*`: report objects, 0600). Reference tables
(AljexMappingProfile, Driver, UserProfile, Division, ...) are read from production, never written.

## Tag and backups

Tag `rhprod` (3-12 lowercase letters/digits; the tables become `...-NONE-rhrhprod`). Use the same tag for every command; `--tag`
must equal the target's tag or the wrapper refuses.

Restore source defaults to the newest AVAILABLE `prodpre-importAljex-*` on-demand backup per table. CHECK THE PRINTED COUNTS: on
2026-11-08 the newest `prodpre-importAljex-20261108T142330` set (08:23 CST) holds Customer 126 / Location 201 / Carrier 0, while live
production held Customer 641 / Location 420 / Carrier 1106 and the `mid-load-2026-11-08-main-*` set (12:59 CST) holds Customer 641 /
Location 420 / Carrier 2442. If the copies must mirror current production, restore from the later set with
`--backup-prefix mid-load-2026-11-08-main-` (any AVAILABLE on-demand backup of the production table with that name prefix; still restored
only into NEW `-rh` tables). Take a fresh `prodpre-importAljex-*` set (`node scripts/prodBackup.mjs ...`) right before if production
changed since.

## Commands, in order

Every command needs `BCAT_ALLOW_PROD=$(date +%F)` and `--i-mean-production`; without `--apply` each one is a dry run that prints a plan.
`--apply` asks for the typed confirmation `273354631837:5ucwdyvwivelbo4k4jomvrwel4-NONE` (or `--confirm-prod <same>`).

```bash
export BCAT_ALLOW_PROD=$(date +%F)
T=rhprod
SRC=/Users/adminoid/aljex-export/aljex-full-export-2026-11-07.csv
M="--target prod-rehearsal:$T --i-mean-production"

# 1. dry run: prints the backup chosen per table (name, time, age, item count) and the new -rh table names. Reads backup metadata only.
node scripts/importAljex.mjs rehearsal-create --tag $T $M [--backup-prefix mid-load-2026-11-08-main-]
# 2. restore the 17 copies, wait ACTIVE, verify every copy's item count (Scan COUNT) equals the backup's. Refuses if any -rh table exists (--reuse keeps existing ones).
node scripts/importAljex.mjs rehearsal-create --tag $T $M [--backup-prefix ...] --apply
# 3. plan only on the copies (stage + plan, prints entity counts)
node scripts/importAljex.mjs run --source $SRC $M
# 4. stage + plan + APPLY + reconcile on the copies; the printed line must say "reconciled YES" and exit code 0
node scripts/importAljex.mjs run --source $SRC $M --apply
# 5. verify the REHEARSAL job in the local job book
jq '.[] | select(.target=="REHEARSAL") | {id,status,stageHash,profileVersion,options}' "${TMPDIR:-/tmp}/aljex-cli-jobs.json"
#    expect: id aljexrun:<stamp>A, status APPLIED, options.reconciled true; stageHash/profileVersion equal the LIVE PLAN's
# 6. LIVE loads apply (lead/Ryne; unchanged production gate): node scripts/importAljex.mjs run --source $SRC --target prod:<liveTag> --i-mean-production [--apply]
# 7. drop the copies (dry run lists them; --apply deletes ONLY the -rh$T tables; live tables and backups are never touched)
node scripts/importAljex.mjs rehearsal-drop --tag $T $M
node scripts/importAljex.mjs rehearsal-drop --tag $T $M --apply
```

`resume --run <jobId> --target prod-rehearsal:$T --i-mean-production --apply` continues an interrupted step 4 (same local job book).
Only `run | resume | rehearsal-create | rehearsal-drop` are accepted with `prod-rehearsal`; `--memory`, `--prod-mode-rehearsal-suffix`
and `seed-counter`/`rollback`/`file`/`stage` are refused.

## Guarantees enforced in code (`engine/tables.ts`, `engine/cli.ts`)

- `productionRehearsalPolicy(tag)` exists only behind the wrapper gate. `assertTargets` accepts it only for a REHEARSAL job tagged
  `<tag>` whose written tables are exactly the `-rh<tag>` siblings of the 17 production tables and whose every other table is the
  production table. A LIVE job, another tag, a live written table, a dev suffix or a mixed stack is refused.
- The plain `productionPolicy` is unchanged (LIVE jobs on exactly the production tables; REHEARSAL jobs and `-rh` tables refused).
- `rehearsal-drop` only ever names `<live>-rh<tag>` tables built from the 17 models and never calls DeleteBackup.

## Time estimates (estimates, not measured)

Restore of 17 small tables: about 5 to 15 minutes (parallel, bounded by the largest); count verification: under a minute at
current sizes (AuditLog about 20k items). Stage + plan of the 2026-11-07 export: minutes; APPLY at the engine's observed dev
rates: tens of minutes. Drop: under a minute. Copies cost on-demand storage only while they exist.

## Expected counts

Restored copies equal the printed backup item counts (step 2 fails otherwise). After step 4 the copies hold the file's loads
(Shipment/Order/Load/LoadCarrier/LoadFinancials/LoadCharge/Invoice/CarrierBill/payments...), and the reconcile bridge must
show 0 difference per line with conservation OK. The live PLAN's entity counts should match step 3's except for customers,
carriers and locations that the copies already contained (matched/enriched rather than created) if the backup set differs from
current production.

## Rollback

- Before the live apply nothing in production changed: `rehearsal-drop ... --apply` removes every copy.
- The local job book is the only other artifact: `rm "${TMPDIR:-/tmp}/aljex-cli-jobs.json"` (this also removes the reconciled
  rehearsal evidence, so the live guard will refuse again) and `rm -rf "${TMPDIR:-/tmp}"/aljex-run-aljexrun-*` for report files.
- If a restore stops half way: `rehearsal-drop --apply`, then `rehearsal-create --apply` again.
