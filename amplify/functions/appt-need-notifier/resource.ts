import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Posts to #appts-ivan when a pickup or delivery is flagged NEED — i.e. somebody has to
 * go and book an appointment.
 *
 * APPTS_IVAN_CHANNEL_ID is a plain env var set in backend.ts, matching how
 * INTAKE_IVAN_CHANNEL_ID is wired for gmail-task-intake. The bot needs chat:write.
 */
export const apptNeedNotifier = defineFunction({
  name: 'appt-need-notifier',
  entry: './handler.ts',
  resourceGroupName: 'data',
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
