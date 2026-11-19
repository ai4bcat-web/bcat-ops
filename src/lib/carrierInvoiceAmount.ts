/**
 * Carrier invoice amount: what one carrier's lines have to say for the bill to total what the carrier invoiced.
 *
 * AP records a carrier's invoice date and, in the same step, the amount on that invoice. The amount lives in the
 * assignment's CARRIER charge lines (the bill snapshots them), so a different amount means a different rate. This
 * moves the linehaul line and leaves every other line as it was; the pricing math is `priceCharges`, the same
 * arithmetic the Financials grid and the server use, so what this returns is what `UPDATE_CARRIER_CHARGES` stores.
 */
import { priceCharges, type ChargeContext } from './shipmentCharges'
import type { LoadChargeInput, LoadChargeRecord } from '../types/tms'

export type RepriceResult =
  | { ok: true; charges: LoadChargeInput[]; fromCents: number; toCents: number }
  | { ok: false; message: string }

/** A stored line as the editor's draft: the shape `UPDATE_CARRIER_CHARGES` takes back. */
export function chargeToDraft(charge: LoadChargeRecord): LoadChargeInput {
  return {
    side: charge.side,
    code: charge.code,
    label: charge.label ?? null,
    calculatedBy: charge.calculatedBy,
    rateCents: charge.rateCents,
    count: charge.count ?? 1,
    isRate: charge.isRate,
    sortOrder: charge.sortOrder,
    note: charge.note ?? null,
    orderId: charge.orderId ?? null,
    loadId: charge.loadId ?? null,
    loadCarrierId: charge.loadCarrierId ?? null,
    release: charge.release ?? null,
  }
}

function totalOf(lines: LoadChargeInput[], ctx: ChargeContext): number {
  return priceCharges(lines, ctx).reduce((sum, line) => sum + line.amountCents, 0)
}

/** The line the invoice amount moves: the linehaul, else the first other rate line. */
function rateLineIndex(lines: LoadChargeInput[]): number {
  const rated = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.isRate)
  const linehaul = rated.find(({ line }) => line.code.toUpperCase() === 'LINEHAUL')
  const first = linehaul ?? rated.find(({ line }) => line.code.toUpperCase() !== 'FSC') ?? rated[0]
  return first ? first.index : -1
}

const WHOLE = 'Use Adjust carrier pay to change the individual charges.'

/**
 * `carrierLines` are the assignment's own CARRIER lines. The result is those lines with the rate line made a flat
 * amount that brings the total to `targetCents`; when the total is already there they come back untouched.
 */
export function repriceToInvoiceAmount(
  carrierLines: readonly LoadChargeRecord[],
  targetCents: number,
  ctx: ChargeContext = {},
): RepriceResult {
  if (!Number.isSafeInteger(targetCents) || targetCents <= 0) return { ok: false, message: 'Enter the amount on the carrier’s invoice.' }
  const drafts = carrierLines
    .slice()
    .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(chargeToDraft)
  const fromCents = totalOf(drafts, ctx)
  if (fromCents === targetCents) return { ok: true, charges: drafts, fromCents, toCents: targetCents }

  const index = rateLineIndex(drafts)
  if (index < 0) return { ok: false, message: `This carrier has no rate line to change. ${WHOLE}` }
  const withRate = (rateCents: number): LoadChargeInput[] =>
    drafts.map((line, i) => (i === index ? { ...line, calculatedBy: 'FLAT', count: 1, rateCents } : line))

  // A percent line moves with the rate, so the total is a straight line in the rate: read its slope from two points.
  const probe = 100_000
  const atZero = totalOf(withRate(0), ctx)
  const slope = (totalOf(withRate(probe), ctx) - atZero) / probe
  if (!(slope > 0)) return { ok: false, message: `The rate line does not move the total. ${WHOLE}` }
  if (targetCents < atZero) {
    return { ok: false, message: `The other charges on this carrier already add up to more than that. ${WHOLE}` }
  }
  const guess = Math.round((targetCents - atZero) / slope)
  for (const nudge of [0, -1, 1, -2, 2]) {
    const rateCents = guess + nudge
    if (rateCents >= 0 && totalOf(withRate(rateCents), ctx) === targetCents) {
      return { ok: true, charges: withRate(rateCents), fromCents, toCents: targetCents }
    }
  }
  return { ok: false, message: `The charges cannot be made to total that amount to the cent. ${WHOLE}` }
}
