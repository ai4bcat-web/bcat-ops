import { describe, it, expect } from 'vitest'
import { buildDayLegs, totals, emptyMilesByCustomer, type DayEvent } from './deadhead'

const ev = (over: Partial<DayEvent> & { at: string; kind: DayEvent['kind']; odometer: number | null }): DayEvent => over

describe('buildDayLegs', () => {
  it('labels a normal day: yard→P1 empty, P1→D1 loaded, D1→P2 empty, P2→D2 loaded, D2→yard empty', () => {
    const d = buildDayLegs([
      ev({ at: '2026-10-15T11:00:00Z', kind: 'CLOCK_IN', odometer: 1000, place: 'Yard' }),
      ev({ at: '2026-10-15T12:00:00Z', kind: 'ARRIVED', odometer: 1059, stopType: 'pickup', loadId: 'L1', place: 'Batory', customer: 'BATORY FOODS' }),
      ev({ at: '2026-10-15T12:40:00Z', kind: 'DEPARTED', odometer: 1059, stopType: 'pickup', loadId: 'L1', place: 'Batory' }),
      ev({ at: '2026-10-15T14:00:00Z', kind: 'ARRIVED', odometer: 1104, stopType: 'delivery', loadId: 'L1', place: 'Eagle' }),
      ev({ at: '2026-10-15T15:00:00Z', kind: 'ARRIVED', odometer: 1124, stopType: 'pickup', loadId: 'L2', place: 'Carlyn', customer: 'CARLYN' }),
      ev({ at: '2026-10-15T15:30:00Z', kind: 'DEPARTED', odometer: 1124, stopType: 'pickup', loadId: 'L2', place: 'Carlyn' }),
      ev({ at: '2026-10-15T17:00:00Z', kind: 'ARRIVED', odometer: 1180, stopType: 'delivery', loadId: 'L2', place: 'Jewel' }),
      ev({ at: '2026-10-15T19:00:00Z', kind: 'CLOCK_OUT', odometer: 1240, place: 'Yard' }),
    ])
    expect(d.legs.map((l) => [l.from, l.to, l.miles, l.loaded])).toEqual([
      ['Yard', 'Batory', 59, false],
      ['Batory', 'Eagle', 45, true],
      ['Eagle', 'Carlyn', 20, false],
      ['Carlyn', 'Jewel', 56, true],
      ['Jewel', 'Yard', 60, false],
    ])
    expect(d.loadedMiles).toBe(101)
    expect(d.emptyMiles).toBe(139)
    expect(d.unknownLegs).toBe(0)
    expect(d.onboardAtEnd).toEqual([])
    expect(d.legs[0].towardCustomer).toBe('BATORY FOODS')
    expect(d.legs[2].towardLoadId).toBe('L2')
  })

  it('a pickup not delivered by clock out makes the ride home loaded and carries into the next morning', () => {
    const night = buildDayLegs([
      ev({ at: '2026-10-15T20:00:00Z', kind: 'DEPARTED', odometer: 2000, stopType: 'pickup', loadId: 'L3', place: 'Batory' }),
      ev({ at: '2026-10-15T21:00:00Z', kind: 'CLOCK_OUT', odometer: 2059, place: 'Yard' }),
    ])
    expect(night.legs[0].loaded).toBe(true)
    expect(night.onboardAtEnd).toEqual(['L3'])
    const morning = buildDayLegs([
      ev({ at: '2026-10-16T11:00:00Z', kind: 'CLOCK_IN', odometer: 2059, place: 'Yard' }),
      ev({ at: '2026-10-16T12:30:00Z', kind: 'ARRIVED', odometer: 2150, stopType: 'delivery', loadId: 'L3', place: 'Eagle' }),
      ev({ at: '2026-10-16T13:30:00Z', kind: 'ARRIVED', odometer: 2180, stopType: 'pickup', loadId: 'L4', place: 'Batory' }),
    ], night.onboardAtEnd)
    expect(morning.legs.map((l) => [l.miles, l.loaded])).toEqual([[91, true], [30, false]])
  })

  it('two pickups before a delivery keep the truck loaded the whole way, counted once', () => {
    const d = buildDayLegs([
      ev({ at: '2026-10-15T12:00:00Z', kind: 'DEPARTED', odometer: 100, stopType: 'pickup', loadId: 'A', place: 'P1' }),
      ev({ at: '2026-10-15T13:00:00Z', kind: 'DEPARTED', odometer: 130, stopType: 'pickup', loadId: 'B', place: 'P2' }),
      ev({ at: '2026-10-15T14:00:00Z', kind: 'ARRIVED', odometer: 170, stopType: 'delivery', loadId: 'A', place: 'D1' }),
      ev({ at: '2026-10-15T15:00:00Z', kind: 'ARRIVED', odometer: 190, stopType: 'delivery', loadId: 'B', place: 'D2' }),
    ])
    expect(d.loadedMiles).toBe(90)
    expect(d.emptyMiles).toBe(0)
    expect(d.legs[1].loadIds).toEqual(['A', 'B'])
  })

  it('a missing reading makes that leg unknown instead of inventing miles', () => {
    const d = buildDayLegs([
      ev({ at: '2026-10-15T11:00:00Z', kind: 'CLOCK_IN', odometer: 1000, place: 'Yard' }),
      ev({ at: '2026-10-15T12:00:00Z', kind: 'ARRIVED', odometer: null, stopType: 'pickup', loadId: 'L1', place: 'Batory' }),
      ev({ at: '2026-10-15T12:30:00Z', kind: 'DEPARTED', odometer: 1059, stopType: 'pickup', loadId: 'L1', place: 'Batory' }),
      ev({ at: '2026-10-15T14:00:00Z', kind: 'ARRIVED', odometer: 1104, stopType: 'delivery', loadId: 'L1', place: 'Eagle' }),
    ])
    expect(d.unknownLegs).toBe(2)
    expect(d.loadedMiles).toBe(45)
    expect(d.emptyMiles).toBe(0)
  })

  it('an odometer that goes backwards never yields negative miles', () => {
    const d = buildDayLegs([
      ev({ at: '2026-10-15T11:00:00Z', kind: 'CLOCK_IN', odometer: 1000 }),
      ev({ at: '2026-10-15T12:00:00Z', kind: 'ARRIVED', odometer: 990, stopType: 'pickup', loadId: 'L1' }),
    ])
    expect(d.emptyMiles).toBe(0)
    expect(d.legs).toEqual([])   // clamps to a zero-mile hop, which is dropped
  })
})

