import { describe, it, expect } from 'vitest'
import {
  apptWorkflowStatus, canMarkRequested, canMarkConfirmed, changeNeededPatch, canSetChangeNeeded,
} from './apptStatus'
import { fromDateInput, fromDateTimeInput } from './date'
import type { Load, Stop } from '@/types'

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 'p', type: 'pickup', appt: fromDateTimeInput('2026-09-10T09:00'),
  apptType: 'exact', driverId: null, sequence: 0, ...over,
})
const batory = { customer: 'BATORY FOODS' } as Load
const acme = { customer: 'Acme Freight' } as Load

describe('apptWorkflowStatus', () => {
  it('non-Batory: RATECON NEEDED until the ratecon is on the load, then confirmed', () => {
    expect(apptWorkflowStatus(stop(), acme)).toBe('ratecon_needed')
    expect(apptWorkflowStatus(stop(), { ...acme, rateConfirmKey: 'rate-confirms/x' } as Load)).toBe('confirmed')
  })

  it('Batory: an explicit ladder status wins', () => {
    for (const s of ['need_request', 'need_book', 'requested', 'confirmed', 'change_needed'] as const) {
      expect(apptWorkflowStatus(stop({ apptStatus: s }), batory)).toBe(s)
    }
  })

  it('grandfathers pre-ladder Batory stops: booked+proofed → confirmed, booked → requested', () => {
    expect(apptWorkflowStatus(stop({ apptProofs: { e2open: 'a', email: 'b' } }), batory)).toBe('confirmed')
    expect(apptWorkflowStatus(stop(), batory)).toBe('requested')
    expect(apptWorkflowStatus(stop({ apptType: 'tbd', appt: fromDateInput('2026-09-10') }), batory)).toBe('need_request')
    expect(apptWorkflowStatus(stop({ type: 'delivery', apptType: 'tbd', appt: fromDateInput('2026-09-10') }), batory)).toBe('need_book')
    expect(apptWorkflowStatus(stop({ apptMoveRequested: true }), batory)).toBe('change_needed')
  })
})

describe('screenshot gates', () => {
  it('REQUESTED needs the request-email screenshot', () => {
    expect(canMarkRequested(stop())).toBe(false)
    expect(canMarkRequested(stop({ apptProofs: { request: 'k' } }))).toBe(true)
  })
  it('CONFIRMED needs the confirmed-email AND e2open screenshots', () => {
    expect(canMarkConfirmed(stop({ apptProofs: { request: 'k' } }))).toBe(false)
    expect(canMarkConfirmed(stop({ apptProofs: { e2open: 'a' } }))).toBe(false)
    expect(canMarkConfirmed(stop({ apptProofs: { e2open: 'a', email: 'b' } }))).toBe(true)
  })
})

describe('CHANGE NEEDED', () => {
  it('only Ruben or Ryne may set it', () => {
    expect(canSetChangeNeeded('ryne@bcatcorp.com')).toBe(true)
    expect(canSetChangeNeeded('Ruben@bcatcorp.com')).toBe(true)
    expect(canSetChangeNeeded('dennis@bcatcorp.com')).toBe(false)
    expect(canSetChangeNeeded(null)).toBe(false)
  })
  it('entering it records the wanted time and clears EVERY screenshot', () => {
    const p = changeNeededPatch(fromDateTimeInput('2026-09-12T13:00'))
    expect(p.apptStatus).toBe('change_needed')
    expect(p.apptChangeTo).toBe(fromDateTimeInput('2026-09-12T13:00'))
    expect(p.apptMoveRequested).toBe(true)
    expect(p.apptProofs).toEqual({ request: null, e2open: null, email: null })
  })
})
