import { defineFunction, secret } from '@aws-amplify/backend'

export const driverAppApi = defineFunction({
  name: 'driver-app-api',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  environment: {
    // Slack bot token for #intake-ivan rate-con/POD posts.
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
    // Shared secret for the loads inbox Gmail bridge (same secret name as
    // vendor-ap-intake so the Apps Script project only needs one constant).
    LOADS_INTAKE_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
    // Read-only hours-of-service lookups for the Ivan app. The same org key the Motive
    // sync jobs use; nothing here ever writes to Motive — duty status is a federal record
    // and edits belong in the certified ELD.
    MOTIVE_API_KEY: secret('MOTIVE_API_KEY'),
    // Table names, bucket, SES from address, user pool IDs, and channel ID are
    // wired in amplify/backend.ts.
  },
})
