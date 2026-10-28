import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * intake-reconcile — closes the loop between a tender in Slack and the load somebody
 * already built from it.
 *
 * Measured before this existed: 317 intake items sat in NEW while the load they describe
 * was already in Ops. The work was done; only the queue did not know. This replies in the
 * item's OWN Slack thread with the PRO and moves the item to BUILT.
 *
 * It never starts a thread. See the handler — a post without a thread_ts is refused.
 */
export const intakeReconcile = defineFunction({
  name: 'intake-reconcile',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
