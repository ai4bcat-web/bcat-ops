# TMS merge: stage 0 (BCAT_SCHEMA_STAGE=0)

Merges `merge/main-into-dev` into production `main` and deploys it with `BCAT_SCHEMA_STAGE=0` (procedure and the warning about never lowering the stage: `Docs/tms-build/AW_STAGED_DEPLOY.md`). Stage 0 puts the merged frontend, the new Lambdas and custom operations, and 244 optional fields on 9 existing tables live. It creates NO table and changes NO index.

Evidence: `node scripts/stageDeployCheck.mjs --baseline-ref origin/main --stages 0 --keep` run for this PR (origin/main = `17f71c3e`, includes the GSI prep). Output: `stage 0 | models + 0, fields + 244 | created 147, updated 245, deleted 25 | TOTAL 417`, `OK`. Stage-0 data stack as synthesized by that run: 697,466 B / 393 resources (baseline origin/main: 758,677 B / 310). The 968,472 B / 460 figure in the gates below is the full-schema shape (unset stage). Per-resource lists below come from a diff of the kept templates (`diffTemplates` in `scripts/stageDelta.mjs`). Anything not observed is marked UNVERIFIED.

Read-only AWS reads against production were made for sections 3 and the GSI/PITR note (Lambda configuration key names, event/URL configs, DynamoDB describe calls). No writes, no secret values.

---

## RISK LIST (read this first)

| # | Severity | Risk | Reason (cited) | Recommended guard (NOT applied here) |
|---|---|---|---|---|
| R1 | **HIGH, product** | **Creating a new load/shipment fails at stage 0.** Calendar "add load", Dispatch/Tasks "New load", Intake "Build load", Factoring "Create load", Duplicate, and `/tms/shipments/new` all call `createShipment`/`duplicateShipment` -> `tms-shipment-actions` `CREATE_SHIPMENT`. That Lambda writes Shipment, Order, LoadFinancials, LoadCharge, ProClaim in one `TransactWriteItems` (`amplify/functions/tms-shipment-actions/handler.ts:2197-2210`) BEFORE `Load.create` (`:2237`). Those tables do not exist until stage 2 and their env vars are dropped at stage 0. The old client `createLoad` is also refused (client auth is read+update only: `AW_CREATELOAD_AUDIT.md`, `amplify/data/resource.ts:229-238`). No frontend guard: the new-shipment entry points are not wrapped by `modelsAvailable` (grep of `src/features/{shipments,calendar,tasks,factoring}`, `src/hooks`, `src/store` finds it only in `useShipments`/`useWorkflowExceptions`). Editing existing loads (`updateLoad`) is unchanged. | Decision for Ryne before go: stage 0 = no new loads from the UI until stage 2 (the same window dispatch would have to enter loads some other way). Code guard if unacceptable: keep the legacy client create path until stage 2 (re-allow `create` on Load and route `openNewShipment` to it while `!modelsAvailable(SHIPMENT_MODELS)`), or run stages 0-2 back to back. UNVERIFIED whether rehearsal2 exercised "add load" at stage 0. **Operator note (OPEN, not fixed in this PR):** run stages 0, 1 and 2 back to back (stage 0 takes 45-60 min; start 1-3 as soon as each SUCCEEDs). Until stage 2 finishes, anything that creates a load or shipment (Calendar "add load", Dispatch/Tasks "New load", Intake "Build load", Factoring "Create load", Duplicate, `/tms/shipments/new`) fails and the user sees the error returned by the `tms-shipment-actions` Lambda (nothing is created; exact text not captured). Editing existing loads, dispatch, calendar viewing, driver app and everything in section 8 "keep working" are unaffected. Tell dispatch beforehand not to enter new loads in that window. |
| R2 | ~~HIGH~~ **FIXED** | **Vendor / maintenance-invoice AP intake keeps working exactly as production today until stage 3.** `vendor-ap-extract` (source restored from origin/main: `amplify/functions/vendor-ap-extract/*`, wiring in `amplify/backend.ts` behind `vendorApExtractLegacy(stage)`) is NOT deleted at stage 0. Below stage 3 `vendor-ap-intake` still has `VENDOR_AP_EXTRACT_FUNCTION_NAME` = vendor-ap-extract with the `{ id }` payload (no `VENDOR_AP_EXTRACT_TARGET` set; `amplify/functions/vendor-ap-intake/extractPayload.ts`). At stage 3 (the stage that creates WorkflowRun, `VENDOR_AP_EXTRACT_RETIRED_STAGE` in `amplify/data/stages.ts`) the env var is repointed at `workflow-agent`, `VENDOR_AP_EXTRACT_TARGET=workflow-agent` switches the payload to the `runFor` hand-off, and the old Lambda (function + role + policy, 3 resources) is deleted in that same stage. `scripts/stageDeployCheck.mjs` allows that deletion only at stage 3. Caveat: between the intake env update and the Lambda deletion inside the stage-4 deploy, an invoice arriving in that minute may hit the old Lambda while it is being removed (the invoke is wrapped in try/catch and only warns; the row exists; re-run extraction for it afterwards if its fields stay empty). | None needed. |
| R3 | ~~Medium~~ **FIXED** | The five new schedule triggers that fail without their tables are NOT created below the stage that creates their tables (`TRIGGER_MODELS` / `triggerEnabled` in `amplify/data/stages.ts`): `WorkflowAgentSweepRule` (stage 3, WorkflowRun), `SpotQuoterPollRule` (stage 1, SpotRequest/SpotSettings/GmailConnection/Integration), `McpSyncRule` (stage 1, Carrier/Integration), `DataSafetyNightlyExportRule` + `DataSafetyNightlyCheckRule` (stage 3, Shipment/DataExportJob), `tracking-automation` Scheduler schedule (stage 2, Shipment/LoadCheckCall). The Lambda functions stay deployed at stage 0; only their triggers wait. Measured by `stageDeployCheck`: stage 0 creates 1 Events::Rule (`ApInboxHourlyRule`, quiet disabled skip), 1 Scheduler schedule (`check-call-notifier`, Load GSI only, 0 rows), 2 event-source mappings (Load stream, `shipmentId` gate); stage 1 adds McpSync + SpotQuoterPoll; stage 2 adds the tracking-automation schedule; stage 3 adds 4 rules (WorkflowAgentSweep, 2 DataSafety, DashboardRollupSweep) and 6 stream mappings. Residual: the tracking-automation Scheduler IAM role (`SchedulerRoleForTarget...`, no schedule) and the `TrackingAutomationInvoke` permission still exist at stage 0 and are inert. | None needed. |
| R4 | Low | `GOOGLE_MAPS_API_KEY` and `GEOCODE_TOKEN_SECRET` do not exist in SSM (already true on production today for `tms-geocode`; the merge widens `GOOGLE_MAPS_API_KEY` to 3 Lambdas). Deploy does not fail (`AW_SECRETS_ENV_AUDIT.md`). | Ryne creates them (`npx ampx secret set ...`) before the deploy so warm instances do not carry the gap. |
| R5 | Low | Thin margins: `tms-directory-actions` env 3,495 / 3,900 est. bytes (hard cap 4,096); the full-schema data template is 968,472 B / 1,000,000 (stage 0 itself is 697,466 B). | None for stage 0; later stages. |

