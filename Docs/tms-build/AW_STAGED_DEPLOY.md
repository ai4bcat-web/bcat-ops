# Staged schema deploy (Step AW)

Going from the 60-model production shape to the merged 109-model tree in ONE Amplify release fails:
CloudFormation refuses a stack operation that creates, updates or deletes more than 2,500 resources
across the nested stacks ("Limit on the number of resources in a single stack operation exceeded").
The rehearsal hit it. The schema therefore deploys in six releases, driven by one branch environment
variable, `BCAT_SCHEMA_STAGE`.

> ## WARNING: NEVER LOWER `BCAT_SCHEMA_STAGE` ON A DEPLOYED STACK
>
> A lower stage no longer contains the models the higher stage created. CloudFormation then DELETES
> those tables and their data (the tables are not retained). The synth cannot know what is deployed,
> so there is no guard in code: the operator is the guard.
> After a FAILED stage k, leave the variable at k and fix forward (see "A stage failed"). Do not "go
> back to k-1". To return to a working state, re-run stage k (or raise it) only.

## How the variable works

- Unset, empty, or `>= 5`: the WHOLE schema. Dev and every deploy that does not set it are unchanged
  (verified: data stack 968,579 B / 460 resources in `--prod-shape`, same as before).
- `0..4`: that stage. A non-integer value fails the synth loudly.
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

## Stage table (resources = created + updated + deleted, measured)

Measured by `node scripts/stageDeployCheck.mjs --baseline-ref feat/gsi-prep` (prod-shape synth; the
baseline is main plus the GSI prep slice). Method: synthesize every stage; for each stage compare every
`*.template.json` (root stack and all nested stacks) with the previous stage, resource by resource
(logical id, properties compared as canonical JSON); a resource in a new nested stack is created, one
whose properties differ is updated, one that vanished is deleted. The limit enforced is 1,500 per stage
(the cap is 2,500; 40% margin).

| Stage | What it deploys | created | updated | deleted | TOTAL |
|---|---|---|---|---|---|
| 0 | Production models + 244 additive fields on 9 existing models (Load +50, Customer +51, Location +1, Division +11, TmsSettings +116, FactoringItem +4, VendorPayable +3, TruckConfig +2, TruckLocationHistory +6) + the new Lambdas / custom operations (no new tables, no table change) | 147 | 245 | 25 | 417 |
| 1 | Point-in-time recovery always on: the `pointInTimeRecoverySpecification` flip on all 60 existing tables. Nothing else | 0 | 121 | 0 | 121 |
| 2 | 21 models: Carrier, CarrierContact, CarrierPaymentMethod, CarrierDocument, CompanyPhone, OwnershipDivision, OwnershipRule, ShipmentView, ShipmentColumnTemplate, UserProfile, Commission, CommissionPayPeriod, Integration, SpotSettings, GmailConnection, SpotRequest, ApInboxItem, CrmContact, CrmDomain, CrmActivity, CrmAccount | 574 | 27 | 0 | 601 |
| 3 | 14 models, the shipment core: ProClaim, IntakeLoad, Shipment, Order, LoadCarrier, LoadFinancials, LoadCharge, LoadCheckCall, TrackingLink, ShipmentDocument, ShipmentNotice, ShipmentPosting, ShipmentMessage, Quote | 496 | 38 | 0 | 534 |
| 4 | 14 models: Invoice, ArPayment, CarrierBill, ApPayment, ImportJob, AljexImportJob, AljexMappingProfile, LegacyAljexRow, AljexCodeMap, DataExportJob, WorkflowRun, DemoRecord, LaneRateSample, DashboardRollup (+ their stream mappings / schedule; deletes the old vendor-ap-extract Lambda) | 438 | 23 | 3 | 464 |
| 5 | TruckLocationHistory TTL (`ttlEpoch`), ALONE | 0 | 3 | 0 | 3 |

(The numbers are re-measured by the script; stage 5 equals "unset".) A model nobody listed in
`MODEL_STAGE` lands in stage 4, never stage 5. Adding a field to any model needs no stage edit: a field
on an existing model rides in stage 0, a field on a new model rides with its model.

### Stage 0 deletes 25 resources, on purpose

All are API resolvers or one Lambda, no table, no data: the Load `deleteLoad` mutation and `onDeleteLoad`
subscription (a PRO is permanent), the client create/update/delete mutations on TruckLocationHistory
(only Lambdas write it). `stageDeployCheck.mjs` allows exactly these and fails on any other deletion.

### Triggers wait for their tables; the old vendor extractor waits for WorkflowRun

- Lambdas are deployed at stage 0, but a schedule that reads a table would fail on every run until the table
  exists, so each is created only at the stage that creates its tables (`TRIGGER_MODELS`/`triggerEnabled` in
  `amplify/data/stages.ts`): McpSync and SpotQuoterPoll rules at stage 2, the tracking-automation Scheduler
  schedule at stage 3, WorkflowAgentSweep and the two DataSafety rules at stage 4. Stage 0 creates only the
  harmless ApInboxHourly rule, the check-call-notifier schedule and two Load-stream mappings.
