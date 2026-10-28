import { defineFunction, secret } from '@aws-amplify/backend'

export const motiveFaultSync = defineFunction({
  name: 'motive-fault-sync',
  entry: './handler.ts',
  resourceGroupName: 'ops',
  timeoutSeconds: 120,
  environment: {
    MOTIVE_API_KEY: secret('MOTIVE_API_KEY'),
  },
})
