/**
 * The Ready to invoice facts Ryne reviews before billing (2026-11-12): customer reference, lane,
 * carrier, customer rate, carrier rate and profit.
 *
 * INTERNAL ONLY. Carrier rate and profit are what we pay and keep: they live on this screen
 * and nowhere a customer can see — not the invoice PDF, the combined invoice + POD PDF, the
 * e-mail, the aging report or its e-mail, or the outstanding-receivables export (which reads
 * Invoice rows, and an Invoice carries only customer-side lines).
 */
import type { ShipmentListRow } from '@/hooks/useShipments'
import type { ShipmentRecord } from '@/types/tms'

export interface ReadyFacts {
  customerRef: string | null
  /** "City, ST" of the first pickup. */
  origin: string | null
  /** "City, ST" of the last delivery. */
  destination: string | null
  carrier: string | null
  customerRateCents: number | null
  carrierRateCents: number | null
  /** Customer rate − carrier rate; null unless both are known. */
  profitCents: number | null
}

/** "City, ST": the stop's city already carries its state on most rows; add the state when it does not. */
export function cityState(city: string | null | undefined, state: string | null | undefined): string | null {
  const c = (city ?? '').trim()
  if (!c) return null
  if (/,\s*[A-Za-z]{2}\s*$/.test(c) || !state) return c.replace(/,\s*([A-Za-z]{2})\s*$/, (_, st: string) => `, ${st.toUpperCase()}`)
  return `${c}, ${state.toUpperCase()}`
}

export function readyFactsOf(
  board: ShipmentListRow | undefined,
  shipment: ShipmentRecord | null | undefined,
  amountCents: number,
): ReadyFacts {
  const s = board ?? shipment ?? null
  const customerRateCents = board?.revenueCents ?? amountCents
  const carrierRateCents = board?.costCents ?? null
  return {
    customerRef: board?.customerReference ?? board?.reference ?? null,
    origin: cityState(s?.originCity, board?.fromState),
    destination: cityState(s?.destinationCity, board?.toState),
    carrier: (board?.carriers?.length ?? 0) > 1 ? board!.carriers.map((c) => c.name).join(', ') : board?.carrierName ?? null,
    customerRateCents,
    carrierRateCents,
    profitCents: customerRateCents != null && carrierRateCents != null ? customerRateCents - carrierRateCents : null,
  }
}
