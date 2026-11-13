import { defineBackend } from '@aws-amplify/backend'
import { AccountRootPrincipal, AnyPrincipal, ArnPrincipal, Effect, PolicyDocument, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam'
import { Alias, Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms'
import { AttributeType, BillingMode, ProjectionType, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb'
import { CfnFunction, Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType, HttpMethod, EventSourceMapping, FilterCriteria, FilterRule, StartingPosition } from 'aws-cdk-lib/aws-lambda'
import { CfnRule, Rule, Schedule, RuleTargetInput } from 'aws-cdk-lib/aws-events'
import { LambdaFunction as EventsLambdaTarget } from 'aws-cdk-lib/aws-events-targets'
import { ArnFormat, Aspects, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import type { IConstruct } from 'constructs'
import {
  UserPool,
  UserPoolClient,
  UserPoolEmail,
  UserPoolOperation,
  VerificationEmailStyle,
} from 'aws-cdk-lib/aws-cognito'
import { createHash } from 'node:crypto'
import { auth } from './auth/resource'
import { data } from './data/resource'
import { FINAL_STAGE, TTL_STAGE, currentSchemaStage, modelPresent, pitrEnabled, triggerEnabled, vendorApExtractLegacy } from './data/stages'
import { storage } from './storage/resource'
import { userManagement } from './functions/userManagement/resource'
import { slackIntakeWebhook } from './functions/slack-intake-webhook/resource'
import { gmailTaskIntake } from './functions/gmail-task-intake/resource'
import { shipmentEmailIntake } from './functions/shipment-email-intake/resource'
import { twofaIntake } from './functions/twofa-intake/resource'
import { factoringIntake } from './functions/factoring-intake/resource'
import { vendorApActions } from './functions/vendor-ap-actions/resource'
import { vendorApIntake } from './functions/vendor-ap-intake/resource'
import { vendorApExtract } from './functions/vendor-ap-extract/resource'
import { workflowAgent } from './functions/workflow-agent/resource'
import { apptNeedNotifier } from './functions/appt-need-notifier/resource'
import { slackStatusNotifier } from './functions/slack-status-notifier/resource'
import { payCreditApproval } from './functions/pay-credit-approval/resource'
import { fuelImport } from './functions/fuel-import/resource'
import { generateRecurringExpenses } from './functions/generate-recurring-expenses/resource'
import { motiveMileageSync } from './functions/motive-mileage-sync/resource'
import { motiveOdometerSync } from './functions/motive-odometer-sync/resource'
import { motiveLocationSync } from './functions/motive-location-sync/resource'
import { motiveFaultSync } from './functions/motive-fault-sync/resource'
import { blueinkSync } from './functions/blueink-sync/resource'
import { intakeReconcile } from './functions/intake-reconcile/resource'
import { complianceScanner } from './functions/compliance-scanner/resource'
import { onboardingPortalApi } from './functions/onboarding-portal-api/resource'
import { onboardingEmailer } from './functions/onboarding-emailer/resource'
import { driverPayEmailer } from './functions/driver-pay-emailer/resource'
import { vehicleQuoteEmailer } from './functions/vehicle-quote-emailer/resource'
import { googleReviews } from './functions/google-reviews/resource'
import { paychexPaySync } from './functions/paychex-pay-sync/resource'
import { dispatchActions } from './functions/dispatch-actions/resource'
import { dispatchTwilioWebhook } from './functions/dispatch-twilio-webhook/resource'
import { dispatchSlackBridge } from './functions/dispatch-slack-bridge/resource'
import { dispatchNudge } from './functions/dispatch-nudge/resource'
import { brokerLoadAlert } from './functions/broker-load-alert/resource'
import { rateconAssignedText } from './functions/ratecon-assigned-text/resource'
import { amazonDisputeIntake } from './functions/amazon-dispute-intake/resource'
import { disputePortalApi } from './functions/dispute-portal-api/resource'
import { trackingApi } from './functions/tracking-api/resource'
import { tripScreenshotParser } from './functions/trip-screenshot-parser/resource'
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods, ObjectOwnership } from 'aws-cdk-lib/aws-s3'
import { rateconParser } from './functions/ratecon-parser/resource'
import { apptReport } from './functions/appt-report/resource'
import { cashCheckinReminder } from './functions/cash-checkin-reminder/resource'
import { apptRequestEmailer } from './functions/appt-request-emailer/resource'
import { tmsDirectoryActions } from './functions/tms-directory-actions/resource'
import { mcpSync } from './functions/mcp-sync/resource'
import { tmsShipmentActions } from './functions/tms-shipment-actions/resource'
import { tmsCarrierActions } from './functions/tms-carrier-actions/resource'
import { tmsTrackingActions } from './functions/tms-tracking-actions/resource'
import { tmsFinanceActions } from './functions/tms-finance-actions/resource'
import { tmsAljexImport } from './functions/tms-aljex-import/resource'
import { tmsDataSafety } from './functions/tms-data-safety/resource'
import { tmsSpotQuoter } from './functions/tms-spot-quoter/resource'
import { tmsCrmActions } from './functions/tms-crm-actions/resource'
import { tmsApInbox } from './functions/tms-ap-inbox/resource'
import { tmsDashboardRollup } from './functions/tms-dashboard-rollup/resource'
import { devRuleState, devSesDeny } from './devRuleGuard'
import { SHIPMENT_ACTIONS_TABLES } from './functions/tms-shipment-actions/tableEnv'
import { TRACKING_ACTIONS_TABLES } from './functions/tms-tracking-actions/tableEnv'
import { FINANCE_ACTIONS_TABLES } from './functions/tms-finance-actions/tableEnv'
import { CRM_ACTIONS_TABLES } from './functions/tms-crm-actions/tableEnv'
import { ALJEX_IMPORT_TABLES } from './functions/tms-aljex-import/tableEnv'
import { loadTrackingProjector } from './functions/load-tracking-projector/resource'
import { shipmentNotifier } from './functions/shipment-notifier/resource'
import { checkCallNotifier } from './functions/check-call-notifier/resource'
import { trackingAutomation } from './functions/tracking-automation/resource'
import { rateConSignApi } from './functions/rate-con-sign-api/resource'
import { tmsGeocode } from './functions/tms-geocode/resource'
import { podActions } from './functions/pod-actions/resource'
import { otrActions, otrStatusSync } from './functions/otr-actions/resource'
import { driverSignupGate } from './functions/driver-signup-gate/resource'
import { driverWelcome } from './functions/driver-welcome/resource'
import { driverAppApi } from './functions/driver-app-api/resource'
import { configurePodScanner } from './podScanner.js'

/*
 * Keep the data stack's CloudFormation template under the 1 MB hard cap.
 *
 * Step G took the data stack to 1,007,296 bytes and CloudFormation refused the update
 * outright ("Template may not exceed 1000000 bytes in size"). Two CDK context keys fix
 * that, and both have to be set here: a Stack reads them in its CONSTRUCTOR, out of the
 * App's context, and `ampx pipeline-deploy` builds that App inside `defineBackend` in
 * this process. `cdk.json` is never read on that path (job 27), so CDK_CONTEXT_JSON —
 * which the CDK toolkit sets just before importing this file, and which it leaves
 * writable (only CDK_CONTEXT and CDK_OUTDIR are frozen during synth) — is the one place
 * both are true.
 *
 * - suppressTemplateIndentation drops the pretty-printer's whitespace. CloudFormation
 *   counts what is uploaded, not what is readable: same resources, 1,010,618 -> 714,287
 *   bytes on this branch.
 * - minimizePolicies is CDK's own IAM minimisation: statements that agree on their
 *   actions have their resources unioned (and vice versa), so every table ARN is named
 *   once per distinct action set instead of once per call site. Equality on one axis is
 *   required before the other is unioned, so the effective (action, resource) grants are
 *   unchanged — no wildcards, no table gains an action it did not already have.
 *
 * Jobs 27, 28 and 32 each failed WITHOUT changing the uploaded template because a nested
 * stack's asset key is hashed from the template CONTENT, not from the file's bytes: a
 * re-indented but otherwise identical template keeps job 26's key, cdk-assets finds that
 * object already in S3 and skips the upload, and CloudFormation re-reads the 1,010,720
 * byte original. minimizePolicies changes the content, so the key moves and the minified
 * template is actually published. See Docs/tms-build/BUILD_LOG.md.
 */
process.env.CDK_CONTEXT_JSON = JSON.stringify({
  ...JSON.parse(process.env.CDK_CONTEXT_JSON ?? '{}'),
  '@aws-cdk/core:suppressTemplateIndentation': true,
  '@aws-cdk/aws-iam:minimizePolicies': true,
})

const backend = defineBackend({
  auth,
  data,
  storage,
  userManagement,
  slackIntakeWebhook,
  gmailTaskIntake,
  shipmentEmailIntake,
  twofaIntake,
  factoringIntake,
  vendorApActions,
  vendorApIntake,
  // Production's extractor stays until the stage that creates WorkflowRun (see stages.ts).
  ...(vendorApExtractLegacy(currentSchemaStage()) ? { vendorApExtract } : {}),
  workflowAgent,
  apptNeedNotifier,
  slackStatusNotifier,
  payCreditApproval,
  fuelImport,
  generateRecurringExpenses,
  motiveMileageSync,
  motiveOdometerSync,
  blueinkSync,
  intakeReconcile,
  motiveLocationSync,
  motiveFaultSync,
  complianceScanner,
  onboardingPortalApi,
  onboardingEmailer,
  driverPayEmailer,
  vehicleQuoteEmailer,
  googleReviews,
  paychexPaySync,
  brokerLoadAlert,
  rateconAssignedText,
  rateconParser,
  apptReport,
  cashCheckinReminder,
  apptRequestEmailer,
  amazonDisputeIntake,
  disputePortalApi,
  trackingApi,
  tripScreenshotParser,
  tmsDirectoryActions,
  mcpSync,
  tmsShipmentActions,
  tmsCarrierActions,
  tmsTrackingActions,
  tmsFinanceActions,
  tmsAljexImport,
  tmsDataSafety,
  tmsSpotQuoter,
  tmsCrmActions,
  tmsApInbox,
  tmsDashboardRollup,
  loadTrackingProjector,
  checkCallNotifier,
  trackingAutomation,
  shipmentNotifier,
  rateConSignApi,
  tmsGeocode,
  podActions,
  driverSignupGate,
  driverWelcome,
  driverAppApi,
  otrActions,
  otrStatusSync,
  dispatchActions,
  dispatchTwilioWebhook,
  dispatchSlackBridge,
  dispatchNudge,
})

// ── Staged schema deploy (amplify/data/stages.ts, Docs/tms-build/AW_STAGED_DEPLOY.md) ──
// BCAT_SCHEMA_STAGE=k synthesizes only the models present at stage k, so a table the current
// stage does not have must be skipped cleanly everywhere it is wired. Unset (dev, every deploy
// today) leaves `stageTables` / `stageCfnTables` as the real objects: zero behavior change.
// Below the final stage a missing table is an ABSENT stub: grants are no-ops, settable props
// ignore writes, and `tableName` / `tableArn` / `tableStreamArn` are a sentinel that
// `addEnvironment` and `addToRolePolicy` drop (a Lambda deploys without that variable or
// statement). Anything else that would carry the sentinel into a template is caught by
// scripts/stageDeployCheck.mjs, which fails if the sentinel appears in any synthesized template.
const SCHEMA_STAGE = currentSchemaStage()
export const ABSENT_TABLE_SENTINEL = '__BCAT_TABLE_NOT_IN_STAGE__'
const ABSENT_TABLE = new Proxy({} as Record<string, unknown>, {
  get: (_t, prop) => (typeof prop === 'string' && /^table(Name|Arn|StreamArn)$/.test(prop)
    ? ABSENT_TABLE_SENTINEL
    : () => undefined),
  set: () => true,
})
function stageView<T extends object>(real: T): T {
  if (SCHEMA_STAGE >= FINAL_STAGE) return real
  return new Proxy(real, {
    get: (target, prop, receiver) => (typeof prop === 'string' && !modelPresent(prop, SCHEMA_STAGE) && !(prop in target)
      ? ABSENT_TABLE
      : Reflect.get(target, prop, receiver)),
  })
}
const stageTables = stageView(backend.data.resources.tables)
const stageCfnTables = stageView(backend.data.resources.cfnResources.amplifyDynamoDbTables)
/** The table, or null when this stage does not have the model. */
function tableOrNull(model: string): (typeof stageTables)[string] | null {
  return model in backend.data.resources.tables ? backend.data.resources.tables[model] : null
}
if (SCHEMA_STAGE < FINAL_STAGE) {
  const addEnvironment = LambdaFunction.prototype.addEnvironment
  LambdaFunction.prototype.addEnvironment = function (this: LambdaFunction, key: string, value: string, options?: Parameters<LambdaFunction['addEnvironment']>[2]) {
    return value.includes(ABSENT_TABLE_SENTINEL) ? this : addEnvironment.call(this, key, value, options)
  }
  const addToRolePolicy = LambdaFunction.prototype.addToRolePolicy
  LambdaFunction.prototype.addToRolePolicy = function (this: LambdaFunction, statement: PolicyStatement) {
    const json = statement.toStatementJson()
    const all: unknown[] = [json.Resource].flat().filter((r) => r !== undefined)
    const kept = all.filter((r) => !(typeof r === 'string' && r.includes(ABSENT_TABLE_SENTINEL)))
    if (kept.length === all.length) return addToRolePolicy.call(this, statement)
    if (kept.length > 0) addToRolePolicy.call(this, PolicyStatement.fromJson({ ...json, Resource: kept }))
  }
}


// ── Auth session lifetime ──────────────────────────────────────────────────
// Stay logged in (mobile + desktop) until explicit logout, for up to 60 days. The
// refresh token controls the overall session length; access/id tokens are short-lived
// and refresh silently in the background. Token revocation stays on so logout works.
const cfnUserPoolClient = backend.auth.resources.cfnResources.cfnUserPoolClient
cfnUserPoolClient.refreshTokenValidity = 60
cfnUserPoolClient.accessTokenValidity = 1
cfnUserPoolClient.idTokenValidity = 1
cfnUserPoolClient.tokenValidityUnits = {
  refreshToken: 'days',
  accessToken:  'hours',
  idToken:      'hours',
}
cfnUserPoolClient.enableTokenRevocation = true

// ── Driver Cognito pool (separate from staff pool) ─────────────────────────
// Drivers authenticate through their own user pool and never touch the staff
// AppSync API. Self-signup is allowed, but every signup is validated against the
// roster by the driver-signup-gate Lambda before Cognito creates the account.
// The pool lives in the signup-gate function's own stack. Putting it in a stack of its
// own made that stack reference the gate Lambda across a stack boundary while the root
// stack referenced the pool id, which CloudFormation rejects as a dependency cycle.
// Colocating keeps the trigger wiring intra-stack and leaves only the ordinary
// root -> child output reference, the same shape disputePortalUrl already uses.
const driverAuthScope = (backend.driverSignupGate.resources.lambda as LambdaFunction).stack

const driverPool = new UserPool(driverAuthScope, 'BcatDriverPool', {
  userPoolName: 'bcat-driver-pool',
  selfSignUpEnabled: true,
  signInAliases: { email: true },
  /*
   * Send through SES from our own domain, not Cognito's built-in mailer.
   *
   * Cognito's default sends as no-reply@verificationemail.com, a shared address with a
   * reputation we do not control, and it is capped at 50 messages a day for the whole
   * account. A verification code that lands in a spam folder is indistinguishable from
   * one that was never sent, and that is exactly how it presented: a driver asked for a
   * code, Cognito reported success, and nothing arrived.
   *
   * bcatcorp.com is a verified SES domain, so codes now come from the company domain with
   * its DKIM and SPF behind them, there is no daily cap, and delivery is visible in SES
   * instead of invisible.
   *
   * IMPORTANT: SES is still in sandbox on this account, which only delivers to verified
   * identities. Addresses at bcatcorp.com are covered by the domain identity, so staff and
   * anyone on the company domain receive mail. A driver on gmail or yahoo will receive
   * NOTHING until production access is granted — the same limit that already applies to
   * the invite and welcome emails, which have always gone through SES. Request production
   * access before onboarding drivers on outside addresses.
   */
  email: UserPoolEmail.withSES({
    fromEmail: 'noreply@bcatcorp.com',
    fromName: 'Ivan Cartage',
    sesRegion: 'us-east-1',
    sesVerifiedDomain: 'bcatcorp.com',
  }),
  userVerification: {
    emailStyle: VerificationEmailStyle.CODE,
    emailSubject: 'Your Ivan Cartage driver code',
    emailBody: 'Your Ivan Cartage verification code is {####}. It expires in 24 hours.',
  },
  standardAttributes: {
    email: { required: true, mutable: true },
  },
  // Email is mutable so drivers can change it, but require verification of the new
  // address before Cognito replaces the old one. This closes a takeover path where
  // an unverified-token holder could update the email to another driver's address.
  keepOriginal: {
    email: true,
  },
  passwordPolicy: {
    minLength: 8,
    requireLowercase: true,
    requireDigits: true,
    requireSymbols: false,
    requireUppercase: false,
  },
})

const driverPoolClient = new UserPoolClient(driverAuthScope, 'BcatDriverPoolClient', {
  userPool: driverPool,
  authFlows: {
    userPassword: true,
    userSrp: true,
  },
  generateSecret: false,
  accessTokenValidity: Duration.hours(1),
  idTokenValidity: Duration.hours(1),
  // Ten years is Cognito's ceiling: a driver signs in once and stays signed in. The app
  // refreshes the hour-long id token off this on every launch (DriverAuthContext).
  refreshTokenValidity: Duration.days(3650),
})

driverPool.addTrigger(
  UserPoolOperation.PRE_SIGN_UP,
  backend.driverSignupGate.resources.lambda,
)

// Allowed portal origins. The prod domain is set via the PORTAL_PROD_ORIGIN env var
// in the Amplify Console (e.g. https://ops.bcatcorp.com); localhost is for dev.
// On the dev stack ops-dev.bcatcorp.com is in the domain association but does not
// resolve in DNS, so public links and CORS must fall back to the reachable branch URL.
const AWS_BRANCH_NAME = process.env.AWS_BRANCH ?? ''
const AWS_APP_ID = process.env.AWS_APP_ID ?? 'd3dejqzs77khq6'
const AMPLIFY_BRANCH_ORIGIN = AWS_BRANCH_NAME && AWS_APP_ID
  ? `https://${AWS_BRANCH_NAME}.${AWS_APP_ID}.amplifyapp.com`
  : null
const PORTAL_PROD_ORIGIN = process.env.PORTAL_PROD_ORIGIN ?? 'https://ops.bcatcorp.com'
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN
  ?? (process.env.BCAT_DEV_STACK === 'true' ? AMPLIFY_BRANCH_ORIGIN : null)
  ?? PORTAL_PROD_ORIGIN
const EXPLICIT_DEV_BRANCH_ORIGIN = 'https://dev.d3dejqzs77khq6.amplifyapp.com'
const PORTAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  PORTAL_PROD_ORIGIN,
  ...(PORTAL_ORIGIN !== PORTAL_PROD_ORIGIN ? [PORTAL_ORIGIN] : []),
  // Keep the legacy explicit branch URL as a fallback when env vars don't yield it.
  ...(process.env.BCAT_DEV_STACK === 'true'
    && PORTAL_ORIGIN !== EXPLICIT_DEV_BRANCH_ORIGIN
    && PORTAL_PROD_ORIGIN !== EXPLICIT_DEV_BRANCH_ORIGIN
      ? [EXPLICIT_DEV_BRANCH_ORIGIN]
      : []),
]

// Welcome email once a driver sets their password. Attached here, beside the
// PRE_SIGN_UP trigger, for the same intra-stack reason documented above.
const driverWelcomeFn = backend.driverWelcome.resources.lambda as LambdaFunction
driverPool.addTrigger(UserPoolOperation.POST_CONFIRMATION, driverWelcomeFn)

driverWelcomeFn.addEnvironment('DRIVER_TABLE_NAME', stageTables['Driver'].tableName)
driverWelcomeFn.addEnvironment('FROM_ADDRESS', 'onboarding@bcatcorp.com')
driverWelcomeFn.addEnvironment('PORTAL_ORIGIN', PORTAL_ORIGIN)
driverWelcomeFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan'],
    resources: [stageTables['Driver'].tableArn],
  }),
)
driverWelcomeFn.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] }),
)

// ── userManagement Lambda ──────────────────────────────────────────────────

backend.userManagement.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'cognito-idp:ListUsers',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminDeleteUser',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:AdminResetUserPassword',
      'cognito-idp:CreateGroup',
      // Step I: a role change signs the user out of their old groups only on the
      // next token refresh, so an admin can force it; a re-invite resends the
      // temporary password Cognito already minted.
      'cognito-idp:AdminUserGlobalSignOut',
    ],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)

;(backend.userManagement.resources.lambda as LambdaFunction).addEnvironment(
  'USER_POOL_ID',
  backend.auth.resources.userPool.userPoolId
)

// Step S4: read-only listing of the DRIVER pool (verified / confirmed state for the
// user overview). A separate statement; the staff-pool grant above is unchanged.
backend.userManagement.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    // ListUsers: the roll call. The two Admin*Password actions: an admin gets a driver back
    // into the Ivan driver app (manageUsers driverLogin / resetDriverPassword).
    actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminResetUserPassword', 'cognito-idp:AdminSetUserPassword'],
    resources: [driverPool.userPoolArn],
  }),
)
;(backend.userManagement.resources.lambda as LambdaFunction).addEnvironment(
  'DRIVER_USER_POOL_ID',
  driverPool.userPoolId,
)

// Step I: the staff directory. The role lives here and is projected onto the
// Cognito groups above; every change is stamped into the shared audit log.
const userProfileTable = stageTables['UserProfile']
const userMgmtAuditTable = stageTables['AuditLog']
;(backend.userManagement.resources.lambda as LambdaFunction).addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Scan',
    ],
    resources: [userProfileTable.tableArn, userMgmtAuditTable.tableArn],
  })
)
;(backend.userManagement.resources.lambda as LambdaFunction).addEnvironment(
  'USER_PROFILE_TABLE_NAME',
  userProfileTable.tableName
)
;(backend.userManagement.resources.lambda as LambdaFunction).addEnvironment(
  'AUDIT_LOG_TABLE_NAME',
  userMgmtAuditTable.tableName
)

// ── driverSignupGate Lambda (driver pool PreSignUp trigger) ────────────────

const signupDriverTable = stageTables['Driver']
const signupDriverPaySettingTable = stageTables['DriverPaySetting']

backend.driverSignupGate.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan'],
    resources: [signupDriverTable.tableArn, signupDriverPaySettingTable.tableArn],
  }),
)

;(backend.driverSignupGate.resources.lambda as LambdaFunction).addEnvironment(
  'DRIVER_TABLE_NAME',
  signupDriverTable.tableName,
)
;(backend.driverSignupGate.resources.lambda as LambdaFunction).addEnvironment(
  'DRIVER_PAY_SETTING_TABLE_NAME',
  signupDriverPaySettingTable.tableName,
)

// Step S4: best-effort log of refused sign-ups into the existing AuditLog table.
const signupAuditLogTable = stageTables['AuditLog']
backend.driverSignupGate.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:PutItem'],
    resources: [signupAuditLogTable.tableArn],
  }),
)
;(backend.driverSignupGate.resources.lambda as LambdaFunction).addEnvironment(
  'AUDIT_LOG_TABLE_NAME',
  signupAuditLogTable.tableName,
)

// ── driver-app-api Lambda (driver PWA HTTP API) ────────────────────────────

const driverApiFn = backend.driverAppApi.resources.lambda as LambdaFunction
// Time-off requests ping this channel (Ruben tagged); set in the Amplify Console env like the appt report's.
driverApiFn.addEnvironment('SLACK_GLOBAL_CHANNEL_ID', process.env.SLACK_GLOBAL_CHANNEL_ID ?? '')
const driverSubmissionTable = stageTables['DriverSubmission']
const driverSubmissionDocTable = stageTables['DriverSubmissionDoc']
// Detention times Ivan's drivers record for themselves. Writable by the driver API, which
// is the only thing that writes them.
const driverLoadTimeTable = stageTables['DriverLoadTime']
// The Ivan time clock. Drivers write their own rows; staff correct them from the hours page.
const timeClockTable = stageTables['TimeClockEntry']
// Time-off requests drivers send from the app (and staff approve): DriverAvailability rows.
const driverApiAvailabilityTable = stageTables['DriverAvailability']
const driverApiAmazonTripTable = stageTables['AmazonTrip']
const driverApiDeductionTable = stageTables['DriverPayDeduction']
const driverApiCreditTable = stageTables['DriverPayCredit']
const driverApiFuelTxTable = stageTables['FuelTransaction']
const driverApiDriverTable = stageTables['Driver']
const driverApiPaySettingTable = stageTables['DriverPaySetting']
const driverApiLoadTable = stageTables['Load']
const driverApiCustomerTable = stageTables['Customer']
const driverApiLocationTable = stageTables['Location']
const driverApiPodDocumentTable = stageTables['PodDocument']
// Read-only: the shipment documents filed for a load, so the app can tick off a ticked extra (lumper receipt).
const driverApiShipmentDocumentTable = stageTables['ShipmentDocument']
// The Ivan app shows a driver when their own truck's next PM falls due. Equipment holds the
// last PM; TruckLocation holds Motive's odometer. Read-only — the app never edits either.
const driverApiEquipmentTable = stageTables['Equipment']
const driverApiTruckLocationTable = stageTables['TruckLocation']
const driverApiMaintenanceTaskTable = stageTables['MaintenanceTask']

// The driver API is internet-facing (Function URL, auth handled in-handler), so it gets
// read-only access to the roster and pay tables it reports from. Only the two submission
// tables it owns are writable — a bug here must never be able to alter anyone's pay.
const driverApiReadOnlyArns = [
  driverApiDriverTable.tableArn,
  `${driverApiDriverTable.tableArn}/index/*`,
  driverApiPaySettingTable.tableArn,
  `${driverApiPaySettingTable.tableArn}/index/*`,
  driverApiAmazonTripTable.tableArn,
  `${driverApiAmazonTripTable.tableArn}/index/*`,
  driverApiLoadTable.tableArn,
  `${driverApiLoadTable.tableArn}/index/*`,
  driverApiDeductionTable.tableArn,
  `${driverApiDeductionTable.tableArn}/index/*`,
  driverApiCreditTable.tableArn,
  `${driverApiCreditTable.tableArn}/index/*`,
  driverApiFuelTxTable.tableArn,
  `${driverApiFuelTxTable.tableArn}/index/*`,
  driverApiCustomerTable.tableArn,
  `${driverApiCustomerTable.tableArn}/index/*`,
  driverApiLocationTable.tableArn,
  `${driverApiLocationTable.tableArn}/index/*`,
  driverApiPodDocumentTable.tableArn,
  `${driverApiPodDocumentTable.tableArn}/index/*`,
  driverApiShipmentDocumentTable.tableArn,
  `${driverApiShipmentDocumentTable.tableArn}/index/*`,
  driverApiEquipmentTable.tableArn,
  `${driverApiEquipmentTable.tableArn}/index/*`,
  driverApiTruckLocationTable.tableArn,
  `${driverApiTruckLocationTable.tableArn}/index/*`,
  driverApiMaintenanceTaskTable.tableArn,
  `${driverApiMaintenanceTaskTable.tableArn}/index/*`,
]

const driverApiWritableArns = [
  driverSubmissionTable.tableArn,
  `${driverSubmissionTable.tableArn}/index/*`,
  driverSubmissionDocTable.tableArn,
  `${driverSubmissionDocTable.tableArn}/index/*`,
  driverLoadTimeTable.tableArn,
  `${driverLoadTimeTable.tableArn}/index/*`,
  timeClockTable.tableArn,
  `${timeClockTable.tableArn}/index/*`,
  driverApiAvailabilityTable.tableArn,
  `${driverApiAvailabilityTable.tableArn}/index/*`,
]

// A finished driver POD upload is filed on the shipment by tms-shipment-actions (plain identity grant, like the other Lambda-to-Lambda calls).
driverApiFn.addEnvironment('TMS_SHIPMENT_ACTIONS_FUNCTION_NAME', backend.tmsShipmentActions.resources.lambda.functionName)
driverApiFn.addToRolePolicy(new PolicyStatement({
  actions:   ['lambda:InvokeFunction'],
  resources: [backend.tmsShipmentActions.resources.lambda.functionArn],
}))
driverApiFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: driverApiReadOnlyArns,
  }),
)
driverApiFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    ],
    resources: driverApiWritableArns,
  }),
)
/*
 * The one write the driver API makes outside its own tables: a driver's arrived/departed
 * taps and the ETA they imply are stamped onto the load's stops — the record the loads
 * board derives its lifecycle from. UpdateItem only, on the Load table only; the handler
 * rewrites nothing but `stops` and the audit fields, and refuses a load the driver is not on.
 */
driverApiFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [driverApiLoadTable.tableArn] }),
)
/*
 * A driver picks the truck they are in at the start of the day, so the ELD fix and the
 * logs line up with the right person. That is the two-sided assignment the office
 * writes (Driver.assignedTruckId + Equipment.assignedDriverId), and nothing else on
 * either row — the handler updates exactly those attributes.
 */
driverApiFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    resources: [driverApiDriverTable.tableArn, driverApiEquipmentTable.tableArn],
  }),
)
// A driver's note about a facility is appended to the directory record (driverNotes only);
// a note on a stop with no directory place creates that Location first (PutItem).
driverApiFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:UpdateItem', 'dynamodb:PutItem'], resources: [driverApiLocationTable.tableArn] }),
)
// A driver reports a truck problem: one new MaintenanceTask on their own unit, nothing else.
driverApiFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [driverApiMaintenanceTaskTable.tableArn] }),
)
driverApiFn.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] }),
)

