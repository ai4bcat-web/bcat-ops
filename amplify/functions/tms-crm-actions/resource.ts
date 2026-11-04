import { defineFunction } from '@aws-amplify/backend'

/**
 * Step AB. CRM bones: activity timeline, contacts, domain claims, last touch / next
 * step, follow-ups, owner assignment and the one-off backfill. AppSync
 * `tmsCrmActions` only; no schedule, no SSM, no S3, no model, no Gmail.
 */
export const tmsCrmActions = defineFunction({
  name: 'tms-crm-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 512,
})
