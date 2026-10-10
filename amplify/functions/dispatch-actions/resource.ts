import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * The office's side of Dispatch: one `manageDispatch(action, input)` mutation.
 *
 *   send        text (and pictures) a driver from the dispatch number
 *   start       open a conversation with a driver (or any number) before they text in
 *   markRead    clear the unread count once someone has looked
 *   assign      hand a conversation to a teammate
 *   link        tie a number to a driver, or label a number that is not one
 *   archive / reopen
 *   note        an internal note in the thread the driver never sees
 *   mediaUrl    a short-lived link to a picture or voicemail in S3
 *   status      is Twilio set up, and what number is it
 *   getSettings / saveSettings   who the phones ring, voicemail, Slack, auto-reply
 *
 * Table names, bucket, the SSM path and the webhook URL are wired in backend.ts.
 */
export const dispatchActions = defineFunction({
  name: 'dispatch-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  memoryMB: 512,
  environment: {
    // Mirrors page-sent texts into the driver's Slack channel (slack bridge).
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
