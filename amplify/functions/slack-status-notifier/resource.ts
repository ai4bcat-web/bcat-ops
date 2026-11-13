import { defineFunction, secret } from '@aws-amplify/backend'

export const slackStatusNotifier = defineFunction({
  name: 'slack-status-notifier',
  entry: './handler.ts',
  resourceGroupName: 'data',
  // Two jobs, both "post an update under an intake's Slack message": the legacy IntakeItem status mutation (AppSync), and the
  // IntakeLoad / Shipment / ShipmentDocument / Invoice streams (intakeThread.ts). A new e-mail can reach Slack ~20 s after it is
  // staged, so a duplicate notice waits up to a minute for the thread to appear.
  timeoutSeconds: 90,
  environment: {
    // The bot needs chat:write (replies) and channels:history (finding the e-mail's message in the intake channels).
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
    // The intake channels to search: the same channel → division map slack-intake-webhook reads.
    SLACK_CHANNEL_MAPPING: secret('SLACK_CHANNEL_MAPPING'),
  },
})
