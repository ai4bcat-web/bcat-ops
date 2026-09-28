import { defineFunction, secret } from '@aws-amplify/backend'

export const vendorApIntake = defineFunction({
  name: 'vendor-ap-intake',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // Shared with the other intake bridges so the Apps Script project only needs
    // one secret constant/property.
    VENDOR_AP_INTAKE_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
    // TABLE_NAME and BUCKET_NAME are wired in amplify/backend.ts so the deploy
    // never waits for them.
  },
})
