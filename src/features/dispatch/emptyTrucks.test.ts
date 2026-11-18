import { describe, it, expect } from 'vitest'
import type { Driver, Load, Stop } from '@/types'
import type { Equipment } from '@/types/equipment'
import { computeEmptyTrucks, isOwnFleetDriver, roadMiles, BACK_TO_BACK_HOURS, LONG_DEADHEAD_MILES } from './emptyTrucks'

// Wed 2026-11-18 12:30 in Chicago. The half hour keeps whole-hour offsets off Chicago midnight, which counts as "no time".
const NOW = Date.parse('2026-11-18T18:30:00Z')
const DAY = 86_400_000
const H = 3_600_000
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * H).toISOString()

const driver = (over: Partial<Driver> = {}): Driver => ({
  id: 'd1', name: 'Joshua Kly', phone: '+18475550100', active: true, fleetGroup: 'LOCAL', assignedTruckId: 'e1', ...over,
}) as Driver

const truck: Equipment = { id: 'e1', type: 'truck', unitNumber: '685', make: 'Volvo', model: 'VNL', ownership: 'owned', insured: true, active: true } as Equipment

function stop(over: Partial<Stop> & { id: string; type: Stop['type']; sequence: number }): Stop {
  return { appt: at(0), driverId: 'd1', ...over } as Stop
}

let seq = 0
function load(over: Record<string, unknown> & { stops: Stop[] }): Load {
  seq += 1
  return {
    id: `L${seq}`, aljexId: String(20000 + seq), tmsId: '', pickupNumber: '', pickupAppt: '', deliveryAppt: '', pickupDriverId: null, deliveryDriverId: null,
    readyToInvoice: false, status: 'DISPATCHED', revDivision: 'ASSETS', ...over,
  } as unknown as Load
}

/** A pickup in Kenosha and a delivery in Chicago for driver d1, delivery `endHours` from now. */
function run(endHours: number, extra: Record<string, unknown> = {}, driverId = 'd1', startHours = endHours - 6): Load {
  return load({
    stops: [
      stop({ id: 'a', type: 'pickup', sequence: 0, city: 'Kenosha, WI', appt: at(startHours), driverId }),
      stop({ id: 'b', type: 'delivery', sequence: 1, city: 'Chicago, IL', appt: at(endHours), driverId }),
    ],
    ...extra,
  })
}

const base = { equipment: [truck], now: NOW, horizonDays: 7, canSeeMoney: true, dailyValueCents: null }

describe('who counts as own fleet', () => {
  it('is Ivan\'s active drivers: not owner operators, box trucks or the brokered placeholders', () => {
    expect(isOwnFleetDriver(driver())).toBe(true)
    expect(isOwnFleetDriver(driver({ active: false }))).toBe(false)
    expect(isOwnFleetDriver(driver({ fleetGroup: 'OWNER_OPERATOR' }))).toBe(false)
    expect(isOwnFleetDriver(driver({ fleetGroup: 'BOX_TRUCK' }))).toBe(false)
    expect(isOwnFleetDriver(driver({ type: 'broker' }))).toBe(false)
  })
})

