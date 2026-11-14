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
import { isFactorBilled, mcRequiredForFactoring, type CustomerType, type FactorBillingCustomer } from './factorBilling'
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

/**
 * The PO a load factors under: the order's customer-visible PO reference, else the shipment's Customer Ref
 * (the header field, which the form mirrors onto the load as `tmsId` and reads back from there when the
 * order has no PO reference — shipment 20000's shape). PO reference first, Customer Ref second.
 */
export function factoringPoNumber(
  references: Parameters<typeof orderPoNumber>[0],
  customerRef: string | null | undefined,
): string | null {
  const fallback = text(customerRef)
  return orderPoNumber(references) ?? (fallback && fallback.toUpperCase() !== 'N/A' ? fallback : null)
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

/** Short names for a flag: "Missing for factoring: PO, Pick Up ZIP". */
export const FACTOR_GAP_LABEL: Record<FactorGapCode, string> = {
  PO_MISSING: 'PO',
  RATE_MISSING: 'Customer rate',
  PICKUP_CITY: 'Pick Up city',
  PICKUP_STATE: 'Pick Up state',
  PICKUP_ZIP: 'Pick Up ZIP',
  DELIVERY_CITY: 'Consignee city',
  DELIVERY_STATE: 'Consignee state',
  DELIVERY_ZIP: 'Consignee ZIP',
  CUSTOMER_MC: 'Customer MC #',
  BILLING_METHOD: 'Billing method',
}

/**
 * The same gaps for a load that already exists (Ryne 2026-11-14): active, in Load Review or past it.
 * Only a factor-billed customer's load is flagged; any other load answers []. Derived every time it is
 * read, never stored, so a fixed field clears the flag on the next read.
 */
export function factorGapsForLoad(input: FactorReadyInput): FactorGap[] {
  if (!isFactorBilled(input.customer)) return []
  return factorGapsAtCreate(input)
}

/** "Missing for factoring: PO, Pick Up ZIP"; empty when nothing is missing. */
export function factorGapSummary(codes: readonly FactorGapCode[]): string {
  if (codes.length === 0) return ''
  return `Missing for factoring: ${codes.map((c) => FACTOR_GAP_LABEL[c]).join(', ')}`
}

/** What a customer record we factor must carry: a broker needs an MC. Null when it is fine. */
export function customerMcRequiredError(customer: FactorBillingCustomer & { mcNumber?: string | null; customerType?: CustomerType | null }): string | null {
  if (!mcRequiredForFactoring(customer)) return null
  return text(customer.mcNumber) ? null : 'Enter the MC number — it is required for every broker we factor (OTR looks the broker up by MC).'
}

/** A customer we factor whose type nobody has set: flagged, never blocked (Ryne 2026-11-14). */
export function customerNeedsType(customer: FactorBillingCustomer & { customerType?: CustomerType | null }): boolean {
  return isFactorBilled(customer) && !customer.customerType
}

export type CustomerFactorFlag = 'MISSING_MC' | 'NEEDS_TYPE'

export const CUSTOMER_FACTOR_FLAG_LABEL: Record<CustomerFactorFlag, string> = {
  MISSING_MC: 'Missing MC — required for factoring',
  NEEDS_TYPE: 'Customer type not set (Broker / Shipper)',
}

/**
 * What a customer we factor still owes its record, derived (never stored): a broker without an MC, or a type nobody set.
 * Null for a manually billed customer or a complete one.
 */
export function customerFactorFlag(customer: FactorBillingCustomer & { mcNumber?: string | null; customerType?: CustomerType | null }): CustomerFactorFlag | null {
  if (customerMcRequiredError(customer)) return 'MISSING_MC'
  if (customerNeedsType(customer)) return 'NEEDS_TYPE'
  return null
}
