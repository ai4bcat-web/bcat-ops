import { describe, it, expect } from 'vitest'
import { laneStats, laneFallback } from './laneStats'
import type { LaneRateSampleRecord } from '../types/tms'

const NOW = '2026-10-28T12:00:00.000Z'

let seq = 0
const sample = (over: Partial<LaneRateSampleRecord>): LaneRateSampleRecord => {
  seq += 1
  return {
    id: `lrs:load-${seq}`,
    laneKey: 'CHICAGO|IL>DANVILLE|IL',
    date: '2026-10-01',
    loadId: `load-${seq}`,
    shipmentId: `ship-${seq}`,
    source: 'LOAD',
    sampledAt: NOW,
    version: 1,
    ...over,
  }
}

describe('laneStats', () => {
  it('reports the middle of an odd count', () => {
    const stats = laneStats(
      [
        sample({ customerRateCents: 100_000 }),
        sample({ customerRateCents: 600_000 }),
        sample({ customerRateCents: 200_000 }),
      ],
      {},
      NOW,
    )
    expect(stats.customer).toMatchObject({
      count: 3,
      lowCents: 100_000,
      medianCents: 200_000,
      avgCents: 300_000,
      highCents: 600_000,
    })
  })

  it('averages the two middles of an even count, to a whole cent', () => {
    const even = laneStats(
      [
        sample({ customerRateCents: 100_000 }),
        sample({ customerRateCents: 200_000 }),
        sample({ customerRateCents: 300_000 }),
        sample({ customerRateCents: 500_000 }),
      ],
      {},
      NOW,
    )
    expect(even.customer.medianCents).toBe(250_000)

    const odd = laneStats(
      [sample({ customerRateCents: 100 }), sample({ customerRateCents: 101 })],
      {},
      NOW,
    )
    expect(odd.customer.medianCents).toBe(101)
  })

  it('bills the customer off revenue when there is no quoted rate', () => {
    const stats = laneStats([sample({ revenueCents: 175_000 })], {}, NOW)
    expect(stats.customer.count).toBe(1)
    expect(stats.customer.avgCents).toBe(175_000)
  })

  it('keeps an excluded sample out of every statistic', () => {
    const stats = laneStats(
      [
        sample({ customerRateCents: 200_000 }),
        sample({ customerRateCents: 9_000_000, excluded: true }),
      ],
      {},
      NOW,
    )
    expect(stats.customer.count).toBe(1)
    expect(stats.customer.highCents).toBe(200_000)
  })

  it('counts a sample sitting exactly on the window edge, and drops the day before', () => {
    const edge = sample({ date: '2026-07-30', customerRateCents: 100_000 })
    const older = sample({ date: '2026-07-29', customerRateCents: 900_000 })

    expect(laneStats([edge, older], { windowDays: 90 }, NOW).customer.count).toBe(1)
    expect(laneStats([edge, older], { windowDays: 180 }, NOW).customer.count).toBe(2)
    expect(laneStats([edge, older], { windowDays: 'ALL' }, NOW).customer.count).toBe(2)
    expect(laneStats([edge, older], {}, NOW).customer.count).toBe(2)
  })

  it('filters by equipment and by rate type', () => {
    const rows = [
      sample({ customerRateCents: 100_000, equipmentType: 'VAN', rateType: 'SPOT' }),
      sample({ customerRateCents: 200_000, equipmentType: 'REEFER', rateType: 'SPOT' }),
      sample({ customerRateCents: 300_000, equipmentType: 'VAN', rateType: 'CONTRACT' }),
    ]
    expect(laneStats(rows, { equipmentType: 'van' }, NOW).customer.count).toBe(2)
    expect(laneStats(rows, { rateType: 'CONTRACT' }, NOW).customer.avgCents).toBe(300_000)
    expect(laneStats(rows, { equipmentType: 'VAN', rateType: 'SPOT' }, NOW).customer.count).toBe(1)
  })

  it('leaves own-fleet legs out of the buy side unless they are asked for', () => {
    const rows = [
      sample({ customerRateCents: 200_000, carrierRateCents: 150_000, assignmentKind: 'CARRIER' }),
      sample({ customerRateCents: 180_000, carrierRateCents: 0, costCents: 0, assignmentKind: 'OWN_ASSET' }),
    ]
    const byDefault = laneStats(rows, {}, NOW)
    expect(byDefault.carrier).toMatchObject({ count: 1, lowCents: 150_000, avgCents: 150_000 })
    expect(byDefault.customer.count).toBe(2)

    const withFleet = laneStats(rows, { includeOwnFleetCost: true }, NOW)
    expect(withFleet.carrier).toMatchObject({ count: 2, lowCents: 0, avgCents: 75_000 })
  })

  it('falls back to cost when an assignment has no carrier rate', () => {
    const stats = laneStats([sample({ costCents: 142_000, assignmentKind: 'CARRIER' })], {}, NOW)
    expect(stats.carrier.avgCents).toBe(142_000)
  })

  it('averages cents per mile over the samples that have miles', () => {
    const stats = laneStats(
      [
        sample({ customerRateCents: 100_000, miles: 100 }),
        sample({ customerRateCents: 300_000, miles: 200 }),
        sample({ customerRateCents: 50_000, miles: 0 }),
        sample({ customerRateCents: 50_000 }),
      ],
      {},
      NOW,
    )
    expect(stats.customer.count).toBe(4)
    expect(stats.customer.perMileCents).toBe(1250)
    expect(stats.milesAvg).toBe(150)
  })

  it('leaves per-mile null when nothing carries miles', () => {
    const stats = laneStats([sample({ customerRateCents: 100_000, miles: 0 })], {}, NOW)
    expect(stats.customer.perMileCents).toBeNull()
    expect(stats.milesAvg).toBeNull()
  })

  it('walks the month strip forwards and remembers the newest sample', () => {
    const stats = laneStats(
      [
        sample({ date: '2026-09-15', customerRateCents: 200_000, carrierRateCents: 150_000, assignmentKind: 'CARRIER' }),
        sample({ date: '2026-07-04', customerRateCents: 100_000 }),
        sample({ date: '2026-09-02', customerRateCents: 300_000, carrierRateCents: 250_000, assignmentKind: 'CARRIER' }),
        sample({ date: '2026-08-20', customerRateCents: 180_000 }),
      ],
      {},
      NOW,
    )
    expect(stats.byMonth.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(stats.byMonth[2]).toEqual({
      month: '2026-09',
      customerAvgCents: 250_000,
      carrierAvgCents: 200_000,
      count: 2,
    })
    expect(stats.byMonth[0].carrierAvgCents).toBeNull()
    expect(stats.lastAt).toBe('2026-09-15')
  })

  it('averages the margin the loads actually ran at', () => {
    const stats = laneStats(
      [sample({ customerRateCents: 100_000, marginBps: 1800 }), sample({ customerRateCents: 100_000, marginBps: 2201 })],
      {},
      NOW,
    )
    expect(stats.marginAvgBps).toBe(2001)
  })

  it('says nothing rather than NaN about a lane with no history', () => {
    const stats = laneStats([], { windowDays: 90 }, NOW)
    expect(stats.customer).toEqual({
      count: 0, lowCents: null, medianCents: null, avgCents: null, highCents: null, perMileCents: null,
    })
    expect(stats.carrier.count).toBe(0)
    expect(stats.marginAvgBps).toBeNull()
    expect(stats.milesAvg).toBeNull()
    expect(stats.byMonth).toEqual([])
    expect(stats.lastAt).toBeNull()
    for (const value of Object.values(stats.customer)) {
      expect(Number.isNaN(value as number)).toBe(false)
    }
  })

  it('says nothing about a side nobody priced', () => {
    const stats = laneStats([sample({ customerRateCents: 200_000 })], {}, NOW)
    expect(stats.carrier.count).toBe(0)
    expect(stats.carrier.medianCents).toBeNull()
  })
})

describe('laneFallback', () => {
  const exact = [sample({ customerRateCents: 200_000 })]
  const zip3 = [sample({ customerRateCents: 190_000 }), sample({ customerRateCents: 210_000 })]

  it('prefers the exact lane and counts it in the badge', () => {
    const picked = laneFallback(exact, zip3, 'CHICAGO|IL>DANVILLE|IL', '606>618')
    expect(picked.basis).toBe('EXACT')
    expect(picked.samples).toHaveLength(1)
    expect(picked.badge).toBe('1 load on this lane')
  })

  it('pluralises the exact badge', () => {
    const many = [...exact, sample({ customerRateCents: 150_000 })]
    expect(laneFallback(many, zip3, 'CHICAGO|IL>DANVILLE|IL', '606>618').badge).toBe('2 loads on this lane')
  })

  it('names the ZIP3 neighbourhood when the lane itself is new', () => {
    const picked = laneFallback([], zip3, 'CHICAGO|IL>DANVILLE|IL', '606>618')
    expect(picked.basis).toBe('ZIP3')
    expect(picked.samples).toHaveLength(2)
    expect(picked.badge).toBe('2 loads 606→618')
    expect(laneFallback([], [zip3[0]], 'CHICAGO|IL>DANVILLE|IL', '606>618').badge).toBe('1 load 606→618')
  })

  it('has no basis when neither set has history', () => {
    const picked = laneFallback([], [], 'CHICAGO|IL>DANVILLE|IL', '606>618')
    expect(picked).toEqual({ samples: [], basis: 'NONE', badge: 'No history on this lane' })
  })

  it('drops excluded samples before deciding and before counting', () => {
    const canceled = [sample({ customerRateCents: 200_000, excluded: true })]
    const picked = laneFallback(canceled, zip3, 'CHICAGO|IL>DANVILLE|IL', '606>618')
    expect(picked.basis).toBe('ZIP3')
    expect(picked.badge).toBe('2 loads 606→618')
  })

  it('refuses a set whose key is missing', () => {
    expect(laneFallback(exact, zip3, null, '606>618').basis).toBe('ZIP3')
    expect(laneFallback([], zip3, null, null).basis).toBe('NONE')
  })
})
