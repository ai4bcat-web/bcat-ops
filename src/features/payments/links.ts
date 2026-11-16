import { monthBounds } from './paymentsReceived'

/**
 * Payments are recorded in one place only (Ryne 2026-11-15): Accounting → Payments Received.
 * Every other screen links there with the customer, and the invoice when there is one, picked.
 */
export function recordPaymentPath(input: { customerId?: string | null; invoiceId?: string | null; invoiceIds?: readonly string[] } = {}): string {
  const q = new URLSearchParams({ record: '1' })
  if (input.customerId) q.set('customer', input.customerId)
  for (const id of [...(input.invoiceId ? [input.invoiceId] : []), ...(input.invoiceIds ?? [])]) q.append('invoice', id)
  return `/tms/payments-received?${q.toString()}`
}

/** Payments Received opened on one customer (their profile, an invoice): only their invoices show. */
export function customerPaymentsPath(customerId: string): string {
  return `/tms/payments-received?customer=${encodeURIComponent(customerId)}`
}

export const RECORD_PAYMENT_LINK_LABEL = 'Record payment in Payments Received'

/** A period on Payments Received: `week` / `month` / `last` month, or a `YYYY-MM` month. */
export type PaymentsPeriod = 'week' | 'month' | 'last' | string

/** Payments Received opened on a period (the Receivables "Collected" figures and old `?tab=paid` links). */
export function paymentsReceivedPath(period?: PaymentsPeriod | null): string {
  return period ? `/tms/payments-received?period=${encodeURIComponent(period)}` : '/tms/payments-received'
}

export type PresetKey = 'week' | 'month' | 'last' | 'year' | 'all' | 'custom'

export function presetRange(key: PresetKey, asOf: string): { from: string; to: string } | null {
  const d = new Date(`${asOf}T12:00:00Z`)
  if (key === 'week') return { from: new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10), to: asOf }
  if (key === 'month') return monthBounds(asOf)
  if (key === 'last') return monthBounds(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15)).toISOString().slice(0, 10))
  if (key === 'year') return { from: `${asOf.slice(0, 4)}-01-01`, to: asOf }
  if (key === 'all') return { from: '', to: '' }
  return null
}

/** `?period=` → a preset and its dates: week / month / last, or a `YYYY-MM` month (shown as Custom dates). */
export function periodFromParam(period: string | null, asOf: string): { preset: PresetKey; range: { from: string; to: string } } | null {
  if (!period) return null
  if (period === 'week' || period === 'month' || period === 'last' || period === 'year' || period === 'all') {
    const range = presetRange(period, asOf)
    return range ? { preset: period, range } : null
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    const range = monthBounds(`${period}-15`)
    if (period === asOf.slice(0, 7)) return { preset: 'month', range }
    return { preset: 'custom', range }
  }
  return null
}


/** `?tab=paid` (the removed Paid tab) → Payments Received, on the same month when one is given. */
export function paidTabRedirect(search: string): string | null {
  const q = new URLSearchParams(search)
  if (q.get('tab') !== 'paid') return null
  const month = q.get('month')
  return paymentsReceivedPath(month && /^\d{4}-\d{2}$/.test(month) ? month : 'month')
}
