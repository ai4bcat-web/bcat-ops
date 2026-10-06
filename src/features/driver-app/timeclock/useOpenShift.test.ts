/**
 * The running clock's arithmetic. It is derived from the clock-in timestamp rather than
 * counted up, which is the whole point: a phone that slept for an hour must wake showing an
 * hour more, not however many ticks it managed to fire.
 */
import { describe, it, expect } from 'vitest'
import { elapsedSeconds, elapsedLabel } from './useOpenShift'

describe('elapsedSeconds', () => {
  const start = '2026-10-06T12:00:00Z'

  it('counts from the clock-in, not from when the screen opened', () => {
    expect(elapsedSeconds(start, Date.parse('2026-10-06T19:04:31Z'))).toBe(25471)
  })

  it('does not lose time while the phone is asleep', () => {
    // Derived from the timestamp, so a gap in ticks costs nothing.
    const after = elapsedSeconds(start, Date.parse('2026-10-06T13:00:00Z'))
    expect(after).toBe(3600)
  })

  it('never goes negative on a clock skewed ahead', () => {
    // A phone whose clock is a minute fast would otherwise show "-60".
    expect(elapsedSeconds(start, Date.parse('2026-10-06T11:59:00Z'))).toBe(0)
  })

  it('is zero with no shift', () => {
    expect(elapsedSeconds(null)).toBe(0)
    expect(elapsedSeconds(undefined)).toBe(0)
    expect(elapsedSeconds('not a date')).toBe(0)
  })
})

describe('elapsedLabel', () => {
  it('reads as a clock, not a duration', () => {
    // "7:04:31" is what a running clock looks like; "7h 4m" is what a total looks like.
    expect(elapsedLabel(25471)).toBe('7:04:31')
  })

  it('pads minutes and seconds', () => {
    expect(elapsedLabel(3661)).toBe('1:01:01')
    expect(elapsedLabel(60)).toBe('0:01:00')
  })

  it('starts at zero', () => {
    expect(elapsedLabel(0)).toBe('0:00:00')
  })

  it('keeps counting past a day rather than wrapping', () => {
    // A forgotten clock-out reading 26:00:00 is exactly the thing that gets noticed.
    expect(elapsedLabel(26 * 3600)).toBe('26:00:00')
  })
})
