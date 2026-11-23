/**
 * "OTR no buy" on a customer, worked out from the factoring queue and never stored.
 *
 * A customer has it once any of their factoring rows has ever carried a No Buy (see `noBuyInfo`
 * in noBuy.ts: the broker check said NO BUY, or a person flagged OTR's refusal). The row keeps
 * that mark after it leaves the OTR queue (Invoiced manually, Archived), so the history is the
 * flag. Staff-facing only: no invoice, aging report or e-mail reads this.
 */
import { noBuyInfo } from './noBuy'
import type { FactoringItem } from '@/types'

export interface OtrNoBuyEvent {
  /** The PRO the row was raised for. */
  pro: string
  /** When OTR said No buy (the broker check's time, else when it was invoiced by hand, else the row's last change). */
  at: string | null
  reason: string
}

export type OtrNoBuyByCustomer = Map<string, OtrNoBuyEvent[]>

/** Newest first. `customerOfInvoice` finds the customer of a row that names an invoice but no customer. */
export function otrNoBuyByCustomer(
  items: readonly FactoringItem[],
  customerOfInvoice?: (invoiceId: string) => string | null | undefined,
): OtrNoBuyByCustomer {
  const map: OtrNoBuyByCustomer = new Map()
  for (const item of items) {
    const { noBuy, reason } = noBuyInfo(item)
    if (!noBuy) continue
    const customerId = item.customerId || (item.invoiceId ? customerOfInvoice?.(item.invoiceId) : null)
    if (!customerId) continue
    const events = map.get(customerId) ?? []
    events.push({ pro: item.proNumber || item.id, at: item.brokerCheckedAt || item.manualInvoicedAt || item.updatedAt || null, reason: reason ?? 'OTR will not buy' })
    map.set(customerId, events)
  }
  for (const events of map.values()) events.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  return map
}

/** "No buy" for a column cell and filter. */
export const NO_BUY_LABEL = 'No buy'

export function noBuyColumnText(events: readonly OtrNoBuyEvent[] | undefined): string {
  return events && events.length > 0 ? NO_BUY_LABEL : ''
}

/** The banner line: "No buy from OTR on PRO 14114 (Nov 3, 2026) and 2 more." */
export function noBuySummary(events: readonly OtrNoBuyEvent[], formatDay: (iso: string) => string): string {
  const [first, ...rest] = events
  if (!first) return ''
  const when = first.at ? ` (${formatDay(first.at)})` : ''
  return `OTR has said No buy on PRO ${first.pro}${when}${rest.length ? ` and ${rest.length} more` : ''}.`
}
