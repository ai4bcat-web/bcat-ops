import { defineFunction } from '@aws-amplify/backend'

/**
 * Custom AppSync mutation handler for the vendor AP queue.
 *
 * Exposes a single `manageVendorPayable(action, id?, maintenanceInvoiceId?, input?)`
 * mutation that returns `{ item, duplicate? }`. TABLE_NAME (VendorPayable) and
 * MAINTENANCE_TABLE_NAME are injected in backend.ts so the data stack can wire the
 * actual table names and IAM policies.
 */
export const vendorApActions = defineFunction({
  name: 'vendor-ap-actions',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // TABLE_NAME and MAINTENANCE_TABLE_NAME are set in amplify/backend.ts.
  },
})
