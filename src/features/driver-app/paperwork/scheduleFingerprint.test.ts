import { describe, it, expect } from 'vitest'
import { scheduleFingerprint } from './scheduleFingerprint'
import type { PaperworkLoad } from '../driverApi'

const mk = (id: string, stops: Array<Record<string, unknown>>, sortOrder: number | null = null) =>
  ({ id, reference: id, sortOrder, stops }) as unknown as PaperworkLoad
const st = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, type: 'pickup', date: '2026-10-14', yours: true, appt: '2026-10-14T13:00:00Z', apptType: 'exact', name: 'Batory', city: 'Chicago', sequence: 0, ...over })

describe('scheduleFingerprint', () => {
  it('changes when a stop is added, moved, reassigned or retimed', () => {
    const base = scheduleFingerprint([mk('a', [st('p')])], '2026-10-14')
    expect(scheduleFingerprint([mk('a', [st('p')]), mk('b', [st('q')])], '2026-10-14')).not.toBe(base)
    expect(scheduleFingerprint([mk('a', [st('p', { appt: '2026-10-14T15:00:00Z' })])], '2026-10-14')).not.toBe(base)
    expect(scheduleFingerprint([mk('a', [st('p', { yours: false })])], '2026-10-14')).not.toBe(base)
    expect(scheduleFingerprint([mk('a', [st('p')], 2)], '2026-10-14')).not.toBe(base)
  })
  it("ignores the driver's own taps and other days", () => {
    const base = scheduleFingerprint([mk('a', [st('p')])], '2026-10-14')
    expect(scheduleFingerprint([mk('a', [st('p', { arrivedAt: '2026-10-14T13:05:00Z', departedAt: '2026-10-14T13:40:00Z' })])], '2026-10-14')).toBe(base)
    expect(scheduleFingerprint([mk('a', [st('p'), st('x', { date: '2026-10-15' })])], '2026-10-14')).toBe(base)
  })
})
