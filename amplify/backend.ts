import { defineBackend } from '@aws-amplify/backend'
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { CfnFunction, Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType, HttpMethod, EventSourceMapping, StartingPosition } from 'aws-cdk-lib/aws-lambda'
import { CfnRule, Rule, Schedule, RuleTargetInput } from 'aws-cdk-lib/aws-events'
import { LambdaFunction as EventsLambdaTarget } from 'aws-cdk-lib/aws-events-targets'
import { ArnFormat, CfnOutput, Duration, Stack } from 'aws-cdk-lib'
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
import { factoringIntake } from './functions/factoring-intake/resource'
import { vendorApActions } from './functions/vendor-ap-actions/resource'
import { vendorApIntake } from './functions/vendor-ap-intake/resource'
import { apptNeedNotifier } from './functions/appt-need-notifier/resource'
import { slackStatusNotifier } from './functions/slack-status-notifier/resource'
import { fuelImport } from './functions/fuel-import/resource'
import { generateRecurringExpenses } from './functions/generate-recurring-expenses/resource'
import { motiveMileageSync } from './functions/motive-mileage-sync/resource'
import { motiveOdometerSync } from './functions/motive-odometer-sync/resource'
import { motiveLocationSync } from './functions/motive-location-sync/resource'
import { motiveFaultSync } from './functions/motive-fault-sync/resource'
import { blueinkSync } from './functions/blueink-sync/resource'
import { complianceScanner } from './functions/compliance-scanner/resource'
import { onboardingPortalApi } from './functions/onboarding-portal-api/resource'
import { onboardingEmailer } from './functions/onboarding-emailer/resource'
import { driverPayEmailer } from './functions/driver-pay-emailer/resource'
import { vehicleQuoteEmailer } from './functions/vehicle-quote-emailer/resource'
import { googleReviews } from './functions/google-reviews/resource'
import { paychexPaySync } from './functions/paychex-pay-sync/resource'
import { brokerLoadAlert } from './functions/broker-load-alert/resource'
import { amazonDisputeIntake } from './functions/amazon-dispute-intake/resource'
import { disputePortalApi } from './functions/dispute-portal-api/resource'
import { tripScreenshotParser } from './functions/trip-screenshot-parser/resource'
import { Bucket, HttpMethods } from 'aws-cdk-lib/aws-s3'
import { rateconParser } from './functions/ratecon-parser/resource'
import { apptReport } from './functions/appt-report/resource'
import { cashCheckinReminder } from './functions/cash-checkin-reminder/resource'
import { apptRequestEmailer } from './functions/appt-request-emailer/resource'
import { tmsDirectoryActions } from './functions/tms-directory-actions/resource'
import { tmsGeocode } from './functions/tms-geocode/resource'
import { podActions } from './functions/pod-actions/resource'
import { otrActions, otrStatusSync } from './functions/otr-actions/resource'
import { driverSignupGate } from './functions/driver-signup-gate/resource'
import { driverWelcome } from './functions/driver-welcome/resource'
import { driverAppApi } from './functions/driver-app-api/resource'
import { configurePodScanner } from './podScanner.js'

const backend = defineBackend({
  auth,
  data,
  storage,
  userManagement,
  slackIntakeWebhook,
  gmailTaskIntake,
  factoringIntake,
  vendorApActions,
  vendorApIntake,
  apptNeedNotifier,
  slackStatusNotifier,
  fuelImport,
  generateRecurringExpenses,
  motiveMileageSync,
  motiveOdometerSync,
  blueinkSync,
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
  rateconParser,
  apptReport,
  cashCheckinReminder,
  apptRequestEmailer,
  amazonDisputeIntake,
  disputePortalApi,
  tripScreenshotParser,
  tmsDirectoryActions,
  tmsGeocode,
  podActions,
  driverSignupGate,
  driverWelcome,
  driverAppApi,
  otrActions,
  otrStatusSync,
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
  refreshTokenValidity: Duration.days(60),
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
]

// ── driver-app-api Lambda (driver PWA HTTP API) ────────────────────────────

const driverApiFn = backend.driverAppApi.resources.lambda as LambdaFunction
const driverSubmissionTable = backend.data.resources.tables['DriverSubmission']
const driverSubmissionDocTable = backend.data.resources.tables['DriverSubmissionDoc']
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
]

const driverApiWritableArns = [
  driverSubmissionTable.tableArn,
  `${driverSubmissionTable.tableArn}/index/*`,
  driverSubmissionDocTable.tableArn,
  `${driverSubmissionDocTable.tableArn}/index/*`,
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
driverApiFn.addEnvironment('DRIVER_PAY_SETTING_TABLE_NAME', driverApiPaySettingTable.tableName)
driverApiFn.addEnvironment('AMAZON_TRIP_TABLE_NAME', driverApiAmazonTripTable.tableName)
driverApiFn.addEnvironment('LOAD_TABLE_NAME', driverApiLoadTable.tableName)
driverApiFn.addEnvironment('CUSTOMER_TABLE_NAME', driverApiCustomerTable.tableName)
driverApiFn.addEnvironment('LOCATION_TABLE_NAME', driverApiLocationTable.tableName)
driverApiFn.addEnvironment('POD_DOCUMENT_TABLE_NAME', driverApiPodDocumentTable.tableName)
driverApiFn.addEnvironment('DRIVER_PAY_DEDUCTION_TABLE_NAME', driverApiDeductionTable.tableName)
driverApiFn.addEnvironment('DRIVER_PAY_CREDIT_TABLE_NAME', driverApiCreditTable.tableName)
driverApiFn.addEnvironment('FUEL_TRANSACTION_TABLE_NAME', driverApiFuelTxTable.tableName)
driverApiFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)
driverApiFn.addEnvironment('DRIVER_USER_POOL_ID', driverPool.userPoolId)
driverApiFn.addEnvironment('DRIVER_USER_POOL_CLIENT_ID', driverPoolClient.userPoolClientId)
// Plain env vars (not secrets) so a missing value never blocks the deploy.
driverApiFn.addEnvironment('INTAKE_IVAN_CHANNEL_ID', process.env.INTAKE_IVAN_CHANNEL_ID ?? 'C0B4YJXLYM8')
driverApiFn.addEnvironment('LOADS_EMAIL_TO', process.env.LOADS_EMAIL_TO ?? 'ivanloads@bcatcorp.com')
driverApiFn.addEnvironment('SES_FROM_ADDRESS', process.env.SES_FROM_ADDRESS ?? 'onboarding@bcatcorp.com')