No handler in the new set can send e-mail, text, Slack or spend Anthropic money at stage 0 (verified per handler in section 2). There is no outbound-world RISK.

---

## 1. Lambdas

### 1a. 18 NEW Lambdas (all created; trigger = what can invoke it at stage 0)

| Lambda (`amplify/functions/...`) | Purpose | Trigger at stage 0 |
|---|---|---|
| tms-shipment-actions | Shipment lifecycle: create/duplicate/void, order form, PRO, credit, carrier assign (writes Shipment/Order/Load) | AppSync mutation `tmsShipmentActions` (+ invoked by tms-spot-quoter) |
| tms-carrier-actions | Carrier directory, documents, payment methods | AppSync mutation `tmsCarrierActions` |
| tms-tracking-actions | Tracking links, check calls, POD requests, shipment messages, geocode/AI enrichment | AppSync `tmsTrackingActions`; invoked by tracking-automation and shipment-email-intake |
| tms-finance-actions | AR/AP, invoicing, payments, SES invoice e-mail | AppSync `tmsFinanceActions` |
| tms-crm-actions | CRM contacts/accounts, Anthropic-assisted | AppSync `tmsCrmActions` |
| tms-spot-quoter | Spot-quote Gmail poller and carrier-call webhook (Anthropic) | AppSync `tmsSpotActions`; EventBridge rule `SpotQuoterPollRule` (5 min; created at stage 1, NOT at stage 0); Function URL `CarrierCallUrl` (NONE) |
| tms-ap-inbox | Accounting AP inbox (Gmail + Anthropic) | AppSync `tmsApInboxActions`; EventBridge rule `ApInboxHourlyRule` (1 h) |
| workflow-agent | Workflow runs (tender, AP extraction replacing vendor-ap-extract, etc.; Anthropic) | AppSync `tmsWorkflowActions`; Function URL `WorkflowAgentUrl` (NONE, `INBOX_SECRET`); EventBridge rule `WorkflowAgentSweepRule` (15 min, `{sweep:true}`; created at stage 3, NOT at stage 0); async invoke from vendor-ap-intake and the other intake bridges |
| tms-aljex-import | Aljex legacy importer (900 s, 1,536 MB) | AppSync mutation `tmsAljexImport` only |
| tms-data-safety | Nightly PITR exports, CSV exports, DataSafety bucket | AppSync `tmsDataSafety`; EventBridge rules `DataSafetyNightlyExportRule` (07:15 UTC) and `DataSafetyNightlyCheckRule` (10:15 UTC), both created at stage 3, NOT at stage 0; self-invoke |
| tms-dashboard-rollup | Dashboard rollup recompute | NONE at stage 0 (its stream mappings and 5-min sweep rule are not created at stage 0: only 2 mappings and no `DashboardRollupSweepRule` exist in the stage-0 diff) |
| shipment-email-intake | E-mail webhook -> shipment message | Function URL `ShipmentEmailIntakeUrl` (NONE, secret in body) |
| mcp-sync | MyCarrierPackets sync | EventBridge rule `McpSyncRule` (30 min; created at stage 1, NOT at stage 0) |
| load-tracking-projector | Load stream -> check-call rows | DynamoDB stream mapping `LoadTrackingProjectorStreamMapping` (Load stream, LATEST, batch 10, retry 2) |
| shipment-notifier | Load stream -> customer milestone / carrier POD e-mail via SES | DynamoDB stream mapping `ShipmentNotifierStreamMapping` (Load stream) |
| check-call-notifier | Slack alerts for due check calls | EventBridge **Scheduler** schedule `checkcallnotifierlambdaschedule0` cron `*/5 * * * ? *`, ENABLED |
| tracking-automation | Runs auto check-call / POD passes | EventBridge **Scheduler** schedule `trackingautomationlambdaschedule0` cron `*/5 * * * ? *`, ENABLED, created at stage 2, NOT at stage 0; invokes tms-tracking-actions `RUN_TRACKING_AUTOMATION` |
| rate-con-sign-api | Public rate-confirmation signing API | Function URL `RateConSignApiUrl` (NONE, one-time token) |

