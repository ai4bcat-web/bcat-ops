/**
 * Step AB §4.2 — the suggested spot rate. Pure; the caller supplies the market answer
 * (`PRICE_FROM_MARKET` / `priceFromMarket`), the lane samples and the settings.
 *
 * Basis, in order:
 *   DAT_LIVE  — a real RateView answer: target margin on the market average, lifted to the floor.
 *   HISTORY   — no live DAT and ≥ 3 samples (this customer's preferred): our median sell, never
 *               below the carrier median grossed up to the floor margin.
 *   STUB      — the simulated market number, flagged; never `GOOD`, never auto-sendable.
 *
 * The suggestion is never below the buy side it was built from, so the margin is never
 * negative. Relative imports only (Lambdas bundle by path).
 */
import type { CustomerFlowSource, MarginSettingsSource } from '../flowDefaults'
import { marginBpsOf, resolveMargin, sellRateFromMarket } from '../flowDefaults'
import type { RateViewAnswer } from '../integrations/rateView'
import { laneFallback, laneStats } from '../laneStats'
import type { LaneRateSampleRecord, LaneStats, SpotExtraction } from '../../types/tms'
import { destinationStop, originStop } from './normalize'
import type { SpotSuggestion } from './types'

export const MIN_HISTORY_SAMPLES = 3
const WINDOW_DAYS = 180

export interface SpotSuggestInput {
  extraction: SpotExtraction
  /** `RateViewAnswer`; `stub:true` means no market call was made. */
  market: RateViewAnswer | null
  /** Samples for the exact lane (`laneKeyFor`). */
  samples: LaneRateSampleRecord[]
  /** Samples for the ZIP3 neighbourhood, used only when the exact lane has none. */
  zip3Samples?: LaneRateSampleRecord[]
  customerId?: string | null
  settings: MarginSettingsSource | null
  customer: CustomerFlowSource | null
  nowIso: string
}

/** Rounds up to a whole dollar, in cents. */
function ceilDollar(cents: number): number {
  return Math.ceil(cents / 100 - 1e-9) * 100
}

/** The smallest whole-dollar sell that still earns `floorBps` on `buyCents`. */
function floorSellFor(buyCents: number, floorBps: number): number {
  if (!Number.isFinite(buyCents) || buyCents <= 0) return 0
  return ceilDollar(buyCents / (1 - Math.min(9900, Math.max(0, floorBps)) / 10000))
}

