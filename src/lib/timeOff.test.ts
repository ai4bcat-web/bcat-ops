import { describe, it, expect } from 'vitest'
import { statusOf, isApproved, overlappingRequest, ptoDaysUsed, validateTimeOffRequest, addDaysISO, describeRange, ptoRowFor } from './timeOff'

const TODAY = '2026-11-06'
const ok = (input: Record<string, unknown>, eligible = true) => validateTimeOffRequest(input, TODAY, eligible)

describe('statusOf', () => {
  it('reads a row with no status as APPROVED so the existing calendar is unchanged', () => {
    expect(statusOf({})).toBe('APPROVED')
    expect(statusOf({ status: null })).toBe('APPROVED')
    expect(isApproved({ status: 'PENDING' })).toBe(false)
    expect(isApproved({ status: 'DENIED' })).toBe(false)
    expect(isApproved({ status: 'APPROVED' })).toBe(true)
  })
})

describe('overlappingRequest', () => {
  const rows = [
    { id: 'a', type: 'FULL_DAY_OFF', startDate: '2026-11-10', endDate: '2026-11-12', status: 'PENDING' },
    { id: 'b', type: 'FULL_DAY_OFF', startDate: '2026-11-20', endDate: '2026-11-20' },
    { id: 'c', type: 'FULL_DAY_OFF', startDate: '2026-11-25', endDate: '2026-11-25', status: 'DENIED' },
  ]
  it('collides with pending and unstated-status (approved) rows on any shared day', () => {
    expect(overlappingRequest(rows, '2026-11-12', '2026-11-14')?.id).toBe('a')
    expect(overlappingRequest(rows, '2026-11-20', '2026-11-20')?.id).toBe('b')
  })
  it('does not collide with a denied row, or with the next day', () => {
    expect(overlappingRequest(rows, '2026-11-25', '2026-11-25')).toBeNull()
    expect(overlappingRequest(rows, '2026-11-13', '2026-11-13')).toBeNull()
  })
})

describe('ptoDaysUsed', () => {
  it('counts PTO rows in the calendar year, one per day, and nothing else', () => {
    const rows = [
      { kind: 'PTO', workDate: '2026-01-02' }, { kind: 'PTO', workDate: '2026-11-05' }, { kind: 'PTO', workDate: '2025-12-31' },
      { kind: 'HOLIDAY', workDate: '2026-07-04' }, { kind: 'WORK', workDate: '2026-11-05' },
    ]
    expect(ptoDaysUsed(rows, '2026')).toBe(2)
    expect(ptoDaysUsed(rows, '2025')).toBe(1)
  })
})

describe('validateTimeOffRequest', () => {
  it('defaults an hours request to what was asked, in quarter hours', () => {
    expect(ok({ type: 'FULL_DAY_OFF', startDate: '2026-11-10', hours: 8, note: ' dentist ' })).toEqual({ ok: true, value: { type: 'FULL_DAY_OFF', startDate: '2026-11-10', endDate: '2026-11-10', hours: 8, note: 'dentist' } })
    expect(ok({ type: 'LATE_START', startDate: '2026-11-10', hours: 2.3 })).toMatchObject({ ok: true, value: { hours: 2.25 } })
  })
  it('refuses nonsense: no type, no date, backwards range, zero hours, more hours than days', () => {
    for (const bad of [
      { startDate: '2026-11-10', hours: 8 },
      { type: 'FULL_DAY_OFF', hours: 8 },
      { type: 'FULL_DAY_OFF', startDate: '2026-11-10', endDate: '2026-11-09', hours: 8 },
      { type: 'FULL_DAY_OFF', startDate: '2026-11-10', hours: 0 },
      { type: 'FULL_DAY_OFF', startDate: '2026-11-10', hours: 25 },
      { type: 'FULL_DAY_OFF', startDate: '2026-11-01', hours: 8 },
      { type: 'FULL_DAY_OFF', startDate: '2026-11-10', endDate: '2026-12-20', hours: 8 },
    ]) expect(ok(bad).ok).toBe(false)
  })
  it('PTO: eligible drivers only, one day, eight hours whatever was sent, inside the 30-back / 14-ahead window', () => {
    expect(ok({ type: 'PTO', startDate: '2026-11-05', hours: 3 })).toMatchObject({ ok: true, value: { hours: 8, endDate: '2026-11-05' } })
    expect(ok({ type: 'PTO', startDate: '2026-11-05' }, false)).toEqual({ ok: false, error: 'PTO is not set up for you.' })
    expect(ok({ type: 'PTO', startDate: '2026-11-05', endDate: '2026-11-06' }).ok).toBe(false)
    expect(ok({ type: 'PTO', startDate: '2026-10-07' }).ok).toBe(true)
    expect(ok({ type: 'PTO', startDate: '2026-10-06' }).ok).toBe(false)
    expect(ok({ type: 'PTO', startDate: '2026-11-20' }).ok).toBe(true)
    expect(ok({ type: 'PTO', startDate: '2026-11-21' }).ok).toBe(false)
  })
})

describe('helpers', () => {
  it('does date arithmetic across a month end and describes ranges', () => {
    expect(addDaysISO('2026-11-30', 1)).toBe('2026-12-01')
    expect(describeRange('2026-11-10', '2026-11-10')).toBe('Nov 10')
    expect(describeRange('2026-11-10', '2026-11-12')).toBe('Nov 10 – Nov 12')
  })
  it('an approved PTO day is a 480-minute staff row on that day', () => {
    expect(ptoRowFor('d1', '2026-11-05', 'ryne@bcatcorp.com', 'id1', 'now')).toMatchObject({ driverId: 'd1', workDate: '2026-11-05', kind: 'PTO', minutes: 480, source: 'STAFF', clockInAt: null })
  })
})
