/**
 * Pure projections behind `/quotes` and `/rates`. Everything here decides; the pages
 * and dialogs only draw. The split matters for the same reason it does in AP: which
 * rung a row belongs on, what the board's totals say and whether a link has lapsed
 * are all assertions somebody has to be able to make without a browser.
 *
 * Nothing in this file reaches a network or a clock of its own — every function that
 * needs "now" is handed it, so a test pins the hour and the page passes one clock to
 * the whole screen. The status machine itself is `quoteState` in `@/lib/quotes`: this
 * module never compares a status to a string to decide what may be done.
 */
import { laneKey3For, laneKeyFor } from '@/lib/laneKey'
import { OFFER_STATUS_LABEL, QUOTE_STATUS_LABEL, isOpenQuoteStatus, quoteState } from '@/lib/quotes'
import type { Stop } from '@/types'
import type { QuoteLostReason, QuoteRecord } from '@/types/tms'

export type QuoteTabKey = 'to-price' | 'sent' | 'replies' | 'drafts' | 'won-lost' | 'offers'

export const QUOTE_TABS: { key: QuoteTabKey; label: string }[] = [
  { key: 'to-price', label: 'To price' },
  { key: 'sent', label: 'Sent' },
  { key: 'replies', label: 'Replies' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'won-lost', label: 'Won / Lost' },
  { key: 'offers', label: 'Carrier offers' },
]

export const LOST_REASON_LABEL: Record<QuoteLostReason, string> = {
  EXPIRED: 'Expired',
  NO_RESPONSE: 'No response',
  TOO_HIGH: 'Price too high',
  TOO_SLOW: 'Answered too slowly',
  TRUCK_NOT_AVAILABLE: 'No truck available',
  WITHDRAWN: 'We withdrew',
  OTHER: 'Other',
  NO_REASON: 'No reason given',
}

/** A quote's rung in the words of its own side: a carrier is booked, not won. */
export function statusLabel(quote: Pick<QuoteRecord, 'side' | 'status'>): string {
  return quote.side === 'BUY' ? OFFER_STATUS_LABEL[quote.status] : QUOTE_STATUS_LABEL[quote.status]
}

/** Newest quote date first, then by number, so a tab's order never depends on the read. */
function byDateDesc(rows: readonly QuoteRecord[]): QuoteRecord[] {
  return [...rows].sort((a, b) => b.quoteDate.localeCompare(a.quoteDate) || b.id.localeCompare(a.id))
}

/**
 * Which tab each row falls on. `open` is the sparse worklist read (both sides); `closed`
 * is one month's rows, which is the only place a WON or LOST quote can come from.
 *
 * The buy side never appears on a sell tab: an offer out with a carrier is not a quote
 * waiting on a customer, and a board that mixed them would double-count the money.
 */
export function splitQuoteTabs(
  open: readonly QuoteRecord[],
  closed: readonly QuoteRecord[],
): Record<QuoteTabKey, QuoteRecord[]> {
  const sell = open.filter((q) => q.side === 'SELL')
  const buy = open.filter((q) => q.side === 'BUY')
  const inTab = (statuses: readonly QuoteRecord['status'][]) =>
    byDateDesc(sell.filter((q) => statuses.includes(q.status)))

  return {
    'to-price': inTab(['REQUESTED']),
    sent: inTab(['QUOTED', 'SENT_COUNTER']),
    replies: inTab(['RECEIVED_REPLY', 'RECEIVED_COUNTER']),
    drafts: inTab(['DRAFT']),
    'won-lost': byDateDesc(closed.filter((q) => q.side === 'SELL' && !isOpenQuoteStatus(q.status))),
    offers: byDateDesc(buy),
  }
}

export function quoteTabCounts(rows: Record<QuoteTabKey, QuoteRecord[]>): Record<QuoteTabKey, number> {
  return {
    'to-price': rows['to-price'].length,
    sent: rows.sent.length,
    replies: rows.replies.length,
    drafts: rows.drafts.length,
    'won-lost': rows['won-lost'].length,
    offers: rows.offers.length,
  }
}

