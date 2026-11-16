/**
 * Which queue rows OTR has turned down, so the office can see at a glance which invoices have to go out by hand.
 *
 * Three signals, all already on the row (nothing is guessed):
 *   - NO_BUY: the broker check said OTR will not buy from that broker, or a person flagged OTR's refusal (see `noBuy.ts`);
 *   - DEAD: OTR's own status for the invoice is Dead (it will not be funded and nothing more will happen to it);
 *   - ERROR: OTR sent an error back on a row that is still waiting (the submission or its status check was refused).
 * A row that has already left the OTR queue (factored, invoiced manually, archived) is never flagged.
 */
import type { FactoringItem } from '@/types'
import { noBuyInfo } from './noBuy'
import { otrStatusMeta } from './otrInvoiceStatus'

export type OtrRejectionKind = 'NO_BUY' | 'DEAD' | 'ERROR'

export interface OtrRejection {
  kind: OtrRejectionKind
  /** Why, in a sentence the office can act on. */
  reason: string
}

/** Statuses that are still the office's work: everything not yet funded, sent by hand or parked. */
const OPEN_STATUSES: ReadonlyArray<FactoringItem['status']> = ['NEED_TO_FACTOR', 'PENDING_WITH_OTR', 'MANUAL_INVOICE']

export function otrRejection(item: Pick<FactoringItem, 'status' | 'brokerCheckResult' | 'manualReason' | 'otrError' | 'otrStatus' | 'brokerMcChecked'>): OtrRejection | null {
  if (!OPEN_STATUSES.includes(item.status)) return null
  const { noBuy, reason } = noBuyInfo(item)
  if (noBuy) return { kind: 'NO_BUY', reason: reason ?? 'OTR will not buy this invoice' }
  if (otrStatusMeta(item.otrStatus)?.code === 4) return { kind: 'DEAD', reason: 'OTR marked this invoice Dead: it will not be funded' }
  const error = item.otrError?.trim()
  if (error && item.status !== 'MANUAL_INVOICE') return { kind: 'ERROR', reason: `OTR refused it: ${error}` }
  return null
}

/** Rows that have to be invoiced by hand because OTR turned them down. */
export function needsManualInvoice(items: readonly FactoringItem[]): FactoringItem[] {
  return items.filter((i) => otrRejection(i) != null)
}

/**
 * Who may move a row to Invoice manually when OTR has NOT said No buy.
 *
 * "Invoice manually" is the answer to No buy and nothing else. A Dead invoice or one OTR
 * refused with an error is still OTR's to sort out (resubmit, fix the documents, ask them),
 * so those rows stay in the queue. Only an admin (ADMIN group or the owner) can override.
 */
export function mayInvoiceManually(
  item: Pick<FactoringItem, 'status' | 'brokerCheckResult' | 'manualReason' | 'otrError' | 'otrStatus' | 'brokerMcChecked'>,
  user: { email?: string | null; groups?: readonly string[] | null } | null,
): { allowed: boolean; override: boolean } {
  if (item.status !== 'NEED_TO_FACTOR' && item.status !== 'PENDING_WITH_OTR' && item.status !== 'MANUAL_INVOICE') return { allowed: false, override: false }
  if (noBuyInfo(item).noBuy) return { allowed: true, override: false }
  if (item.status === 'MANUAL_INVOICE') return { allowed: false, override: false }
  const admin = (user?.groups ?? []).includes('ADMIN') || (user?.email ?? '').trim().toLowerCase() === 'ryne@bcatcorp.com'
  return { allowed: admin, override: admin }
}

/**
 * The OTR rejected tab (Ryne 2026-11-14): rows OTR itself turned down — No buy, Dead, or an error
 * OTR sent back — still in the queue. Our own failures to reach OTR (an auth or connection error)
 * are not OTR rejecting anything, so they stay where they are.
 */
export function isOtrRejected(item: Parameters<typeof otrRejection>[0]): boolean {
  const r = otrRejection(item)
  if (!r) return false
  return r.kind !== 'ERROR' || !OWN_FAILURE.test(r.reason)
}

const OWN_FAILURE = /auth failed|unauthori[sz]ed|timed? ?out|network|ECONN|fetch failed|not configured/i

/**
 * Why OTR turned this load down, for the shipment page — whatever the row's status now, so the
 * reason is still there after the load was moved to manual invoice. Null when OTR never did.
 */
export function otrRejectionReason(item: Parameters<typeof otrRejection>[0]): string | null {
  const { noBuy, reason } = noBuyInfo(item)
  if (noBuy) return reason ?? 'OTR will not buy this invoice'
  if (otrStatusMeta(item.otrStatus)?.code === 4) return 'OTR marked this invoice Dead: it will not be funded'
  const error = item.otrError?.trim()
  if (error && !OWN_FAILURE.test(error)) return `OTR refused it: ${error}`
  return null
}

/**
 * The OTR rejected tab on the Factoring page (Ryne 2026-11-14: the manual tab is renamed OTR rejected):
 * every row OTR turned down, plus rows already parked to go out by hand (status MANUAL_INVOICE),
 * so nothing that still has to be invoiced by hand drops out of view.
 */
export function inOtrRejectedTab(item: Parameters<typeof otrRejection>[0]): boolean {
  return isOtrRejected(item) || item.status === 'MANUAL_INVOICE'
}

/**
 * Everything we know about why OTR turned a row down, in plain English (Ryne 2026-11-15: "it should say why").
 * OTR's API gives a status code and, on a refusal, an error message; it gives no free-text reason for Dead,
 * so the lines say that and point at OTR's own invoice for the rest. Null when OTR did not reject the row.
 */
export function otrRejectionDetails(
  item: Parameters<typeof otrRejection>[0] & Pick<FactoringItem, 'otrInvoiceId' | 'otrStatusSyncedAt'>,
): { headline: string; lines: string[] } | null {
  const reason = otrRejectionReason(item)
  if (!reason) return null
  const lines: string[] = []
  const status = otrStatusMeta(item.otrStatus)
  const { noBuy } = noBuyInfo(item)
  if (noBuy) {
    lines.push(item.brokerCheckResult === 'NO_BUY'
      ? `OTR's broker check said No buy${item.brokerMcChecked?.trim() ? ` for MC ${item.brokerMcChecked.trim()}` : ''}: OTR will not buy invoices on this customer.`
      : 'Marked No buy from OTR’s refusal.')
  }
  if (status?.code === 4) lines.push('OTR status Dead: OTR will not fund this invoice and will not work it further. OTR’s system gives no written reason for Dead; the OTR portal or your OTR rep has it.')
  else if (status) lines.push(`OTR status: ${status.label}.`)
  const error = item.otrError?.trim()
  if (error && !OWN_FAILURE.test(error)) lines.push(`OTR’s message: ${error}`)
  if (item.otrInvoiceId) lines.push(`OTR invoice #${item.otrInvoiceId}${item.otrStatusSyncedAt ? ` · last checked ${item.otrStatusSyncedAt.slice(0, 10)}` : ''}.`)
  const headline = noBuy ? `OTR: No buy — ${reason}` : status?.code === 4 ? 'OTR: Dead — this invoice will not be funded' : `OTR: ${reason}`
  return { headline, lines }
}
