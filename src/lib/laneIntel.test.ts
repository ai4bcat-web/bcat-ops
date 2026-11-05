import { describe, it, expect } from 'vitest'
import {
  laneInputOfStops, laneIntelFloor, laneIntelMonths, laneQuoteRows, laneQuoteStats, laneRunRows, laneRunStats, laneRunWindows, quoteOutcome,
} from './laneIntel'
import { lanePlace } from './laneMatch'
import type { LaneRateSampleRecord, QuoteRecord } from '../types/tms'

const NOW = '2026-11-04T12:00:00.000Z'
const target = {
  origin: lanePlace({ city: 'Chicago', state: 'IL', zip: '60601' }),
  destination: lanePlace({ city: 'Dallas', state: 'TX', zip: '75201' }),
}

const sample = (o: Partial<LaneRateSampleRecord>): LaneRateSampleRecord => ({
  id: 'lrs:1', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-10-01', loadId: 'l', shipmentId: 's',
  customerName: 'ZZ Acme', equipmentType: 'VAN', customerRateCents: 300000, carrierRateCents: 250000, assignmentKind: 'CARRIER',
  source: 'BACKFILL', sampledAt: NOW, version: 1, ...o,
} as unknown as LaneRateSampleRecord)

const quote = (o: Partial<QuoteRecord>): QuoteRecord => ({
  id: 'Q1', side: 'SELL', status: 'QUOTED', quoteDate: '2026-10-01', quoteMonth: '2026-10', amountCents: 300000,
  laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', equipmentType: 'VAN', rounds: 1, version: 1, ...o,
} as unknown as QuoteRecord)

describe('what we ran this lane for', () => {
  it('computes count / avg / low / high over matching loads only', () => {
    const rows = laneRunRows([
      sample({ id: 'a', customerRateCents: 300000, carrierRateCents: 250000, date: '2026-10-01' }),
      sample({ id: 'b', customerRateCents: 360000, carrierRateCents: 270000, date: '2026-09-01' }),
      sample({ id: 'c', customerRateCents: 240000, carrierRateCents: 200000, date: '2026-08-01', laneKey: 'EVANSTON|IL>DALLAS|TX' }), // ZIP3 match
      sample({ id: 'x', laneKey: 'CHICAGO|IL>HOUSTON|TX', laneKey3: '606>770' }), // other lane
      sample({ id: 'y', equipmentType: 'REEFER' }), // other equipment
      sample({ id: 'z', excluded: true }), // canceled after sampling
      sample({ id: 'old', date: '2020-01-01' }), // outside the window
    ], target, { equipmentType: 'VAN', fromDate: '2024-11-04' })
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(rows.find((r) => r.id === 'c')?.match).toBe('ZIP3')
    const stats = laneRunStats(rows)
    expect(stats.count).toBe(3)
    expect(stats.customer).toEqual({ count: 3, avgCents: 300000, lowCents: 240000, highCents: 360000 })
    expect(stats.carrier).toEqual({ count: 3, avgCents: 240000, lowCents: 200000, highCents: 270000 })
    expect(stats.lastDate).toBe('2026-10-01')
  })

  it('keeps our own trucks out of the carrier side instead of counting them as free', () => {
    const rows = laneRunRows([
      sample({ id: 'own', assignmentKind: 'OWN_ASSET', carrierRateCents: 0, costCents: 0, customerRateCents: 280000 }),
      sample({ id: 'brk', customerRateCents: 300000, carrierRateCents: 250000 }),
    ], target, {})
    const stats = laneRunStats(rows)
    expect(stats.carrier).toMatchObject({ count: 1, avgCents: 250000 })
    expect(stats.customer.count).toBe(2)
  })

  it('reports an empty lane as nulls, not zeros', () => {
    expect(laneRunStats([])).toMatchObject({ count: 0, customer: { avgCents: null, lowCents: null }, marginAvgBps: null, lastDate: null })
  })

  it('cuts 30 / 90 / 365-day windows over every match, edges inclusive', () => {
    const rows = laneRunRows([
      sample({ id: 'a', customerRateCents: 300000, carrierRateCents: 250000, date: '2026-10-05' }), // 30 days back: in
      sample({ id: 'b', customerRateCents: 200000, carrierRateCents: 150000, date: '2026-10-04' }), // 31 days: 90 only
      sample({ id: 'c', customerRateCents: 100000, carrierRateCents: 90000, date: '2025-11-04' }), // 365 days: in 365
      sample({ id: 'd', customerRateCents: 500000, carrierRateCents: 400000, date: '2025-11-03' }), // 366 days: out
    ], target, {})
    const w = laneRunWindows(rows, NOW)
    expect([w.d30.count, w.d90.count, w.d365.count]).toEqual([1, 2, 3])
    expect(w.d90.customer.avgCents).toBe(250000)
    expect(w.d365.carrier.avgCents).toBe(163333)
  })
})

