import { defineFunction, secret } from '@aws-amplify/backend'

export const slackIntakeWebhook = defineFunction({
  name: 'slack-intake-webhook',
  entry: './handler.ts',
  resourceGroupName: 'data',
  environment: {
    SLACK_SIGNING_SECRET:  secret('SLACK_SIGNING_SECRET'),
    // JSON mapping Slack channel IDs → source enum
    // e.g. '{"C12345678":"IVAN_CARTAGE","C87654321":"BCAT_LOGISTICS"}'
    // Set via: npx ampx secret set SLACK_CHANNEL_MAPPING  (or Amplify Console → Secrets)
    SLACK_CHANNEL_MAPPING: secret('SLACK_CHANNEL_MAPPING'),
  },
  // TABLE_NAME added via addEnvironment() in backend.ts
})
