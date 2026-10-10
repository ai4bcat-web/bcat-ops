import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Slack → driver: a message typed in a driver's #drv-… channel becomes a text.
 *
 * Invoked asynchronously by slack-intake-webhook (which already receives and verifies every
 * Slack event) whenever an event lands in a channel that belongs to a Dispatch conversation.
 * Pictures attached in Slack go out as MMS; a message starting with // is kept as an
 * internal note. Outcome is reported back in the channel as a threaded reply only when
 * something went wrong, so a normal exchange reads like a text thread.
 */
export const dispatchSlackBridge = defineFunction({
  name: 'dispatch-slack-bridge',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 512,
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
