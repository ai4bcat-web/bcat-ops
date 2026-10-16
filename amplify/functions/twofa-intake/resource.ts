import { defineFunction, secret } from '@aws-amplify/backend'

/** Google Voice text forwards (via the Gmail bridge) → the Slack 2FA channel. */
export const twofaIntake = defineFunction({
  name: 'twofa-intake',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 15,
  environment: {
    // The one shared intake secret every Gmail bridge posts with.
    TWOFA_INTAKE_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
    SLACK_BOT_TOKEN:     secret('SLACK_BOT_TOKEN'),
    // TWO_FA_SLACK_CHANNEL is a plain env var set in backend.ts (defaults to #2fa).
  },
})
