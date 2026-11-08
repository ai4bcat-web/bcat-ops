/**
 * The two history sections of the Rate-intelligence panel, as pure projections:
 *
 *   "What we ran this lane for"    `LaneRateSample` rows (live loads + the imported Aljex
 *                                  history, source BACKFILL) → rows + count / avg / low / high.
 *   "What we quoted this lane for" `Quote` rows → outcome WON / LOST / EXPIRED / PENDING + win rate.
 *
 * The lane test and the equipment test are `laneMatch`'s, shared with the DAT section, so the
 * three sections can never disagree about which lane they are describing.
 *
 * Relative imports only: the tmsShipmentActions Lambda bundles this file by path.
 */
import type { LaneRateSampleRecord, QuoteLostReason, QuoteRecord, QuoteStatus } from '../types/tms'
import {
  laneSpecFromKeys,
  matchLane,
  sameEquipment,
  type LaneMatchOptions,
  type LaneMatchTier,
  type LaneSpec,
} from './laneMatch'

/** How far back "what we ran / quoted" looks. */
export const LANE_INTEL_MONTHS = 24
/** Rows the panel lists; the statistics cover every match, the table is the newest of them. */
export const LANE_INTEL_LIST_LIMIT = 25

export interface LaneRunRow {
  id: string
  date: string
  customerName: string | null
  carrierName: string | null
  /** What we paid the carrier; null for our own trucks (no purchase). */
  carrierCostCents: number | null
  customerRateCents: number | null
  marginCents: number | null
  marginBps: number | null
  equipmentType: string | null
  shipmentNumber: string | null
  /** BACKFILL = imported Aljex history. */
  source: string | null
  match: LaneMatchTier
}

export interface SpreadStats {
  count: number
  avgCents: number | null
  lowCents: number | null
  highCents: number | null
}

export interface LaneRunStats {
  /** Matching loads: the number printed beside the table. */
  count: number
  customer: SpreadStats
  carrier: SpreadStats
  marginAvgBps: number | null
  /** The newest matching load's date. */
  lastDate: string | null
}

/** The same loads cut to the last 30 / 90 / 365 days, so a short list of rows never skews an average. */
export interface LaneRunWindows {
  d30: LaneRunStats
  d90: LaneRunStats
  d365: LaneRunStats
}

export type QuoteOutcome = 'WON' | 'LOST' | 'EXPIRED' | 'PENDING'

export interface LaneQuoteRow {
  id: string
  date: string
  customerName: string | null
  quotedCents: number
  outcome: QuoteOutcome
  lostReason: QuoteLostReason | null
  status: QuoteStatus
  equipmentType: string | null
  match: LaneMatchTier
}

export interface LaneQuoteStats {
  count: number
  won: number
  lost: number
  expired: number
  pending: number
  /** won / (won + lost + expired); null until something has been decided. */
  winRate: number | null
  avgQuotedCents: number | null
  /** Average of the quotes that WON. */
  avgWonCents: number | null
}

export interface LaneIntelligence {
  /** The lane as the server matched it. */
  laneKey: string | null
  laneKey3: string | null
  equipmentType: string | null
  fromDate: string
  months: number
  generatedAt: string
  runs: { stats: LaneRunStats; rows: LaneRunRow[]; windows: LaneRunWindows }
  quotes: { stats: LaneQuoteStats; rows: LaneQuoteRow[] }
  /** True when a read hit its page ceiling: the numbers are real but are not every row. */
  truncated: boolean
}

/** A lane as the panel and the action take it: free text per end, as typed or extracted. */
export interface LaneInput {
  originCity?: string | null
  originState?: string | null
  originZip?: string | null
  destinationCity?: string | null
  destinationState?: string | null
  destinationZip?: string | null
}

/** A stable identity for a lane input, so a panel re-reads only when the lane really changed. */
export function laneInputKey(lane: LaneInput): string {
  return [
    lane.originCity, lane.originState, lane.originZip, lane.destinationCity, lane.destinationState, lane.destinationZip,
  ].map((v) => (v ?? '').trim().toUpperCase()).join('|')
}