### 1b. 47 UPDATED Lambdas (names only)

- AppSync-bound (17): vendor-ap-actions, pay-credit-approval, slack-status-notifier, user-management (timeout 3 s -> 30 s), onboarding-emailer, driver-pay-emailer, appt-request-emailer, ratecon-parser, trip-screenshot-parser, vehicle-quote-emailer, appt-need-notifier, google-reviews, tms-directory-actions, tms-geocode, pod-actions, otr-actions, dispatch-actions.
- Function-URL / webhook / API (12): slack-intake-webhook, gmail-task-intake, twofa-intake, factoring-intake, vendor-ap-intake, fuel-import, amazon-dispute-intake, onboarding-portal-api, dispute-portal-api, tracking-api (URL CORS changed), driver-app-api, dispatch-twilio-webhook.
- Already-live schedules (12): generate-recurring-expenses, motive-mileage-sync, motive-odometer-sync, motive-location-sync, motive-fault-sync, blueink-sync, intake-reconcile, compliance-scanner, paychex-pay-sync, appt-report, cash-checkin-reminder, otr-status-sync.
- Load stream consumers (2): broker-load-alert, ratecon-assigned-text.
- Other (4): driver-signup-gate, driver-welcome, dispatch-slack-bridge, dispatch-nudge.

These Lambdas change because the merged code and environment ship (new env vars, IAM, secrets). Their handler diffs against origin/main were not reviewed line by line for this PR (UNVERIFIED); the trigger set of every Lambda in this list is unchanged except the two rules below.

---

## 2. Triggers that are ENABLED on production at stage 0

`BCAT_DEV_STACK` is not set on `main` (and the synth throws if it is, `backend.ts:4287-4290`), so none of the dev-only disabling applies. Counts from the diff (after the R3 gates): 1 new EventBridge rule (`ApInboxHourlyRule`), 1 new Scheduler schedule (`check-call-notifier`), 2 new event-source mappings, 4 new Function URLs; 2 existing rules touched (ApptReportDailyRule, CashCheckinReminderDailyRule, both stay ENABLED; same cron), 1 existing Function URL touched (TrackingApiUrl CORS).

