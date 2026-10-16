import { describe, expect, it } from 'vitest'
import { hoursLeaders, grossLeaders, rankLeaders, shiftDays, lastAppointment } from './driverLeaderboard'
import type { TimeClockRow } from './timeClock'
import type { Load } from '@/types'

const load = (p: Partial<Load> & { id: string }): Load =>
  ({ aljexId: '', tmsId: '', pickupNumber: '', pickupAppt: '', deliveryAppt: '', pickupDriverId: null, deliveryDriverId: null, ...p }) as unknown as Load

describe('lastAppointment', () => {
  it('returns the latest stop owned by the driver with its city, across loads', () => {
    const loads = [
      load({ id: 'L1', stops: [
        { id: 'L1:pu', type: 'pickup', appt: '2026-10-16T13:00:00Z', city: 'Chicago, IL', driverId: 'oo1', sequence: 0 },
        { id: 'L1:de', type: 'delivery', appt: '2026-10-17T19:30:00Z', city: 'Indianapolis, IN', driverId: 'oo1', sequence: 1, apptType: 'range', apptEnd: '2026-10-17T21:00:00Z' },
      ] }),
      load({ id: 'L2', stops: [
        { id: 'L2:de', type: 'delivery', appt: '2026-10-20T12:00:00Z', city: 'Columbus, OH', driverId: 'oo2', sequence: 0 },
      ] }),
    ]
    expect(lastAppointment(loads, 'oo1')).toEqual({ loadId: 'L1', stopType: 'delivery', at: '2026-10-17T19:30:00Z', apptType: 'range', apptEnd: '2026-10-17T21:00:00Z', city: 'Indianapolis, IN' })
    expect(lastAppointment(loads, 'oo2')?.city).toBe('Columbus, OH')
    expect(lastAppointment(loads, 'nobody')).toBeNull()
  })

  it('falls back to the load driver for legacy loads without a stops array', () => {
    const loads = [load({ id: 'L3', pickupAppt: '2026-10-18T13:00:00Z', originCity: 'Joliet, IL', deliveryAppt: '2026-10-19T15:00:00Z', destinationCity: 'Nashville, TN', pickupDriverId: 'oo1', deliveryDriverId: 'oo1' })]
    const got = lastAppointment(loads, 'oo1')
    expect(got?.stopType).toBe('delivery')
    expect(got?.at).toBe('2026-10-19T15:00:00Z')
    expect(got?.city).toBe('Nashville, TN')
  })
})

const drivers = [
  { id: 'a', name: 'Ana', colorKey: 'blue' },
  { id: 'b', name: 'Ben', colorKey: null },
  { id: 'c', name: 'Cal' },
]
const row = (p: Partial<TimeClockRow> & { driverId: string; workDate: string }): TimeClockRow =>
  ({ id: `${p.driverId}-${p.workDate}`, kind: 'WORK', ...p })

describe('hoursLeaders', () => {
  it('sums WORK minutes per driver, ranks descending and counts distinct days', () => {
    const rows = [
      row({ driverId: 'a', workDate: '2026-10-12', minutes: 600 }),
      row({ driverId: 'a', workDate: '2026-10-13', minutes: 30 }),
      row({ driverId: 'b', workDate: '2026-10-12', minutes: 480 }),
      row({ driverId: 'b', workDate: '2026-10-12', minutes: 240 }), // split shift, same day
    ]
    expect(hoursLeaders(rows, drivers)).toEqual([
      { driverId: 'b', name: 'Ben', colorKey: null, value: 12, count: 1 },
      { driverId: 'a', name: 'Ana', colorKey: 'blue', value: 10.5, count: 2 },
    ])
  })

  it('ignores holidays, PTO, open shifts and rows for unknown drivers', () => {
    const rows = [
      row({ driverId: 'a', workDate: '2026-10-12', kind: 'HOLIDAY' }),
      row({ driverId: 'a', workDate: '2026-10-13', kind: 'PTO', minutes: 480 }),
      row({ driverId: 'b', workDate: '2026-10-12', clockInAt: '2026-10-12T13:00:00Z' }), // still clocked in
      row({ driverId: 'zz', workDate: '2026-10-12', minutes: 600 }),
    ]
    expect(hoursLeaders(rows, drivers)).toEqual([])
  })

  it('falls back to the timestamps when a row was never totalled', () => {
    const rows = [row({ driverId: 'c', workDate: '2026-10-12', clockInAt: '2026-10-12T13:00:00Z', clockOutAt: '2026-10-12T21:15:00Z' })]
    expect(hoursLeaders(rows, drivers)).toEqual([{ driverId: 'c', name: 'Cal', colorKey: null, value: 8.25, count: 1 }])
  })
})

describe('grossLeaders', () => {
  it('ranks by statement gross, drops zero weeks, carries the load count', () => {
    const out = grossLeaders([
      { driver: drivers[0]!, statement: { gross: 4200.004 }, trips: [1, 2, 3] },
      { driver: drivers[1]!, statement: { gross: 0 }, trips: [] },
      { driver: drivers[2]!, statement: { gross: 5100 }, trips: [1, 2] },
    ])
    expect(out.map((r) => [r.name, r.value, r.count])).toEqual([['Cal', 5100, 2], ['Ana', 4200, 3]])
  })
})

describe('rankLeaders / shiftDays', () => {
  it('breaks ties by name so the board is stable', () => {
    const out = rankLeaders([
      { driverId: '2', name: 'Zed', value: 10, count: 1 },
      { driverId: '1', name: 'Amy', value: 10, count: 1 },
    ])
    expect(out.map((r) => r.name)).toEqual(['Amy', 'Zed'])
  })
  it('shifts calendar days across a DST change without moving the date', () => {
    expect(shiftDays('2026-11-02', -7)).toBe('2026-10-26')
    expect(shiftDays('2026-10-16', 7)).toBe('2026-10-23')
  })
})
