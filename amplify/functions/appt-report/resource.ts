import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * appt-report — daily 3 PM America/Chicago Slack digest to #bcat-global listing the
 * appointments in the next 5 business days that still need Dennis, need Ruben, or are
 * awaiting a confirmation. Missing ratecons are deliberately excluded: they are
 * paperwork on the loads board, not scheduling work. Weekdays only.
 * Two UTC cron rules fire it (20:00 & 21:00); the handler posts only when it is
 * actually 15:00 in Chicago, so DST never shifts the report.
 */
export const apptReport = defineFunction({
  name: 'appt-report',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
