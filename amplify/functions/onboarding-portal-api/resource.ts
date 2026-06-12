import { defineFunction } from '@aws-amplify/backend'

export const onboardingPortalApi = defineFunction({
  name: 'onboarding-portal-api',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  // Table names, BUCKET_NAME, and ALLOWED_ORIGINS wired in backend.ts.
})
