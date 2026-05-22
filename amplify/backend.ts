import { defineBackend } from '@aws-amplify/backend'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda'
import { Rule, Schedule } from 'aws-cdk-lib/aws-events'
import { LambdaFunction as EventsLambdaTarget } from 'aws-cdk-lib/aws-events-targets'
import { CfnOutput } from 'aws-cdk-lib'
import { auth } from './auth/resource'
import { data } from './data/resource'
import { storage } from './storage/resource'
import { userManagement } from './functions/userManagement/resource'
import { slackIntakeWebhook } from './functions/slack-intake-webhook/resource'
import { slackStatusNotifier } from './functions/slack-status-notifier/resource'
import { fuelImport } from './functions/fuel-import/resource'
import { generateRecurringExpenses } from './functions/generate-recurring-expenses/resource'
import { motiveMileageSync } from './functions/motive-mileage-sync/resource'

const backend = defineBackend({
  auth,
  data,
  storage,
  userManagement,
  slackIntakeWebhook,
  slackStatusNotifier,
  fuelImport,
  generateRecurringExpenses,
  motiveMileageSync,
})

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
backend.fuelImport.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem'],
    resources: [fuelTxTable.tableArn],
  })
)

fuelImportFn.addEnvironment('FUEL_TX_TABLE_NAME', fuelTxTable.tableName)

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

backend.motiveMileageSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [
      truckConfigTable.tableArn,
      truckMileageTable.tableArn,
    ],
  })
)

motiveFn.addEnvironment('TRUCK_CONFIG_TABLE_NAME',  truckConfigTable.tableName)
motiveFn.addEnvironment('TRUCK_MILEAGE_TABLE_NAME', truckMileageTable.tableName)

// EventBridge daily cron — 02:05 UTC every day
const dailyMileageRule = new Rule(motiveFn.stack, 'MotiveMileageDailySyncRule', {
  schedule:    Schedule.cron({ minute: '5', hour: '2', day: '*', month: '*' }),
  description: 'Sync Motive ELD mileage for COMPANY trucks daily',
})
dailyMileageRule.addTarget(new EventsLambdaTarget(motiveFn))
