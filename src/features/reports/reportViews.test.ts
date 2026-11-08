/**
 * The four places `/reports` could quietly lie.
 *
 * A default window that lost a month would under-report the quarter; a filter list built
 * from nothing would offer cuts that return no rows; a margin printed as `0.0%` when the
 * revenue was zero would read as a break-even month; and an own-fleet note printed over a
 * table with no own-fleet load in it would teach the office to ignore the one warning
 * that matters.
 */
import { describe, it, expect } from 'vitest'
import type { LaneRateSampleRecord, ProfitReport } from '@/types/tms'
import { monthsBetween, profitReport } from '@/lib/reporting'
import {
  defaultRange, filterOptionsFrom, formatMarginBps, formatMoneyCents, formatPerMile, monthChoices, ownFleetNote,
} from './reportViews'

function sample(patch: Partial<LaneRateSampleRecord> = {}): LaneRateSampleRecord {
  return {
    id: 'lrs:1',
    laneKey: 'CHICAGO|IL>DANVILLE|IL',
    date: '2026-10-12',
    loadId: 'l1',
    shipmentId: 's1',
    sampleMonth: '2026-10',
    revenueCents: 250_000,
    costCents: 200_000,
    source: 'LOAD',
    sampledAt: '2026-10-12T12:00:00.000Z',
    version: 1,
    ...patch,
  }
}

describe('defaultRange', () => {
  it('spans this month and the two before it', () => {
    expect(defaultRange('2026-10-28T19:00:00.000Z')).toEqual({ from: '2026-08', to: '2026-10' })
    expect(monthsBetween('2026-08', '2026-10')).toHaveLength(3)
  })

  it('rolls back across the year boundary', () => {
    expect(defaultRange('2026-01-15')).toEqual({ from: '2025-11', to: '2026-01' })
    expect(defaultRange('2026-02-01')).toEqual({ from: '2025-12', to: '2026-02' })
  })

  it('reports no window at all for a string with no month in it', () => {
    expect(defaultRange('')).toEqual({ from: '', to: '' })
    expect(monthsBetween('', '')).toEqual([])
  })
})

describe('monthChoices', () => {
  it('counts back from the given month, newest first, across the year', () => {
    expect(monthChoices('2026-02-09', 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11'])
  })
})

describe('filterOptionsFrom', () => {
  it('offers each value once, named, and ignores the empty ones', () => {
    const options = filterOptionsFrom([
      sample({ divisionKey: 'BROKERAGE', carrierId: 'c1', carrierName: 'Zed Trucking', customerId: 'k1' }),
      // Same carrier, second spelling absent: the name already learned survives.
      sample({ id: 'lrs:2', divisionKey: 'BROKERAGE', carrierId: 'c1', customerId: 'k1', customerName: 'Acme Foods' }),
      sample({ id: 'lrs:3', divisionKey: '  ', teamKey: '', mode: 'FTL', equipmentType: 'VAN', carrierId: 'c2', carrierName: 'Acme Carriers' }),
      sample({ id: 'lrs:4', assignmentKind: 'OWN_ASSET', carrierId: null, mode: 'FTL' }),
    ])

    expect(options.divisions).toEqual([{ value: 'BROKERAGE', label: 'BROKERAGE' }])
    expect(options.teams).toEqual([])
    expect(options.modes).toEqual([{ value: 'FTL', label: 'FTL' }])
    expect(options.equipment).toEqual([{ value: 'VAN', label: 'VAN' }])
    // Sorted by the name that is printed, not by id.
    expect(options.carriers).toEqual([
      { value: 'c2', label: 'Acme Carriers' },
      { value: 'c1', label: 'Zed Trucking' },
    ])
    expect(options.customers).toEqual([{ value: 'k1', label: 'Acme Foods' }])
  })
})

describe('formatMarginBps', () => {
  it('prints basis points as one decimal percent', () => {
    expect(formatMarginBps(4670)).toBe('46.7%')
    expect(formatMarginBps(-1234)).toBe('-12.3%')
    expect(formatMarginBps(0)).toBe('0.0%')
  })

  it('prints an em dash when there is no margin to print', () => {
    expect(formatMarginBps(null)).toBe('—')
    expect(formatMarginBps(undefined)).toBe('—')
  })
})

describe('formatPerMile and formatMoneyCents', () => {
  it('separates thousands and keeps an unknown rate blank', () => {
    expect(formatMoneyCents(1_234_567)).toBe('$12,345.67')
    expect(formatPerMile(215)).toBe('$2.15')
    expect(formatPerMile(null)).toBe('—')
  })
})

describe('ownFleetNote', () => {
  const report = (rows: LaneRateSampleRecord[]): ProfitReport =>
    profitReport(rows, { from: '2026-10', to: '2026-10', groupBy: 'CARRIER' })

  it('says nothing when no load ran on our own trucks', () => {
    expect(ownFleetNote(report([sample({ carrierId: 'c1', carrierName: 'Zed Trucking' })]))).toBeNull()
  })

  it('warns that an own-fleet margin is not comparable, counting the loads', () => {
    const note = ownFleetNote(report([
      sample({ assignmentKind: 'OWN_ASSET' }),
      sample({ id: 'lrs:2', assignmentKind: 'OWN_ASSET' }),
      sample({ id: 'lrs:3', carrierId: 'c1' }),
    ]))

    expect(note).toContain('2 loads')
    expect(note).toContain('driver settlements')
  })

  it('says nothing about an empty window', () => {
    expect(ownFleetNote(report([]))).toBeNull()
  })
})
