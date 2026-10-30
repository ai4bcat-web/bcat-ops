import { describe, it, expect } from 'vitest'
import {
  TRACKING_ETA_BASIS_LABELS, etaToStop, trackingEtaEstimate, trackingEtaFromMatrix,
} from './trackingEta'

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

describe('trackingEtaEstimate', () => {
  const joliet = { lat: 41.525, lng: -88.0817 }
  const dallas = { lat: 32.7767, lng: -96.797, appt: '2026-10-23T09:00:00.000Z' }

  it('projects arrival from the ping, not from now', () => {
    const ping = '2026-10-21T12:00:00.000Z'
    const now = '2026-10-21T12:30:00.000Z'
    const result = trackingEtaEstimate(joliet, dallas, ping, now)

    expect(result.basis).toBe('ESTIMATE')
    expect(result.basisLabel).toBe(TRACKING_ETA_BASIS_LABELS.ESTIMATE)
    expect(Date.parse(result.etaAt)).toBeCloseTo(
      Date.parse(ping) + result.driveMinutes * 60_000,
      -2, // fractional drive minutes land on sub-second arrival times
    )
  })

  it('clamps a stale ping to now instead of reading as already arrived', () => {
    // The truck is two minutes from the stop but the ping is a day old.
    const nearStop = { lat: 32.78, lng: -96.80, appt: null }
    const ping = '2026-10-21T12:00:00.000Z'
    const now = '2026-10-22T12:00:00.000Z'
    const result = trackingEtaEstimate(nearStop, dallas, ping, now)

    expect(result.etaAt).toBe(now)
  })

  it('reports lateBy against the appointment when the clamped eta is past it', () => {
    const ping = '2026-10-21T12:00:00.000Z'
    const now = '2026-10-23T12:00:00.000Z' // after the 09:00 appointment
    const result = trackingEtaEstimate(joliet, dallas, ping, now)

    expect(result.lateBy).toBeGreaterThan(0)
  })

  it('throws on an invalid ping timestamp', () => {
    expect(() => trackingEtaEstimate(joliet, dallas, 'not-a-date', '2026-10-21T12:00:00.000Z')).toThrow()
  })
})

describe('trackingEtaFromMatrix', () => {
  const stop = { appt: '2026-10-21T15:00:00.000Z' }

  it('converts meters and seconds and keeps the matrix basis', () => {
    const ping = '2026-10-21T12:00:00.000Z'
    const leg = { distanceMeters: 160_934.4, durationSeconds: 7_200 } // 100 mi, 2 h
    const result = trackingEtaFromMatrix(stop, ping, ping, leg)

    expect(result.miles).toBeCloseTo(100, 3)
    expect(result.driveMinutes).toBeCloseTo(120, 3)
    expect(result.etaAt).toBe('2026-10-21T14:00:00.000Z')
    expect(result.lateBy).toBeNull()
    expect(result.basis).toBe('GOOGLE_DISTANCE_MATRIX')
    expect(result.basisLabel).toBe(TRACKING_ETA_BASIS_LABELS.GOOGLE_DISTANCE_MATRIX)
  })

  it('flags arrival past the appointment', () => {
    const ping = '2026-10-21T12:00:00.000Z'
    const leg = { distanceMeters: 0, durationSeconds: 4 * 3_600 } // 4 h → 16:00 vs 15:00 appt
    const result = trackingEtaFromMatrix(stop, ping, ping, leg)

    expect(result.lateBy).toBe(60)
  })
})
