import { describe, expect, it } from 'vitest'
import { apptDay, isFcfsStop, stopsOutOfOrder } from './stopOrder'

describe('stopsOutOfOrder', () => {
  // PRO 20053: FCFS pickup 7am, delivery window opens 6am the same day (America/Chicago).
  const pickup7 = { appt: '2026-11-16T13:00:00.000Z', contact: { hours: 'FCFS 07:00 TO 16:00' } }
  const delivery6 = { appt: '2026-11-16T12:00:00.000Z', contact: { hours: '6am - 3pm' } }

  it('lets an FCFS pair overlap on the same day', () => {
    expect(stopsOutOfOrder(pickup7, delivery6)).toBe(false)
  })

  it('still blocks an FCFS delivery on an earlier day', () => {
    expect(stopsOutOfOrder(pickup7, { ...delivery6, appt: '2026-11-12T21:00:00.000Z' })).toBe(true)
  })

  it('blocks a same-day overlap when neither stop is FCFS', () => {
    expect(stopsOutOfOrder({ ...pickup7, contact: { hours: '7am - 4pm' } }, delivery6)).toBe(true)
  })

  it('reads FCFS from apptType too', () => {
    expect(stopsOutOfOrder({ appt: pickup7.appt, apptType: 'fcfs' }, { appt: delivery6.appt })).toBe(false)
  })

  it('allows stops in order', () => {
    expect(stopsOutOfOrder(delivery6, pickup7)).toBe(false)
  })

  it('works on the form\'s wall-clock values', () => {
    expect(stopsOutOfOrder({ appt: '2026-11-16T07:00', hours: 'fcfs' }, { appt: '2026-11-16T06:00' })).toBe(false)
    expect(stopsOutOfOrder({ appt: '2026-11-16T07:00', hours: 'fcfs' }, { appt: '2026-11-12T15:00' })).toBe(true)
    expect(stopsOutOfOrder({ appt: '2026-11-16T07:00' }, { appt: '2026-11-16T06:00' })).toBe(true)
  })
})

describe('apptDay / isFcfsStop', () => {
  it('reads an evening UTC instant as the Chicago day', () => {
    expect(apptDay('2026-11-17T03:00:00.000Z')).toBe('2026-11-16')
  })
  it('matches FCFS as a word only', () => {
    expect(isFcfsStop({ hours: 'FCFS 06:00 TO 15:00' })).toBe(true)
    expect(isFcfsStop({ hours: '7am - 6pm' })).toBe(false)
  })
})
