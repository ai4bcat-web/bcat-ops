import { describe, expect, it } from 'vitest'
import { CUSTOMER, filledValues } from './testFixtures'
import { firstPickupIndex, lastDeliveryIndex, toStops } from './mapping'
import { validateForm } from './validation'
import { formatApptTime, apptTimeLabel } from '@/lib/date'

const base = { mode: 'create' as const, settings: null }

function fcfsValues(from: string, to: string) {
  const v = filledValues()
  v.stops = v.stops.filter((s) => s.id !== 'stp-b') // one pickup, one delivery
  const fp = firstPickupIndex(v.stops)
  v.stops[fp] = { ...v.stops[fp], fcfs: true, appt: `2026-11-16T${from}`, apptEnd: `2026-11-16T${to}` }
  return { v, fp }
}

describe('FCFS appointment window', () => {
  it('saves as apptType fcfs with appt = opens, apptEnd = closes', () => {
    const { v, fp } = fcfsValues('07:00', '16:00')
    const stop = toStops(v)[fp]
    expect(stop.apptType).toBe('fcfs')
    expect(stop.appt).toBe('2026-11-16T13:00:00.000Z')
    expect(stop.apptEnd).toBe('2026-11-16T22:00:00.000Z')
  })

  it('an ordinary appointment stays exact and carries no end', () => {
    const v = filledValues()
    const fp = firstPickupIndex(v.stops)
    v.stops[fp] = { ...v.stops[fp], appt: '2026-11-16T07:00' }
    const stop = toStops(v)[fp]
    expect(stop.apptType).toBe('exact')
    expect(stop.apptEnd ?? null).toBeNull()
  })

  it('blocks a window that closes before it opens', () => {
    const { v } = fcfsValues('16:00', '07:00')
    const issues = validateForm(v, { ...base, level: 'create', customer: CUSTOMER })
    expect(issues.some((i) => /FCFS window must end after it opens/.test(i.message) && i.severity === 'error')).toBe(true)
  })

  it('lets a same-day delivery open before an FCFS pickup', () => {
    const { v } = fcfsValues('07:00', '16:00')
    const ld = lastDeliveryIndex(v.stops)
    v.stops[ld] = { ...v.stops[ld], appt: '2026-11-16T06:00', fcfs: true, apptEnd: '2026-11-16T15:00' }
    const issues = validateForm(v, { ...base, level: 'create', customer: CUSTOMER })
    expect(issues.some((i) => i.id.includes('order:'))).toBe(false)
  })

  it('shows the window wherever appointment times are formatted', () => {
    const appt = '2026-11-16T13:00:00.000Z'
    const end = '2026-11-16T22:00:00.000Z'
    expect(formatApptTime(appt, 'fcfs', end)).toBe('FCFS 07:00–16:00')
    expect(apptTimeLabel(appt, 'fcfs', end)).toBe('FCFS 07:00–16:00')
    expect(formatApptTime(appt, 'fcfs')).toBe('FCFS')
  })
})
