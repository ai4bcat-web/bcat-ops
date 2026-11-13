import { describe, expect, it } from 'vitest'
import { carryStopState } from './stopCarry'

describe('carryStopState', () => {
  const previous = [
    {
      id: 'stp-1', type: 'pickup', appt: '2026-11-16T13:00:00.000Z', sequence: 0,
      apptStatus: 'confirmed', apptProofs: { request: 'appt-proofs/l/stp-1/request-1.png', e2open: 'k2', email: 'k3' },
      apptThreadTs: '123.456', apptRequestedFor: '2026-11-16', etaAt: '2026-11-16T12:00:00.000Z',
    },
    { id: 'stp-2', type: 'delivery', appt: '2026-11-17T12:00:00.000Z', sequence: 1, apptProofs: { email: 'k4' } },
  ]

  it('keeps the Appts screenshots and status when the order form saves the stops', () => {
    const next = [
      { id: 'stp-1', type: 'pickup', appt: '2026-11-16T13:00:00.000Z', name: 'MRS', sequence: 0, stopNotes: null },
      { id: 'stp-2', type: 'delivery', appt: '2026-11-17T12:00:00.000Z', sequence: 1 },
    ]
    const out = carryStopState(next, previous)
    expect(out[0].apptProofs).toEqual(previous[0].apptProofs)
    expect(out[0].apptStatus).toBe('confirmed')
    expect(out[0].apptThreadTs).toBe('123.456')
    expect(out[0].etaAt).toBe('2026-11-16T12:00:00.000Z')
    expect(out[1].apptProofs).toEqual({ email: 'k4' })
  })

  it('restarts the ladder and clears the screenshots when a confirmed appointment is moved', () => {
    const out = carryStopState([{ id: 'stp-1', type: 'pickup', appt: '2026-11-16T15:00:00.000Z', sequence: 0 }], previous)
    expect(out[0].apptStatus).toBe('need_request')
    expect(out[0].apptProofs).toEqual({ request: null, e2open: null, email: null })
    expect(out[0].apptThreadTs).toBe('123.456')
  })

  it('keeps the screenshots when an appointment without a status is moved', () => {
    const out = carryStopState([{ id: 'stp-2', type: 'delivery', appt: '2026-11-17T15:00:00.000Z', sequence: 1 }], previous)
    expect(out[0].apptProofs).toEqual({ email: 'k4' })
  })

  it('lets the form win on the fields it owns, including clearing one', () => {
    const next = [{ id: 'stp-1', type: 'pickup', appt: '2026-11-16T13:00:00.000Z', sequence: 0, name: 'NEW', etaAt: null }]
    const out = carryStopState(next, previous)
    expect(out[0].name).toBe('NEW')
    expect(out[0].etaAt).toBeNull()
  })

  it('carries nothing onto a new stop or one whose id changed', () => {
    const out = carryStopState([{ id: 'stp-new', type: 'delivery', appt: '', sequence: 0 }], previous)
    expect(out[0].apptProofs).toBeUndefined()
  })
})