// Drivers PUT via presigned URLs and the Lambda GETs via presigned URLs.
backend.storage.resources.bucket.grantPut(driverApiFn, 'driver-docs/*')
backend.storage.resources.bucket.grantRead(driverApiFn, 'driver-docs/*')
backend.storage.resources.bucket.grantDelete(driverApiFn, 'driver-docs/*')

driverApiFn.addEnvironment('DRIVER_SUBMISSION_TABLE_NAME', driverSubmissionTable.tableName)
driverApiFn.addEnvironment('DRIVER_SUBMISSION_DOC_TABLE_NAME', driverSubmissionDocTable.tableName)
driverApiFn.addEnvironment('DRIVER_TABLE_NAME', driverApiDriverTable.tableName)
driverApiFn.addEnvironment('DRIVER_LOAD_TIME_TABLE_NAME', driverLoadTimeTable.tableName)
driverApiFn.addEnvironment('TIME_CLOCK_TABLE_NAME', timeClockTable.tableName)
driverApiFn.addEnvironment('DRIVER_AVAILABILITY_TABLE_NAME', driverApiAvailabilityTable.tableName)
driverApiFn.addEnvironment('DRIVER_PAY_SETTING_TABLE_NAME', driverApiPaySettingTable.tableName)
driverApiFn.addEnvironment('AMAZON_TRIP_TABLE_NAME', driverApiAmazonTripTable.tableName)
driverApiFn.addEnvironment('LOAD_TABLE_NAME', driverApiLoadTable.tableName)
driverApiFn.addEnvironment('CUSTOMER_TABLE_NAME', driverApiCustomerTable.tableName)
driverApiFn.addEnvironment('LOCATION_TABLE_NAME', driverApiLocationTable.tableName)
driverApiFn.addEnvironment('POD_DOCUMENT_TABLE_NAME', driverApiPodDocumentTable.tableName)
driverApiFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME', driverApiShipmentDocumentTable.tableName)
driverApiFn.addEnvironment('EQUIPMENT_TABLE_NAME', driverApiEquipmentTable.tableName)
driverApiFn.addEnvironment('TRUCK_LOCATION_TABLE_NAME', driverApiTruckLocationTable.tableName)
driverApiFn.addEnvironment('MAINTENANCE_TASK_TABLE_NAME', driverApiMaintenanceTaskTable.tableName)
driverApiFn.addEnvironment('DRIVER_PAY_DEDUCTION_TABLE_NAME', driverApiDeductionTable.tableName)
driverApiFn.addEnvironment('DRIVER_PAY_CREDIT_TABLE_NAME', driverApiCreditTable.tableName)
driverApiFn.addEnvironment('FUEL_TRANSACTION_TABLE_NAME', driverApiFuelTxTable.tableName)
driverApiFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
driverApiFn.addEnvironment('DRIVER_USER_POOL_ID', driverPool.userPoolId)
driverApiFn.addEnvironment('DRIVER_USER_POOL_CLIENT_ID', driverPoolClient.userPoolClientId)
/*
 * The STAFF pool, so an admin can open a driver's app as that driver.
 *
 * Two pools reach this Lambda and they are not interchangeable: a driver's own token
 * resolves them by email, while a staff token is only ever accepted alongside an explicit
 * impersonation header, from an admin, for reads. See loadVerifiedDriver.
 */
driverApiFn.addEnvironment('STAFF_USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
driverApiFn.addEnvironment(
  'STAFF_USER_POOL_CLIENT_ID',
  backend.auth.resources.userPoolClient.userPoolClientId,
)
driverApiFn.addEnvironment('AUDIT_LOG_TABLE_NAME', stageTables['AuditLog'].tableName)
stageTables['AuditLog'].grantWriteData(driverApiFn)
// Plain env vars (not secrets) so a missing value never blocks the deploy.
driverApiFn.addEnvironment('INTAKE_IVAN_CHANNEL_ID', process.env.INTAKE_IVAN_CHANNEL_ID ?? 'C0B4YJXLYM8')
driverApiFn.addEnvironment('LOADS_EMAIL_TO', process.env.LOADS_EMAIL_TO ?? 'ivanloads@bcatcorp.com')
// #intake-pods. A driver's POD is announced here and nowhere else — it used to email
// ivanloads@, which feeds #intake-ivan, so every POD landed on the channel dispatch
// watches for new freight AND became an intake item nobody was ever going to build.
driverApiFn.addEnvironment('INTAKE_PODS_CHANNEL_ID', process.env.INTAKE_PODS_CHANNEL_ID ?? 'C0C6ZT55R0T')
driverApiFn.addEnvironment('SES_FROM_ADDRESS', process.env.SES_FROM_ADDRESS ?? 'onboarding@bcatcorp.com')

// Function URL — drivers call this directly from the PWA; JWT verification is handled in the Lambda.
const driverApiUrl = new FunctionUrl(driverApiFn.stack, 'DriverAppApiUrl', {
  function: driverApiFn,
  authType: FunctionUrlAuthType.NONE,
  cors: {
    // Same origin allowlist the other portals use — the PWA is served from the app itself.
    allowedOrigins: PORTAL_ORIGINS,
    /*
     * DELETE is here because the driver app uses it: removing a document calls
     * DELETE /submissions/:id/docs. It was missing, so the browser's preflight refused
     * the request before it left the page and every "remove this document" failed with a
     * bare "Failed to fetch" — for real drivers, not only for an admin looking on.
     * PUT is deliberately absent: the only PUT goes straight to S3 with a presigned URL,
     * which is a different origin with its own CORS.
     */
    allowedMethods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE],
    /*
     * x-bcat-impersonate-driver is what View as driver sends. A custom header makes the
     * browser preflight the request, and a preflight that does not name the header is
     * rejected — which is why that screen showed "Failed to fetch" with no matching
     * entry in the Lambda's log: the request never reached AWS at all.
     */
    allowedHeaders: ['content-type', 'authorization', 'x-bcat-impersonate-driver'],
  },
})

new CfnOutput(driverApiFn.stack, 'DriverAppApiFunctionUrl', {
  value:       driverApiUrl.url,
  description: 'Driver PWA HTTP API Function URL',
})

// ── IntakeItem table (shared by webhook + notifier) ────────────────────────

const intakeTable = stageTables['IntakeItem']

// ── slackIntakeWebhook Lambda ──────────────────────────────────────────────

const webhookFn = backend.slackIntakeWebhook.resources.lambda as LambdaFunction

// DynamoDB: write new items (dedup handled via conditional put, no GSI query needed)
backend.slackIntakeWebhook.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],
    resources: [intakeTable.tableArn],
  })
)

webhookFn.addEnvironment('TABLE_NAME', intakeTable.tableName)

/*
 * A tender's rate confirmation arrives as a file ON the Slack message. Storing it here is
 * what lets Build load attach it to the load and the parser read the lane off it — without
 * this the attachment list was always empty and every field was typed by hand.
 */
webhookFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
backend.storage.resources.bucket.grantPut(webhookFn, 'intake-attachments/*')

// Function URL — Slack posts to this endpoint
const slackWebhookUrl = new FunctionUrl(webhookFn.stack, 'SlackIntakeWebhookUrl', {
  function: webhookFn,
  authType: FunctionUrlAuthType.NONE,
})

new CfnOutput(webhookFn.stack, 'SlackIntakeWebhookFunctionUrl', {
  value:       slackWebhookUrl.url,
  description: 'Paste into Slack App → Event Subscriptions → Request URL',
})

// ── gmailTaskIntake Lambda (tasks@ email → IntakeItem + Slack #intake-ivan) ──

const gmailTaskFn = backend.gmailTaskIntake.resources.lambda as LambdaFunction

backend.gmailTaskIntake.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],   // dedup via conditional put
    resources: [intakeTable.tableArn],
  })
)

gmailTaskFn.addEnvironment('TABLE_NAME', intakeTable.tableName)
// Plain env var (not a secret) so a missing channel never blocks the deploy — set
// INTAKE_IVAN_CHANNEL_ID in the Amplify Console env to enable the Slack post.
gmailTaskFn.addEnvironment('INTAKE_IVAN_CHANNEL_ID', process.env.INTAKE_IVAN_CHANNEL_ID ?? '')

// ── apptReport (daily 3 PM Chicago digest of unconfirmed appts → #bcat-global) ──
const apptReportFn = backend.apptReport.resources.lambda as LambdaFunction
const loadTableForReport = stageTables['Load']
const customerTableForReport = stageTables['Customer']
backend.apptReport.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:Scan'], resources: [loadTableForReport.tableArn] })
)
backend.apptReport.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:Scan'], resources: [customerTableForReport.tableArn] })
)
apptReportFn.addEnvironment('LOAD_TABLE_NAME', loadTableForReport.tableName)
apptReportFn.addEnvironment('CUSTOMER_TABLE_NAME', customerTableForReport.tableName)
apptReportFn.addEnvironment('SLACK_GLOBAL_CHANNEL_ID', process.env.SLACK_GLOBAL_CHANNEL_ID ?? '')
// 20:00 & 21:00 UTC Mon–Fri — whichever lands on 15:00 America/Chicago posts (DST-proof).
const apptReportRule = new Rule(apptReportFn.stack, 'ApptReportDailyRule', {
  schedule: Schedule.cron({ minute: '0', hour: '20,21', weekDay: 'MON-FRI', month: '*' }),
  description: 'Daily 3 PM Chicago unconfirmed-appt digest',
})
apptReportRule.addTarget(new EventsLambdaTarget(apptReportFn))

// ── cashCheckinReminder (Slack nudge the morning after each biweekly payroll) ──
// Reads the "Last payroll date" + channel from the CashSettings row the Finance page
// edits, and skips when a check-in for that payroll is already logged.
const cashReminderFn = backend.cashCheckinReminder.resources.lambda as LambdaFunction
const cashSettingsTable = stageTables['CashSettings']
const cashCheckInTable = stageTables['CashCheckIn']
backend.cashCheckinReminder.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [cashSettingsTable.tableArn] })
)
backend.cashCheckinReminder.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:Scan'], resources: [cashCheckInTable.tableArn] })
)
cashReminderFn.addEnvironment('SETTINGS_TABLE_NAME', cashSettingsTable.tableName)
cashReminderFn.addEnvironment('CHECKIN_TABLE_NAME', cashCheckInTable.tableName)
// 14:00 & 15:00 UTC daily — whichever lands on 09:00 America/Chicago posts (DST-proof).
const cashReminderRule = new Rule(cashReminderFn.stack, 'CashCheckinReminderDailyRule', {
  schedule: Schedule.cron({ minute: '0', hour: '14,15', day: '*', month: '*' }),
  description: 'Cash check-in reminder the morning after payroll',
})
cashReminderRule.addTarget(new EventsLambdaTarget(cashReminderFn))

// ── apptRequestEmailer (Appts page → facility appointment contact) ───────────
backend.apptRequestEmailer.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] })
)
;(backend.apptRequestEmailer.resources.lambda as LambdaFunction).addEnvironment(
  'FROM_ADDRESS', process.env.APPT_REQUEST_FROM_ADDRESS ?? 'dennis@bcatcorp.com',
)

// ── apptNeedNotifier (pickup/delivery flagged NEED → Slack #appts-ivan) ──────
// Defaults to the #appts-ivan channel; override with APPTS_IVAN_CHANNEL_ID in the
// Amplify Console env if the channel ever moves.
;(backend.apptNeedNotifier.resources.lambda as LambdaFunction).addEnvironment(
  'APPTS_IVAN_CHANNEL_ID',
  process.env.APPTS_IVAN_CHANNEL_ID ?? 'C0BPX858363',
)

const gmailTaskUrl = new FunctionUrl(gmailTaskFn.stack, 'GmailTaskIntakeUrl', {
  function: gmailTaskFn,
  authType: FunctionUrlAuthType.NONE,
})

new CfnOutput(gmailTaskFn.stack, 'GmailTaskIntakeFunctionUrl', {
  value:       gmailTaskUrl.url,
  description: 'POST tasks@ emails here from the Apps Script',
})

// ── shipmentEmailIntake Lambda (inbound replies to tracking+<shipmentId>@) ───
const shipmentEmailIntakeFn = backend.shipmentEmailIntake.resources.lambda as LambdaFunction
const shipmentEmailIntakeMessageTable = stageTables['ShipmentMessage']

backend.shipmentEmailIntake.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [shipmentEmailIntakeMessageTable.tableArn, `${shipmentEmailIntakeMessageTable.tableArn}/index/*`],
  })
)

shipmentEmailIntakeFn.addEnvironment('SHIPMENT_MESSAGE_TABLE_NAME', shipmentEmailIntakeMessageTable.tableName)
shipmentEmailIntakeFn.addEnvironment('TMS_TRACKING_ACTIONS_FUNCTION_NAME', backend.tmsTrackingActions.resources.lambda.functionName)

// The resource-policy grant below carries an aws:SourceArn condition that an IAM role principal never
// satisfies, so the intake also needs the plain identity grant (deployed dev: AccessDenied on Invoke).
backend.shipmentEmailIntake.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['lambda:InvokeFunction'],
    resources: [backend.tmsTrackingActions.resources.lambda.functionArn],
  })
)
backend.tmsTrackingActions.resources.lambda.addPermission('ShipmentEmailIntakeInvoke', {
  principal: shipmentEmailIntakeFn.grantPrincipal,
  action: 'lambda:InvokeFunction',
  sourceArn: shipmentEmailIntakeFn.functionArn,
})

const shipmentEmailIntakeUrl = new FunctionUrl(shipmentEmailIntakeFn.stack, 'ShipmentEmailIntakeUrl', {
  function: shipmentEmailIntakeFn,
  authType: FunctionUrlAuthType.NONE,
})
new CfnOutput(shipmentEmailIntakeFn.stack, 'ShipmentEmailIntakeFunctionUrl', {
  value:       shipmentEmailIntakeUrl.url,
  description: 'POST tracking+<shipmentId>@ replies here',
})

// ── twofaIntake Lambda (Google Voice text forwards → Slack #2fa) ───────────
const twofaFn = backend.twofaIntake.resources.lambda as LambdaFunction
// Channel id or name; plain env so a missing value never blocks the deploy (defaults to #2fa).
twofaFn.addEnvironment('TWO_FA_SLACK_CHANNEL', process.env.TWO_FA_SLACK_CHANNEL ?? '#2fa')
const twofaUrl = new FunctionUrl(twofaFn.stack, 'TwofaIntakeUrl', { function: twofaFn, authType: FunctionUrlAuthType.NONE })
new CfnOutput(twofaFn.stack, 'TwofaIntakeFunctionUrl', { value: twofaUrl.url, description: 'POST Google Voice text-forward emails here' })

// ── factoringIntake Lambda (factor@ email → FactoringItem) ──────────────────
const factoringIntakeFn = backend.factoringIntake.resources.lambda as LambdaFunction
const factoringTable = stageTables['FactoringItem']

backend.factoringIntake.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'], // create-only; duplicate PROs handled by condition
    resources: [factoringTable.tableArn],
  }),
)

factoringIntakeFn.addEnvironment('TABLE_NAME', factoringTable.tableName)

const factoringIntakeUrl = new FunctionUrl(factoringIntakeFn.stack, 'FactoringIntakeUrl', {
  function: factoringIntakeFn,
  authType: FunctionUrlAuthType.NONE,
})

new CfnOutput(factoringIntakeFn.stack, 'FactoringIntakeFunctionUrl', {
  value:       factoringIntakeUrl.url,
  description: 'POST factor@ emails here from the Gmail bridge',
})

// Vendor AP: authenticated payment actions plus secret-authenticated Gmail intake.
const vendorApTable = stageTables['VendorPayable']
const vendorApActionsFn = backend.vendorApActions.resources.lambda as LambdaFunction
const vendorApMaintenanceTable = stageTables['MaintenanceInvoice']
vendorApActionsFn.addEnvironment('TABLE_NAME', vendorApTable.tableName)
vendorApActionsFn.addEnvironment('MAINTENANCE_TABLE_NAME', vendorApMaintenanceTable.tableName)
vendorApActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
  resources: [vendorApTable.tableArn, vendorApMaintenanceTable.tableArn],
}))
// Access tokens carry no email; the Lambda resolves the caller via AdminGetUser
// (same as userManagement) for the owner check and the `paidBy` audit field.
vendorApActionsFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
// Payment confirmations to vendors: from the verified bcatcorp.com sender, replies and a
// copy to the AP mailbox.
vendorApActionsFn.addEnvironment('FROM_ADDRESS', 'noreply@bcatcorp.com')
vendorApActionsFn.addEnvironment('CONFIRM_CC', 'vendorpayments@bcatcorp.com')
vendorApActionsFn.addToRolePolicy(new PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] }))
vendorApActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['cognito-idp:AdminGetUser'],
  resources: [backend.auth.resources.userPool.userPoolArn],
}))
const vendorApIntakeFn = backend.vendorApIntake.resources.lambda as LambdaFunction
vendorApIntakeFn.addEnvironment('TABLE_NAME', vendorApTable.tableName)
vendorApIntakeFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
vendorApIntakeFn.addToRolePolicy(new PolicyStatement({
  actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
  resources: [vendorApTable.tableArn],
}))
backend.storage.resources.bucket.grantPut(vendorApIntakeFn, 'intake-pdfs/vendor-ap/*')
backend.storage.resources.bucket.grantRead(vendorApIntakeFn, 'intake-pdfs/vendor-ap/*')
// Below the stage that creates WorkflowRun the invoice extractor is still `vendor-ap-extract`
// (production's Lambda, kept until then: workflow-agent cannot run without WorkflowRun). From that
// stage it lives in `workflow-agent` (Step K), which answers the old `{ id }` / `{ all: true }`
// payloads unchanged; the extractor is not defined at all and the bridge is repointed in the
// workflow-agent block below (that block also grants the three edge Lambdas, and `trackingApiFn`
// is not declared until further down this file).
const vendorApExtractFn = backend.vendorApExtract?.resources.lambda as LambdaFunction | undefined
if (vendorApExtractFn) {
  vendorApExtractFn.addEnvironment('TABLE_NAME', vendorApTable.tableName)
  vendorApExtractFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
  vendorApExtractFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'],
    resources: [vendorApTable.tableArn],
  }))
  backend.storage.resources.bucket.grantRead(vendorApExtractFn, 'intake-pdfs/vendor-ap/*')
}
const vendorApIntakeUrl = new FunctionUrl(vendorApIntakeFn.stack, 'VendorApIntakeUrl', {
  function: vendorApIntakeFn,
  authType: FunctionUrlAuthType.NONE,
})
new CfnOutput(vendorApIntakeFn.stack, 'VendorApIntakeFunctionUrl', {
  value: vendorApIntakeUrl.url,
  description: 'Vendor AP Gmail bridge webhook; requires the shared intake secret',
})

// ── Dispatch (Twilio texts + calls with drivers) ───────────────────────────
//
// Credentials, the dispatch number and the webhook secret live under one SSM path and
// are read at run time (see _shared/dispatchConfig.ts), so this stack deploys before the
// number exists. scripts/dispatchTwilioSetup.mts fills the path and points Twilio here.

const dispatchConversationTable = stageTables['DispatchConversation']
const dispatchMessageTable = stageTables['DispatchMessage']
const dispatchSettingsTable = stageTables['DispatchSettings']
const dispatchDriverTable = stageTables['Driver']
const dispatchWebhookFn = backend.dispatchTwilioWebhook.resources.lambda as LambdaFunction
const dispatchActionsFn = backend.dispatchActions.resources.lambda as LambdaFunction
const dispatchSlackBridgeFn = backend.dispatchSlackBridge.resources.lambda as LambdaFunction
const dispatchNudgeFn = backend.dispatchNudge.resources.lambda as LambdaFunction
const dispatchParamPath = `/bcat/dispatch/${backend.auth.resources.userPool.userPoolId}`
const dispatchParamArn = Stack.of(dispatchWebhookFn).formatArn({
  service: 'ssm',
  resource: 'parameter',
  resourceName: `${dispatchParamPath.replace(/^\//, '')}/*`,
})
const dispatchTableArns = [dispatchConversationTable.tableArn, dispatchMessageTable.tableArn, dispatchSettingsTable.tableArn]

// driverApiFn is in the list because the driver app's stop events and POD sends are
// written into the driver's conversation (recordDriverStatus) and mirrored to Slack.
// trackingActionsFn is in it because Step D's carrier tracking link is texted to the
// driver from the dispatch number, so the text and any reply live in Dispatch like
// every other driver conversation. Note SETTINGS_TABLE_NAME below is *DispatchSettings*
// (what tablesFromEnv reads); tmsTrackingActions reads TmsSettings from
// TMS_SETTINGS_TABLE_NAME, wired with the rest of its own tables further down.
const trackingActionsFn = backend.tmsTrackingActions.resources.lambda as LambdaFunction

// One suffix instead of a full name per table. Each `<X>_TABLE_NAME` costs ~300 B in the data-stack
// template (a Select/Split over the table ARN) and ~60 B of Lambda environment; the big TMS routers
// carried 15-33 of them, which was 36 KB of a template capped at 1,000,000 B. The handler's tableEnv.ts
// derives `<Model>-<suffix>` for every name it lists. The api id is cut out of a table name (no
// reference to the API construct: that would close a cycle).
function passDataTableSuffix(fn: LambdaFunction, tables: Readonly<Record<string, string>>): void {
  const dataTables = stageTables
  const models = [...new Set(Object.values(tables))]
  const missing = models.filter((model) => !dataTables[model])
  if (missing.length > 0) throw new Error(`DATA_TABLE_SUFFIX: ${fn.node.id} names models the data stack does not have: ${missing.join(', ')}`)
  // Below the final stage some of the models are not deployed yet; the suffix comes from the first present one.
  const base = models.map((model) => tableOrNull(model)).find((table) => table)
  if (base) fn.addEnvironment('DATA_TABLE_SUFFIX', `${Fn.select(1, Fn.split('-', base.tableName))}-NONE`)
}
passDataTableSuffix(trackingActionsFn, TRACKING_ACTIONS_TABLES)
for (const fn of [dispatchWebhookFn, dispatchActionsFn, dispatchSlackBridgeFn, dispatchNudgeFn, driverApiFn, trackingActionsFn]) {
  // trackingActionsFn takes its table names from DATA_TABLE_SUFFIX (passDataTableSuffix above).
  if (fn !== trackingActionsFn) {
    fn.addEnvironment('CONVERSATION_TABLE_NAME', dispatchConversationTable.tableName)
    fn.addEnvironment('MESSAGE_TABLE_NAME', dispatchMessageTable.tableName)
    fn.addEnvironment('SETTINGS_TABLE_NAME', dispatchSettingsTable.tableName)
    fn.addEnvironment('DRIVER_TABLE_NAME', dispatchDriverTable.tableName)
  }
  fn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
  fn.addEnvironment('DISPATCH_PARAM_PATH', dispatchParamPath)
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: [...dispatchTableArns, ...dispatchTableArns.map((arn) => `${arn}/index/*`)],
  }))
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:Scan'],
    resources: [dispatchDriverTable.tableArn],
  }))
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['ssm:GetParametersByPath', 'ssm:GetParameter'],
    resources: [dispatchParamArn],
  }))
  backend.storage.resources.bucket.grantReadWrite(fn, 'dispatch-media/*')
}
// A picture texted to dispatch is filed as the POD on the driver's open load
// (amplify/functions/_shared/dispatchAutoPod.ts): the webhook reads loads and writes
// a driver submission, and stamps the delivery.
{
  const dispatchLoadTable = stageTables['Load']
  dispatchWebhookFn.addEnvironment('LOAD_TABLE_NAME', dispatchLoadTable.tableName)
  dispatchWebhookFn.addEnvironment('DRIVER_SUBMISSION_TABLE_NAME', driverSubmissionTable.tableName)
  dispatchWebhookFn.addEnvironment('DRIVER_SUBMISSION_DOC_TABLE_NAME', driverSubmissionDocTable.tableName)
  dispatchWebhookFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [dispatchLoadTable.tableArn],
  }))
  dispatchWebhookFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:Scan', 'dynamodb:PutItem'],
    resources: [driverSubmissionTable.tableArn, driverSubmissionDocTable.tableArn],
  }))
}

// Steps AJ/AK — per-truck driver work phones.
//  * tracking-actions and driver-app-api read TruckConfig (GetItem by truckId): every driver text goes to
//    the truck's work phone, and the driver app shows it. tracking-actions already has DRIVER_TABLE_NAME
//    (the loop above) and Scan on Driver; it gains GetItem for the personal number / assigned truck.
//  * the dispatch webhook scans TruckConfig so a text from a truck's work phone is matched to its driver,
//    and carries that text into the shipment thread by invoking tracking-actions as a system caller.
//    The function name travels through SSM (written in the tracking stack, read at run time): the tracking
//    stack already references the webhook stack (WEBHOOK_URL), so passing the name as an env var here
//    would close a CloudFormation cycle.
{
  const truckConfigTable = stageTables['TruckConfig']
  for (const fn of [trackingActionsFn, driverApiFn]) {
    if (fn !== trackingActionsFn) fn.addEnvironment('TRUCK_CONFIG_TABLE_NAME', truckConfigTable.tableName)
    fn.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [truckConfigTable.tableArn] }))
  }
  trackingActionsFn.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [dispatchDriverTable.tableArn] }))

  dispatchWebhookFn.addEnvironment('TRUCK_CONFIG_TABLE_NAME', truckConfigTable.tableName)
  dispatchWebhookFn.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Scan'], resources: [truckConfigTable.tableArn] }))

  let trackingRootStack: Stack = Stack.of(trackingActionsFn)
  while (trackingRootStack.nestedStackParent) trackingRootStack = trackingRootStack.nestedStackParent
  // Plain string at synth time (no tokens), distinct per deployment: the root stack name, hashed.
  const trackingFnParamName = `/bcat/tracking-actions/${createHash('sha256').update(trackingRootStack.stackName).digest('hex').slice(0, 16)}/function-name`
  new StringParameter(Stack.of(trackingActionsFn), 'TrackingActionsFunctionName', {
    parameterName: trackingFnParamName,
    stringValue: trackingActionsFn.functionName,
  })
  dispatchWebhookFn.addEnvironment('TRACKING_ACTIONS_PARAM_NAME', trackingFnParamName)
  dispatchWebhookFn.addToRolePolicy(new PolicyStatement({
    actions: ['ssm:GetParameter'],
    resources: [Stack.of(dispatchWebhookFn).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: trackingFnParamName.replace(/^\//, ''),
    })],
  }))
  trackingActionsFn.addPermission('DispatchWebhookInvoke', {
    principal: dispatchWebhookFn.grantPrincipal,
    action: 'lambda:InvokeFunction',
    sourceArn: dispatchWebhookFn.functionArn,
  })
}

// The five-minute nudge also flags drivers sitting at a stop past two hours
// (amplify/functions/_shared/dwellAlerts.ts): it reads loads and stamps the flagged stop.
{
  const nudgeLoadTable = stageTables['Load']
  dispatchNudgeFn.addEnvironment('LOAD_TABLE_NAME', nudgeLoadTable.tableName)
  dispatchNudgeFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:Scan', 'dynamodb:UpdateItem'],
    resources: [nudgeLoadTable.tableArn],
  }))
}

const dispatchWebhookUrl = new FunctionUrl(dispatchWebhookFn.stack, 'DispatchTwilioWebhookUrl', {
  function: dispatchWebhookFn,
  authType: FunctionUrlAuthType.NONE,
})
new CfnOutput(dispatchWebhookFn.stack, 'DispatchTwilioWebhookFunctionUrl', {
  value: dispatchWebhookUrl.url,
  description: 'Twilio webhook base for the dispatch number; every route needs ?t=<secret>',
})
// Delivery receipts for outbound texts come back to the webhook.
dispatchActionsFn.addEnvironment('WEBHOOK_URL', dispatchWebhookUrl.url)
dispatchSlackBridgeFn.addEnvironment('WEBHOOK_URL', dispatchWebhookUrl.url)
trackingActionsFn.addEnvironment('WEBHOOK_URL', dispatchWebhookUrl.url)
// Slack → driver: the intake webhook (which already receives every Slack event) recognises
// a driver channel by the conversation table and hands the event to the bridge.
webhookFn.addEnvironment('DISPATCH_CONVERSATION_TABLE_NAME', dispatchConversationTable.tableName)
webhookFn.addEnvironment('DISPATCH_SLACK_BRIDGE_FUNCTION_NAME', dispatchSlackBridgeFn.functionName)
webhookFn.addToRolePolicy(new PolicyStatement({
  actions: ['dynamodb:Query'],
  resources: [`${dispatchConversationTable.tableArn}/index/*`],
}))
dispatchSlackBridgeFn.grantInvoke(webhookFn)
// The driver app shows the dispatch number at the top: /me reads DISPATCH_NUMBER.
driverApiFn.addEnvironment('DISPATCH_PARAM_PATH', dispatchParamPath)
driverApiFn.addToRolePolicy(new PolicyStatement({
  actions: ['ssm:GetParameter'],
  resources: [dispatchParamArn],
}))
dispatchActionsFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
dispatchActionsFn.addToRolePolicy(new PolicyStatement({
  // AdminGetUser resolves the caller; ListUsers feeds the dispatcher pick-list.
  actions: ['cognito-idp:AdminGetUser', 'cognito-idp:ListUsers'],
  resources: [backend.auth.resources.userPool.userPoolArn],
}))

