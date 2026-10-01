import { describe, it, expect } from 'vitest'
import { dayMpg, dayFuelGallons, dayMiles } from './handler'

describe('dayMpg', () => {
  it('reports economy for a day that moved and burned fuel', () => {
    expect(dayMpg(480, 60)).toBe(8)
  })

  it('reports nothing when the odometer never moved but fuel was burned', () => {
    // Seen in production: Motive returned 46 gallons of driving fuel for a truck
    // whose only odometer reading was the one we already had, which wrote 0.0 MPG
    // onto the page next to a day the driver had actually driven.
    expect(dayMpg(0, 46.8)).toBeNull()
  })

  it('reports nothing when a reading is missing entirely', () => {
    expect(dayMpg(null, 46.8)).toBeNull()
    expect(dayMpg(480, null)).toBeNull()
    expect(dayMpg(480, 0)).toBeNull()
  })
})

describe('dayFuelGallons', () => {
  it('counts the fuel idled away alongside the fuel driven', () => {
    // The production row for unit 0012: 55.06 driving + 2.58 idle. Driving alone
    // reads ~5% better than the pump, and the pump is what the driver checks.
    expect(dayFuelGallons(55.06, 2.58)).toBeCloseTo(57.64, 2)
  })

  it('still reports a figure when Motive breaks out only one of the two', () => {
    expect(dayFuelGallons(40, null)).toBe(40)
    expect(dayFuelGallons(null, 3)).toBe(3)
  })

  it('reports nothing when Motive reported neither', () => {
    expect(dayFuelGallons(null, null)).toBeNull()
  })
})

describe('dayMiles', () => {
  it('measures the day against the previous reading', () => {
    expect(dayMiles(448_100, 448_584)).toBe(484)
  })

  it('reports nothing when there is no earlier reading to measure against', () => {
    // First day of a fresh deploy: no prior row, so the day is unknown, not zero.
    expect(dayMiles(null, 448_584)).toBeNull()
  })

  it('refuses to turn a backwards odometer into negative miles', () => {
    // An ECM swap or a unit reassignment reads lower than yesterday; a negative
    // day would silently cancel real miles out of the week total.
    expect(dayMiles(448_584, 100)).toBe(0)
  })
})
