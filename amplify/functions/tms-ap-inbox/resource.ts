import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Step AG. The Accounting AP inbox: AppSync `tmsApInboxActions` plus the EventBridge
 * `{ sync: true, scheduled: true }` door (rule `ApInboxHourlyRule`, hourly, auto-disabled on dev).
 *
 * It reads ONE mailbox (ai4bcat@gmail.com) through the Gmail REST API with the read-only
 * `gmail.readonly` scope, classifies mail with the same Anthropic key `workflow-agent` uses,
 * stores only mail classified as an invoice or credit memo, and may update a carrier bill's
 * invoice number / dates (and amount on a placeholder bill) under the strict rules in
 * `src/lib/apInbox/{match,applyPlan}.ts`. It never sends, drafts, approves or pays anything.
 */
export const tmsApInbox = defineFunction({
  name: 'tms-ap-inbox',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
  },
})
