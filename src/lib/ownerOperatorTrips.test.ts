import { describe, it, expect } from 'vitest'
import { ownerOpTripsFor, OWNER_OP_FIRST_PERIOD } from './ownerOperatorTrips'

const driverId = 'driver-1'

function baseLoad(overrides: Partial<Parameters<typeof ownerOpTripsFor>[0][number]> = {}) {
  return {
    id: 'load-1',
    tmsId: 'TMS-1',
    aljexId: 'ALJX-1',
    customer: 'Brokerage Customer',
    miles: 250,
    rate: 45000,
    deliveryAppt: '2026-09-28T17:00:00Z',
    deliveryDriverId: driverId,
    originCity: 'Chicago',
    destinationCity: 'Detroit',
    originName: 'Chicago Warehouse',
    destinationName: 'Detroit Yard',
    ...overrides,
  }
}

describe('ownerOpTripsFor', () => {
  it('converts rate cents to dollars (45000 -> 450)', () => {
    const trips = ownerOpTripsFor([baseLoad()], driverId, '2026-09-27')
    expect(trips).toHaveLength(1)
    expect(trips[0].freightAmount).toBe(450)
  })
  it('falls back past the literal "N/A" tmsId the TMS import writes, and trims the aljex id', () => {
    // 53 production loads carry tmsId 'N/A' as a string. Using it would print the same
    // identifier on every one of those lines, making a statement impossible to audit.
    const trips = ownerOpTripsFor(
      [baseLoad({ tmsId: 'N/A', aljexId: '14452  ' })],
      driverId,
      '2026-09-27',
    )
    expect(trips[0].loadId).toBe('14452')
  })

  it('falls back to the row id when neither external id is usable', () => {
    const trips = ownerOpTripsFor(
      [baseLoad({ id: 'row-9', tmsId: 'n/a', aljexId: '   ' })],
      driverId,
      '2026-09-27',
    )
    expect(trips[0].loadId).toBe('row-9')
  })


  it('counts a Saturday-night delivery in the current week and excludes next-Sunday deliveries', () => {
    const saturdayNight = baseLoad({
      id: 'sat',
      deliveryAppt: '2026-10-03T23:00:00Z',
    })
    const nextSunday = baseLoad({
      id: 'sun',
      deliveryAppt: '2026-10-04T00:00:00Z',
    })
    const trips = ownerOpTripsFor([saturdayNight, nextSunday], driverId, '2026-09-27')
    expect(trips.map((t) => t.id)).toEqual(['sat'])
  })

  it('excludes loads delivered by another driver', () => {
    const mine = baseLoad({ id: 'mine' })
    const theirs = baseLoad({ id: 'theirs', deliveryDriverId: 'driver-2' })
    const trips = ownerOpTripsFor([mine, theirs], driverId, '2026-09-27')
    expect(trips.map((t) => t.id)).toEqual(['mine'])
  })

  it('skips loads missing rate, delivery appointment, or delivery driver', () => {
    const noRate = baseLoad({ id: 'no-rate', rate: null })
    const noAppt = baseLoad({ id: 'no-appt', deliveryAppt: null })
    const noDriver = baseLoad({ id: 'no-driver', deliveryDriverId: null })
    const ok = baseLoad({ id: 'ok' })
    const trips = ownerOpTripsFor([noRate, noAppt, noDriver, ok], driverId, '2026-09-27')
    expect(trips.map((t) => t.id)).toEqual(['ok'])
  })

  it('sorts trips oldest delivery first', () => {
    const middle = baseLoad({ id: 'middle', deliveryAppt: '2026-09-29T12:00:00Z' })
    const first = baseLoad({ id: 'first', deliveryAppt: '2026-09-27T08:00:00Z' })
    const last = baseLoad({ id: 'last', deliveryAppt: '2026-10-03T18:00:00Z' })
    const trips = ownerOpTripsFor([middle, last, first], driverId, '2026-09-27')
    expect(trips.map((t) => t.id)).toEqual(['first', 'middle', 'last'])
  })
})

describe('OWNER_OP_FIRST_PERIOD', () => {
  it('is pinned to 2026-09-27', () => {
    expect(OWNER_OP_FIRST_PERIOD).toBe('2026-09-27')
  })
})
