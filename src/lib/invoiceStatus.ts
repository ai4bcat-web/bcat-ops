import type { MaintenanceInvoice, InvoiceStatus } from '@/types/equipment'

/**
 * Emailed invoices (repairs@) created from this instant forward go into the review queue
 * (PENDING) instead of straight onto the list. Everything created before — plus every
 * manually-added invoice — stays POSTED, so existing data and the P&L are unaffected and
 * no back-fill/migration is needed. Advance this ONLY if you ever want to re-baseline.
 */
export const INVOICE_QUEUE_CUTOFF = '2026-07-30T00:00:00.000Z'

/**
 * Effective state of an invoice. `status` is authoritative when set; otherwise a new
 * emailed invoice (after the cutoff) is PENDING and everything else is POSTED.
 */
export function invoiceState(inv: Pick<MaintenanceInvoice, 'status' | 'source' | 'createdAt'>): InvoiceStatus {
  if (inv.status === 'ARCHIVED' || inv.status === 'POSTED' || inv.status === 'PENDING') return inv.status
  if (inv.source === 'EMAIL' && (inv.createdAt ?? '') >= INVOICE_QUEUE_CUTOFF) return 'PENDING'
  return 'POSTED'
}

export const isQueued   = (i: Pick<MaintenanceInvoice, 'status' | 'source' | 'createdAt'>) => invoiceState(i) === 'PENDING'
export const isPosted   = (i: Pick<MaintenanceInvoice, 'status' | 'source' | 'createdAt'>) => invoiceState(i) === 'POSTED'
export const isArchived = (i: Pick<MaintenanceInvoice, 'status' | 'source' | 'createdAt'>) => invoiceState(i) === 'ARCHIVED'
