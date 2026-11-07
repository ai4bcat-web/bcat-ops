# AW stage A: production schema vs merged schema

Written 2026-11-07 by SchemaDiff. Read-only analysis; no repo source was modified, no AWS call was made (nothing touched production or dev AWS; the measure scripts synth locally).

Baseline = `origin/main` (`ff4489dd`, production's source; `amplify/data/` there holds only `resource.ts`, no auxiliary schema/enum files). Merged = working tree on `merge/main-into-dev` (HEAD `61e931f6`; `origin/main` is an ancestor of HEAD, so the merged schema is a strict superset of main's, hours commits #135/#136 included).

Method: both `resource.ts` files were copied into `/tmp/aw/{main,merged}/amplify` (node_modules symlinked), one line appended to export the `schema` object, evaluated with `tsx`, and `schema.transform()` produced the real AppSync SDL (models, `@index`/`@primaryKey`, `@auth`, enums, custom queries/mutations, `@function` bindings). The SDL was parsed with `graphql` and diffed field by field (type, `!`, arrays, directives). Artifacts: `/tmp/aw/main.graphql`, `/tmp/aw/merged.graphql`, `/tmp/aw/diff.json`.

Totals: main 60 models / 53 enums / 17 Lambda functions bound to the schema; merged 109 models / 183 enums / 27 bound Lambdas.

## Verdict

**No storage-level blockers found.** Nothing that triggers table replacement or a failed update: no removed model, no removed field, no key (primary key / sort key) change, no GSI changed or removed, no optional->required change, no type change, no enum member removed. All 241 added fields on existing models are optional.

Two things Ryne should know that are NOT CloudFormation blockers but are API-contract removals (section 3b), and one per-table GSI flag (section 4: `Load` +3, which the project already analysed and which dev already deployed in one update).

## 1. Models added: 49 (60 -> 109)

AljexCodeMap, AljexImportJob, AljexMappingProfile, ApInboxItem, ApPayment, ArPayment, Carrier, CarrierBill, CarrierContact, CarrierDocument, CarrierPaymentMethod, Commission, CommissionPayPeriod, CompanyPhone, CrmAccount, CrmActivity, CrmContact, CrmDomain, DashboardRollup, DataExportJob, DemoRecord, GmailConnection, ImportJob, IntakeLoad, Integration, Invoice, LaneRateSample, LegacyAljexRow, LoadCarrier, LoadCharge, LoadCheckCall, LoadFinancials, Order, OwnershipDivision, OwnershipRule, ProClaim, Quote, Shipment, ShipmentColumnTemplate, ShipmentDocument, ShipmentMessage, ShipmentNotice, ShipmentPosting, ShipmentView, SpotRequest, SpotSettings, TrackingLink, UserProfile, WorkflowRun.

New tables are CREATEd (no one-GSI limit on create). Between them they carry 66 GSIs (see 4). Models removed: none.

## 2. Fields added to existing models: 241, every one optional

| Model | Added fields | Notes |
|---|---|---|
| Load | 54 | all nullable; includes the three GSI key attributes `shipmentId`, `status` (enum `LoadStatus`), `checkCallOpen` (+ sort `nextCheckCallAt`). Fields with read-only field auth: `carrierAssignmentStatus`, `legacyImported`, `legacySource`, `previousReadyToInvoice`, `previousStatus`, `voidedAt` |
| Customer | 47 | all nullable (enums `CustomerStatus`, `CustomerInvoiceFrequency`, `CustomerTrackingMode`, `CustomerTrackingMethod`, `CustomerDriverSmsTarget`) |
| TmsSettings | 113 | all nullable |
| Division | 11 | all nullable |
| FactoringItem | 4 | `invoiceId`, `orderId`, `shipmentId`, `source` (enum) |
| VendorPayable | 3 | `apInboxAppliedAt`, `apInboxItemId`, `apInboxSourceUrl` |
| TruckLocationHistory | 6 | `accuracyM`, `approx`, `loadId`, `payload`, `refId`, `ttlEpoch` |
| TruckConfig | 2 | `phone`, `phoneLabel` |
| Location | 1 | `aljexCode` |

Every other existing model (including Driver, Equipment and all driver-pay / fuel / expense / compliance / dispatch tables): field list identical. Enum members: one added to an existing enum (`DriverFleetGroup` + `OWNER_OPERATOR`, i.e. the hours/driver-fleet work from main is already in main; no removal anywhere); 130 whole enums added (inline enums on the new models and new fields). Custom types: none in either schema. Custom input types: no difference.

Existing-model field changes that are not shape changes (directives only):
- `Load.aljexId`, `Load.pickupNumber`, `Load.tmsId`: stay `String!`, gain field auth `allow private, operations: [read]` (client cannot write them; the Step R PRO-permanence design).
- `AuditLog.entityType`: stays `String!`, gains the new `@index` (see 4).

## 3. BLOCKERS for Ryne (key, removed, required, type, GSI change, enum removal)

| Check | Result | Evidence |
|---|---|---|
| Removed model | **none found** | `modelsRemoved: []` in `/tmp/aw/diff.json` |
| Removed field | **none found** | `fieldsRemoved: {}` |
| Changed primary key / sort key / identifier | **none found** | the `@primaryKey` directive text is compared as part of each field's directives; no existing field's directives changed except the auth/index additions listed above. Main's 10 `@primaryKey` models (e.g. TruckLocationHistory `truckId`+`locatedAt`, TruckMileage, PodSenderMapping) are textually identical in merged |
| optional -> required | **none found** | no existing field's `!` changed; all 241 additions are nullable |
| Type change | **none found** | `fieldChanged` lists only the 3 Load auth additions and the AuditLog index addition, all with unchanged types |
| Changed or removed GSI | **none found** | all 60+ pre-existing `@index` directives (names/queryFields, sort keys) identical on the 60 main models |
| Enum member removed | **none found** | `enumsRemoved: []`; the only changed existing enum gained a member |
| Query/Mutation/Subscription removed | none | `ops.removed` empty for all three roots |

This agrees with `GSI_DEPLOY_SEQUENCE.md` section 2 (written 11-04, deployed-template based): "Removed or changed keys: none".

### 3b. API-surface tightening (not storage blockers; Ryne should be aware)

1. **`Load`: the generated `createLoad` and `deleteLoad` mutations (and `onDeleteLoad` subscription) are gone.** `@model` went from default to `@model(mutations: {delete: null}, subscriptions: {onDelete: null})` and model auth from `allow private` to `allow private, operations: [read, update]`, so create is also not available to a signed-in client (the TMS creates loads through the `tmsShipmentActions` Lambda; `src/lib/apiClient.ts:446` comments "There is no createLoad"). Production's current frontend calls `createLoad` (`origin/main:src/lib/apiClient.ts:242`, `useAppStore.ts:649`). The merge deploy ships backend and frontend together, so a stale open tab on the old bundle will get an error when adding a load until it reloads. Step R by design (Ryne 2026-10-28: a PRO number is permanent). No data impact.
2. **`TruckLocationHistory`**: `@model(subscriptions: null)` -> `@model(subscriptions: null, mutations: {create: null, update: null, delete: null})`, auth `private` -> `private, read`. Client writes to the table are removed; only Lambdas write. Grep found no client caller of those mutations.
3. `manageUsers` query gained two optional args (`role`, `input`): additive.
4. 10 new `@function`-bound mutations: `tmsAljexImport`, `tmsApInboxActions`, `tmsCarrierActions`, `tmsCrmActions`, `tmsDataSafety`, `tmsFinanceActions`, `tmsShipmentActions`, `tmsSpotActions`, `tmsTrackingActions`, `tmsWorkflowActions` (all `allow private`). Existing ones unchanged.
5. Infrastructure removal: Lambda `vendor-ap-extract` (and its `VENDOR_AP_EXTRACT_FUNCTION_NAME` env on `vendor-ap-intake`) is deleted in the merged tree, replaced by `workflow-agent` (removed on dev in `80b1251a`, Step K). The deploy deletes that Lambda in prod's data stack. Not a data resource.

## 4. GSIs

### 4a. Existing production tables that gain GSIs (the DynamoDB limit applies)

| Table (on production) | GSIs on main | GSIs on merged | Added | Flag |
|---|---|---|---|---|
| **Load** | 1 (`customerId`) | 4 | **+3**: `shipmentId` (HASH `shipmentId`, `listLoadByShipmentId`), `status` (HASH `status`, `listLoadByStatus`), `checkCallOpen` (HASH `checkCallOpen`, RANGE `nextCheckCallAt`, `listLoadByCheckCallOpenAndNextCheckCallAt`) | **>1 added** |
| AuditLog | 0 | 1 | +1: HASH `entityType`, RANGE `entityId` (`listAuditLogByEntityTypeAndEntityId`) | ok (1) |
| every other existing table (58) | n | n | 0 | none |

Projection: Amplify `@index` default (ALL), per `GSI_DEPLOY_SEQUENCE.md` table (all four ALL, all key attributes type `S`, additive).

Only `Load` exceeds one added GSI. New tables (49) are created with all their GSIs at once (66 GSIs in total across them; CREATE has no limit).

### 4b. How the project already treats "one GSI per table per update"

- `Docs/tms-build/GSI_DEPLOY_SEQUENCE.md` section 1: the premise is **wrong for this stack**. Amplify Gen2 data tables are `Custom::AmplifyDynamoDBTable` owned by the AmplifyTableManager Lambda, which issues ONE `UpdateTable` per `isComplete` poll (10 s poll, 360 attempts = 1 h cap per table) and works through the remaining GSIs serially. Prod runs the identical handler asset as dev. Dev already added the same three Load GSIs in one commit (`ee5b2cd`, 2026-10-28): created serially 05:26:18 / 05:34:52 / 05:43:13, `LoadTable` UPDATE_COMPLETE 05:51:36 (~25 min). So a single deploy is expected to succeed; the cost is ~25 min of serial Load waiting. Not proven: prod data volume and inside the mega-merge deploy.
- `Docs/tms-build/CUTOVER_PLAN.md` NB-4 / P3 (L42, L77): **GSI prep push**: ONE schema-only commit on `main` (4 key fields + 3 Load GSIs + the AuditLog GSI; only `amplify/data/resource.ts`), ~15.5 min job + ~25 min GSI creation; needs Ryne's OK; status 11-04 NOT DONE. Fallback if that update fails: three commits, one GSI per table each, ~24 min per step ("Option B" in `GSI_DEPLOY_SEQUENCE.md`). P4: a throwaway Amplify branch from main fast-forwarded to dev proves the +49-table deploy and GSI behaviour (also not done as of 11-04). With the prep push done, F11 is a fast-forward and the merged delta would contain no GSI additions; `CUTOVER_PLAN.md` L308 says "the 3 Load GSIs are no longer part of the merge once P3 is done".
- `scripts/gsiSequenceCheck.mjs` is the tool that enforces the limit: `diff`/`sequence` take `--max-gsi-per-table` (default 1) and exit 3 when more than that many GSI creates/deletes hit one table in a step, exit 2 on a replacement-triggering diff (key schema change, removed table, attribute type change). With the default 1, main -> merged exits 3 on `Load` (+3). That is a conservative gate, not what CloudFormation does for this stack. `simulate` replays the real table-manager handler to count `updateTable` calls.
- `scripts/measureDataTemplate.mjs` does NOT look at GSIs at all: it measures template bytes, resource count and Lambda env size only (exit 2 over 1,000,000 B, 3 Lambda env over limit, 4 over 995,000 B guard, 5 over 500 resources). `Docs/DEV_STACK.md` has no GSI section.
- Status note: the "GSI prep push" label in the CUTOVER_PLAN/BUILD_LOG docs; `TMS_BUILD_BRIEF.md` does not exist under `Docs/tms-build` (grep of the existing docs found the plan only in `CUTOVER_PLAN.md`, `GSI_DEPLOY_SEQUENCE.md`, `THURSDAY_BRIEF.md`, `BUILD_LOG.md`, `AI-plan.md`).

### 4c. Other table-level changes in the merged deploy (from `GSI_DEPLOY_SEQUENCE.md` section 2; not re-derived here)
- PITR forced on for the 60 existing tables (`UpdateContinuousBackups` per table, before GSI work).
- `TruckLocationHistory` TTL attribute `null` -> `ttlEpoch` (new field `ttlEpoch` is in the added-field list above).

## 5. Lambdas / env vars / secrets / IAM in `amplify/backend.ts` vs main

`amplify/backend.ts`: 2,430 insertions / 73 deletions vs main.

**defineBackend members:** +18, -1.
- Added: `checkCallNotifier` (schedule every 5 m, 512 MB, `SLACK_BOT_TOKEN`), `loadTrackingProjector` (Load stream, 512 MB), `mcpSync` (300 s), `rateConSignApi` (public Function URL, 30 s), `shipmentEmailIntake` (Function URL, 30 s, secret `INTAKE_WEBHOOK_SECRET`), `shipmentNotifier` (stream, 512 MB), `tmsAljexImport` (900 s, 1,536 MB), `tmsApInbox` (300 s, 1 GB, `ANTHROPIC_API_KEY`), `tmsCarrierActions`, `tmsCrmActions` (`ANTHROPIC_API_KEY`), `tmsDashboardRollup` (300 s, 1 GB, per-table stream mappings), `tmsDataSafety` (900 s, 1 GB), `tmsFinanceActions`, `tmsShipmentActions`, `tmsSpotQuoter` (300 s, 1 GB, `ANTHROPIC_API_KEY`), `tmsTrackingActions` (`GOOGLE_MAPS_API_KEY`, `ANTHROPIC_API_KEY`), `trackingAutomation` (schedule every 5 m, 256 MB), `workflowAgent` (90 s, 1 GB, `ANTHROPIC_API_KEY`, `INTAKE_WEBHOOK_SECRET`). All `resourceGroupName: 'data'`, i.e. they land in the data stack.
- Removed: `vendorApExtract` (superseded by `workflowAgent`, see 3b.5).
- Modified existing resources: `tmsDirectoryActions` now also reads 12 stack secrets (OTR_USERNAME/PASSWORD/SUBSCRIPTION_KEY, MOTIVE_API_KEY, BLUE_INK_TECH_API_KEY, GOOGLE_MAPS_API_KEY, ANTHROPIC_API_KEY, SLACK_BOT_TOKEN/SIGNING_SECRET/CHANNEL_MAPPING, PAYCHEX_CLIENT_ID/SECRET), making it the heaviest Lambda env (est. 3,495 of 3,900 limit); `userManagement` timeout 3 s -> 30 s.

**Secrets:** the set of distinct `secret('...')` names is **identical** to main (14 names; none new). The prod-shape measure checks them against `scripts/lib/prodSecretNames.json`: 12 present, 2 MISSING in prod SSM: `GEOCODE_TOKEN_SECRET` (2 Lambdas) and `GOOGLE_MAPS_API_KEY` (3 Lambdas, now also tmsTrackingActions/tmsDirectoryActions); per the script "those Lambdas degrade at cold start (deploy does not fail)". `GEOCODE_TOKEN_SECRET` was already used on main by `tms-geocode`.

**Build-time env vars read by backend.ts** (`process.env.*`): added `AWS_APP_ID` (defaults to `d3dejqzs77khq6`), `BCAT_DEV_STACK` (dev-only guard), `CDK_CONTEXT_JSON`, `PORTAL_ORIGIN` (falls back to `PORTAL_PROD_ORIGIN` / `https://ops.bcatcorp.com`); none removed. Nothing mandatory for prod: the prod-shape synth unsets `BCAT_DEV_STACK` and `BCAT_ISOLATED_PREVIEW`. Amplify Console env var lengths are covered by `scripts/lib/prodBuildEnv.json` in `--prod-shape`.

**Counts, main -> merged:** `new PolicyStatement` 88 -> 221; `addEnvironment` 191 -> 357; `grant*()` calls 22 -> 45; Function URL declarations 12 -> 16; `CfnOutput` 13 -> 17; `EventSourceMapping` 3 -> 6 (plus the DashboardRollup per-table loop); schedule/rule uses 19 -> 32; a new S3 `Bucket` (`DataSafetyBucket`, `backend.ts` L2988, in the data-safety Lambda's stack).
- New Function URLs / outputs: `RateConSignApiFunctionUrl`, `ShipmentEmailIntakeFunctionUrl`, `CarrierCallFunctionUrl`, `WorkflowAgentFunctionUrl`.
- New stream mappings: `LoadTrackingProjectorStreamMapping`, `ShipmentNotifierStreamMapping`, `DashboardRollup<table>StreamMapping` (loop); `BrokerLoadStreamMapping` and `RateconAssignedTextStreamMapping` already existed on main.
- IAM action strings new in backend.ts (not on main): `cognito-idp:AdminUserGlobalSignOut`, `dynamodb:BatchWriteItem`, `dynamodb:DescribeContinuousBackups`, `dynamodb:DescribeExport`, `dynamodb:DescribeTable`, `dynamodb:ExportTableToPointInTime`, `dynamodb:ListTables`, `dynamodb:TransactWriteItems` (and `DeleteItem` in single-line lists), `s3:DeleteObject`, `s3:GetObject`, `s3:ListBucket`, `s3:PutObject` (+ `s3:prefix` condition), `ssm:DeleteParameter`. No action strings removed. The data-safety Lambda gets the table export / ListTables / DescribeContinuousBackups grants; `ssm:DeleteParameter` is the new destructive SSM permission to review.
- Storage (`amplify/storage/resource.ts`, +75): new access prefixes `workflow-inbox/*`, `carrier-docs/*`, `shipment-docs/*`, `invoices/*`, `remittances/*`, `brand/*`, `imports/*` (authenticated read; staff groups write per prefix; no deletes except `carrier-docs`, `brand`, `imports` for staff).
- The Aspect near the bottom of backend.ts (dev secret stripping / SES deny) is bypassed in the prod shape, as `measureDataTemplate.mjs --prod-shape` documents.

## 6. CloudFormation size

`scripts/measureDataTemplate.mjs` header: synthesizes exactly what the Amplify build runs (`Toolkit.fromAssemblyBuilder` + `tsImport('amplify/backend.ts')` + the `amplifySynth` message) and prints the byte count of the data stack and of every template over 100 KB, plus resource count and estimated Lambda env size. `--branch dev` = dev context. `--prod-shape` = synthesize as main would after the merge (branch `main`, `BCAT_DEV_STACK`/`BCAT_ISOLATED_PREVIEW` unset, prod build env lengths filled, secret names checked). Both ran on the merged working tree with exit 0 (caps: 500 resources, 1,000,000 B CloudFormation, 995,000 B guard).

Raw output lines:

```
# node scripts/measureDataTemplate.mjs --branch dev
[info at /amplify-d3dejqzs77khq6-dev-branch-f0946a5a1f/data] Number of resources: 460 is approaching allowed maximum of 500
[warn at /amplify-d3dejqzs77khq6-dev-branch-f0946a5a1f/data] Template size is approaching limit: 964379/1000000. Split resources into multiple stacks to reduce template size. [ack: @aws-cdk/core:Stack.templateSize]
branch:    dev
templates: 116
   964387  amplifyd3dejqzs77khq6devbranchf0946a5a1fdata61149764.nested.template.json
   171937  amplifyd3dejqzs77khq6devbranchf0946a5a1fdataamplifyDataFunctionDirectiveStack16C428AE.nested.template.json
data stack: 964387 bytes, 35613 under the 1000000 cap (guard 995000: 30613)
resources:  460 of 500
asset key:  c90f9bdb5cc6bbb20b4b8f79ee4b5ea11d9d77bfbf995d17de02bdea8286f365
top 5: tmsdirectoryactionslambdaC060C7E2=3478, driverappapilambda665E2DED=2873, workflowagentlambda4BAD616E=1870, tmsspotquoterlambdaD7208187=1609, tmstrackingactionslambda6EA07509=1543

# node scripts/measureDataTemplate.mjs --prod-shape
[info at /amplify-d3dejqzs77khq6-main-branch-0feb70fa58/data] Number of resources: 460 is approaching allowed maximum of 500
[warn at /amplify-d3dejqzs77khq6-main-branch-0feb70fa58/data] Template size is approaching limit: 968571/1000000. Split resources into multiple stacks to reduce template size. [ack: @aws-cdk/core:Stack.templateSize]
branch:    main
templates: 116
   968579  amplifyd3dejqzs77khq6mainbranch0feb70fa58dataAC94B0A0.nested.template.json
   172540  amplifyd3dejqzs77khq6mainbranch0feb70fa58dataamplifyDataFunctionDirectiveStack88D308B6.nested.template.json
data stack: 968579 bytes, 31421 under the 1000000 cap (guard 995000: 26421)
resources:  460 of 500
asset key:  5473ee1581cddbe472ce9f818ecd3998ceb2d636746bd91d69e37c4766b334e2
top 5: tmsdirectoryactionslambdaC060C7E2=3495, driverappapilambda665E2DED=2876, workflowagentlambda4BAD616E=1872, tmsspotquoterlambdaD7208187=1610, tmstrackingactionslambda6EA07509=1549
```

| Measure | dev | prod-shape (what main would deploy) | Cap | Headroom (prod-shape) |
|---|---|---|---|---|
| Data stack template | 964,387 B | **968,579 B** | 1,000,000 | 31,421 B = **3.14%** of the cap |
| vs guard 995,000 | 30,613 under | 26,421 under | 995,000 | 2.66% |
| Resources (data stack) | 460 | **460** | 500 | 40 (8%) |
| `amplifyDataFunctionDirectiveStack` nested | 171,937 B | 172,540 B | 1,000,000 | 82% free |
| Largest Lambda env (est.) | 3,478 | 3,495 (tmsDirectoryActions) | limit 3,900 / hard 4,096 | 405 |

No stack is over a cap or the guard; the data stack is the only one near a cap. It is 0.14 points outside the "within 3%" band to the 1,000,000 cap, and 2.66% to the 995,000 guard, so there is essentially no room for another step's models before the next deploy: measured growth since the 11-04 numbers in `CUTOVER_PLAN.md` L342 (962,490 B / 457 resources) is +6,089 B and +3 resources. With nothing else in the schema moving, a merged tree that adds more than ~30 KB (e.g. 5-8 more models with GSIs) would breach 1,000,000.

### Proposed nested-stack split plan (contingency; not required to deploy this tree)

Because the headroom is thin, prepare this but only execute if a later change pushes the prod-shape over the guard (exit 4):
1. Keep `resourceGroupName: 'data'` for the Lambdas that must reference data tables (`tms*Actions`, `workflowAgent`, `tmsDashboardRollup`).
2. Move the heaviest, least-coupled Lambdas, their policies and event-source mappings into a new resource group (e.g. `resourceGroupName: 'ops'`): `tmsDataSafety` + `DataSafetyBucket`, `mcpSync`, `trackingAutomation`, `checkCallNotifier`, `loadTrackingProjector`, `shipmentNotifier`. Each Lambda moves its function, role, policy statements, log group and Function URL out of the data stack (each `addToRolePolicy` becomes IAM Policy resources; 221 `PolicyStatement`s are what drives the size). Moving them also removes their share of the 500 resources.
3. Cross-stack references (table ARNs/names, stream ARNs) become CloudFormation parameters/exports between nested stacks; keep `Stack.of(fn)` mapping code working by looking up the stack from the Lambda rather than assuming the data stack. Verify with `node scripts/measureDataTemplate.mjs --prod-shape` that the data stack drops below ~900,000 B before and after.
4. A split moves existing deployed resources between nested stacks, which on production means delete-and-recreate of those Lambdas (new ARNs, new Function URLs for any with URLs). Do it on dev first, outside the cutover window, never in the same deploy as the +49-table merge. Do NOT split resources that production already has in the data stack (Load/other tables, existing Lambdas) in the cutover deploy.
5. Cheaper lever first: consolidate duplicated per-Lambda `PolicyStatement`s into one managed policy per Lambda group (statement count 221 -> far fewer) before moving anything.

Recommendation for Gate A/B: treat 968,579 B / 460 as the number of record for the prod shape, require P4 (throwaway-branch deploy) to confirm CloudFormation accepts it, and freeze new models until after cutover.

## 7. Reproduction

```
mkdir -p /tmp/aw/main /tmp/aw/merged
git archive origin/main amplify package.json | tar -x -C /tmp/aw/main
cp -R amplify package.json /tmp/aw/merged/
ln -sfn "$PWD/node_modules" /tmp/aw/main/node_modules; ln -sfn "$PWD/node_modules" /tmp/aw/merged/node_modules
echo "export { schema as __schema }" >> /tmp/aw/{main,merged}/amplify/data/resource.ts
# tsImport the file, then schema.transform().schema -> SDL; diff SDLs with graphql-js `parse`
node scripts/measureDataTemplate.mjs --branch dev
node scripts/measureDataTemplate.mjs --prod-shape
```

Caveat: this is a source-to-source diff against `origin/main`, not against a deployed template. `GSI_DEPLOY_SEQUENCE.md` already established that main's synth equals prod's deployed tables with zero differences (as of the 11-04 main tip `a90a2a3`); main has since moved to `ff4489dd` (hours commits #135/#136), which is the baseline of this diff (the diff was taken against `ff4489dd`, so those commits are in main's side).