/** `null` when the request is not something this tool prices (non-FTL, missing lane/equipment). */
export function suggestSpotRate(input: SpotSuggestInput): SpotSuggestion | null {
  const e = input.extraction
  const mode = e.mode ?? 'FTL'
  const from = originStop(e)
  const to = destinationStop(e)
  if (mode !== 'FTL') return null
  if (!from?.city || !from.state || !to?.city || !to.state || !e.equipmentType) return null

  const margin = resolveMargin(input.settings, input.customer, mode)
  const filters = { windowDays: WINDOW_DAYS as 180, equipmentType: e.equipmentType }
  const fb = laneFallback(
    input.samples ?? [],
    input.zip3Samples ?? [],
    (input.samples ?? []).length ? 'LANE' : null,
    (input.zip3Samples ?? []).length ? 'ZIP3' : null,
  )
  const laneAll: LaneStats = laneStats(fb.samples, filters, input.nowIso)
  const forCustomer = input.customerId ? fb.samples.filter((s) => s.customerId === input.customerId) : []
  const custStats: LaneStats | null = forCustomer.length ? laneStats(forCustomer, filters, input.nowIso) : null
  const sellStats = custStats && custStats.customer.count >= MIN_HISTORY_SAMPLES ? custStats : laneAll
  const customerSpecific = sellStats === custStats
  const carrierMedian = laneAll.carrier.medianCents ?? null
  const notes: string[] = []

  const common = {
    targetBps: margin.targetBps,
    floorBps: margin.floorBps,
    targetSource: margin.targetSource,
  }
  const finish = (
    basis: SpotSuggestion['basis'],
    stub: boolean,
    suggestedRaw: number,
    buyCents: number | null,
    floorSellCents: number,
    fields: Pick<SpotSuggestion, 'lowCents' | 'avgCents' | 'highCents' | 'reports' | 'days' | 'miles' | 'sampleCount' | 'confidence' | 'label'>,
  ): SpotSuggestion => {
    const suggestedCents = Math.max(suggestedRaw, floorSellCents)
    if (suggestedRaw < floorSellCents) notes.push('Raised to the margin floor.')
    const perMileCents = fields.miles && fields.miles > 0 ? Math.round(suggestedCents / fields.miles) : null
    return {
      basis,
      stub,
      suggestedCents,
      perMileCents,
      ...common,
      floorSellCents,
      marginAtSuggested: buyCents != null && buyCents > 0 ? marginBpsOf(suggestedCents, buyCents) : null,
      belowFloor: floorSellCents > 0 && suggestedCents < floorSellCents,
      notes,
      ...fields,
    }
  }

  const market = input.market
  const historyCount = sellStats.customer.count
  const histNote = historyCount > 0 && sellStats.customer.medianCents != null
    ? `${customerSpecific ? 'We charged this customer' : 'We charged'} $${Math.round(sellStats.customer.medianCents / 100).toLocaleString('en-US')} median on ${historyCount} ${historyCount === 1 ? 'load' : 'loads'}.`
    : null

  // 1. Live DAT.
  if (market && !market.stub && market.averageCents > 0) {
    if (histNote) notes.push(histNote)
    return finish(
      'DAT_LIVE',
      false,
      sellRateFromMarket(market.averageCents, margin.targetBps),
      market.averageCents,
      floorSellFor(market.averageCents, margin.floorBps),
      {
        lowCents: market.lowCents,
        avgCents: market.averageCents,
        highCents: market.highCents,
        reports: market.reports,
        days: market.days,
        miles: market.miles || laneAll.milesAvg,
        sampleCount: historyCount,
        confidence: market.reports >= MIN_HISTORY_SAMPLES ? 'GOOD' : 'THIN',
        label: 'DAT RateView · live',
      },
    )
  }

  // 2. Our own lane history.
  if (historyCount >= MIN_HISTORY_SAMPLES && sellStats.customer.medianCents != null) {
    const buy = carrierMedian ?? (market && market.averageCents > 0 ? market.averageCents : null)
    const floorSell = buy != null ? floorSellFor(buy, margin.floorBps) : 0
    if (buy == null) notes.push('No buy-side history — the margin floor could not be checked.')
    const basisLabel = customerSpecific ? 'EXACT' : fb.basis
    return finish(
      'HISTORY',
      false,
      Math.round(sellStats.customer.medianCents / 100) * 100,
      buy,
      floorSell,
      {
        lowCents: sellStats.customer.lowCents,
        avgCents: sellStats.customer.avgCents,
        highCents: sellStats.customer.highCents,
        reports: null,
        days: WINDOW_DAYS,
        miles: sellStats.milesAvg ?? market?.miles ?? null,
        sampleCount: historyCount,
        confidence: historyCount >= 5 ? 'GOOD' : 'THIN',
        label: `Lane history · ${historyCount} ${historyCount === 1 ? 'load' : 'loads'} · ${basisLabel}${customerSpecific ? ' · this customer' : ''}`,
      },
    )
  }

  // 3. The stub market number.
  if (market && market.averageCents > 0) {
    notes.push(market.message)
    if (historyCount > 0) notes.push(`Only ${historyCount} ${historyCount === 1 ? 'load' : 'loads'} of history — too few to price from.`)
    return finish(
      'STUB',
      true,
      sellRateFromMarket(market.averageCents, margin.targetBps),
      market.averageCents,
      floorSellFor(market.averageCents, margin.floorBps),
      {
        lowCents: market.lowCents,
        avgCents: market.averageCents,
        highCents: market.highCents,
        reports: market.reports,
        days: market.days,
        miles: market.miles || null,
        sampleCount: historyCount,
        confidence: 'STUB',
        label: 'STUB — simulated market price',
      },
    )
  }

  return null
}
