import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * OTR Solutions factoring actions.
 *
 * Exposes a single `manageOtr(action, input)` mutation that routes every
 * interaction with OTR's Carrier TMS v3 API:
 *   - resolve      : match a queue row's PRO to a Load (Load.aljexId)
 *   - assemble     : build the invoice payload and report what's missing
 *   - setMc        : record a broker MC on the Customer (creating it if absent)
 *   - brokerCheck  : ask OTR whether the broker is approved, BEFORE submitting
 *   - submit       : create the invoice, then upload the POD and rate confirmation
 *   - syncStatus   : read OTR's status back onto the row
 *
 * Submitting is deliberately a separate action from assembling: a human presses
 * Submit on the queue row. Nothing here creates an invoice on its own.
 *
 * OTR_BASE_URL is an environment variable, not a constant, so pointing at
 * production is a config change rather than a code change. It defaults to
 * staging in backend.ts.
 *
 * Environment injected in amplify/backend.ts:
 *   FACTORING_ITEM_TABLE_NAME, LOAD_TABLE_NAME, CUSTOMER_TABLE_NAME,
 *   LOCATION_TABLE_NAME, POD_DOCUMENT_TABLE_NAME, BUCKET_NAME, OTR_BASE_URL
 */
export const otrActions = defineFunction({
  name: 'otr-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  // Document upload streams PDFs from S3 to OTR; 60s leaves room for two files.
  timeoutSeconds: 60,
  memoryMB: 1024,
  environment: {
    OTR_USERNAME: secret('OTR_USERNAME'),
    OTR_PASSWORD: secret('OTR_PASSWORD'),
    OTR_SUBSCRIPTION_KEY: secret('OTR_SUBSCRIPTION_KEY'),
  },
})

/**
 * Hourly mirror of OTR's invoice board onto the queue.
 *
 * Separate from otrActions so the read-only poll can never be confused with the
 * human-initiated submit path, and so a slow poll can't consume the submit
 * function's concurrency. Runs `syncAll`: every row holding an otrInvoiceId that
 * is not already terminal.
 */
export const otrStatusSync = defineFunction({
  name: 'otr-status-sync',
  entry: './sync.ts',
  resourceGroupName: 'data',
  // Hourly at :05 — offset from the top of the hour so it doesn't contend with
  // the other schedules in this stack. AWS cron: min hour dom month dow year.
  schedule: '5 * * * ? *',
  timeoutSeconds: 120,
  memoryMB: 512,
  environment: {
    OTR_USERNAME: secret('OTR_USERNAME'),
    OTR_PASSWORD: secret('OTR_PASSWORD'),
    OTR_SUBSCRIPTION_KEY: secret('OTR_SUBSCRIPTION_KEY'),
  },
})