export interface QuoteTotals {
  /** Σ of every open sell quote that carries a number — what is on the table. */
  openCents: number
  openCount: number
  wonCents: number
  wonCount: number
  lostCount: number
  /** Won ÷ decided, as whole percent. A month that decided nothing is 0, never NaN. */
  winRatePct: number
  /** Median hours from our send to their answer; null when nobody has answered. */
  medianReplyHours: number | null
}

const HOUR_MS = 3_600_000

function hoursBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const start = from ? Date.parse(from) : NaN
  const end = to ? Date.parse(to) : NaN
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return (end - start) / HOUR_MS
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * The strip above the board. The open figure comes off the live worklist; everything
 * else comes off the month that is selected, so "won this month" and the win rate are
 * answers about the same set of rows rather than two different windows.
 */
export function quoteTotals(
  open: readonly QuoteRecord[],
  monthRows: readonly QuoteRecord[],
): QuoteTotals {
  let openCents = 0
  let openCount = 0
  for (const quote of open) {
    if (quote.side !== 'SELL' || !isOpenQuoteStatus(quote.status)) continue
    openCount += 1
    openCents += quote.amountCents
  }

  let wonCents = 0
  let wonCount = 0
  let lostCount = 0
  const replies: number[] = []
  for (const quote of monthRows) {
    if (quote.side !== 'SELL') continue
    if (quote.status === 'WON') {
      wonCount += 1
      wonCents += quote.amountCents
    } else if (quote.status === 'LOST') {
      lostCount += 1
    }
    const hours = hoursBetween(quote.sentAt, quote.respondedAt)
    if (hours !== null) replies.push(hours)
  }

  const decided = wonCount + lostCount
  const hours = median(replies)

  return {
    openCents,
    openCount,
    wonCents,
    wonCount,
    lostCount,
    winRatePct: decided === 0 ? 0 : Math.round((wonCount * 100) / decided),
    medianReplyHours: hours === null ? null : Math.round(hours * 10) / 10,
  }
}

export type ChipTone = 'muted' | 'warn' | 'danger' | 'good'

export interface QuoteChip {
  text: string
  tone: ChipTone
}

