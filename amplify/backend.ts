import { defineBackend } from '@aws-amplify/backend'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda'
import { CfnOutput } from 'aws-cdk-lib'
import { auth } from './auth/resource'
import { data } from './data/resource'
import { storage } from './storage/resource'
import { userManagement } from './functions/userManagement/resource'
import { slackIntakeWebhook } from './functions/slack-intake-webhook/resource'
import { slackStatusNotifier } from './functions/slack-status-notifier/resource'
import { fuelImport } from './functions/fuel-import/resource'

const backend = defineBackend({
  auth,
  data,
  storage,
  userManagement,
  slackIntakeWebhook,
  slackStatusNotifier,
  fuelImport,
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

// DynamoDB: write new items + query externalId GSI for dedup
backend.slackIntakeWebhook.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions:   ['dynamodb:PutItem', 'dynamodb:Query'],
    resources: [intakeTable.tableArn, `${intakeTable.tableArn}/index/*`],
  })
)

webhookFn.addEnvironment('TABLE_NAME', intakeTable.tableName)
// SLACK_CHANNEL_MAPPING: set this in Amplify Console → Environment variables after deploy
// Format: '{"C12345678":"IVAN_CARTAGE","C87654321":"BCAT_LOGISTICS"}'
webhookFn.addEnvironment('SLACK_CHANNEL_MAPPING', '{}')

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
