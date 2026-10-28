import { defineFunction, secret } from '@aws-amplify/backend'

export const fuelImport = defineFunction({
  name: 'fuel-import',
  entry: './handler.ts',
  resourceGroupName: 'ops',
  timeoutSeconds: 120,
  environment: {
    FUEL_IMPORT_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
  },
})
