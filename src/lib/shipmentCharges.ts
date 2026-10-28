/**
 * Charge math for a shipment — MVMNT's FinancialLineItem grid, in one place.
 *
 * Every line is `rate × something`, and which something is decided by the charge
 * code's `calculatedBy`. The two money columns a broker actually steers by are
 * derived from those lines, never typed in:
 *
 *   Customer Rate / Carrier Rate = linehaul + fuel surcharge on that side
 *   Revenue / Cost               = every line on that side, accessorials included
 *   Profit = Revenue − Cost, Margin = Profit ÷ Revenue
 *
 * Imports are relative and type-only on purpose: the tmsShipmentActions Lambda
 * bundles this file by path, so a `@/` alias here would break the function build.
 * Money is integer cents everywhere; percentages are basis points.
 */
import type { ChargeCalc, ChargeSide, PricingDefaults } from '../types/tms'

/**
 * The codes that make up the Rate rather than an accessorial. Stored per line as
 * `isRate` so a re-coded charge keeps the classification it was saved with; this
 * list is what the server stamps that flag from.
 */
export const RATE_CODES = ['LINEHAUL', 'FSC'] as const

export function isRateCode(code: string): boolean {
  return (RATE_CODES as readonly string[]).includes(code.toUpperCase())
}

/** The minimum of a charge line the math needs. Stored rows and editor drafts both fit. */
export interface ChargeLineInput {
  side: ChargeSide
  code: string
  calculatedBy: ChargeCalc
  rateCents: number
  count?: number | null
  isRate: boolean
}

/**
 * What the line is measured against. `sideRateBaseCents` is only read by PERCENT
 * lines; `priceCharges` fills it in per side, so callers rarely pass it.
 */
export interface ChargeContext {
  miles?: number | null
  weightLbs?: number | null
  sideRateBaseCents?: number | null
}

export interface PricedCharge extends ChargeLineInput {
  amountCents: number
}

export interface FinancialTotals {
  customerRateCents: number
  revenueCents: number
  carrierRateCents: number
  costCents: number
  profitCents: number
  /** Profit ÷ Revenue in basis points. Zero revenue yields 0, never Infinity/NaN. */
  marginBps: number
  /** The most we may pay carriers on this shipment and still clear the margin floor. */
  topSpendCents: number
  /** What we should aim to buy at under the customer's pricing defaults; null when unset. */
  targetBuyCents: number | null
  lines: PricedCharge[]
}

/**
 * What one line is worth. Rounds once, at the end, so a per-cwt line on an odd
 * weight lands on a whole cent instead of carrying a fraction into the totals.
 */
export function chargeAmount(line: ChargeLineInput, ctx: ChargeContext = {}): number {
  const rate = line.rateCents || 0
  if (line.calculatedBy === 'PER_MILE') return Math.round(rate * (ctx.miles ?? 0))
  if (line.calculatedBy === 'PER_CWT') return Math.round((rate * (ctx.weightLbs ?? 0)) / 100)
  if (line.calculatedBy === 'PERCENT') return Math.round(((ctx.sideRateBaseCents ?? 0) * rate) / 10000)
  return Math.round(rate * (line.count ?? 1))
}

/**
 * The base a PERCENT line on this side is a percentage of: the side's Rate lines.
 *
 * A PERCENT line that is itself flagged as Rate contributes nothing to the base —
 * otherwise the base would depend on itself. That keeps the math total without
 * rejecting a line somebody coded that way.
 */
export function rateBaseCents(lines: ChargeLineInput[], side: ChargeSide, ctx: ChargeContext = {}): number {
  let base = 0
  for (const line of lines) {
    if (line.side !== side || !line.isRate) continue
    base += chargeAmount(line, { miles: ctx.miles, weightLbs: ctx.weightLbs, sideRateBaseCents: 0 })
  }
  return base
}

/** Every line with its computed amount, each side's PERCENT base resolved first. */
export function priceCharges(lines: ChargeLineInput[], ctx: ChargeContext = {}): PricedCharge[] {
  const base: Record<ChargeSide, number> = {
    CUSTOMER: rateBaseCents(lines, 'CUSTOMER', ctx),
    CARRIER: rateBaseCents(lines, 'CARRIER', ctx),
  }
  return lines.map((line) => ({
    ...line,
    amountCents: chargeAmount(line, {
      miles: ctx.miles,
      weightLbs: ctx.weightLbs,
      sideRateBaseCents: base[line.side],
    }),
  }))
}

/**
 * The totals box. `pricing` is the customer's pricing defaults (falling back to the
 * org's) and `marginFloorBps` the org floor; both only affect the two advisory
 * numbers — top spend and target buy are warnings, never gates.
 */
export function computeFinancials(
  lines: ChargeLineInput[],
  ctx: ChargeContext = {},
  pricing: PricingDefaults | null = null,
  marginFloorBps: number | null = null,
): FinancialTotals {
  const priced = priceCharges(lines, ctx)

  let customerRateCents = 0
  let revenueCents = 0
  let carrierRateCents = 0
  let costCents = 0
  for (const line of priced) {
    if (line.side === 'CUSTOMER') {
      revenueCents += line.amountCents
      if (line.isRate) customerRateCents += line.amountCents
    } else {
      costCents += line.amountCents
      if (line.isRate) carrierRateCents += line.amountCents
    }
  }

  const profitCents = revenueCents - costCents
  const marginBps = revenueCents === 0 ? 0 : Math.round((profitCents * 10000) / revenueCents)

  // An explicit minimum profit beats the percentage floor: a customer with a $150
  // floor wants $150 on a $400 load, not 15% of it.
  const floorCents = pricing?.minProfitCents != null
    ? pricing.minProfitCents
    : Math.round((revenueCents * (marginFloorBps ?? 0)) / 10000)

  return {
    customerRateCents,
    revenueCents,
    carrierRateCents,
    costCents,
    profitCents,
    marginBps,
    topSpendCents: revenueCents - floorCents,
    targetBuyCents: targetBuy(revenueCents, pricing),
    lines: priced,
  }
}

/**
 * What to buy at under the customer's pricing mode. MARGIN takes the percentage off
 * the sell price, MARKUP treats it as applied to the buy price, PROFIT is a flat
 * dollar spread. Null whenever the mode's input is not configured — a missing
 * default must show as blank, not as a target of the full revenue.
 */
function targetBuy(revenueCents: number, pricing: PricingDefaults | null): number | null {
  if (!pricing) return null
  if (pricing.mode === 'PROFIT') {
    return pricing.defaultProfitCents == null ? null : revenueCents - pricing.defaultProfitCents
  }
  const bps = pricing.defaultBps
  if (bps == null) return null
  if (pricing.mode === 'MARKUP') {
    return bps <= -10000 ? null : Math.round((revenueCents * 10000) / (10000 + bps))
  }
  return Math.round((revenueCents * (10000 - bps)) / 10000)
}
