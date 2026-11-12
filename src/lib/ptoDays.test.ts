import { describe, it, expect } from 'vitest'
import {
  expandPtoDates, planPtoDays, ptoMinutesFor, ptoRowsOf, filterPtoRows, ptoTotalsByDriver, sortDriversForPto, mondayOf, MAX_PTO_BATCH,
} from './ptoDays'

describe('expandPtoDates', () => {
  it('skips weekends by default and keeps them when asked', () => {
    // 2026-11-06 is a Friday, 11-09 a Monday.
    expect(expandPtoDates({ from: '2026-11-06', to: '2026-11-09', includeWeekends: false })).toEqual(['2026-11-06', '2026-11-09'])
    expect(expandPtoDates({ from: '2026-11-06', to: '2026-11-09', includeWeekends: true })).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'])
  })
  it('adds extra dates, de-duplicates, sorts and drops bad dates', () => {
    expect(expandPtoDates({ from: '2026-11-09', to: '2026-11-09', extraDates: ['2026-10-01', '2026-11-09', 'nope'], includeWeekends: false }))
      .toEqual(['2026-10-01', '2026-11-09'])
  })
  it('a reversed range gives nothing from the range', () => {
    expect(expandPtoDates({ from: '2026-11-10', to: '2026-11-09', includeWeekends: true })).toEqual([])
  })
})

describe('planPtoDays', () => {
  it('skips days that already have PTO so a day is never paid twice', () => {
    const plan = planPtoDays(['2026-11-02', '2026-11-03'], new Set(['2026-11-03']))
    expect(plan).toEqual({ add: ['2026-11-02'], skipped: ['2026-11-03'], error: null })
  })
  it('refuses an oversized batch', () => {
    const many = Array.from({ length: MAX_PTO_BATCH + 1 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`)
    expect(planPtoDays(many, new Set()).error).toMatch(/at most/)
  })
})

describe('ptoMinutesFor', () => {
  it('is quarter-hour precise and bounded', () => {
    expect(ptoMinutesFor(8)).toBe(480)
    expect(ptoMinutesFor(4.5)).toBe(270)
    expect(ptoMinutesFor(0)).toBe(0)
    expect(ptoMinutesFor(40)).toBe(1440)
    expect(ptoMinutesFor(Number.NaN)).toBe(0)
  })
})

describe('table helpers', () => {
  const rows = ptoRowsOf([
    { id: '1', driverId: 'a', workDate: '2026-03-02', kind: 'PTO', minutes: 480, note: 'PTO approved by ruben@bcatcorp.com' },
    { id: '2', driverId: 'a', workDate: '2026-10-13', kind: 'PTO', minutes: 240, note: 'half day', correctedBy: 'ryne@bcatcorp.com' },
    { id: '3', driverId: 'b', workDate: '2026-10-14', kind: 'PTO', minutes: null },
    { id: '4', driverId: 'b', workDate: '2026-10-14', kind: 'WORK', minutes: 480 },
    { id: '5', driverId: 'a', workDate: '2025-12-30', kind: 'PTO', minutes: 480 },
  ] as never)
  it('keeps only PTO rows, newest first, with a default day for a row never totalled', () => {
    expect(rows.map((r) => r.id)).toEqual(['3', '2', '1', '5'])
    expect(rows.find((r) => r.id === '3')!.minutes).toBe(480)
    expect(rows.find((r) => r.id === '1')!.enteredBy).toBe('ruben@bcatcorp.com')
    expect(rows.find((r) => r.id === '2')!.corrected).toBe(true)
  })
  it('filters by driver, month and week', () => {
    expect(filterPtoRows(rows, { driverId: 'b' }).map((r) => r.id)).toEqual(['3'])
    expect(filterPtoRows(rows, { month: '2026-10' }).map((r) => r.id)).toEqual(['3', '2'])
    expect(filterPtoRows(rows, { weekOf: '2026-10-15' }).map((r) => r.id)).toEqual(['3', '2'])   // Mon 10-12 .. Sun 10-18
    expect(mondayOf('2026-10-18')).toBe('2026-10-12')
  })
  it('totals days and minutes per driver for one year', () => {
    expect(ptoTotalsByDriver(rows, '2026').sort((x, y) => x.driverId.localeCompare(y.driverId)))
      .toEqual([{ driverId: 'a', days: 2, minutes: 720 }, { driverId: 'b', days: 1, minutes: 480 }])
  })
  it('lists PTO-eligible drivers first', () => {
    expect(sortDriversForPto([{ name: 'Zed' }, { name: 'Amy' }, { name: 'Bo', ptoEligible: true }, { name: 'Al', ptoEligible: false }]).map((d) => d.name))
      .toEqual(['Bo', 'Al', 'Amy', 'Zed'])
  })
})