describe('where a truck goes empty', () => {
  it('is the last stop of the load, in that city, at its appointment, with nothing booked', () => {
    const r = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(30)] })
    expect(r.rows).toHaveLength(1)
    const row = r.rows[0]
    expect(row.driverName).toBe('Joshua Kly')
    expect(row.truck).toBe('685')
    expect(row.emptyAt).toBe(NOW + 30 * H)
    expect(row.point.place).toBe('Chicago, IL')
    expect(row.point.approx).toBe(false)
    expect(row.kind).toBe('IDLE')
    expect(row.next).toBeNull()
    expect(row.openEnded).toBe(true)
    expect(row.alreadyEmpty).toBe(false)
    // Open-ended idle runs to the end of the 7-day window.
    expect(row.idleDays).toBeCloseTo((7 * DAY - 30 * H) / DAY, 1)
  })

  it('is empty after the LAST stop of a multi-stop load, and only the driver\'s own stops count', () => {
    const l = load({
      stops: [
        stop({ id: 'a', type: 'pickup', sequence: 0, city: 'Kenosha, WI', appt: at(2) }),
        stop({ id: 'b', type: 'delivery', sequence: 1, city: 'Elgin, IL', appt: at(5) }),
        stop({ id: 'c', type: 'delivery', sequence: 2, city: 'Joliet, IL', appt: at(9) }),
        // Someone else takes the last drop: it is not this driver's.
        stop({ id: 'd', type: 'delivery', sequence: 3, city: 'Madison, WI', appt: at(20), driverId: 'other' }),
      ],
    })
    const [row] = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [l] }).rows
    expect(row.point.place).toBe('Joliet, IL')
    expect(row.emptyAt).toBe(NOW + 9 * H)
  })

  it('uses the time the stop actually left, and says so when it is already empty', () => {
    const l = load({
      stops: [
        stop({ id: 'a', type: 'pickup', sequence: 0, city: 'Kenosha, WI', appt: at(-30), arrivedAt: at(-30), departedAt: at(-28) }),
        stop({ id: 'b', type: 'delivery', sequence: 1, city: 'Chicago, IL', appt: at(-24), arrivedAt: at(-25), departedAt: at(-23) }),
      ],
      status: 'DELIVERED',
    })
    const [row] = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [l] }).rows
    expect(row.emptyAt).toBe(NOW - 23 * H)
    expect(row.alreadyEmpty).toBe(true)
    expect(row.late).toBe(false)
  })

  it('flags a stop past its appointment that nobody marked departed', () => {
    const [row] = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(-5)] }).rows
    expect(row.alreadyEmpty).toBe(true)
    expect(row.late).toBe(true)
    expect(row.emptyAt).toBe(NOW - 5 * H)
  })

  it('counts a stop with only a day as that evening and says the time is not known', () => {
    // 2026-11-19 at Chicago midnight = FCFS style.
    const l = load({
      stops: [
        stop({ id: 'a', type: 'pickup', sequence: 0, city: 'Kenosha, WI', appt: '2026-11-19T06:00:00Z', apptType: 'fcfs' }),
        stop({ id: 'b', type: 'delivery', sequence: 1, city: 'Chicago, IL', appt: '2026-11-19T06:00:00Z', apptType: 'fcfs' }),
      ],
    })
    const [row] = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [l] }).rows
    expect(row.timeKnown).toBe(false)
    expect(row.emptyAt).toBe(Date.parse('2026-11-19T23:00:00Z'))
  })

  it('leaves out voided and canceled loads, and loads whose date is not set', () => {
    const rows = computeEmptyTrucks({
      ...base, drivers: [driver()],
      loads: [run(10, { voidedAt: '2026-11-17T00:00:00Z' }), run(12, { status: 'CANCELED' }), run(14, { unscheduled: true })],
    }).rows
    expect(rows).toHaveLength(0)
  })

  it('leaves out other fleets and inactive drivers', () => {
    const drivers = [
      driver({ id: 'oo', fleetGroup: 'OWNER_OPERATOR' }), driver({ id: 'bx', fleetGroup: 'BOX_TRUCK' }),
      driver({ id: 'br', type: 'broker' }), driver({ id: 'off', active: false }),
    ]
    const loads = drivers.map((d, i) => run(10 + i, {}, d.id))
    expect(computeEmptyTrucks({ ...base, drivers, loads }).rows).toHaveLength(0)
  })

  it('treats two overlapping loads as one block of work that ends with the later one', () => {
    const rows = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(20, {}, 'd1', 2), run(26, {}, 'd1', 12)] }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].emptyAt).toBe(NOW + 26 * H)
  })

  it('does not list an empty window that already closed, or one emptied more than three days ago', () => {
    // Ended 20 h ago, next load started 10 h ago: the truck is working again.
    const closed = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(-20), run(0, {}, 'd1', -10)] }).rows
    expect(closed.map((r) => r.endLoad.pro)).not.toContain(run(-20).aljexId)
    const old = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(-5 * 24)] }).rows
    expect(old).toHaveLength(0)
  })

  it('leaves out a truck that goes empty after the window', () => {
    expect(computeEmptyTrucks({ ...base, horizonDays: 2, drivers: [driver()], loads: [run(60)] }).rows).toHaveLength(0)
    expect(computeEmptyTrucks({ ...base, horizonDays: 14, drivers: [driver()], loads: [run(60)] }).rows).toHaveLength(1)
  })
})

