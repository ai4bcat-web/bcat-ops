# Staged schema deploy (Step AW)

Going from the 60-model production shape to the merged 109-model tree in ONE Amplify release fails:
CloudFormation refuses a stack operation that creates, updates or deletes more than 2,500 resources
across the nested stacks ("Limit on the number of resources in a single stack operation exceeded").
The rehearsal hit it. The schema therefore deploys in five releases (stages 0..4), driven by one branch environment
variable, `BCAT_SCHEMA_STAGE`.

> ## WARNING: NEVER LOWER `BCAT_SCHEMA_STAGE` ON A DEPLOYED STACK
>
> A lower stage no longer contains the models the higher stage created. CloudFormation then DELETES
> those tables and their data (the tables are not retained). The synth cannot know what is deployed,
> so there is no guard in code: the operator is the guard.
> After a FAILED stage k, leave the variable at k and fix forward (see "A stage failed"). Do not "go
> back to k-1". To return to a working state, re-run stage k (or raise it) only.

## How the variable works

- Unset, empty, or `>= 4`: the WHOLE schema. Dev and every deploy that does not set it are unchanged
  (verified: data stack 968,516 B / 460 resources in `--prod-shape`).
- `0..3`: that stage. A non-integer value fails the synth loudly.
- Code: `amplify/data/stages.ts` (the stage table), `amplify/data/resource.ts` (filters the model set;
  the authored schema and the `Schema` type stay whole, so the frontend build is identical at every
  stage), `amplify/backend.ts` (every wiring of a model not in the current stage is skipped).
- Lambdas deploy at stage 0 with the table environment variables / IAM statements of absent models
  simply missing; a handler that needs one fails only that action. (No handler reads a table name at
  module load in a way that throws: checked by importing every `amplify/functions/*/handler.ts` with an
  empty environment.) Routers that use `DATA_TABLE_SUFFIX` derive every table name from the suffix, so
  they point at a not-yet-existing table until its stage lands and fail only on that action.
- The frontend ships the same code at every stage. Pages for models not yet deployed are dormant
  (their GraphQL fields do not exist yet) until the stage that creates them.
- Point-in-time recovery is NOT a stage and is not driven by `BCAT_SCHEMA_STAGE` (see "PITR (deferred,
  not part of the cutover)").

## Stage table (resources = created + updated + deleted, measured)

Measured by `node scripts/stageDeployCheck.mjs --baseline-ref 17f71c3e` (prod-shape synth; `17f71c3e` is
production's shape BEFORE the stage 0 merge PR: once the merge is on `origin/main`, `origin/main` is no
longer a production-shape baseline, so pass the pre-merge SHA). Method: synthesize every stage; for each
stage compare every `*.template.json` (root stack and all nested stacks) with the previous stage, resource
by resource (logical id, properties compared as canonical JSON); a resource in a new nested stack is
created, one whose properties differ is updated, one that vanished is deleted. The limit enforced is
1,500 per stage (the cap is 2,500; 40% margin).

| Stage | What it deploys | created | updated | deleted | TOTAL |
|---|---|---|---|---|---|
| 0 | Production models + 244 additive fields on 9 existing models (Load +50, Customer +51, Location +1, Division +11, TmsSettings +116, FactoringItem +4, VendorPayable +3, TruckConfig +2, TruckLocationHistory +6) + the new Lambdas / custom operations (no new tables, no table change) | 147 | 245 | 25 | 417 |
| 1 | 21 models: Carrier, CarrierContact, CarrierPaymentMethod, CarrierDocument, CompanyPhone, OwnershipDivision, OwnershipRule, ShipmentView, ShipmentColumnTemplate, UserProfile, Commission, CommissionPayPeriod, Integration, SpotSettings, GmailConnection, SpotRequest, ApInboxItem, CrmContact, CrmDomain, CrmActivity, CrmAccount (+ the TaxVault stack) | 574 | 27 | 0 | 601 |
| 2 | 14 models, the shipment core: ProClaim, IntakeLoad, Shipment, Order, LoadCarrier, LoadFinancials, LoadCharge, LoadCheckCall, TrackingLink, ShipmentDocument, ShipmentNotice, ShipmentPosting, ShipmentMessage, Quote | 496 | 38 | 0 | 534 |
| 3 | 14 models: Invoice, ArPayment, CarrierBill, ApPayment, ImportJob, AljexImportJob, AljexMappingProfile, LegacyAljexRow, AljexCodeMap, DataExportJob, WorkflowRun, DemoRecord, LaneRateSample, DashboardRollup (+ their stream mappings / schedule; deletes the old vendor-ap-extract Lambda) | 438 | 23 | 3 | 464 |
| 4 | TruckLocationHistory TTL (`ttlEpoch`), ALONE | 0 | 3 | 0 | 3 |