| Trigger | Can act on the outside world? | What it does at stage 0 (tables absent) |
|---|---|---|
| Scheduler: check-call-notifier, every 5 min | Slack DM/post to staff (not drivers/customers), via `SLACK_BOT_TOKEN` | Queries the Load GSI `checkCallOpen='OPEN'`. GSI is ACTIVE on production Load (checked). `checkCallOpen` is null on every existing row (new field), so 0 rows and no message. Order / LoadCarrier envs absent but only used per due load. No send. Will DM reps once something sets `checkCallOpen`. |
| **NOT CREATED at stage 0 (R3; created at stage 2)**: Scheduler: tracking-automation, every 5 min | tms-tracking-actions can send Twilio SMS / SES e-mail to drivers and carrier dispatchers (not customers) when switches are on (default off) | POD pass queries Shipment (absent) outside a try: throws each run. No send. See R3. |
| **NOT CREATED at stage 0 (R3; created at stage 3)**: Rule: WorkflowAgentSweepRule, 15 min | Anthropic/none in sweep | Queries WorkflowRun `''`: throws each run. No send, no spend. |
| **NOT CREATED at stage 0 (R3; created at stage 1)**: Rule: SpotQuoterPollRule, 5 min | Gmail read + Anthropic when connections exist | Throws on unguarded Scan of GmailConnection `''` before any Gmail/SSM/Anthropic call. No send, no spend. |
| Rule: ApInboxHourlyRule, 1 h | Gmail + Anthropic when enabled | `scheduled && !config.enabled` -> quiet `DISABLED` skip (`tms-ap-inbox/sync.ts:136`); `apInbox.enabled` defaults false. No error, no send, no spend. |
| **NOT CREATED at stage 0 (R3; created at stage 1)**: Rule: McpSyncRule, 30 min | MyCarrierPackets API | Credentials SSM param absent -> null; then `readRow` on Integration `''` throws. No MCP call. |
| **NOT CREATED at stage 0 (R3; created at stage 3)**: Rules: DataSafetyNightlyExportRule / NightlyCheckRule | DynamoDB export to the new S3 bucket (cost) | Throws at `suffixFromShipmentTable('')` before ListTables/export (`export.ts:123-126`). Also production tables have PITR DISABLED (checked on Load and TruckLocationHistory), and the code skips non-PITR tables (`SKIPPED_NO_PITR`). No export, no cost, no Slack/e-mail. |
| Stream mapping: ShipmentNotifierStreamMapping (Load stream) | SES e-mail to customers (milestones) and carriers (POD request) | Needs `shipmentId` set on the Load (new field, null on all existing rows); legacy rows return before any read. Shipment/ShipmentNotice lookups fail caught per record. No e-mail from ordinary dispatch edits. |
| Stream mapping: LoadTrackingProjectorStreamMapping (Load stream) | None (writes own tables) | Same `shipmentId` gate; if it ran it would throw writing LoadCheckCall, retry 2, drop. Load writes and the other consumers (broker-load-alert, ratecon-assigned-text) are independent iterators and unaffected. The Load stream now has four consumers (AWS advises two per shard: UNVERIFIED impact). |
| Function URL RateConSignApiUrl (NONE) | Public, token-gated | No token -> 400; with token -> Scan of LoadCarrier `undefined` -> 500. Cannot sign or write. |
| Function URL ShipmentEmailIntakeUrl (NONE) | Secret-gated | Bad secret 401. Valid secret -> downstream tms-tracking-actions call fails -> 502 (UNVERIFIED). No outbound mail. |
| Function URL WorkflowAgentUrl (NONE) | Secret-gated (`INBOX_SECRET` = `INTAKE_WEBHOOK_SECRET`) | WorkflowRun does not exist until stage 3, so a call fails (vendor-ap-intake no longer targets it below stage 3, R2; the other bridges that invoke it in `backend.ts` wrap the call in try/catch and only warn, per the code comments; not exercised here: UNVERIFIED). |
| Function URL CarrierCallUrl (NONE) | Body secret | `getConfigRaw` throws (SpotSettings `''`) -> 500; nothing accepted. |
| Existing rules ApptReport / CashCheckinReminder, Motive (6), Blue Ink (2), Paychex weekly, compliance, intake-reconcile, recurring expenses | Slack, Motive, Blue Ink, Paychex as today | Unchanged schedules, live today. |

---

## 3. Deleted resources: 25 (all API resolvers; no table, no data, no Lambda)

| Resource | Count | User-visible consequence |
|---|---|---|
| Load `deleteLoad` mutation (3 AppSync functions + `DeleteLoadResolver`) | 4 | A PRO is permanent; the UI has no Load hard-delete any more (`LoadDrawer`, calendar delete, grid delete removed); void/unvoid exist but are `tms-shipment-actions` (stage 2). A stale tab on the old bundle gets a GraphQL validation error. |
| Load `onDeleteLoad` subscription (3 functions + resolver) | 4 | Stale tabs lose delete-sync; create/update subscriptions remain. |
| TruckLocationHistory client `create` (5 functions + resolver), `update` (5 + resolver), `delete` (4 + resolver) mutations | 17 | Clients can no longer write location history (only Lambdas do; no client caller found in `src`). Reads stay. |
| Lambda `vendor-ap-extract` (function + role + default policy) | 0 at stage 0 (3 at stage 3) | Kept until stage 3, see R2. |
| Total | 4 + 4 + 17 = 25 (20 AppSync FunctionConfigurations, 5 Resolvers; matches the synth) | |

