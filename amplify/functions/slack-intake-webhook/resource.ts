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
    // Needed to download a file off a Slack message: url_private is not public, it is
    // fetched with the bot's own token.
    SLACK_BOT_TOKEN:       secret('SLACK_BOT_TOKEN'),
  },
  /*
   * Slack retries a webhook it considers slow, and downloading a rate confirmation takes
   * longer than answering an event does. The retry is harmless — the item write is keyed on
   * the Slack message id and a duplicate is rejected — but a longer budget avoids provoking
   * one in the first place.
   */
  timeoutSeconds: 30,
  // TABLE_NAME added via addEnvironment() in backend.ts
})
