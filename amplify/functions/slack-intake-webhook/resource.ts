import { defineFunction, secret } from '@aws-amplify/backend'

export const slackIntakeWebhook = defineFunction({
  name: 'slack-intake-webhook',
  entry: './handler.ts',
  resourceGroupName: 'data',
  environment: {
    // Set SLACK_SIGNING_SECRET in Amplify Console → Secrets before deploying
    SLACK_SIGNING_SECRET: secret('SLACK_SIGNING_SECRET'),
  },
  // TABLE_NAME and SLACK_CHANNEL_MAPPING added via addEnvironment() in backend.ts
})