`scripts/stageDeployCheck.mjs` fails on any other deletion.

Note a doc correction (`AW_CREATELOAD_AUDIT.md`): `createLoad` is NOT removed from the schema; it stays IAM-only for `tms-shipment-actions`, and signed-in client tokens get Not Authorized. Production's old bundle called it from the calendar/loads page; a stale tab fails on add-load until reload.

### Vendor AP / maintenance-invoice intake after stage 0 (production reads, key names only)

- Production `vendor-ap-extract` (`amplify-d3dejqzs77khq6-ma-vendorapextractlambda77F-fjPilcCGbkLG`, nodejs22, 90 s, 1,024 MB, env keys TABLE_NAME, AMPLIFY_SSM_ENV_CONFIG, BUCKET_NAME, ANTHROPIC_API_KEY): no Function URL, no event-source mapping, no EventBridge rule targets it. It runs only by async invoke from vendor-ap-intake.
- Production `vendor-ap-intake` (`...-ma-vendorapintakelambdaAB4C-U1IRNpviH5ay`): Function URL authType NONE, 30 s, env keys TABLE_NAME, VENDOR_AP_EXTRACT_FUNCTION_NAME, AMPLIFY_SSM_ENV_CONFIG, VENDOR_AP_INTAKE_SECRET, BUCKET_NAME; no rules/mappings. It is the ONLY production Lambda whose environment references `VENDOR_AP_EXTRACT_FUNCTION_NAME` (scan of all `amplify-d3dejqzs77khq6-ma-*` function environment key names).
- What calls the intake URL (Gmail forwarder, Slack, other) was not determined: UNVERIFIED.
- After stage 0 NOTHING changes for this path: the intake still invokes `vendor-ap-extract` with `{ id }` (R2 fixed). At stage 3 the intake is repointed to `workflow-agent` and the old Lambda is deleted.

---

## 4. Schema: 244 additive fields, AppSync update

From the synth (`fields added to existing models`): Load +50, Customer +51, Location +1, Division +11, TmsSettings +116, FactoringItem +4, VendorPayable +3, TruckConfig +2, TruckLocationHistory +6 = 244. All optional. (`AW_SCHEMA_DIFF.md` and `AW_STAGED_DEPLOY.md` carry older counts, 241 and 54/47/113 for Load/Customer/TmsSettings; the script output above is the current number.) No new models/tables (60 -> 60), no key, type, enum-member or GSI change, no removed field.

Big groups:
- Load (50): shipment link (`orderId`, `loadNumber`, `leg`, `shipmentId` already via GSI prep), status change trail, carrier assignment (`carrierRepId`, `activeLoadCarrierId`, `carrierName`), tracking (`lastKnown*`, `checkCall*` planning/escalation), revenue division tags (`revDivision`, `revSubdivision`, ...), `previousStatus`, `voidedAt`.
- Customer (51): billing (`billingMethod`, `apEmail`, `invoiceCopyEmails`), status lifecycle, credit and terms, contacts/bill-to, tracking and quoting defaults, integrations ids (`project44CustomerId`, `hubspotId`, `haulpayDebtorId`).
- TmsSettings (116): numbering (`shipmentPrefix`, `nextShipmentNumber`, `invoiceSeriesStart`), credit defaults, carrier rules, check-call defaults (`checkCall*`), AP inbox config, stage labels, rate-con terms.
- Division (11): `taxId`, contacts, invoice verbiage, `logoKey`, `isPrimary`.
- Others: Location `aljexCode`; FactoringItem `source`, `invoiceId`, `orderId`, `shipmentId`; VendorPayable `apInboxItemId`, `apInboxSourceUrl`, `apInboxAppliedAt`; TruckConfig `phone`, `phoneLabel`; TruckLocationHistory `loadId`, `accuracyM`, `approx`, `refId`, `ttlEpoch`, `payload`.

AppSync: `GraphQLSchema` updated (1), 10 new Lambda data sources + 10 new Mutation resolvers (`tmsShipmentActions`, `tmsWorkflowActions`, `tmsSpotActions`, `tmsApInboxActions`, `tmsCrmActions`, `tmsCarrierActions`, `tmsTrackingActions`, `tmsFinanceActions`, `tmsAljexImport`, `tmsDataSafety`), 20 new and 4 updated FunctionConfigurations, 25 removed (section 3). Production Load table `Load-5ucwdyvwivelbo4k4jomvrwel4-NONE` already shows the four GSIs ACTIVE (loadsByStatus, loadsByShipmentId, loadsByCheckCallOpenAndNextCheckCallAt, loadsByCustomerId): the stage-0 prerequisite is met.

