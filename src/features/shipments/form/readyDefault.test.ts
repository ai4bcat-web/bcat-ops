import { describe, expect, it } from 'vitest'
import { followAppt, readyFollowsAppt, withAppt } from './readyDefault'
import { emptyValues, type FormStop } from './model'

const pickup = (over: Partial<FormStop> = {}): FormStop => ({ ...emptyValues().stops[0], type: 'pickup', ...over })

describe('Ready follows the appointment', () => {
  it('fills a blank Ready from the appointment', () => {
    expect(withAppt(pickup({ ready: '', appt: '' }), '2026-11-13T07:00')).toMatchObject({ appt: '2026-11-13T07:00', ready: '2026-11-13T07:00' })
  })
  it('moves a Ready that still equals the old appointment', () => {
    expect(withAppt(pickup({ ready: '2026-11-13T07:00', appt: '2026-11-13T07:00' }), '2026-11-14T08:00').ready).toBe('2026-11-14T08:00')
  })
  it('keeps a Ready typed by hand', () => {
    const s = pickup({ ready: '2026-11-13T05:00', appt: '2026-11-13T07:00' })
    expect(readyFollowsAppt(s)).toBe(false)
    expect(withAppt(s, '2026-11-14T08:00')).toMatchObject({ appt: '2026-11-14T08:00', ready: '2026-11-13T05:00' })
  })
  it('a delivery has Must Deliver, not Ready: nothing is copied', () => {
    expect(withAppt(pickup({ type: 'delivery', ready: '' }), '2026-11-13T07:00').ready).toBe('')
  })
  it('an FCFS window opening counts as the appointment', () => {
    const prev = pickup({ ready: '', appt: '', fcfs: false })
    const next = { ...prev, fcfs: true, appt: '2026-11-13T07:00', apptEnd: '2026-11-13T16:00' }
    expect(followAppt(prev, next)).toMatchObject({ fcfs: true, ready: '2026-11-13T07:00' })
    expect(followAppt(prev, { ...prev, fcfs: true })).toEqual({ ...prev, fcfs: true })
  })
})