(The numbers are re-measured by the script; stage 4 equals "unset".) A model nobody listed in
`MODEL_STAGE` lands in stage 3, never stage 4. Adding a field to any model needs no stage edit: a field
on an existing model rides in stage 0, a field on a new model rides with its model.

Rules `stageDeployCheck.mjs` enforces on every stage: the GraphQL schema is a strict superset of the
previous stage; at most 1,500 resources changed; at most one new GSI per existing table; an existing
table changes only in the TTL stage (and that stage changes nothing but TruckLocationHistory); NO stage
ever deletes a DynamoDB table (`AWS::DynamoDB::Table` / `Custom::AmplifyDynamoDBTable`), not even through
the allow-lists below; the staged-out sentinel never reaches a template.

### Stage 0 deletes 25 resources, on purpose

All are API resolvers or one Lambda, no table, no data: the Load `deleteLoad` mutation and `onDeleteLoad`
subscription (a PRO is permanent), the client create/update/delete mutations on TruckLocationHistory
(only Lambdas write it). `stageDeployCheck.mjs` allows exactly these and fails on any other deletion.

### Triggers wait for their tables; the old vendor extractor waits for WorkflowRun

- Lambdas are deployed at stage 0, but a schedule that reads a table would fail on every run until the table
  exists, so each is created only at the stage that creates its tables (`TRIGGER_MODELS`/`triggerEnabled` in
  `amplify/data/stages.ts`): McpSync and SpotQuoterPoll rules at stage 1, the tracking-automation Scheduler
  schedule at stage 2, WorkflowAgentSweep and the two DataSafety rules at stage 3. Stage 0 creates only the
  harmless ApInboxHourly rule, the check-call-notifier schedule and two Load-stream mappings.
