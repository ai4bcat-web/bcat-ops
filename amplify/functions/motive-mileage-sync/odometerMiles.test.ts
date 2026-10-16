import { describe, it, expect } from 'vitest'
import { indexOdometerRows, dayMilesFromOdometer, rangeMilesFromOdometer, ledgerCovers, chunkRange } from './odometerMiles'

const rows = [
  { truckId: 't1', date: '2026-10-12', miles: 335, endOdometer: 391000 },
  { truckId: 't1', date: '2026-10-13', miles: 146, endOdometer: 391146 },
  { truckId: 't1', date: '2026-10-14', miles: 0, endOdometer: 391146 },
  { truckId: 't2', date: '2026-10-14', miles: null, endOdometer: null },   // Motive reported nothing
]
const index = indexOdometerRows(rows)

describe('dayMilesFromOdometer', () => {
  it('returns the closed day miles from the ledger, including a real zero', () => {
    expect(dayMilesFromOdometer(index, 't1', '2026-10-13', '2026-10-15', 391500)).toBe(146)
    expect(dayMilesFromOdometer(index, 't1', '2026-10-14', '2026-10-15', 391500)).toBe(0)
  })
  it('derives today from the live odometer minus the last closed reading', () => {
    expect(dayMilesFromOdometer(index, 't1', '2026-10-15', '2026-10-15', 391446)).toBe(300)
    expect(dayMilesFromOdometer(index, 't1', '2026-10-15', '2026-10-15', 391000)).toBe(0)   // never negative
  })
  it('is null for a day the ledger does not have, for an unknown truck, and for today without a live reading', () => {
    expect(dayMilesFromOdometer(index, 't1', '2026-10-11', '2026-10-15', 391500)).toBeNull()
    expect(dayMilesFromOdometer(index, 't9', '2026-10-13', '2026-10-15', 1)).toBeNull()
    expect(dayMilesFromOdometer(index, 't1', '2026-10-15', '2026-10-15', null)).toBeNull()
    expect(dayMilesFromOdometer(index, 't2', '2026-10-14', '2026-10-15', 5)).toBeNull()
  })
})

describe('rangeMilesFromOdometer', () => {
  it('sums the covered days and adds today from the live odometer', () => {
    expect(ledgerCovers(index, 't1', '2026-10-12')).toBe(true)
    expect(rangeMilesFromOdometer(index, 't1', '2026-10-12', '2026-10-18', '2026-10-15', 391446)).toBe(335 + 146 + 0 + 300)
  })
  it('is null when the ledger starts after the range start (caller falls back to IFTA)', () => {
    expect(ledgerCovers(index, 't1', '2026-10-01')).toBe(false)
    expect(rangeMilesFromOdometer(index, 't1', '2026-10-01', '2026-10-31', '2026-10-15', 391446)).toBeNull()
  })
})

describe('chunkRange', () => {
  it('splits a year into 90-day windows that tile the range exactly', () => {
    const c = chunkRange('2026-01-01', '2026-10-16')
    expect(c[0]).toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(c[1].start).toBe('2026-04-01')
    expect(c[c.length - 1].end).toBe('2026-10-16')
    expect(c.every((w) => w.start <= w.end)).toBe(true)
  })
  it('leaves a short range as one window', () => {
    expect(chunkRange('2026-10-01', '2026-10-15')).toEqual([{ start: '2026-10-01', end: '2026-10-15' }])
  })
})
