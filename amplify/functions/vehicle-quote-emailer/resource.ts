import { defineFunction } from '@aws-amplify/backend'

export const vehicleQuoteEmailer = defineFunction({
  name: 'vehicle-quote-emailer',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  // FROM_ADDRESS + BCC_ADDRESS wired in backend.ts.
})
