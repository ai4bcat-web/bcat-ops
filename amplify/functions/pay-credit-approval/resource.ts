import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * pay-credit-approval — the approval gate for driver pay credits.
 *
 * `managePayCredit(action, creditId, reason)`:
 *   - NOTIFY  — after someone other than the owner adds a credit, DM Ryne on Slack with
 *               the driver, amount, note, who asked, and a link to the settlement page.
 *   - APPROVE / REJECT — owner or ADMIN only (checked here, not in the UI); stamps the
 *               credit and DMs whoever requested it.
 *
 * Environment (amplify/backend.ts): PAY_CREDIT_TABLE_NAME, DRIVER_TABLE_NAME,
 * USER_POOL_ID, PORTAL_BASE_URL, APPROVER_EMAIL.
 */
export const payCreditApproval = defineFunction({
  name: 'pay-credit-approval',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    SLACK_BOT_TOKEN: secret('SLACK_BOT_TOKEN'),
  },
})
