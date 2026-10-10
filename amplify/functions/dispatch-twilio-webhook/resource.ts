import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Twilio's side of Dispatch: the Function URL the dispatch number points at.
 *
 *   POST /sms                 inbound text or picture from a driver
 *   POST /status              delivery receipt for something the office sent
 *   POST /voice               inbound call: ring the office phones, else voicemail
 *   POST /voice/whisper       screen on the answering phone (press a key to accept)
 *   POST /voice/accept        the key was pressed; bridge the call
 *   POST /voice/after         how the dial ended; missed calls fall to voicemail
 *   POST /voice/recording     the voicemail audio is ready
 *   POST /voice/transcription the voicemail transcript is ready
 *
 * Every URL carries ?t=<secret>; the Twilio signature is also checked whenever the
 * account's auth token has been stored. Table names, bucket and the SSM path are wired
 * in amplify/backend.ts.
 */
export const dispatchTwilioWebhook = defineFunction({
  name: 'dispatch-twilio-webhook',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  memoryMB: 512,
  environment: {
    // Optional Slack ping for inbound texts; the channel comes from Dispatch settings.
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
