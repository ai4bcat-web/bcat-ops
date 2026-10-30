import { describe, it, expect } from 'vitest'
import { etaToStop } from './trackingEta'

describe('etaToStop', () => {
  const origin = { lat: 41.525, lng: -88.082 } // Joliet, IL area
  const dallas = { lat: 32.7767, lng: -96.797 }
  const appt = '2026-10-22T09:00:00.000Z'

  it('returns miles, drive minutes and an eta in the future', () => {
    const now = '2026-10-21T12:00:00.000Z'
    const result = etaToStop(origin, { ...dallas, appt }, now)

    expect(result.miles).toBeGreaterThan(700)
    expect(result.miles).toBeLessThan(900)
    expect(result.driveMinutes).toBeGreaterThan(0)
    expect(result.etaAt).toMatch(/^\d{4}-/)
    expect(Date.parse(result.etaAt)).toBeGreaterThan(Date.parse(now))
    expect(result.lateBy).toBeNull()
  })

  it('is on time when the ETA is before the appointment', () => {
    const now = '2026-10-20T12:00:00.000Z'
    const result = etaToStop(origin, { ...dallas, appt }, now)
    expect(result.lateBy).toBeNull()
  })

  it('reports lateBy when the ETA is past the appointment', () => {
    const now = '2026-10-22T12:00:00.000Z'
    const result = etaToStop(origin, { ...dallas, appt }, now)
    expect(result.lateBy).toBeGreaterThan(0)
  })

  it('clamps an already-arrived ETA to now and still reports lateBy', () => {
    const stop = { lat: origin.lat, lng: origin.lng, appt }
    const now = '2026-10-22T12:00:00.000Z'
    const result = etaToStop(origin, stop, now)

    expect(result.miles).toBe(0)
    expect(result.driveMinutes).toBe(0)
    expect(result.etaAt).toBe(now)
    expect(result.lateBy).toBeGreaterThan(0)
  })

  it('treats a missing appointment as not late', () => {
    const result = etaToStop(origin, { ...dallas, appt: null }, '2026-10-22T12:00:00.000Z')
    expect(result.lateBy).toBeNull()
  })
})
