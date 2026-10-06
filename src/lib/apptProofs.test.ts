/**
 * The completeness badge must count every stop.
 *
 * It used to count only the first pickup and the last delivery, so a three-stop Batory
 * load could show a green, complete 6/6 while the middle stop had nothing on it. A badge
 * that reads finished while a stop is unproven is worse than no badge: it is the one place
 * somebody checks before they stop chasing.
 */
import { describe, it, expect } from 'vitest'
import { loadProofCount, stopProofCount, PROOFS_PER_STOP } from './apptProofs'
import type { Load, Stop } from '@/types'

const stop = (id: string, type: 'pickup' | 'delivery', proofs?: Stop['apptProofs']): Stop => ({
  id, type, sequence: 0, driverId: null, appt: '2026-10-08T17:00:00.000Z',
  apptType: 'tbd', ...(proofs ? { apptProofs: proofs } : {}),
} as Stop)

const load = (stops: Stop[]): Load => ({ id: 'l1', stops } as unknown as Load)
const all = { request: 'r', e2open: 'e', email: 'm' }

describe('loadProofCount', () => {
  it('wants three screenshots for every stop, not only the two ends', () => {
    const l = load([stop('a', 'pickup'), stop('b', 'pickup'), stop('c', 'delivery')])
    expect(loadProofCount(l).want).toBe(3 * PROOFS_PER_STOP)
  })

  it('does NOT read complete while a middle stop is unproven', () => {
    // The exact false all-clear: both ends fully evidenced, middle stop bare.
    const l = load([stop('a', 'pickup', all), stop('b', 'pickup'), stop('c', 'delivery', all)])
    const { have, want } = loadProofCount(l)
    expect(have).toBe(6)
    expect(want).toBe(9)
    expect(have).toBeLessThan(want)
  })

  it('reads complete once every stop is evidenced', () => {
    const l = load([stop('a', 'pickup', all), stop('b', 'pickup', all), stop('c', 'delivery', all)])
    const { have, want } = loadProofCount(l)
    expect(have).toBe(want)
  })

  it('is unchanged for an ordinary two-stop shipment', () => {
    const l = load([stop('a', 'pickup', all), stop('b', 'delivery', all)])
    expect(loadProofCount(l)).toEqual({ have: 6, want: 6 })
  })

  it('counts partial evidence on a stop', () => {
    expect(stopProofCount(stop('a', 'pickup', { request: 'r', e2open: null, email: null }))).toBe(1)
  })
})
