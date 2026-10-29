// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { motionOf, relativeTime } from './motion'

describe('motionOf', () => {
  const now = Date.parse('2026-10-29T12:00:00.000Z')

  it('is Moving when the place changed within 90 minutes', () => {
    expect(
      motionOf({
        lastUpdateAt: '2026-10-29T10:45:00.000Z',
        lastUpdatePlace: 'Dallas, TX',
        previousUpdateAt: '2026-10-29T09:00:00.000Z',
        previousUpdatePlace: 'Austin, TX',
        nowMs: now,
      }),
    ).toBe('Moving')
  })

  it('is Stopped when the place is unchanged and the ping is recent', () => {
    expect(
      motionOf({
        lastUpdateAt: '2026-10-29T10:45:00.000Z',
        lastUpdatePlace: 'Dallas, TX',
        previousUpdateAt: '2026-10-29T09:00:00.000Z',
        previousUpdatePlace: 'Dallas, TX',
        nowMs: now,
      }),
    ).toBe('Stopped')
  })

  it('is No signal when the newest ping is older than 4 hours', () => {
    expect(
      motionOf({
        lastUpdateAt: '2026-10-29T06:00:00.000Z',
        lastUpdatePlace: 'Dallas, TX',
        previousUpdateAt: '2026-10-29T04:00:00.000Z',
        previousUpdatePlace: 'Austin, TX',
        nowMs: now,
      }),
    ).toBe('No signal')
  })

  it('is No signal when there is no ping at all', () => {
    expect(motionOf({ nowMs: now })).toBe('No signal')
  })

  it('does not infer a stop from one position or from old movement', () => {
    expect(motionOf({ lastUpdateAt: '2026-10-29T11:30:00Z', lastUpdatePlace: 'Dallas, TX', nowMs: now })).toBe('No signal')
    expect(motionOf({ lastUpdateAt: '2026-10-29T09:00:00Z', lastUpdatePlace: 'Dallas, TX',
      previousUpdateAt: '2026-10-29T08:30:00Z', previousUpdatePlace: 'Austin, TX', nowMs: now })).toBe('No signal')
  })

  it('includes exactly 90 minutes of movement, but rejects reversed fixes', () => {
    const evidence = { lastUpdateAt: '2026-10-29T10:30:00Z', lastUpdatePlace: 'Dallas, TX',
      previousUpdateAt: '2026-10-29T09:00:00Z', previousUpdatePlace: 'Austin, TX', nowMs: now }
    expect(motionOf(evidence)).toBe('Moving')
    expect(motionOf({ ...evidence, nowMs: now + 1 })).toBe('No signal')
    expect(motionOf({ ...evidence, previousUpdateAt: '2026-10-29T11:00:00Z' })).toBe('No signal')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-10-29T12:00:00.000Z')

  it('describes a future appointment', () => {
    expect(relativeTime('2026-10-29T12:30:00.000Z', now)).toBe('in 30 min')
  })

  it('describes a past ping', () => {
    expect(relativeTime('2026-10-29T10:00:00.000Z', now)).toBe('2 h ago')
  })

  it('returns null for missing values', () => {
    expect(relativeTime(null, now)).toBeNull()
    expect(relativeTime(undefined, now)).toBeNull()
  })
})
