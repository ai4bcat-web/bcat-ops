import { defineBackend } from '@aws-amplify/backend'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda'
import { CfnOutput } from 'aws-cdk-lib'
import { auth } from './auth/resource'
import { data } from './data/resource'
import { storage } from './storage/resource'
import { userManagement } from './functions/userManagement/resource'
import { intakeWebhook } from './functions/intake-webhook/resource'
import { fuelImport } from './functions/fuel-import/resource'

const backend = defineBackend({ auth, data, storage, userManagement, intakeWebhook, fuelImport })

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

// ── intakeWebhook Lambda ───────────────────────────────────────────────────

const webhookFn = backend.intakeWebhook.resources.lambda as LambdaFunction

// DynamoDB: read + write to the IntakeItem table (for dedup scan and PutItem)
const intakeTable = backend.data.resources.tables['IntakeItem']
backend.intakeWebhook.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:PutItem', 'dynamodb:Query'],
    resources: [intakeTable.tableArn],
  })
)

// S3: write intake PDFs to the existing rate-confirms bucket
const bucketArn = backend.storage.resources.bucket.bucketArn
backend.intakeWebhook.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:PutObject'],
    resources: [`${bucketArn}/intake-pdfs/*`],
  })
)

// Environment variables (CDK tokens resolve at synthesis time)
webhookFn.addEnvironment('TABLE_NAME',  intakeTable.tableName)
webhookFn.addEnvironment('BUCKET_NAME', backend.storage.resources.bucket.bucketName)

// Function URL — auth NONE, secret enforced in handler
const fnUrl = new FunctionUrl(webhookFn.stack, 'IntakeWebhookUrl', {
  function: webhookFn,
  authType: FunctionUrlAuthType.NONE,
})

// Expose URL in CloudFormation outputs so it's easy to find after deploy
new CfnOutput(webhookFn.stack, 'IntakeWebhookFunctionUrl', {
  value: fnUrl.url,
  description: 'Paste into SETUP.md → WEBHOOK_URL and Apps Script WEBHOOK_URL',
})

// ── fuelImport Lambda ──────────────────────────────────────────────────────

const fuelImportFn = backend.fuelImport.resources.lambda as LambdaFunction

// DynamoDB: read + write FuelTransaction table
const fuelTxTable = backend.data.resources.tables['FuelTransaction']
backend.fuelImport.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan', 'dynamodb:PutItem'],
    resources: [fuelTxTable.tableArn],
  })
)

fuelImportFn.addEnvironment('FUEL_TX_TABLE_NAME', fuelTxTable.tableName)

// Function URL — same auth pattern as intake-webhook (secret enforced in handler)
const fuelImportUrl = new FunctionUrl(fuelImportFn.stack, 'FuelImportFunctionUrl', {
  function: fuelImportFn,
  authType: FunctionUrlAuthType.NONE,
})

new CfnOutput(fuelImportFn.stack, 'FuelImportFunctionUrlOutput', {
  value: fuelImportUrl.url,
  description: 'Paste into SETUP.md → FUEL_IMPORT_WEBHOOK_URL and Apps Script FUEL_IMPORT_WEBHOOK_URL',
})
