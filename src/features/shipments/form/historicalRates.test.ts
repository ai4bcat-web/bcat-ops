import { describe, expect, it } from 'vitest'
import { bucketSamples, periodBounds } from './historicalRates'
import type { LaneRateSampleRecord } from '@/types/tms'

const NOW = '2026-11-04T15:00:00.000Z'
const sample = (date: string, over: Partial<LaneRateSampleRecord> = {}): LaneRateSampleRecord => ({
  id: `lrs:${date}:${Math.random()}`, laneKey: 'A|IL>B|TX', date, loadId: 'l', shipmentId: 's', source: 'LOAD', sampledAt: '', version: 1,
  customerRateCents: 100000, revenueCents: 110000, miles: 500, equipmentType: 'Dry Van', ...over,
} as LaneRateSampleRecord)

describe('historical rate buckets', () => {
  it('windows are inclusive at the edge', () => {
    const b = bucketSamples([sample('2026-10-28'), sample('2026-10-27'), sample('2026-11-03')], NOW)
    expect(b.lastWeek?.count).toBe(2) // 10-28 is exactly 7 days back; 10-27 is out
    expect(b.yesterday?.count).toBe(1)
    expect(b.last30?.count).toBe(3)
  })
  it('drops excluded samples and filters equipment unless Any equipment', () => {
    const rows = [sample('2026-11-01', { excluded: true }), sample('2026-11-01', { equipmentType: 'Reefer' }), sample('2026-11-01')]
    expect(bucketSamples(rows, NOW, { equipmentType: 'Dry Van' }).last30?.count).toBe(1)
    expect(bucketSamples(rows, NOW, { equipmentType: 'Dry Van', anyEquipment: true }).last30?.count).toBe(2)
  })
  it('a period with no samples is null, never zeros', () => {
    const b = bucketSamples([sample('2026-11-03')], NOW)
    expect(b.lastYear).not.toBeNull()
    expect(b.lastQuarter).toBeNull()
    expect(bucketSamples([], NOW).last90).toBeNull()
  })
  it('Last Quarter is the previous calendar quarter, across a year turn', () => {
    expect(periodBounds('lastQuarter', '2026-11-04T00:00:00Z')).toEqual({ from: '2026-07-01', to: '2026-09-30' })
    expect(periodBounds('lastQuarter', '2027-02-10T00:00:00Z')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
  })
  it('reports median, spread and per-mile', () => {
    const b = bucketSamples([sample('2026-11-03', { customerRateCents: 100000, revenueCents: 120000 }), sample('2026-11-02', { customerRateCents: 200000, revenueCents: 220000 })], NOW)
    expect(b.last30?.linehaul).toMatchObject({ lowCents: 100000, highCents: 200000, medianCents: 150000 })
    expect(b.last30?.rate.medianCents).toBe(170000)
    expect(b.last30?.perMileCents).toBeGreaterThan(0)
  })
})
