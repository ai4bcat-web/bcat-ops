import { defineFunction, secret } from '@aws-amplify/backend'

export const gmailTaskIntake = defineFunction({
  name: 'gmail-task-intake',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // Shared webhook secret — the SAME one the existing fuel/intake Apps Script uses,
    // so the bridge can POST here with the same token. (Already set in Amplify Console.)
    GMAIL_INTAKE_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
    // Slack bot token (chat:write) — same secret the status notifier uses.
    SLACK_BOT_TOKEN:     secret('SLACK_BOT_TOKEN'),
    // INTAKE_IVAN_CHANNEL_ID + TABLE_NAME are plain env vars set in backend.ts so the
    // deploy never blocks on a missing secret (Slack post is skipped until configured).
  },
})
