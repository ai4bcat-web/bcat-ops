import { defineFunction } from '@aws-amplify/backend'

/** Public, read-only: where a truck is, for the broker or shipper holding its tracking link. */
export const trackingApi = defineFunction({
  name: 'tracking-api',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 15,
  // Table names are wired in amplify/backend.ts.
})