---

## 5. IAM (summary from the template diff)

New: 30 roles (18 Lambda roles + 2 Scheduler roles + 10 AppSync data-source roles), 33 policies, 18 Lambda invoke permissions. Updated: 62 roles, 55 policies, 1 managed policy (mostly the shared per-Lambda grants: new env tables, SSM, SES, Cognito `AdminGetUser`). Deleted at stage 0: none (vendor-ap-extract role and policy are deleted at stage 3).

Broad or notable actions added (by role):
- `ssm:DeleteParameter` (with Get/Put): tms-directory-actions (integration param path `/*`), tms-spot-quoter (Gmail token path `/*`), tms-ap-inbox (only `.../ap-inbox`).
- `dynamodb:ExportTableToPointInTime`, `DescribeTable`, `DescribeContinuousBackups`, `ListTables` (`*`), `DescribeExport`: tms-data-safety only, scoped to table ARN patterns of its own API id (`backend.ts:3262-3278`).
- S3 `PutObject` / `DeleteObject`: tms-data-safety (new bucket); tms-spot-quoter and tms-ap-inbox (`DeleteObject`, `PutObject`); `PutObject` on the existing app bucket for tms-aljex-import, -carrier-, -finance-, -shipment-, -tracking-actions, workflow-agent, tracking-api. Cognito authenticated/ADMIN/DISPATCHER roles gain `s3:PutObject`/`DeleteObject` for the new storage prefixes (`workflow-inbox/*`, `carrier-docs/*`, `shipment-docs/*`, `invoices/*`, `remittances/*`, `brand/*`, `imports/*`; `amplify/storage/resource.ts`).
- `ses:SendEmail`/`SendRawEmail` on `*`: shipment-notifier, tms-finance-actions, tms-shipment-actions, tms-tracking-actions (same pattern as existing mail Lambdas).
- DynamoDB `BatchWriteItem`/`TransactWriteItems`/`DeleteItem`: tms-aljex-import, tms-shipment-actions, tms-carrier-actions, tms-directory-actions, driver-app-api (`BatchWriteItem`, `DeleteItem`), user-management (`DeleteItem`).
- Cognito: `AdminGetUser` on 11 new Lambdas; user-management adds `AdminUserGlobalSignOut` (full user-management set re-issued).
- No `iam:*`, `sns`, `sqs`, `kms` or wildcard-resource destructive actions were found in the added statements (filter in this review: ssm, ses, s3, dynamodb, cognito, lambda:InvokeFunction, iam, events, scheduler).

---

## 6. New infrastructure

- S3 bucket `DataSafetyBucket` (+ bucket policy), public access blocked. Lifecycle: `exports/nightly/` 35 d, `exports/manual/` 35 d, `exports/csv/` 7 d, `imports/jobs/` 30 d, `imports/runs/` 365 d, noncurrent versions 90 d, incomplete multipart 7 d. Empty and unused at stage 0.
- SSM parameter `/bcat/tracking-actions/46198baffbf671f8/function-name` (name of tms-tracking-actions; production already has `/bcat/tracking-actions/ab7f791936be5ce5/function-name` for dispatch-twilio-webhook: whether the dispatch webhook reads the new one is UNVERIFIED).
- Function URLs (4 new, all authType NONE; auth is inside the handler): `RateConSignApiUrl` (CORS POST), `ShipmentEmailIntakeUrl`, `WorkflowAgentUrl`, `CarrierCallUrl` (on tms-spot-quoter). Updated: `TrackingApiUrl` (CORS origins). No IAM-auth URL was added.
- 1 EventBridge Scheduler schedule + 1 EventBridge rule + 2 event-source mappings (section 2). New outputs: `RateConSignApiFunctionUrl`, `ShipmentEmailIntakeFunctionUrl`, `CarrierCallFunctionUrl`, `WorkflowAgentFunctionUrl`.
- 2 `Custom::CDKBucketDeployment` and 3 bucket policies updated (existing buckets).

---

## 7. Secrets and environment (`AW_SECRETS_ENV_AUDIT.md`)

