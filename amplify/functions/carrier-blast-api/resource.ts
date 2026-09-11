import { defineFunction, secret } from '@aws-amplify/backend'

export const carrierBlastApi = defineFunction({
  name: 'carrier-blast-api',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 900,
  memoryMB: 1024,
  environment: {
    // Instantly workspace API key and shared webhook secret.
    INSTANTLY_API_KEY:         secret('INSTANTLY_API_KEY'),
    INSTANTLY_WEBHOOK_SECRET:  secret('INSTANTLY_WEBHOOK_SECRET'),
    // CONTACT_TABLE, CAMPAIGN_TABLE, REPLY_TABLE, and WEBHOOK_URL are wired in amplify/backend.ts.
  },
})
