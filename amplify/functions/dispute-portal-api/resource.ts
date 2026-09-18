import { defineFunction } from '@aws-amplify/backend'

export const disputePortalApi = defineFunction({
  name: 'dispute-portal-api',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  // TABLE_NAME, BUCKET_NAME, and ALLOWED_ORIGINS are wired in amplify/backend.ts.
})
