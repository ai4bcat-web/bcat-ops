import { describe, expect, it } from 'vitest'
import type { LaneRateSampleRecord, SpotExtraction } from '../../types/tms'
import type { RateViewAnswer } from '../integrations/rateView'
import { suggestSpotRate, type SpotSuggestInput } from './suggest'

const NOW = '2026-11-04T16:00:00Z'

function extraction(over: Partial<SpotExtraction> = {}): SpotExtraction {
  return {
    customerName: null, contactName: null, contactPhone: null,
    stops: [
      { type: 'PICKUP', name: null, city: 'Chicago', state: 'IL', zip: null, dateStr: null, time: null },
      { type: 'DELIVERY', name: null, city: 'Dallas', state: 'TX', zip: null, dateStr: null, time: null },
    ],
    pickupDate: '2026-11-06', deliveryDate: null, equipment: 'van', equipmentType: 'VAN', lengthFt: 53,
    mode: 'FTL', weightLbs: 38000, pieces: null, commodity: null, temperatureF: null, hazmat: null,
    accessorials: [], targetRateDollars: null, notes: null,
    ...over,
  }
}

function market(over: Partial<RateViewAnswer> = {}): RateViewAnswer {
  return {
    averageCents: 200_000, lowCents: 180_000, highCents: 230_000, fuelCents: 20_000, perMileCents: 250,
    miles: 800, reports: 40, days: 7, stub: false, source: 'DAT_RATEVIEW', message: 'live',
    ...over,
  }
}

function sample(i: number, over: Partial<LaneRateSampleRecord> = {}): LaneRateSampleRecord {
  return {
    id: `s${i}`, laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-10-15', loadId: `l${i}`,
    shipmentId: `sh${i}`, customerId: 'c1', equipmentType: 'VAN', rateType: 'SPOT', miles: 800,
    customerRateCents: 260_000, revenueCents: 260_000, carrierRateCents: 210_000, costCents: 210_000,
    source: 'SHIPMENT', sampledAt: '2026-10-16T00:00:00Z', version: 1,
    ...over,
  } as LaneRateSampleRecord
}

function input(over: Partial<SpotSuggestInput> = {}): SpotSuggestInput {
  return {
    extraction: extraction(),
    market: market(),
    samples: [],
    settings: { marginTargetBps: 2000, marginFloorBps: 1000 },
    customer: null,
    nowIso: NOW,
    ...over,
  }
}

describe('suggestSpotRate basis', () => {
  it('prices from live DAT at the target margin, rounded to the dollar', () => {
    const s = suggestSpotRate(input())!
    expect(s.basis).toBe('DAT_LIVE')
    expect(s.stub).toBe(false)
    // 2000 / (1 - 0.20) = 2500
    expect(s.suggestedCents).toBe(250_000)
    expect(s.suggestedCents % 100).toBe(0)
    expect(s.marginAtSuggested).toBe(2000)
    expect(s.perMileCents).toBe(Math.round(250_000 / 800))
    expect(s.confidence).toBe('GOOD')
  })

  it('prefers this customer\'s history over lane-wide history, from 3 samples', () => {
    const samples = [
      ...[1, 2, 3].map((i) => sample(i, { customerId: 'c1', customerRateCents: 300_000, revenueCents: 300_000 })),
      ...[4, 5, 6].map((i) => sample(i, { customerId: 'c2', customerRateCents: 250_000, revenueCents: 250_000 })),
    ]
    const s = suggestSpotRate(input({ market: market({ stub: true }), samples, customerId: 'c1' }))!
    expect(s.basis).toBe('HISTORY')
    expect(s.suggestedCents).toBe(300_000)
    expect(s.sampleCount).toBe(3)
    expect(s.label).toContain('EXACT')
  })

  it('uses lane-wide history when the customer has fewer than 3 loads', () => {
    const samples = [1, 2, 3, 4].map((i) => sample(i, { customerId: i === 1 ? 'c1' : 'c2' }))
    const s = suggestSpotRate(input({ market: null, samples, customerId: 'c1' }))!
    expect(s.basis).toBe('HISTORY')
    expect(s.sampleCount).toBe(4)
  })

  it('falls to the STUB basis with fewer than 3 samples and never reports GOOD', () => {
    const s = suggestSpotRate(input({ market: market({ stub: true, message: 'STUB — no DAT call was made' }), samples: [sample(1), sample(2)] }))!
    expect(s.basis).toBe('STUB')
    expect(s.stub).toBe(true)
    expect(s.confidence).toBe('STUB')
    expect(s.notes.join(' ')).toContain('no DAT call was made')
    expect(s.label).toMatch(/STUB/)
  })

  it('labels a ZIP3 fallback', () => {
    const s = suggestSpotRate(input({ market: null, samples: [], zip3Samples: [1, 2, 3].map((i) => sample(i)) }))!
    expect(s.basis).toBe('HISTORY')
    expect(s.label).toContain('ZIP3')
  })

  it('ignores samples of a different equipment', () => {
    const samples = [1, 2, 3].map((i) => sample(i, { equipmentType: 'REEFER' }))
    expect(suggestSpotRate(input({ market: market({ stub: true }), samples }))!.basis).toBe('STUB')
  })
})

describe('margin floor', () => {
  it('lifts a history price that sits below the carrier-based floor and never goes negative', () => {
    // sell median 2,000 but carrier median 2,100: floor at 10% = 2,100/0.9 = 2,334
    const samples = [1, 2, 3].map((i) => sample(i, { customerRateCents: 200_000, revenueCents: 200_000, carrierRateCents: 210_000, costCents: 210_000 }))
    const s = suggestSpotRate(input({ market: null, samples }))!
    expect(s.floorSellCents).toBe(233_400)
    expect(s.suggestedCents).toBe(233_400)
    expect(s.marginAtSuggested).toBeGreaterThanOrEqual(1000)
    expect(s.belowFloor).toBe(false)
    expect(s.notes.join(' ')).toMatch(/floor/i)
  })

  it('lifts a live DAT price when the floor beats the target', () => {
    const s = suggestSpotRate(input({ settings: { marginTargetBps: 500, marginFloorBps: 500 }, customer: { marginTargetBps: 500, marginFloorBps: 500 } }))!
    expect(s.suggestedCents).toBeGreaterThanOrEqual(200_000)
    expect(s.marginAtSuggested!).toBeGreaterThanOrEqual(0)
  })

  it('at a zero floor the sell is never below the buy even after dollar rounding', () => {
    const s = suggestSpotRate(input({ market: market({ averageCents: 200_049 }), settings: { marginTargetBps: 0, marginFloorBps: 0 } }))!
    expect(s.suggestedCents).toBeGreaterThanOrEqual(200_049)
    expect(s.marginAtSuggested!).toBeGreaterThanOrEqual(0)
  })
})

describe('not priceable', () => {
  it('returns null for LTL, missing lane or missing equipment', () => {
    expect(suggestSpotRate(input({ extraction: extraction({ mode: 'LTL' }) }))).toBeNull()
    expect(suggestSpotRate(input({ extraction: extraction({ stops: [] }) }))).toBeNull()
    expect(suggestSpotRate(input({ extraction: extraction({ equipmentType: null }) }))).toBeNull()
  })
})
