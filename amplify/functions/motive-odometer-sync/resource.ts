import { defineFunction, secret } from '@aws-amplify/backend'

export const motiveOdometerSync = defineFunction({
  name: 'motive-odometer-sync',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
  environment: {
    MOTIVE_API_KEY: secret('MOTIVE_API_KEY'),
  },
})
