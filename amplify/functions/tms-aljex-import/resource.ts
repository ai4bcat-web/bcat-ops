import { defineFunction } from '@aws-amplify/backend'

/**
 * tms-aljex-import Lambda — Step N1.
 *
 * Bulk import from Aljex CSV: dry-run preview, idempotent apply by file hash,
 * per-row errors uploaded to S3. Writes Shipment, Order, Load, LoadFinancials,
 * LoadCharge, Customer, Location, Invoice, InvoiceLine, CarrierBill, ProClaim
 * and AuditLog directly via DynamoDB SDK.
 */
export const tmsAljexImport = defineFunction({
  name: 'tms-aljex-import',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
})
