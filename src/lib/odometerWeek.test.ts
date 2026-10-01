import { describe, it, expect } from 'vitest'
import {
  buildOdometerWeek,
  truckWeekRevenue,
  revenuePerMile,
  milesBetween,
  weekDays,
  sundayOf,
  recentWeekStarts,
  type TruckOdometerDay,
  type LoadWeekInput,
} from './odometerWeek'

const WEEK = '2026-09-27' // Sunday

function row(date: string, over: Partial<TruckOdometerDay> = {}): TruckOdometerDay {
  return { truckId: 't1', unitNumber: '009', date, weekStart: WEEK, source: 'motive', ...over }
}

describe('buildOdometerWeek', () => {
  it('lays out Sun..Sat and keeps a missing day a gap, not an invented zero', () => {
    const week = buildOdometerWeek(WEEK, [
      row('2026-09-27', { miles: 100 }),
      // Monday absent — Motive reported nothing.
      row('2026-09-29', { miles: 150 }),
    ])
    expect(week.days.map((d) => d.label)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    expect(week.days[1].miles).toBeNull()
    expect(week.days[2].miles).toBe(150)
  })

  it('week total equals the sum of the day miles', () => {
    const week = buildOdometerWeek(WEEK, [
      row('2026-09-27', { miles: 100 }),
      row('2026-09-28', { miles: 150 }),
      row('2026-09-29', { miles: 25.5 }),
    ])
    const daySum = week.days.reduce((sum, d) => sum + (d.miles ?? 0), 0)
    expect(week.totalMiles).toBeCloseTo(daySum, 6)
    expect(week.totalMiles).toBeCloseTo(275.5, 6)
  })

  it('a backwards odometer yields 0 miles, never negative', () => {
    expect(milesBetween(1000, 990)).toBe(0)
    const week = buildOdometerWeek(WEEK, [row('2026-09-27', { startOdometer: 1000, endOdometer: 990 })])
    expect(week.days[0].miles).toBe(0)
    expect(week.totalMiles).toBe(0)
  })

  it('clamps a stored negative miles figure to zero', () => {
    const week = buildOdometerWeek(WEEK, [row('2026-09-27', { miles: -12.5 })])
    expect(week.days[0].miles).toBe(0)
  })

  it('leaves the day a gap when only one reading is known', () => {
    const week = buildOdometerWeek(WEEK, [row('2026-09-27', { endOdometer: 990 })])
    expect(week.days[0].miles).toBeNull()
  })

  it('derives week MPG from total miles over total fuel', () => {
    const week = buildOdometerWeek(WEEK, [
      row('2026-09-27', { miles: 100, fuelGallons: 10 }),
      row('2026-09-28', { miles: 200, fuelGallons: 20 }),
    ])
    expect(week.mpg).toBeCloseTo(10, 6)
  })

  it('reports no week MPG when fuel is unknown or zero', () => {
    expect(buildOdometerWeek(WEEK, [row('2026-09-27', { miles: 100 })]).mpg).toBeNull()
    expect(buildOdometerWeek(WEEK, [row('2026-09-27', { miles: 100, fuelGallons: 0 })]).mpg).toBeNull()
  })
})

describe('revenue per mile', () => {
  it('is null when the truck drove no miles (no divide by zero)', () => {
    expect(revenuePerMile(5000, 0)).toBeNull()
  })

  it('divides weekly dollars by weekly miles', () => {
    expect(revenuePerMile(2500, 1000)).toBe(2.5)
  })
})

describe('truckWeekRevenue', () => {
  it('attributes a load rate in cents to its delivery day and the driver\'s assigned truck', () => {
    const loads: LoadWeekInput[] = [
      { deliveryDriverId: 'd1', rate: 250000, deliveryAppt: '2026-09-29T18:00:00Z' },
      { deliveryDriverId: 'd1', rate: 100000, deliveryAppt: '2026-09-20T18:00:00Z' }, // prior week
    ]
    const assignments = [{ driverId: 'd1', assignedTruckId: 't1' }]
    expect(truckWeekRevenue('t1', WEEK, loads, assignments)).toBe(2500)
  })

  it('never counts a broker-covered load toward a truck', () => {
    const loads: LoadWeekInput[] = [{ deliveryDriverId: 'd1', rate: 250000, deliveryAppt: '2026-09-29' }]
    const assignments = [{ driverId: 'd1', assignedTruckId: 't1', isBroker: true }]
    expect(truckWeekRevenue('t1', WEEK, loads, assignments)).toBe(0)
  })

  it('prefers an explicit load truck over the driver assignment', () => {
    const loads: LoadWeekInput[] = [{ truckId: 't2', deliveryDriverId: 'd1', rate: 10000, deliveryAppt: '2026-09-29' }]
    const assignments = [{ driverId: 'd1', assignedTruckId: 't1' }]
    expect(truckWeekRevenue('t1', WEEK, loads, assignments)).toBe(0)
    expect(truckWeekRevenue('t2', WEEK, loads, assignments)).toBe(100)
  })

  it('counts the last day of the week (Saturday) but not the next Sunday', () => {
    const loads: LoadWeekInput[] = [
      { deliveryDriverId: 'd1', rate: 10000, deliveryAppt: '2026-10-03' },
      { deliveryDriverId: 'd1', rate: 10000, deliveryAppt: '2026-10-04' },
    ]
    const assignments = [{ driverId: 'd1', assignedTruckId: 't1' }]
    expect(truckWeekRevenue('t1', WEEK, loads, assignments)).toBe(100)
  })
})

describe('week helpers', () => {
  it('weekDays returns the seven Sun..Sat dates in order', () => {
    expect(weekDays(WEEK)).toEqual([
      '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
    ])
  })

  it('sundayOf snaps any day back to its week start', () => {
    expect(sundayOf('2026-10-01')).toBe(WEEK)
    expect(sundayOf(WEEK)).toBe(WEEK)
  })

  it('recentWeekStarts walks back a week at a time, newest first', () => {
    expect(recentWeekStarts(3, '2026-10-01')).toEqual(['2026-09-27', '2026-09-20', '2026-09-13'])
  })
})