- No new secret NAMES: the 14 distinct `secret()` names are identical to origin/main. Only new uses: tms-directory-actions reads 13 (OTR x3, MOTIVE, BLUE_INK, GOOGLE_MAPS, ANTHROPIC, SLACK_BOT_TOKEN/SIGNING_SECRET/CHANNEL_MAPPING, PAYCHEX x2, GEOCODE_TOKEN_SECRET); ANTHROPIC_API_KEY +5 Lambdas (tms-ap-inbox, tms-crm-actions, tms-spot-quoter, tms-tracking-actions, workflow-agent; vendor-ap-extract keeps it until stage 3); SLACK_BOT_TOKEN +2 (check-call-notifier, tms-directory-actions); INTAKE_WEBHOOK_SECRET +2 (shipment-email-intake, workflow-agent).
- Exist in the shared SSM path for main: ANTHROPIC_API_KEY, BLUE_INK_TECH_API_KEY, INTAKE_WEBHOOK_SECRET, MOTIVE_API_KEY, OTR_USERNAME/PASSWORD/SUBSCRIPTION_KEY, PAYCHEX_CLIENT_ID/SECRET, SLACK_BOT_TOKEN/CHANNEL_MAPPING/SIGNING_SECRET.
- Degrade-only (missing, deploy still succeeds): `GOOGLE_MAPS_API_KEY` (tms-geocode, tms-tracking-actions, tms-directory-actions) and `GEOCODE_TOKEN_SECRET` (tms-geocode, tms-directory-actions): geocoding and route-miles features stay off. Also missing, runtime-only: `/bcat/integrations/<pool>/MYCARRIERPACKETS`, `/OPENAPI`, `/GMAIL_REP_OAUTH`, per-rep Gmail tokens (MCP and Gmail features stay off).
- Synth-time env: `AWS_APP_ID`, `BCAT_DEV_STACK` (must stay unset on main), `CDK_CONTEXT_JSON`, `PORTAL_ORIGIN` (must stay unset on main) are all optional. Branch `main` today has `PAYCHEX_COMPANY_ID`, `VITE_ONBOARDING_API_URL`; `BCAT_SCHEMA_STAGE=0` must be ADDED to the full map (`set_stage` in `AW_STAGED_DEPLOY.md`, which replaces the whole map).
- Audit date for those reads: 2026-11-07 (names only).

---

## 8. Frontend (ships whole at stage 0)

- The merged frontend with the dev UI styling and the BCAT production-blue palette (`Docs/tms-build/AW_PALETTE.md`: brand blue `#1ea8f3`, dark `#0369a1`, tint `#e6f4fd`; semantic greens/reds/ambers unchanged).
- Six-tab lifecycle strip in the TMS top bar: Quote, Build, View, Book, Track, Review (`STEP_AV_LIFECYCLE_TABS.md`, `src/lib/navSections.ts`), plus an "Active shipments" sidebar row. At stage 0 all six are shown but disabled (`aria-disabled`, tooltip "Switches on during the merge", no navigation) because their models do not exist.
- Sidebar: Brokerage section (Company Dashboard, Active shipments, Customers, Carriers, Locations), Accounting group (AR, AP, Vendors, Factoring), Settings group (General & automation, Company, Divisions & ownership, Users & roles, Integrations, AI agents, Spot quoter, Carrier Sales, Commissions, Reports, Audit log, Compliance, Platform health, Demo). Dormant rows are disabled with no badge.
- Billing method fields on the Customer form / Billing setup and the Jenny-only billing release grant (Cognito group `page-billingRelease`, `amplify/functions/tms-finance-actions/store.ts:80-84`; judged by the group alone, no ADMIN bypass) are present but inert: no invoices exist. Whether a customer edit at stage 0 writes the new `billingMethod` field: UNVERIFIED (it is an optional field on an existing table).
- Landing: `/` and `/tms` land on the production `/dashboard` while the Company Dashboard is dormant. A bookmarked `/loads` or `/loads/:id` lands on `/calendar` (the old loads grid page no longer exists in the merged frontend; `/loads` and `/grid` are redirects to `/tms/shipments`, which is dormant). This is a visible change.

Dormant until their stage (`AW_DORMANT_PAGES.md`; empty state: "<Area> turns on during the merge ... Nothing is wrong and no data is lost. Existing pages keep working." with a back link):

| Stage | Pages |
|---|---|
| 1 | Carriers (list, Find and invite), Settings > Commissions, Divisions & ownership, Integrations, Spot quoter & e-mail |
| 2 | Shipments board/new/edit/detail, Intake, Carrier Sales, Load Tracking and Customer links, Load Review, Quotes and Spot inbox, Carrier profile, Billing setup |
| 3 | Company Dashboard, Accounts Receivable, Accounts Payable, Workflows and run trace, Reports, AI agents, Demo, Import, Aljex import, Aljex reconciliation, Data & backups |

Reads that degrade silently (no toast): the `apiClient` flags seeded from the deployed schema and the new early returns listed in `AW_DORMANT_PAGES.md`; `useShipments`, `useShellBadgeCounts`, `useNotifications`, `useWorkflowExceptions`, `useSpotNewCount` zero out with no request.

