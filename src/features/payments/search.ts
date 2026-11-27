/**
 * Payments Received search (Ryne 2026-11-27): any text typed in the search box looks across ALL invoices and
 * ALL payments, whatever the tab, the date range or the six-month window the page loads. Pure helpers; the page
 * wires them up.
 */
import { customerRefOf } from '@/lib/customerRef'
import type { InvoiceRecord } from '@/types/tms'
import type { ReceivedRow } from './paymentsReceived'

export const SEARCH_RESULT_CAP = 200

export const normalizeTerm = (text: string | null | undefined): string => (text ?? '').trim().toLowerCase()

/** The PRO an invoice id belongs to: `13365-2` is PRO 13365. */
export const proOfInvoiceId = (invoiceId: string): string => invoiceId.split('-')[0].trim()

/** True when the term could be an invoice number or PRO, so an exact lookup is worth one read. */
export function looksLikeInvoiceNumber(term: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{2,24}$/.test(term.trim())
}

/** Invoice id → its PO / customer ref, from the invoices the page knows about. */
export type PoByInvoice = ReadonlyMap<string, string>

export function poMapOf(invoices: readonly InvoiceRecord[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const inv of invoices) {
    const po = customerRefOf(inv.references)
    if (po) m.set(inv.id, po)
  }
  return m
}

/** A payment, credit, debit or reversal matches by customer, reference, note, or any invoice / PRO / PO it was applied to. */
export function ledgerMatchesTerm(row: ReceivedRow, term: string, poByInvoice: PoByInvoice): boolean {
  const q = normalizeTerm(term)
  if (!q) return true
  const hay = [row.customerName, row.reference ?? '', row.note ?? '']
  for (const i of row.invoices) hay.push(i.invoiceId, proOfInvoiceId(i.invoiceId), poByInvoice.get(i.invoiceId) ?? '')
  return hay.some((v) => v.toLowerCase().includes(q))
}

export function ledgerSearch(rows: readonly ReceivedRow[], term: string, poByInvoice: PoByInvoice): ReceivedRow[] {
  return rows.filter((r) => ledgerMatchesTerm(r, term, poByInvoice))
}

/** An invoice matches by number, PRO, PO / customer ref, or customer name. */
export function invoiceMatchesTerm(inv: InvoiceRecord, term: string, customerName: string): boolean {
  const q = normalizeTerm(term)
  if (!q) return false
  return [inv.id, inv.number ?? '', inv.shipmentNumber ?? '', customerRefOf(inv.references) ?? '', customerName]
    .some((v) => v.toLowerCase().includes(q))
}

/**
 * Every invoice the page can see (open book, recent months, exact look-ups), de-duplicated by id and narrowed to the
 * term, newest invoice first. Voided invoices stay in, so a search for one says so instead of showing nothing.
 */
export function invoiceSearch(
  sources: ReadonlyArray<readonly InvoiceRecord[]>,
  term: string,
  customerName: (customerId: string) => string,
  opts: { customerId?: string | null; cap?: number } = {},
): { rows: InvoiceRecord[]; total: number } {
  const byId = new Map<string, InvoiceRecord>()
  for (const list of sources) for (const inv of list) if (!byId.has(inv.id)) byId.set(inv.id, inv)
  const hits = [...byId.values()]
    .filter((inv) => !opts.customerId || inv.customerId === opts.customerId)
    .filter((inv) => invoiceMatchesTerm(inv, term, customerName(inv.customerId)))
    .sort((a, b) => (b.invoiceDate ?? '').localeCompare(a.invoiceDate ?? '') || b.id.localeCompare(a.id, undefined, { numeric: true }))
  const cap = opts.cap ?? SEARCH_RESULT_CAP
  return { rows: hits.slice(0, cap), total: hits.length }
}

export type InvoiceSearchState = 'Open' | 'Partly paid' | 'Paid' | 'Void'

export function invoiceSearchState(inv: Pick<InvoiceRecord, 'status'>): InvoiceSearchState {
  if (inv.status === 'VOID') return 'Void'
  if (inv.status === 'PAID') return 'Paid'
  if (inv.status === 'PARTIAL') return 'Partly paid'
  return 'Open'
}