describe('what is booked next', () => {
  it('an idle gap names the next load and counts the days up to its pickup', () => {
    const first = run(10)
    const second = run(10 + 50 + 6, {}, 'd1', 10 + 50)
    const rows = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [first, second] }).rows
    const row = rows.find((r) => r.endLoad.id === first.id)!
    expect(row.kind).toBe('IDLE')
    expect(row.next?.loadId).toBe(second.id)
    expect(row.openEnded).toBe(false)
    expect(row.idleDays).toBeCloseTo(50 / 24, 1)
  })

  it('a next pickup within a few hours is back to back: nothing idle, no dollars, no open loads', () => {
    const first = run(10)
    const second = run(10 + BACK_TO_BACK_HOURS + 4, {}, 'd1', 10 + BACK_TO_BACK_HOURS - 1)
    const rows = computeEmptyTrucks({ ...base, dailyValueCents: 50_000, drivers: [driver()], loads: [first, second] }).rows
    const row = rows.find((r) => r.endLoad.id === first.id)!
    expect(row.kind).toBe('BACK_TO_BACK')
    expect(row.idleValueCents).toBeNull()
    expect(row.matches).toEqual([])
  })
})

describe('open loads to put an empty truck on', () => {
  const openLoad = (city: string, hoursFromNow: number, over: Record<string, unknown> = {}) => load({
    status: 'SOURCING', customer: 'Acme Foods', rate: 180_000,
    stops: [
      stop({ id: `o${seq}`, type: 'pickup', sequence: 0, city, appt: at(hoursFromNow), driverId: null }),
      stop({ id: `p${seq}`, type: 'delivery', sequence: 1, city: 'Dallas, TX', appt: at(hoursFromNow + 20), driverId: null }),
    ],
    ...over,
  })

  it('ranks by the empty run to the pickup and flags a long one', () => {
    const near = openLoad('Elgin, IL', 34)
    const far = openLoad('Indianapolis, IN', 33)
    const [row] = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(30), far, near] }).rows
    expect(row.matches.map((m) => m.loadId)).toEqual([near.id, far.id])
    expect(row.matches[0].deadheadMiles).toBeGreaterThan(20)
    expect(row.matches[0].deadheadMiles!).toBeLessThan(LONG_DEADHEAD_MILES)
    expect(row.matches[0].longDeadhead).toBe(false)
    expect(row.matches[1].longDeadhead).toBe(true)
  })

  it('only offers loads nobody has, in an own-truck division, picking up after the truck is empty and before the next load', () => {
    const covered = openLoad('Elgin, IL', 34, { carrierName: 'Redline Haulers' })
    const driven = load({ status: 'BOOKED', stops: [stop({ id: 'x', type: 'pickup', sequence: 0, city: 'Elgin, IL', appt: at(34), driverId: 'someone' }), stop({ id: 'y', type: 'delivery', sequence: 1, city: 'Dallas, TX', appt: at(50), driverId: 'someone' })] })
    const brokerage = openLoad('Elgin, IL', 34, { revDivision: 'BROKERAGE' })
    const delivered = openLoad('Elgin, IL', 34, { status: 'DELIVERED' })
    const tooEarly = openLoad('Elgin, IL', 20)
    const tooLate = openLoad('Elgin, IL', 30 + 24 * 5)
    const ok = openLoad('Joliet, IL', 40)
    const [row] = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(30), covered, driven, brokerage, delivered, tooEarly, tooLate, ok] }).rows
    expect(row.matches.map((m) => m.loadId)).toEqual([ok.id])
  })

  it('stops looking at the next booked pickup', () => {
    const first = run(10)
    const second = run(10 + 30 + 6, {}, 'd1', 10 + 30)
    const early = openLoad('Elgin, IL', 20)
    const late = openLoad('Elgin, IL', 10 + 48)
    const row = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [first, second, early, late] }).rows.find((r) => r.endLoad.id === first.id)!
    expect(row.matches.map((m) => m.loadId)).toEqual([early.id])
  })

  it('marks a run that could only be placed to the state as approximate', () => {
    const odd = openLoad('Smallville, WI', 34)
    const [row] = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(30), odd] }).rows
    expect(row.matches[0].approx).toBe(true)
    expect(row.matches[0].deadheadMiles).not.toBeNull()
  })

  it('hides customer rates from people who may not see money', () => {
    const l = openLoad('Elgin, IL', 34)
    const money = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(30), l] }).rows[0]
    const noMoney = computeEmptyTrucks({ ...base, canSeeMoney: false, drivers: [driver()], loads: [run(30), l] }).rows[0]
    expect(money.matches[0].rateCents).toBe(180_000)
    expect(noMoney.matches[0].rateCents).toBeNull()
    expect(noMoney.matches[0].customer).toBe('Acme Foods')
  })
})