Production pages that keep working unchanged (models are production models; click through after deploy): Dispatch, Calendar (view/edit existing loads), Driver info/Drivers, Hours, Time off, Files, Fleet, Fuel, Maintenance, Insurance, Appts, Tasks, Reddit queue, Feedback, Compliance, Finances, Customers, Locations, Vendors, Factoring, Settings (general), Users, Audit, Company/Billing/Branding/Notifications/Account, Carrier Sales settings. Exceptions to "unchanged": the loads grid (gone), and creating a load (R1).

---

## 9. What does NOT happen at stage 0

- No tables (60 -> 60), no GSI add/change/remove (the Load and AuditLog GSIs were deployed beforehand and are ACTIVE), no data movement, no importer run (tms-aljex-import is deployed but nothing invokes it), no backfill.
- No PITR change (PITR is no longer a stage: deferred, see `AW_STAGED_DEPLOY.md` "PITR (deferred, not part of the cutover)"): production Load and TruckLocationHistory show PITR DISABLED; DataSafety exports therefore skip even if they ran.
- No TTL change (stage 4): `ttlEpoch` is only a new optional field.
- Tax-ID vault not created (stage 1); Division `taxId` is just an optional field.
- Numbering untouched: `TmsSettings.nextShipmentNumber`, `invoiceSeriesStart` and friends are new null fields nothing writes at stage 0; PRO/shipment counters are not read or written.
- No Slack/SES/Twilio/Paychex/OTR/Motive/Gmail/MCP/Anthropic call is initiated by any new trigger (section 2).

---

## 10. Rollback, recovery, monitoring

- Do NOT lower `BCAT_SCHEMA_STAGE`. Never set it below the deployed stage (it would delete tables and data at later stages; at stage 0 there is nothing below to go to). Unsetting it deploys the WHOLE schema (all 49 tables in one release) and exceeds the per-operation limit that motivated staging: do not.
- If the stage-0 deploy fails: leave the variable at 0, read the first `*_FAILED` event (`aws cloudformation describe-stack-events` on the failing nested stack), fix on the branch, re-run `run_stage 0`. If the stack ends `UPDATE_ROLLBACK_FAILED`: `aws cloudformation continue-update-rollback --stack-name <root> [--resources-to-skip ...]`, then re-run stage 0. The TruckLocationHistory TTL warning applies to stage 4 only.
- Reverting the frontend/Lambdas by redeploying origin/main is NOT a rollback path: the stack would then lack the 18 Lambdas and the 244 fields' schema, and previously created resources get removed; use fix-forward.
- Expected duration: rehearsal2 stage 0 took 42 minutes (job 3 SUCCEED, `GO_NO_GO.md`). Plan for 45 to 60 minutes.
- Watch during the deploy: Amplify job phases (build, deploy), CloudFormation root stack `amplify-d3dejqzs77khq6-main-branch-*` and nested stacks (data, function, `DataSafety`), first `*_FAILED` events; after SUCCEED: Lambda Errors (expected: none new from scheduled triggers after R3), vendor-ap-intake invocations and vendor-ap-extract (unchanged, R2), AppSync 4xx on `createLoad`/`deleteLoad` from stale tabs, DynamoDB throttling on Load, SES send count (expect no change), Slack posts from check-call-notifier (expect none).

### Post-deploy smoke checklist (10 steps)

1. Log in (Cognito) with an admin and a dispatcher account; the app loads and the update banner appears on old tabs.
2. Dashboard (`/dashboard`) renders as before; `/` and `/tms` land there.
3. Dispatch: conversations list and an existing load open; no console GraphQL errors.
4. Calendar: existing loads appear; open one and save a harmless edit (updateLoad works). (R1: "add load" is expected to fail until stage 2.)
5. Driver app (`/driver-view` and the PWA) loads a driver's assigned load.
6. Factoring queue: items list and open one.
7. Generate a PDF (rate con, invoice PDF or POD from an existing load).
8. Hours page loads and shows current data.
9. Time off page loads and shows requests.
10. Open a dormant page (for example `/tms/shipments`, `/tms/invoicing`, `/tms/brokerage/reports`): the empty state "turns on during the merge" shows, with no error screen and no failed requests.

Extra checks: `/loads` redirect lands on `/calendar`; a test vendor invoice through the normal path works as today (R2 fixed).

---

## Gates (HEAD c96331c3b5efc08f45620bd9a0d370c6bf32b9e6)

Commit SHA: **c96331c3b5efc08f45620bd9a0d370c6bf32b9e6**

Gate numbers as reported by the build log: 925 test files / 11,174 tests passing, `tsc` x3 clean, eslint 0 warnings, build ok, full-schema data stack 968,472 B / 460 resources (stage-0 synth measured in this PR: 697,466 B / 393 resources; created 147 / updated 245 / deleted 25). These gate numbers were supplied with the assignment and not re-run here.
