import { defineFunction } from '@aws-amplify/backend'

/**
 * Cognito PreSignUp trigger for the driver pool. Rejects signups whose email does
 * not match an active, eligible Amazon driver on the roster. Email verification
 * is still required — this function only validates eligibility.
 */
export const driverSignupGate = defineFunction({
  name: 'driver-signup-gate',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 10,
  memoryMB: 512,
})
