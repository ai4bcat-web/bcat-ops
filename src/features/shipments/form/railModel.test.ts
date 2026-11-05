import { describe, expect, it } from 'vitest'
import { emptyValues } from './model'
import { proPreview, railSummary, requiredProgress, requiredRows } from './railModel'
import { CUSTOMER, filledValues } from './testFixtures'
import { blockingIssues, validateForm } from './validation'

const gate = (v: Parameters<typeof validateForm>[0]) =>
  blockingIssues(validateForm(v, { level: 'create', mode: 'create', customer: CUSTOMER, settings: null })).length

describe('requiredRows', () => {
  it('lists the seven Aljex reds on an empty form, none done', () => {
    const rows = requiredRows(emptyValues(), 'create')
    expect(rows.map((r) => r.key)).toEqual(['customer', 'pickup', 'ready', 'equipment', 'weight', 'description', 'revenue'])
    expect(requiredProgress(rows)).toEqual({ done: 0, total: 7, ready: false })
  })

  it('agrees with the Create gate: all rows done exactly when nothing blocks', () => {
    const ok = filledValues()
    expect(gate(ok)).toBe(0)
    expect(requiredProgress(requiredRows(ok, 'create', { customer: CUSTOMER })).ready).toBe(true)

    const noWeight = filledValues()
    noWeight.ship.weightLbs = ''
    expect(gate(noWeight)).toBeGreaterThan(0)
    const rows = requiredRows(noWeight, 'create', { customer: CUSTOMER })
    expect(rows.find((r) => r.key === 'weight')).toMatchObject({ done: false })
    expect(requiredProgress(rows).ready).toBe(false)
  })

  it('a blocking issue with no fixed row (carrier origin) joins as an extra undone row', () => {
    const v = filledValues()
    v.carrier.originCity = ''
    v.carrier.originState = ''
    v.carrier.carrierId = 'car-1'
    const rows = requiredRows(v, 'create', { customer: CUSTOMER })
    expect(gate(v)).toBe(2)
    expect(rows.filter((r) => !r.done)).toHaveLength(2)
    expect(rows.filter((r) => !r.done).every((r) => r.card === 'carrier')).toBe(true)
  })

  it('does not require equipment on LTL', () => {
    const v = filledValues()
    v.mode = 'LTL'
    v.ship.equipmentType = ''
    expect(requiredRows(v, 'create', { customer: CUSTOMER }).some((r) => r.key === 'equipment')).toBe(false)
  })
})

describe('railSummary / proPreview', () => {
  it('builds the lane and freight lines from the form', () => {
    const v = filledValues()
    v.stops[0].city = 'Chicago'; v.stops[0].state = 'il'
    v.stops[v.stops.length - 1].city = 'Dallas'; v.stops[v.stops.length - 1].state = 'TX'
    v.ship.customerMiles = '912'; v.ship.weightLbs = '42000'; v.ship.equipmentType = 'Dry van'; v.ship.description = 'Food'
    const s = railSummary(v, null, null)
    expect(s.laneLine).toBe('Chicago, IL → Dallas, TX · 912 mi')
    expect(s.freightLine).toBe('Dry van · 42,000 lb · Food')
  })

  it('previews the next PRO from the counter, blank until settings load', () => {
    expect(proPreview(null)).toBe('')
    expect(proPreview({ shipmentPrefix: 'S', nextShipmentNumber: 14913 } as never)).toBe('S014913')
  })
})
