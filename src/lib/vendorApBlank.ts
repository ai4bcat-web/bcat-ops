import type { VendorPayable } from '@/types/vendorAp'

/** An e-mailed bill nothing has been read from yet: no vendor, no invoice number, no amount. */
export function needsDetails(item: VendorPayable): boolean {
  return item.source === 'EMAIL' && item.status === 'NEED_TO_PAY' && !item.vendor && !item.invoiceNumber && item.amount == null
}
