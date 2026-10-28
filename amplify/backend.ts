import { defineBackend } from '@aws-amplify/backend'
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { CfnFunction, Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType, HttpMethod, EventSourceMapping, StartingPosition } from 'aws-cdk-lib/aws-lambda'
import { CfnRule, Rule, Schedule, RuleTargetInput } from 'aws-cdk-lib/aws-events'
import { LambdaFunction as EventsLambdaTarget } from 'aws-cdk-lib/aws-events-targets'
import { ArnFormat, Aspects, CfnOutput, Duration, Stack } from 'aws-cdk-lib'
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
import { storage } from './storage/resource'
import { userManagement } from './functions/userManagement/resource'
import { slackIntakeWebhook } from './functions/slack-intake-webhook/resource'
import { gmailTaskIntake } from './functions/gmail-task-intake/resource'
import { twofaIntake } from './functions/twofa-intake/resource'
import { factoringIntake } from './functions/factoring-intake/resource'
import { vendorApActions } from './functions/vendor-ap-actions/resource'
import { vendorApIntake } from './functions/vendor-ap-intake/resource'
import { vendorApExtract } from './functions/vendor-ap-extract/resource'
import { apptNeedNotifier } from './functions/appt-need-notifier/resource'
import { slackStatusNotifier } from './functions/slack-status-notifier/resource'
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
import { Bucket, HttpMethods } from 'aws-cdk-lib/aws-s3'
import { rateconParser } from './functions/ratecon-parser/resource'
import { apptReport } from './functions/appt-report/resource'
import { cashCheckinReminder } from './functions/cash-checkin-reminder/resource'
import { apptRequestEmailer } from './functions/appt-request-emailer/resource'
import { tmsDirectoryActions } from './functions/tms-directory-actions/resource'
import { tmsShipmentActions } from './functions/tms-shipment-actions/resource'
import { tmsCarrierActions } from './functions/tms-carrier-actions/resource'
import { tmsTrackingActions } from './functions/tms-tracking-actions/resource'
import { tmsFinanceActions } from './functions/tms-finance-actions/resource'
import { loadTrackingProjector } from './functions/load-tracking-projector/resource'
import { shipmentNotifier } from './functions/shipment-notifier/resource'
import { checkCallNotifier } from './functions/check-call-notifier/resource'
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
  twofaIntake,
  factoringIntake,
  vendorApActions,
  vendorApIntake,
  vendorApExtract,
  apptNeedNotifier,
  slackStatusNotifier,
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
  tmsShipmentActions,
  tmsCarrierActions,
  tmsTrackingActions,
  tmsFinanceActions,
  loadTrackingProjector,
  checkCallNotifier,
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

// Welcome email once a driver sets their password. Attached here, beside the
// PRE_SIGN_UP trigger, for the same intra-stack reason documented above.
const driverWelcomeFn = backend.driverWelcome.resources.lambda as LambdaFunction
driverPool.addTrigger(UserPoolOperation.POST_CONFIRMATION, driverWelcomeFn)

driverWelcomeFn.addEnvironment('DRIVER_TABLE_NAME', backend.data.resources.tables['Driver'].tableName)
driverWelcomeFn.addEnvironment('FROM_ADDRESS', 'onboarding@bcatcorp.com')
driverWelcomeFn.addEnvironment('PORTAL_ORIGIN', process.env.PORTAL_PROD_ORIGIN ?? 'https://ops.bcatcorp.com')
driverWelcomeFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan'],
    resources: [backend.data.resources.tables['Driver'].tableArn],
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
    ],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
)

;(backend.userManagement.resources.lambda as LambdaFunction).addEnvironment(
  'USER_POOL_ID',
  backend.auth.resources.userPool.userPoolId
)

// ── driverSignupGate Lambda (driver pool PreSignUp trigger) ────────────────

const signupDriverTable = backend.data.resources.tables['Driver']
const signupDriverPaySettingTable = backend.data.resources.tables['DriverPaySetting']

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

// Allowed portal origins. The prod domain is set via the PORTAL_PROD_ORIGIN env var
// in the Amplify Console (e.g. https://ops.bcatcorp.com); localhost is for dev.
const PORTAL_PROD_ORIGIN = process.env.PORTAL_PROD_ORIGIN ?? 'https://ops.bcatcorp.com'
const PORTAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  PORTAL_PROD_ORIGIN,
  // The dev stack's branch domain (ops-dev.bcatcorp.com) is not in DNS yet, so the
  // only reachable dev origin is Amplify's default branch URL. Without it every
  // public page — the truck link, the rate-con signing page, the customer tracking
  // link — is blocked by CORS on dev and cannot be used or verified there.
  ...(process.env.BCAT_DEV_STACK === 'true' ? ['https://dev.d3dejqzs77khq6.amplifyapp.com'] : []),
]

// ── driver-app-api Lambda (driver PWA HTTP API) ────────────────────────────

