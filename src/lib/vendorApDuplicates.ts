/**
 * Duplicate invoices in the vendor AP queue: the same bill arriving twice (forwarded by
 * two people, re-sent by the vendor, or a maintenance invoice that also came by email).
 *
 * Two rows match when the vendor is the same and either the invoice number matches, or
 * the amount and invoice date both match. The earliest row is the original; the later
 * ones are the duplicates to delete.
 */
import type { VendorPayable } from '@/types/vendorAp'

export interface DuplicateMark {
  /** The row this one duplicates (the earliest of the group). */
  originalId: string
  /** How the match was made, for the badge's tooltip. */
  reason: 'invoice number' | 'amount and date'
}

function normVendor(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/\b(inc|llc|ltd|co|corp|company|the)\b\.?/g, '').replace(/[^a-z0-9]/g, '')
}

function normInvoice(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/^(inv|invoice|#|no\.?|number)\s*/g, '').replace(/[^a-z0-9]/g, '')
}

/** Map of duplicate row id → what it duplicates. Rows not in the map are fine. */
export function findVendorApDuplicates(items: readonly VendorPayable[]): Map<string, DuplicateMark> {
  const out = new Map<string, DuplicateMark>()
  const sorted = [...items].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
  const byInvoice = new Map<string, string>()
  const byAmountDate = new Map<string, string>()
  for (const it of sorted) {
    const vendor = normVendor(it.vendor)
    if (!vendor) continue
    const inv = normInvoice(it.invoiceNumber)
    if (inv) {
      const key = `${vendor}|${inv}`
      const original = byInvoice.get(key)
      if (original) { out.set(it.id, { originalId: original, reason: 'invoice number' }); continue }
      byInvoice.set(key, it.id)
    }
    if (it.amount != null && it.invoiceDate) {
      const key = `${vendor}|${it.amount}|${it.invoiceDate}`
      const original = byAmountDate.get(key)
      if (original && original !== it.id) { out.set(it.id, { originalId: original, reason: 'amount and date' }); continue }
      byAmountDate.set(key, it.id)
    }
  }
  return out
}