// ── rateconAssignedText Lambda (Load stream → "new ratecon" text to owner operators) ──
// An owner operator put on a load with a rate con gets one text from the dispatch number.
// Same stream as brokerLoadAlert; mapped in the Lambda's own stack for the same reason.
{
  const rateconTextFn = backend.rateconAssignedText.resources.lambda as LambdaFunction
  const rateconLoadTable = stageTables['Load']
  const rateconPayTable = stageTables['DriverPaySetting']
  rateconTextFn.addEnvironment('CONVERSATION_TABLE_NAME', dispatchConversationTable.tableName)
  rateconTextFn.addEnvironment('MESSAGE_TABLE_NAME', dispatchMessageTable.tableName)
  rateconTextFn.addEnvironment('SETTINGS_TABLE_NAME', dispatchSettingsTable.tableName)
  rateconTextFn.addEnvironment('DRIVER_TABLE_NAME', dispatchDriverTable.tableName)
  rateconTextFn.addEnvironment('PAY_SETTING_TABLE_NAME', rateconPayTable.tableName)
  rateconTextFn.addEnvironment('LOAD_TABLE_NAME', rateconLoadTable.tableName)
  rateconTextFn.addEnvironment('DISPATCH_PARAM_PATH', dispatchParamPath)
  rateconTextFn.addEnvironment('WEBHOOK_URL', dispatchWebhookUrl.url)
  rateconTextFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: [...dispatchTableArns, ...dispatchTableArns.map((arn) => `${arn}/index/*`)],
  }))
  rateconTextFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:Scan'],
    resources: [dispatchDriverTable.tableArn, rateconPayTable.tableArn],
  }))
  rateconTextFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    resources: [rateconLoadTable.tableArn],
  }))
  rateconTextFn.addToRolePolicy(new PolicyStatement({
    actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
    resources: [rateconLoadTable.tableStreamArn!],
  }))
  rateconTextFn.addToRolePolicy(new PolicyStatement({
    actions: ['ssm:GetParametersByPath', 'ssm:GetParameter'],
    resources: [dispatchParamArn],
  }))
  new EventSourceMapping(Stack.of(rateconTextFn), 'RateconAssignedTextStreamMapping', {
    target:           rateconTextFn,
    eventSourceArn:   rateconLoadTable.tableStreamArn,
    startingPosition: StartingPosition.LATEST,
    batchSize:        10,
    retryAttempts:    2,
    enabled:          process.env.BCAT_ISOLATED_PREVIEW !== 'true' && process.env.BCAT_DEV_STACK !== 'true',
  })
}

// ── amazonDisputeIntake Lambda (Google Form → AmazonDispute) ────────────────

const disputeFn = backend.amazonDisputeIntake.resources.lambda as LambdaFunction
const disputeTable = stageTables['AmazonDispute']

backend.amazonDisputeIntake.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],   // dedup via conditional put
    resources: [disputeTable.tableArn],
  })
)

disputeFn.addEnvironment('TABLE_NAME', disputeTable.tableName)

const disputeIntakeUrl = new FunctionUrl(disputeFn.stack, 'AmazonDisputeIntakeUrl', {
  function: disputeFn,
  authType: FunctionUrlAuthType.NONE,
})

new CfnOutput(disputeFn.stack, 'AmazonDisputeIntakeFunctionUrl', {
  value:       disputeIntakeUrl.url,
  description: 'Google-Form Apps Script DISPUTE_WEBHOOK_URL',
})

// ── slackStatusNotifier Lambda (custom AppSync mutation handler) ───────────

const notifierFn = backend.slackStatusNotifier.resources.lambda as LambdaFunction

// DynamoDB: read IntakeItem to get Slack thread context before posting reply
backend.slackStatusNotifier.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem'],
    resources: [intakeTable.tableArn],
  })
)

notifierFn.addEnvironment('TABLE_NAME', intakeTable.tableName)

// Intake Slack threads (Ryne 2026-11-12): the same Lambda posts process updates (PRO created, duplicate, dismissed, carrier booked,
// picked up, delivered, POD, released, invoice sent) under the Slack message an intake e-mail arrived as. Fed by four streams; it
// claims each line on the IntakeLoad row (slackPosted) and stores the thread there and on the shipment. Never money (intakeThread.ts).
// Mappings are created disabled on dev and isolated previews (the handler is also a dry run on dev).
{
  const threadSources = {
    IntakeLoad: tableOrNull('IntakeLoad'),
    Shipment: tableOrNull('Shipment'),
    ShipmentDocument: tableOrNull('ShipmentDocument'),
    Invoice: tableOrNull('Invoice'),
  }
  const threadLoad = tableOrNull('Load')
  const threadAudit = tableOrNull('AuditLog')
  if (threadSources.IntakeLoad && threadSources.Shipment && threadSources.ShipmentDocument && threadSources.Invoice && threadLoad && threadAudit) {
    const { IntakeLoad, Shipment, ShipmentDocument, Invoice } = threadSources
    notifierFn.addToRolePolicy(new PolicyStatement({
      actions:   ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
      resources: [IntakeLoad.tableStreamArn!, Shipment.tableStreamArn!, ShipmentDocument.tableStreamArn!, Invoice.tableStreamArn!],
    }))
    // GetItem + UpdateItem on IntakeLoad (thread + slackPosted claims) and Shipment (thread copy); read-only Load (carrier name).
    notifierFn.addToRolePolicy(new PolicyStatement({
      actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [IntakeLoad.tableArn, Shipment.tableArn],
    }))
    notifierFn.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [threadLoad.tableArn] }))
    notifierFn.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [threadAudit.tableArn] }))
    notifierFn.addEnvironment('INTAKE_LOAD_TABLE_NAME', IntakeLoad.tableName)
    notifierFn.addEnvironment('SHIPMENT_TABLE_NAME',    Shipment.tableName)
    notifierFn.addEnvironment('LOAD_TABLE_NAME',        threadLoad.tableName)
    notifierFn.addEnvironment('AUDIT_LOG_TABLE_NAME',   threadAudit.tableName)
    notifierFn.addEnvironment('PORTAL_ORIGIN',          PORTAL_ORIGIN)
    const threadMappingOn = process.env.BCAT_ISOLATED_PREVIEW !== 'true' && process.env.BCAT_DEV_STACK !== 'true'
    const threadFilters: Record<string, ReturnType<typeof FilterCriteria.filter>[] | undefined> = {
      // Only shipments built from (or linked to) an intake row; only POD documents.
      Shipment: [FilterCriteria.filter({ dynamodb: { NewImage: { intakeLoadId: { S: FilterRule.exists() } } } })],
      ShipmentDocument: [FilterCriteria.filter({ dynamodb: { NewImage: { type: { S: FilterRule.isEqual('POD') } } } })],
    }
    for (const [name, table] of Object.entries({ IntakeLoad, Shipment, ShipmentDocument, Invoice })) {
      // Own-stack scoping, as BrokerLoadStreamMapping (deploy #227 cycle).
      new EventSourceMapping(Stack.of(notifierFn), `IntakeThread${name}StreamMapping`, {
        target:           notifierFn,
        eventSourceArn:   table.tableStreamArn,
        startingPosition: StartingPosition.LATEST,
        batchSize:        10,
        retryAttempts:    1,
        filters:          threadFilters[name],
        enabled:          threadMappingOn,
      })
    }
  }
}

// ── payCreditApproval Lambda (managePayCredit mutation) ────────────────────
// Box-truck pay credits added by anyone but the owner/ADMIN wait for Ryne's approval:
// NOTIFY DMs him on Slack, APPROVE/REJECT stamp the credit (owner/ADMIN enforced in the
// handler). The Lambda reads the credit and the driver's name and writes only the
// approval fields; it never creates, deletes or re-prices a credit.
const payApprovalFn = backend.payCreditApproval.resources.lambda as LambdaFunction
const payApprovalCreditTable = stageTables['DriverPayCredit']
payApprovalFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
  resources: [payApprovalCreditTable.tableArn],
}))
payApprovalFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem'],
  resources: [stageTables['Driver'].tableArn],
}))
payApprovalFn.addToRolePolicy(new PolicyStatement({
  actions:   ['cognito-idp:AdminGetUser'],
  resources: [backend.auth.resources.userPool.userPoolArn],
}))
payApprovalFn.addEnvironment('PAY_CREDIT_TABLE_NAME', payApprovalCreditTable.tableName)
payApprovalFn.addEnvironment('DRIVER_TABLE_NAME', stageTables['Driver'].tableName)
payApprovalFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
payApprovalFn.addEnvironment('PORTAL_BASE_URL', PORTAL_PROD_ORIGIN)
payApprovalFn.addEnvironment('APPROVER_EMAIL', process.env.PAY_CREDIT_APPROVER_EMAIL ?? 'ryne@bcatcorp.com')

// ── fuelImport Lambda ──────────────────────────────────────────────────────

const fuelImportFn = backend.fuelImport.resources.lambda as LambdaFunction

const fuelTxTable = stageTables['FuelTransaction']
const fuelEquipmentTable = stageTables['Equipment']
backend.fuelImport.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    // Scan FuelTransaction (dedup) + Equipment (data-backed card→truck map); write FuelTransaction.
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem'],
    resources: [fuelTxTable.tableArn, fuelEquipmentTable.tableArn],
  })
)

fuelImportFn.addEnvironment('FUEL_TX_TABLE_NAME', fuelTxTable.tableName)
fuelImportFn.addEnvironment('EQUIPMENT_TABLE_NAME', fuelEquipmentTable.tableName)

const fuelImportUrl = new FunctionUrl(fuelImportFn.stack, 'FuelImportFunctionUrl', {
  function: fuelImportFn,
  authType: FunctionUrlAuthType.NONE,
})

new CfnOutput(fuelImportFn.stack, 'FuelImportFunctionUrlOutput', {
  value:       fuelImportUrl.url,
  description: 'Paste into SETUP.md → FUEL_IMPORT_WEBHOOK_URL',
})

// ── generateRecurringExpenses Lambda ──────────────────────────────────────

const recurringFn = backend.generateRecurringExpenses.resources.lambda as LambdaFunction

const expenseTypeTable   = stageTables['ExpenseType']
const allocationTable    = stageTables['TruckExpenseAllocation']
const recurringTable     = stageTables['RecurringExpense']
const expenseRecordTable = stageTables['ExpenseRecord']

// Permissions: read RecurringExpense, write ExpenseRecord, read+write seed tables
backend.generateRecurringExpenses.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:GetItem'],
    resources: [
      expenseTypeTable.tableArn,
      allocationTable.tableArn,
      recurringTable.tableArn,
      expenseRecordTable.tableArn,
    ],
  })
)

recurringFn.addEnvironment('EXPENSE_TYPE_TABLE_NAME',   expenseTypeTable.tableName)
recurringFn.addEnvironment('ALLOCATION_TABLE_NAME',     allocationTable.tableName)
recurringFn.addEnvironment('RECURRING_TABLE_NAME',      recurringTable.tableName)
recurringFn.addEnvironment('EXPENSE_RECORD_TABLE_NAME', expenseRecordTable.tableName)

// EventBridge cron — 1st of every month at 00:05 UTC
const monthlyRule = new Rule(recurringFn.stack, 'RecurringExpensesMonthlyRule', {
  schedule:    Schedule.cron({ minute: '5', hour: '0', day: '1', month: '*' }),
  description: 'Generate recurring expense records on the 1st of each month',
})
monthlyRule.addTarget(new EventsLambdaTarget(recurringFn))

// ── motiveMileageSync Lambda ───────────────────────────────────────────────

const motiveFn = backend.motiveMileageSync.resources.lambda as LambdaFunction

const truckConfigTable  = stageTables['TruckConfig']
const truckMileageTable = stageTables['TruckMileage']
const equipmentTable    = stageTables['Equipment']

const odometerDayTableForMileage = stageTables['TruckOdometerDay']
backend.motiveMileageSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem'],
    resources: [
      equipmentTable.tableArn,
      truckMileageTable.tableArn,
      odometerDayTableForMileage.tableArn,   // read-only: miles come from the odometer ledger
    ],
  })
)

motiveFn.addEnvironment('EQUIPMENT_TABLE_NAME',          equipmentTable.tableName)
motiveFn.addEnvironment('TRUCK_MILEAGE_TABLE_NAME',      truckMileageTable.tableName)
motiveFn.addEnvironment('TRUCK_ODOMETER_DAY_TABLE_NAME', odometerDayTableForMileage.tableName)

// EventBridge daily cron — 02:05 UTC every day
const dailyMileageRule = new Rule(motiveFn.stack, 'MotiveMileageDailySyncRule', {
  schedule:    Schedule.cron({ minute: '5', hour: '2', day: '*', month: '*' }),
  description: 'Sync Motive ELD mileage for every Motive vehicle daily',
})
dailyMileageRule.addTarget(new EventsLambdaTarget(motiveFn))
// Second pass 06:30 UTC — right after the odometer ledger closes the previous Central
// day (06:00 UTC), so yesterday's miles are final by the morning.
const mileageAfterCloseRule = new Rule(motiveFn.stack, 'MotiveMileageAfterOdometerCloseRule', {
  schedule:    Schedule.cron({ minute: '30', hour: '6', day: '*', month: '*' }),
  description: 'Re-sync Motive mileage after the odometer ledger closes the previous day',
})
mileageAfterCloseRule.addTarget(new EventsLambdaTarget(motiveFn))

// ── motiveLocationSync Lambda ──────────────────────────────────────────────

const motiveLocationFn = backend.motiveLocationSync.resources.lambda as LambdaFunction

const truckLocationTable        = stageTables['TruckLocation']
const truckLocationHistoryTable = stageTables['TruckLocationHistory']

backend.motiveLocationSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    // GetItem: read prior TruckLocation to preserve motionSince across syncs.
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:GetItem'],
    resources: [
      equipmentTable.tableArn,
      truckLocationTable.tableArn,
      truckLocationHistoryTable.tableArn,
    ],
  })
)

motiveLocationFn.addEnvironment('EQUIPMENT_TABLE_NAME',              equipmentTable.tableName)
motiveLocationFn.addEnvironment('TRUCK_LOCATION_TABLE_NAME',         truckLocationTable.tableName)
motiveLocationFn.addEnvironment('TRUCK_LOCATION_HISTORY_TABLE_NAME', truckLocationHistoryTable.tableName)

// EventBridge cron — every 10 minutes (near-real-time fleet positions)
const locationSyncRule = new Rule(motiveLocationFn.stack, 'MotiveLocationSyncRule', {
  schedule:    Schedule.rate(Duration.minutes(10)),
  description: 'Sync Motive ELD truck locations for every Motive vehicle every 10 minutes',
})
locationSyncRule.addTarget(new EventsLambdaTarget(motiveLocationFn))

// ── motiveFaultSync Lambda ─────────────────────────────────────────────────

const motiveFaultFn = backend.motiveFaultSync.resources.lambda as LambdaFunction

const truckFaultCodeTable = stageTables['TruckFaultCode']

backend.motiveFaultSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    // DeleteItem: a code Motive no longer reports as open is removed, so the
    // table always IS the current fault list.
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
    resources: [equipmentTable.tableArn, truckFaultCodeTable.tableArn],
  })
)

motiveFaultFn.addEnvironment('EQUIPMENT_TABLE_NAME',        equipmentTable.tableName)
motiveFaultFn.addEnvironment('TRUCK_FAULT_CODE_TABLE_NAME', truckFaultCodeTable.tableName)

// EventBridge cron — hourly. DTCs are maintenance signals, not live telemetry.
const faultSyncRule = new Rule(motiveFaultFn.stack, 'MotiveFaultSyncRule', {
  schedule:    Schedule.rate(Duration.hours(1)),
  description: 'Sync open Motive fault codes (DTCs) for every Motive vehicle hourly',
})
faultSyncRule.addTarget(new EventsLambdaTarget(motiveFaultFn))

// ── motiveOdometerSync Lambda ──────────────────────────────────────────────
// Weekly odometer ledger: Sunday opens the week (start odometer), and a daily run
// closes the previous Chicago calendar day (end odometer + miles + Motive fuel).

const motiveOdometerFn = backend.motiveOdometerSync.resources.lambda as LambdaFunction

const truckOdometerDayTable = stageTables['TruckOdometerDay']

backend.motiveOdometerSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    // GetItem: read the prior day's row to diff odometer readings.
    actions:   ['dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:PutItem'],
    resources: [equipmentTable.tableArn, truckOdometerDayTable.tableArn],
  })
)

motiveOdometerFn.addEnvironment('EQUIPMENT_TABLE_NAME',           equipmentTable.tableName)
motiveOdometerFn.addEnvironment('TRUCK_ODOMETER_DAY_TABLE_NAME', truckOdometerDayTable.tableName)

// Open the week — Sunday 06:00 UTC. EventBridge cron is UTC and ignores DST; 06:00
// UTC is 00:00 CST (winter) / 01:00 CDT (summer), i.e. Sunday in Chicago either
// way, so the opening read lands on the week's Sunday.
const odometerOpenWeekRule = new Rule(motiveOdometerFn.stack, 'MotiveOdometerOpenWeekRule', {
  schedule:    Schedule.cron({ minute: '0', hour: '6', month: '*', weekDay: '1' }),
  description: 'Open the odometer week: record every Motive truck\'s Sunday starting odometer',
})
odometerOpenWeekRule.addTarget(new EventsLambdaTarget(motiveOdometerFn, {
  event: RuleTargetInput.fromObject({ mode: 'openWeek' }),
}))

// Close the day — every day 06:00 UTC. Same reasoning: 06:00 UTC is after midnight
// Chicago in both CST and CDT, so the handler closes the PREVIOUS Chicago day
// (Saturday is closed by Sunday's run, etc.). DST shifts the wall-clock close by
// an hour but never the day boundary.
const odometerCloseDayRule = new Rule(motiveOdometerFn.stack, 'MotiveOdometerCloseDayRule', {
  schedule:    Schedule.cron({ minute: '0', hour: '6', day: '*', month: '*' }),
  description: 'Close yesterday: record end odometer, daily miles and Motive fuel for every Motive truck',
})
odometerCloseDayRule.addTarget(new EventsLambdaTarget(motiveOdometerFn, {
  event: RuleTargetInput.fromObject({ mode: 'closeDay' }),
}))


// ── intakeReconcile Lambda ────────────────────────────────────────────────────
// Replies in a tender's OWN Slack thread once its load exists, and moves the intake
// item to BUILT. It never starts a thread — see the handler for the refusal.
const intakeReconcileFn = backend.intakeReconcile.resources.lambda as LambdaFunction
const intakeReconcileTable = stageTables['IntakeItem']
intakeReconcileFn.addEnvironment('INTAKE_TABLE_NAME', intakeReconcileTable.tableName)
intakeReconcileFn.addEnvironment('LOAD_TABLE_NAME', stageTables['Load'].tableName)
intakeReconcileFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
    resources: [
      intakeReconcileTable.tableArn, `${intakeReconcileTable.tableArn}/index/*`,
      stageTables['Load'].tableArn,
      `${stageTables['Load'].tableArn}/index/*`,
    ],
  }),
)
// Writes only the reconciliation fields, and only on IntakeItem.
intakeReconcileFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [intakeReconcileTable.tableArn] }),
)
new Rule(backend.data.stack, 'IntakeReconcileSchedule', {
  // Every 20 minutes: chat.postMessage is one per second per channel and the cap is 40
  // per run, so a backlog drains over a few passes rather than in a burst.
  schedule: Schedule.rate(Duration.minutes(20)),
  targets: [new EventsLambdaTarget(intakeReconcileFn)],
})

// ── blueinkSync Lambda (Blue Ink Tech ELD) ─────────────────────────────────
// One Lambda, two cadences via the event payload: frequent location sync (default
// {}) and a daily mileage sync ({ mode: 'mileage' }). Writes into the same
// TruckMileage / TruckLocation tables as Motive so BIT trucks (e.g. unit 310)
// appear on the dashboard identically.

const blueinkFn = backend.blueinkSync.resources.lambda as LambdaFunction

backend.blueinkSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:GetItem'],
    resources: [
      equipmentTable.tableArn,
      truckMileageTable.tableArn,
      truckLocationTable.tableArn,
      truckLocationHistoryTable.tableArn,
    ],
  })
)

blueinkFn.addEnvironment('EQUIPMENT_TABLE_NAME',              equipmentTable.tableName)
blueinkFn.addEnvironment('TRUCK_MILEAGE_TABLE_NAME',          truckMileageTable.tableName)
blueinkFn.addEnvironment('TRUCK_LOCATION_TABLE_NAME',         truckLocationTable.tableName)
blueinkFn.addEnvironment('TRUCK_LOCATION_HISTORY_TABLE_NAME', truckLocationHistoryTable.tableName)
blueinkFn.addEnvironment('GOOGLE_PLACES_API_KEY',            process.env.GOOGLE_PLACES_API_KEY ?? '')

// Location: every 10 minutes (default event → location sync).
const blueinkLocationRule = new Rule(blueinkFn.stack, 'BlueInkLocationSyncRule', {
  schedule:    Schedule.rate(Duration.minutes(10)),
  description: 'Sync Blue Ink Tech truck locations every 10 minutes',
})
blueinkLocationRule.addTarget(new EventsLambdaTarget(blueinkFn))

// Mileage: daily at 02:20 UTC ({ mode: 'mileage' } → day/week/month/year).
const blueinkMileageRule = new Rule(blueinkFn.stack, 'BlueInkMileageSyncRule', {
  schedule:    Schedule.cron({ minute: '20', hour: '2', day: '*', month: '*' }),
  description: 'Sync Blue Ink Tech truck mileage (day/week/month/year) daily',
})
blueinkMileageRule.addTarget(new EventsLambdaTarget(blueinkFn, {
  event: RuleTargetInput.fromObject({ mode: 'mileage' }),
}))

// ── complianceScanner Lambda ───────────────────────────────────────────────

const complianceScannerFn = backend.complianceScanner.resources.lambda as LambdaFunction

const complianceDocTable   = stageTables['ComplianceDocument']
const onboardingTaskTable  = stageTables['OnboardingTask']
const complianceAlertTable = stageTables['ComplianceAlert']
const driverTable          = stageTables['Driver']

backend.complianceScanner.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
    resources: [
      complianceDocTable.tableArn,
      onboardingTaskTable.tableArn,
      complianceAlertTable.tableArn,
      driverTable.tableArn,
      truckConfigTable.tableArn,
    ],
  })
)

complianceScannerFn.addEnvironment('DOC_TABLE_NAME',          complianceDocTable.tableName)
complianceScannerFn.addEnvironment('TASK_TABLE_NAME',         onboardingTaskTable.tableName)
complianceScannerFn.addEnvironment('ALERT_TABLE_NAME',        complianceAlertTable.tableName)
complianceScannerFn.addEnvironment('DRIVER_TABLE_NAME',       driverTable.tableName)
complianceScannerFn.addEnvironment('TRUCK_CONFIG_TABLE_NAME', truckConfigTable.tableName)

// EventBridge daily cron — 6:00 AM America/Chicago.
// aws-events Schedule.cron is UTC-only; 11:00 UTC = 6:00 AM CDT (the DST-active
// half of the year). It runs at 5:00 AM CST in winter — acceptable drift for a
// daily expiration sweep. Switch to EventBridge Scheduler if exact local time matters.
const complianceScanRule = new Rule(complianceScannerFn.stack, 'ComplianceScannerDailyRule', {
  schedule:    Schedule.cron({ minute: '0', hour: '11', day: '*', month: '*' }),
  description: 'Daily DOT compliance expiration scan (6:00 AM America/Chicago)',
})
complianceScanRule.addTarget(new EventsLambdaTarget(complianceScannerFn))

// ── Shared compliance tables ───────────────────────────────────────────────

const onboardingInviteTable    = stageTables['OnboardingInvite']
const signatureRequestTable    = stageTables['DocumentSignatureRequest']
const driverApplicationTable   = stageTables['DriverApplication']
const auditLogTable            = stageTables['AuditLog']
const complianceSettingsTable  = stageTables['ComplianceSettings']


// ── onboardingPortalApi Lambda (public, token-validated Function URL) ───────

const portalApiFn = backend.onboardingPortalApi.resources.lambda as LambdaFunction

backend.onboardingPortalApi.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
    resources: [
      onboardingInviteTable.tableArn,
      driverTable.tableArn,
      onboardingTaskTable.tableArn,
      complianceDocTable.tableArn,
      driverApplicationTable.tableArn,
      auditLogTable.tableArn,
      signatureRequestTable.tableArn,
    ],
  })
)
// Presigned PUT uploads land under compliance/* in the documents bucket.
backend.storage.resources.bucket.grantPut(portalApiFn, 'compliance/*')
// Signed-form PDFs are written directly (base64 body) by the sign action.
backend.storage.resources.bucket.grantWrite(portalApiFn, 'compliance/*')

portalApiFn.addEnvironment('SIGN_REQ_TABLE_NAME', signatureRequestTable.tableName)
portalApiFn.addEnvironment('INVITE_TABLE_NAME', onboardingInviteTable.tableName)
portalApiFn.addEnvironment('DRIVER_TABLE_NAME', driverTable.tableName)
portalApiFn.addEnvironment('TASK_TABLE_NAME',   onboardingTaskTable.tableName)
portalApiFn.addEnvironment('DOC_TABLE_NAME',    complianceDocTable.tableName)
portalApiFn.addEnvironment('APP_TABLE_NAME',    driverApplicationTable.tableName)
portalApiFn.addEnvironment('AUDIT_TABLE_NAME',  auditLogTable.tableName)
portalApiFn.addEnvironment('BUCKET_NAME',       backend.storage.resources.bucket.bucketName)
portalApiFn.addEnvironment('ALLOWED_ORIGINS',   PORTAL_ORIGINS.join(','))

// Function URL — CORS locked to the prod domain + localhost:5173.
const portalApiUrl = new FunctionUrl(portalApiFn.stack, 'OnboardingPortalApiUrl', {
  function: portalApiFn,
  authType: FunctionUrlAuthType.NONE,
  cors: {
    allowedOrigins: PORTAL_ORIGINS,
    allowedMethods: [HttpMethod.POST],
    allowedHeaders: ['content-type'],
  },
})

new CfnOutput(portalApiFn.stack, 'OnboardingPortalApiFunctionUrl', {
  value:       portalApiUrl.url,
  description: 'Set as VITE_ONBOARDING_API_URL in the frontend env (driver portal API)',
})

// ── disputePortalApi Lambda (public Amazon dispute portal) ────────────────

const disputePortalApiFn = backend.disputePortalApi.resources.lambda as LambdaFunction
const disputeTableForPortal = stageTables['AmazonDispute']
const driverTableForPortal = stageTables['Driver']

backend.disputePortalApi.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:PutItem'],
    resources: [disputeTableForPortal.tableArn],
  })
)
// Driver dropdown on the public form: read-only, and the handler projects name + active only.
backend.disputePortalApi.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan'],
    resources: [driverTableForPortal.tableArn],
  })
)

// Guests PUT proof files via a presigned URL; the Lambda also HEADs them on submit.
backend.storage.resources.bucket.grantPut(disputePortalApiFn, 'dispute-proofs/*')
backend.storage.resources.bucket.grantRead(disputePortalApiFn, 'dispute-proofs/*')

// Allow the browser to complete the presigned PUT with content-type/content-length
// and the If-None-Match: * create-only guard.
const storageBucket = backend.storage.resources.bucket as Bucket
storageBucket.addCorsRule({
  allowedOrigins: PORTAL_ORIGINS,
  allowedMethods: [HttpMethods.PUT],
  allowedHeaders: ['*'],
  maxAge:         300,
})

disputePortalApiFn.addEnvironment('TABLE_NAME', disputeTableForPortal.tableName)
disputePortalApiFn.addEnvironment('DRIVER_TABLE_NAME', driverTableForPortal.tableName)
disputePortalApiFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)

const disputePortalApiUrl = new FunctionUrl(disputePortalApiFn.stack, 'DisputePortalApiUrl', {
  function: disputePortalApiFn,
  authType: FunctionUrlAuthType.NONE,
  cors: {
    allowedOrigins: PORTAL_ORIGINS,
    allowedMethods: [HttpMethod.POST],
    allowedHeaders: ['content-type'],
  },
})

new CfnOutput(disputePortalApiFn.stack, 'DisputePortalApiFunctionUrl', {
  value:       disputePortalApiUrl.url,
  description: 'Public driver dispute portal API URL',
})

// ── Step J: where a page-entered integration credential lives ──────────────
// One SecureString per provider under this path (the /bcat/pods/<pool>/connection
// precedent), scoped to the user pool id so the dev stack's parameters are dev's
// by construction. Two Lambdas touch it: tmsDirectoryActions reads and writes,
// trackingApi only reads. Amplify's own /amplify/* secret paths are never written
// from the app — those are rotated with `npx ampx secret set`.
const integrationParamPath = `/bcat/integrations/${backend.auth.resources.userPool.userPoolId}`

