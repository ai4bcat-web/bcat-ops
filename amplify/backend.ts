import { defineBackend } from '@aws-amplify/backend'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType, HttpMethod, EventSourceMapping, StartingPosition } from 'aws-cdk-lib/aws-lambda'
import { Rule, Schedule, RuleTargetInput } from 'aws-cdk-lib/aws-events'
import { LambdaFunction as EventsLambdaTarget } from 'aws-cdk-lib/aws-events-targets'
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib'
import { auth } from './auth/resource'
import { data } from './data/resource'
import { storage } from './storage/resource'
import { userManagement } from './functions/userManagement/resource'
import { slackIntakeWebhook } from './functions/slack-intake-webhook/resource'
import { gmailTaskIntake } from './functions/gmail-task-intake/resource'
import { slackStatusNotifier } from './functions/slack-status-notifier/resource'
import { fuelImport } from './functions/fuel-import/resource'
import { generateRecurringExpenses } from './functions/generate-recurring-expenses/resource'
import { motiveMileageSync } from './functions/motive-mileage-sync/resource'
import { motiveLocationSync } from './functions/motive-location-sync/resource'
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

const backend = defineBackend({
  auth,
  data,
  storage,
  userManagement,
  slackIntakeWebhook,
  gmailTaskIntake,
  slackStatusNotifier,
  fuelImport,
  generateRecurringExpenses,
  motiveMileageSync,
  blueinkSync,
  motiveLocationSync,
  complianceScanner,
  onboardingPortalApi,
  onboardingEmailer,
  driverPayEmailer,
  vehicleQuoteEmailer,
  googleReviews,
  paychexPaySync,
  brokerLoadAlert,
  amazonDisputeIntake,
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

const gmailTaskUrl = new FunctionUrl(gmailTaskFn.stack, 'GmailTaskIntakeUrl', {
  function: gmailTaskFn,
  authType: FunctionUrlAuthType.NONE,
})

new CfnOutput(gmailTaskFn.stack, 'GmailTaskIntakeFunctionUrl', {
  value:       gmailTaskUrl.url,
  description: 'POST tasks@ emails here from the Apps Script (JSON with the shared secret)',
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
const driverApplicationTable   = backend.data.resources.tables['DriverApplication']
const auditLogTable            = backend.data.resources.tables['AuditLog']
const complianceSettingsTable  = backend.data.resources.tables['ComplianceSettings']

// Allowed portal origins. The prod domain is set via the PORTAL_PROD_ORIGIN env var
// in the Amplify Console (e.g. https://ops.bcatcorp.com); localhost is for dev.
const PORTAL_PROD_ORIGIN = process.env.PORTAL_PROD_ORIGIN ?? 'https://ops.bcatcorp.com'
const PORTAL_ORIGINS = ['http://localhost:5173', PORTAL_PROD_ORIGIN]

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
    ],
  })
)
// Presigned PUT uploads land under compliance/* in the documents bucket.
backend.storage.resources.bucket.grantPut(portalApiFn, 'compliance/*')

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
quoteEmailerFn.addEnvironment('BCC_ADDRESS',  process.env.QUOTE_BCC_ADDRESS ?? 'cars@bcatcorp.com')

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
emailerFn.addEnvironment('FROM_ADDRESS',        'onboarding@bcatcorp.com')

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
})
