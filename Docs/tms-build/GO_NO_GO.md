# GO / NO-GO checklist for the Monday 2026-11-09 merge (Step AW)

Owner: lead agent. Updated after every stage. Ryne decides at the Sunday-evening checkpoint. The real merge to `main`
and the GSI prep deploy happen ONLY on Ryne's explicit go, with a fresh backup taken right before.
Status: OPEN / IN PROGRESS / PASS / FAIL / AT RISK. Evidence = a file, a log line or a job number.

| # | Criterion (from Ryne, round 2) | Status | Evidence / note |
|---|---|---|---|
| 1 | Full test suite and build green on the merged tree | PASS (latest tree) | 920 files / 11,074 tests, tsc x3, eslint 0 warnings, build, stageDeployCheck OK; commit 5f45cf75 |
| 2 | MERGE_REGRESSION gaps all covered (tests or scripted live checks) | MOSTLY COVERED | gap tests added: driver-app routes, pay golden, factoring bridge identity, 15 Lambda smokes, 16 page renders, merge-surface guard (MERGE_REGRESSION.md statuses to be refreshed after the live run) |
| 3 | Rehearsal regression run clean (full copy of production, fresh data) | IN PROGRESS | rehearsal2: baseline job 2 SUCCEED, stage 0 job 3 SUCCEED (42 min), stages 1..4 (scripts/stageRun.sh; PITR is no longer a stage, incident 2026-11-07, see AW_STAGED_DEPLOY.md); then prod-data load + devVerifyAW/devVerifyProdPages |
| 4 | Schema diff has no blockers; data stack under the cap | PASS | AW_SCHEMA_DIFF.md no blockers; data stack 968,472 B / 460 (cap 1,000,000 / 500) after tax vault, AR, billing fields |
| 5 | Required production secrets present | PASS (stage A) | AW_SECRETS_ENV_AUDIT.md: none fail the deploy; degrade-only list |
| 6 | AR / AP / customer / carrier reconciliation done, every difference matched or approved | OPEN | stage E |
| 7 | Jenny@bcatcorp.com login works for Release to billing, Send invoice, reconciliation sign-off | OPEN | stage D |
| 8 | Fresh backup taken and verified right before the real merge | OPEN | rerun the 2026-11-08 procedure under a new stamp |
| 9 | Load -> Shipment backfill dry-run clean (PRO-first, ID fallback), no unmappable/ambiguous unexplained | OPEN | stage C |
| 10 | Billing method set for every active customer (or listed for Ryne); factor/manual paths tested | OPEN | stage D |
| 11 | Numbering starts at 20000 (PRO = invoice number) | BUILT, NOT APPLIED | scripts/seedSeries20000.mjs (PRO = invoice number, counter floor 20000) dry-run default, refuses production; applied at cutover only |
| 12 | BCAT blue palette on dev styling, AA contrast, before/after screenshots for Ryne | BUILT; AFTER shots pending | BCAT blue (#0369a1 light / #1ea8f3 dark), contrast check passes, before shots captured; after shots once dev deploy lands |
| 13 | The merged schema deploys to a production-shaped stack (P4) | RED -> staged plan proven in part | one-shot deploy FAILS (rehearsal jobs 1 and 3). Staged path BCAT_SCHEMA_STAGE 0..4 (stage deltas in AW_STAGED_DEPLOY.md; the old PITR stage was removed after the production incident 2026-11-07): baseline->stage 0 SUCCEED on the rehearsal (42 min); stages 1-4 to be re-run on the new numbering. Production needs 5 deploys (+ GSI prep) each ~15-45 min |
| 14 | Final delta import (loads, customers, carriers, AR, AP changed in Aljex since the snapshot) | OPEN | from fresh Aljex exports Sunday night / Monday early |
| 15 | Old factoring bridge and intake mailboxes untouched and still running | PASS (never touched) | rules honoured |

## Built in this stage batch (Sat 11-07 evening)
- C: PRO-first link (importer LINK class), awBackfillShipments dry-run CLI, /loads redirects, projector mirror, division + sales-rep rules, numbering-20000 script (not applied).
- D: billing method on Customer, Billing setup page, RELEASE_TO_BILLING / SEND_INVOICE / SYNC_FACTORING_CHANGE, always-copy invoices@, Jenny-only grants (page-billingRelease / page-aljexSignoff, no role bypass incl. ADMIN/owner; scripts/grantJenny.mjs fails loudly if absent), post-invoice reason + timeline, Possible-duplicate badges.
- E: importers (customers, carriers, AP aging, AP expected, AR with Danisco 120-day redate, active-shipments check) wired to router/CLI/wizard (scripts/awImport.mjs, AW_IMPORT_RUNBOOK.md), reconciliation page with open-balance/approve and Jenny-only sign-off, Settings > Integrations deployment-secrets card, encrypted carrier tax-ID vault (AW_TAXID_BUILD.md).
- F: BCAT blue palette (AW_PALETTE.md).

## Risks for Monday (kept current)
- **Production deploy time:** stage 0 took 42 min on the rehearsal (baseline -> merged tree). Five staged deploys (stages 0..4) plus the GSI prep will take roughly 2.5-3.5 hours of wall clock, one Ryne go each. Earliest Monday-safe window: start the staged sequence before 04:00 CST Monday; the Aljex data loads (customers/carriers/AR/AP/loads) and reconciliation come after stage 3 (Invoice, CarrierBill, Shipment tables exist only from stages 2-3).
- Per-file import actions run inside the AppSync request (30 s): the carriers file (2,462 rows) must use the CLI direct-Lambda path (scripts/awImport.mjs), not the browser wizard.
- **BLOCKER (stage B):** one-shot deploy of the merged schema fails (above). The real merge becomes a sequence of N Amplify deploys (~15-25 min each); the stage count and per-stage delta come from the staged-deploy work. Tell the operator preparing the GSI prep push on main: do not merge in one push; do not change TruckLocationHistory TTL in the same deploy as anything else.
- Carrier.einNumber stores carrier tax IDs in clear today on dev (readable by all staff); the encrypted-vault design (AW_TAXID_DESIGN.md) removes it. Carrier is not on production, so not a CloudFormation blocker.
- Fresh CloudFormation create of the full merged stack failed on 'Limit on the number of resources in a single stack operation' (rehearsal job 1). The real merge is an UPDATE of the production stack (60 -> 109 models); the rehearsal tests exactly that (baseline stack then merged update). Result: see BUILD_LOG Step AW stage B.
