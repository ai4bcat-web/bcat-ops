import { describe, it, expect } from 'vitest'
import { dwellAlerts, markDwellAlerted } from './dwellAlerts'
import type { Load } from '../../../src/types'

const NOW = Date.parse('2026-10-15T20:00:00Z')
const mk = (stops: Array<Record<string, unknown>>, pro = '14617') => ({ id: 'l1', aljexId: pro, stops }) as unknown as Load
const onSite = (type: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
  ({ id: `${type}-1`, type, sequence: type === 'pickup' ? 0 : 1, driverId: 'd1', name: 'EAGLE FOODS', city: 'WAUKEGAN', arrivedAt: new Date(NOW - minutesAgo * 60_000).toISOString(), ...extra })

describe('dwellAlerts', () => {
  it('flags a pickup not departed and a delivery not delivered after two hours, in the words dispatch uses', () => {
    const a = dwellAlerts([mk([onSite('pickup', 125)]), mk([onSite('delivery', 180)], '14696')], NOW)
    expect(a).toHaveLength(2)
    expect(a[0].text).toMatch(/^⏱ On site at pickup 2\.1 h and not departed · EAGLE FOODS, WAUKEGAN · PRO 14617/)
    expect(a[1].text).toMatch(/^⏱ On site at delivery 3 h and not marked delivered .* PRO 14696 .*POD/)
    expect(a[0].driverId).toBe('d1')
  })
  it('leaves alone a stop under two hours, one already departed, one with no driver, and one already flagged', () => {
    expect(dwellAlerts([mk([onSite('pickup', 119)])], NOW)).toEqual([])
    expect(dwellAlerts([mk([onSite('pickup', 300, { departedAt: '2026-10-15T19:00:00Z' })])], NOW)).toEqual([])
    expect(dwellAlerts([mk([onSite('pickup', 300, { driverId: null })])], NOW)).toEqual([])
    expect(dwellAlerts([mk([onSite('pickup', 300, { dwellAlertedAt: '2026-10-15T18:00:00Z' })])], NOW)).toEqual([])
  })
  it('marks the stop so the next sweep skips it', () => {
    const load = mk([onSite('pickup', 300)])
    const stops = markDwellAlerted(load, 'pickup-1', '2026-10-15T20:00:00Z')
    expect(dwellAlerts([{ ...load, stops } as Load], NOW)).toEqual([])
  })
})
