import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Every five minutes: find loads whose next check call has come due and DM the
 * carrier rep on Slack (and/or a channel), once for DUE and once for OVERDUE per
 * scheduled time. Rides Step B's sparse `checkCallOpen` + `nextCheckCallAt` index,
 * so the query costs one GSI read no matter how many loads exist.
 *
 * The in-app worklist at /check-calls is the same data read straight from the
 * client, which is what dev uses: `schedule:` creates an EventBridge rule inside
 * the data stack, and the dev guard in backend.ts disables every rule there.
 */
export const checkCallNotifier = defineFunction({
  name: 'check-call-notifier',
  entry: './handler.ts',
  resourceGroupName: 'ops',
  schedule: 'every 5m',
  timeoutSeconds: 60,
  memoryMB: 512,
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
