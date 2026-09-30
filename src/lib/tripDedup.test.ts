import { describe, it, expect } from 'vitest'
import { partitionNewTrips, duplicateTripIds } from './tripDedup'
import type { AmazonTrip } from '@/lib/apiClient'

const baseTrip = (overrides: Partial<AmazonTrip> = {}): AmazonTrip => ({
  id: 'trip-1',
  driverId: 'driver-a',
  periodStart: '2026-09-27',
  loadId: 'T-114H1QD2C',
  origin: 'GYR3',
  destination: 'FTW6',
  miles: 1068,
  equipment: "53' Trailer",
  freightAmount: 5248.52,
  ratePerMile: 4.91,
  dispatcher: null,
  status: 'Completed',
  notes: null,
  sortOrder: null,
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-28T00:00:00Z',
  ...overrides,
})

describe('partitionNewTrips', () => {
  it('returns zero fresh rows when re-importing an identical CSV', () => {
    const existing = [baseTrip()]
    const incoming = [baseTrip({ id: 'new-1', createdAt: 'now', updatedAt: 'now' })]
    const { fresh, duplicates } = partitionNewTrips(incoming, existing)
    expect(fresh).toHaveLength(0)
    expect(duplicates).toHaveLength(1)
  })

  it('imports two genuinely different loads in the same week', () => {
    const existing = [baseTrip()]
    const incoming = [
      baseTrip({ id: 'new-1', loadId: 'T-NEWLOAD1' }),
      baseTrip({ id: 'new-2', loadId: 'T-NEWLOAD2' }),
    ]
    const { fresh, duplicates } = partitionNewTrips(incoming, existing)
    expect(fresh).toHaveLength(2)
    expect(duplicates).toHaveLength(0)
  })

  it('does not treat the same loadId in a different pay week as a duplicate', () => {
    const existing = [baseTrip({ periodStart: '2026-09-20' })]
    const incoming = [baseTrip({ periodStart: '2026-09-27' })]
    const { fresh, duplicates } = partitionNewTrips(incoming, existing)
    expect(fresh).toHaveLength(1)
    expect(duplicates).toHaveLength(0)
  })

  it('distinguishes no-loadId trips that differ only by freight amount', () => {
    const existing = [baseTrip({ loadId: null, freightAmount: 100 })]
    const incoming = [
      baseTrip({ loadId: null, freightAmount: 100 }),
      baseTrip({ loadId: null, freightAmount: 200 }),
    ]
    const { fresh, duplicates } = partitionNewTrips(incoming, existing)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].freightAmount).toBe(200)
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].freightAmount).toBe(100)
  })

  it('deduplicates two identical incoming rows against each other', () => {
    const existing: AmazonTrip[] = []
    const incoming = [baseTrip(), baseTrip()]
    const { fresh, duplicates } = partitionNewTrips(incoming, existing)
    expect(fresh).toHaveLength(1)
    expect(duplicates).toHaveLength(1)
  })
  it('preserves repeated unidentified runs while skipping their counted reimport', () => {
    const first = baseTrip({ id: 'run-1', loadId: null })
    const second = baseTrip({ id: 'run-2', loadId: null })
    const third = baseTrip({ id: 'run-3', loadId: null })
    expect(partitionNewTrips([first, second], []).fresh).toEqual([first, second])
    expect(partitionNewTrips([first, second], [first, second]).fresh).toEqual([])
    expect(partitionNewTrips([first, second, third], [first, second]).fresh).toEqual([third])
  })
})

describe('duplicateTripIds', () => {
  it('flags a reference that already settled the week before', () => {
    const flagged = duplicateTripIds(
      [{ id: 'a', loadId: 'TMS-1' }, { id: 'b', loadId: 'TMS-2' }],
      [{ id: 'prev', loadId: 'tms-1' }],
    )
    expect([...flagged]).toEqual(['a'])
  })

  it('flags only the extra copy when one week carries the same load twice', () => {
    const flagged = duplicateTripIds([{ id: 'a', loadId: 'TMS-1' }, { id: 'b', loadId: 'TMS-1' }], [])
    expect([...flagged]).toEqual(['b'])
  })

  it('never collides loads that carry no usable reference', () => {
    // 53 production loads store the literal 'N/A'; treating that as an id would flag
    // every one of them as a duplicate of the others.
    const flagged = duplicateTripIds(
      [{ id: 'a', loadId: 'N/A' }, { id: 'b', loadId: '' }, { id: 'c', loadId: null }],
      [{ id: 'prev', loadId: 'N/A' }],
    )
    expect(flagged.size).toBe(0)
  })
})