const driverApiFn = backend.driverAppApi.resources.lambda as LambdaFunction
const driverSubmissionTable = backend.data.resources.tables['DriverSubmission']
const driverSubmissionDocTable = backend.data.resources.tables['DriverSubmissionDoc']
// Detention times Ivan's drivers record for themselves. Writable by the driver API, which
// is the only thing that writes them.
const driverLoadTimeTable = backend.data.resources.tables['DriverLoadTime']
// The Ivan time clock. Drivers write their own rows; staff correct them from the hours page.
const timeClockTable = backend.data.resources.tables['TimeClockEntry']
const driverApiAmazonTripTable = backend.data.resources.tables['AmazonTrip']
const driverApiDeductionTable = backend.data.resources.tables['DriverPayDeduction']
const driverApiCreditTable = backend.data.resources.tables['DriverPayCredit']
const driverApiFuelTxTable = backend.data.resources.tables['FuelTransaction']
const driverApiDriverTable = backend.data.resources.tables['Driver']
const driverApiPaySettingTable = backend.data.resources.tables['DriverPaySetting']
const driverApiLoadTable = backend.data.resources.tables['Load']
const driverApiCustomerTable = backend.data.resources.tables['Customer']
const driverApiLocationTable = backend.data.resources.tables['Location']
const driverApiPodDocumentTable = backend.data.resources.tables['PodDocument']
// The Ivan app shows a driver when their own truck's next PM falls due. Equipment holds the
// last PM; TruckLocation holds Motive's odometer. Read-only — the app never edits either.
const driverApiEquipmentTable = backend.data.resources.tables['Equipment']
const driverApiTruckLocationTable = backend.data.resources.tables['TruckLocation']
const driverApiMaintenanceTaskTable = backend.data.resources.tables['MaintenanceTask']

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
]

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
// A driver's note about a facility is appended to the directory record (driverNotes only).
driverApiFn.addToRolePolicy(
  new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [driverApiLocationTable.tableArn] }),
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
driverApiFn.addEnvironment('DRIVER_PAY_SETTING_TABLE_NAME', driverApiPaySettingTable.tableName)
driverApiFn.addEnvironment('AMAZON_TRIP_TABLE_NAME', driverApiAmazonTripTable.tableName)
driverApiFn.addEnvironment('LOAD_TABLE_NAME', driverApiLoadTable.tableName)
driverApiFn.addEnvironment('CUSTOMER_TABLE_NAME', driverApiCustomerTable.tableName)
driverApiFn.addEnvironment('LOCATION_TABLE_NAME', driverApiLocationTable.tableName)
driverApiFn.addEnvironment('POD_DOCUMENT_TABLE_NAME', driverApiPodDocumentTable.tableName)
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
driverApiFn.addEnvironment('AUDIT_LOG_TABLE_NAME', backend.data.resources.tables['AuditLog'].tableName)
backend.data.resources.tables['AuditLog'].grantWriteData(driverApiFn)
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

const intakeTable = backend.data.resources.tables['IntakeItem']

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
const loadTableForReport = backend.data.resources.tables['Load']
const customerTableForReport = backend.data.resources.tables['Customer']
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
  description: 'Daily 3 PM Chicago unconfirmed-appointments digest to the global Slack channel',
})
apptReportRule.addTarget(new EventsLambdaTarget(apptReportFn))

// ── cashCheckinReminder (Slack nudge the morning after each biweekly payroll) ──
// Reads the "Last payroll date" + channel from the CashSettings row the Finance page
// edits, and skips when a check-in for that payroll is already logged.
const cashReminderFn = backend.cashCheckinReminder.resources.lambda as LambdaFunction
const cashSettingsTable = backend.data.resources.tables['CashSettings']
const cashCheckInTable = backend.data.resources.tables['CashCheckIn']
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
  description: 'Slack reminder for the weekly cash check-in the morning after each payroll',
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
  description: 'POST tasks@ emails here from the Apps Script (JSON with the shared secret)',
})

// ── twofaIntake Lambda (Google Voice text forwards → Slack #2fa) ───────────
const twofaFn = backend.twofaIntake.resources.lambda as LambdaFunction
// Channel id or name; plain env so a missing value never blocks the deploy (defaults to #2fa).
twofaFn.addEnvironment('TWO_FA_SLACK_CHANNEL', process.env.TWO_FA_SLACK_CHANNEL ?? '#2fa')
const twofaUrl = new FunctionUrl(twofaFn.stack, 'TwofaIntakeUrl', { function: twofaFn, authType: FunctionUrlAuthType.NONE })
new CfnOutput(twofaFn.stack, 'TwofaIntakeFunctionUrl', { value: twofaUrl.url, description: 'POST Google Voice text-forward emails here from the Apps Script (JSON with the shared secret)' })

// ── factoringIntake Lambda (factor@ email → FactoringItem) ──────────────────
const factoringIntakeFn = backend.factoringIntake.resources.lambda as LambdaFunction
const factoringTable = backend.data.resources.tables['FactoringItem']

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
  description: 'POST factor@ emails here from the Gmail bridge (JSON with the shared secret)',
})

// Vendor AP: authenticated payment actions plus secret-authenticated Gmail intake.
const vendorApTable = backend.data.resources.tables['VendorPayable']
const vendorApActionsFn = backend.vendorApActions.resources.lambda as LambdaFunction
const vendorApMaintenanceTable = backend.data.resources.tables['MaintenanceInvoice']
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
// Reads each invoice for vendor / amount / dates; intake hands it the new row's id.
const vendorApExtractFn = backend.vendorApExtract.resources.lambda as LambdaFunction
vendorApExtractFn.addEnvironment('TABLE_NAME', vendorApTable.tableName)
vendorApExtractFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
vendorApExtractFn.addToRolePolicy(new PolicyStatement({
  actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'],
  resources: [vendorApTable.tableArn],
}))
backend.storage.resources.bucket.grantRead(vendorApExtractFn, 'intake-pdfs/vendor-ap/*')
vendorApIntakeFn.addEnvironment('VENDOR_AP_EXTRACT_FUNCTION_NAME', vendorApExtractFn.functionName)
vendorApExtractFn.grantInvoke(vendorApIntakeFn)
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

