# Stage 1 incident 2026-11-07: recovery of the production data stack (read-only analysis, commands for Ryne)

## What happened (facts from Amplify main job 715 and CloudFormation, all read-only)
- Release 715 ran with `BCAT_SCHEMA_STAGE=1`, which at that time meant "turn point-in-time recovery on for the 60 existing tables".
  60 `Custom::AmplifyDynamoDBTable` resources called `UpdateContinuousBackups` at once; DynamoDB answered `Rate exceeded`
  (first failures: EscalationEmailLog, AmazonPayMaster) and CloudFormation began rolling back.
- The rollback then failed on 15 table custom resources with: `Execution Already Exists: arn:aws:states:...:execution:
  AmplifyTableWaiterStateMachine...:<request id>`. The Amplify table-manager starts a Step Functions waiter named after the
  request id; the rollback request collides with the execution the failed update already started (that execution SUCCEEDED at
  19:37:44, nothing is running now: `list-executions --status-filter RUNNING` is 0 on all six waiter state machines).
  This is deterministic, so a plain `continue-update-rollback` will fail the same way on the same resources.
- State right now: root `amplify-d3dejqzs77khq6-main-branch-0feb70fa58` and data stack `...-data7552DF31-1KWGVF631TI3D` are
  `UPDATE_ROLLBACK_FAILED`; 15 model stacks are `UPDATE_ROLLBACK_FAILED` (the others were still settling when checked at 19:45).
  All 60 production tables are ACTIVE and every one reports PITR `DISABLED`: nothing was changed on any table. Production runs
  with the stage-0 template and behaviour.

## The 15 resources that failed to roll back
Custom::AmplifyDynamoDBTable in: DispatchSettings, TruckOdometerDay, DriverSubmissionDoc, DriverSubmission, Division, Location,
DriverPayCredit, DriverPayDeduction, TruckLocation, EscalationEmailLog, OnboardingInvite, TruckConfig, TruckMileage, IntakeItem, Load
(the list can grow while nested rollbacks settle: `scripts/prodRecoveryPlan.sh` regenerates it).

## Recovery commands (a human runs these; the planner below only reads)
1. Plan (read-only, prints the exact skip list, safe to run any time):
   `bash scripts/prodRecoveryPlan.sh`
2. Wait until it prints `nested stacks still settling: 0` and the root and data stack both read `UPDATE_ROLLBACK_FAILED`
   (nested rollbacks can take up to an hour: the table waiter polls 10 s x 360).
3. Because the failure is a name collision, skip the plain retry and use the skip list the planner printed:
   `aws cloudformation continue-update-rollback --stack-name amplify-d3dejqzs77khq6-main-branch-0feb70fa58 --resources-to-skip <the list from step 1>`
   (each entry is `data7552DF31.<model nested stack logical id>.<Model>Table`.)
   Poll: `aws cloudformation describe-stacks --stack-name amplify-d3dejqzs77khq6-main-branch-0feb70fa58 --query 'Stacks[0].StackStatus' --output text`
   until `UPDATE_ROLLBACK_COMPLETE` (roughly 5-15 min).
4. What skipping means: CloudFormation stops trying to roll those 15 table resources back and records them as rolled back. No
   table, index or item is touched (tables stay as they are: ACTIVE, PITR disabled). A few may differ from CloudFormation's
   record until the next successful deploy updates them; that is harmless.
5. If step 3 fails again with a different resource, add that resource to the skip list in the same format and retry. If it
   fails with `Rate exceeded` again, wait 10 minutes and retry (it is the same table-manager API throttle).
6. Verify: root `UPDATE_ROLLBACK_COMPLETE`, the app answers, `aws dynamodb list-tables` still shows 60 tables, 958 Load items.

## Before ANY push or env change afterwards
- `BCAT_SCHEMA_STAGE=1` is still set on the main branch. Under the NEW numbering (below) 1 means "21 new models". Reset it to 0
  FIRST (and any push to main while it is 1 will start a release):
  `ENV=$(aws amplify get-branch --app-id d3dejqzs77khq6 --branch-name main --query branch.environmentVariables --output json | python3 -c "import json,sys; d=json.load(sys.stdin); d['BCAT_SCHEMA_STAGE']='0'; print(','.join(f'{a}={b}' for a,b in d.items()))")`
  `aws amplify update-branch --app-id d3dejqzs77khq6 --branch-name main --environment-variables "$ENV"`
- The stack's template is the stage-0 shape, so env 0 is consistent with what is deployed.

## The redesign (PR to main)
PITR is removed from the staged path (on-demand backups cover the cutover). Stages renumber, cumulative, no stage deletes a table:
| new | old | content |
|---|---|---|
| 0 | 0 | production shape + 244 optional fields + new Lambdas (unchanged: already deployed) |
| 1 | 2 | 21 models (Carrier..., ownership, UserProfile, Commission, Integration, Spot, CRM) + tax vault |
| 2 | 3 | 14 shipment-core models |
| 3 | 4 | 14 models (Invoice, ArPayment, CarrierBill, ApPayment, imports, workflow, dashboards) |
| 4 | 5 | TruckLocationHistory TTL alone |
PITR later (not part of the cutover): see AW_STAGED_DEPLOY.md, section "PITR (deferred)".
