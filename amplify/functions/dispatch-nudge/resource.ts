import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Every five minutes: find driver texts nobody has answered and DM the dispatcher on
 * Slack (then the backup). See _shared/dispatchNudge.ts for the rules.
 */
export const dispatchNudge = defineFunction({
  name: 'dispatch-nudge',
  entry: './handler.ts',
  resourceGroupName: 'data',
  schedule: 'every 5m',
  timeoutSeconds: 60,
  memoryMB: 512,
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