- `vendor-ap-extract` (production's invoice extractor) is NOT deleted at stage 0: `vendor-ap-intake` keeps
  invoking it with `{ id }` exactly as today. Stage 4 (which creates WorkflowRun, what `workflow-agent` needs)
  repoints the intake at `workflow-agent` (`VENDOR_AP_EXTRACT_TARGET=workflow-agent`, run hand-off payload) and
  deletes the old Lambda, role and policy (3 resources, the only deletion allowed outside stage 0; the checker
  permits it at `VENDOR_AP_EXTRACT_RETIRED_STAGE` only). "Stage k is a superset of stage k-1" is checked on the
  data model only; this one deliberate non-data removal is therefore listed here. Never lower the stage below 4
  afterwards: the old Lambda would not come back with its production name.

### Why these boundaries

- GSIs: Load (`shipmentId`, `status`, `checkCallOpen`+`nextCheckCallAt`) and AuditLog (`entityType`+
  `entityId`) are NOT a step here. They deploy first from `feat/gsi-prep` (see
  `Docs/tms-build/GSI_DEPLOY_SEQUENCE.md`) and are part of the stage 0 shape. If they are not live yet,
  `stageDeployCheck.mjs` fails ("gains N GSIs") on the stage 0 step; do not start stage 0 until they are.
  DynamoDB builds one GSI per table per update; stage 0 must not add any.
- PITR (stage 1) rewrites the table resource in every existing nested stack, so it is a stage of its own.
- TTL (stage 5): DynamoDB allows one TTL change per table per hour. A stage that fails AFTER this change
  cannot roll back cleanly (UPDATE_ROLLBACK_FAILED; the rehearsal got stuck exactly this way), so it is
  the only change in its stage and the last one. The script fails if anything else changes in it.
- Any other change to an existing production table (billing mode, streams, deletion policy) would be a
  stage of its own. There is none today; the script fails if an existing table changes in any stage other
  than 1 and 5.

## Before you start

```sh
git checkout <the branch Amplify builds>            # the merged tree, with the stage mechanism
node scripts/stageDeployCheck.mjs --baseline-ref feat/gsi-prep   # or origin/main once the GSI prep is on main
```
It must print `OK`. It takes about 4 minutes, synthesizes only and writes nothing to AWS. Keep
`--jobs 1` (parallel synths in one checkout collide in `amplify/.amplify/layers`).

Also: the GSI prep is deployed and ACTIVE (`aws dynamodb describe-table --table-name Load-<apiId>-NONE
--query 'Table.GlobalSecondaryIndexes[].[IndexName,IndexStatus]'`), and no other release is running.

## Operator procedure (one stage at a time, one Amplify deploy at a time)

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
run_stage 1     # check, then 2, 3, 4, 5
```

Expected time per stage: 15 to 30 minutes for the Amplify build plus the CloudFormation update
[INFERENCE from deploy history, not measured here; record the real numbers from the rehearsal below].
Stage 1 touches 60 tables with an `UpdateContinuousBackups` call each and may be the quickest to fail on
throttling; stages 2 to 4 create 14 to 21 tables each. A stage must reach SUCCEED before the next starts.

### Check between stages

1. Job SUCCEED; the CloudFormation root stack `amplify-<appId>-<branch>-branch-*` is `UPDATE_COMPLETE`
   (also the nested stacks): `aws cloudformation describe-stacks --stack-name <root> --query 'Stacks[0].StackStatus'`.
2. Tables exist: count them (`aws dynamodb list-tables --query 'length(TableNames)'`) and compare with the
   stage (60 production tables through stage 1; +21, +14, +14 after).
3. Stage 1 only: `aws dynamodb describe-continuous-backups --table-name Load-<apiId>-NONE` shows
   `PointInTimeRecoveryStatus: ENABLED`.
4. Stage 5 only: `aws dynamodb describe-time-to-live --table-name TruckLocationHistory-<apiId>-NONE`
   shows `ENABLED` on `ttlEpoch` (the status passes through ENABLING).
5. Smoke the live app on the existing pages (drivers, loads, dispatch). After stages 2 to 4 the pages for
   the new models start working; before their stage they are dormant, not broken.
6. Do not start the next stage until the previous TTL/GSI/PITR state is settled (`describe-table` ACTIVE).

### A stage failed

- Do NOT set a lower `BCAT_SCHEMA_STAGE`. A lower stage would delete models and data.
- Read the failure: `aws cloudformation describe-stack-events` on the failing nested stack (first
  `*_FAILED` event). Fix the cause on the branch (code or configuration), then re-run the SAME stage
  (`run_stage k`) : the update continues from the rolled-back state.
- If the stack is `UPDATE_ROLLBACK_FAILED`: continue the rollback
  (`aws cloudformation continue-update-rollback --stack-name <root> [--resources-to-skip ...]`), then
  re-run the same stage. The known cause is a second TTL change on TruckLocationHistory inside one hour;
  with stage 5 isolated this cannot arise from another stage. If stage 5 itself fails after the TTL
  change, wait 70 minutes before retrying anything that touches that table.
- Only after the fix is the same stage re-run; only after SUCCEED go on.

### Prerequisites and caveats

- Stage 0 assumes the GSI prep (`feat/gsi-prep`) is already deployed. Without it stage 0 would add 3
  GSIs to Load in one update, which DynamoDB refuses.
- Stage 1 can be skipped only by deliberately setting `PITR_STAGE` to a stage that is small enough:
  the numbers above say stage 1 alone is 121 resources, so combining it with stage 2 (588) would still be
  under the limit; edit `PITR_STAGE` and re-run the checker if you want fewer releases. Likewise stages
  3 and 4 could merge (986): that is within the limit but halves the margin for failure isolation.
- The dev branch is unset and always deploys the whole schema.

## Files

`amplify/data/stages.ts`, `amplify/data/resource.ts` (`stageTypes`), `amplify/backend.ts` (`stageTables`,
`stageCfnTables`, `tableOrNull`, PITR and TTL guards, the dashboard rollup block),
`scripts/stageDelta.mjs` (pure comparison logic, tested by `scripts/stageDelta.test.mjs`),
`scripts/stageDeployCheck.mjs`, `scripts/measureDataTemplate.mjs` (prints the stage), tests
`amplify/data/stages.test.ts`.