/** First pickup and last delivery of a route as a lane input; null when there is no route yet. */
export function laneInputOfStops(
  stops: ReadonlyArray<{ type?: string | null; city?: string | null; state?: string | null; zip?: string | null }> | null | undefined,
): LaneInput | null {
  const list = (stops ?? []).filter((s) => s != null)
  if (list.length < 2) return null
  const kind = (s: { type?: string | null }) => String(s.type ?? '').toLowerCase()
  const first = list.find((s) => kind(s) === 'pickup') ?? list[0]
  const last = [...list].reverse().find((s) => kind(s) === 'delivery') ?? list[list.length - 1]
  if (first === last) return null
  return {
    originCity: first.city, originState: first.state, originZip: first.zip,
    destinationCity: last.city, destinationState: last.state, destinationZip: last.zip,
  }
}

const amount = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function spread(values: number[]): SpreadStats {
  if (values.length === 0) return { count: 0, avgCents: null, lowCents: null, highCents: null }
  let sum = 0
  let low = values[0]
  let high = values[0]
  for (const v of values) {
    sum += v
    if (v < low) low = v
    if (v > high) high = v
  }
  return { count: values.length, avgCents: Math.round(sum / values.length), lowCents: low, highCents: high }
}

/** The 'YYYY-MM-DD' floor of the window, `months` calendar months back from `nowIso`. */
export function laneIntelFloor(nowIso: string, months: number = LANE_INTEL_MONTHS): string {
  const d = new Date(nowIso)
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.toISOString().slice(0, 10)
}

/**
 * The window's month keys ('YYYY-MM') from the floor's month to `nowIso`'s, oldest first. Quotes are
 * indexed by month, so this is the list of bounded queries the quote lookup makes.
 */
