import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * cash-checkin-reminder — the morning after every payroll (every 14 days from the
 * "Last payroll date" on the Weekly Cash Check-in page), post a Slack reminder to the
 * channel configured on that page asking for the check-in. Skipped when a check-in
 * dated on or after that payroll is already logged. Two UTC cron rules fire it
 * (14:00 & 15:00); the handler posts only when it is 09:00 in Chicago, so DST never
 * shifts the reminder.
 */
export const cashCheckinReminder = defineFunction({
  name: 'cash-checkin-reminder',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
