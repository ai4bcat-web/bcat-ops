import { defineFunction, secret } from '@aws-amplify/backend'

export const intakeWebhook = defineFunction({
  name: 'intake-webhook',
  entry: './handler.ts',
  // Webhook secret is stored as an Amplify secret (SSM Parameter Store).
  // Set it in Amplify Console → Secrets → INTAKE_WEBHOOK_SECRET before deploying.
  environment: {
    INTAKE_WEBHOOK_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
  },
  // TABLE_NAME, BUCKET_NAME added via addEnvironment() in backend.ts (CDK tokens)
})
