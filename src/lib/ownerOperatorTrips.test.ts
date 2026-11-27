import { describe, it, expect } from 'vitest'
import { ownerOpTripsFor, OWNER_OP_FIRST_PERIOD, ratePerMile, totalRatePerMile, settlementStopDates, settlementDateLabel, paidDirectCents } from './ownerOperatorTrips'
import { tripPayAmount, calcDriverPay } from './driverPay'

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

/**
 * One $/mi rule for the staff page and the driver app, so the two never show an owner
 * operator different numbers for the same load.
 */
describe('ratePerMile', () => {
  it('divides freight by miles to the cent', () => {
    expect(ratePerMile(1400, 371)).toBe(3.77)
    expect(ratePerMile(1210, 464)).toBe(2.61)
  })

  it('is null — not $0.00, not Infinity — when the miles are missing or zero', () => {
    // "$0.00/mi" reads as a load that paid nothing. That is a claim, not an absence.
    expect(ratePerMile(1400, 0)).toBeNull()
    expect(ratePerMile(1400, null)).toBeNull()
    expect(ratePerMile(1400, undefined)).toBeNull()
  })

  it('is null when there is no freight to divide', () => {
    expect(ratePerMile(null, 371)).toBeNull()
    expect(ratePerMile(undefined, 371)).toBeNull()
  })

  it('refuses nonsense rather than returning NaN', () => {
    expect(ratePerMile(Number.NaN, 371)).toBeNull()
    expect(ratePerMile(1400, -5)).toBeNull()
  })
})

describe('totalRatePerMile', () => {
  it('is freight over miles across the loads that have miles, leaving no-mile loads out of both sides', () => {
    expect(totalRatePerMile([
      { freightAmount: 1000, miles: 241 },
      { freightAmount: 1400, miles: 371 },
      { freightAmount: 2500, miles: null },
    ])).toEqual({ miles: 612, rate: 3.92 })
  })

  it('has no rate when no load has miles', () => {
    expect(totalRatePerMile([{ freightAmount: 900, miles: null }])).toEqual({ miles: 0, rate: null })
  })
})

describe('settlementStopDates', () => {
  it('uses what happened, else the appointment', () => {
    const d = settlementStopDates([
      { type: 'delivery', sequence: 1, appt: '2026-11-13T15:00:00Z' },
      { type: 'pickup', sequence: 0, appt: '2026-11-10T14:00:00Z', departedAt: '2026-11-10T16:30:00Z' },
    ], null)
    expect(d.pickup).toEqual({ at: '2026-11-10T16:30:00Z', actual: true })
    expect(d.delivery).toEqual({ at: '2026-11-13T15:00:00Z', actual: false })
  })

  it("takes the load's delivered time first", () => {
    expect(settlementStopDates([{ type: 'delivery', appt: '2026-11-09T15:00:00Z' }], '2026-11-09T15:14:53Z').delivery)
      .toEqual({ at: '2026-11-09T15:14:53Z', actual: true })
  })

  it('labels in Central time, blank when unknown', () => {
    expect(settlementDateLabel({ at: '2026-11-10T03:00:00Z', actual: true })).toBe('11/09')
    expect(settlementDateLabel({ at: null, actual: false })).toBe('')
  })
})

describe('a lumper paid direct to the driver (load 20132)', () => {
  const fifty = { payPercent: 0.5, expensesBeforePercent: false }
  const afterExpenses = { payPercent: 0.5, expensesBeforePercent: true }

  it('works the driver share off the total less the amount paid direct: $3,650 - $500 -> $3,150 -> 50% = $1,575', () => {
    const [trip] = ownerOpTripsFor([baseLoad({ rate: 365000, driverPaidDirectCents: 50000 })], driverId, '2026-09-27')
    expect(trip.freightAmount).toBe(3150)
    expect(trip.paidDirect).toBe(500)
    expect(trip.loadTotal).toBe(3650)
    expect(tripPayAmount(trip.freightAmount, fifty)).toBe(1575)
    // The check drops by exactly $250 against the same load without the adjustment.
    const [before] = ownerOpTripsFor([baseLoad({ rate: 365000 })], driverId, '2026-09-27')
    expect(tripPayAmount(before.freightAmount, fifty) - tripPayAmount(trip.freightAmount, fifty)).toBe(250)
  })

  it('leaves a load with nothing paid direct exactly as it was (missing, null, zero, negative, NaN)', () => {
    for (const v of [undefined, null, 0, -500, Number.NaN]) {
      const [trip] = ownerOpTripsFor([baseLoad({ rate: 45000, driverPaidDirectCents: v })], driverId, '2026-09-27')
      expect(trip.freightAmount).toBe(450)
      expect(trip.paidDirect).toBe(0)
      expect(trip.loadTotal).toBe(450)
    }
  })

  it('never takes more than the load total, so freight cannot go negative', () => {
    const [trip] = ownerOpTripsFor([baseLoad({ rate: 45000, driverPaidDirectCents: 90000 })], driverId, '2026-09-27')
    expect(trip.paidDirect).toBe(450)
    expect(trip.freightAmount).toBe(0)
    expect(paidDirectCents({ rate: 45000, driverPaidDirectCents: 90000 })).toBe(45000)
    expect(paidDirectCents({ rate: null, driverPaidDirectCents: 500 })).toBe(0)
  })

  it('adjusts only the load it is set on, and the week statement adds up', () => {
    const loads = [
      baseLoad({ id: 'a', rate: 365000, driverPaidDirectCents: 50000, deliveryAppt: '2026-09-28T17:00:00Z' }),
      baseLoad({ id: 'b', rate: 540000, deliveryAppt: '2026-09-29T17:00:00Z' }),
    ]
    const trips = ownerOpTripsFor(loads, driverId, '2026-09-27')
    expect(trips.map((t) => t.freightAmount)).toEqual([3150, 5400])
    const st = calcDriverPay(trips.map((t) => ({ freightAmount: t.freightAmount })), afterExpenses, [], [], [])
    expect(st.gross).toBe(8550)
    // 50% of gross less the 2% factoring fee on that gross.
    expect(st.checkAmount).toBe(4189.5)
  })

  it('on an after-expenses statement the check drops by his share of the amount net of the factoring fee that follows the gross ($245)', () => {
    const withLumper = ownerOpTripsFor([baseLoad({ rate: 365000 })], driverId, '2026-09-27')
    const adjusted = ownerOpTripsFor([baseLoad({ rate: 365000, driverPaidDirectCents: 50000 })], driverId, '2026-09-27')
    const check = (trips: typeof adjusted) => calcDriverPay(trips.map((t) => ({ freightAmount: t.freightAmount })), afterExpenses, [], [], []).checkAmount
    expect(check(withLumper)).toBe(1788.5)
    expect(check(adjusted)).toBe(1543.5)
    expect(check(withLumper) - check(adjusted)).toBe(245)
  })
})
