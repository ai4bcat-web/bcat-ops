import { defineFunction } from '@aws-amplify/backend'

export const driverPayEmailer = defineFunction({
  name: 'driver-pay-emailer',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  // FROM_ADDRESS wired in backend.ts; ses:SendRawEmail granted there.
})
