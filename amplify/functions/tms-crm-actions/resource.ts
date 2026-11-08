import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Step AB. CRM bones: activity timeline, contacts, domain claims, last touch / next
 * step, follow-ups, owner assignment and the one-off backfill. AppSync
 * `tmsCrmActions` only; no schedule, no SSM, no S3, no Gmail.
 * Step AI: the conversational-dashboard actions live here too; `ANTHROPIC_API_KEY` is the
 * one model call (PREVIEW_DASHBOARD_CHAT). The model never receives rows.
 */
export const tmsCrmActions = defineFunction({
  name: 'tms-crm-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 512,
  environment: {
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
  },
})
