import { defineFunction } from '@aws-amplify/backend'

/**
 * tms-finance-actions Lambda — custom AppSync mutation `tmsFinanceActions(action, input)`.
 *
 * Everything that posts money against a customer: generate, e-mail, mark sent, void an
 * invoice; receive a payment with its allocations; issue a credit memo; write off; reverse;
 * hand an issued invoice to the factoring queue. Separate from `tms-shipment-actions`
 * because that router admits anyone holding `page-loads` and is already 4,000 lines; a
 * ledger is gated to owner / ADMIN / `page-invoicing`, with posting admin-only by default.
 *
 * 60s rather than 30: BATCH_GENERATE renders and stores up to 25 invoice PDFs in one call,
 * and BATCH_EMAIL streams their bytes back out of S3.
 */
export const tmsFinanceActions = defineFunction({
  name: 'tms-finance-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  // A big scanned POD is read back in memory to be made smaller for an e-mail (pdfShrink): 512 MB is not room for a 5712 x 4284 picture.
  memoryMB: 1024,
})
