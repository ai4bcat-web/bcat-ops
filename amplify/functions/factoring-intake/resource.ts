import { defineFunction, secret } from '@aws-amplify/backend'

export const factoringIntake = defineFunction({
  name: 'factoring-intake',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // Shared webhook secret — the SAME token the existing fuel/intake Gmail bridge
    // uses, so the Apps Script can POST here without a new secret.
    FACTORING_INTAKE_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
    // TABLE_NAME is a plain env var set in backend.ts so the deploy never blocks on it.
  },
})
