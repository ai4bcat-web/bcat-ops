import { defineFunction, secret } from '@aws-amplify/backend'

export const carrierBlastWebhook = defineFunction({
  name: 'carrier-blast-webhook',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // Shared secret delivered in the x-bcat-secret header from Instantly.
    INSTANTLY_WEBHOOK_SECRET: secret('INSTANTLY_WEBHOOK_SECRET'),
    // CONTACT_TABLE, CAMPAIGN_TABLE, and REPLY_TABLE are wired in amplify/backend.ts.
  },
})