export function laneIntelMonths(nowIso: string, months: number = LANE_INTEL_MONTHS): string[] {
  const d = new Date(nowIso)
  const out: string[] = []
  let y = d.getUTCFullYear()
  let m = d.getUTCMonth()
  for (let i = 0; i <= months; i++) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`)
    m -= 1
    if (m < 0) { m = 11; y -= 1 }
  }
  return out.reverse()
}

/**
 * The samples that are this lane, newest first, as table rows. Excluded samples (canceled / TONU'd
 * loads) and those outside the window or equipment are dropped; a sample matches through its two
 * keys, so an Aljex-imported row with only a ZIP3 pair still counts on a ZIP3 match.
 */
export function laneRunRows(
  samples: readonly LaneRateSampleRecord[],
  target: LaneSpec,
  filters: { equipmentType?: string | null; fromDate?: string | null } & LaneMatchOptions,
): LaneRunRow[] {
  const rows: LaneRunRow[] = []
  for (const s of samples) {
    if (s.excluded) continue
    const date = (s.date ?? '').slice(0, 10)
    if (!date || (filters.fromDate && date < filters.fromDate)) continue
    if (!sameEquipment(filters.equipmentType, s.equipmentType)) continue
    const match = matchLane(target, laneSpecFromKeys(s.laneKey, s.laneKey3), filters)
    if (!match) continue
    const customer = amount(s.customerRateCents) ?? amount(s.revenueCents)
    // Our own truck bought nothing: a null cost, not a free load.
    const carrier = s.assignmentKind === 'OWN_ASSET' ? null : (amount(s.carrierRateCents) ?? amount(s.costCents))
    const profit = amount(s.profitCents)
    rows.push({
      id: s.id,
      date,
      customerName: s.customerName ?? null,
      carrierName: s.carrierName ?? null,
      carrierCostCents: carrier,
      customerRateCents: customer,
      marginCents: profit ?? (customer != null && carrier != null ? customer - carrier : null),
      marginBps: amount(s.marginBps),
      equipmentType: s.equipmentType ?? null,
      shipmentNumber: s.shipmentNumber ?? null,
      source: s.source ?? null,
      match,
    })
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
}

/** Count / avg / low / high of what we charged and paid on the matching loads. */
export function laneRunStats(rows: readonly LaneRunRow[]): LaneRunStats {
  const margins = rows.map((r) => r.marginBps).filter((v): v is number => v != null)
  return {
    count: rows.length,
    customer: spread(rows.map((r) => r.customerRateCents).filter((v): v is number => v != null)),
    carrier: spread(rows.map((r) => r.carrierCostCents).filter((v): v is number => v != null)),
    marginAvgBps: margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : null,
    lastDate: rows.length ? rows[0].date : null,
  }
}

const DAY_MS = 86_400_000

/** 'YYYY-MM-DD' of the day `days` before `nowIso`'s UTC date (whole UTC days: no DST arithmetic). */
function dayFloor(nowIso: string, days: number): string {
  const day = Date.parse(`${nowIso.slice(0, 10)}T00:00:00Z`)
  return new Date(day - days * DAY_MS).toISOString().slice(0, 10)
}

/** Loads dated on or after each window's floor; `rows` are every match, not the listed page. */
export function laneRunWindows(rows: readonly LaneRunRow[], nowIso: string): LaneRunWindows {
  const within = (days: number) => laneRunStats(rows.filter((r) => r.date >= dayFloor(nowIso, days)))
  return { d30: within(30), d90: within(90), d365: within(365) }
}

/**
 * Where a SELL quote stands as a lane-history fact. A quote converted to a shipment is WON whatever
 * its status says; passed / lost are LOST (a lapsed reason, or a sent quote past its clock, is
 * EXPIRED); anything still open is PENDING. Drafts and canceled quotes were never put to a customer
 * and are not part of the lane's record: null.
 */
export function quoteOutcome(
  quote: Pick<QuoteRecord, 'side' | 'status' | 'shipmentId' | 'lostReason' | 'expiresAt'>,
  nowIso: string,
): QuoteOutcome | null {
  if (quote.side !== 'SELL') return null
  if (quote.shipmentId || quote.status === 'WON') return 'WON'
  switch (quote.status) {
    case 'LOST':
      return quote.lostReason === 'EXPIRED' ? 'EXPIRED' : 'LOST'
    case 'PASS':
      return 'LOST'
    case 'DRAFT':
    case 'CANCELED':
      return null
    case 'QUOTED':
    case 'SENT_COUNTER': {
      const expires = quote.expiresAt ? Date.parse(quote.expiresAt) : NaN
      return !Number.isNaN(expires) && expires <= Date.parse(nowIso) ? 'EXPIRED' : 'PENDING'
    }
    default:
      return 'PENDING'
  }
}

/** The SELL quotes that are this lane, newest first, with their outcome. */
export function laneQuoteRows(
  quotes: readonly QuoteRecord[],
  target: LaneSpec,
  filters: { equipmentType?: string | null; fromDate?: string | null; nowIso: string; excludeId?: string | null } & LaneMatchOptions,
): LaneQuoteRow[] {
  const rows: LaneQuoteRow[] = []
  for (const q of quotes) {
    if (q.id === filters.excludeId) continue
    const outcome = quoteOutcome(q, filters.nowIso)
    if (!outcome) continue
    const date = (q.quoteDate ?? '').slice(0, 10)
    if (!date || (filters.fromDate && date < filters.fromDate)) continue
    if (!sameEquipment(filters.equipmentType, q.equipmentType)) continue
    const match = matchLane(target, laneSpecFromKeys(q.laneKey, q.laneKey3), filters)
    if (!match) continue
    rows.push({
      id: q.id,
      date,
      customerName: q.customerName ?? null,
      quotedCents: q.customerRateCents ?? q.amountCents,
      outcome,
      lostReason: q.lostReason ?? null,
      status: q.status,
      equipmentType: q.equipmentType ?? null,
      match,
    })
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
}

export function laneQuoteStats(rows: readonly LaneQuoteRow[]): LaneQuoteStats {
  const by = (o: QuoteOutcome) => rows.filter((r) => r.outcome === o)
  const won = by('WON')
  const decided = won.length + by('LOST').length + by('EXPIRED').length
  const avg = (list: readonly LaneQuoteRow[]): number | null =>
    list.length ? Math.round(list.reduce((a, r) => a + r.quotedCents, 0) / list.length) : null
  return {
    count: rows.length,
    won: won.length,
    lost: by('LOST').length,
    expired: by('EXPIRED').length,
    pending: by('PENDING').length,
    winRate: decided > 0 ? won.length / decided : null,
    avgQuotedCents: avg(rows),
    avgWonCents: avg(won),
  }
}
