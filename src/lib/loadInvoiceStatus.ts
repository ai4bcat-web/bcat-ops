/**
 * Where a load's invoice stands, in one word, for the shipments board and the shipment page (Ryne 2026-11-14).
 *
 * It follows the AR tab the load sits in, so a load reads the same here as on Accounts receivable:
 * - Not invoiced: still before Load Review's release (DOCS_NEEDED, or no order AR state yet).
 * - Ready to invoice: released, no invoice yet, or an auto-generated invoice not sent yet (the AR draft).
 * - Factoring pending: submitted to OTR and not funded yet.
 * - OTR rejected: OTR turned it down (`otrRejection`), so it has to be invoiced by hand.
 * - Outstanding: sent with nothing paid. Partially paid: sent, some paid, a balance open.
 * - Paid: the balance is zero (with the paid date). Factored: OTR funded it.
 * - No invoice needed / Legacy: the two AR states that are not on the walk.
 *
 * Derived from what is already stored (the order's cached AR fields, the invoice row, the OTR queue row);
 * nothing new is written. The live invoice and factoring row are optional: without them the order's cached
 * fields decide, which cannot tell a draft from a sent invoice, so an open invoice then reads Outstanding.
 * Internal only: it never names carrier pay.
 */
import type { FactoringItem } from '@/types'
import type { ArStatus, InvoiceRecord } from '@/types/tms'
import type { TmsTone } from '@/features/tms/kit/statusTone'
import { otrRejection } from './otrRejection'

export type LoadInvoiceStatusKey =
  | 'NOT_INVOICED'
  | 'READY'
  | 'FACTORING_PENDING'
  | 'OTR_REJECTED'
  | 'OUTSTANDING'
  | 'PARTIAL'
  | 'PAID'
  | 'FACTORED'
  | 'NO_INVOICE'
  | 'LEGACY'

export const LOAD_INVOICE_STATUS_LABEL: Record<LoadInvoiceStatusKey, string> = {
  NOT_INVOICED: 'Not invoiced',
  READY: 'Ready to invoice',
  FACTORING_PENDING: 'Factoring pending',
  OTR_REJECTED: 'OTR rejected',
  OUTSTANDING: 'Outstanding',
  PARTIAL: 'Partially paid',
  PAID: 'Paid',
  FACTORED: 'Factored',
  NO_INVOICE: 'No invoice needed',
  LEGACY: 'Legacy',
}

const TONE: Record<LoadInvoiceStatusKey, TmsTone> = {
  NOT_INVOICED: 'gray',
  READY: 'blue',
  FACTORING_PENDING: 'purple',
  OTR_REJECTED: 'red',
  OUTSTANDING: 'orange',
  PARTIAL: 'orange',
  PAID: 'green',
  FACTORED: 'green',
  NO_INVOICE: 'gray',
  LEGACY: 'gray',
}

/** The order of the facet in the board's header filter. */
export const LOAD_INVOICE_STATUS_ORDER: readonly LoadInvoiceStatusKey[] = [
  'NOT_INVOICED', 'READY', 'FACTORING_PENDING', 'OTR_REJECTED', 'OUTSTANDING', 'PARTIAL', 'PAID', 'FACTORED', 'NO_INVOICE', 'LEGACY',
]

export interface LoadInvoiceStatus {
  key: LoadInvoiceStatusKey
  label: string
  tone: TmsTone
  /** Paid / Legacy: when the balance reached zero, if recorded. */
  paidAt: string | null
  /** OTR rejected: OTR's reason. */
  reason: string | null
}

/** The order's cached AR fields (Step F), as the board row and the shipment bundle both carry them. */
export interface LoadInvoiceOrder {
  arStatus?: ArStatus | null
  invoiceId?: string | null
  readyToInvoiceAt?: string | null
  paidAt?: string | null
  factoringItemId?: string | null
}

export type LoadInvoiceRow = Pick<InvoiceRecord, 'status' | 'paidCents' | 'balanceCents'>
  & Partial<Pick<InvoiceRecord, 'paidAt' | 'sentAt' | 'markedSentAt' | 'sentCount'>>

export type LoadInvoiceFactorItem = Pick<FactoringItem, 'status'>
  & Partial<Pick<FactoringItem, 'brokerCheckResult' | 'manualReason' | 'otrError' | 'otrStatus' | 'brokerMcChecked' | 'otrInvoiceId' | 'otrSubmittedAt'>>

function status(key: LoadInvoiceStatusKey, extra: { paidAt?: string | null; reason?: string | null } = {}): LoadInvoiceStatus {
  return { key, label: LOAD_INVOICE_STATUS_LABEL[key], tone: TONE[key], paidAt: extra.paidAt ?? null, reason: extra.reason ?? null }
}

/** The AR page's `isInvoiceSent` rule: e-mailed, marked sent, or submitted to OTR. */
function isSent(inv: LoadInvoiceRow, item: LoadInvoiceFactorItem | null): boolean {
  if (inv.sentAt || inv.markedSentAt || (inv.sentCount ?? 0) > 0) return true
  return Boolean(item && (item.otrInvoiceId || item.otrSubmittedAt || item.status === 'PENDING_WITH_OTR' || item.status === 'FACTORED'))
}

export function loadInvoiceStatusOf(
  order: LoadInvoiceOrder | null | undefined,
  invoice?: LoadInvoiceRow | null,
  factorItem?: LoadInvoiceFactorItem | null,
): LoadInvoiceStatus {
  const ar = order?.arStatus ?? null
  if (ar === 'INVOICE_NOT_NEEDED') return status('NO_INVOICE')
  if (ar === 'LEGACY') return status('LEGACY', { paidAt: order?.paidAt })

  const inv = invoice && invoice.status !== 'VOID' ? invoice : null
  const item = factorItem ?? null

  if (inv?.status === 'PAID' || (!inv && ar === 'PAID')) return status('PAID', { paidAt: inv?.paidAt ?? order?.paidAt })

  if (item) {
    const rejected = otrRejection({
      status: item.status,
      brokerCheckResult: item.brokerCheckResult ?? null,
      manualReason: item.manualReason ?? null,
      otrError: item.otrError ?? null,
      otrStatus: item.otrStatus ?? null,
      brokerMcChecked: item.brokerMcChecked ?? null,
    })
    if (rejected) return status('OTR_REJECTED', { reason: rejected.reason })
    if (item.status === 'FACTORED') return status('FACTORED')
    if (item.status === 'PENDING_WITH_OTR') return status('FACTORING_PENDING')
  }

  if (inv) {
    if (!isSent(inv, item) && inv.paidCents === 0) return status('READY')
    if (inv.paidCents > 0 && inv.balanceCents > 0) return status('PARTIAL')
    return status('OUTSTANDING')
  }

  // No live invoice row: the order's cache decides.
  if (order?.invoiceId || ar === 'UNPAID') return status('OUTSTANDING')
  if (ar === 'UNBILLED' || order?.readyToInvoiceAt) return status('READY')
  return status('NOT_INVOICED')
}

/** "Paid Nov 12, 2026" on a paid pill; the plain label otherwise. */
export function loadInvoiceStatusText(s: LoadInvoiceStatus, formatDate: (iso: string) => string): string {
  if ((s.key === 'PAID' || s.key === 'LEGACY') && s.paidAt) return `${s.label} ${formatDate(s.paidAt)}`
  return s.label
}
