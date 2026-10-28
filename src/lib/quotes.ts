/**
 * Quotes — one model, two sides, and the four questions every surface asks about one.
 *
 * 1. **Whose move is it?** `quoteState` is the only place that decides. The board,
 *    the detail page and the Lambda refusals all read the same answer, so a button
 *    a user can see is a button the server will honour.
 * 2. **What is it worth?** `priceQuoteLines` never does its own arithmetic: it hands
 *    the lines to `computeFinancials` and adds the advice around the number. A quote
 *    and the shipment it converts into are priced by the same code or they are not
 *    the same quote.
 * 3. **What may a stranger see?** `quotePublicView` builds the public page from an
 *    allow-list, field by field. A field added to `QuoteRecord` tomorrow cannot leak
 *    by being forgotten here, because nothing is copied wholesale.
 * 4. **Money is integer cents.** Nothing divides except the two places a human reads
 *    a percentage or a dollar sign.
 *
 * Imports are relative: `tmsShipmentActions` and `tracking-api` bundle this file by
 * path and the `@/` alias does not exist in the function build.
 */
import { formatInvoiceNumber, invoiceNumberFormatError } from './invoiceBuild'
import { priceCharges, computeFinancials } from './shipmentCharges'
import type { ChargeContext, FinancialTotals } from './shipmentCharges'
import { formatCents } from './tmsDirectory'
import type {
  ChargeSide,
  LoadChargeInput,
  OrderReference,
  PricingDefaults,
  QuoteLostReason,
  QuotePublicLine,
  QuotePublicStop,
  QuotePublicView,
  QuoteRecord,
  QuoteSettings,
  QuoteSide,
  QuoteStatus,
  QuotingDefaults,
  RateType,
  ShipmentMode,
} from '../types/tms'
import type { Stop } from '../types'

/** Every rung, in the order a quote climbs them. */
export const QUOTE_STATUSES: readonly QuoteStatus[] = [
  'DRAFT',
  'REQUESTED',
  'QUOTED',
  'SENT_COUNTER',
  'RECEIVED_REPLY',
  'RECEIVED_COUNTER',
  'WON',
  'LOST',
  'PASS',
  'CANCELED',
]

/** The rungs that carry the sparse `quoteOpen` marker. */
export const OPEN_QUOTE_STATUSES: readonly QuoteStatus[] = [
  'DRAFT',
  'REQUESTED',
  'QUOTED',
  'SENT_COUNTER',
  'RECEIVED_REPLY',
  'RECEIVED_COUNTER',
]

/** The rungs where `quoteOpen` is REMOVEd and nothing else may be written. */
export const CLOSED_QUOTE_STATUSES: readonly QuoteStatus[] = QUOTE_STATUSES.filter(
  (status) => !OPEN_QUOTE_STATUSES.includes(status),
)

export const LOST_REASONS: readonly QuoteLostReason[] = [
  'EXPIRED',
  'NO_RESPONSE',
  'TOO_HIGH',
  'TOO_SLOW',
  'TRUCK_NOT_AVAILABLE',
  'WITHDRAWN',
  'OTHER',
  'NO_REASON',
]

/**
 * What a public decline may say. EXPIRED and NO_RESPONSE are things we conclude
 * about somebody who said nothing — neither can arrive from a person who answered.
 */
export const PUBLIC_DECLINE_REASONS: readonly QuoteLostReason[] = LOST_REASONS.filter(
  (reason) => reason !== 'EXPIRED' && reason !== 'NO_RESPONSE',
)

/** The sell side's words for each rung. */
export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  DRAFT: 'Draft',
  REQUESTED: 'Requested',
  QUOTED: 'Quoted',
  SENT_COUNTER: 'Counter sent',
  RECEIVED_REPLY: 'Reply received',
  RECEIVED_COUNTER: 'Counter received',
  WON: 'Won',
  LOST: 'Lost',
  PASS: 'Passed',
  CANCELED: 'Canceled',
}