describe('what sitting empty is worth', () => {
  it('is blank until a daily value is set, so no made-up dollars', () => {
    const r = computeEmptyTrucks({ ...base, drivers: [driver()], loads: [run(30)] })
    expect(r.rows[0].idleValueCents).toBeNull()
    expect(r.summary.valueCents).toBeNull()
    expect(r.summary.trucks).toBe(1)
    expect(r.summary.idleTruckDays).toBeGreaterThan(0)
  })

  it('is idle days times the daily value, summed over the idle rows', () => {
    const first = run(10)
    const second = run(10 + 48 + 6, {}, 'd1', 10 + 48)
    const r = computeEmptyTrucks({ ...base, dailyValueCents: 40_000, drivers: [driver()], loads: [first, second] })
    const row = r.rows.find((x) => x.endLoad.id === first.id)!
    expect(row.idleDays).toBeCloseTo(2, 1)
    expect(row.idleValueCents).toBe(80_000)
    expect(r.summary.valueCents).toBe(r.rows.filter((x) => x.kind === 'IDLE').reduce((n, x) => n + (x.idleValueCents ?? 0), 0))
  })

  it('never reaches people who may not see money', () => {
    const r = computeEmptyTrucks({ ...base, canSeeMoney: false, dailyValueCents: 40_000, drivers: [driver()], loads: [run(30)] })
    expect(r.rows[0].idleValueCents).toBeNull()
    expect(r.summary.valueCents).toBeNull()
  })
})

describe('order', () => {
  it('lists the soonest empty first', () => {
    const a = driver({ id: 'a', name: 'Zed' })
    const b = driver({ id: 'b', name: 'Amy', assignedTruckId: null })
    const rows = computeEmptyTrucks({ ...base, drivers: [a, b], loads: [run(40, {}, 'a'), run(12, {}, 'b')] }).rows
    expect(rows.map((r) => r.driverName)).toEqual(['Amy', 'Zed'])
    expect(rows[0].truck).toBeNull()
  })
})

describe('roadMiles', () => {
  it('is null when either end has no position', () => {
    expect(roadMiles({ lat: null, lng: null }, { lat: 42, lng: -88 })).toBeNull()
    expect(roadMiles({ lat: 42.5875, lng: -87.88 }, { lat: 41.837, lng: -87.6849 })).toBeGreaterThan(50)
  })
})