// ── trackingApi Lambda (public truck tracking page) ────────────────────────
const trackingApiFn = backend.trackingApi.resources.lambda as LambdaFunction
backend.trackingApi.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:GetItem'],
    resources: [
      stageTables['Equipment'].tableArn,
      stageTables['TruckLocation'].tableArn,
      stageTables['Driver'].tableArn,
      stageTables['Load'].tableArn,
    ],
  })
)
trackingApiFn.addEnvironment('EQUIPMENT_TABLE_NAME', stageTables['Equipment'].tableName)
trackingApiFn.addEnvironment('TRUCK_LOCATION_TABLE_NAME', stageTables['TruckLocation'].tableName)
trackingApiFn.addEnvironment('DRIVER_TABLE_NAME', stageTables['Driver'].tableName)
trackingApiFn.addEnvironment('LOAD_TABLE_NAME', stageTables['Load'].tableName)
// ── Step D: the shipment Customer Link and the carrier ping link ───────────
// Same public Lambda, three new routes (GET /s/<token>, GET /l/<token>,
// POST /l/<token>/ping). The token IS the TrackingLink row's primary key, so the
// lookup is a GetItem and no index can be walked from outside.
{
  const trackingLinkTable  = stageTables['TrackingLink']
  const loadCheckCallTable = stageTables['LoadCheckCall']
  const trackShipmentTable = stageTables['Shipment']
  const trackOrderTable    = stageTables['Order']
  const trackLoadCarrier   = stageTables['LoadCarrier']
  const trackDivisionTable = stageTables['Division']
  const trackSettingsTable = stageTables['TmsSettings']
  const trackHistoryTable  = stageTables['TruckLocationHistory']
  const trackQuoteTable    = stageTables['Quote']
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    // The link row itself: read it, bump its counters, expire it.
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [trackingLinkTable.tableArn],
  }))
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    // A ping writes one event row. Load is deliberately NOT writable from here.
    // Step AO: and one breadcrumb row in TruckLocationHistory (truckId 'load:<loadId>').
    actions:   ['dynamodb:PutItem'],
    resources: [loadCheckCallTable.tableArn, trackHistoryTable.tableArn, stageTables['ShipmentMessage'].tableArn],
  }))
  // The driver's accept / status taps are logged in the shipment thread.
  trackingApiFn.addEnvironment('SHIPMENT_MESSAGE_TABLE_NAME', stageTables['ShipmentMessage'].tableName)
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    // Step AO: the history table is read by key for the cached route row.
    actions:   ['dynamodb:GetItem'],
    resources: [trackShipmentTable.tableArn, trackDivisionTable.tableArn, trackSettingsTable.tableArn, trackHistoryTable.tableArn],
  }))
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${loadCheckCallTable.tableArn}/index/*`,
      `${trackOrderTable.tableArn}/index/*`,
      `${trackLoadCarrier.tableArn}/index/*`,
      `${stageTables['Load'].tableArn}/index/*`,
      `${trackHistoryTable.tableArn}/index/*`,
    ],
  }))
  // Driver stop taps are filed as stop events by tms-shipment-actions (plain identity grant).
  trackingApiFn.addEnvironment('TMS_SHIPMENT_ACTIONS_FUNCTION_NAME', backend.tmsShipmentActions.resources.lambda.functionName)
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['lambda:InvokeFunction'],
    resources: [backend.tmsShipmentActions.resources.lambda.functionArn],
  }))
  trackingApiFn.addEnvironment('TRACKING_LINK_TABLE_NAME',   trackingLinkTable.tableName)
  trackingApiFn.addEnvironment('LOAD_CHECK_CALL_TABLE_NAME', loadCheckCallTable.tableName)
  trackingApiFn.addEnvironment('SHIPMENT_TABLE_NAME',        trackShipmentTable.tableName)
  trackingApiFn.addEnvironment('ORDER_TABLE_NAME',           trackOrderTable.tableName)
  trackingApiFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',    trackLoadCarrier.tableName)
  trackingApiFn.addEnvironment('DIVISION_TABLE_NAME',        trackDivisionTable.tableName)
  trackingApiFn.addEnvironment('TMS_SETTINGS_TABLE_NAME',    trackSettingsTable.tableName)
  trackingApiFn.addEnvironment('TRUCK_LOCATION_HISTORY_TABLE_NAME', trackHistoryTable.tableName)
  // ── Step H: the public quote link (GET /q/<token>, POST /q/<token>/respond) ─
  // The token is not the primary key, so the row is found through the linkToken
  // index and the answer is one conditioned UpdateItem on the row itself. No
  // Put and no Delete: a public caller may move a quote it holds the live
  // secret for, and nothing else.
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [trackQuoteTable.tableArn],
  }))
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [`${trackQuoteTable.tableArn}/index/*`],
  }))
  trackingApiFn.addEnvironment('QUOTE_TABLE_NAME', trackQuoteTable.tableName)
  // ── Step E: the carrier upload portal (GET /u/<t>, POST /u/<t>/upload,
  // POST /u/<t>/commit) ─────────────────────────────────────────────────────
  // The public role may Put a ShipmentDocument row and Query the shipment's own
  // documents to render the checklist, and nothing else. There is deliberately no
  // Order, Load, LoadCarrier or Shipment write grant here: a file a carrier sends
  // lands PENDING and influences a billing decision only once a member of staff
  // accepts it from the review queue.
  const trackShipmentDocTable = stageTables['ShipmentDocument']
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:GetItem'],
    resources: [trackShipmentDocTable.tableArn, `${trackShipmentDocTable.tableArn}/index/*`],
  }))
  // The upload view reads the one load and the one assignment the token names,
  // by primary key. Both were Query-on-index only, which is enough for the
  // customer page but not for this one.
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem'],
    resources: [trackLoadCarrier.tableArn, stageTables['Load'].tableArn],
  }))
  // A ping writes the computed delivery ETA back to the assignment so the board
  // can show it without recomputing on every load.
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:UpdateItem'],
    resources: [trackLoadCarrier.tableArn],
  }))
  trackingApiFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME', trackShipmentDocTable.tableName)
  trackingApiFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
  // The upload is a presigned PUT this Lambda signs, pinned to the content type
  // and the length it has already validated; the commit reads the object's
  // headers back to prove what landed is what was promised.
  //
  // Spelled out rather than grantReadWrite, which would hand a public,
  // unauthenticated Function URL s3:DeleteObject* on every shipment document and
  // s3:List* on the whole bucket. This role puts a file and reads its headers,
  // and nothing in step E ever deletes an object.
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['s3:PutObject', 's3:GetObject'],
    resources: [`${backend.storage.resources.bucket.bucketArn}/shipment-docs/*`],
  }))
  // ── Step J: BCAT's own read API and the webhook receiver ──────────────────
  // POST /api/token mints a 1-hour bearer for an issued client; GET
  // /api/v1/shipments/<number> answers it from the identity table (a voided PRO
  // answers status VOIDED, never 404). POST /api/webhooks/<provider> verifies a
  // provider signature and files one idempotency receipt.
  //
  // The client secret's hash and the token signing key live in the OPENAPI
  // parameter; a provider's webhookSigningSecret lives in a parameter of its own,
  // `<path>/<PROVIDER>/webhook`, specifically so this grant can be written. The
  // provider's OTHER credentials — the DAT password, the HubSpot token, the
  // QuickBooks refresh token — sit in `<path>/<PROVIDER>`, which is deliberately
  // NOT readable here: this is the one Internet-facing Lambda in the stack.
  //
  // It writes the Integration row's lastUsedAt / webhook counters and holds
  // NOTHING on Invoice, FactoringItem or Order — a public endpoint must not be
  // able to see money, let alone move it.
  const integrationParamArnFor = (suffix: string): string =>
    Stack.of(trackingApiFn).formatArn({
      service: 'ssm',
      resource: 'parameter',
      // For hierarchical SSM parameter ARNs the leading slash is part of the resource id.
      resourceName: `${integrationParamPath.replace(/^\//, '')}/${suffix}`,
    })
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['ssm:GetParameter'],
    resources: [integrationParamArnFor('*/webhook'), integrationParamArnFor('OPENAPI')],
  }))
  const trackIntegrationTable = stageTables['Integration']
  const trackCarrierTable = stageTables['Carrier']
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    // GetItem reads the client row, UpdateItem stamps lastUsedAt, PutItem files
    // the webhook receipt with attribute_not_exists(id) — which IS the replay guard.
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem'],
    resources: [trackIntegrationTable.tableArn],
  }))
  // Step N2: MCP carrier.updated webhooks update Carrier rows by mcNumber.
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:Scan'],
    resources: [trackCarrierTable.tableArn],
  }))
  // The public shipment read finds the PRO through the Shipment table's own index.
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [`${trackShipmentTable.tableArn}/index/*`],
  }))
  trackingApiFn.addEnvironment('INTEGRATION_TABLE_NAME', trackIntegrationTable.tableName)
  trackingApiFn.addEnvironment('CARRIER_TABLE_NAME', trackCarrierTable.tableName)
  trackingApiFn.addEnvironment('INTEGRATION_PARAM_PATH', integrationParamPath)
  trackingApiFn.addEnvironment('OPENAPI_PARAM_NAME',     `${integrationParamPath}/OPENAPI`)
}
const trackingApiUrl = new FunctionUrl(trackingApiFn.stack, 'TrackingApiUrl', {
  function: trackingApiFn,
  authType: FunctionUrlAuthType.NONE,
  // POST is the carrier driver's one-tap location ping; GET is every read page.
  cors: { allowedOrigins: PORTAL_ORIGINS, allowedMethods: [HttpMethod.GET, HttpMethod.POST], allowedHeaders: ['content-type'] },
})
new CfnOutput(trackingApiFn.stack, 'TrackingApiFunctionUrl', { value: trackingApiUrl.url, description: 'Public truck tracking API URL' })

// ── workflow-agent Lambda (Step K: AI agents, the workflow inbox, AP extract) ─
//
// One worker for every AI workflow: quote / tender / AP / capacity e-mail and provider
// webhooks. It reads the directory, asks the model a schema-constrained question, and
// writes a WorkflowRun describing what it found.
//
// THE STRUCTURAL GUARANTEE, and the reason the grants below are written out one table
// at a time instead of a `grantReadWriteData` sweep: this role holds
//   * no write of any kind on Shipment, Order, Load, LoadCarrier, Invoice, CarrierBill,
//     FactoringItem, Customer, Carrier or TmsSettings, and
//   * no `lambda:InvokeFunction` on anything at all.
// So the agent cannot create freight and cannot reach AR, by IAM rather than by code
// review. Applying a proposal is still CREATE_SHIPMENT / SAVE_QUOTE / RECORD_BILL
// through the normal routers, under the person's own Cognito identity. The two writes
// it does hold are the ones that are its own output: the VendorPayable fields the AP
// extractor already filled in, and a PENDING ShipmentDocument row for an invoice it
// filed. Any widening here has to be argued on its own.
const workflowAgentFn = backend.workflowAgent.resources.lambda as LambdaFunction
const workflowRunTable         = stageTables['WorkflowRun']
const workflowShipmentTable    = stageTables['Shipment']
const workflowOrderTable       = stageTables['Order']
const workflowLoadTable        = stageTables['Load']
const workflowLoadCarrierTable = stageTables['LoadCarrier']
const workflowCustomerTable    = stageTables['Customer']
const workflowCarrierTable     = stageTables['Carrier']
const workflowCarrierContactTable = stageTables['CarrierContact']
const workflowLocationTable    = stageTables['Location']
const workflowQuoteTable       = stageTables['Quote']
const workflowShipmentDocTable = stageTables['ShipmentDocument']
const workflowSettingsTable    = stageTables['TmsSettings']
const workflowIntakeTable      = stageTables['IntakeItem']
const workflowSubmissionTable  = stageTables['DriverSubmission']
const workflowProClaimTable    = stageTables['ProClaim']
const workflowIntegrationTable = stageTables['Integration']
const workflowAuditLogTable    = stageTables['AuditLog']
// Step U: the tender e-mails a division's intake address received are staged as IntakeLoad
// rows (conditional put, so a re-run never overwrites a row a reviewer started editing),
// and the e-mail bridge asks which addresses to watch, so the division table is read-only
// here. Get/Put/Query/UpdateItem on IntakeLoad (see the policy below), never Delete — editing and promoting are tmsShipmentActions'.
const workflowIntakeLoadTable  = stageTables['IntakeLoad']
const workflowDivisionTable    = stageTables['OwnershipDivision']

// TABLE_NAME is VendorPayable: the moved AP extractor reads it under that name and
// changing it would be a rename for no gain.
workflowAgentFn.addEnvironment('TABLE_NAME',                    vendorApTable.tableName)
workflowAgentFn.addEnvironment('BUCKET_NAME',                   backend.storage.resources.bucket.bucketName)
workflowAgentFn.addEnvironment('WORKFLOW_RUN_TABLE_NAME',       workflowRunTable.tableName)
workflowAgentFn.addEnvironment('SHIPMENT_TABLE_NAME',           workflowShipmentTable.tableName)
workflowAgentFn.addEnvironment('ORDER_TABLE_NAME',              workflowOrderTable.tableName)
workflowAgentFn.addEnvironment('LOAD_TABLE_NAME',               workflowLoadTable.tableName)
workflowAgentFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',       workflowLoadCarrierTable.tableName)
workflowAgentFn.addEnvironment('CUSTOMER_TABLE_NAME',           workflowCustomerTable.tableName)
workflowAgentFn.addEnvironment('CARRIER_TABLE_NAME',            workflowCarrierTable.tableName)
workflowAgentFn.addEnvironment('CARRIER_CONTACT_TABLE_NAME',    workflowCarrierContactTable.tableName)
workflowAgentFn.addEnvironment('LOCATION_TABLE_NAME',           workflowLocationTable.tableName)
workflowAgentFn.addEnvironment('QUOTE_TABLE_NAME',              workflowQuoteTable.tableName)
workflowAgentFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME',  workflowShipmentDocTable.tableName)
workflowAgentFn.addEnvironment('TMS_SETTINGS_TABLE_NAME',       workflowSettingsTable.tableName)
workflowAgentFn.addEnvironment('INTAKE_ITEM_TABLE_NAME',        workflowIntakeTable.tableName)
workflowAgentFn.addEnvironment('DRIVER_SUBMISSION_TABLE_NAME',  workflowSubmissionTable.tableName)
workflowAgentFn.addEnvironment('PRO_CLAIM_TABLE_NAME',          workflowProClaimTable.tableName)
workflowAgentFn.addEnvironment('INTEGRATION_TABLE_NAME',        workflowIntegrationTable.tableName)
workflowAgentFn.addEnvironment('AUDIT_LOG_TABLE_NAME',          workflowAuditLogTable.tableName)
workflowAgentFn.addEnvironment('INTAKE_LOAD_TABLE_NAME',        workflowIntakeLoadTable.tableName)
workflowAgentFn.addEnvironment('OWNERSHIP_DIVISION_TABLE_NAME', workflowDivisionTable.tableName)
// Access tokens carry no e-mail; the action router resolves the caller through
// AdminGetUser for the owner/ADMIN checks, the vendorApActions pattern above.
workflowAgentFn.addEnvironment('USER_POOL_ID',                  backend.auth.resources.userPool.userPoolId)

// The run table is the agent's own. No DeleteItem: a run is DISMISSED or RESOLVED,
// never removed. The index ARNs carry the three queues (byAgent, byShipment, the
// sparse exceptionOpen worklist).
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
  resources: [workflowRunTable.tableArn, `${workflowRunTable.tableArn}/index/*`],
}))
// Query (through the status index) and UpdateItem too: the repeat-e-mail roll-up (findIntakeByReference / findIntakeDuplicate / logRepeatEmail /
// enrichIntakeLoad) and the already-built flag write need them, and without them every staging with a reference failed AccessDenied. No
// DeleteItem: a row is never removed here, and a person's edits are protected by the conditions on those writes.
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
  resources: [workflowIntakeLoadTable.tableArn, `${workflowIntakeLoadTable.tableArn}/index/*`],
}))
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: [workflowDivisionTable.tableArn],
}))

// Everything the agent needs to recognise a sender, a shipment or a document — read
// only. Scan is here because the directory match walks Customer/Carrier/CarrierContact
// whole; the rest are reached by key or through an index.
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: [
    workflowShipmentTable.tableArn,       `${workflowShipmentTable.tableArn}/index/*`,
    workflowOrderTable.tableArn,          `${workflowOrderTable.tableArn}/index/*`,
    workflowLoadTable.tableArn,           `${workflowLoadTable.tableArn}/index/*`,
    workflowLoadCarrierTable.tableArn,    `${workflowLoadCarrierTable.tableArn}/index/*`,
    workflowCustomerTable.tableArn,       `${workflowCustomerTable.tableArn}/index/*`,
    workflowCarrierTable.tableArn,        `${workflowCarrierTable.tableArn}/index/*`,
    workflowCarrierContactTable.tableArn, `${workflowCarrierContactTable.tableArn}/index/*`,
    workflowLocationTable.tableArn,       `${workflowLocationTable.tableArn}/index/*`,
    workflowQuoteTable.tableArn,          `${workflowQuoteTable.tableArn}/index/*`,
    workflowShipmentDocTable.tableArn,    `${workflowShipmentDocTable.tableArn}/index/*`,
    workflowSettingsTable.tableArn,       `${workflowSettingsTable.tableArn}/index/*`,
    workflowIntakeTable.tableArn,         `${workflowIntakeTable.tableArn}/index/*`,
    workflowSubmissionTable.tableArn,     `${workflowSubmissionTable.tableArn}/index/*`,
    workflowProClaimTable.tableArn,       `${workflowProClaimTable.tableArn}/index/*`,
    workflowIntegrationTable.tableArn,    `${workflowIntegrationTable.tableArn}/index/*`,
  ],
}))

// The AP extractor's one business write, unchanged from vendor-ap-extract: it fills the
// invoice fields nobody typed on a payable row it was handed. GetItem/Scan for the
// `{ all: true }` backfill. VendorPayable only — no other table is writable here.
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:UpdateItem'],
  resources: [vendorApTable.tableArn],
}))
// A carrier invoice the agent filed becomes one PENDING ShipmentDocument row that a
// person reviews. Put only: it can add a document, never change or accept one.
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:PutItem'],
  resources: [workflowShipmentDocTable.tableArn],
}))
// Every disposition writes its audit row.
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:PutItem'],
  resources: [workflowAuditLogTable.tableArn],
}))
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['cognito-idp:AdminGetUser'],
  resources: [backend.auth.resources.userPool.userPoolArn],
}))

// Attachments the agent reads: vendor invoices, Slack tender files, driver uploads.
// Read-only — the bytes a sender gave us are the record of what arrived.
backend.storage.resources.bucket.grantRead(workflowAgentFn, 'intake-pdfs/vendor-ap/*')
backend.storage.resources.bucket.grantRead(workflowAgentFn, 'intake-attachments/*')
backend.storage.resources.bucket.grantRead(workflowAgentFn, 'driver-docs/*')
// Its own inbox: the presigned PUTs it hands the bridge, the message.json it writes at
// commit, and the parked webhook bodies.
//
// Spelled out rather than grantReadWrite, which is BUCKET_READ_ACTIONS plus
// s3:DeleteObject* and bucket-wide s3:GetBucket*/s3:List*. This Lambda has a public
// NONE-auth Function URL, and the message is the evidence a run was ever justified:
// nothing here may delete one, and nothing here needs to list the bucket.
backend.storage.resources.bucket.grantRead(workflowAgentFn, 'workflow-inbox/*')
workflowAgentFn.addToRolePolicy(new PolicyStatement({
  actions:   ['s3:PutObject'],
  resources: [`${backend.storage.resources.bucket.bucketArn}/workflow-inbox/*`],
}))

// The e-mail bridge posts here. authType NONE, so the shared intake secret in the body
// is the only authentication — the handler compares it with timingSafeEqual.
const workflowAgentUrl = new FunctionUrl(workflowAgentFn.stack, 'WorkflowAgentUrl', {
  function: workflowAgentFn,
  authType: FunctionUrlAuthType.NONE,
})
new CfnOutput(workflowAgentFn.stack, 'WorkflowAgentFunctionUrl', {
  value:       workflowAgentUrl.url,
  description: 'Workflow inbox (prepare/commit)',
})

// Fails runs that died mid-flight (a timeout leaves IN_PROGRESS behind, and nothing
// else would ever close it). DISABLED on dev by the BCAT_DEV_STACK guard at the bottom
// of this file, where SWEEP_STALLED is the manual door.
if (triggerEnabled('workflowSweep', SCHEMA_STAGE)) {
  const workflowSweepRule = new Rule(workflowAgentFn.stack, 'WorkflowAgentSweepRule', {
    schedule:    Schedule.rate(Duration.minutes(15)),
    description: 'Fail stalled workflow runs every 15 minutes',
  })
  workflowSweepRule.addTarget(new EventsLambdaTarget(workflowAgentFn, {
    event: RuleTargetInput.fromObject({ sweep: true }),
  }))
}

// ── The four bridges that hand work to the agent ───────────────────────────
// Each is one asynchronous invoke inside a try/catch that only warns: a workflow that
// cannot start must never fail the intake that was going to succeed. The invoke grant
// points at workflowAgentFn — the agent itself still holds no InvokeFunction anywhere.
//
// vendor-ap-intake keeps the old env var name. From the stage that creates WorkflowRun it names
// the workflow agent (run hand-off payload); below it, vendor-ap-extract is still the target
// (`{ id }` payload), exactly as production does today. VENDOR_AP_EXTRACT_TARGET tells the
// intake which payload to send; unset means the legacy extractor.
if (vendorApExtractFn) {
  vendorApIntakeFn.addEnvironment('VENDOR_AP_EXTRACT_FUNCTION_NAME', vendorApExtractFn.functionName)
  vendorApExtractFn.grantInvoke(vendorApIntakeFn)
} else {
  vendorApIntakeFn.addEnvironment('VENDOR_AP_EXTRACT_FUNCTION_NAME', workflowAgentFn.functionName)
  vendorApIntakeFn.addEnvironment('VENDOR_AP_EXTRACT_TARGET', 'workflow-agent')
  workflowAgentFn.grantInvoke(vendorApIntakeFn)
}
// slack-intake-webhook: an e-mailed tender that landed as an IntakeItem.
webhookFn.addEnvironment('WORKFLOW_AGENT_FUNCTION_NAME', workflowAgentFn.functionName)
workflowAgentFn.grantInvoke(webhookFn)
// driver-app-api: the loads inbox commit (a driver/Ivan e-mail submission).
driverApiFn.addEnvironment('WORKFLOW_AGENT_FUNCTION_NAME', workflowAgentFn.functionName)
workflowAgentFn.grantInvoke(driverApiFn)
// tracking-api: a provider webhook, parked in S3 first so the agent reads the body it
// was actually sent rather than a re-serialised copy.
trackingApiFn.addEnvironment('WORKFLOW_AGENT_FUNCTION_NAME', workflowAgentFn.functionName)
workflowAgentFn.grantInvoke(trackingApiFn)
trackingApiFn.addToRolePolicy(new PolicyStatement({
  actions:   ['s3:PutObject'],
  resources: [`${backend.storage.resources.bucket.bucketArn}/workflow-inbox/*`],
}))

// ── rateConSignApi Lambda (public rate-confirmation signing page) ──────────
// A carrier signs without an account: the emailed link carries a one-time token
// on the LoadCarrier row, and this Lambda is the only thing that can read it.
// Kept OUT of the isolated-preview allowlist further down — it serves a public
// Function URL, so a preview stack must never be able to answer on it.
const rateConSignApiFn      = backend.rateConSignApi.resources.lambda as LambdaFunction
const signLoadCarrierTable  = stageTables['LoadCarrier']
const signLoadTable         = stageTables['Load']
const signShipmentTable     = stageTables['Shipment']
const signCarrierDocTable   = stageTables['CarrierDocument']
const signDivisionTable     = stageTables['Division']
const signSettingsTable     = stageTables['TmsSettings']
const signAuditLogTable     = stageTables['AuditLog']
const signShipmentDocTable  = stageTables['ShipmentDocument']
const signShipmentMessageTable = stageTables['ShipmentMessage']

// The token is found by scanning LoadCarrier (the table may only gain one GSI
// per deploy and carrierId is that one), exactly as validateInvite does.
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan'],
    resources: [signLoadCarrierTable.tableArn],
  })
)
// Everything the signing page displays: the load behind the assignment, the
// division letterhead, the carrier-settings row and the unsigned document. This
// role answers an unauthenticated Function URL, so a table the handler never
// opens is a table it must not be able to open.
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem'],
    resources: [
      signLoadTable.tableArn,
      signCarrierDocTable.tableArn,
      signDivisionTable.tableArn,
      signSettingsTable.tableArn,
    ],
  })
)
// In-place writes touch one row and one table: the assignment the token belongs
// to (status, request counter, the driver fields the carrier typed).
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:UpdateItem'],
    resources: [signLoadCarrierTable.tableArn],
  })
)
// Step AM: signing moves the assignment up the ladder, and the board's mirror of the rung lives on the
// Load and the Shipment. UpdateItem only; nothing else of either table is reachable from here.
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:UpdateItem'],
    resources: [signLoadTable.tableArn, signShipmentTable.tableArn],
  })
)
// Signing writes new rows: the signed-copy CarrierDocument, the load's Documents row (ShipmentDocument,
// the Public-folder signed rate con the invoice packet picks up) and the audit trail.
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],
    resources: [signCarrierDocTable.tableArn, signAuditLogTable.tableArn, signShipmentDocTable.tableArn, signShipmentMessageTable.tableArn],
  })
)
// The previous signed version is flipped to SUPERSEDED (UpdateItem), and the shipment's documents are read
// through the shipmentId index to find it. Nothing here can delete a document.
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:UpdateItem'],
    resources: [signShipmentDocTable.tableArn],
  })
)
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [signShipmentDocTable.tableArn, `${signShipmentDocTable.tableArn}/index/*`, signAuditLogTable.tableArn, `${signAuditLogTable.tableArn}/index/*`],
  })
)
// An old link finds the assignment it belonged to, to say the rate con was replaced.
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem'],
    resources: [signLoadCarrierTable.tableArn],
  })
)
// Reads the unsigned PDF to presign a GET of it; writes the stamped copy under shipment-docs/ (the
// document-upload convention) and reads it back only to heal a lost Documents row.
backend.storage.resources.bucket.grantReadWrite(rateConSignApiFn, 'rate-confirms/*')
backend.storage.resources.bucket.grantReadWrite(rateConSignApiFn, 'shipment-docs/*')

rateConSignApiFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',    signLoadCarrierTable.tableName)
rateConSignApiFn.addEnvironment('LOAD_TABLE_NAME',            signLoadTable.tableName)
rateConSignApiFn.addEnvironment('SHIPMENT_TABLE_NAME',        signShipmentTable.tableName)
rateConSignApiFn.addEnvironment('SHIPMENT_MESSAGE_TABLE_NAME', signShipmentMessageTable.tableName)
// The signed-reply e-mail is sent by tracking-actions; the plain identity grant (not a resource policy) is what an IAM role needs.
rateConSignApiFn.addEnvironment('TMS_TRACKING_ACTIONS_FUNCTION_NAME', backend.tmsTrackingActions.resources.lambda.functionName)
backend.rateConSignApi.resources.lambda.addToRolePolicy(new PolicyStatement({
  actions:   ['lambda:InvokeFunction'],
  resources: [backend.tmsTrackingActions.resources.lambda.functionArn],
}))
rateConSignApiFn.addEnvironment('CARRIER_DOCUMENT_TABLE_NAME', signCarrierDocTable.tableName)
rateConSignApiFn.addEnvironment('DIVISION_TABLE_NAME',        signDivisionTable.tableName)
rateConSignApiFn.addEnvironment('SETTINGS_TABLE_NAME',        signSettingsTable.tableName)
rateConSignApiFn.addEnvironment('AUDIT_LOG_TABLE_NAME',       signAuditLogTable.tableName)
rateConSignApiFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME', signShipmentDocTable.tableName)
rateConSignApiFn.addEnvironment('BUCKET_NAME',                backend.storage.resources.bucket.bucketName)

const rateConSignApiUrl = new FunctionUrl(rateConSignApiFn.stack, 'RateConSignApiUrl', {
  function: rateConSignApiFn,
  authType: FunctionUrlAuthType.NONE,
  cors: {
    allowedOrigins: PORTAL_ORIGINS,
    allowedMethods: [HttpMethod.POST],
    allowedHeaders: ['content-type'],
  },
})

new CfnOutput(rateConSignApiFn.stack, 'RateConSignApiFunctionUrl', {
  value:       rateConSignApiUrl.url,
  description: 'Public carrier rate-confirmation signing API URL',
})

backend.addOutput({
  custom: {
    trackingApiUrl: trackingApiUrl.url,
    disputePortalUrl: disputePortalApiUrl.url,
    driverUserPoolId: driverPool.userPoolId,
    driverUserPoolClientId: driverPoolClient.userPoolClientId,
    driverApiUrl: driverApiUrl.url,
    rateConSignUrl: rateConSignApiUrl.url,
  },
})

// ── onboardingEmailer Lambda (SES, custom AppSync mutation) ─────────────────

const emailerFn = backend.onboardingEmailer.resources.lambda as LambdaFunction

backend.onboardingEmailer.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan'],
    resources: [onboardingInviteTable.tableArn, driverTable.tableArn, complianceSettingsTable.tableArn],
  })
)
backend.onboardingEmailer.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] })
)
emailerFn.addEnvironment('INVITE_TABLE_NAME',   onboardingInviteTable.tableName)
emailerFn.addEnvironment('DRIVER_TABLE_NAME',   driverTable.tableName)
emailerFn.addEnvironment('SETTINGS_TABLE_NAME', complianceSettingsTable.tableName)
// Invite links must point at the deployed app, not the caller's browser origin (which is
// localhost when an admin kicks off an invite from `npm run dev`). Same prod origin the
// scanner uses. Overrides the client-supplied portalBaseUrl in the handler.
emailerFn.addEnvironment('PORTAL_BASE_URL',     PORTAL_ORIGIN)

// ── driverPayEmailer Lambda (SES raw — PDF statement attachment) ────────────