// Function URL — drivers call this directly from the PWA; JWT verification is handled in the Lambda.
const driverApiUrl = new FunctionUrl(driverApiFn.stack, 'DriverAppApiUrl', {
  function: driverApiFn,
  authType: FunctionUrlAuthType.NONE,
  cors: {
    // Same origin allowlist the other portals use — the PWA is served from the app itself.
    allowedOrigins: PORTAL_ORIGINS,
    allowedMethods: [HttpMethod.GET, HttpMethod.POST],
    allowedHeaders: ['content-type', 'authorization'],
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
const vendorApIntakeUrl = new FunctionUrl(vendorApIntakeFn.stack, 'VendorApIntakeUrl', {
  function: vendorApIntakeFn,
  authType: FunctionUrlAuthType.NONE,
})
new CfnOutput(vendorApIntakeFn.stack, 'VendorApIntakeFunctionUrl', {
  value: vendorApIntakeUrl.url,
  description: 'Vendor AP Gmail bridge webhook; requires the shared intake secret',
})

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

backend.motiveMileageSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem'],
    resources: [
      equipmentTable.tableArn,
      truckMileageTable.tableArn,
    ],
  })
)

motiveFn.addEnvironment('EQUIPMENT_TABLE_NAME',     equipmentTable.tableName)
motiveFn.addEnvironment('TRUCK_MILEAGE_TABLE_NAME', truckMileageTable.tableName)

// EventBridge daily cron — 02:05 UTC every day
const dailyMileageRule = new Rule(motiveFn.stack, 'MotiveMileageDailySyncRule', {
  schedule:    Schedule.cron({ minute: '5', hour: '2', day: '*', month: '*' }),
  description: 'Sync Motive ELD mileage for every Motive vehicle daily',
})
dailyMileageRule.addTarget(new EventsLambdaTarget(motiveFn))

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

backend.addOutput({
  custom: {
    disputePortalUrl: disputePortalApiUrl.url,
    driverUserPoolId: driverPool.userPoolId,
    driverUserPoolClientId: driverPoolClient.userPoolClientId,
    driverApiUrl: driverApiUrl.url,
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
  enabled:           process.env.BCAT_ISOLATED_PREVIEW !== 'true',   // see the guard below
})

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
podActionsFn.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId)

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
podActionsFn.addToRolePolicy(
  new PolicyStatement({
    actions:   ['cognito-idp:AdminGetUser'],
    resources: [backend.auth.resources.userPool.userPoolArn],
  }),
)

backend.storage.resources.bucket.grantPut(podActionsFn, 'pods/*')
backend.storage.resources.bucket.grantRead(podActionsFn, 'pods/*')

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

// Background ingestion: every 15 minutes walk the last 7 days of the JobsDone feed
// (each tick walks every page because JobsDone's cursor is not time-ordered). This
// rule is deliberately NOT disabled under BCAT_ISOLATED_PREVIEW: it only reads
// JobsDone and writes this stack's own tables, the same reasoning that keeps
// podActions callable there, and "new images keep arriving" cannot be verified
// on a preview stack otherwise.
const podBackgroundSyncRule = new Rule(podActionsFn.stack, 'PodBackgroundSyncRule', {
  schedule:    Schedule.rate(Duration.minutes(15)),
  description: 'JobsDone PODs: import and scan the last 7 days every 15 minutes',
})
podBackgroundSyncRule.addTarget(new EventsLambdaTarget(podActionsFn, {
  event: RuleTargetInput.fromObject({ action: 'backfillSchedule' }),
}))
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

  const previewCallable = new Set(['userManagement', 'vendorApActions', 'tmsDirectoryActions', 'tmsGeocode', 'podActions'])
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
const OTR_BASE_URL = 'https://servicesstg.otrsolutions.com/CarrierTmsV3'

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
}

otrActionsFn.addEnvironment('LOAD_TABLE_NAME', otrLoadTable.tableName)
otrActionsFn.addEnvironment('CUSTOMER_TABLE_NAME', otrCustomerTable.tableName)
otrActionsFn.addEnvironment('LOCATION_TABLE_NAME', otrLocationTable.tableName)
otrActionsFn.addEnvironment('POD_DOCUMENT_TABLE_NAME', otrPodTable.tableName)
otrActionsFn.addEnvironment('DRIVER_SUBMISSION_TABLE_NAME', otrSubmissionTable.tableName)
otrActionsFn.addEnvironment('DRIVER_SUBMISSION_DOC_TABLE_NAME', otrSubmissionDocTable.tableName)
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

// Locations, PODs and driver submissions are read-only here.
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
