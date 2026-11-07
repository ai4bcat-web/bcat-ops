# GO / NO-GO checklist for the Monday 2026-11-09 merge (Step AW)

Owner: lead agent. Updated after every stage. Ryne decides at the Sunday-evening checkpoint. The real merge to `main`
and the GSI prep deploy happen ONLY on Ryne's explicit go, with a fresh backup taken right before.
Status: OPEN / IN PROGRESS / PASS / FAIL / AT RISK. Evidence = a file, a log line or a job number.

| # | Criterion (from Ryne, round 2) | Status | Evidence / note |
|---|---|---|---|
| 1 | Full test suite and build green on the merged tree | PASS (stage A) | 844 files / 10,420 tests, build ok, commit 51c769c |
| 2 | MERGE_REGRESSION gaps all covered (tests or scripted live checks) | OPEN | 10 gaps + 30 partial listed in MERGE_REGRESSION.md |
| 3 | Rehearsal regression run clean (full copy of production, fresh data) | RED (blocked by #13) | the merged tree does NOT deploy to a stack in one update (see #13); rehearsal will be rebuilt through the staged path |
| 4 | Schema diff has no blockers; data stack under the cap | PASS (stage A), recheck after C/D/E | AW_SCHEMA_DIFF.md: no blockers; 968,579 / 1,000,000 B, 460/500 |
| 5 | Required production secrets present | PASS (stage A) | AW_SECRETS_ENV_AUDIT.md: none fail the deploy; degrade-only list |
| 6 | AR / AP / customer / carrier reconciliation done, every difference matched or approved | OPEN | stage E |
| 7 | Jenny@bcatcorp.com login works for Release to billing, Send invoice, reconciliation sign-off | OPEN | stage D |
| 8 | Fresh backup taken and verified right before the real merge | OPEN | rerun the 2026-11-08 procedure under a new stamp |
| 9 | Load -> Shipment backfill dry-run clean (PRO-first, ID fallback), no unmappable/ambiguous unexplained | OPEN | stage C |
| 10 | Billing method set for every active customer (or listed for Ryne); factor/manual paths tested | OPEN | stage D |
| 11 | Numbering starts at 20000 (PRO = invoice number) | OPEN | wired in stage C/D; scope confirmed round 2 |
| 12 | BCAT blue palette on dev styling, AA contrast, before/after screenshots for Ryne | IN PROGRESS | stage F |
| 13 | The merged schema deploys to a production-shaped stack (P4) | RED: FAILS in one deploy | Rehearsal job 3 (baseline 60-model stack -> merged tree, one update) failed: CloudFormation 'Limit on the number of resources in a single stack operation exceeded' (cap 2,500 created/updated/deleted per operation across nested stacks); rollback then stuck (UPDATE_ROLLBACK_FAILED) on TruckLocationHistory TTL cooldown. A fresh create of the merged stack fails the same way (job 1). Fix in progress: BCAT_SCHEMA_STAGE staged deploy (Docs/tms-build/AW_STAGED_DEPLOY.md), Load +3 GSIs and AuditLog +1 each in their own stage, TruckLocationHistory TTL alone in the last stage. The real merge to main MUST NOT be a single push. |
| 14 | Final delta import (loads, customers, carriers, AR, AP changed in Aljex since the snapshot) | OPEN | from fresh Aljex exports Sunday night / Monday early |
| 15 | Old factoring bridge and intake mailboxes untouched and still running | PASS (never touched) | rules honoured |

## Risks for Monday (kept current)
- **BLOCKER (stage B):** one-shot deploy of the merged schema fails (above). The real merge becomes a sequence of N Amplify deploys (~15-25 min each); the stage count and per-stage delta come from the staged-deploy work. Tell the operator preparing the GSI prep push on main: do not merge in one push; do not change TruckLocationHistory TTL in the same deploy as anything else.
- Carrier.einNumber stores carrier tax IDs in clear today on dev (readable by all staff); the encrypted-vault design (AW_TAXID_DESIGN.md) removes it. Carrier is not on production, so not a CloudFormation blocker.
- Fresh CloudFormation create of the full merged stack failed on 'Limit on the number of resources in a single stack operation' (rehearsal job 1). The real merge is an UPDATE of the production stack (60 -> 109 models); the rehearsal tests exactly that (baseline stack then merged update). Result: see BUILD_LOG Step AW stage B.
