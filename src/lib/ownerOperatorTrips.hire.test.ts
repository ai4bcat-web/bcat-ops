import { describe, it, expect } from 'vitest'
import { ownerOpTripsFor, ownerOpStartDate, ownerOpOnPayroll, ownerOpWeekFrom } from './ownerOperatorTrips'

const load = (id: string, day: string) => ({ id, tmsId: id, rate: 100000, deliveryAppt: `${day}T17:00:00Z`, deliveryDriverId: 'd1' })

describe('owner operator start date', () => {
  it('reads a hire date and cuts a longer stamp to its day', () => {
    expect(ownerOpStartDate('2026-10-02')).toBe('2026-10-02')
    expect(ownerOpStartDate('2026-10-02T00:00:00Z')).toBe('2026-10-02')
  })
  it('treats a missing or unusable hire date as no limit', () => {
    for (const bad of [undefined, null, '', '  ', 'soon', '2026-13-40', '10/02/2026']) expect(ownerOpStartDate(bad)).toBeNull()
  })
  it('lists a driver from the week that holds the hire date, not before', () => {
    // Pay weeks run Sunday to Saturday: 9/27–10/3, 10/4–10/10.
    expect(ownerOpOnPayroll('2026-10-02', '2026-09-20')).toBe(false)
    expect(ownerOpOnPayroll('2026-10-02', '2026-09-27')).toBe(true)
    expect(ownerOpOnPayroll('2026-10-02', '2026-10-04')).toBe(true)
    expect(ownerOpOnPayroll('2026-10-03', '2026-09-27')).toBe(true) // the last day of the week still counts
    expect(ownerOpOnPayroll('2026-10-04', '2026-09-27')).toBe(false)
    expect(ownerOpOnPayroll(null, '2026-09-27')).toBe(true)
  })
  it('counts the hire week from the hire date and every later week from its first day', () => {
    expect(ownerOpWeekFrom('2026-10-02', '2026-09-27')).toBe('2026-10-02')
    expect(ownerOpWeekFrom('2026-10-02', '2026-10-04')).toBe('2026-10-04')
    expect(ownerOpWeekFrom(null, '2026-09-27')).toBe('2026-09-27')
  })
})

describe('ownerOpTripsFor with a start date', () => {
  const loads = [load('a', '2026-09-28'), load('b', '2026-10-02'), load('c', '2026-10-03')]
  it('leaves out loads delivered before the start date', () => {
    expect(ownerOpTripsFor(loads, 'd1', '2026-09-27', '2026-10-02').map((t) => t.id)).toEqual(['b', 'c'])
  })
  it('is unchanged without one', () => {
    expect(ownerOpTripsFor(loads, 'd1', '2026-09-27').map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(ownerOpTripsFor(loads, 'd1', '2026-09-27', null).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})