const dispatchConversationTable = backend.data.resources.tables['DispatchConversation']
const dispatchMessageTable = backend.data.resources.tables['DispatchMessage']
const dispatchSettingsTable = backend.data.resources.tables['DispatchSettings']
const dispatchDriverTable = backend.data.resources.tables['Driver']
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
for (const fn of [dispatchWebhookFn, dispatchActionsFn, dispatchSlackBridgeFn, dispatchNudgeFn, driverApiFn, trackingActionsFn]) {
  fn.addEnvironment('CONVERSATION_TABLE_NAME', dispatchConversationTable.tableName)
  fn.addEnvironment('MESSAGE_TABLE_NAME', dispatchMessageTable.tableName)
  fn.addEnvironment('SETTINGS_TABLE_NAME', dispatchSettingsTable.tableName)
  fn.addEnvironment('DRIVER_TABLE_NAME', dispatchDriverTable.tableName)
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
  const dispatchLoadTable = backend.data.resources.tables['Load']
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

// The five-minute nudge also flags drivers sitting at a stop past two hours
// (amplify/functions/_shared/dwellAlerts.ts): it reads loads and stamps the flagged stop.
{
  const nudgeLoadTable = backend.data.resources.tables['Load']
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
  const rateconLoadTable = backend.data.resources.tables['Load']
  const rateconPayTable = backend.data.resources.tables['DriverPaySetting']
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
const disputeTable = backend.data.resources.tables['AmazonDispute']

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
  description: 'Paste into the Google-Form Apps Script (DISPUTE_WEBHOOK_URL) — see amazon-dispute-intake/APPS_SCRIPT.md',
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

// ── fuelImport Lambda ──────────────────────────────────────────────────────

const fuelImportFn = backend.fuelImport.resources.lambda as LambdaFunction

const fuelTxTable = backend.data.resources.tables['FuelTransaction']
const fuelEquipmentTable = backend.data.resources.tables['Equipment']
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

const expenseTypeTable   = backend.data.resources.tables['ExpenseType']
const allocationTable    = backend.data.resources.tables['TruckExpenseAllocation']
const recurringTable     = backend.data.resources.tables['RecurringExpense']
const expenseRecordTable = backend.data.resources.tables['ExpenseRecord']

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

const truckConfigTable  = backend.data.resources.tables['TruckConfig']
const truckMileageTable = backend.data.resources.tables['TruckMileage']
const equipmentTable    = backend.data.resources.tables['Equipment']

const odometerDayTableForMileage = backend.data.resources.tables['TruckOdometerDay']
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

const truckLocationTable        = backend.data.resources.tables['TruckLocation']
const truckLocationHistoryTable = backend.data.resources.tables['TruckLocationHistory']

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

const truckFaultCodeTable = backend.data.resources.tables['TruckFaultCode']

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

const truckOdometerDayTable = backend.data.resources.tables['TruckOdometerDay']

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
const intakeReconcileTable = backend.data.resources.tables['IntakeItem']
intakeReconcileFn.addEnvironment('INTAKE_TABLE_NAME', intakeReconcileTable.tableName)
intakeReconcileFn.addEnvironment('LOAD_TABLE_NAME', backend.data.resources.tables['Load'].tableName)
intakeReconcileFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
    resources: [
      intakeReconcileTable.tableArn, `${intakeReconcileTable.tableArn}/index/*`,
      backend.data.resources.tables['Load'].tableArn,
      `${backend.data.resources.tables['Load'].tableArn}/index/*`,
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

const complianceDocTable   = backend.data.resources.tables['ComplianceDocument']
const onboardingTaskTable  = backend.data.resources.tables['OnboardingTask']
const complianceAlertTable = backend.data.resources.tables['ComplianceAlert']
const driverTable          = backend.data.resources.tables['Driver']

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

const onboardingInviteTable    = backend.data.resources.tables['OnboardingInvite']
const signatureRequestTable    = backend.data.resources.tables['DocumentSignatureRequest']
const driverApplicationTable   = backend.data.resources.tables['DriverApplication']
const auditLogTable            = backend.data.resources.tables['AuditLog']
const complianceSettingsTable  = backend.data.resources.tables['ComplianceSettings']


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
const disputeTableForPortal = backend.data.resources.tables['AmazonDispute']
const driverTableForPortal = backend.data.resources.tables['Driver']

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

// ── trackingApi Lambda (public truck tracking page) ────────────────────────
const trackingApiFn = backend.trackingApi.resources.lambda as LambdaFunction
backend.trackingApi.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:GetItem'],
    resources: [
      backend.data.resources.tables['Equipment'].tableArn,
      backend.data.resources.tables['TruckLocation'].tableArn,
      backend.data.resources.tables['Driver'].tableArn,
      backend.data.resources.tables['Load'].tableArn,
    ],
  })
)
trackingApiFn.addEnvironment('EQUIPMENT_TABLE_NAME', backend.data.resources.tables['Equipment'].tableName)
trackingApiFn.addEnvironment('TRUCK_LOCATION_TABLE_NAME', backend.data.resources.tables['TruckLocation'].tableName)
trackingApiFn.addEnvironment('DRIVER_TABLE_NAME', backend.data.resources.tables['Driver'].tableName)
trackingApiFn.addEnvironment('LOAD_TABLE_NAME', backend.data.resources.tables['Load'].tableName)
// ── Step D: the shipment Customer Link and the carrier ping link ───────────
// Same public Lambda, three new routes (GET /s/<token>, GET /l/<token>,
// POST /l/<token>/ping). The token IS the TrackingLink row's primary key, so the
// lookup is a GetItem and no index can be walked from outside.
{
  const trackingLinkTable  = backend.data.resources.tables['TrackingLink']
  const loadCheckCallTable = backend.data.resources.tables['LoadCheckCall']
  const trackShipmentTable = backend.data.resources.tables['Shipment']
  const trackOrderTable    = backend.data.resources.tables['Order']
  const trackLoadCarrier   = backend.data.resources.tables['LoadCarrier']
  const trackDivisionTable = backend.data.resources.tables['Division']
  const trackSettingsTable = backend.data.resources.tables['TmsSettings']
  const trackHistoryTable  = backend.data.resources.tables['TruckLocationHistory']
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    // The link row itself: read it, bump its counters, expire it.
    actions:   ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [trackingLinkTable.tableArn],
  }))
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    // A ping writes one event row. Load is deliberately NOT writable from here.
    actions:   ['dynamodb:PutItem'],
    resources: [loadCheckCallTable.tableArn],
  }))
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem'],
    resources: [trackShipmentTable.tableArn, trackDivisionTable.tableArn, trackSettingsTable.tableArn],
  }))
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${loadCheckCallTable.tableArn}/index/*`,
      `${trackOrderTable.tableArn}/index/*`,
      `${trackLoadCarrier.tableArn}/index/*`,
      `${backend.data.resources.tables['Load'].tableArn}/index/*`,
      `${trackHistoryTable.tableArn}/index/*`,
    ],
  }))
  trackingApiFn.addEnvironment('TRACKING_LINK_TABLE_NAME',   trackingLinkTable.tableName)
  trackingApiFn.addEnvironment('LOAD_CHECK_CALL_TABLE_NAME', loadCheckCallTable.tableName)
  trackingApiFn.addEnvironment('SHIPMENT_TABLE_NAME',        trackShipmentTable.tableName)
  trackingApiFn.addEnvironment('ORDER_TABLE_NAME',           trackOrderTable.tableName)
  trackingApiFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',    trackLoadCarrier.tableName)
  trackingApiFn.addEnvironment('DIVISION_TABLE_NAME',        trackDivisionTable.tableName)
  trackingApiFn.addEnvironment('TMS_SETTINGS_TABLE_NAME',    trackSettingsTable.tableName)
  trackingApiFn.addEnvironment('TRUCK_LOCATION_HISTORY_TABLE_NAME', trackHistoryTable.tableName)
  // ── Step E: the carrier upload portal (GET /u/<t>, POST /u/<t>/upload,
  // POST /u/<t>/commit) ─────────────────────────────────────────────────────
  // The public role may Put a ShipmentDocument row and Query the shipment's own
  // documents to render the checklist, and nothing else. There is deliberately no
  // Order, Load, LoadCarrier or Shipment write grant here: a file a carrier sends
  // lands PENDING and influences a billing decision only once a member of staff
  // accepts it from the review queue.
  const trackShipmentDocTable = backend.data.resources.tables['ShipmentDocument']
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:GetItem'],
    resources: [trackShipmentDocTable.tableArn, `${trackShipmentDocTable.tableArn}/index/*`],
  }))
  // The upload view reads the one load and the one assignment the token names,
  // by primary key. Both were Query-on-index only, which is enough for the
  // customer page but not for this one.
  trackingApiFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem'],
    resources: [trackLoadCarrier.tableArn, backend.data.resources.tables['Load'].tableArn],
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
}
const trackingApiUrl = new FunctionUrl(trackingApiFn.stack, 'TrackingApiUrl', {
  function: trackingApiFn,
  authType: FunctionUrlAuthType.NONE,
  // POST is the carrier driver's one-tap location ping; GET is every read page.
  cors: { allowedOrigins: PORTAL_ORIGINS, allowedMethods: [HttpMethod.GET, HttpMethod.POST], allowedHeaders: ['content-type'] },
})
new CfnOutput(trackingApiFn.stack, 'TrackingApiFunctionUrl', { value: trackingApiUrl.url, description: 'Public truck tracking API URL' })

// ── rateConSignApi Lambda (public rate-confirmation signing page) ──────────
// A carrier signs without an account: the emailed link carries a one-time token
// on the LoadCarrier row, and this Lambda is the only thing that can read it.
// Kept OUT of the isolated-preview allowlist further down — it serves a public
// Function URL, so a preview stack must never be able to answer on it.
const rateConSignApiFn      = backend.rateConSignApi.resources.lambda as LambdaFunction
const signLoadCarrierTable  = backend.data.resources.tables['LoadCarrier']
const signLoadTable         = backend.data.resources.tables['Load']
const signCarrierDocTable   = backend.data.resources.tables['CarrierDocument']
const signDivisionTable     = backend.data.resources.tables['Division']
const signSettingsTable     = backend.data.resources.tables['TmsSettings']
const signAuditLogTable     = backend.data.resources.tables['AuditLog']

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
// Signing writes exactly two new rows: the signed-copy CarrierDocument and the
// audit trail of who typed their name into the page.
rateConSignApiFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem'],
    resources: [signCarrierDocTable.tableArn, signAuditLogTable.tableArn],
  })
)
// Reads the unsigned PDF to presign a GET of it, writes the stamped copy back.
backend.storage.resources.bucket.grantReadWrite(rateConSignApiFn, 'rate-confirms/*')

rateConSignApiFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',    signLoadCarrierTable.tableName)
rateConSignApiFn.addEnvironment('LOAD_TABLE_NAME',            signLoadTable.tableName)
rateConSignApiFn.addEnvironment('CARRIER_DOCUMENT_TABLE_NAME', signCarrierDocTable.tableName)
rateConSignApiFn.addEnvironment('DIVISION_TABLE_NAME',        signDivisionTable.tableName)
rateConSignApiFn.addEnvironment('SETTINGS_TABLE_NAME',        signSettingsTable.tableName)
rateConSignApiFn.addEnvironment('AUDIT_LOG_TABLE_NAME',       signAuditLogTable.tableName)
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
emailerFn.addEnvironment('PORTAL_BASE_URL',     PORTAL_PROD_ORIGIN)

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
const driverPayTable = backend.data.resources.tables['DriverPayPeriod']
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

const escalationRuleTable     = backend.data.resources.tables['EscalationRule']
const escalationEmailLogTable = backend.data.resources.tables['EscalationEmailLog']

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
complianceScannerFn.addEnvironment('PORTAL_BASE_URL',     PORTAL_PROD_ORIGIN)

// ── tmsDirectoryActions Lambda ──────────────────────────────────────────────
// Directory, config, and merge writes. Customer/Location/Division/Settings/MergeJob
// tables are written via raw DynamoDB SDK; Load repoints during merge use the
// generated AppSync mutation (allow.resource(tmsDirectoryActions) on Load).
const directoryActionsFn = backend.tmsDirectoryActions.resources.lambda as LambdaFunction
const directoryCustomerTable = backend.data.resources.tables['Customer']
const directoryLocationTable = backend.data.resources.tables['Location']
const directoryDivisionTable = backend.data.resources.tables['Division']
const directorySettingsTable = backend.data.resources.tables['TmsSettings']
const directoryMergeJobTable = backend.data.resources.tables['DirectoryMergeJob']
const directoryLoadTable = backend.data.resources.tables['Load']

const directoryTableArns = [
  directoryCustomerTable.tableArn,
  directoryLocationTable.tableArn,
  directoryDivisionTable.tableArn,
  directorySettingsTable.tableArn,
  directoryMergeJobTable.tableArn,
  directoryLoadTable.tableArn,
]

directoryActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'],
    resources: directoryTableArns,
  }),
)

directoryActionsFn.addEnvironment('TABLE_NAME',                    '')
directoryActionsFn.addEnvironment('CUSTOMER_TABLE_NAME',           directoryCustomerTable.tableName)
directoryActionsFn.addEnvironment('LOCATION_TABLE_NAME',           directoryLocationTable.tableName)
directoryActionsFn.addEnvironment('DIVISION_TABLE_NAME',           directoryDivisionTable.tableName)
directoryActionsFn.addEnvironment('SETTINGS_TABLE_NAME',           directorySettingsTable.tableName)
directoryActionsFn.addEnvironment('MERGE_JOB_TABLE_NAME',          directoryMergeJobTable.tableName)
directoryActionsFn.addEnvironment('LOAD_TABLE_NAME',               directoryLoadTable.tableName)
directoryActionsFn.addEnvironment('USER_POOL_ID',                  backend.auth.resources.userPool.userPoolId)
directoryActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  }),
)

// ── Step E tables, declared once for the four Lambdas that share them ───────
const shipmentDocumentTable  = backend.data.resources.tables['ShipmentDocument']
const shipmentNoticeTable    = backend.data.resources.tables['ShipmentNotice']
// DriverSubmission / DriverSubmissionDoc are already declared for the driver API
// above; ATTACH_DRIVER_DOC only reads them.

// ── tmsShipmentActions Lambda (Step B) ──────────────────────────────────────
// Shipment/Order/LoadCarrier/LoadFinancials/LoadCharge are written with the raw
// SDK (TransactWriteItems keeps the five tables agreeing); Load goes through the
// generated updateLoad mutation (allow.resource(tmsShipmentActions) on the schema)
// so the calendar's subscriptions still fire. Customer/TmsSettings are read-only
// here — their writes stay with tmsDirectoryActions.
const shipmentActionsFn = backend.tmsShipmentActions.resources.lambda as LambdaFunction
const shipmentTable          = backend.data.resources.tables['Shipment']
const orderTable             = backend.data.resources.tables['Order']
const loadCarrierTable       = backend.data.resources.tables['LoadCarrier']
const loadFinancialsTable    = backend.data.resources.tables['LoadFinancials']
const loadChargeTable        = backend.data.resources.tables['LoadCharge']
const shipmentLoadTable      = backend.data.resources.tables['Load']
const shipmentCustomerTable  = backend.data.resources.tables['Customer']
const shipmentSettingsTable  = backend.data.resources.tables['TmsSettings']
const shipmentAuditLogTable  = backend.data.resources.tables['AuditLog']
// The backfill needs the driver roster to tell an own-asset load from one that only
// ever sat on a "Broker Need to Cover" pseudo-driver.
const shipmentDriverTable    = backend.data.resources.tables['Driver']
// Step C: booking reads the directory carrier and its documents, and the rate
// confirmation is printed on the division's letterhead. All read-only here —
// carrier writes belong to tmsCarrierActions.
const shipmentCarrierTable   = backend.data.resources.tables['Carrier']
const shipmentCarrierDocTable = backend.data.resources.tables['CarrierDocument']
const shipmentDivisionTable  = backend.data.resources.tables['Division']

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
      backend.data.resources.tables['LoadCheckCall'].tableArn,
      backend.data.resources.tables['TrackingLink'].tableArn,
    ],
  }),
)
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
      `${backend.data.resources.tables['LoadCheckCall'].tableArn}/index/*`,
      `${backend.data.resources.tables['TrackingLink'].tableArn}/index/*`,
    ],
  }),
)

shipmentActionsFn.addEnvironment('SHIPMENT_TABLE_NAME',        shipmentTable.tableName)
shipmentActionsFn.addEnvironment('ORDER_TABLE_NAME',           orderTable.tableName)
shipmentActionsFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',    loadCarrierTable.tableName)
shipmentActionsFn.addEnvironment('LOAD_FINANCIALS_TABLE_NAME', loadFinancialsTable.tableName)
shipmentActionsFn.addEnvironment('LOAD_CHARGE_TABLE_NAME',     loadChargeTable.tableName)
shipmentActionsFn.addEnvironment('LOAD_TABLE_NAME',            shipmentLoadTable.tableName)
shipmentActionsFn.addEnvironment('CUSTOMER_TABLE_NAME',        shipmentCustomerTable.tableName)
shipmentActionsFn.addEnvironment('SETTINGS_TABLE_NAME',        shipmentSettingsTable.tableName)
shipmentActionsFn.addEnvironment('AUDIT_LOG_TABLE_NAME',       shipmentAuditLogTable.tableName)
shipmentActionsFn.addEnvironment('DRIVER_TABLE_NAME',          shipmentDriverTable.tableName)
shipmentActionsFn.addEnvironment('LOAD_CHECK_CALL_TABLE_NAME', backend.data.resources.tables['LoadCheckCall'].tableName)
shipmentActionsFn.addEnvironment('TRACKING_LINK_TABLE_NAME',   backend.data.resources.tables['TrackingLink'].tableName)
shipmentActionsFn.addEnvironment('USER_POOL_ID',               backend.auth.resources.userPool.userPoolId)
shipmentActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  }),
)

// Step C: BOOK_CARRIER reads the carrier and its paperwork, SEND_RATE_CON
// stores the generated PDF and emails it to the carrier with SES.
shipmentActionsFn.addEnvironment('CARRIER_TABLE_NAME',          shipmentCarrierTable.tableName)
shipmentActionsFn.addEnvironment('CARRIER_DOCUMENT_TABLE_NAME', shipmentCarrierDocTable.tableName)
shipmentActionsFn.addEnvironment('DIVISION_TABLE_NAME',         shipmentDivisionTable.tableName)
shipmentActionsFn.addEnvironment('BUCKET_NAME',                 backend.storage.resources.bucket.bucketName)
shipmentActionsFn.addEnvironment('FROM_ADDRESS',                'ai4bcat@gmail.com')
// The signing link in the email points at the app, not at the Function URL.
shipmentActionsFn.addEnvironment('PORTAL_ORIGIN',               PORTAL_PROD_ORIGIN)
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
      'dynamodb:Query',
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
shipmentActionsFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME',     shipmentDocumentTable.tableName)
shipmentActionsFn.addEnvironment('DRIVER_SUBMISSION_TABLE_NAME',     driverSubmissionTable.tableName)
shipmentActionsFn.addEnvironment('DRIVER_SUBMISSION_DOC_TABLE_NAME', driverSubmissionDocTable.tableName)
backend.storage.resources.bucket.grantReadWrite(shipmentActionsFn, 'shipment-docs/*')

// ── tmsCarrierActions Lambda (Step C) ───────────────────────────────────────
// The carrier directory's single writer: Carrier, CarrierContact,
// CarrierPaymentMethod and CarrierDocument are written with the raw SDK, the
// way tmsDirectoryActions owns Customer and Location. LoadCarrier and Load are
// read-only here — a status change annotates covered loads, it never bounces
// them, and booking itself stays with tmsShipmentActions.
const carrierActionsFn        = backend.tmsCarrierActions.resources.lambda as LambdaFunction
const carrierTable            = backend.data.resources.tables['Carrier']
const carrierContactTable     = backend.data.resources.tables['CarrierContact']
const carrierPaymentTable     = backend.data.resources.tables['CarrierPaymentMethod']
const carrierDocumentTable    = backend.data.resources.tables['CarrierDocument']
const carrierLoadCarrierTable = backend.data.resources.tables['LoadCarrier']
const carrierLoadTable        = backend.data.resources.tables['Load']
const carrierSettingsTable    = backend.data.resources.tables['TmsSettings']
const carrierAuditLogTable    = backend.data.resources.tables['AuditLog']

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

// ── tmsTrackingActions Lambda (Step D) ──────────────────────────────────────
// Owns TrackingLink and everything that carries a link outside the office: the
// carrier-driver ping link (texted from the dispatch number, wired in the dispatch
// loop above) and the per-shipment Customer Link (SES). Check calls themselves
// stay on tmsShipmentActions, which is where Load status and money already live.
// Note SETTINGS_TABLE_NAME was set to DispatchSettings by the dispatch loop, so
// TmsSettings arrives as TMS_SETTINGS_TABLE_NAME here.
const trackingLinkTbl       = backend.data.resources.tables['TrackingLink']
const trackingCheckCallTbl  = backend.data.resources.tables['LoadCheckCall']
const trackingShipmentTbl   = backend.data.resources.tables['Shipment']
const trackingOrderTbl      = backend.data.resources.tables['Order']
const trackingLoadCarrTbl   = backend.data.resources.tables['LoadCarrier']
const trackingLoadTbl       = backend.data.resources.tables['Load']
const trackingCustomerTbl   = backend.data.resources.tables['Customer']
const trackingSettingsTbl   = backend.data.resources.tables['TmsSettings']
const trackingAuditLogTbl   = backend.data.resources.tables['AuditLog']
const trackingDivisionTbl   = backend.data.resources.tables['Division']

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
trackingActionsFn.addEnvironment('TRACKING_LINK_TABLE_NAME',    trackingLinkTbl.tableName)
trackingActionsFn.addEnvironment('LOAD_CHECK_CALL_TABLE_NAME',  trackingCheckCallTbl.tableName)
trackingActionsFn.addEnvironment('SHIPMENT_TABLE_NAME',         trackingShipmentTbl.tableName)
trackingActionsFn.addEnvironment('ORDER_TABLE_NAME',            trackingOrderTbl.tableName)
trackingActionsFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',     trackingLoadCarrTbl.tableName)
trackingActionsFn.addEnvironment('LOAD_TABLE_NAME',             trackingLoadTbl.tableName)
trackingActionsFn.addEnvironment('CUSTOMER_TABLE_NAME',         trackingCustomerTbl.tableName)
trackingActionsFn.addEnvironment('TMS_SETTINGS_TABLE_NAME',     trackingSettingsTbl.tableName)
trackingActionsFn.addEnvironment('AUDIT_LOG_TABLE_NAME',        trackingAuditLogTbl.tableName)
trackingActionsFn.addEnvironment('DIVISION_TABLE_NAME',         trackingDivisionTbl.tableName)
trackingActionsFn.addEnvironment('USER_POOL_ID',                backend.auth.resources.userPool.userPoolId)
trackingActionsFn.addEnvironment('PORTAL_ORIGIN',               PORTAL_PROD_ORIGIN)
trackingActionsFn.addEnvironment('FROM_ADDRESS',                'ai4bcat@gmail.com')
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
trackingActionsFn.addEnvironment('SHIPMENT_NOTICE_TABLE_NAME',   shipmentNoticeTable.tableName)
trackingActionsFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME', shipmentDocumentTable.tableName)
backend.storage.resources.bucket.grantRead(trackingActionsFn, 'shipment-docs/*')
backend.storage.resources.bucket.grantRead(trackingActionsFn, 'driver-docs/*')
backend.storage.resources.bucket.grantRead(trackingActionsFn, 'rate-confirms/*')

// ── tmsFinanceActions Lambda (Step F) ───────────────────────────────────────
// Owns Invoice and ArPayment: the only writer of UNPAID, PAID and every cash row.
// It reads the shipment cluster to take the invoice snapshot, freezes the load's
// financials in the same transaction that issues the bill, renders the PDF itself
// (pdf-lib, in memory) and writes it under invoices/*, e-mails it through the same
// ShipmentNotice log every other outbound document uses, and writes the factoring
// queue row that Send to Factor hands to the existing OTR submit.
const financeActionsFn      = backend.tmsFinanceActions.resources.lambda as LambdaFunction
const invoiceTable          = backend.data.resources.tables['Invoice']
const arPaymentTable        = backend.data.resources.tables['ArPayment']
const financeOrderTable     = backend.data.resources.tables['Order']
const financeShipmentTable  = backend.data.resources.tables['Shipment']
const financeLoadTable      = backend.data.resources.tables['Load']
const financeLoadCarrierTbl = backend.data.resources.tables['LoadCarrier']
const financeFinancialsTbl  = backend.data.resources.tables['LoadFinancials']
const financeChargeTable    = backend.data.resources.tables['LoadCharge']
const financeCustomerTable  = backend.data.resources.tables['Customer']
const financeDivisionTable  = backend.data.resources.tables['Division']
const financeSettingsTable  = backend.data.resources.tables['TmsSettings']
const financeAuditLogTable  = backend.data.resources.tables['AuditLog']
const financeFactoringTable = backend.data.resources.tables['FactoringItem']
// Step G (AP): the bill ledger, the payment ledger and the carrier directory rows a
// bill's payee snapshot is taken from.
const carrierBillTable      = backend.data.resources.tables['CarrierBill']
const apPaymentTable        = backend.data.resources.tables['ApPayment']
const financeCarrierTable   = backend.data.resources.tables['Carrier']
const financeCarrierPayTbl  = backend.data.resources.tables['CarrierPaymentMethod']
const financeCarrierCntTbl  = backend.data.resources.tables['CarrierContact']

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
      financeDivisionTable.tableArn,
      shipmentDocumentTable.tableArn,
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
    ],
  })
)
financeActionsFn.addEnvironment('INVOICE_TABLE_NAME',            invoiceTable.tableName)
financeActionsFn.addEnvironment('AR_PAYMENT_TABLE_NAME',         arPaymentTable.tableName)
financeActionsFn.addEnvironment('ORDER_TABLE_NAME',              financeOrderTable.tableName)
financeActionsFn.addEnvironment('SHIPMENT_TABLE_NAME',           financeShipmentTable.tableName)
financeActionsFn.addEnvironment('LOAD_TABLE_NAME',               financeLoadTable.tableName)
financeActionsFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',       financeLoadCarrierTbl.tableName)
financeActionsFn.addEnvironment('LOAD_FINANCIALS_TABLE_NAME',    financeFinancialsTbl.tableName)
financeActionsFn.addEnvironment('LOAD_CHARGE_TABLE_NAME',        financeChargeTable.tableName)
financeActionsFn.addEnvironment('CUSTOMER_TABLE_NAME',           financeCustomerTable.tableName)
financeActionsFn.addEnvironment('DIVISION_TABLE_NAME',           financeDivisionTable.tableName)
financeActionsFn.addEnvironment('SETTINGS_TABLE_NAME',           financeSettingsTable.tableName)
financeActionsFn.addEnvironment('AUDIT_LOG_TABLE_NAME',          financeAuditLogTable.tableName)
financeActionsFn.addEnvironment('FACTORING_ITEM_TABLE_NAME',     financeFactoringTable.tableName)
financeActionsFn.addEnvironment('CARRIER_BILL_TABLE_NAME',       carrierBillTable.tableName)
financeActionsFn.addEnvironment('AP_PAYMENT_TABLE_NAME',         apPaymentTable.tableName)
financeActionsFn.addEnvironment('CARRIER_TABLE_NAME',            financeCarrierTable.tableName)
financeActionsFn.addEnvironment('CARRIER_PAYMENT_METHOD_TABLE_NAME', financeCarrierPayTbl.tableName)
financeActionsFn.addEnvironment('CARRIER_CONTACT_TABLE_NAME',    financeCarrierCntTbl.tableName)
financeActionsFn.addEnvironment('SHIPMENT_DOCUMENT_TABLE_NAME',  shipmentDocumentTable.tableName)
financeActionsFn.addEnvironment('SHIPMENT_NOTICE_TABLE_NAME',    shipmentNoticeTable.tableName)
financeActionsFn.addEnvironment('BUCKET_NAME',                   backend.storage.resources.bucket.bucketName)
financeActionsFn.addEnvironment('USER_POOL_ID',                  backend.auth.resources.userPool.userPoolId)
financeActionsFn.addEnvironment('PORTAL_ORIGIN',                 PORTAL_PROD_ORIGIN)
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

// ── brokerLoadAlert Lambda (Load stream → broker task + global Slack ping) ──
// Fires when a load is assigned to the "Broker Need to Cover" driver: creates an
// IntakeItem task for Arcie and posts to the BCAT global Slack channel.

const brokerAlertFn = backend.brokerLoadAlert.resources.lambda as LambdaFunction
const loadTable     = backend.data.resources.tables['Load']

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
  // Writes: Load (status), LoadCheckCall (the stop event), Shipment (rederive).
  // BatchGetItem is what readBundle uses to collect LoadFinancials by load id —
  // without it rederiveShipmentStatus dies after the Load row has already moved.
  projectorFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
    resources: [loadTable.tableArn, trackingCheckCallTbl.tableArn, trackingShipmentTbl.tableArn],
  }))
  // Read-only: the bundle's other halves and the driver roster.
  projectorFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan'],
    resources: [
      trackingOrderTbl.tableArn,
      trackingLoadCarrTbl.tableArn,
      backend.data.resources.tables['LoadFinancials'].tableArn,
      backend.data.resources.tables['LoadCharge'].tableArn,
      backend.data.resources.tables['Driver'].tableArn,
    ],
  }))
  projectorFn.addToRolePolicy(new PolicyStatement({
    actions:   ['dynamodb:Query'],
    resources: [
      `${loadTable.tableArn}/index/*`,
      `${trackingCheckCallTbl.tableArn}/index/*`,
      `${trackingOrderTbl.tableArn}/index/*`,
      `${trackingLoadCarrTbl.tableArn}/index/*`,
      `${backend.data.resources.tables['LoadCharge'].tableArn}/index/*`,
    ],
  }))
  projectorFn.addEnvironment('LOAD_TABLE_NAME',            loadTable.tableName)
  projectorFn.addEnvironment('LOAD_CHECK_CALL_TABLE_NAME', trackingCheckCallTbl.tableName)
  projectorFn.addEnvironment('SHIPMENT_TABLE_NAME',        trackingShipmentTbl.tableName)
  projectorFn.addEnvironment('ORDER_TABLE_NAME',           trackingOrderTbl.tableName)
  projectorFn.addEnvironment('LOAD_CARRIER_TABLE_NAME',    trackingLoadCarrTbl.tableName)
  projectorFn.addEnvironment('LOAD_FINANCIALS_TABLE_NAME', backend.data.resources.tables['LoadFinancials'].tableName)
  projectorFn.addEnvironment('LOAD_CHARGE_TABLE_NAME',     backend.data.resources.tables['LoadCharge'].tableName)
  projectorFn.addEnvironment('DRIVER_TABLE_NAME',          backend.data.resources.tables['Driver'].tableName)
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
  notifyFn.addEnvironment('PORTAL_ORIGIN',               PORTAL_PROD_ORIGIN)
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

// ── podActions Lambda (JobsDone PODs) ──────────────────────────────────────
// Custom AppSync router for JobsDone POD imports. All access is enforced here;
// the PodDocument model only allows this Lambda. Configuration is stored in a
// stack-specific SSM SecureString parameter under /bcat/pods/<userPoolId>/connection.

const podActionsFn = backend.podActions.resources.lambda as LambdaFunction
const podDocumentTable = backend.data.resources.tables['PodDocument']
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

const podSenderMappingTable = backend.data.resources.tables['PodSenderMapping']

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
  ]) {
    (rule.node.defaultChild as CfnRule).state = 'DISABLED'
  }

  const previewCallable = new Set(['userManagement', 'vendorApActions', 'tmsDirectoryActions', 'tmsShipmentActions', 'tmsCarrierActions', 'tmsTrackingActions', 'tmsFinanceActions', 'tmsGeocode', 'podActions'])
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

const otrFactoringTable = backend.data.resources.tables['FactoringItem']
const otrLoadTable = backend.data.resources.tables['Load']
const otrCustomerTable = backend.data.resources.tables['Customer']
const otrLocationTable = backend.data.resources.tables['Location']
const otrPodTable = backend.data.resources.tables['PodDocument']
// A POD can also arrive as a driver scan or a staff upload, which land in
// DriverSubmissionDoc rather than PodDocument. Submit has to see both, or a POD someone
// watched reach Slack is invisible to the thing that invoices it.
const otrSubmissionTable = backend.data.resources.tables['DriverSubmission']
const otrSubmissionDocTable = backend.data.resources.tables['DriverSubmissionDoc']

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
// Every Lambda is denied SES. Slack, OTR, Paychex and Blue Ink are
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
    if (construct instanceof CfnRule) construct.state = 'DISABLED'
  }
  // Secrets that reach a third party with side effects are replaced by a placeholder on
  // dev. Amplify resolves `secret()` values at cold start from the SSM paths listed in
  // AMPLIFY_SSM_ENV_CONFIG; dropping a name from that list and setting the variable to a
  // plain string leaves the Lambda running with a token that no provider will accept.
  // Read-only providers (Motive, Google, Anthropic) keep their real keys.
  const NEUTERED_SECRETS = ['SLACK_BOT_TOKEN', 'OTR_USERNAME', 'OTR_PASSWORD', 'OTR_SUBSCRIPTION_KEY', 'PAYCHEX_CLIENT_ID', 'PAYCHEX_CLIENT_SECRET', 'BLUE_INK_TECH_API_KEY']
  for (const construct of Object.values(backend)) {
    const lambda = (construct as { resources?: { lambda?: LambdaFunction } }).resources?.lambda
    if (!lambda) continue
    lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ['ses:*'], resources: ['*'] }))
    lambda.addEnvironment('BCAT_DEV_STACK', 'true')
  }
  // Amplify sets AMPLIFY_SSM_ENV_CONFIG to a Lazy token (JSON of {name: {path, sharedPath}})
  // and each secret variable to a placeholder that its runtime shim replaces from SSM. The
  // rendered environment is only knowable at synth, so an Aspect resolves it then, drops the
  // neutered names from the SSM config and pins those variables to a placeholder string
  // through property overrides (which apply after the L2 renders its environment).
  Aspects.of(devRootStack).add({
    visit(node: IConstruct) {
      if (!(node instanceof CfnFunction)) return
      const rendered = Stack.of(node).resolve(node.environment) as { variables?: Record<string, unknown> } | undefined
      const vars = rendered?.variables ?? {}
      const ssmConfig = vars.AMPLIFY_SSM_ENV_CONFIG
      if (typeof ssmConfig !== 'string') return
      const parsed = JSON.parse(ssmConfig) as Record<string, unknown>
      const removed = NEUTERED_SECRETS.filter((name) => name in parsed)
      if (removed.length === 0) return
      for (const name of removed) {
        delete parsed[name]
        node.addPropertyOverride(`Environment.Variables.${name}`, 'disabled-on-dev')
      }
      node.addPropertyOverride('Environment.Variables.AMPLIFY_SSM_ENV_CONFIG', JSON.stringify(parsed))
    },
  })
}