describe('what we quoted this lane for', () => {
  it('maps a quote to WON / LOST / EXPIRED / PENDING', () => {
    expect(quoteOutcome(quote({ status: 'WON' }), NOW)).toBe('WON')
    expect(quoteOutcome(quote({ status: 'QUOTED', shipmentId: 'S1' }), NOW)).toBe('WON') // converted = won
    expect(quoteOutcome(quote({ status: 'LOST', lostReason: 'TOO_HIGH' }), NOW)).toBe('LOST')
    expect(quoteOutcome(quote({ status: 'PASS' }), NOW)).toBe('LOST')
    expect(quoteOutcome(quote({ status: 'LOST', lostReason: 'EXPIRED' }), NOW)).toBe('EXPIRED')
    expect(quoteOutcome(quote({ status: 'QUOTED', expiresAt: '2026-11-03T00:00:00Z' }), NOW)).toBe('EXPIRED')
    expect(quoteOutcome(quote({ status: 'QUOTED', expiresAt: '2026-11-05T00:00:00Z' }), NOW)).toBe('PENDING')
    expect(quoteOutcome(quote({ status: 'RECEIVED_COUNTER' }), NOW)).toBe('PENDING')
    expect(quoteOutcome(quote({ status: 'DRAFT' }), NOW)).toBeNull()
    expect(quoteOutcome(quote({ status: 'CANCELED' }), NOW)).toBeNull()
    expect(quoteOutcome(quote({ side: 'BUY', status: 'WON' }), NOW)).toBeNull()
  })

  it('win rate is won over decided; pending quotes do not dilute it', () => {
    const rows = laneQuoteRows([
      quote({ id: 'Q1', status: 'WON', amountCents: 300000 }),
      quote({ id: 'Q2', status: 'LOST', lostReason: 'TOO_HIGH', amountCents: 350000 }),
      quote({ id: 'Q3', status: 'LOST', lostReason: 'EXPIRED', amountCents: 320000 }),
      quote({ id: 'Q4', status: 'RECEIVED_REPLY', amountCents: 310000 }),
      quote({ id: 'Q5', status: 'WON', amountCents: 280000, laneKey: 'EVANSTON|IL>DALLAS|TX' }),
      quote({ id: 'Q6', status: 'WON', laneKey: 'CHICAGO|IL>HOUSTON|TX', laneKey3: '606>770' }),
      quote({ id: 'Q7', status: 'WON', equipmentType: 'REEFER' }),
      quote({ id: 'Q8', status: 'WON' }),
    ], target, { equipmentType: 'VAN', nowIso: NOW, excludeId: 'Q8' })
    expect(rows.map((r) => r.id).sort()).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'])
    const stats = laneQuoteStats(rows)
    expect(stats).toMatchObject({ count: 5, won: 2, lost: 1, expired: 1, pending: 1 })
    expect(stats.winRate).toBeCloseTo(0.5)
    expect(stats.avgWonCents).toBe(290000)
  })

  it('has no win rate until something is decided', () => {
    const stats = laneQuoteStats(laneQuoteRows([quote({ status: 'QUOTED', expiresAt: '2026-11-05T00:00:00Z' })], target, { nowIso: NOW }))
    expect(stats.winRate).toBeNull()
    expect(stats.pending).toBe(1)
  })
})

describe('the 24-month window', () => {
  it('is a date floor and the month keys the quote index is queried with', () => {
    expect(laneIntelFloor(NOW)).toBe('2024-11-04')
    const months = laneIntelMonths(NOW)
    expect(months).toHaveLength(25)
    expect(months[0]).toBe('2024-11')
    expect(months[months.length - 1]).toBe('2026-11')
  })

  it('takes the first pickup and last delivery as the lane', () => {
    expect(laneInputOfStops([
      { type: 'pickup', city: 'Chicago', state: 'IL', zip: '60601' },
      { type: 'delivery', city: 'Joliet', state: 'IL', zip: '60431' },
      { type: 'delivery', city: 'Dallas', state: 'TX', zip: '75201' },
    ])).toMatchObject({ originCity: 'Chicago', destinationCity: 'Dallas' })
    expect(laneInputOfStops([{ type: 'pickup', city: 'Chicago' }])).toBeNull()
  })
})