/** `4h`, `3d`, `25m` — how much of a link's life is left, in one unit. */
function remainingText(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Rows with no clock on them — drafts, restored quotes, offers logged off a phone call
 * — still have to appear in the composite `quoteOpen`/`expiresAt` index the board reads,
 * so the Lambda writes them a far-future `expiresAt`. It is an index key, not a date:
 * nothing may ever print it or count down to it.
 */
const NO_EXPIRY_SENTINEL = '9999-12-31T23:59:59.999Z'

export function hasExpiryClock(expiresAt: string | null | undefined): boolean {
  return !!expiresAt && expiresAt !== NO_EXPIRY_SENTINEL && !expiresAt.startsWith('9999')
}

/**
 * What the Sent tab says about the clock. An expired quote is not "nearly due" — the
 * number went out with an hour on it and that hour is gone, so the chip says so and
 * the row offers Re-send rather than Convert.
 */
export function expiryChip(
  quote: Pick<QuoteRecord, 'side' | 'status' | 'expiresAt' | 'amountCents' | 'counterCents'>,
  nowIso: string,
): QuoteChip | null {
  const state = quoteState(quote, nowIso)
  if (state.expired) return { text: 'Expired', tone: 'danger' }
  // A clock only governs a round that is sitting with the other side. A counter they
  // sent us does not go stale while we think about it, and a draft has no clock at all,
  // so neither gets a countdown however old the `expiresAt` left on the row is.
  if (state.whoseMove !== 'THEM' || !hasExpiryClock(quote.expiresAt)) return null
  const expiresAt = Date.parse(quote.expiresAt ?? '')
  const now = Date.parse(nowIso)
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return null
  if (expiresAt <= now) return { text: 'Expired', tone: 'danger' }
  const left = expiresAt - now
  return { text: `Expires in ${remainingText(left)}`, tone: left <= 4 * HOUR_MS ? 'warn' : 'muted' }
}

/** `12.5% margin`, red when the quote loses money, amber under the floor it must clear. */
export function marginChip(
  quote: Pick<QuoteRecord, 'marginBps'>,
  floorBps: number | null,
): QuoteChip | null {
  const bps = quote.marginBps
  if (bps == null || !Number.isFinite(bps)) return null
  const text = `${(bps / 100).toFixed(1)}% margin`
  if (bps < 0) return { text, tone: 'danger' }
  if (floorBps != null && floorBps > 0 && bps < floorBps) return { text, tone: 'warn' }
  return { text, tone: 'good' }
}

/** Who owes the next move, named rather than abbreviated: "Customer", "Carrier", "Us". */
export function whoseMoveLabel(
  quote: Pick<QuoteRecord, 'side' | 'status' | 'expiresAt' | 'amountCents' | 'counterCents'>,
  nowIso: string,
): string {
  const state = quoteState(quote, nowIso)
  if (state.expired) return 'Us — it lapsed'
  if (state.whoseMove === 'US') return 'Us'
  if (state.whoseMove === 'THEM') return quote.side === 'BUY' ? 'Carrier' : 'Customer'
  return '—'
}

export interface OfferActions {
  canAccept: boolean
  canCounter: boolean
  canReject: boolean
  canCopyLink: boolean
}

/**
 * What may be done to a carrier offer, read off `quoteState` rather than off the row's
 * status. Booking takes a number that is actually on the table — their counter, or the
 * price they named while it is still live — so an offer that lapsed offers neither
 * Accept nor Counter, only Reject and a fresh request.
 *
 * The offers tab and the shipment's offers card both gate on this, so the two surfaces
 * cannot disagree about whether a carrier can still be booked.
 */
export function offerActions(
  quote: Pick<QuoteRecord, 'side' | 'status' | 'expiresAt' | 'amountCents' | 'counterCents' | 'linkToken'>,
  nowIso: string,
): OfferActions {
  const state = quoteState(quote, nowIso)
  const liveNumber = state.canAccept || state.canConvert
  return {
    canAccept: liveNumber,
    canCounter: liveNumber || state.canCounter,
    canReject: state.canMarkLost,
    canCopyLink: !!quote.linkToken,
  }
}

/**
 * Their last number on this row: the counter when they made one, otherwise the number
 * the row carries on the rungs where the other side has spoken. Null when nobody has.
 */
export function theirNumberCents(quote: QuoteRecord): number | null {
  if (quote.counterCents != null && quote.counterCents > 0) return quote.counterCents
  if (quote.side === 'BUY' && (quote.status === 'RECEIVED_REPLY' || quote.status === 'QUOTED')) {
    return quote.amountCents > 0 ? quote.amountCents : null
  }
  return null
}

/** The public link for a live round. Null when this round has no token to hand out. */
export function quoteLinkUrl(token: string | null | undefined, origin: string): string | null {
  const value = (token ?? '').trim()
  if (!value) return null
  return `${origin.replace(/\/+$/, '')}/quote/${value}`
}

/** Hours since a request landed, for the To price tab's age column. */
export function ageHours(quote: Pick<QuoteRecord, 'createdAt' | 'quoteDate'>, nowIso: string): number | null {
  return hoursBetween(quote.createdAt ?? `${quote.quoteDate}T00:00:00.000Z`, nowIso)
}

export interface LaneLookupInput {
  originCity: string
  originState: string
  originZip: string
  destCity: string
  destState: string
  destZip: string
}

export const EMPTY_LANE_LOOKUP: LaneLookupInput = {
  originCity: '', originState: '', originZip: '', destCity: '', destState: '', destZip: '',
}

/**
 * A typed-in lane as the two keys the samples are indexed by. The lookup form builds
 * the same stop shape a load carries so `laneKeyFor` does the normalising — a page
 * that upper-cased and piped its own string would key differently from the sampler.
 */
export function laneLookupKeys(input: LaneLookupInput): { laneKey: string | null; laneKey3: string | null } {
  const stops: Stop[] = [
    {
      id: 'lane-lookup:pickup',
      type: 'pickup',
      appt: '',
      driverId: null,
      sequence: 0,
      city: `${input.originCity}, ${input.originState}`,
      address: { city: input.originCity, state: input.originState, zip: input.originZip },
    },
    {
      id: 'lane-lookup:delivery',
      type: 'delivery',
      appt: '',
      driverId: null,
      sequence: 1,
      city: `${input.destCity}, ${input.destState}`,
      address: { city: input.destCity, state: input.destState, zip: input.destZip },
    },
  ]
  return { laneKey: laneKeyFor(stops), laneKey3: laneKey3For(stops) }
}