/** The same ten rungs in the buy side's words: a carrier is booked, not won. */
export const OFFER_STATUS_LABEL: Record<QuoteStatus, string> = {
  DRAFT: 'Draft',
  REQUESTED: 'Request sent',
  QUOTED: 'Offer in',
  SENT_COUNTER: 'Counter sent',
  RECEIVED_REPLY: 'Reply received',
  RECEIVED_COUNTER: 'Counter received',
  WON: 'Booked',
  LOST: 'Not booked',
  PASS: 'Carrier pass',
  CANCELED: 'Canceled',
}

export function isOpenQuoteStatus(status: QuoteStatus): boolean {
  return OPEN_QUOTE_STATUSES.includes(status)
}

const HOUR_MS = 3_600_000
/** Hours a customer gets to answer, when neither the customer nor the org has said. */
export const DEFAULT_HOURS_TO_QUOTE = 24
/** Hours a carrier gets to answer, when the org has not said. */
export const DEFAULT_OFFER_EXPIRY_HOURS = 24
/** No link is ever minted dead: a pickup already past still leaves an hour on it. */
const MINIMUM_OFFER_HOURS = 1

function positiveHours(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Everything a surface needs to know about one quote right now. `rung` and
 * `expired` describe it; the rest are the only verbs it will accept.
 */
export interface QuoteState {
  rung: QuoteStatus
  expired: boolean
  whoseMove: 'US' | 'THEM' | 'NONE'
  canSend: boolean
  canCounter: boolean
  canAccept: boolean
  canConvert: boolean
  canRestore: boolean
  canEdit: boolean
  canCancel: boolean
  canMarkLost: boolean
}

export type QuoteStateInput = Pick<
  QuoteRecord,
  'side' | 'status' | 'expiresAt' | 'amountCents' | 'counterCents'
>

/**
 * The one reading of a quote. Expiry only bites on the two rungs where our number
 * is sitting with somebody else: a counter they sent us does not go stale while we
 * think about it, and a draft has no clock at all.
 *
 * An expired quote is re-sendable rather than convertible — the number went out
 * with an hour on it, and the honest move is to mint a new link, not to book
 * freight against a promise that lapsed.
 */
export function quoteState(quote: QuoteStateInput, nowIso: string): QuoteState {
  const rung = quote.status
  const open = isOpenQuoteStatus(rung)
  const onTheClock = rung === 'QUOTED' || rung === 'SENT_COUNTER'
  const expiresAt = timeOf(quote.expiresAt)
  const now = timeOf(nowIso)
  const expired = onTheClock && expiresAt !== null && now !== null && expiresAt <= now

  let whoseMove: 'US' | 'THEM' | 'NONE' = 'NONE'
  if (open) {
    const theirs = onTheClock || (rung === 'REQUESTED' && quote.side === 'BUY')
    whoseMove = theirs ? 'THEM' : 'US'
  }

  const counterCents = quote.counterCents ?? 0

  return {
    rung,
    expired,
    whoseMove,
    canSend: rung === 'DRAFT' || rung === 'REQUESTED' || expired,
    canCounter: rung === 'RECEIVED_COUNTER',
    canAccept: rung === 'RECEIVED_COUNTER' && counterCents > 0,
    canConvert:
      !expired &&
      quote.amountCents > 0 &&
      (rung === 'QUOTED' || rung === 'SENT_COUNTER' || rung === 'RECEIVED_REPLY'),
    canRestore: rung === 'LOST' || rung === 'CANCELED',
    canEdit: rung === 'DRAFT' || rung === 'REQUESTED',
    canCancel: open,
    canMarkLost: open,
  }
}

/**
 * When this round's link stops working.
 *
 * SELL takes the customer's own hours first — a shipper who has to go to committee
 * is quoted for longer than one who answers from a phone — then the org's, then a
 * day. BUY is capped at the first pickup: an offer that outlives the load it covers
 * invites a carrier to accept freight that left without them. The floor of one hour
 * is the other half of that: a pickup already in the past must not mint a dead link.
 */
export function quoteExpiry(
  side: QuoteSide,
  sentAtIso: string,
  customerQuotingDefaults: QuotingDefaults | null,
  settings: QuoteSettings | null,
  firstPickupAppt: string | null,
): string {
  const sentAt = timeOf(sentAtIso)
  if (sentAt === null) throw new Error('A quote expiry needs the time the quote was sent')

  if (side === 'SELL') {
    const hours =
      positiveHours(customerQuotingDefaults?.hoursToQuote) ??
      positiveHours(settings?.hoursToQuote) ??
      DEFAULT_HOURS_TO_QUOTE
    return new Date(sentAt + hours * HOUR_MS).toISOString()
  }

  const hours = positiveHours(settings?.offerExpiryHours) ?? DEFAULT_OFFER_EXPIRY_HOURS
  const pickup = timeOf(firstPickupAppt)
  let at = sentAt + hours * HOUR_MS
  if (pickup !== null && pickup < at) at = pickup
  return new Date(Math.max(at, sentAt + MINIMUM_OFFER_HOURS * HOUR_MS)).toISOString()
}

/**
 * One thing worth saying about a price before it goes out. `adminOnly` marks the
 * two a rep may not be allowed to overrule — the gate itself lives in the Lambda,
 * which reads `quoteBelowMinMarginAdminOnly`.
 */
export interface QuotePricingWarning {
  key: string
  message: string
  adminOnly: boolean
}

export type QuotePricingResult = FinancialTotals & { warnings: QuotePricingWarning[] }

/** Basis points as a human reads them: 1_250 is "12.5%". */
function percentOf(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

/**
 * The quote's numbers, which are the shipment's numbers, plus what to say about
 * them. Every total comes back from `computeFinancials` untouched — this function
 * adds warnings and nothing else, so a quote and the shipment it becomes can never
 * disagree about what the freight is worth.
 */
export function priceQuoteLines(
  lines: LoadChargeInput[],
  ctx: ChargeContext,
  pricing: PricingDefaults | null,
  marginFloorBps: number | null,
  customerPricing?: { minProfitCents?: number | null; maxProfitCents?: number | null } | null,
): QuotePricingResult {
  const totals = computeFinancials(lines, ctx, pricing, marginFloorBps)
  const warnings: QuotePricingWarning[] = []

  const floorBps = marginFloorBps != null && marginFloorBps > 0 ? marginFloorBps : null
  if (floorBps !== null && totals.revenueCents > 0 && totals.marginBps < floorBps) {
    warnings.push({
      key: 'BELOW_MARGIN_FLOOR',
      message: `This quote makes ${percentOf(totals.marginBps)} margin, under the ${percentOf(floorBps)} floor.`,
      adminOnly: true,
    })
  }

  const minProfitCents = customerPricing?.minProfitCents ?? pricing?.minProfitCents ?? null
  if (minProfitCents != null && totals.profitCents < minProfitCents) {
    warnings.push({
      key: 'BELOW_MIN_PROFIT',
      message: `This quote makes $${formatCents(totals.profitCents)}, under the $${formatCents(minProfitCents)} this customer is quoted at.`,
      adminOnly: true,
    })
  }

  const maxProfitCents = customerPricing?.maxProfitCents ?? pricing?.maxProfitCents ?? null
  if (maxProfitCents != null && totals.profitCents > maxProfitCents) {
    warnings.push({
      key: 'ABOVE_MAX_PROFIT',
      message: `This quote makes $${formatCents(totals.profitCents)}, over the $${formatCents(maxProfitCents)} this customer is quoted at.`,
      adminOnly: false,
    })
  }

  if (totals.costCents > 0 && totals.costCents > totals.topSpendCents) {
    warnings.push({
      key: 'TOP_SPEND_EXCEEDED',
      message: `The carrier side is $${formatCents(totals.costCents)}, over the $${formatCents(totals.topSpendCents)} this quote can spend.`,
      adminOnly: false,
    })
  }

  return { ...totals, warnings }
}

const LINEHAUL_CODE = 'LINEHAUL'
const NEGATIVE_LINEHAUL_MESSAGE =
  "That counter is below this quote's accessorials — the line haul would be negative"
const UNREACHABLE_COUNTER_MESSAGE =
  'That counter cannot be matched exactly — a percentage line on this quote moves with the line haul'
/** Enough rounds for a percentage line riding on the line haul to settle. */
const MAX_ABSORB_ROUNDS = 32
/** How far the line haul is nudged to learn what one cent of it is worth. */
const PROBE_CENTS = 10_000

/** The line a counter is absorbed into: the customer's line haul, or the first rate line. */
function linehaulIndex(lines: LoadChargeInput[]): number {
  const linehaul = lines.findIndex(
    (line) => line.side === 'CUSTOMER' && line.code.trim().toUpperCase() === LINEHAUL_CODE,
  )
  if (linehaul !== -1) return linehaul
  return lines.findIndex((line) => line.isRate)
}

/**
 * What one side of the quote prices to. A counter is a number on one side's total —
 * a sell quote's `amountCents` is its CUSTOMER lines, and a sell quote is allowed
 * to carry a CARRIER estimate besides, which no customer counter has anything to
 * say about.
 */
function pricedTotal(lines: LoadChargeInput[], ctx: ChargeContext, side: ChargeSide): number {
  let total = 0
  for (const priced of priceCharges(lines, ctx)) {
    if (priced.side === side) total += priced.amountCents
  }
  return total
}

function withLinehaul(lines: LoadChargeInput[], index: number, amountCents: number): LoadChargeInput[] {
  const next = lines.slice()
  next[index] = { ...next[index], calculatedBy: 'FLAT', rateCents: amountCents, count: 1 }
  return next
}

/**
 * Take their number and leave the accessorials alone.
 *
 * Only the line haul moves, and it moves as a flat amount: a counter is a price,
 * not a new per-mile rate, and detention at $75/hr does not become cheaper because
 * the shipper talked us down. A percentage line (fuel on the line haul) rides along,
 * so the step is scaled by what one cent of line haul is actually worth rather than
 * applied blind — otherwise a 15% fuel line would overshoot every time.
 */
export function absorbCounter(
  lines: LoadChargeInput[],
  counterCents: number,
  ctx: ChargeContext = {},
): LoadChargeInput[] {
  if (!Number.isSafeInteger(counterCents) || counterCents < 0) {
    throw new Error('A counter has to be a whole number of cents, and never negative')
  }

  let working = lines.map((line) => ({ ...line }))
  let index = linehaulIndex(working)
  if (index === -1) {
    working.unshift({
      side: 'CUSTOMER',
      code: LINEHAUL_CODE,
      calculatedBy: 'FLAT',
      rateCents: 0,
      count: 1,
      isRate: true,
      sortOrder: 0,
    })
    index = 0
  }

  // Flatten the line haul to whatever it is worth today: from here it is an amount.
  const side = working[index].side
  let amount = priceCharges(working, ctx)[index].amountCents
  working = withLinehaul(working, index, amount)
  let total = pricedTotal(working, ctx, side)

  const probe = pricedTotal(withLinehaul(working, index, amount + PROBE_CENTS), ctx, side)
  const gain = (probe - total) / PROBE_CENTS
  if (!(gain > 0)) {
    throw new Error('The line haul on this quote cannot absorb a counter — the total does not move with it')
  }

  for (let round = 0; round < MAX_ABSORB_ROUNDS && total !== counterCents; round += 1) {
    const needed = amount + Math.round((counterCents - total) / gain)
    if (needed < 0) throw new Error(NEGATIVE_LINEHAUL_MESSAGE)
    if (needed === amount) break
    amount = needed
    working = withLinehaul(working, index, amount)
    total = pricedTotal(working, ctx, side)
  }

  if (total !== counterCents) throw new Error(UNREACHABLE_COUNTER_MESSAGE)
  return working
}

export interface QuoteSiblingClose {
  id: string
  status: 'LOST' | 'CANCELED'
  lostReason: QuoteLostReason | null
}

/**
 * What happens to the rest of the round when one quote wins.
 *
 * A sibling that carried a price was beaten, and that is history worth keeping —
 * it is LOST, with the reason the side makes true: a carrier we did not book had a
 * truck somebody else got. A sibling nobody ever priced was never in the running,
 * so it is CANCELED with no reason at all rather than counted as a loss.
 */
export function closeSiblings(
  group: Pick<QuoteRecord, 'id' | 'status' | 'amountCents' | 'side'>[],
  winnerId: string,
): QuoteSiblingClose[] {
  const out: QuoteSiblingClose[] = []
  for (const quote of group) {
    if (quote.id === winnerId || !isOpenQuoteStatus(quote.status)) continue
    if (quote.amountCents > 0) {
      out.push({
        id: quote.id,
        status: 'LOST',
        lostReason: quote.side === 'BUY' ? 'TRUCK_NOT_AVAILABLE' : 'OTHER',
      })
    } else {
      out.push({ id: quote.id, status: 'CANCELED', lostReason: null })
    }
  }
  return out
}

const CHARGE_CODE_LABELS: Record<string, string> = {
  LINEHAUL: 'Line haul',
  FSC: 'Fuel surcharge',
  DETENTION: 'Detention',
  LAYOVER: 'Layover',
  TONU: 'Truck ordered not used',
  STOPOFF: 'Stop-off',
  STOP_OFF: 'Stop-off',
  LUMPER: 'Lumper',
  TARP: 'Tarp',
  REWEIGH: 'Reweigh',
  ACCESSORIAL: 'Accessorial',
}

/** A charge code as a customer reads it: `STOP_OFF` is "Stop-off", not a constant. */
export function humanChargeCode(code: string): string {
  const key = code.trim().toUpperCase()
  const known = CHARGE_CODE_LABELS[key]
  if (known) return known
  const words = key.replace(/[_-]+/g, ' ').toLowerCase().trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A stop with the facility, the address and the references taken off it: a quote
 * tells you which town, never which dock.
 */
function publicStop(stop: Stop): QuotePublicStop {
  const parts = (stop.city ?? '').split(',')
  return {
    type: stop.type,
    city: stop.address?.city?.trim() || parts[0]?.trim() || null,
    state: stop.address?.state?.trim() || parts[1]?.trim() || null,
    appt: stop.appt ?? null,
    apptType: stop.apptType ?? null,
    sequence: stop.sequence ?? 0,
  }
}

function orderedStops(stops: Stop[]): Stop[] {
  return [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

/** A carrier is shown where it loads and where it tips, not the milk run between. */
function endpointStops(stops: Stop[]): Stop[] {
  const ordered = orderedStops(stops)
  if (ordered.length === 0) return []
  const pickup = ordered.find((stop) => stop.type === 'pickup') ?? ordered[0]
  const delivery =
    [...ordered].reverse().find((stop) => stop.type === 'delivery') ?? ordered[ordered.length - 1]
  return pickup === delivery ? [pickup] : [pickup, delivery]
}

/** The customer's own lines, priced, each under a name a customer can read. */
function publicLines(quote: QuoteRecord): QuotePublicLine[] {
  const source = quote.lines ?? []
  const priced = priceCharges(source, { miles: quote.miles, weightLbs: quote.weightLbs })
  const out: QuotePublicLine[] = []
  source.forEach((line, at) => {
    if (line.side !== 'CUSTOMER') return
    out.push({
      label: line.label?.trim() || humanChargeCode(line.code),
      amountCents: priced[at].amountCents,
    })
  })
  return out
}

/** The offer fields the two "our number vs theirs" readings need. */
export type QuoteOfferNumbers = Pick<
  QuoteRecord,
  'status' | 'amountCents' | 'counterCents' | 'counterBy'
>

/**
 * What we are offering the carrier: our counter if we made one, else the row's
 * number. The public offer page and the Carrier tab both read this, so a dispatcher
 * and the carrier are always looking at the same money.
 */
export function ourOfferCents(quote: QuoteOfferNumbers): number {
  if (quote.counterBy === 'US' && quote.counterCents != null) return quote.counterCents
  return quote.amountCents
}

/**
 * The carrier's own last number, so both sides see what they said. Their counter
 * when they countered; otherwise the number on the row, which on the three rungs
 * where a carrier has spoken is the price they named. Null means they have not
 * named one yet.
 */
export function carrierLastNumber(quote: QuoteOfferNumbers): number | null {
  if (quote.counterBy === 'THEM' && quote.counterCents != null) return quote.counterCents
  const named =
    quote.status === 'QUOTED' ||
    quote.status === 'RECEIVED_COUNTER' ||
    quote.status === 'RECEIVED_REPLY'
  return named ? quote.amountCents : null
}

export interface QuotePublicViewOptions {
  brokerName: string
  termsText?: string | null
  showBookNow?: boolean
  nowIso: string
}

/**
 * What the public link may say — built field by field, never by copying the row.
 *
 * The sell page shows a customer their own freight and their own price: cities and
 * appointments, the lines behind the total, nothing about what we pay for it or who
 * hauls it. The buy page shows a carrier the lane, the equipment and our offer:
 * nothing about whose freight it is or what it sold for. Both rules are enforced by
 * what is written below rather than by anything removed afterwards.
 */
export function quotePublicView(quote: QuoteRecord, opts: QuotePublicViewOptions): QuotePublicView {
  const state = quoteState(quote, opts.nowIso)
  const awaiting: 'YOU' | 'US' | 'NONE' =
    state.whoseMove === 'THEM' ? 'YOU' : state.whoseMove === 'US' ? 'US' : 'NONE'
  const shared = {
    quoteNumber: quote.id,
    status: quote.status,
    brokerName: opts.brokerName,
    expiresAt: quote.expiresAt ?? null,
    expired: state.expired,
    awaiting,
    mode: quote.mode ?? null,
    equipmentType: quote.equipmentType ?? null,
    equipmentLengthFt: quote.equipmentLengthFt ?? null,
    commodity: quote.commodity ?? null,
    weightLbs: quote.weightLbs ?? null,
    miles: quote.miles ?? null,
    // On a BUY row this is the note we wrote for the carrier, not the customer's.
    message: quote.customerMessage?.trim() || null,
    terms: opts.termsText?.trim() || null,
    rounds: quote.rounds,
    generatedAt: opts.nowIso,
  }

  if (quote.side === 'SELL') {
    return {
      ...shared,
      side: 'SELL',
      stops: orderedStops(quote.stops ?? []).map(publicStop),
      amountCents: quote.amountCents,
      lines: publicLines(quote),
    }
  }

  return {
    ...shared,
    side: 'BUY',
    stops: endpointStops(quote.stops ?? []).map(publicStop),
    amountCents: ourOfferCents(quote),
    lines: [],
    bookNowRateCents: opts.showBookNow ? quote.bookNowRateCents ?? null : null,
    theirAmountCents: carrierLastNumber(quote),
  }
}

/** `Q{n:6}` — `{n}`/`{n:K}` and `{yyyy}` work exactly as they do on an invoice. */
export const DEFAULT_QUOTE_NUMBER_FORMAT = 'Q{n:6}'

const QUOTE_NUMBER_FORMAT_MESSAGE = 'The quote number format needs an {n} token'

/**
 * One quote number. The quote number is the row's id, so this is minted once from
 * the settings counter and never recomputed — a format changed next month renumbers
 * nothing that already exists.
 */
export function quoteNumber(format: string | null | undefined, n: number, dateIso = ''): string {
  const chosen = format?.trim() || DEFAULT_QUOTE_NUMBER_FORMAT
  return formatInvoiceNumber(chosen, { prefix: '', n, date: dateIso })
}

/**
 * A format with no counter would hand every quote the same id, and the id is the
 * row's key — the second quote of the day would fail its `attribute_not_exists`
 * Put. The settings card and the Lambda both refuse through this. A blank format is
 * not an error: it means the default.
 */
export function quoteNumberFormatError(format: string | null | undefined): string | null {
  const chosen = format?.trim()
  if (!chosen) return null
  return invoiceNumberFormatError(chosen) === null ? null : QUOTE_NUMBER_FORMAT_MESSAGE
}

/**
 * A quote again, for the week after next. The freight, the lines and the customer
 * come along; the conversation does not. No token above all: a duplicate that
 * carried the original's link would let one customer's answer land on two rows.
 */
export function duplicateQuote(
  quote: QuoteRecord,
  opts: { pickupAppt?: string | null },
): Partial<QuoteRecord> {
  const pickupAppt = opts.pickupAppt ?? null
  const stops = orderedStops(quote.stops ?? []).map((stop) =>
    pickupAppt && stop.type === 'pickup' && stop.sequence === 0 ? { ...stop, appt: pickupAppt } : { ...stop },
  )

  return {
    side: quote.side,
    status: 'DRAFT',
    quoteOpen: 'OPEN',
    duplicatedFromId: quote.id,
    rounds: 0,
    customerId: quote.customerId ?? null,
    customerName: quote.customerName ?? null,
    contactName: quote.contactName ?? null,
    contactEmail: quote.contactEmail ?? null,
    customerRepId: quote.customerRepId ?? null,
    carrierId: quote.carrierId ?? null,
    carrierName: quote.carrierName ?? null,
    carrierMc: quote.carrierMc ?? null,
    carrierEmail: quote.carrierEmail ?? null,
    divisionKey: quote.divisionKey ?? null,
    mode: quote.mode ?? null,
    rateType: quote.rateType ?? null,
    equipmentType: quote.equipmentType ?? null,
    equipmentLengthFt: quote.equipmentLengthFt ?? null,
    stops,
    laneKey: quote.laneKey ?? null,
    laneKey3: quote.laneKey3 ?? null,
    pickupAppt: pickupAppt ?? quote.pickupAppt ?? null,
    deliveryAppt: pickupAppt ? null : quote.deliveryAppt ?? null,
    commodity: quote.commodity ?? null,
    weightLbs: quote.weightLbs ?? null,
    miles: quote.miles ?? null,
    references: quote.references ? quote.references.map((reference) => ({ ...reference })) : null,
    lines: quote.lines ? quote.lines.map((line) => ({ ...line })) : null,
    amountCents: quote.amountCents,
    customerRateCents: quote.customerRateCents ?? null,
    targetBuyCents: quote.targetBuyCents ?? null,
    topSpendCents: quote.topSpendCents ?? null,
    marginBps: quote.marginBps ?? null,
    bookNowRateCents: quote.bookNowRateCents ?? null,
    customerMessage: quote.customerMessage ?? null,
    internalNotes: quote.internalNotes ?? null,
  }
}

/**
 * What this customer could owe us if every quote on the table lands: the open sell
 * quotes plus what is already outstanding. Buy rows are money we would pay, not
 * money we would be owed, so they never count — and neither does a quote nobody
 * has priced.
 */
export function projectedExposureCents(
  openQuotes: Pick<QuoteRecord, 'side' | 'status' | 'amountCents'>[],
  openReceivableCents: number,
): number {
  let total = openReceivableCents
  for (const quote of openQuotes) {
    if (quote.side !== 'SELL' || !isOpenQuoteStatus(quote.status)) continue
    if (quote.amountCents > 0) total += quote.amountCents
  }
  return total
}

/** The payload a won quote hands the shipment bodies, and nothing besides. */
export interface QuoteConvertInput {
  customerId: string
  mode: ShipmentMode | null
  rateType: RateType | null
  stops: Stop[]
  references: OrderReference[]
  lines: LoadChargeInput[]
  equipmentType: string | null
  equipmentLengthFt: number | null
  commodity: string | null
  weightLbs: number | null
  miles: number | null
  quoteId: string
  quoteNumber: string
  quoteAmountCents: number
  quoteNotes: string | null
}

/**
 * The quote, as the shipment bodies want it. The four `quote*` fields are the trail
 * back: an order that came from a quote says which one and at what number, so a
 * later re-price can be read against what was sold.
 */
export function convertInput(quote: QuoteRecord): QuoteConvertInput {
  const customerId = quote.customerId?.trim()
  if (!customerId) {
    throw new Error('This quote has no customer — pick one before it can become a shipment')
  }
  const stops = orderedStops(quote.stops ?? [])
  if (stops.length === 0) {
    throw new Error('This quote has no stops — add a pickup and a delivery before converting it')
  }

  return {
    customerId,
    mode: quote.mode ?? null,
    rateType: quote.rateType ?? null,
    stops: stops.map((stop) => ({ ...stop })),
    references: (quote.references ?? []).map((reference) => ({ ...reference })),
    lines: (quote.lines ?? []).map((line) => ({ ...line })),
    equipmentType: quote.equipmentType ?? null,
    equipmentLengthFt: quote.equipmentLengthFt ?? null,
    commodity: quote.commodity ?? null,
    weightLbs: quote.weightLbs ?? null,
    miles: quote.miles ?? null,
    quoteId: quote.id,
    quoteNumber: quote.id,
    quoteAmountCents: quote.amountCents,
    quoteNotes: quote.internalNotes?.trim() || null,
  }
}
