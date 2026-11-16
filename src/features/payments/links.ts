/**
 * Payments are recorded in one place only (Ryne 2026-11-15): Accounting → Payments received.
 * Every other screen links there with the customer, and the invoice when there is one, picked.
 */
export function recordPaymentPath(input: { customerId?: string | null; invoiceId?: string | null; invoiceIds?: readonly string[] } = {}): string {
  const q = new URLSearchParams({ record: '1' })
  if (input.customerId) q.set('customer', input.customerId)
  for (const id of [...(input.invoiceId ? [input.invoiceId] : []), ...(input.invoiceIds ?? [])]) q.append('invoice', id)
  return `/tms/payments-received?${q.toString()}`
}

export const RECORD_PAYMENT_LINK_LABEL = 'Record payment in Payments received'
