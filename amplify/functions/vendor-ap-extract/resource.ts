import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Reads a vendor invoice (the PDF or picture on the email) and fills in what the queue
 * shows: vendor, invoice number, amount, invoice date, due date. Invoked asynchronously by
 * vendor-ap-intake when a row lands; `{ all: true }` backfills rows never read.
 * Never overwrites a value a person already typed.
 */
export const vendorApExtract = defineFunction({
  name: 'vendor-ap-extract',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 90,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY'),
  },
})