const payEmailerFn = backend.driverPayEmailer.resources.lambda as LambdaFunction
backend.driverPayEmailer.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] })
)
payEmailerFn.addEnvironment('FROM_ADDRESS', process.env.DRIVER_PAY_FROM_ADDRESS ?? 'ai4bcat@gmail.com')

// ── vehicleQuoteEmailer Lambda (SES — HTML vehicle-transport quote) ─────────
// Sends the customer-facing Best Care Auto Transport quote from ruben@bcatcorp.com
// and always BCCs cars@bcatcorp.com. bcatcorp.com is domain-verified in SES (see
// the note below), so no per-address verification is needed.

const quoteEmailerFn = backend.vehicleQuoteEmailer.resources.lambda as LambdaFunction
// SendRawEmail is required because the quote email is sent as raw MIME whenever it
// embeds the inline logo (Content.Raw in SESv2 maps to the ses:SendRawEmail action).
backend.vehicleQuoteEmailer.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] })
)
quoteEmailerFn.addEnvironment('FROM_ADDRESS', process.env.QUOTE_FROM_ADDRESS ?? 'ruben@bcatcorp.com')
// cars@ is CC'd (visible to the customer), not BCC'd.
quoteEmailerFn.addEnvironment('CC_ADDRESS',   process.env.QUOTE_CC_ADDRESS ?? process.env.QUOTE_BCC_ADDRESS ?? 'cars@bcatcorp.com')

// ── googleReviews Lambda (live Google rating + count for the quote CTA) ─────
// Plain env vars (not secrets) so a missing value never blocks the deploy — set
// both in the Amplify Console to activate the "★ reviews on Google" CTA. Until
// then the Lambda returns { configured: false } and the CTA is hidden.
const googleReviewsFn = backend.googleReviews.resources.lambda as LambdaFunction
googleReviewsFn.addEnvironment('GOOGLE_PLACES_API_KEY', process.env.GOOGLE_PLACES_API_KEY ?? '')
googleReviewsFn.addEnvironment('GOOGLE_PLACE_ID',       process.env.GOOGLE_PLACE_ID ?? '')
// Optional overrides — the handler defaults these to the Best Care listing.
googleReviewsFn.addEnvironment('GOOGLE_PLACE_QUERY',    process.env.GOOGLE_PLACE_QUERY ?? '')
googleReviewsFn.addEnvironment('GOOGLE_REVIEWS_URL',    process.env.GOOGLE_REVIEWS_URL ?? '')

// ── paychexPaySync Lambda (weekly Paychex Flex → DriverPayPeriod) ───────────

const paychexFn      = backend.paychexPaySync.resources.lambda as LambdaFunction
const driverPayTable = stageTables['DriverPayPeriod']
backend.paychexPaySync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],
    resources: [driverPayTable.tableArn],
  })
)
paychexFn.addEnvironment('PAY_TABLE_NAME', driverPayTable.tableName)
// Paychex company id is an account number (not a secret) — set as a plain env var.
paychexFn.addEnvironment('PAYCHEX_COMPANY_ID', process.env.PAYCHEX_COMPANY_ID ?? '')

// Monday at 11:00 UTC (06:00 CDT / 05:00 CST), before the weekly finance review.
const paychexWeeklyRule = new Rule(paychexFn.stack, 'PaychexPaySyncWeeklyRule', {
  schedule: Schedule.cron({ minute: '0', hour: '11', weekDay: 'MON' }),
  description: 'Weekly Paychex Flex pay-period sync (Monday 11:00 UTC)',
})
paychexWeeklyRule.addTarget(new EventsLambdaTarget(paychexFn))
emailerFn.addEnvironment('FROM_ADDRESS', 'onboarding@bcatcorp.com')

// ── SES sending domain (bcatcorp.com) ──────────────────────────────────────
// The bcatcorp.com SES domain identity is managed OUT OF BAND (one-time,
// account-global) and is intentionally NOT created here. A CDK-managed
// AWS::SES::EmailIdentity is provisioned per Amplify branch stack, but SES permits
// only one identity per domain per account — so every additional branch deploy
// collided with "bcatcorp.com already exists in stack …" and rolled the data stack
// back. Verify the domain + DKIM once in the SES console; the emailer/scanner
// Lambdas only need ses:SendEmail + the FROM_ADDRESS env var (granted below).
backend.complianceScanner.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] })
)

// ── complianceScanner: Phase 4 escalation wiring ────────────────────────────
// Granted/env'd here (not in the scanner block above) because the escalation
// tables are declared in the shared-compliance section.

const escalationRuleTable     = stageTables['EscalationRule']
const escalationEmailLogTable = stageTables['EscalationEmailLog']

backend.complianceScanner.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [
      escalationRuleTable.tableArn,
      escalationEmailLogTable.tableArn,
      complianceSettingsTable.tableArn,
      onboardingInviteTable.tableArn,
      auditLogTable.tableArn,
    ],
  })
)
complianceScannerFn.addEnvironment('RULE_TABLE_NAME',     escalationRuleTable.tableName)
complianceScannerFn.addEnvironment('EMAILLOG_TABLE_NAME', escalationEmailLogTable.tableName)
complianceScannerFn.addEnvironment('SETTINGS_TABLE_NAME', complianceSettingsTable.tableName)
complianceScannerFn.addEnvironment('INVITE_TABLE_NAME',   onboardingInviteTable.tableName)
complianceScannerFn.addEnvironment('AUDIT_TABLE_NAME',    auditLogTable.tableName)
complianceScannerFn.addEnvironment('FROM_ADDRESS',        'onboarding@bcatcorp.com')
complianceScannerFn.addEnvironment('PORTAL_BASE_URL',     PORTAL_ORIGIN)

// ── tmsDirectoryActions Lambda ──────────────────────────────────────────────
// Directory, config, and merge writes. Customer/Location/Division/Settings/MergeJob
// tables are written via raw DynamoDB SDK; Load repoints during merge use the
// generated AppSync mutation (allow.resource(tmsDirectoryActions) on Load).
const directoryActionsFn = backend.tmsDirectoryActions.resources.lambda as LambdaFunction
const directoryCustomerTable = stageTables['Customer']
const directoryLocationTable = stageTables['Location']
const directoryDivisionTable = stageTables['Division']
const directorySettingsTable = stageTables['TmsSettings']
const directoryMergeJobTable = stageTables['DirectoryMergeJob']
// Step L — spreadsheet import jobs.
const directoryImportJobTable = stageTables['ImportJob']
const directoryOwnershipDivisionTable = stageTables['OwnershipDivision']
const directoryOwnershipRuleTable     = stageTables['OwnershipRule']
const directoryShipmentViewTable      = stageTables['ShipmentView']
const directoryShipmentColumnTemplateTable = stageTables['ShipmentColumnTemplate']
const directoryLoadTable = stageTables['Load']
// Step J: one row per integration provider, API client and webhook receipt.
const directoryIntegrationTable = stageTables['Integration']
// Step N2: MyCarrierPackets sync writes compliance data onto Carrier rows.
const directoryCarrierTable = stageTables['Carrier']

const directoryTableArns = [
  directoryCustomerTable.tableArn,
  directoryLocationTable.tableArn,
  directoryDivisionTable.tableArn,
  directorySettingsTable.tableArn,
  directoryMergeJobTable.tableArn,
  directoryImportJobTable.tableArn,
  directoryLoadTable.tableArn,
  // Step I: saving teams mirrors the membership onto each UserProfile.teamKeys,
  // so the one save keeps the settings row and the staff rows in step.
  stageTables['UserProfile'].tableArn,
  // Step R: the self-serve revenue taxonomy and the saved department views.
  // tmsDirectoryActions is their only writer — the client reads the three
  // tables directly and never writes them.
  directoryOwnershipDivisionTable.tableArn,
  directoryOwnershipRuleTable.tableArn,
  directoryShipmentViewTable.tableArn,
  directoryShipmentColumnTemplateTable.tableArn,
  // Step R: the taxonomy and view edits are audited like every other settings write.
  stageTables['AuditLog'].tableArn,
  // Step J: the integration framework's only table. Note what is NOT here —
  // Shipment, Order, Invoice and FactoringItem are deliberately absent, so no
  // integration action can reach AR or create a factoring row even by mistake.
  directoryIntegrationTable.tableArn,
  // Step N2: Carrier is here for the MyCarrierPackets sync — mcpStatus,
  // safetyRating, insurancePolicies and review fields only, never status.
  directoryCarrierTable.tableArn,
]

directoryActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Scan'],
    resources: directoryTableArns,
  }),
)

// One suffix instead of a full name per table: Lambda caps environment variables at 4 KB and 17
// table names took tms-directory-actions over it (deploy 158). The handler derives `<Model>-<suffix>`.
// The api id is cut out of a table name (no reference to the API construct: that would close a cycle).
directoryActionsFn.addEnvironment('DATA_TABLE_SUFFIX', `${Fn.select(1, Fn.split('-', directoryCustomerTable.tableName))}-NONE`)
directoryActionsFn.addEnvironment('USER_POOL_ID',                  backend.auth.resources.userPool.userPoolId)
directoryActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  }),
)

// ── Step J: the integration framework on tmsDirectoryActions ────────────────
// Reads and writes the page-entered credentials under `integrationParamPath`
// (declared above the trackingApi block, which reads the same path).
const integrationParamArn = Stack.of(directoryActionsFn).formatArn({
  service: 'ssm',
  resource: 'parameter',
  // For hierarchical SSM parameter ARNs the leading slash is part of the resource id.
  resourceName: `${integrationParamPath.replace(/^\//, '')}/*`,
})
directoryActionsFn.addEnvironment('INTEGRATION_PARAM_PATH', integrationParamPath)
directoryActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
    resources: [integrationParamArn],
  }),
)
// Twilio is provisioned by scripts/dispatchTwilioSetup.mjs, not from the app. The
// Integrations page needs to say whether that has been run for this pool, which is
// a read of the parameter NAMES under the path — never a value (WithDecryption is
// off in readTwilioStatus, and no Put or Delete is granted here).
directoryActionsFn.addEnvironment('DISPATCH_PARAM_PATH', dispatchParamPath)
directoryActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['ssm:GetParametersByPath'],
    resources: [dispatchParamArn],
  }),
)
// A webhook receipt (`evt:<PROVIDER>:<eventId>`, kind WEBHOOK_EVENT) exists only to
// refuse a replay, so DynamoDB expires it rather than anything sweeping the table.
// `ttlEpoch` is epoch seconds ≈10 minutes out, written by tracking-api: twice the
// ±300 s signature window, so a duplicate of a delivery at the far edge still
// finds its receipt. Provider and API-client rows carry no `ttlEpoch` and are
// never touched by TTL. `defineData` provisions AMPLIFY_TABLE, so the wrapper is
// the supported way to set this.
stageCfnTables['Integration'].timeToLiveAttribute = {
  attributeName: 'ttlEpoch',
  enabled: true,
}

// ── Point-in-time recovery on every table (Aljex-exit Phase 0) ───────────────
// An in-place property flip (no replacement, no data movement, no GSI change) on every
// Amplify-managed table. PITR keeps 35 days and is also what makes
// ExportTableToPointInTime (the nightly export) and RestoreTableToPointInTime (restore to
// a new table) usable. Shared file: this lands on production tables too when dev merges.
// NOT driven by the schema stage (incident 2026-11-07: a stage that flipped it on all 60 existing tables was
// throttled, "Rate exceeded", and its rollback failed). Production main sets no env, so it never flips PITR and the
// deployed tables keep their existing form; tables created at a later stage are created WITHOUT it (on-demand
// backups cover the cutover). Dev (BCAT_DEV_STACK=true) at the final stage keeps it on; a staged rehearsal sets
// BCAT_ENABLE_PITR=false to mirror production. See pitrEnabled and AW_STAGED_DEPLOY.md "PITR (deferred...)".
if (pitrEnabled(process.env, SCHEMA_STAGE)) {
  for (const table of Object.values(stageCfnTables)) {
    table.pointInTimeRecoveryEnabled = true
  }
}

// ── Step N2: MyCarrierPackets scheduled sync ───────────────────────────────
const mcpSyncFn = backend.mcpSync.resources.lambda as LambdaFunction
const mcpSyncCarrierTable = stageTables['Carrier']
mcpSyncFn.addEnvironment('CARRIER_TABLE_NAME', mcpSyncCarrierTable.tableName)
mcpSyncFn.addEnvironment('INTEGRATION_PARAM_PATH', integrationParamPath)
mcpSyncFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:PutItem'],
    resources: [mcpSyncCarrierTable.tableArn],
  }),
)
// MyCarrierPackets pull: contacts and payment methods are written beside the carrier, and
// every pull is audited. directoryActions starts a pull by invoking this function async.
const mcpSyncContactTable = stageTables['CarrierContact']
const mcpSyncPaymentTable = stageTables['CarrierPaymentMethod']
const mcpSyncAuditTable   = stageTables['AuditLog']
mcpSyncFn.addEnvironment('CARRIER_CONTACT_TABLE_NAME',        mcpSyncContactTable.tableName)
mcpSyncFn.addEnvironment('CARRIER_PAYMENT_METHOD_TABLE_NAME', mcpSyncPaymentTable.tableName)
mcpSyncFn.addEnvironment('AUDIT_LOG_TABLE_NAME',              mcpSyncAuditTable.tableName)
mcpSyncFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [
      mcpSyncContactTable.tableArn, `${mcpSyncContactTable.tableArn}/index/*`,
      mcpSyncPaymentTable.tableArn, `${mcpSyncPaymentTable.tableArn}/index/*`,
    ],
  }),
)
mcpSyncFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [mcpSyncAuditTable.tableArn] }),
)
directoryActionsFn.addEnvironment('MCP_SYNC_FUNCTION_NAME', mcpSyncFn.functionName)
// Step AM: when MCP activates a carrier, assignments waiting on setup advance (LoadCarrier) and the
// rung is mirrored onto the Load and Shipment rows. No other write reaches those tables from here.
const mcpSyncLoadCarrierTable = stageTables['LoadCarrier']
const mcpSyncShipmentTable    = stageTables['Shipment']
const mcpSyncLoadTable        = stageTables['Load']
mcpSyncFn.addEnvironment('LOAD_CARRIER_TABLE_NAME', mcpSyncLoadCarrierTable.tableName)
mcpSyncFn.addEnvironment('SHIPMENT_TABLE_NAME',     mcpSyncShipmentTable.tableName)
mcpSyncFn.addEnvironment('LOAD_TABLE_NAME',         mcpSyncLoadTable.tableName)
mcpSyncFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query', 'dynamodb:UpdateItem'],
    resources: [mcpSyncLoadCarrierTable.tableArn, `${mcpSyncLoadCarrierTable.tableArn}/index/*`],
  }),
)
mcpSyncFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [mcpSyncShipmentTable.tableArn, mcpSyncLoadTable.tableArn] }),
)
// Step AD (Find & Invite): the invitation is noted on the load's thread. PutItem on ShipmentMessage only:
// no Shipment, Order or invoice table is reachable from here.
const directoryMessageTable = stageTables['ShipmentMessage']
directoryActionsFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [directoryMessageTable.tableArn] }),
)
directoryActionsFn.addToRolePolicy(
  new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [mcpSyncFn.functionArn] }),
)
mcpSyncFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['ssm:GetParameter'],
    resources: [integrationParamArn],
  }),
)
// Step S4: heartbeat. A successful run stamps lastOkAt on the MYCARRIERPACKETS
// Integration row so Platform health can show an honest "last sync".
const mcpSyncIntegrationTable = stageTables['Integration']
mcpSyncFn.addEnvironment('INTEGRATION_TABLE_NAME', mcpSyncIntegrationTable.tableName)
mcpSyncFn.addToRolePolicy(
  new PolicyStatement({
    // GetItem: the LIVE gate. Put/Delete: the resume cursor row. UpdateItem: the heartbeat.
    actions:   ['dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
    resources: [mcpSyncIntegrationTable.tableArn],
  }),
)
// The rule is created enabled. The dev-stack guard later disables schedules, so
// dev still deploys but does not poll MCP by itself. Every 5 minutes (Ryne 2026-11-09: a carrier that finishes its packet must become
// Active and fill its profile right away): just over the 4-minute minimum MCP's guide sets between polling calls.
if (triggerEnabled('mcpSync', SCHEMA_STAGE)) {
  const mcpSyncRule = new Rule(mcpSyncFn.stack, 'McpSyncRule', {
    schedule: Schedule.rate(Duration.minutes(5)),
  })
  mcpSyncRule.addTarget(new EventsLambdaTarget(mcpSyncFn))
}

// ── Step E tables, declared once for the four Lambdas that share them ───────
const shipmentDocumentTable  = stageTables['ShipmentDocument']
const shipmentNoticeTable    = stageTables['ShipmentNotice']
// DriverSubmission / DriverSubmissionDoc are already declared for the driver API
// above; ATTACH_DRIVER_DOC only reads them.

// ── tmsShipmentActions Lambda (Step B) ──────────────────────────────────────
// Shipment/Order/LoadCarrier/LoadFinancials/LoadCharge are written with the raw
// SDK (TransactWriteItems keeps the five tables agreeing); Load goes through the
// generated updateLoad mutation (allow.resource(tmsShipmentActions) on the schema)
// so the calendar's subscriptions still fire. Customer/TmsSettings are read-only
// here — their writes stay with tmsDirectoryActions.
const shipmentActionsFn = backend.tmsShipmentActions.resources.lambda as LambdaFunction
passDataTableSuffix(shipmentActionsFn, SHIPMENT_ACTIONS_TABLES)
;(shipmentActionsFn.node.defaultChild as CfnFunction).timeout = 120
const shipmentTable          = stageTables['Shipment']
const orderTable             = stageTables['Order']
const loadCarrierTable       = stageTables['LoadCarrier']
const loadFinancialsTable    = stageTables['LoadFinancials']
const loadChargeTable        = stageTables['LoadCharge']
const shipmentLoadTable      = stageTables['Load']
const shipmentCustomerTable  = stageTables['Customer']
const shipmentSettingsTable  = stageTables['TmsSettings']
const shipmentAuditLogTable  = stageTables['AuditLog']
// The backfill needs the driver roster to tell an own-asset load from one that only
// ever sat on a "Broker Need to Cover" pseudo-driver.
const shipmentDriverTable    = stageTables['Driver']
// Step C: booking reads the directory carrier and its documents, and the rate
// confirmation is printed on the division's letterhead. All read-only here —
// carrier writes belong to tmsCarrierActions.
const shipmentCarrierTable   = stageTables['Carrier']
const shipmentCarrierDocTable = stageTables['CarrierDocument']
const shipmentDivisionTable  = stageTables['Division']
// Step H: quotes and carrier offers are written here — the same Lambda already
// owns the pricing and the booking a quote turns into. CarrierContact is read
// only, to address an offer request at a carrier's dispatch desk.
const shipmentCarrierContactTable = stageTables['CarrierContact']
const shipmentQuoteTable     = stageTables['Quote']
const shipmentLaneSampleTable = stageTables['LaneRateSample']
// Step R: the ownership taxonomy. Read-only here — the rules resolve a
// shipment's revenue division on every booking, driver change and re-tag;
// tmsDirectoryActions stays their only writer.
const shipmentOwnershipDivisionTable = stageTables['OwnershipDivision']
const shipmentOwnershipRuleTable     = stageTables['OwnershipRule']
const shipmentProClaimTable          = stageTables['ProClaim']
// Step I. ASSIGN_CARRIER_REP validates the rep against a real UserProfile, and
// BATCH_SHIPMENT_TASK reuses the same lookup for SET_SALES_REP.
const shipmentUserProfileTable       = stageTables['UserProfile']

shipmentActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      // ConditionCheckItem: BOOK_CARRIER guards the Load row inside the booking
      // transaction, so a load that moved cancels the write instead of leaving an
      // orphan ACTIVE LoadCarrier behind (same pattern as pod-actions' assign).
      'dynamodb:ConditionCheckItem',
    ],
    resources: [
      shipmentTable.tableArn,
      orderTable.tableArn,
      loadCarrierTable.tableArn,
      loadFinancialsTable.tableArn,
      loadChargeTable.tableArn,
      shipmentLoadTable.tableArn,
      shipmentAuditLogTable.tableArn,
      // Read-only here, but DynamoDB scopes by table, not by action/attribute.
      shipmentCustomerTable.tableArn,
      shipmentSettingsTable.tableArn,
      shipmentDriverTable.tableArn,
      shipmentCarrierTable.tableArn,
      shipmentCarrierDocTable.tableArn,
      shipmentDivisionTable.tableArn,
      // Step D: LOG_CHECK_CALL writes the event log; REMOVE_LOAD_CARRIER revokes
      // the carrier's ACTIVE tracking link when the carrier comes off the load.
      stageTables['LoadCheckCall'].tableArn,
      stageTables['TrackingLink'].tableArn,
      // Step H: the quote and offer rows, and the lane history a delivered load
      // leaves behind. CarrierContact is read-only — the directory owns it.
      // ShipmentNotice carries the CARRIER_OFFER rows an offer request writes,
      // the same claim-then-send pattern the tracking and finance routers use.
      shipmentCarrierContactTable.tableArn,
      shipmentQuoteTable.tableArn,
      shipmentLaneSampleTable.tableArn,
      shipmentNoticeTable.tableArn,
      // Step R: read-only — the division tree and the rules that tag a shipment.
      shipmentOwnershipDivisionTable.tableArn,
      shipmentOwnershipRuleTable.tableArn,
      // Step R cutover: the PRO claim table. Written with a conditional put inside
      // the shipment transaction and never deleted — a PRO, once issued, is taken
      // forever, voided or not.
      shipmentProClaimTable.tableArn,
    ],
  }),
)
// Staff validation never grants this writer authority to change staff records.
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['dynamodb:GetItem'],
  resources: [shipmentUserProfileTable.tableArn],
}))
// Moving a load to billing creates the carrier's AP record (_shared/pendingCarrierBill): the payee
// snapshot reads the carrier's payment methods, read-only here — tmsCarrierActions owns them.
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['dynamodb:GetItem', 'dynamodb:Query'],
  resources: [stageTables['CarrierPaymentMethod'].tableArn, `${stageTables['CarrierPaymentMethod'].tableArn}/index/*`],
}))
// Aljex-exit: the code -> user crosswalk (SET_ALJEX_CODE_MAP, REASSIGN_SHIPMENTS_BY_REP_CODE).
const shipmentAljexCodeMapTable = stageTables['AljexCodeMap']
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'],
  resources: [shipmentAljexCodeMapTable.tableArn],
}))
// Board and bundle reads come off the GSIs declared on these models.
shipmentActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [
      `${shipmentTable.tableArn}/index/*`,
      `${orderTable.tableArn}/index/*`,
      `${loadCarrierTable.tableArn}/index/*`,
      `${loadChargeTable.tableArn}/index/*`,
      `${shipmentLoadTable.tableArn}/index/*`,
      `${shipmentCustomerTable.tableArn}/index/*`,
      `${shipmentCarrierTable.tableArn}/index/*`,
      `${shipmentCarrierDocTable.tableArn}/index/*`,
      `${stageTables['LoadCheckCall'].tableArn}/index/*`,
      `${stageTables['TrackingLink'].tableArn}/index/*`,
      `${shipmentCarrierContactTable.tableArn}/index/*`,
      `${shipmentQuoteTable.tableArn}/index/*`,
      `${shipmentLaneSampleTable.tableArn}/index/*`,
      `${shipmentNoticeTable.tableArn}/index/*`,
      // Delete recovery uses the existing entityType/entityId AuditLog index (no schema change).
      `${shipmentAuditLogTable.tableArn}/index/*`,
    ],
  }),
)
// Step W: ASSIGN_ASSET refuses to move a load that is already on a box-truck
// settlement (a stored BoxTruckTrip row). Read-only: one Scan, table ARN only.
const shipmentBoxTruckTripTable = stageTables['BoxTruckTrip']
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:Scan'],
  resources: [shipmentBoxTruckTripTable.tableArn],
}))

shipmentActionsFn.addEnvironment('USER_POOL_ID',               backend.auth.resources.userPool.userPoolId)
// Step U: the intake review queue. Edit, promote and dismiss are this function's; staging
// (the Put) belongs to workflow-agent. Scan + DeleteItem: the demo seed counts the open
// rows (GET_DEMO_STATE) and a reset removes the one it staged; ConditionCheckItem for the
// promote transaction's guards.
const shipmentIntakeLoadTable = stageTables['IntakeLoad']
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:ConditionCheckItem'],
  resources: [shipmentIntakeLoadTable.tableArn, `${shipmentIntakeLoadTable.tableArn}/index/*`],
}))
shipmentActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  }),
)

// Step C: BOOK_CARRIER reads the carrier and its paperwork, SEND_RATE_CON
// stores the generated PDF and emails it to the carrier with SES.
// Step H: the quote board, the offer thread and the lane history.
shipmentActionsFn.addEnvironment('BUCKET_NAME',                 backend.storage.resources.bucket.bucketName)
// Sent from the verified bcatcorp.com domain (DKIM-aligned), not from a gmail.com address: mail from ai4bcat@gmail.com through SES
// fails alignment and lands in spam or is dropped (the 20002 rate con never showed up in anyone's inbox). Replies still go to the thread mailbox.
shipmentActionsFn.addEnvironment('FROM_ADDRESS',                'notifications@bcatcorp.com')
// The signing link in the email points at the app, not at the Function URL.
shipmentActionsFn.addEnvironment('PORTAL_ORIGIN',               PORTAL_ORIGIN)
// The rate con is sent as raw MIME with the PDF attached (SESv2 Content.Raw
// maps to ses:SendRawEmail), the same way the driver-pay statement goes out.
shipmentActionsFn.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] })
)
backend.storage.resources.bucket.grantReadWrite(shipmentActionsFn, 'rate-confirms/*')
backend.storage.resources.bucket.grantReadWrite(shipmentActionsFn, 'carrier-docs/*')

// ── Step E: the shipment document index ─────────────────────────────────────
// tmsShipmentActions is the single writer of ShipmentDocument, and the only thing
// that puts bytes under shipment-docs/*: staff uploads arrive through a presigned
// PUT it signed, generated PDFs it writes itself. DriverSubmission and its docs
// are read-only here — ATTACH_DRIVER_DOC points a row at the key the driver app
// already wrote and never copies the file, so the own-fleet POD flow is untouched.
shipmentActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:ConditionCheckItem',
    ],
    resources: [
      shipmentDocumentTable.tableArn,
      `${shipmentDocumentTable.tableArn}/index/*`,
      driverSubmissionTable.tableArn,
      `${driverSubmissionTable.tableArn}/index/*`,
      driverSubmissionDocTable.tableArn,
      `${driverSubmissionDocTable.tableArn}/index/*`,
    ],
  }),
)
backend.storage.resources.bucket.grantReadWrite(shipmentActionsFn, 'shipment-docs/*')
// Intake e-mail files are copied onto the shipment when the load is linked.
backend.storage.resources.bucket.grantRead(shipmentActionsFn, 'intake-attachments/*')

// ── Step P: postings, carrier offers and the demo seed ──────────────────────
// POST_LOAD / UNPOST_LOAD own ShipmentPosting outright. The demo seed owns
// DemoRecord — its own index of what it made, which is the only thing a reset is
// ever allowed to touch — and reads ShipmentMessage to count the thread for the
// Demo page's checklist. The seed writes Customer and Carrier directly (their
// routers are a different Lambda) and mints every piece of freight through this
// file's own CREATE_SHIPMENT / BOOK_CARRIER, so it cannot reach a state the app
// could not; both tables are already on the big grant above.
const shipmentPostingTable = stageTables['ShipmentPosting']
const shipmentDemoTable    = stageTables['DemoRecord']
const shipmentMessageTable = stageTables['ShipmentMessage']
shipmentActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:ConditionCheckItem',
    ],
    resources: [
      shipmentPostingTable.tableArn,
      `${shipmentPostingTable.tableArn}/index/*`,
      shipmentDemoTable.tableArn,
      `${shipmentDemoTable.tableArn}/index/*`,
      // Written by the seed only; read by the Demo page's checklist.
      shipmentMessageTable.tableArn,
      `${shipmentMessageTable.tableArn}/index/*`,
    ],
  }),
)
// Step J: the market rate behind a quote and the board adapters read the
// Integration row to decide stub vs live, and the credential pointer it carries.
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
  resources: [stageTables['Integration'].tableArn],
}))
// The credentials themselves stay in SSM. Read-only, and scoped to the same
// per-pool integration path tmsDirectoryActions writes — a board posting and a
// RateView lookup need DAT's key, and nothing on this role may write one.
shipmentActionsFn.addEnvironment('INTEGRATION_PARAM_PATH', integrationParamPath)
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['ssm:GetParameter'],
  resources: [integrationParamArn],
}))

// ── tmsCarrierActions Lambda (Step C) ───────────────────────────────────────
// The carrier directory's single writer: Carrier, CarrierContact,
// CarrierPaymentMethod and CarrierDocument are written with the raw SDK, the
// way tmsDirectoryActions owns Customer and Location. LoadCarrier and Load are
// read-only here — a status change annotates covered loads, it never bounces
// them, and booking itself stays with tmsShipmentActions.
const carrierActionsFn        = backend.tmsCarrierActions.resources.lambda as LambdaFunction
const carrierTable            = stageTables['Carrier']
const carrierContactTable     = stageTables['CarrierContact']
const carrierPaymentTable     = stageTables['CarrierPaymentMethod']
const carrierDocumentTable    = stageTables['CarrierDocument']
const carrierLoadCarrierTable = stageTables['LoadCarrier']
const carrierLoadTable        = stageTables['Load']
const carrierSettingsTable    = stageTables['TmsSettings']
const carrierAuditLogTable    = stageTables['AuditLog']

carrierActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'dynamodb:Scan',
    ],
    resources: [
      carrierTable.tableArn,
      carrierContactTable.tableArn,
      carrierPaymentTable.tableArn,
      carrierDocumentTable.tableArn,
      carrierLoadCarrierTable.tableArn,
      carrierAuditLogTable.tableArn,
      // Read-only here, but DynamoDB scopes by table, not by action/attribute.
      carrierLoadTable.tableArn,
      carrierSettingsTable.tableArn,
    ],
  })
)
// Dedupe by normalizedName/MC/DOT, the per-carrier child lists, and the covered
// loads a status change has to annotate all come off GSIs.
carrierActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${carrierTable.tableArn}/index/*`,
      `${carrierContactTable.tableArn}/index/*`,
      `${carrierPaymentTable.tableArn}/index/*`,
      `${carrierDocumentTable.tableArn}/index/*`,
      `${carrierLoadCarrierTable.tableArn}/index/*`,
    ],
  })
)

carrierActionsFn.addEnvironment('CARRIER_TABLE_NAME',                carrierTable.tableName)
carrierActionsFn.addEnvironment('CARRIER_CONTACT_TABLE_NAME',        carrierContactTable.tableName)
carrierActionsFn.addEnvironment('CARRIER_PAYMENT_METHOD_TABLE_NAME', carrierPaymentTable.tableName)
carrierActionsFn.addEnvironment('CARRIER_DOCUMENT_TABLE_NAME',       carrierDocumentTable.tableName)
carrierActionsFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',           carrierLoadCarrierTable.tableName)
carrierActionsFn.addEnvironment('LOAD_TABLE_NAME',                   carrierLoadTable.tableName)
carrierActionsFn.addEnvironment('SETTINGS_TABLE_NAME',               carrierSettingsTable.tableName)
carrierActionsFn.addEnvironment('AUDIT_LOG_TABLE_NAME',              carrierAuditLogTable.tableName)
carrierActionsFn.addEnvironment('BUCKET_NAME',                       backend.storage.resources.bucket.bucketName)
carrierActionsFn.addEnvironment('USER_POOL_ID',                      backend.auth.resources.userPool.userPoolId)
carrierActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)
// PREPARE_DOCUMENT presigns the PUT and COMMIT_DOCUMENT HEADs the object back.
// No delete: DELETE_DOCUMENT removes the row and leaves the file.
backend.storage.resources.bucket.grantReadWrite(carrierActionsFn, 'carrier-docs/*')

// ── TaxVault (Docs/tms-build/AW_TAXID_DESIGN.md): encrypted carrier tax IDs ─────────────────────────
// A plain CDK table + two KMS keys in a nested stack of their own: NOT an Amplify model, so no AppSync type can
// ever carry the ciphertext, and the data stack gains no resource. The data stack gains no env var either: the
// Lambdas derive `CarrierTaxVault-<apiId>` and `alias/bcat-tax-vault[-mac]-<apiId>` from CARRIER_TABLE_NAME
// (_shared/taxVault.ts vaultNamesFor), and every grant lives HERE, in the vault stack: the key policy names the
// two function roles, and the table grants attach to those roles from this stack. Nothing in the data stack
// references this stack, so the dependency runs one way (TaxVault -> data) and there is no cycle.
// Keys and table are RETAIN: deleting this stack never loses ciphertext, and a key is never deleted quietly.
// Stage 0 (the production shape) must create no table: the vault is created at stage 1, with the Carrier model it serves,
// and never changes afterwards. Below stage 1 the tax actions answer with a clear 'not available yet' error.
const TAX_VAULT_STAGE = 1
if (SCHEMA_STAGE >= TAX_VAULT_STAGE) {
  const vaultStack = backend.createStack('TaxVault')
  // The API id the data stack already exports (no new output, no stage dependence). Nothing in the data stack
  // references this stack, so unlike the Lambdas' own policies this reference cannot close a cycle.
  const vaultApiId = backend.data.apiId
  const vaultCarrierRole = carrierActionsFn.role!.roleArn
  const vaultMcpRole = (backend.mcpSync.resources.lambda as LambdaFunction).role!.roleArn
  const vaultRoles = [vaultCarrierRole, vaultMcpRole].map((arn) => new ArnPrincipal(arn))

  // The encryption context binds a ciphertext to its carrier and its stack: moved to another carrier or another
  // API, Decrypt fails. Every usage statement requires it (field + api pinned, carrierId present, nothing else).
  const contextRequired = {
    StringEquals: { 'kms:EncryptionContext:field': 'taxId', 'kms:EncryptionContext:api': vaultApiId },
    'ForAllValues:StringEquals': { 'kms:EncryptionContextKeys': ['carrierId', 'field', 'api'] },
    Null: { 'kms:EncryptionContext:carrierId': 'false' },
  }
  // Account root keeps ADMINISTRATION only (unavoidable in AWS: whoever is IAM admin can re-grant themselves; that is
  // the trust boundary). It has no usage action on either key.
  const adminStatement = () => new PolicyStatement({
    sid: 'KeyAdministrationOnly',
    principals: [new AccountRootPrincipal()],
    actions: [
      'kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*', 'kms:Disable*',
      'kms:Get*', 'kms:Delete*', 'kms:TagResource', 'kms:UntagResource', 'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion',
    ],
    resources: ['*'],
  })

  const encryptKey = new Key(vaultStack, 'TaxVaultKey', {
    description: 'BCAT carrier tax-ID encryption key (direct Encrypt/Decrypt, encryption context enforced)',
    enableKeyRotation: true,
    pendingWindow: Duration.days(30),
    removalPolicy: RemovalPolicy.RETAIN,
    policy: new PolicyDocument({
      statements: [
        adminStatement(),
        new PolicyStatement({ sid: 'EncryptCarrierActionsAndMcpSync', principals: vaultRoles, actions: ['kms:Encrypt'], resources: ['*'], conditions: contextRequired }),
        new PolicyStatement({ sid: 'DecryptCarrierActionsOnly', principals: [vaultRoles[0]], actions: ['kms:Decrypt'], resources: ['*'], conditions: contextRequired }),
        // An IAM policy elsewhere in the account cannot grant Decrypt: nobody but the one role gets it.
        new PolicyStatement({
          sid: 'DenyDecryptExceptCarrierActions', effect: Effect.DENY, principals: [new AnyPrincipal()], actions: ['kms:Decrypt'], resources: ['*'],
          conditions: { ArnNotEquals: { 'aws:PrincipalArn': vaultCarrierRole } },
        }),
      ],
    }),
  })
  new Alias(vaultStack, 'TaxVaultKeyAlias', { aliasName: Fn.join('', ['alias/bcat-tax-vault-', vaultApiId]), targetKey: encryptKey })

  // HMAC_256 (GenerateMac) for the duplicate fingerprint: useless without KMS. HMAC keys do not auto-rotate.
  // GenerateMac takes no encryption context, so these statements carry no context condition.
  const macKey = new Key(vaultStack, 'TaxVaultMacKey', {
    description: 'BCAT carrier tax-ID duplicate-fingerprint HMAC key',
    keySpec: KeySpec.HMAC_256,
    keyUsage: KeyUsage.GENERATE_VERIFY_MAC,
    pendingWindow: Duration.days(30),
    removalPolicy: RemovalPolicy.RETAIN,
    policy: new PolicyDocument({
      statements: [
        adminStatement(),
        new PolicyStatement({ sid: 'MacCarrierActionsAndMcpSync', principals: vaultRoles, actions: ['kms:GenerateMac'], resources: ['*'] }),
      ],
    }),
  })
  new Alias(vaultStack, 'TaxVaultMacKeyAlias', { aliasName: Fn.join('', ['alias/bcat-tax-vault-mac-', vaultApiId]), targetKey: macKey })

  // Item: carrierId, ciphertext (B), keyArn, type, last4, fingerprint, setAt, setBy, source, version. Rate-limit rows
  // `rl#<email>#<hour>` share the table and expire through ttlEpoch. Table SSE stays AWS-managed: the field cipher is
  // what protects the value (a restored backup is ciphertext only).
  const vaultTable = new Table(vaultStack, 'CarrierTaxVault', {
    tableName: Fn.join('', ['CarrierTaxVault-', vaultApiId]),
    partitionKey: { name: 'carrierId', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    encryption: TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    timeToLiveAttribute: 'ttlEpoch',
    removalPolicy: RemovalPolicy.RETAIN,
  })
  vaultTable.addGlobalSecondaryIndex({
    indexName: 'byFingerprint',
    partitionKey: { name: 'fingerprint', type: AttributeType.STRING },
    projectionType: ProjectionType.KEYS_ONLY,
  })
  // carrierActions: set / status / reveal (rate-limit counter) / clear. mcpSync: set only (never reads a value).
  const carrierRole = Role.fromRoleArn(vaultStack, 'TaxVaultCarrierActionsRole', vaultCarrierRole, { mutable: true })
  carrierRole.addToPrincipalPolicy(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
    resources: [vaultTable.tableArn, `${vaultTable.tableArn}/index/byFingerprint`],
  }))
  const mcpRole = Role.fromRoleArn(vaultStack, 'TaxVaultMcpSyncRole', vaultMcpRole, { mutable: true })
  mcpRole.addToPrincipalPolicy(new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
    resources: [vaultTable.tableArn, `${vaultTable.tableArn}/index/byFingerprint`],
  }))
}

// ── tmsTrackingActions Lambda (Step D) ──────────────────────────────────────
// Owns TrackingLink and everything that carries a link outside the office: the
// carrier-driver ping link (texted from the dispatch number, wired in the dispatch
// loop above) and the per-shipment Customer Link (SES). Check calls themselves
// stay on tmsShipmentActions, which is where Load status and money already live.
// Note SETTINGS_TABLE_NAME was set to DispatchSettings by the dispatch loop, so
// TmsSettings arrives as TMS_SETTINGS_TABLE_NAME here.
const trackingLinkTbl       = stageTables['TrackingLink']
const trackingCheckCallTbl  = stageTables['LoadCheckCall']
const trackingShipmentTbl   = stageTables['Shipment']
const trackingOrderTbl      = stageTables['Order']
const trackingLoadCarrTbl   = stageTables['LoadCarrier']
const trackingLoadTbl       = stageTables['Load']
const trackingCustomerTbl   = stageTables['Customer']
const trackingSettingsTbl   = stageTables['TmsSettings']
const trackingAuditLogTbl   = stageTables['AuditLog']
const trackingDivisionTbl   = stageTables['Division']

trackingActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:Query',
    ],
    resources: [
      trackingLinkTbl.tableArn,
      trackingCheckCallTbl.tableArn,
      trackingLoadCarrTbl.tableArn,
      trackingShipmentTbl.tableArn,
      trackingSettingsTbl.tableArn,
      trackingAuditLogTbl.tableArn,
      // Read-only here, but DynamoDB scopes by table, not by action.
      trackingOrderTbl.tableArn,
      trackingLoadTbl.tableArn,
      trackingCustomerTbl.tableArn,
      trackingDivisionTbl.tableArn,
    ],
  })
)
trackingActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${trackingLinkTbl.tableArn}/index/*`,
      `${trackingCheckCallTbl.tableArn}/index/*`,
      `${trackingLoadCarrTbl.tableArn}/index/*`,
      `${trackingOrderTbl.tableArn}/index/*`,
      `${trackingLoadTbl.tableArn}/index/*`,
    ],
  })
)
trackingActionsFn.addEnvironment('USER_POOL_ID',                backend.auth.resources.userPool.userPoolId)
trackingActionsFn.addEnvironment('PORTAL_ORIGIN',               PORTAL_ORIGIN)
trackingActionsFn.addEnvironment('FROM_ADDRESS',                'ai4bcat@gmail.com')
// ── Step AO (append-only block): load-keyed breadcrumbs and the cached route ──
// tmsTrackingActions files shared-pin / geocoded-reply fixes and the route cache row in
// TruckLocationHistory, and reads TruckLocation to decide whether an own-asset leg still has
// an ELD fix (a tracking link is only allowed when it has none for two hours).
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
  resources: [truckLocationHistoryTable.tableArn, `${truckLocationHistoryTable.tableArn}/index/*`, truckLocationTable.tableArn],
}))
trackingActionsFn.addToRolePolicy(
  new PolicyStatement({
    // The Customer Link's contact card is the order's rep, read from the pool.
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)
trackingActionsFn.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] })
)
// Step V. The automation engine (a) reads the shipment's tracker (UserProfile) for the
// {trackerName}/{trackerPhone} template placeholders and (b) queries the Shipment
// status+pickupAppt index for the POD pass (DELIVERED, last 21 days).
const trackingUserProfileTbl = stageTables['UserProfile']
trackingActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem'],
    resources: [trackingUserProfileTbl.tableArn],
  })
)
trackingActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [`${trackingShipmentTbl.tableArn}/index/*`],
  })
)
// ── Step E: the notice log, the document index and the files they carry ─────
// tmsTrackingActions owns ShipmentNotice because it owns everything that leaves
// the building. It only reads ShipmentDocument — document rows belong to
// tmsShipmentActions — but EMAIL_DOCUMENTS has to fetch the bytes, which live
// under three different prefixes depending on where the file came from.
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
  resources: [shipmentNoticeTable.tableArn, `${shipmentNoticeTable.tableArn}/index/*`],
}))
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Query'],
  resources: [shipmentDocumentTable.tableArn, `${shipmentDocumentTable.tableArn}/index/*`],
}))
backend.storage.resources.bucket.grantRead(trackingActionsFn, 'shipment-docs/*')
backend.storage.resources.bucket.grantRead(trackingActionsFn, 'driver-docs/*')
backend.storage.resources.bucket.grantRead(trackingActionsFn, 'rate-confirms/*')

// ── Step P8/P9: the shipment thread, the tracking agent and the POD review ───
// tmsTrackingActions is the only Lambda wired to both Twilio and SES for a
// shipment, so the per-shipment e-mail/SMS thread and the check-call agent live
// here rather than beside the shipment writer. It owns ShipmentMessage outright;
// ShipmentDocument stays read-mostly (above) plus the one review stamp a POD
// verdict writes, which is why the document grant gains UpdateItem.
const trackingMessageTbl = stageTables['ShipmentMessage']
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
  resources: [trackingMessageTbl.tableArn, `${trackingMessageTbl.tableArn}/index/*`],
}))
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:UpdateItem'],
  resources: [shipmentDocumentTable.tableArn],
}))
// A POD verdict is a transaction across the document, the shipment and the order,
// so the tracking router needs the same transactional guards the shipment one has.
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:ConditionCheckItem'],
  resources: [
    trackingShipmentTbl.tableArn,
    trackingOrderTbl.tableArn,
    trackingLoadTbl.tableArn,
    shipmentDocumentTable.tableArn,
  ],
}))
// The order's AR status is what "ready for billing" means, and the release goes
// through the Step F gate inside this Lambda rather than around it.
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:UpdateItem'],
  resources: [trackingOrderTbl.tableArn, trackingLoadTbl.tableArn],
}))
// The release gate reads the order's documents and charges before it answers.
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Query'],
  resources: [loadChargeTable.tableArn, `${loadChargeTable.tableArn}/index/*`],
}))
// The release gate and the thread read the whole shipment through the shared readBundle,
// which collects the Loads by their ids and each load's LoadFinancials in one BatchGet each.
// Without these two grants (and the table name) REVIEW_SHIPMENT_POD fails on a real shipment
// with "not authorized to perform: dynamodb:BatchGetItem".
const trackingLoadFinancialsTbl = stageTables['LoadFinancials']
trackingActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:BatchGetItem'],
  resources: [trackingLoadTbl.tableArn, trackingLoadFinancialsTbl.tableArn],
}))
// `GOOGLE_MAPS_API_KEY` and `ANTHROPIC_API_KEY` reach this function as Amplify
// secrets declared on its own resource, the way tms-geocode and pod-actions hold
// theirs: a key is never an environment variable this file can print.

// ── tmsFinanceActions Lambda (Step F) ───────────────────────────────────────
// Owns Invoice and ArPayment: the only writer of UNPAID, PAID and every cash row.
// It reads the shipment cluster to take the invoice snapshot, freezes the load's
// financials in the same transaction that issues the bill, renders the PDF itself
// (pdf-lib, in memory) and writes it under invoices/*, e-mails it through the same
// ShipmentNotice log every other outbound document uses, and writes the factoring
// queue row that Send to Factor hands to the existing OTR submit.
const financeActionsFn      = backend.tmsFinanceActions.resources.lambda as LambdaFunction
passDataTableSuffix(financeActionsFn, FINANCE_ACTIONS_TABLES)
const invoiceTable          = stageTables['Invoice']
const arPaymentTable        = stageTables['ArPayment']
const financeOrderTable     = stageTables['Order']
const financeShipmentTable  = stageTables['Shipment']
const financeLoadTable      = stageTables['Load']
const financeLoadCarrierTbl = stageTables['LoadCarrier']
const financeFinancialsTbl  = stageTables['LoadFinancials']
const financeChargeTable    = stageTables['LoadCharge']
const financeCustomerTable  = stageTables['Customer']
const financeLocationTable  = stageTables['Location']
const financeDivisionTable  = stageTables['Division']
const financeSettingsTable  = stageTables['TmsSettings']
const financeAuditLogTable  = stageTables['AuditLog']
const financeFactoringTable = stageTables['FactoringItem']
// Step G (AP): the bill ledger, the payment ledger and the carrier directory rows a
// bill's payee snapshot is taken from.
const carrierBillTable      = stageTables['CarrierBill']
const apPaymentTable        = stageTables['ApPayment']
const financeCarrierTable   = stageTables['Carrier']
const financeCarrierPayTbl  = stageTables['CarrierPaymentMethod']
const financeCarrierCntTbl  = stageTables['CarrierContact']
// Step I: the commission ledger, its pay periods and the staff directory the
// commission roles resolve people from.
const commissionTable       = stageTables['Commission']
const commissionPeriodTable = stageTables['CommissionPayPeriod']
const financeUserProfileTbl = stageTables['UserProfile']

financeActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:Query',
      'dynamodb:ConditionCheckItem',
    ],
    resources: [
      invoiceTable.tableArn,
      arPaymentTable.tableArn,
      financeOrderTable.tableArn,
      financeFinancialsTbl.tableArn,
      financeSettingsTable.tableArn,
      financeAuditLogTable.tableArn,
      financeFactoringTable.tableArn,
      shipmentNoticeTable.tableArn,
      // Read-only here, but DynamoDB scopes by table, not by action.
      financeShipmentTable.tableArn,
      financeLoadTable.tableArn,
      financeLoadCarrierTbl.tableArn,
      financeChargeTable.tableArn,
      carrierBillTable.tableArn,
      apPaymentTable.tableArn,
      financeCarrierTable.tableArn,
      financeCarrierPayTbl.tableArn,
      financeCarrierCntTbl.tableArn,
      financeCustomerTable.tableArn,
      // Read-only: the street and zip a directory-booked stop prints on the invoice.
      financeLocationTable.tableArn,
      financeDivisionTable.tableArn,
      shipmentDocumentTable.tableArn,
      commissionTable.tableArn,
      commissionPeriodTable.tableArn,
      financeUserProfileTbl.tableArn,
    ],
  })
)
// The open book, the Paid tab, a customer's ledger, the AR worklists, one shipment's
// orders/loads/charges/documents and the factoring row for an invoice all come off GSIs.
financeActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${invoiceTable.tableArn}/index/*`,
      `${arPaymentTable.tableArn}/index/*`,
      `${financeOrderTable.tableArn}/index/*`,
      `${financeLoadTable.tableArn}/index/*`,
      `${financeLoadCarrierTbl.tableArn}/index/*`,
      `${financeChargeTable.tableArn}/index/*`,
      `${shipmentDocumentTable.tableArn}/index/*`,
      `${shipmentNoticeTable.tableArn}/index/*`,
      `${carrierBillTable.tableArn}/index/*`,
      `${apPaymentTable.tableArn}/index/*`,
      `${financeCarrierPayTbl.tableArn}/index/*`,
      `${financeCarrierCntTbl.tableArn}/index/*`,
      `${commissionTable.tableArn}/index/*`,
    ],
  })
)
// OTR funded it, so the invoice is paid: every 30 minutes, post one FACTOR payment for each open
// invoice whose factoring row OTR has approved (idempotent per invoice).
new Rule(financeActionsFn.stack, 'SettleFactoredInvoicesRule', {
  schedule: Schedule.rate(Duration.minutes(30)),
  targets: [new EventsLambdaTarget(financeActionsFn)],
})
financeActionsFn.addEnvironment('BUCKET_NAME',                   backend.storage.resources.bucket.bucketName)
// A generated invoice is filed on its shipment as a document by tms-shipment-actions (the single writer of ShipmentDocument).
financeActionsFn.addEnvironment('SHIPMENT_ACTIONS_FUNCTION_NAME', backend.tmsShipmentActions.resources.lambda.functionName)
financeActionsFn.addToRolePolicy(new PolicyStatement({
  actions:   ['lambda:InvokeFunction'],
  resources: [backend.tmsShipmentActions.resources.lambda.functionArn],
}))
financeActionsFn.addEnvironment('USER_POOL_ID',                  backend.auth.resources.userPool.userPoolId)
financeActionsFn.addEnvironment('PORTAL_ORIGIN',                 PORTAL_ORIGIN)
financeActionsFn.addEnvironment('FROM_ADDRESS',                  'ai4bcat@gmail.com')
financeActionsFn.addToRolePolicy(
  new PolicyStatement({
    // The caller's e-mail is the signature on every posted row.
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)
financeActionsFn.addToRolePolicy(
  new PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] })
)
// It writes the invoice PDFs it renders, and reads the paperwork it attaches to them.
backend.storage.resources.bucket.grantReadWrite(financeActionsFn, 'invoices/*')
// …and the remittance advices it renders for the carriers it pays.
backend.storage.resources.bucket.grantReadWrite(financeActionsFn, 'remittances/*')
backend.storage.resources.bucket.grantRead(financeActionsFn, 'shipment-docs/*')
backend.storage.resources.bucket.grantRead(financeActionsFn, 'driver-docs/*')
backend.storage.resources.bucket.grantRead(financeActionsFn, 'rate-confirms/*')
// …and the commission statements a pay period renders per rep.
backend.storage.resources.bucket.grantReadWrite(financeActionsFn, 'commissions/*')

// ── DataSafety bucket (Aljex-exit Phase 0) ──────────────────────────────────
// A private, versioned bucket of its own — NOT the Amplify storage bucket, whose
// `imports/*` prefix is readable by every signed-in user and carries browser CORS. It holds
// the raw Aljex files (no expiry: the lossless archive of every column the model does not
// map), staged chunks, reconciliation reports, nightly DynamoDB exports and the
// export-everything CSV jobs. Reachable only through presigned links the two Lambdas hand
// to an owner/ADMIN, and retained if the stack is ever deleted.
const dataSafetyStack = backend.createStack('DataSafety')
const dataSafetyBucket = new Bucket(dataSafetyStack, 'DataSafetyBucket', {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  encryption: BucketEncryption.S3_MANAGED,
  versioned: true,
  removalPolicy: RemovalPolicy.RETAIN,
  objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
  lifecycleRules: [
    { id: 'nightly-exports', prefix: 'exports/nightly/', expiration: Duration.days(35) },
    { id: 'manual-exports', prefix: 'exports/manual/', expiration: Duration.days(35) },
    { id: 'csv-exports', prefix: 'exports/csv/', expiration: Duration.days(7) },
    { id: 'import-stage-chunks', prefix: 'imports/jobs/', expiration: Duration.days(30) },
    { id: 'import-reports', prefix: 'imports/runs/', expiration: Duration.days(365) },
    // `imports/source/` deliberately has no expiry rule.
    { id: 'noncurrent-versions', noncurrentVersionExpiration: Duration.days(90), abortIncompleteMultipartUploadAfter: Duration.days(7) },
  ],
  cors: [{
    allowedMethods: [HttpMethods.PUT, HttpMethods.GET, HttpMethods.HEAD],
    allowedOrigins: PORTAL_ORIGINS,
    allowedHeaders: ['*'],
    exposedHeaders: ['ETag'],
    maxAge: 3000,
  }],
})
// Owner-only shipment delete/restore: private export bytes, never permission to delete S3 objects.
shipmentActionsFn.addEnvironment('DATA_SAFETY_BUCKET_NAME', dataSafetyBucket.bucketName)
// Brokerage per-rep rollup objects (rollups/brokerage/<YYYY-MM>.json): written by tms-dashboard-rollup, read only
// through the caller-filtered BROKERAGE_REP_ROLLUP action. Without these the Brokerage cards said "could not be loaded".
financeActionsFn.addEnvironment('DATA_SAFETY_BUCKET_NAME', dataSafetyBucket.bucketName)
financeActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [`${dataSafetyBucket.bucketArn}/rollups/brokerage/*`],
}))
// A month with no rollup object yet must read as "missing" (NoSuchKey), not AccessDenied: S3 only says NoSuchKey to a caller that may list.
financeActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['s3:ListBucket'],
  resources: [dataSafetyBucket.bucketArn],
  conditions: { StringLike: { 's3:prefix': ['rollups/brokerage/*'] } },
}))
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['s3:PutObject', 's3:GetObject'],
  resources: [`${dataSafetyBucket.bucketArn}/deletes/*`],
}))
shipmentActionsFn.addToRolePolicy(new PolicyStatement({
  actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
  resources: ['Invoice', 'CarrierBill', 'ArPayment', 'ApPayment', 'Commission', 'FactoringItem', 'LegacyAljexRow'].map((model) => stageTables[model].tableArn),
}))

// The Phase 0 Lambdas may touch only this stack's tables: `<Model>-<apiId>-NONE`. The API id
// is cut out of a table name rather than read off the API construct, because a policy that
// referenced the API would close a CloudFormation cycle (API -> resolver -> Lambda -> policy).
const stackApiId = (tableName: string) => Fn.select(1, Fn.split('-', tableName))
const tableArnPattern = (fn: LambdaFunction, apiId: string, suffix = '') =>
  Stack.of(fn).formatArn({ service: 'dynamodb', resource: 'table', resourceName: `*-${apiId}-NONE${suffix}`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })

// ── tmsAljexImport Lambda (Aljex-exit Phase 0) ──────────────────────────────
// Owner/ADMIN router + async worker for the Aljex import. AppSync caps a call at 30 s, so
// STAGE / PLAN / APPLY run in an `Event` self-invoke that drives the engine's runSlice for up
// to 900 s and re-invokes itself while work remains. It writes the ~20 touched tables, reads
// the reference tables, and may also write rehearsal copies (`...-rh<tag>` siblings of the
// same API id) — never another API's (production's) tables, by IAM and by code.
const aljexImportFn = backend.tmsAljexImport.resources.lambda as LambdaFunction
const aljexTables = stageTables
const ALJEX_WRITE_TABLES: string[] = [
  'AljexImportJob', 'AljexMappingProfile',
  'LegacyAljexRow', 'Shipment', 'Order',
  'Load', 'LoadCarrier', 'LoadFinancials',
  'LoadCharge', 'Customer', 'Location',
  'Carrier', 'Invoice', 'ArPayment',
  'CarrierBill', 'ApPayment', 'ProClaim',
  'TmsSettings', 'AuditLog',
]
const ALJEX_READ_TABLES: string[] = [
  'FactoringItem', 'Driver', 'UserProfile',
  'OwnershipDivision', 'OwnershipRule',
  'Division', 'Integration',
]
const aljexApiId = stackApiId(aljexTables['Shipment'].tableName)
aljexImportFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem',
      'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:ConditionCheckItem', 'dynamodb:TransactWriteItems',
    ],
    resources: [
      ...ALJEX_WRITE_TABLES.flatMap((model) => [aljexTables[model].tableArn, `${aljexTables[model].tableArn}/index/*`]),
      // Rehearsal copies: unmanaged siblings of the live tables carrying the same API id.
      tableArnPattern(aljexImportFn, aljexApiId, '-rh*'),
      `${tableArnPattern(aljexImportFn, aljexApiId, '-rh*')}/index/*`,
    ],
  })
)
aljexImportFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Scan', 'dynamodb:Query'],
    resources: ALJEX_READ_TABLES.flatMap((model) => [aljexTables[model].tableArn, `${aljexTables[model].tableArn}/index/*`]),
  })
)
passDataTableSuffix(aljexImportFn, ALJEX_IMPORT_TABLES)
aljexImportFn.addEnvironment('DATA_SAFETY_BUCKET', dataSafetyBucket.bucketName)
aljexImportFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
aljexImportFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)
// Source files, staged chunks, reports. The Amplify storage bucket is no longer touched.
dataSafetyBucket.grantReadWrite(aljexImportFn, 'imports/*')
// Async self-invoke (the worker continues itself). The name is derived from the root stack
// (a plain string at synth time) and the invoke is granted by ARN string: granting through
// the construct is the CloudFormation cycle pod-actions hit.
let aljexRootStack: Stack = Stack.of(aljexImportFn)
while (aljexRootStack.nestedStackParent) aljexRootStack = aljexRootStack.nestedStackParent
const aljexFunctionName = `tms-aljex-import-${createHash('sha256').update(aljexRootStack.stackName).digest('hex').slice(0, 16)}`
;(aljexImportFn.node.defaultChild as CfnFunction).functionName = aljexFunctionName
aljexImportFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['lambda:InvokeFunction'],
    resources: [Stack.of(aljexImportFn).formatArn({ service: 'lambda', resource: 'function', resourceName: aljexFunctionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
  })
)
// IMPORT_SYNC_CARRIERS: the MyCarrierPackets sync Lambda does the MCP calls and writes the
// `mcp*` fields itself; the import only invokes it (it never reads credentials).
const aljexMcpSyncFn = backend.mcpSync.resources.lambda as LambdaFunction
aljexImportFn.addEnvironment('MCP_SYNC_FUNCTION_NAME', aljexMcpSyncFn.functionName)
aljexMcpSyncFn.grantInvoke(aljexImportFn)

// ── tmsDataSafety Lambda (Aljex-exit Phase 0) ───────────────────────────────
// Nightly + manual `ExportTableToPointInTime`, the export-everything CSV and the four
// accountant CSVs. Reads DynamoDB directly; every table it can name is `<Model>-<apiId>-NONE`
// of THIS stack, so it physically cannot reach a production table (different API id).
const dataSafetyFn = backend.tmsDataSafety.resources.lambda as LambdaFunction
const dataExportJobTable = aljexTables['DataExportJob']
const dsApiId = aljexApiId
dataSafetyFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:ListTables'], resources: ['*'] }),
)
dataSafetyFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:DescribeTable', 'dynamodb:DescribeContinuousBackups', 'dynamodb:ExportTableToPointInTime',
      'dynamodb:Scan', 'dynamodb:Query',
    ],
    resources: [tableArnPattern(dataSafetyFn, dsApiId), `${tableArnPattern(dataSafetyFn, dsApiId)}/index/*`],
  })
)
dataSafetyFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:DescribeExport'],
    resources: [`${tableArnPattern(dataSafetyFn, dsApiId)}/export/*`],
  })
)
// Its own bookkeeping: job rows (read/write) and one AuditLog row per start/link action.
dataSafetyFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [dataExportJobTable.tableArn],
  })
)
dataSafetyFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [aljexTables['AuditLog'].tableArn] }),
)
dataSafetyFn.addEnvironment('DATA_SAFETY_BUCKET_NAME', dataSafetyBucket.bucketName)
dataSafetyFn.addEnvironment('DATA_EXPORT_JOB_TABLE_NAME', dataExportJobTable.tableName)
dataSafetyFn.addEnvironment('AUDIT_LOG_TABLE_NAME', aljexTables['AuditLog'].tableName)
dataSafetyFn.addEnvironment('SHIPMENT_TABLE_NAME', aljexTables['Shipment'].tableName)
dataSafetyFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
dataSafetyFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)
// S3 export writes into `exports/nightly/…` (service-side, under this role's permissions);
// the CSV job writes `exports/csv/…`; the Lambda also reads them back for presigned links.
dataSafetyBucket.grantReadWrite(dataSafetyFn)
// Self-invoke (`Event`) to continue a long CSV / export-check job; same by-name pattern.
const dataSafetyFunctionName = `tms-data-safety-${createHash('sha256').update(aljexRootStack.stackName).digest('hex').slice(0, 16)}`
;(dataSafetyFn.node.defaultChild as CfnFunction).functionName = dataSafetyFunctionName
dataSafetyFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['lambda:InvokeFunction'],
    resources: [Stack.of(dataSafetyFn).formatArn({ service: 'lambda', resource: 'function', resourceName: dataSafetyFunctionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
  })
)
// Two rules, in the Lambda's own stack (the other schedules' precedent). They are the ONLY
// rules the dev guard leaves enabled — see devRuleGuard.ts.
const dataSafetyRules: Rule[] = []
if (triggerEnabled('dataSafetyNightly', SCHEMA_STAGE)) {
  const dataSafetyNightlyRule = new Rule(dataSafetyFn.stack, 'DataSafetyNightlyExportRule', {
    schedule: Schedule.cron({ minute: '15', hour: '7', month: '*', weekDay: '*', year: '*' }),
    description: 'Nightly DynamoDB point-in-time export to the DataSafety bucket (01:15 Central standard)',
  })
  dataSafetyNightlyRule.addTarget(new EventsLambdaTarget(dataSafetyFn, { event: RuleTargetInput.fromObject({ kind: 'NIGHTLY' }) }))
  const dataSafetyCheckRule = new Rule(dataSafetyFn.stack, 'DataSafetyNightlyCheckRule', {
    schedule: Schedule.cron({ minute: '15', hour: '10', month: '*', weekDay: '*', year: '*' }),
    description: 'Checks the nightly exports finished and records the result',
  })
  dataSafetyCheckRule.addTarget(new EventsLambdaTarget(dataSafetyFn, { event: RuleTargetInput.fromObject({ kind: 'NIGHTLY_CHECK' }) }))
  dataSafetyRules.push(dataSafetyNightlyRule, dataSafetyCheckRule)
}

// ── brokerLoadAlert Lambda (Load stream → broker task + global Slack ping) ──
// Fires when a load is assigned to the "Broker Need to Cover" driver: creates an
// IntakeItem task for Arcie and posts to the BCAT global Slack channel.

const brokerAlertFn = backend.brokerLoadAlert.resources.lambda as LambdaFunction
const loadTable     = stageTables['Load']

// Read the Load table's DynamoDB stream (the trigger source).
brokerAlertFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
    resources: [loadTable.tableStreamArn!],
  })
)
// Resolve the broker driver by name (Scan) + write the IntakeItem task (conditional put).
brokerAlertFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan'],
    resources: [driverTable.tableArn],
  })
)
brokerAlertFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],
    resources: [intakeTable.tableArn],
  })
)

brokerAlertFn.addEnvironment('TABLE_NAME',        intakeTable.tableName)   // IntakeItem
brokerAlertFn.addEnvironment('DRIVER_TABLE_NAME', driverTable.tableName)
brokerAlertFn.addEnvironment('BROKER_TASK_ASSIGNEE', 'arcie@bcatcorp.com')
brokerAlertFn.addEnvironment('BROKER_DRIVER_NAME',   process.env.BROKER_DRIVER_NAME ?? 'Broker Need to Cover')
// Optional hard override if the driver is ever renamed — set the driver id in the Console.
brokerAlertFn.addEnvironment('BROKER_DRIVER_ID',     process.env.BROKER_DRIVER_ID ?? '')
// Plain env var (not a secret) so a missing channel never blocks the deploy — set
// SLACK_GLOBAL_CHANNEL_ID in the Amplify Console env to enable the Slack post.
brokerAlertFn.addEnvironment('SLACK_GLOBAL_CHANNEL_ID', process.env.SLACK_GLOBAL_CHANNEL_ID ?? '')

// Create the mapping in the Lambda's OWN stack (the `data` stack, via resourceGroupName),
// NOT in Stack.of(loadTable) — the Load table sits in a child nested stack, and scoping the
// mapping there made the child reference the parent's Lambda while the Lambda's policy
// referenced the child's stream ARN → CloudFormation circular dependency (deploy #227).
// Scoping to brokerAlertFn keeps every cross-stack reference one-directional (data → Load).
new EventSourceMapping(Stack.of(brokerAlertFn), 'BrokerLoadStreamMapping', {
  target:            brokerAlertFn,
  eventSourceArn:    loadTable.tableStreamArn,
  startingPosition:  StartingPosition.LATEST,
  batchSize:         10,
  retryAttempts:     2,
  enabled:           process.env.BCAT_ISOLATED_PREVIEW !== 'true' && process.env.BCAT_DEV_STACK !== 'true',   // see the guards below
})

// ── loadTrackingProjector Lambda (Step D; Load stream → check-call rows) ────
// The driver app, the POD close and the dispatch MMS auto-POD all stamp
// stops[].arrivedAt / departedAt straight into Load and never touch Load.status.
// This consumer turns a newly stamped time into the matching LoadCheckCall row
// and advances the load through the same loadStatusFromStopTimes ladder the staff
// actions use. Its own write changes no stop time, so it does not re-trigger.
//
// It is the one Load-stream consumer left ENABLED on dev: unlike brokerLoadAlert
// and rateconAssignedText it only writes our own tables — no Slack, no Twilio,
// no SES — so a dev stack running it cannot reach anybody.
{
  const projectorFn = backend.loadTrackingProjector.resources.lambda as LambdaFunction
  projectorFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
    resources: [loadTable.tableStreamArn!],
  }))
  // Writes: Load (status), LoadCheckCall (the stop event), Shipment (rederive), Order (rederive).
  // BatchGetItem is what readBundle uses to collect LoadFinancials by load id —
  // without it rederiveShipmentStatus dies after the Load row has already moved.
  projectorFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
    resources: [loadTable.tableArn, trackingCheckCallTbl.tableArn, trackingShipmentTbl.tableArn, trackingOrderTbl.tableArn],
  }))
  // Read-only: the bundle's other halves and the driver roster.
  projectorFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: [
      trackingLoadCarrTbl.tableArn,
      stageTables['LoadFinancials'].tableArn,
      stageTables['LoadCharge'].tableArn,
      stageTables['Driver'].tableArn,
    ],
  }))
  projectorFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${loadTable.tableArn}/index/*`,
      `${trackingCheckCallTbl.tableArn}/index/*`,
      `${trackingOrderTbl.tableArn}/index/*`,
      `${trackingLoadCarrTbl.tableArn}/index/*`,
      `${stageTables['LoadCharge'].tableArn}/index/*`,
    ],
  }))
  projectorFn.addEnvironment('LOAD_TABLE_NAME',            loadTable.tableName)
  projectorFn.addEnvironment('LOAD_CHECK_CALL_TABLE_NAME', trackingCheckCallTbl.tableName)
  projectorFn.addEnvironment('SHIPMENT_TABLE_NAME',        trackingShipmentTbl.tableName)
  projectorFn.addEnvironment('ORDER_TABLE_NAME',           trackingOrderTbl.tableName)
  projectorFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',    trackingLoadCarrTbl.tableName)
  projectorFn.addEnvironment('LOAD_FINANCIALS_TABLE_NAME', stageTables['LoadFinancials'].tableName)
  projectorFn.addEnvironment('LOAD_CHARGE_TABLE_NAME',     stageTables['LoadCharge'].tableName)
  projectorFn.addEnvironment('DRIVER_TABLE_NAME',          stageTables['Driver'].tableName)
  // Same own-stack scoping as BrokerLoadStreamMapping (deploy #227 cycle).
  new EventSourceMapping(Stack.of(projectorFn), 'LoadTrackingProjectorStreamMapping', {
    target:            projectorFn,
    eventSourceArn:    loadTable.tableStreamArn,
    startingPosition:  StartingPosition.LATEST,
    batchSize:         10,
    retryAttempts:     2,
    enabled:           process.env.BCAT_ISOLATED_PREVIEW !== 'true',
  })
}

// ── shipmentNotifier Lambda (Step E; Load stream → delivery notices) ────────
// The second Load-stream consumer. Where the projector turns a stamped stop time
// into a status, this one turns a status into the e-mails that status is supposed
// to cause: the customer's milestone notice, and — once every leg of a shipment
// has delivered — the request to the outside carrier for their POD and invoice.
//
// It is created enabled on dev. Its only reach outside our own tables is SES,
// which the dev guard below denies outright, so every notice it writes lands as a
// NOT_SENT row carrying the text it rendered. That is the honest outcome and it is
// exactly what dev needs to exercise: the rows, the deduplication and the Copy
// path, with no possibility of a real customer hearing from a test stack.
{
  const notifyFn = backend.shipmentNotifier.resources.lambda as LambdaFunction
  notifyFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
    resources: [loadTable.tableStreamArn!],
  }))
  // Writes: ShipmentNotice (the row that precedes every send), TrackingLink (the
  // carrier's upload token), Shipment (deliveredAt and the last-notice stamps),
  // LoadCarrier (which link was sent and when).
  notifyFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
    resources: [
      shipmentNoticeTable.tableArn,
      trackingLinkTbl.tableArn,
      trackingShipmentTbl.tableArn,
      trackingLoadCarrTbl.tableArn,
    ],
  }))
  // Read-only: the load that moved, its order, the customer's contacts and
  // preferences, the org defaults and the letterhead the e-mail signs off with.
  notifyFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [
      loadTable.tableArn,
      trackingOrderTbl.tableArn,
      trackingCustomerTbl.tableArn,
      trackingSettingsTbl.tableArn,
      trackingDivisionTbl.tableArn,
      shipmentDocumentTable.tableArn,
    ],
  }))
  notifyFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${loadTable.tableArn}/index/*`,
      `${trackingOrderTbl.tableArn}/index/*`,
      `${trackingLoadCarrTbl.tableArn}/index/*`,
      `${trackingLinkTbl.tableArn}/index/*`,
      `${shipmentNoticeTable.tableArn}/index/*`,
      `${shipmentDocumentTable.tableArn}/index/*`,
    ],
  }))
  notifyFn.addEnvironment('LOAD_TABLE_NAME',             loadTable.tableName)
  notifyFn.addEnvironment('SHIPMENT_TABLE_NAME',         trackingShipmentTbl.tableName)
  notifyFn.addEnvironment('ORDER_TABLE_NAME',            trackingOrderTbl.tableName)
  notifyFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',     trackingLoadCarrTbl.tableName)
  notifyFn.addEnvironment('CUSTOMER_TABLE_NAME',         trackingCustomerTbl.tableName)
  notifyFn.addEnvironment('TMS_SETTINGS_TABLE_NAME',     trackingSettingsTbl.tableName)
  notifyFn.addEnvironment('DIVISION_TABLE_NAME',         trackingDivisionTbl.tableName)
  notifyFn.addEnvironment('TRACKING_LINK_TABLE_NAME',    trackingLinkTbl.tableName)
  notifyFn.addEnvironment('SHIPMENT_NOTICE_TABLE_NAME',  shipmentNoticeTable.tableName)
  notifyFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME', shipmentDocumentTable.tableName)
  notifyFn.addEnvironment('PORTAL_ORIGIN',               PORTAL_ORIGIN)
  notifyFn.addEnvironment('FROM_ADDRESS',                'ai4bcat@gmail.com')
  notifyFn.addToRolePolicy(
    new PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] })
  )
  // Same own-stack scoping as LoadTrackingProjectorStreamMapping (deploy #227 cycle).
  new EventSourceMapping(Stack.of(notifyFn), 'ShipmentNotifierStreamMapping', {
    target:            notifyFn,
    eventSourceArn:    loadTable.tableStreamArn,
    startingPosition:  StartingPosition.LATEST,
    batchSize:         10,
    retryAttempts:     2,
    enabled:           process.env.BCAT_ISOLATED_PREVIEW !== 'true',
  })
}

// ── checkCallNotifier Lambda (Step D; every 5m) ─────────────────────────────
// Rides Step B's sparse checkCallOpen + nextCheckCallAt index and DMs the load's
// carrier rep on Slack once for DUE and once for OVERDUE per scheduled time.
// The EventBridge rule defineFunction creates lives in the data stack, so the dev
// guard's findAll loop disables it; dev proves the sweep through the in-app
// worklist and a hand `aws lambda invoke`.
{
  const notifierFn = backend.checkCallNotifier.resources.lambda as LambdaFunction
  notifierFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
    resources: [loadTable.tableArn, trackingSettingsTbl.tableArn, trackingOrderTbl.tableArn, trackingLoadCarrTbl.tableArn],
  }))
  notifierFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [`${loadTable.tableArn}/index/*`, `${trackingOrderTbl.tableArn}/index/*`, `${trackingLoadCarrTbl.tableArn}/index/*`],
  }))
  notifierFn.addEnvironment('LOAD_TABLE_NAME',         loadTable.tableName)
  notifierFn.addEnvironment('TMS_SETTINGS_TABLE_NAME', trackingSettingsTbl.tableName)
  notifierFn.addEnvironment('ORDER_TABLE_NAME',        trackingOrderTbl.tableName)
  notifierFn.addEnvironment('LOAD_CARRIER_TABLE_NAME', trackingLoadCarrTbl.tableName)
  notifierFn.addEnvironment('USER_POOL_ID',            backend.auth.resources.userPool.userPoolId)
  notifierFn.addToRolePolicy(new PolicyStatement({
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  }))
}

// ── trackingAutomation Lambda (Step V; every 5m) ────────────────────────────
// Owns no logic: it invokes tmsTrackingActions as the `tracking-automation` system caller
// (SYSTEM_CALLERS in the router) to run one AUTO sweep. Same group ('data') and grant
// pattern as shipmentEmailIntake above, so no new stack edge. The EventBridge rule
// defineFunction({schedule}) creates lives in the data stack, so the dev guard
// (every CfnRule DISABLED) disables it and the BCAT_ISOLATED_PREVIEW guard zeroes the
// Lambda: no guard edit needed. Every master switch defaults OFF, so a production deploy
// sends nothing until Settings turns it on.
{
  const automationFn = backend.trackingAutomation.resources.lambda as LambdaFunction
  automationFn.addEnvironment('TMS_TRACKING_ACTIONS_FUNCTION_NAME', backend.tmsTrackingActions.resources.lambda.functionName)
  backend.tmsTrackingActions.resources.lambda.addPermission('TrackingAutomationInvoke', {
    principal: automationFn.grantPrincipal,
    action: 'lambda:InvokeFunction',
    sourceArn: automationFn.functionArn,
  })
  // defineFunction({schedule}) made the Scheduler schedule as the child `schedule-0`; below the
  // stage that creates Shipment/LoadCheckCall every run would fail, so the schedule waits.
  if (!triggerEnabled('trackingAutomation', SCHEMA_STAGE)) automationFn.node.tryRemoveChild('schedule-0')
}

// ── podActions Lambda (JobsDone PODs) ──────────────────────────────────────
// Custom AppSync router for JobsDone POD imports. All access is enforced here;
// the PodDocument model only allows this Lambda. Configuration is stored in a
// stack-specific SSM SecureString parameter under /bcat/pods/<userPoolId>/connection.

const podActionsFn = backend.podActions.resources.lambda as LambdaFunction
const podDocumentTable = stageTables['PodDocument']
const podStack = Stack.of(podActionsFn)
// Pin the Lambda name from the root stack name (unique per app/branch/sandbox and a
// plain string at synth time) so the async self-invoke can be granted by ARN string;
// granting through the construct produced a CloudFormation cycle
// (Lambda -> self-invoke policy -> data function-directive stack -> Lambda).
let podRootStack: Stack = podStack
while (podRootStack.nestedStackParent) podRootStack = podRootStack.nestedStackParent
const podRootStackName = podRootStack.stackName
const podFunctionName = `pod-actions-${createHash('sha256').update(podRootStackName).digest('hex').slice(0, 16)}`
;(podActionsFn.node.defaultChild as CfnFunction).functionName = podFunctionName
const podFunctionArn = podStack.formatArn({ service: 'lambda', resource: 'function', resourceName: podFunctionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })

const podConnectionParamName = `/bcat/pods/${backend.auth.resources.userPool.userPoolId}/connection`

const podSenderMappingTable = stageTables['PodSenderMapping']

podActionsFn.addEnvironment('POD_DOCUMENT_TABLE_NAME', podDocumentTable.tableName)
podActionsFn.addEnvironment('POD_SENDER_MAPPING_TABLE_NAME', podSenderMappingTable.tableName)
podActionsFn.addEnvironment('LOAD_TABLE_NAME', loadTable.tableName)
podActionsFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
podActionsFn.addEnvironment('POD_CONNECTION_PARAM_NAME', podConnectionParamName)
// Derived name (not `podActionsFn.functionName`) so the environment value is a plain
// string rather than a reference to the Lambda resource.
podActionsFn.addEnvironment('POD_FUNCTION_NAME', podFunctionName)

// The driver API asks pod-actions to clean up each uploaded scan. Name and invoke
// permission only — it never reads anything pod-actions owns.
driverApiFn.addEnvironment('POD_FUNCTION_NAME', podFunctionName)
driverApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['lambda:InvokeFunction'],
    resources: [podFunctionArn],
  }),
)
podActionsFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
// Driver and staff uploads land in DriverSubmissionDoc rather than PodDocument, and they
// need the same scan cleanup — a phone photo taken at a dock needs it more, not less.
podActionsFn.addEnvironment('DRIVER_SUBMISSION_DOC_TABLE_NAME', driverSubmissionDocTable.tableName)
podActionsFn.addEnvironment('DRIVER_SUBMISSION_TABLE_NAME', driverSubmissionTable.tableName)

const podDocumentTableArns = [podDocumentTable.tableArn, `${podDocumentTable.tableArn}/index/*`]
const podSenderMappingTableArns = [podSenderMappingTable.tableArn]
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:DeleteItem'],
    resources: podSenderMappingTableArns,
  }),
)
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: podDocumentTableArns,
  }),
)
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    // ConditionCheckItem: the assign transaction verifies the Load exists.
    actions:   ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
    resources: [loadTable.tableArn],
  }),
)
// The POD review check finds a driver's load by the PRO they typed when the submission has
// no loadId yet, which is a scan.
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan'],
    resources: [loadTable.tableArn],
  }),
)
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  }),
)
// Reads the page rows to find the files and writes back which copy is the cleaned one;
// reads them all again to merge, and records the finished PDF on the submission.
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'],
    resources: [driverSubmissionDocTable.tableArn, `${driverSubmissionDocTable.tableArn}/index/*`],
  }),
)
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [driverSubmissionTable.tableArn],
  }),
)

backend.storage.resources.bucket.grantPut(podActionsFn, 'pods/*')
backend.storage.resources.bucket.grantRead(podActionsFn, 'pods/*')
// Driver and staff uploads live under their own prefix; the cleaned copy is written
// beside the original there, never over it.
backend.storage.resources.bucket.grantRead(podActionsFn, 'driver-docs/*')
backend.storage.resources.bucket.grantPut(podActionsFn, 'driver-docs/*')
// Pictures texted to dispatch are filed as PODs straight from the dispatch media folder
// (dispatchAutoPod); the cleanup reads the original there and writes the cleaned page
// beside it, so it needs both directions on that prefix.
backend.storage.resources.bucket.grantReadWrite(podActionsFn, 'dispatch-media/*')
// The POD review check reads the load's rate confirmation to compare addresses with.
backend.storage.resources.bucket.grantRead(podActionsFn, 'rate-confirms/*')

// The frontend downloads presigned POD originals/enhanced images with fetch(),
// so the bucket must answer CORS GETs from the app origins.
storageBucket.addCorsRule({
  allowedOrigins: PORTAL_ORIGINS,
  allowedMethods: [HttpMethods.GET],
  allowedHeaders: ['*'],
  maxAge:         300,
})

const podConnParamArn = Stack.of(podActionsFn).formatArn({
  service: 'ssm',
  resource: 'parameter',
  // For hierarchical SSM parameter ARNs the leading slash is part of the resource id.
  resourceName: podConnectionParamName.replace(/^\//, ''),
})
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['ssm:GetParameter'],
    resources: [podConnParamArn],
  }),
)
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['ssm:PutParameter'],
    resources: [podConnParamArn],
  }),
)

// Self-invoke permission for async processing (Lambda → Event → same Lambda),
// expressed by name/ARN string rather than the construct to avoid a policy cycle.
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['lambda:InvokeFunction'],
    resources: [podFunctionArn],
  }),
)

// Scanner layer/env wiring and memory/timeout for document enhancement.
configurePodScanner(podActionsFn)

// JobsDone is disconnected: PODs now come only from the driver apps and are reviewed on
// the PODs page. The 15-minute JobsDone import that ran here is gone; PODs already
// imported stay readable on their loads.

podActionsFn.addEnvironment('POD_BACKGROUND_SYNC_ENABLED', 'true')

// ── Isolated preview guard ──────────────────────────────────────────────────
// A sandbox or feature-branch stack deployed with BCAT_ISOLATED_PREVIEW=true must never
// reach the outside world: every schedule is disabled, the Load-stream consumer is created disabled,
// and every Lambda that emails, posts to Slack, or calls Motive / Blue Ink / Instantly /
// Paychex / Anthropic — or serves a public Function URL — is pinned to zero concurrency
// and explicitly denied SES. Only the pure-database directory/user/vendor-AP resolvers
// and the geocode proxy stay callable. The flag is refused on the production branch.
if (process.env.BCAT_ISOLATED_PREVIEW === 'true') {
  if (process.env.AWS_BRANCH === 'main') {
    throw new Error('BCAT_ISOLATED_PREVIEW must never be set on the main branch')
  }
  for (const rule of [
    apptReportRule, cashReminderRule, monthlyRule, dailyMileageRule, locationSyncRule,
    faultSyncRule, odometerOpenWeekRule, odometerCloseDayRule,
    blueinkLocationRule, blueinkMileageRule, complianceScanRule, paychexWeeklyRule,
    ...dataSafetyRules,
  ]) {
    (rule.node.defaultChild as CfnRule).state = 'DISABLED'
  }

  const previewCallable = new Set(['userManagement', 'vendorApActions', 'tmsDirectoryActions', 'tmsShipmentActions', 'tmsCarrierActions', 'tmsTrackingActions', 'tmsFinanceActions', 'tmsAljexImport', 'tmsGeocode', 'podActions'])
  for (const [name, construct] of Object.entries(backend)) {
    if (previewCallable.has(name)) continue
    const lambda = (construct as { resources?: { lambda?: LambdaFunction } }).resources?.lambda
    if (!lambda) continue
    ;(lambda.node.defaultChild as CfnFunction).reservedConcurrentExecutions = 0
    lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ['ses:*'], resources: ['*'] }))
  }
}

// ── OTR Solutions factoring ────────────────────────────────────────────────
// otrActions is the human-initiated router (resolve/assemble/setMc/brokerCheck/
// submit/syncStatus) behind the manageOtr mutation. otrStatusSync is a separate
// hourly, READ-ONLY poller that mirrors OTR's invoice board onto the queue —
// keeping it separate means a bug in polling can never create an invoice.
//
// OTR_BASE_URL is set here rather than hard-coded so moving to production is a
// config change. Staging until the production credentials are swapped in.
/*
 * PRODUCTION, and v2 only.
 *
 * Tested with the production subscription key: /carrier-tms/2/auth/token issues a token,
 * while CarrierTmsV3, CarrierTms, CarrierTmsV2, carrier-tms/1 and carrier-tms/3 all 404 or
 * 401. There is no v1 in production, so invoices and documents both speak v2 — the client
 * derives the body shape from this URL, so the two cannot drift apart.
 *
 * Staging, for reference: https://servicesstg.otrsolutions.com/carrier-tms/2
 */
