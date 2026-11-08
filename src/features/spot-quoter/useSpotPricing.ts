/**
 * What a request would be priced at, assembled in the browser from the same three sources
 * the quote editor uses: the market answer (`PRICE_FROM_MARKET`, never saved from here), the
 * lane's own history, and the org/customer margin settings. `suggestSpotRate` is the pure
 * function that turns them into a number, so this page and the server cannot disagree.
 */
import { useEffect, useMemo, useState } from 'react'
import { getTmsSettings, listCustomers, listLaneSamples, listLaneSamplesByZip3, priceFromMarket } from '@/lib/apiClient'
import type { MarketRateResult } from '@/lib/apiClient'
import { laneKey3For, laneKeyFor } from '@/lib/laneKey'
import { suggestSpotRate } from '@/lib/spot/suggest'
import type { SpotSuggestion } from '@/lib/spot/types'
import type { CustomerRecord, LaneRateSampleRecord, SpotExtraction, TmsSettings } from '@/types/tms'
import { quoteStops, spotEnds } from './spotHelpers'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const WINDOW_MS = 180 * 86_400_000

export interface SpotPricing {
  loading: boolean
  /** The market card; null until it lands or when the request has no priceable lane. */
  market: MarketRateResult | null
  error: string | null
  /** null: not priceable here (not a truckload, or the lane/equipment is incomplete). */
  suggestion: SpotSuggestion | null
  sampleCount: number
  customer: CustomerRecord | null
}

interface Loaded {
  key: string
  market: MarketRateResult | null
  samples: LaneRateSampleRecord[]
  zip3: LaneRateSampleRecord[]
  settings: TmsSettings | null
  customers: CustomerRecord[]
  error: string | null
}

export function useSpotPricing(extraction: SpotExtraction | null | undefined, customerId: string | null | undefined): SpotPricing {
  const { origin, destination } = spotEnds(extraction)
  const equipment = extraction?.equipmentType ?? null
  const pickupDate = extraction?.pickupDate ?? null
  const priceable = !!(origin?.city && origin.state && destination?.city && destination.state && equipment && (extraction?.mode ?? 'FTL') === 'FTL')
  const key = priceable
    ? [origin?.city, origin?.state, origin?.zip, destination?.city, destination?.state, destination?.zip, equipment, pickupDate, customerId ?? ''].join('|')
    : ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!key || !extraction || !origin || !destination || !equipment) return
    let live = true
    const stops = quoteStops(extraction)
    const laneKey = laneKeyFor(stops)
    const laneKey3 = laneKey3For(stops)
    const from = new Date(Date.now() - WINDOW_MS).toISOString().slice(0, 10)
    Promise.all([
      priceFromMarket({
        customerId: customerId ?? null,
        originCity: origin.city,
        originState: origin.state,
        destinationCity: destination.city,
        destinationState: destination.state,
        equipmentType: equipment,
        pickupDate,
        mode: 'FTL',
      }).catch((err: unknown) => err),
      laneKey ? listLaneSamples(laneKey, from) : Promise.resolve([] as LaneRateSampleRecord[]),
      laneKey3 ? listLaneSamplesByZip3(laneKey3, from) : Promise.resolve([] as LaneRateSampleRecord[]),
      getTmsSettings().catch(() => null),
      listCustomers().catch(() => [] as CustomerRecord[]),
    ])
      .then(([market, samples, zip3, settings, customers]) => {
        if (!live) return
        const failed = market instanceof Error
        setLoaded({
          key,
          market: failed ? null : (market as MarketRateResult),
          samples,
          zip3,
          settings,
          customers,
          error: failed ? messageOf(market) : null,
        })
      })
      .catch((err: unknown) => {
        if (live) setLoaded({ key, market: null, samples: [], zip3: [], settings: null, customers: [], error: messageOf(err) })
      })
    return () => { live = false }
    // The lane key string stands for every field read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const current = key && loaded?.key === key ? loaded : null
  const customer = useMemo(
    () => (customerId ? (current?.customers.find((c) => c.id === customerId) ?? null) : null),
    [current, customerId],
  )
  const suggestion = useMemo(
    () =>
      current && extraction
        ? suggestSpotRate({
            extraction,
            market: current.market?.answer ?? null,
            samples: current.samples,
            zip3Samples: current.zip3,
            customerId: customerId ?? null,
            settings: current.settings,
            customer,
            nowIso: new Date().toISOString(),
          })
        : null,
    [current, extraction, customerId, customer],
  )

  return {
    loading: !!key && current == null,
    market: current?.market ?? null,
    error: current?.error ?? null,
    suggestion,
    sampleCount: suggestion?.sampleCount ?? 0,
    customer,
  }
}
