import { describe, it, expect } from 'vitest'
import { dayMpg } from './handler'

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
