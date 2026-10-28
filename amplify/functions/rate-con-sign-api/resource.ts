import { defineFunction } from '@aws-amplify/backend'

/**
 * rate-con-sign-api Lambda — public Function URL behind /sign/rate-con/:token.
 *
 * A carrier signs a rate confirmation without an account: the emailed link
 * carries a one-time token, and this Lambda is the only thing that can read or
 * write the LoadCarrier row behind it. Same shape as onboarding-portal-api —
 * NONE auth on the URL, CORS pinned to the portal origins in backend.ts, and
 * every rejection (missing, voided, expired, already signed) handled here.
 */
export const rateConSignApi = defineFunction({
  name: 'rate-con-sign-api',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  // Table names, BUCKET_NAME and the Function URL are wired in backend.ts.
})
