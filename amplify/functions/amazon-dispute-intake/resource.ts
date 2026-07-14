import { defineFunction, secret } from '@aws-amplify/backend'

export const amazonDisputeIntake = defineFunction({
  name: 'amazon-dispute-intake',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // Shared webhook secret — the SAME token the existing fuel/intake Apps Script bridge
    // uses, so the Google-Form Apps Script can POST here with a secret that's already set
    // in the Amplify Console. (INTAKE_WEBHOOK_SECRET.)
    DISPUTE_INTAKE_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
    // TABLE_NAME is a plain env var set in backend.ts so the deploy never blocks on it.
  },
})
