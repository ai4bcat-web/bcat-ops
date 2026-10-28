import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * broker-load-alert Lambda
 *
 * Triggered by the Load table's DynamoDB stream. When a load gets assigned to the
 * "Broker Need to Cover" driver, it creates an IntakeItem task (assigned to Arcie)
 * and posts a heads-up to the BCAT global Slack channel.
 *
 * SLACK_GLOBAL_CHANNEL_ID + BROKER_* knobs are plain env vars set in backend.ts so a
 * missing channel never blocks the deploy (the Slack post is simply skipped until set).
 */
export const brokerLoadAlert = defineFunction({
  name: 'broker-load-alert',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // Slack bot token (chat:write) — same secret the status notifier + gmail intake use.
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
