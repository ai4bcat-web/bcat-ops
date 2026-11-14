/**
 * Days to pay: how long a customer takes to settle an invoice.
 *
 * One definition, used by the Paid tab, the AR customer group header and the customer
 * profile: **invoice date → the date of the payment that brought the balance to zero**.
 *
 * The settling date is read from the cash rows, not from `paidAt` alone: a partial payment
 * and its final payment are separate rows, and the final one is the one that counts. A
 * reversed receipt never counts. `paidAt` is the fallback for history that has no cash
 * rows (imported Aljex invoices marked paid by script).
 */
import type { ArPaymentMethod, ArPaymentRecord, InvoiceRecord } from '@/types/tms'

const DAY_MS = 86_400_000

function ymd(iso: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')
  return m ? m[1] : null
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / DAY_MS)
}

/** One receipt applied to one invoice, as the Paid tab and the invoice detail list it. */
export interface InvoicePaymentLine {
  paymentId: string
  /** YYYY-MM-DD. */
  receivedOn: string
  method: ArPaymentMethod | null
  reference: string | null
  amountCents: number
}

/** Every live receipt (and write-off) against each invoice, oldest first. */
export function paymentLinesByInvoice(payments: ArPaymentRecord[]): Map<string, InvoicePaymentLine[]> {
  const out = new Map<string, InvoicePaymentLine[]>()
  const push = (invoiceId: string, line: InvoicePaymentLine) => {
    const list = out.get(invoiceId) ?? []
    list.push(line)
    out.set(invoiceId, list)
  }
  for (const p of payments) {
    if (p.reversedByPaymentId || p.kind === 'REVERSAL' || p.kind === 'CREDIT_MEMO') continue
    const receivedOn = ymd(p.receivedAt)
    if (!receivedOn) continue
    if (p.kind === 'WRITE_OFF') {
      if (p.invoiceId) push(p.invoiceId, { paymentId: p.id, receivedOn, method: null, reference: p.reference ?? null, amountCents: p.amountCents })
      continue
    }
    for (const a of p.applications ?? []) {
      if (a.amountCents > 0) {
        push(a.invoiceId, { paymentId: p.id, receivedOn, method: p.method ?? null, reference: p.reference ?? null, amountCents: a.amountCents })
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.receivedOn.localeCompare(b.receivedOn))
  return out
}

export interface InvoiceSettlement {
  /** YYYY-MM-DD the balance reached zero; null while anything is still owed. */
  paidOn: string | null
  /** The settling payment's method and check/ref number. */
  method: ArPaymentMethod | null
  reference: string | null
  daysToPay: number | null
}

export function settlementOf(invoice: InvoiceRecord, lines: InvoicePaymentLine[] | undefined): InvoiceSettlement {
  if (invoice.status !== 'PAID') return { paidOn: null, method: null, reference: null, daysToPay: null }
  const last = lines && lines.length > 0 ? lines[lines.length - 1] : null
  const paidOn = last?.receivedOn ?? ymd(invoice.paidAt)
  const from = ymd(invoice.invoiceDate)
  const days = paidOn && from ? Math.max(0, daysBetween(from, paidOn)) : null
  return { paidOn, method: last?.method ?? null, reference: last?.reference ?? null, daysToPay: days }
}

export interface CustomerDaysToPay {
  /** Average over the customer's paid invoices, one decimal; null with none to measure. */
  averageDays: number | null
  count: number
}

export function customerDaysToPay(invoices: InvoiceRecord[], payments: ArPaymentRecord[]): CustomerDaysToPay {
  const lines = paymentLinesByInvoice(payments)
  return averageDaysToPay(invoices.map((inv) => settlementOf(inv, lines.get(inv.id))))
}

export function averageDaysToPay(settlements: InvoiceSettlement[]): CustomerDaysToPay {
  const days = settlements.map((s) => s.daysToPay).filter((d): d is number => d != null)
  if (days.length === 0) return { averageDays: null, count: 0 }
  return { averageDays: Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10, count: days.length }
}

export function daysToPayText(d: CustomerDaysToPay): string {
  return d.averageDays == null ? 'No paid invoices yet' : `${d.averageDays} days to pay (avg of ${d.count})`
}

export const PAYMENT_METHOD_LABEL: Partial<Record<ArPaymentMethod, string>> = {
  ACH: 'ACH',
  CHECK: 'Paper check',
  WIRE: 'Wire',
  CARD: 'Card',
  FACTOR: 'Factor',
  OTHER: 'Other',
}
