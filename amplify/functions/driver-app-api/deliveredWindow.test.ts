import { describe, it, expect } from 'vitest'
import { deliveredWindowEnd, firstHiddenDay, isDeliveredByNow } from './deliveredWindow'

// Monday of the 2026-10-04 pay week.
const NOW = new Date('2026-10-05T09:00:00Z')

describe('deliveredWindowEnd', () => {
  it('stops the week in progress at the end of today', () => {
    // The week runs to 10-11, but a driver may not see past today.
    expect(deliveredWindowEnd('2026-10-04', NOW)).toBe('2026-10-06')
  })

  it('leaves a finished week alone', () => {
    expect(deliveredWindowEnd('2026-09-27', NOW)).toBe('2026-10-04')
  })

  it('shows nothing for a week that has not started', () => {
    // Bound lands before the week does, so the query matches no row.
    const end = deliveredWindowEnd('2026-10-11', NOW)
    expect(end).toBe('2026-10-06')
    expect(end <= '2026-10-11').toBe(true)
  })
})

describe('isDeliveredByNow', () => {
  it('includes a delivery appointed earlier today', () => {
    // The driver who delivered at 08:00 sees it at 09:00, not tomorrow.
    expect(isDeliveredByNow('2026-10-05T08:00:00.000Z', NOW)).toBe(true)
  })

  it('includes a delivery appointed later today', () => {
    /*
     * Deliberate. Nothing in the data records an actual delivery, so the only alternative
     * to this is hiding a load the driver has already run.
     */
    expect(isDeliveredByNow('2026-10-05T23:00:00.000Z', NOW)).toBe(true)
  })

  it('excludes tomorrow and beyond', () => {
    expect(isDeliveredByNow('2026-10-06T00:00:00.000Z', NOW)).toBe(false)
    expect(isDeliveredByNow('2026-10-09T18:00:00.000Z', NOW)).toBe(false)
  })

  it('excludes a load with no delivery appointment', () => {
    expect(isDeliveredByNow(null, NOW)).toBe(false)
    expect(isDeliveredByNow('', NOW)).toBe(false)
  })

  it('firstHiddenDay is tomorrow', () => {
    expect(firstHiddenDay(NOW)).toBe('2026-10-06')
  })
})
