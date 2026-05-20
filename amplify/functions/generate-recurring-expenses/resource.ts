import { defineFunction } from '@aws-amplify/backend'

export const generateRecurringExpenses = defineFunction({
  name: 'generate-recurring-expenses',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,  // 5 min for multi-month backfills
})
