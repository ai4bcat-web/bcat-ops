import { describe, it, expect } from 'vitest'
import { hm, dayWarning, totalsOf, periodCsv, type DriverHoursRow } from './hoursView'
import { summarizePayPeriod, type TimeClockRow } from './timeClock'
import { payForPeriod } from './hoursPay'

const work = (id: string, date: string, inAt: string, outAt: string, minutes: number): TimeClockRow =>
  ({ id, driverId: 'd1', workDate: date, kind: 'WORK', clockInAt: inAt, clockOutAt: outAt, minutes, source: 'DRIVER' })
const leave = (id: string, date: string, kind: 'PTO' | 'HOLIDAY'): TimeClockRow =>
  ({ id, driverId: 'd1', workDate: date, kind, clockInAt: null, clockOutAt: null, minutes: 480, source: 'STAFF' })

const START = '2026-10-12'
const rowFor = (name: string, rows: TimeClockRow[], rate?: number): DriverHoursRow => {
  const period = summarizePayPeriod(START, rows)
  return {
    driverId: name, name, period,
    pay: rate === undefined ? payForPeriod(period.days.map((d) => ({ date: d.date, minutes: d.totalMinutes })), {}) : payForPeriod(period.days.map((d) => ({ date: d.date, minutes: d.totalMinutes })), { hourlyRate: rate }),
  }
}

describe('hm', () => {
  it('reads minutes as clock hours', () => {
    expect([hm(0), hm(495), hm(480), hm(61), hm(-5)]).toEqual(['0:00', '8:15', '8:00', '1:01', '0:00'])
  })
})

describe('totalsOf', () => {
  const a = rowFor('Ann', [work('1', '2026-10-12', '2026-10-12T13:00:00Z', '2026-10-12T21:00:00Z', 480), leave('2', '2026-10-13', 'PTO'), leave('3', '2026-10-14', 'HOLIDAY')], 20)
  const b = rowFor('Bob', [work('4', '2026-10-12', '2026-10-12T13:00:00Z', '2026-10-12T17:00:00Z', 240)])
  it('sums worked, PTO, holiday and total over drivers; pay counts only drivers with a rate', () => {
    const t = totalsOf([a, b])
    expect(t).toMatchObject({ drivers: 2, workedMinutes: 720, ptoMinutes: 480, holidayMinutes: 480, totalMinutes: 1680, totalPay: 24 * 20 })
  })
  it('has no total pay when nobody has a rate', () => {
    expect(totalsOf([b]).totalPay).toBeNull()
    expect(totalsOf([]).totalPay).toBeNull()
  })
})

describe('periodCsv', () => {
  it('lists decimal hours and pay, quoting names; no rate leaves rate and pay blank', () => {
    const a = rowFor('Ann "Boss", Jr', [work('1', '2026-10-12', 'x', 'y', 495)], 20)
    const b = rowFor('Bob', [work('4', '2026-10-12', 'x', 'y', 240)])
    expect(periodCsv([a, b], true)).toBe('Driver,Worked hrs,PTO hrs,Holiday hrs,Total hrs,Rate ($/hr),2-week pay\n"Ann ""Boss"", Jr",8.25,0,0,8.25,20,165\nBob,4,0,0,4,,\n')
  })
  it('omits the rate and pay columns entirely without pay access', () => {
    const a = rowFor('Ann', [work('1', '2026-10-12', 'x', 'y', 480)], 20)
    expect(periodCsv([a], false)).toBe('Driver,Worked hrs,PTO hrs,Holiday hrs,Total hrs\nAnn,8,0,0,8\n')
  })
})

describe('dayWarning', () => {
  const day = (rows: TimeClockRow[]) => summarizePayPeriod(START, rows).days.find((d) => d.date === '2026-10-12')!
  const truck = (first: string, last: string) => ({ firstMoveAt: first, lastMoveAt: last, drivingSeconds: 0 })
  it('flags a shift still on the clock', () => {
    const open: TimeClockRow = { id: 'o', driverId: 'd1', workDate: '2026-10-12', kind: 'WORK', clockInAt: '2026-10-12T13:00:00Z', clockOutAt: null, minutes: null, source: 'DRIVER' }
    expect(dayWarning(day([open]), null)).toBe('open')
  })
  it('flags a clock more than an hour outside the truck, not a pre-trip', () => {
    const d = day([work('1', '2026-10-12', '2026-10-12T11:00:00Z', '2026-10-12T21:00:00Z', 600)])
    expect(dayWarning(d, truck('2026-10-12T13:00:00Z', '2026-10-12T21:00:00Z'))).toBe('gap')
    expect(dayWarning(d, truck('2026-10-12T11:40:00Z', '2026-10-12T21:00:00Z'))).toBeNull()
    expect(dayWarning(d, undefined)).toBeNull()
  })
})
