/**
 * What a load must carry from the day it is built so it can be factored the moment it
 * reaches Ready to invoice (Ryne, 2026-11-14).
 *
 * OTR takes eleven fields (`OTR_REQUIRED_FIELDS`). Three come from the invoice itself
 * (number, date, amount) and exist once it is generated; the rest are known when the
 * shipment is booked: the customer's PO, the MC when the customer is a broker, and the city, state and ZIP at
 * each end of the run. A rate of zero would be an invoice of zero. Those, and the
 * customer's billing method (unset, release to billing is refused), are what this checks.
 *
 * What only arrives later — delivery, the POD, a signed rate confirmation, the carrier
 * and its pay — is the release gate's business (./releaseGate) and is not asked for here.
 *
 * One pure function, called by the shipment form (as validation) and by SAVE_ORDER_FORM
 * on a strict save (as a refusal), so the two cannot disagree about what is missing.
 * Relative imports only: the shipment Lambda bundles this file by path.
 */
import { mcRequiredForFactoring, type CustomerType, type FactorBillingCustomer } from './factorBilling'
import { ordered, placeOf } from './factorHandoff'
import type { Stop } from '../types'

export type FactorGapCode =
  | 'PO_MISSING'
  | 'RATE_MISSING'
  | 'PICKUP_CITY'
  | 'PICKUP_STATE'
  | 'PICKUP_ZIP'
  | 'DELIVERY_CITY'
  | 'DELIVERY_STATE'
  | 'DELIVERY_ZIP'
  | 'CUSTOMER_MC'
  | 'BILLING_METHOD'

export interface FactorGap {
  code: FactorGapCode
  /** The exact sentence shown in the form and in the server's refusal. */
  message: string
}

export interface FactorPlace {
  city?: string | null
  state?: string | null
  zip?: string | null
}

export interface FactorReadyInput {
  /** Null when the shipment only has a typed customer name; the customer checks wait for a link. */
  customer: (FactorBillingCustomer & { name?: string | null; mcNumber?: string | null; customerType?: CustomerType | null }) | null
  poNumber: string | null | undefined
  /** The customer's total in cents (what the invoice will bill). */
  customerRateCents: number | null | undefined
  /** First pick up and last delivery; null when the route has none. */
  pickup: FactorPlace | null
  delivery: FactorPlace | null
}

const text = (v: string | null | undefined): string => (v ?? '').trim()
const ZIP = /^\d{5}(-?\d{4})?$/
const STATE = /^[A-Za-z]{2}$/

function placeGaps(place: FactorPlace | null, end: 'PICKUP' | 'DELIVERY'): FactorGap[] {
  const label = end === 'PICKUP' ? 'Pick Up' : 'Consignee'
  const gaps: FactorGap[] = []
  if (!text(place?.city)) gaps.push({ code: `${end}_CITY`, message: `${label} needs a city — OTR needs it to factor the load.` })
  if (!STATE.test(text(place?.state))) gaps.push({ code: `${end}_STATE`, message: `${label} needs a two-letter state — OTR needs it to factor the load.` })
  if (!ZIP.test(text(place?.zip))) gaps.push({ code: `${end}_ZIP`, message: `${label} needs a ZIP code — OTR needs it to factor the load.` })
  return gaps
}

/** Everything a new load is missing for factoring, in the order the form shows it. Empty = factor-ready at booking. */
export function factorGapsAtCreate(input: FactorReadyInput): FactorGap[] {
  const gaps: FactorGap[] = []
  const { customer } = input
  if (customer) {
    const name = text(customer.name) || 'This customer'
    if (customer.billingMethod !== 'FACTOR' && customer.billingMethod !== 'MANUAL' && customer.factored !== true) {
      gaps.push({ code: 'BILLING_METHOD', message: `${name} has no billing method. Set Factor or Manual on the customer record.` })
    }
    // Brokers only (Ryne 2026-11-14): a factored shipper has no MC to give.
    if (mcRequiredForFactoring(customer) && !text(customer.mcNumber)) {
      gaps.push({ code: 'CUSTOMER_MC', message: `${name} has no MC number. Add it on the customer record — OTR looks the broker up by MC.` })
    }
  }
  if (!text(input.poNumber)) gaps.push({ code: 'PO_MISSING', message: 'Enter the customer ref (PO) — OTR needs a PO number to factor the load.' })
  if (!((input.customerRateCents ?? 0) > 0)) gaps.push({ code: 'RATE_MISSING', message: 'Enter the customer rate — OTR buys the invoice for that amount.' })
  gaps.push(...placeGaps(input.pickup, 'PICKUP'), ...placeGaps(input.delivery, 'DELIVERY'))
  return gaps
}

/** The refusal SAVE_ORDER_FORM throws, or null. */
export function factorGapsError(gaps: readonly FactorGap[]): string | null {
  if (gaps.length === 0) return null
  return `Not ready to factor: ${gaps.map((g) => g.message).join(' ')}`
}

/** The customer's PO from an order's references: code PO, on a reference the customer may see (as the invoice reads it). */
export function orderPoNumber(references: ReadonlyArray<{ code?: string | null; value?: string | null; visibility?: string | null }> | null | undefined): string | null {
  for (const ref of references ?? []) {
    if (text(ref.code).toUpperCase() !== 'PO') continue
    if (ref.visibility !== 'CUSTOMER' && ref.visibility !== 'ALL') continue
    const value = text(ref.value)
    if (value) return value
  }
  return null
}

/** First pick up and last delivery, read the way the factoring queue row reads them. */
export function routeEnds(stops: Stop[] | null | undefined): { pickup: FactorPlace | null; delivery: FactorPlace | null } {
  const picks = ordered(stops, 'pickup')
  const drops = ordered(stops, 'delivery')
  return {
    pickup: picks.length ? placeOf(picks[0]) : null,
    delivery: drops.length ? placeOf(drops[drops.length - 1]) : null,
  }
}
