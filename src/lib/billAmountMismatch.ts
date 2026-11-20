/**
 * Amount mismatch: the carrier's invoice says one amount and the payable another.
 *
 * AP can keep the payable as it is when entering the invoice date and flag the difference; the invoice's own
 * amount is kept on the bill (`invoiceAmountCents`). The flag is worked out from the two amounts, so it clears by
 * itself once the payable is moved to the invoice amount. Carrier pay and invoice amounts are internal: this never
 * appears on anything a customer sees.
 */
import type { CarrierBillRecord } from '@/types/tms'

/** Invoice minus payable, in cents (positive: the carrier invoiced more than we owe), or null when there is no mismatch. */
export function amountMismatchCents(bill: Pick<CarrierBillRecord, 'invoiceAmountCents' | 'grossCents'>): number | null {
  const invoice = bill.invoiceAmountCents
  if (invoice == null || invoice <= 0 || invoice === bill.grossCents) return null
  return invoice - bill.grossCents
}

export function hasAmountMismatch(bill: Pick<CarrierBillRecord, 'invoiceAmountCents' | 'grossCents'>): boolean {
  return amountMismatchCents(bill) != null
}