describe('totals and emptyMilesByCustomer', () => {
  const day = buildDayLegs([
    ev({ at: '2026-10-15T11:00:00Z', kind: 'CLOCK_IN', odometer: 0, place: 'Yard' }),
    ev({ at: '2026-10-15T12:00:00Z', kind: 'ARRIVED', odometer: 60, stopType: 'pickup', loadId: 'L1', customer: 'Batory Foods' }),
    ev({ at: '2026-10-15T12:10:00Z', kind: 'DEPARTED', odometer: 60, stopType: 'pickup', loadId: 'L1' }),
    ev({ at: '2026-10-15T13:00:00Z', kind: 'ARRIVED', odometer: 100, stopType: 'delivery', loadId: 'L1' }),
    ev({ at: '2026-10-15T14:00:00Z', kind: 'ARRIVED', odometer: 125, stopType: 'pickup', loadId: 'L2', customer: 'rojac' }),
  ])
  it('sums across days and reports the empty share', () => {
    const t = totals([day, day])
    expect(t.loadedMiles).toBe(80)
    expect(t.emptyMiles).toBe(170)
    expect(t.emptyShare).toBeCloseTo(170 / 250, 6)
    expect(totals([]).emptyShare).toBeNull()
  })
  it('charges empty miles to the customer the truck was heading to', () => {
    expect(emptyMilesByCustomer([day])).toEqual([
      { customer: 'BATORY FOODS', emptyMiles: 60, legs: 1 },
      { customer: 'ROJAC', emptyMiles: 25, legs: 1 },
    ])
  })
})
