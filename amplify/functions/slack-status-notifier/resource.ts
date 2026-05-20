import { defineFunction, secret } from '@aws-amplify/backend'

export const slackStatusNotifier = defineFunction({
  name: 'slack-status-notifier',
  entry: './handler.ts',
  resourceGroupName: 'data',
  environment: {
    // Set SLACK_BOT_TOKEN in Amplify Console → Secrets before deploying.
    // The bot needs chat:write scope to post threaded replies.
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
