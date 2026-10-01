import { defineFunction } from '@aws-amplify/backend'

/**
 * PostConfirmation trigger on the driver pool: emails a newly confirmed driver
 * the link to add the PWA to their phone.
 *
 * Lives in the same stack as driverSignupGate (see backend.ts) so the trigger
 * wiring stays intra-stack — attaching it from the root stack would reference
 * the pool id and create the CloudFormation cycle the signup gate already
 * documents.
 *
 * FROM_ADDRESS, DRIVER_TABLE_NAME and PORTAL_ORIGIN are wired in backend.ts.
 */
export const driverWelcome = defineFunction({
  name: 'driver-welcome',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
})
