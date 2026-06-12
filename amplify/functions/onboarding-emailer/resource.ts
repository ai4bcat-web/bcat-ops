import { defineFunction } from '@aws-amplify/backend'

export const onboardingEmailer = defineFunction({
  name: 'onboarding-emailer',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  // FROM_ADDRESS + table names wired in backend.ts.
})
