/**
 * One PM rule for the dashboard and the driver app. The case that matters most is the
 * missing input: a truck with no last-PM reading must not read as "25,000 miles to go".
 */
import { describe, it, expect } from 'vitest'
import { pmStatus, PM_INTERVAL_MI, PM_DUE_SOON_MI } from './pmDue'

describe('pmStatus', () => {
  it('counts down from the last PM plus the interval', () => {
    const s = pmStatus({ lastPmMileage: 100_000, currentOdometer: 110_000 })
    expect(s.nextDueAt).toBe(125_000)
    expect(s.remaining).toBe(15_000)
    expect(s.state).toBe('OK')
    expect(s.label).toMatch(/Next PM in 15,000 mi/)
  })

  it('goes amber inside the due-soon window', () => {
    const s = pmStatus({ lastPmMileage: 100_000, currentOdometer: 125_000 - PM_DUE_SOON_MI + 1 })
    expect(s.state).toBe('DUE_SOON')
    expect(s.label).toMatch(/PM due in/)
  })

  it('treats the boundary as due soon, not OK', () => {
    const s = pmStatus({ lastPmMileage: 100_000, currentOdometer: 125_000 - PM_DUE_SOON_MI })
    expect(s.state).toBe('DUE_SOON')
  })

  it('reports overdue with how far past it is', () => {
    const s = pmStatus({ lastPmMileage: 100_000, currentOdometer: 126_500 })
    expect(s.state).toBe('OVERDUE')
    expect(s.remaining).toBe(-1_500)
    expect(s.label).toMatch(/PM overdue by 1,500 mi/)
  })

  it('is overdue exactly at the due odometer', () => {
    expect(pmStatus({ lastPmMileage: 100_000, currentOdometer: 125_000 }).state).toBe('OVERDUE')
  })

  it('says the PM is unscheduled when no last PM is on file', () => {
    // Not "25,000 mi to go" — that would read as reassurance nobody earned.
    const s = pmStatus({ lastPmMileage: null, currentOdometer: 110_000 })
    expect(s.state).toBe('UNKNOWN')
    expect(s.remaining).toBeNull()
    expect(s.nextDueAt).toBeNull()
    expect(s.label).toMatch(/not scheduled/)
  })

  it('says it is waiting on Motive when no odometer has been reported', () => {
    const s = pmStatus({ lastPmMileage: 100_000, currentOdometer: null })
    expect(s.state).toBe('UNKNOWN')
    expect(s.nextDueAt).toBe(125_000)
    expect(s.label).toMatch(/waiting on an odometer reading/)
  })

  it('treats a zero odometer as no reading, which is what Motive sends for a silent truck', () => {
    expect(pmStatus({ lastPmMileage: 100_000, currentOdometer: 0 }).state).toBe('UNKNOWN')
  })

  it('keeps the last PM date for display', () => {
    expect(pmStatus({ lastPmMileage: 1, currentOdometer: 2, lastPmDate: '2026-08-01' }).lastPmDate)
      .toBe('2026-08-01')
  })

  it('uses the fleet interval', () => {
    expect(PM_INTERVAL_MI).toBe(25_000)
  })
})
