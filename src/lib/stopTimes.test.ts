import { describe, it, expect } from 'vitest'
import { stopTapsLine, podSentAtFrom } from './stopTimes'

describe('stopTapsLine', () => {
  it('reads a pickup as on site then departed', () => {
    expect(stopTapsLine({ type: 'pickup', arrivedAt: '2026-10-15T14:12:00Z', departedAt: '2026-10-15T14:48:00Z' })).toBe('On site 9:12 AM · Departed 9:48 AM')
  })
  it('reads a delivery as on site, POD sent, delivered', () => {
    expect(stopTapsLine({ type: 'delivery', arrivedAt: '2026-10-15T18:05:00Z', departedAt: '2026-10-15T18:30:00Z' }, '2026-10-15T18:22:00Z')).toBe('On site 1:05 PM · POD sent 1:22 PM · Delivered 1:30 PM')
  })
  it('shows only what was recorded, and nothing when nothing was', () => {
    expect(stopTapsLine({ type: 'pickup', arrivedAt: '2026-10-15T14:12:00Z', departedAt: null })).toBe('On site 9:12 AM')
    expect(stopTapsLine({ type: 'delivery', arrivedAt: null, departedAt: null })).toBeNull()
  })
})

describe('podSentAtFrom', () => {
  it('takes the earliest POD page and ignores other kinds', () => {
    expect(podSentAtFrom([
      { kind: 'POD', uploadedAt: '2026-10-15T18:25:00Z' },
      { kind: 'POD', uploadedAt: '2026-10-15T18:22:00Z' },
      { kind: 'RATECON', uploadedAt: '2026-10-15T10:00:00Z' },
    ])).toBe('2026-10-15T18:22:00Z')
    expect(podSentAtFrom([])).toBeNull()
  })
})