const OTR_BASE_URL = 'https://services.otrsolutions.com/carrier-tms/2'
/*
 * Documents go to OTR's v2 API. A separate product on their gateway — our subscription key
 * only reached it once OTR widened it — and the half of the integration that never worked:
 * v1 shredded every byte above 0x7F on the way in, and crashed with a null reference on
 * anything its PDF reader could open. v2 took the real 1MB POD untouched and returned 200.
 * Invoices stay on v1, which has always worked; v2's ItemPkey accepts the same invoice id.
 */
const OTR_UPLOAD_BASE_URL = 'https://services.otrsolutions.com/carrier-tms/2'
/*
 * BCAT's own USDOT, which v2 requires on every invoice as ClientDOT. Not a secret — it is
 * painted on the doors of every truck — so it lives here rather than in SSM, where it
 * would be one more thing to set up on a new branch.
 */
const OTR_CLIENT_DOT = '547328'

const otrActionsFn = backend.otrActions.resources.lambda as LambdaFunction
const otrSyncFn = backend.otrStatusSync.resources.lambda as LambdaFunction

const otrFactoringTable = stageTables['FactoringItem']
const otrLoadTable = stageTables['Load']
const otrCustomerTable = stageTables['Customer']
const otrLocationTable = stageTables['Location']
const otrPodTable = stageTables['PodDocument']
// A POD can also arrive as a driver scan or a staff upload, which land in
// DriverSubmissionDoc rather than PodDocument. Submit has to see both, or a POD someone
// watched reach Slack is invisible to the thing that invoices it.
const otrSubmissionTable = stageTables['DriverSubmission']
const otrSubmissionDocTable = stageTables['DriverSubmissionDoc']

for (const fn of [otrActionsFn, otrSyncFn]) {
  fn.addEnvironment('FACTORING_ITEM_TABLE_NAME', otrFactoringTable.tableName)
  fn.addEnvironment('OTR_BASE_URL', OTR_BASE_URL)
  fn.addEnvironment('OTR_UPLOAD_BASE_URL', OTR_UPLOAD_BASE_URL)
  fn.addEnvironment('OTR_CLIENT_DOT', OTR_CLIENT_DOT)
}

// A submit cleans up the POD first if nothing has yet — see enhancedPodForSend. Name and
// invoke permission only; otr-actions reads the submission tables it already has.
otrActionsFn.addEnvironment('POD_FUNCTION_NAME', podFunctionName)
otrActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['lambda:InvokeFunction'],
    resources: [podFunctionArn],
  }),
)
otrActionsFn.addEnvironment('LOAD_TABLE_NAME', otrLoadTable.tableName)
otrActionsFn.addEnvironment('CUSTOMER_TABLE_NAME', otrCustomerTable.tableName)
otrActionsFn.addEnvironment('LOCATION_TABLE_NAME', otrLocationTable.tableName)
otrActionsFn.addEnvironment('POD_DOCUMENT_TABLE_NAME', otrPodTable.tableName)
otrActionsFn.addEnvironment('DRIVER_SUBMISSION_TABLE_NAME', otrSubmissionTable.tableName)
otrActionsFn.addEnvironment('DRIVER_SUBMISSION_DOC_TABLE_NAME', otrSubmissionDocTable.tableName)
// Step F: the third place a POD or the customer's tender can be. A load booked in the
// TMS for an outside carrier has neither a JobsDone text nor a driver submission — its
// documents are ShipmentDocument rows, read through the shipmentId index.
otrActionsFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME', shipmentDocumentTable.tableName)
otrActionsFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)

