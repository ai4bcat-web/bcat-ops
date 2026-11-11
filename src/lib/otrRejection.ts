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