- `vendor-ap-extract` (production's invoice extractor) is NOT deleted at stage 0: `vendor-ap-intake` keeps
  invoking it with `{ id }` exactly as today. Stage 3 (which creates WorkflowRun, what `workflow-agent` needs)
  repoints the intake at `workflow-agent` (`VENDOR_AP_EXTRACT_TARGET=workflow-agent`, run hand-off payload) and
  deletes the old Lambda, role and policy (3 resources, the only deletion allowed outside stage 0; the checker
  permits it at `VENDOR_AP_EXTRACT_RETIRED_STAGE` only). "Stage k is a superset of stage k-1" is checked on the
  data model only; this one deliberate non-data removal is therefore listed here. Never lower the stage below 3
  afterwards: the old Lambda would not come back with its production name.
- The TaxVault stack (`CarrierTaxVault` table, two KMS keys) is created at stage 1 (`TAX_VAULT_STAGE` in
  `amplify/backend.ts`), with the Carrier model it serves.

### Why these boundaries

- GSIs: Load (`shipmentId`, `status`, `checkCallOpen`+`nextCheckCallAt`) and AuditLog (`entityType`+
  `entityId`) are NOT a step here. They deployed first from `feat/gsi-prep` (see
  `Docs/tms-build/GSI_DEPLOY_SEQUENCE.md`) and are part of the stage 0 shape. If they are not live yet,
  `stageDeployCheck.mjs` fails ("gains N GSIs") on the stage 0 step; do not start stage 0 until they are.
  DynamoDB builds one GSI per table per update; stage 0 must not add any.
- TTL (stage 4): DynamoDB allows one TTL change per table per hour. A stage that fails AFTER this change
  cannot roll back cleanly (UPDATE_ROLLBACK_FAILED; the rehearsal got stuck exactly this way), so it is
  the only change in its stage and the last one. The script fails if anything else changes in it.
- Any other change to an existing production table (billing mode, streams, deletion policy, point-in-time
  recovery) would be a stage of its own. There is none today; the script fails if an existing table
  changes in any stage other than 4.

## Before you start

```sh
git checkout <the branch Amplify builds>            # the merged tree, with the stage mechanism
node scripts/stageDeployCheck.mjs --baseline-ref 17f71c3e   # the pre-merge production shape
```
It must print `OK`. It takes about 3 to 7 minutes, synthesizes only and writes nothing to AWS. Keep
`--jobs 1` (parallel synths in one checkout collide in `amplify/.amplify/layers`).

Also: the GSI prep is deployed and ACTIVE (`aws dynamodb describe-table --table-name Load-<apiId>-NONE
--query 'Table.GlobalSecondaryIndexes[].[IndexName,IndexStatus]'`), and no other release is running.

## Operator procedure (one stage at a time, one Amplify deploy at a time)

Stages are 0, 1, 2, 3, 4. Production (`main`) sets ONLY `BCAT_SCHEMA_STAGE`: never `BCAT_ENABLE_PITR`,
never `BCAT_DEV_STACK`. A staged REHEARSAL branch (dev-stack flavoured) sets `BCAT_ENABLE_PITR=false` so
that its templates mirror production (`scripts/rehearsalSequence.sh` does this when it creates the branch).

Set once per shell. `rehearsal` first, then the real branch.

```sh
APP=d3dejqzs77khq6
BRANCH=rehearsal            # then: main (production)
```

`update-branch --environment-variables` REPLACES the whole map. Always read it, change only
`BCAT_SCHEMA_STAGE`, and write the full map back:

```sh
set_stage() {   # usage: set_stage K
  VARS=$(aws amplify get-branch --app-id "$APP" --branch-name "$BRANCH" \
    --query 'branch.environmentVariables' --output json \
    | jq -c --arg k "$1" '. + {BCAT_SCHEMA_STAGE: $k}')
  echo "env vars after: $(echo "$VARS" | jq -c 'keys')"      # eyeball: nothing lost
  aws amplify update-branch --app-id "$APP" --branch-name "$BRANCH" \
    --environment-variables "$(echo "$VARS" | jq -r 'to_entries|map("\(.key)=\(.value)")|join(",")')" >/dev/null
}
# (a value containing a comma breaks the key=value list: stop and edit the map by hand in that case)

run_stage() {   # usage: run_stage K
  set_stage "$1"
  JOB=$(aws amplify start-job --app-id "$APP" --branch-name "$BRANCH" --job-type RELEASE \
    --query 'jobSummary.jobId' --output text)
  echo "stage $1: job $JOB"
  while :; do
    S=$(aws amplify get-job --app-id "$APP" --branch-name "$BRANCH" --job-id "$JOB" \
      --query 'job.summary.status' --output text)
    echo "$(date +%T) $S"
    case "$S" in SUCCEED) break ;; FAILED|CANCELLED) echo "STAGE $1 $S: STOP, do not lower the stage"; return 1 ;; esac
    sleep 30
  done
}

run_stage 0     # check, then:
run_stage 1     # check, then 2, 3, 4
```

Expected time per stage: 15 to 30 minutes for the Amplify build plus the CloudFormation update
[INFERENCE from deploy history, not measured here; record the real numbers from the rehearsal]. Stages 1
to 3 create 14 to 21 tables each (the TaxVault stack rides with stage 1). A stage must reach SUCCEED before
the next starts.

### Check between stages

1. Job SUCCEED; the CloudFormation root stack `amplify-<appId>-<branch>-branch-*` is `UPDATE_COMPLETE`
   (also the nested stacks): `aws cloudformation describe-stacks --stack-name <root> --query 'Stacks[0].StackStatus'`.
2. Tables exist: count them (`aws dynamodb list-tables --query 'length(TableNames)'`) and compare with the
   stage (60 production tables at stage 0; +21 after stage 1, +14 after stage 2, +14 after stage 3).
3. Stage 4 only: `aws dynamodb describe-time-to-live --table-name TruckLocationHistory-<apiId>-NONE`
   shows `ENABLED` on `ttlEpoch` (the status passes through ENABLING).
4. Smoke the live app on the existing pages (drivers, loads, dispatch). After stages 1 to 3 the pages for
   the new models start working; before their stage they are dormant, not broken.
5. Do not start the next stage until the previous TTL/GSI state is settled (`describe-table` ACTIVE).

### A stage failed

- Do NOT set a lower `BCAT_SCHEMA_STAGE`. A lower stage would delete models and data.
- Read the failure: `aws cloudformation describe-stack-events` on the failing nested stack (first
  `*_FAILED` event). Fix the cause on the branch (code or configuration), then re-run the SAME stage
  (`run_stage k`) : the update continues from the rolled-back state.
- If the stack is `UPDATE_ROLLBACK_FAILED`: continue the rollback
  (`aws cloudformation continue-update-rollback --stack-name <root> [--resources-to-skip ...]`), then
  re-run the same stage. The known causes are a second TTL change on TruckLocationHistory inside one hour
  (with stage 4 isolated this cannot arise from another stage) and the throttled PITR flip of the incident
  below (no longer possible: PITR is not a stage). If stage 4 itself fails after the TTL change, wait 70
  minutes before retrying anything that touches that table.
- Only after the fix is the same stage re-run; only after SUCCEED go on.

### Prerequisites and caveats

- Stage 0 assumes the GSI prep (`feat/gsi-prep`) is already deployed. Without it stage 0 would add 3
  GSIs to Load in one update, which DynamoDB refuses.
- Stages 2 and 3 could merge (998): that is within the limit but halves the margin for failure isolation.
  Stage 1 + 2 (1,135) would also fit, with a thin margin.
- The dev branch is unset and always deploys the whole schema (with `BCAT_DEV_STACK=true` that includes
  point-in-time recovery on every table, as before).

## PITR (deferred, not part of the cutover)

Point-in-time recovery is not required for the cutover: on-demand backups exist and are the safety net
(Ryne's decision, 2026-11-07). It used to be stage 1 (see the incident below), and it is gone from the
stage table.

How it is wired now (`pitrEnabled(env, stage)` in `amplify/data/stages.ts`, used in `amplify/backend.ts`):
`table.pointInTimeRecoveryEnabled = true` runs ONLY when `BCAT_ENABLE_PITR=true`, or when
`BCAT_ENABLE_PITR` is not `false` AND `BCAT_DEV_STACK=true` AND the stage is the final one.

| Environment | Result |
|---|---|
| production `main` (no env var) | never flips PITR. Stage 0 shape is unchanged: the 60 deployed tables keep their existing conditional (`Fn::If`) form. Tables created at stages 1 to 3 are created WITHOUT the PITR flag |
| dev (`BCAT_DEV_STACK=true`, stage unset or final) | on, byte-equivalent to today's unstaged template |
| staged rehearsal (`BCAT_DEV_STACK=true`, `BCAT_ENABLE_PITR=false`) | off at every stage, mirroring production |
| `BCAT_ENABLE_PITR=true` | on, at any stage |

Consequence to know about: on production the tables created at stages 1 to 3 have no PITR (the 60 existing
ones have none either today). The DataSafety nightly export skips tables without PITR
(`SKIPPED_NO_PITR`), so until PITR is enabled the nightly exports do not run on production. Restore
relies on on-demand backups.

How to enable it later, safely (after the cutover, when nothing else is deploying): do NOT let
CloudFormation flip 60 tables at once (that is exactly what throttled).

1. Enable it one table at a time with the CLI, with a pause so `UpdateContinuousBackups` is never throttled:

   ```sh
   for T in $(aws dynamodb list-tables --query 'TableNames[]' --output text); do
     case "$T" in *-<apiId>-NONE) ;; *) continue ;; esac     # only this app's tables
     aws dynamodb update-continuous-backups --table-name "$T" \
       --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null && echo "$T on"
     sleep 5
   done
   ```
   Verify: `aws dynamodb describe-continuous-backups --table-name Load-<apiId>-NONE` shows
   `PointInTimeRecoveryStatus: ENABLED` (check every table, retry the ones that failed).
2. THEN set `BCAT_ENABLE_PITR=true` on the branch (add it to the full env map, as in `set_stage`) and
   deploy once. The custom resource then finds PITR already enabled on every table, so it has no work to
   throttle on.

Or leave it off. Never put the flip back into a schema stage.

## Stage 1 incident 2026-11-07

What happened. Amplify `main` job 715 ran `BCAT_SCHEMA_STAGE=1`, which was then the PITR flip: the
`pointInTimeRecoverySpecification` change on all 60 existing tables in one CloudFormation update. The
`Custom::AmplifyDynamoDBTable` handlers called `UpdateContinuousBackups` for all 60 tables in parallel
and were throttled: `Rate exceeded`. The rollback ran the same 60 calls again, failed the same way, and
the stacks ended `UPDATE_ROLLBACK_FAILED`: the root stack and the nested data stacks. Production kept
serving at stage 0 behaviour throughout (no table, data or API was lost).

Decision (Ryne). PITR is not required for the cutover (on-demand backups exist), so the PITR flip is
REMOVED from the staged path. `BCAT_SCHEMA_STAGE` no longer has a PITR stage; see "PITR (deferred, not
part of the cutover)" above for what drives it now. The remaining stages are renumbered; stage 0 is
unchanged.

Renumbering (old -> new). The CONTENT of every stage is unchanged; only the numbers moved:

| Old stage | What | New stage |
|---|---|---|
| 0 | production shape + additive fields + new Lambdas | 0 (unchanged) |
| 1 | PITR flip on the 60 existing tables | REMOVED (not a stage) |
| 2 | 21 models (carriers, ownership, commissions, user profile, integrations, CRM) + TaxVault | 1 |
| 3 | 14 shipment-core models | 2 |
| 4 | 14 models (billing, Aljex import, workflow, rollups); retires vendor-ap-extract | 3 (last model stage, default for unlisted models) |
| 5 | TruckLocationHistory TTL, alone | 4 (= FINAL_STAGE = unset) |

Exact operator procedure for the new numbering (after the failed stack is recovered, see the next
section). Production is at stage 0 behaviour; the old stage 1 never completed. Production env is
`BCAT_SCHEMA_STAGE` only (no `BCAT_ENABLE_PITR`, no `BCAT_DEV_STACK`).

1. Branch has the new code (this change), `node scripts/stageDeployCheck.mjs --baseline-ref 17f71c3e`
   prints `OK`.
2. Recover the root and nested data stacks out of `UPDATE_ROLLBACK_FAILED` (next section), and confirm the
   root stack is `UPDATE_ROLLBACK_COMPLETE` or `UPDATE_COMPLETE`.
3. With the `APP`, `BRANCH=main`, `set_stage`, `run_stage` helpers above, set stage **0** again first (the
   new code at stage 0 is the production shape and leaves the 60 tables as they are), then, one at a time
   and each only after SUCCEED and the checks above:

   ```sh
   run_stage 0     # new code, production shape: no table change
   run_stage 1     # 21 models + TaxVault   (was old stage 2)
   run_stage 2     # 14 shipment-core models (was old stage 3)
   run_stage 3     # 14 models, retires vendor-ap-extract (was old stage 4)
   run_stage 4     # TruckLocationHistory TTL, alone (was old stage 5)
   ```
4. NEVER set a lower stage on a stack that has reached a higher one (the warning at the top). In
   particular a value of `1` on the failed stack now means "21 models", not "PITR".

## Recovery of the failed stage-1 stack (production)

The full analysis, the 15 failed resources, the exact commands (read-only planner `scripts/prodRecoveryPlan.sh`, then `continue-update-rollback --resources-to-skip ...`) and the env reset are in `Docs/tms-build/AW_STAGE1_RECOVERY.md`. Root cause of the failed rollback: `Execution Already Exists` in the table-manager's Step Functions waiter (a deterministic name collision), so skip the 15 table resources rather than retrying plainly.

## Files

`amplify/data/stages.ts`, `amplify/data/resource.ts` (`stageTypes`), `amplify/backend.ts` (`stageTables`,
`stageCfnTables`, `tableOrNull`, the PITR (`pitrEnabled`) and TTL guards, the dashboard rollup block),
`scripts/stageDelta.mjs` (pure comparison logic, tested by `scripts/stageDelta.test.mjs`),
`scripts/stageDeployCheck.mjs`, `scripts/measureDataTemplate.mjs` (prints the stage), tests
`amplify/data/stages.test.ts`.