// Queue rows: the router reads and writes; the poller only updates status fields.
otrActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: [otrFactoringTable.tableArn, `${otrFactoringTable.tableArn}/index/*`],
  }),
)
otrSyncFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:UpdateItem', 'dynamodb:Scan'],
    resources: [otrFactoringTable.tableArn],
  }),
)

// Loads: read to resolve a PRO; update only to link a newly created Customer.
otrActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:UpdateItem'],
    resources: [otrLoadTable.tableArn, `${otrLoadTable.tableArn}/index/*`],
  }),
)

// Customers: PutItem so a broker missing from the directory is created when a
// human enters its MC (see the setMc action).
otrActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [otrCustomerTable.tableArn, `${otrCustomerTable.tableArn}/index/*`],
  }),
)

// Moving a row onto the manual path also clears Invoice.factored (and returning sets it
// back), and every such move writes an AuditLog row. Invoice: read + update only.
otrActionsFn.addEnvironment('INVOICE_TABLE_NAME', stageTables['Invoice'].tableName)
otrActionsFn.addEnvironment('AUDIT_LOG_TABLE_NAME', stageTables['AuditLog'].tableName)
otrActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [stageTables['Invoice'].tableArn],
  }),
)
otrActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],
    resources: [stageTables['AuditLog'].tableArn],
  }),
)

// Locations, PODs, driver submissions and shipment documents are read-only here. The
// shipment documents are reached only by Query on the shipmentId index, so the index ARN
// is the one that matters.
otrActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:Query'],
    resources: [
      otrLocationTable.tableArn,
      otrPodTable.tableArn,
      `${otrPodTable.tableArn}/index/*`,
      otrSubmissionTable.tableArn,
      `${otrSubmissionTable.tableArn}/index/*`,
      otrSubmissionDocTable.tableArn,
      `${otrSubmissionDocTable.tableArn}/index/*`,
      shipmentDocumentTable.tableArn,
      `${shipmentDocumentTable.tableArn}/index/*`,
    ],
  }),
)

// The POD and rate confirmation are streamed from S3 to OTR at submit time.
backend.storage.resources.bucket.grantRead(otrActionsFn)

// Intake enriches each new row by invoking otrActions asynchronously. The name is
// derived from the root stack (a plain string at synth time) rather than the
// construct, so granting invoke by ARN string avoids the CloudFormation cycle the
// pod-actions self-invoke hit.
let otrRootStack: Stack = Stack.of(otrActionsFn)
while (otrRootStack.nestedStackParent) otrRootStack = otrRootStack.nestedStackParent
const otrFunctionName = `otr-actions-${createHash('sha256').update(otrRootStack.stackName).digest('hex').slice(0, 16)}`
;(otrActionsFn.node.defaultChild as CfnFunction).functionName = otrFunctionName
const otrFunctionArn = Stack.of(otrActionsFn).formatArn({
  service: 'lambda',
  resource: 'function',
  resourceName: otrFunctionName,
  arnFormat: ArnFormat.COLON_RESOURCE_NAME,
})

factoringIntakeFn.addEnvironment('OTR_ACTIONS_FUNCTION_NAME', otrFunctionName)
factoringIntakeFn.addToRolePolicy(
  new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [otrFunctionArn] }),
)

// ── Step AB: per-rep Gmail spot quoter + CRM bones ──────────────────────────
//
// tms-spot-quoter: AppSync `tmsSpotActions` + a five-minute poll rule (DISABLED on dev by
// the generic CfnRule loop in the dev guard below; SPOT_POLL_NOW is the manual door).
// Least privilege, every statement named: read/write on its own three tables and the four
// CRM tables, READ-ONLY on the tables it only looks at, PutItem on AuditLog. It holds no
// write on Quote, Customer, Shipment, Order, Load or Invoice, no ses:*, no bedrock:*, no
// KMS, no Secrets Manager and no Cognito admin action except AdminGetUser (Step AL caller resolution). The only way it creates a Quote is
// the direct-invoke door on tms-shipment-actions (lambda:InvokeFunction on that one
// function). No Google secret is an Amplify secret: the OAuth client id/secret are read
// from the Integrations page parameter, each rep's refresh token from its own prefix.
const spotFn = backend.tmsSpotQuoter.resources.lambda as LambdaFunction
const crmFn  = backend.tmsCrmActions.resources.lambda as LambdaFunction
passDataTableSuffix(crmFn, CRM_ACTIONS_TABLES)
const abTable = (name: string) => stageTables[name]
const spotSettingsTable   = abTable('SpotSettings')
const gmailConnTable      = abTable('GmailConnection')
const spotRequestTable    = abTable('SpotRequest')
const crmContactTable     = abTable('CrmContact')
const crmDomainTable      = abTable('CrmDomain')
const crmActivityTable    = abTable('CrmActivity')
const crmAccountTable     = abTable('CrmAccount')
const abCustomerTable     = abTable('Customer')
const abQuoteTable        = abTable('Quote')
const abSettingsTable     = abTable('TmsSettings')
const abIntegrationTable  = abTable('Integration')
const abUserProfileTable  = abTable('UserProfile')
const abAuditTable        = abTable('AuditLog')
const abShipmentTable     = abTable('Shipment')
const abOrderTable        = abTable('Order')

const gmailTokenParamPath = `/bcat/gmail/${backend.auth.resources.userPool.userPoolId}/users`
const withIndexes = (...tables: { tableArn: string }[]) =>
  tables.flatMap((t) => [t.tableArn, `${t.tableArn}/index/*`])

spotFn.addEnvironment('SPOT_SETTINGS_TABLE_NAME',    spotSettingsTable.tableName)
spotFn.addEnvironment('GMAIL_CONNECTION_TABLE_NAME', gmailConnTable.tableName)
spotFn.addEnvironment('SPOT_REQUEST_TABLE_NAME',     spotRequestTable.tableName)
spotFn.addEnvironment('CRM_CONTACT_TABLE_NAME',      crmContactTable.tableName)
spotFn.addEnvironment('CRM_DOMAIN_TABLE_NAME',       crmDomainTable.tableName)
spotFn.addEnvironment('CRM_ACTIVITY_TABLE_NAME',     crmActivityTable.tableName)
spotFn.addEnvironment('CRM_ACCOUNT_TABLE_NAME',      crmAccountTable.tableName)
spotFn.addEnvironment('CUSTOMER_TABLE_NAME',         abCustomerTable.tableName)
spotFn.addEnvironment('QUOTE_TABLE_NAME',            abQuoteTable.tableName)
spotFn.addEnvironment('TMS_SETTINGS_TABLE_NAME',     abSettingsTable.tableName)
spotFn.addEnvironment('INTEGRATION_TABLE_NAME',      abIntegrationTable.tableName)
spotFn.addEnvironment('USER_PROFILE_TABLE_NAME',     abUserProfileTable.tableName)
spotFn.addEnvironment('AUDIT_LOG_TABLE_NAME',        abAuditTable.tableName)
spotFn.addEnvironment('BUCKET_NAME',                 backend.storage.resources.bucket.bucketName)
spotFn.addEnvironment('INTEGRATION_PARAM_PATH',      integrationParamPath)
spotFn.addEnvironment('GMAIL_TOKEN_PARAM_PATH',      gmailTokenParamPath)
spotFn.addEnvironment('PORTAL_ORIGINS',              JSON.stringify(PORTAL_ORIGINS))
spotFn.addEnvironment('PORTAL_ORIGIN',               PORTAL_ORIGIN)
spotFn.addEnvironment('USER_POOL_ID',                backend.auth.resources.userPool.userPoolId)

// Its own tables, plus the CRM tables it writes system activity into (crmStore).
spotFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: withIndexes(
    gmailConnTable, spotRequestTable, spotSettingsTable,
    crmContactTable, crmDomainTable, crmActivityTable, crmAccountTable,
  ),
}))
// Read-only: it recognises a customer, prices against a quote's state and a rep's role.
spotFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: withIndexes(abCustomerTable, abQuoteTable, abSettingsTable, abIntegrationTable, abUserProfileTable),
}))
spotFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:PutItem'],
  resources: [abAuditTable.tableArn],
}))

// SSM. The OAuth client: that one parameter, read-only (the integrations Lambda owns its
// writes). Rep refresh tokens: the separate /bcat/gmail prefix, which the integrations
// Lambda's /bcat/integrations/<pool>/* grant does not match and no other Lambda holds.
spotFn.addToRolePolicy(new PolicyStatement({
  actions:   ['ssm:GetParameter'],
  resources: ['GMAIL_REP_OAUTH', 'DAT'].map((provider) => Stack.of(spotFn).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: `${integrationParamPath.replace(/^\//, '')}/${provider}`,
  })),
}))
spotFn.addToRolePolicy(new PolicyStatement({
  actions:   ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
  resources: [Stack.of(spotFn).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: `${gmailTokenParamPath.replace(/^\//, '')}/*`,
  })],
}))

// The SIMULATED inbox: objects under spot-sim/ and nothing else in the bucket.
spotFn.addToRolePolicy(new PolicyStatement({
  actions:   ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
  resources: [`${backend.storage.resources.bucket.bucketArn}/spot-sim/*`],
}))
spotFn.addToRolePolicy(new PolicyStatement({
  actions:    ['s3:ListBucket'],
  resources:  [backend.storage.resources.bucket.bucketArn],
  conditions: { StringLike: { 's3:prefix': ['spot-sim/*'] } },
}))

// Read-only mailbox (Ryne, 2026-11-04): the spot Lambda holds no Gmail write and no write on
// Quote/Shipment/Load/ShipmentMessage/Carrier. Its only invoke is Step AL's, below.

// Every five minutes. DISABLED on dev by the dev guard's CfnRule loop. Created at the stage that
// creates its tables (TRIGGER_MODELS): below it the poll would only fail on an empty table name.
if (triggerEnabled('spotQuoterPoll', SCHEMA_STAGE)) {
  const spotPollRule = new Rule(spotFn.stack, 'SpotQuoterPollRule', {
    schedule:    Schedule.rate(Duration.minutes(5)),
    description: 'Poll each connected rep Gmail for quote requests',
  })
  spotPollRule.addTarget(new EventsLambdaTarget(spotFn, {
    event: RuleTargetInput.fromObject({ poll: true }),
  }))
}

// A spot request carries the mail body: DynamoDB expires it (`ttlEpoch`, epoch seconds)
// instead of anything sweeping. Dismissed requests get a shorter horizon from the Lambda.
stageCfnTables['SpotRequest'].timeToLiveAttribute = {
  attributeName: 'ttlEpoch',
  enabled: true,
}
// Step AO: load-keyed breadcrumbs and route-cache rows in TruckLocationHistory carry
// `ttlEpoch` (90 / 30 days); Motive and Blue Ink rows have none and are never touched.
// Staged deploy: set ONLY in the final stage, alone (TTL_STAGE). DynamoDB allows one TTL change per
// table per hour, so a stage that fails after this change cannot roll back (UPDATE_ROLLBACK_FAILED).
if (SCHEMA_STAGE >= TTL_STAGE) {
  stageCfnTables['TruckLocationHistory'].timeToLiveAttribute = {
    attributeName: 'ttlEpoch',
    enabled: true,
  }
}

// ── Step AL: Carrier Sales inbound offers hub ───────────────────────────────
// The listener is a third door in the spot Lambda. It classifies and hands the result to
// tms-shipment-actions (FILE_INBOUND_OFFER, system caller 'carrier-inbox' only); the spot role
// gets no write on Quote/Shipment/ShipmentMessage. The invoke grant is a resource policy on the
// target (no cycle). NO sourceArn: a direct Invoke by a role carries no aws:SourceArn, so that
// condition (the TrackingAutomationInvoke shape) never matches and the call is denied.
spotFn.addEnvironment('SHIPMENT_ACTIONS_FUNCTION_NAME', backend.tmsShipmentActions.resources.lambda.functionName)
// Access tokens carry no e-mail claim: csAuthorize resolves the caller through AdminGetUser (the AP inbox / vendorApActions pattern).
spotFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)
spotFn.addToRolePolicy(new PolicyStatement({
  actions:   ['cognito-idp:AdminGetUser'],
  resources: [backend.auth.resources.userPool.userPoolArn],
}))
backend.tmsShipmentActions.resources.lambda.addPermission('CarrierInboxInvoke', {
  principal: spotFn.grantPrincipal,
  action: 'lambda:InvokeFunction',
})
// Cowtown voice agent POSTs a call summary here; the body secret (sha256 in SpotSettings) is the only auth.
const carrierCallUrl = new FunctionUrl(spotFn.stack, 'CarrierCallUrl', {
  function: spotFn,
  authType: FunctionUrlAuthType.NONE,
})
new CfnOutput(spotFn.stack, 'CarrierCallFunctionUrl', {
  value: carrierCallUrl.url,
  description: 'Cowtown voice agent: POST <url>carrier-call',
})
// Unmatched inbound offers carry the mail body: DynamoDB expires them (`ttlEpoch` is set only
// on shipmentId='UNMATCHED' rows). Every other message row has none and is never touched.
stageCfnTables['ShipmentMessage'].timeToLiveAttribute = {
  attributeName: 'ttlEpoch',
  enabled: true,
}

// ── Step AG: Accounting AP inbox (tms-ap-inbox) ─────────────────────────────
// AppSync `tmsApInboxActions` + an hourly rule (DISABLED on dev by the generic CfnRule loop).
// Least privilege, every statement named: RW on ApInboxItem; read on the AP/ledger tables;
// UpdateItem ONLY on CarrierBill, TmsSettings and VendorPayable (+PutItem on VendorPayable for
// create-from-queue); PutItem on ShipmentDocument and AuditLog. No DeleteItem on any table, no
// write on LoadCarrier/Load/Shipment/Order/Invoice/ApPayment/Carrier, no ses:*, bedrock:*, KMS,
// Cognito. SSM: the OAuth client parameter read-only and the ONE ap-inbox token parameter.
const apInboxFn = backend.tmsApInbox.resources.lambda as LambdaFunction
const apinItemTable     = abTable('ApInboxItem')
const apinBillTable     = abTable('CarrierBill')
const apinLcTable       = abTable('LoadCarrier')
const apinVendorTable   = abTable('VendorPayable')
const apinLoadTable     = abTable('Load')
const apinCarrierTable  = abTable('Carrier')
const apinDocTable      = abTable('ShipmentDocument')

apInboxFn.addEnvironment('AP_INBOX_ITEM_TABLE_NAME',    apinItemTable.tableName)
apInboxFn.addEnvironment('CARRIER_BILL_TABLE_NAME',     apinBillTable.tableName)
apInboxFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',     apinLcTable.tableName)
apInboxFn.addEnvironment('VENDOR_PAYABLE_TABLE_NAME',   apinVendorTable.tableName)
apInboxFn.addEnvironment('LOAD_TABLE_NAME',             apinLoadTable.tableName)
apInboxFn.addEnvironment('SHIPMENT_TABLE_NAME',         abShipmentTable.tableName)
apInboxFn.addEnvironment('CARRIER_TABLE_NAME',          apinCarrierTable.tableName)
apInboxFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME', apinDocTable.tableName)
apInboxFn.addEnvironment('TMS_SETTINGS_TABLE_NAME',     abSettingsTable.tableName)
apInboxFn.addEnvironment('INTEGRATION_TABLE_NAME',      abIntegrationTable.tableName)
apInboxFn.addEnvironment('AUDIT_LOG_TABLE_NAME',        abAuditTable.tableName)
apInboxFn.addEnvironment('BUCKET_NAME',                 backend.storage.resources.bucket.bucketName)
apInboxFn.addEnvironment('INTEGRATION_PARAM_PATH',      integrationParamPath)
apInboxFn.addEnvironment('GMAIL_TOKEN_PARAM_PATH',      gmailTokenParamPath)
apInboxFn.addEnvironment('PORTAL_ORIGINS',              JSON.stringify(PORTAL_ORIGINS))
// Access tokens carry no e-mail claim: authorize() resolves the caller through AdminGetUser (vendorApActions pattern).
apInboxFn.addEnvironment('USER_POOL_ID',                  backend.auth.resources.userPool.userPoolId)
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['cognito-idp:AdminGetUser'],
  resources: [backend.auth.resources.userPool.userPoolArn],
}))

apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: withIndexes(apinItemTable),
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchGetItem'],
  // Only the two GSIs the ledger queries (apOpen on CarrierBill / LoadCarrier) need `index/*`;
  // every other table is read by key or Scan, which keeps the data-stack template small.
  resources: [
    ...withIndexes(apinBillTable, apinLcTable),
    apinLoadTable.tableArn, abShipmentTable.tableArn, apinCarrierTable.tableArn, apinDocTable.tableArn,
    abSettingsTable.tableArn, abIntegrationTable.tableArn, apinVendorTable.tableArn,
  ],
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:UpdateItem'],
  resources: [apinBillTable.tableArn, abSettingsTable.tableArn, apinVendorTable.tableArn],
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:PutItem'],
  resources: [apinVendorTable.tableArn, apinDocTable.tableArn, abAuditTable.tableArn],
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['ssm:GetParameter'],
  resources: [Stack.of(apInboxFn).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: `${integrationParamPath.replace(/^\//, '')}/GMAIL_REP_OAUTH`,
  })],
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
  resources: [Stack.of(apInboxFn).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: `${gmailTokenParamPath.replace(/^\//, '')}/ap-inbox`,
  })],
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['s3:PutObject', 's3:DeleteObject'],
  resources: [`${backend.storage.resources.bucket.bucketArn}/intake-pdfs/ap-inbox/*`],
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:   ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
  resources: [`${backend.storage.resources.bucket.bucketArn}/spot-sim/ap-inbox/*`],
}))
apInboxFn.addToRolePolicy(new PolicyStatement({
  actions:    ['s3:ListBucket'],
  resources:  [backend.storage.resources.bucket.bucketArn],
  conditions: { StringLike: { 's3:prefix': ['spot-sim/ap-inbox/*'] } },
}))

// Every hour; the handler runs the review only at the configured Chicago hour (or to finish a
// partial run). DISABLED on dev by the dev guard's CfnRule loop.
const apInboxRule = new Rule(apInboxFn.stack, 'ApInboxHourlyRule', {
  schedule:    Schedule.rate(Duration.hours(1)),
  description: 'Hourly check for the daily AP inbox review',
})
apInboxRule.addTarget(new EventsLambdaTarget(apInboxFn, {
  event: RuleTargetInput.fromObject({ sync: true, scheduled: true }),
}))

// An inbox item carries the e-mail text: DynamoDB expires it (`ttlEpoch`, epoch seconds).
stageCfnTables['ApInboxItem'].timeToLiveAttribute = {
  attributeName: 'ttlEpoch',
  enabled: true,
}

// tms-crm-actions: RW on the four CRM tables; read-only on what the timeline derives
// from; audit PutItem. No SSM, S3, model or Gmail.
crmFn.addEnvironment('USER_POOL_ID',            backend.auth.resources.userPool.userPoolId)
// A caller with no UserProfile row (first load on a fresh stack) is resolved through the pool.
crmFn.addToRolePolicy(new PolicyStatement({
  actions:   ['cognito-idp:AdminGetUser'],
  resources: [backend.auth.resources.userPool.userPoolArn],
}))
crmFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: withIndexes(crmContactTable, crmDomainTable, crmActivityTable, crmAccountTable),
}))
// Step AI read sources (Invoice, LaneRateSample, TmsSettings, OwnershipDivision) join this statement.
const crmAiSources = ['Invoice', 'LaneRateSample', 'TmsSettings', 'OwnershipDivision'].map((m) => stageTables[m])
crmFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: withIndexes(abCustomerTable, abQuoteTable, abShipmentTable, abOrderTable, abUserProfileTable, ...crmAiSources),
}))
crmFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:PutItem'],
  resources: [abAuditTable.tableArn],
}))
// CRM_ASSIGN_OWNER's one Customer write (accountOwnerIds only; the Lambda code enforces
// the attribute). Nothing else on Customer is writable from here.
crmFn.addToRolePolicy(new PolicyStatement({
  actions:   ['dynamodb:UpdateItem'],
  resources: [abCustomerTable.tableArn],
}))
// Step AI (conversational dashboards) rides this router: read-only on the dashboard sources,
// and DashboardRollup is the spec store (rows 'DASH:<id>'; Put/Update ONLY there).
{
  const aiTables = stageTables
  crmFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [aiTables['DashboardRollup'].tableArn],
  }))
}

// ── tmsDashboardRollup Lambda (Step AF; dashboard KPIs from ~100 pre-aggregated rows) ────
// Stream consumer on the six tables the dashboards are computed from, plus a five-minute
// sweep. Reads the source tables, writes only DashboardRollup. Mappings are created in the
// Lambda's own stack (deploy #227 cycle), like the other stream consumers.
// Skipped while the DashboardRollup table is not part of the staged schema.
if (tableOrNull('DashboardRollup')) {
  const rollupFn = backend.tmsDashboardRollup.resources.lambda as LambdaFunction
  const rollupTables = stageTables
  const rollupTable = rollupTables['DashboardRollup']
  const rollupSources = {
    Shipment:       rollupTables['Shipment'],
    Order:          rollupTables['Order'],
    Load:           rollupTables['Load'],
    LaneRateSample: rollupTables['LaneRateSample'],
    Invoice:        rollupTables['Invoice'],
    CarrierBill:    rollupTables['CarrierBill'],
  }
  rollupFn.addEnvironment('DASHBOARD_ROLLUP_TABLE_NAME', rollupTable.tableName)
  rollupFn.addEnvironment('SHIPMENT_TABLE_NAME',         rollupSources.Shipment.tableName)
  rollupFn.addEnvironment('ORDER_TABLE_NAME',            rollupSources.Order.tableName)
  rollupFn.addEnvironment('LOAD_TABLE_NAME',             rollupSources.Load.tableName)
  rollupFn.addEnvironment('LANE_RATE_SAMPLE_TABLE_NAME', rollupSources.LaneRateSample.tableName)
  rollupFn.addEnvironment('INVOICE_TABLE_NAME',          rollupSources.Invoice.tableName)
  rollupFn.addEnvironment('CARRIER_BILL_TABLE_NAME',     rollupSources.CarrierBill.tableName)
  rollupFn.addEnvironment('DATA_SAFETY_BUCKET_NAME',     dataSafetyBucket.bucketName)
  rollupFn.addToRolePolicy(new PolicyStatement({
    actions:   ['s3:PutObject'],
    resources: [`${dataSafetyBucket.bucketArn}/rollups/brokerage/*`],
  }))
  // Read/write: its own table only (rows, dirty markers, leases).
  rollupFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: [rollupTable.tableArn],
  }))
  // Read-only on the sources (BatchGetItem: the readBundle lesson), tables and their indexes.
  rollupFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query'],
    resources: Object.values(rollupSources).flatMap((t) => [t.tableArn, `${t.tableArn}/index/*`]),
  }))
  rollupFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
    resources: Object.values(rollupSources).map((t) => t.tableStreamArn!),
  }))
  for (const [name, table] of Object.entries(rollupSources)) {
    new EventSourceMapping(Stack.of(rollupFn), `DashboardRollup${name}StreamMapping`, {
      target:                rollupFn,
      eventSourceArn:        table.tableStreamArn,
      startingPosition:      StartingPosition.LATEST,
      batchSize:             100,
      maxBatchingWindow:     Duration.seconds(10),
      retryAttempts:         3,
      bisectBatchOnError:    true,
      reportBatchItemFailures: true,
      enabled:               process.env.BCAT_ISOLATED_PREVIEW !== 'true',
    })
  }
  // The only dev-enabled schedule besides the DataSafety pair (devRuleGuard.ts): it writes only DashboardRollup.
  const rollupSweepRule = new Rule(rollupFn.stack, 'DashboardRollupSweepRule', {
    schedule:    Schedule.rate(Duration.minutes(5)),
    description: 'Recompute dirty dashboard rollup rows, the live row and the current months',
  })
  rollupSweepRule.addTarget(new EventsLambdaTarget(rollupFn, { event: RuleTargetInput.fromObject({ sweep: true }) }))
}

// ── Dev stack guard (ops-dev.bcatcorp.com) ──────────────────────────────────
// BCAT_DEV_STACK=true marks the long-lived `dev` branch stack: a full working copy of
// the app (every page, every Lambda callable) on its own tables, pool and bucket, used
// to build and test before a change reaches main. Unlike BCAT_ISOLATED_PREVIEW it does
// not zero the Lambdas — the point of dev is to use the whole app — but nothing on it
// may act on the outside world by itself: every EventBridge schedule (including the
// ones defineFunction creates) is disabled, and the two Load-stream consumers that
// reach the outside world (brokerLoadAlert, rateconAssignedText) are created disabled
// above — loadTrackingProjector stays enabled because it writes only our own tables.
// shipmentNotifier is enabled here too: its one outside call is SES, which the deny
// below refuses, so every notice it writes lands as a NOT_SENT row carrying the text
// it rendered — which is exactly the behaviour dev needs to exercise.
// Every Lambda is denied SES to any recipient except ai4bcat@gmail.com (and its +tag aliases):
// the account has SES production access, so this condition is the only thing standing between
// dev data and a real customer's inbox. Slack, OTR, Paychex and Blue Ink are
// neutered on dev by branch-level secret overrides (see Docs/DEV_STACK.md); Twilio
// is inert because dev's user pool has no /bcat/dispatch/<poolId>/ config.
// Runs last so every rule already exists. Refused on main.
if (process.env.BCAT_DEV_STACK === 'true') {
  if (process.env.AWS_BRANCH === 'main') {
    throw new Error('BCAT_DEV_STACK must never be set on the main branch')
  }
  let devRootStack: Stack = backend.data.stack
  while (devRootStack.nestedStackParent) devRootStack = devRootStack.nestedStackParent
  for (const construct of devRootStack.node.findAll()) {
    // Exactly three exceptions (exact scope-id match): the nightly export and its check, and the
    // dashboard rollup sweep. The guard's rule is "nothing acts on the outside world by itself";
    // the first two read dev tables and write the dev DataSafety bucket, the third reads dev
    // tables and writes only the DashboardRollup table. A lookalike id stays disabled.
    if (construct instanceof CfnRule) construct.state = devRuleState(construct.node.scope?.node.id)
  }
  for (const construct of Object.values(backend)) {
    const lambda = (construct as { resources?: { lambda?: LambdaFunction } }).resources?.lambda
    if (!lambda) continue
    // Mail may only reach the test mailbox (devRuleGuard.ts devSesDeny): one other recipient refuses the send.
    const sesDeny = devSesDeny()
    lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: sesDeny.actions, resources: ['*'], conditions: sesDeny.conditions }))
    lambda.addEnvironment('BCAT_DEV_STACK', 'true')
  }
}

// ── Secret environment variables (every stack) ──────────────────────────────
// Amplify fills each `secret()` variable from SSM at cold start: the runtime shim overwrites
// process.env[name] with the parameter, whatever the deployed value was. The deployed value is
// the 39-byte placeholder "<value will be resolved during runtime>", which Lambda counts against
// its 4 KB environment limit (89 variables on main = 3.4 KB of template and environment). Ship
// an empty string instead; a secret SSM does not hold then reads as unset rather than as that text.
//
// On the dev stack the secrets that reach a third party with side effects are replaced by a
// placeholder: Amplify resolves `secret()` values at cold start from the SSM paths listed in
// AMPLIFY_SSM_ENV_CONFIG; dropping a name from that list and setting the variable to a plain
// string leaves the Lambda running with a token that no provider will accept. Read-only
// providers (Motive, Google, Anthropic) keep their real keys.
{
  const SSM_VALUE_PLACEHOLDER = '<value will be resolved during runtime>'
  const DEV_STACK = process.env.BCAT_DEV_STACK === 'true'
  const NEUTERED_SECRETS = ['SLACK_BOT_TOKEN', 'OTR_USERNAME', 'OTR_PASSWORD', 'OTR_SUBSCRIPTION_KEY', 'PAYCHEX_CLIENT_ID', 'PAYCHEX_CLIENT_SECRET', 'BLUE_INK_TECH_API_KEY']
  let envRootStack: Stack = backend.data.stack
  while (envRootStack.nestedStackParent) envRootStack = envRootStack.nestedStackParent
  // Amplify sets AMPLIFY_SSM_ENV_CONFIG to a Lazy token (JSON of {name: {path, sharedPath}})
  // and each secret variable to the placeholder. The rendered environment is only knowable at
  // synth, so an Aspect resolves it then and applies property overrides (which apply after the
  // L2 renders its environment). One Aspect owns both rewrites so the dev pin always wins.
  Aspects.of(envRootStack).add({
    visit(node: IConstruct) {
      if (!(node instanceof CfnFunction)) return
      const rendered = Stack.of(node).resolve(node.environment) as { variables?: Record<string, unknown> } | undefined
      const vars = rendered?.variables ?? {}
      const ssmConfig = vars.AMPLIFY_SSM_ENV_CONFIG
      if (typeof ssmConfig !== 'string') return
      const parsed = JSON.parse(ssmConfig) as Record<string, unknown>
      const neutered = DEV_STACK ? NEUTERED_SECRETS.filter((name) => name in parsed) : []
      for (const name of neutered) {
        delete parsed[name]
        node.addPropertyOverride(`Environment.Variables.${name}`, 'disabled-on-dev')
      }
      for (const name of Object.keys(parsed)) {
        if (vars[name] === SSM_VALUE_PLACEHOLDER) node.addPropertyOverride(`Environment.Variables.${name}`, '')
      }
      if (neutered.length > 0) node.addPropertyOverride('Environment.Variables.AMPLIFY_SSM_ENV_CONFIG', JSON.stringify(parsed))
    },
  })
}
