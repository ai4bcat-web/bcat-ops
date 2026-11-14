import { describe, expect, it } from 'vitest'
import { emptyValues } from './model'
import { proPreview, railSummary, requiredProgress, requiredRows } from './railModel'
import { CUSTOMER, filledValues } from './testFixtures'
import { blockingIssues, validateForm } from './validation'

const gate = (v: Parameters<typeof validateForm>[0]) =>
  blockingIssues(validateForm(v, { level: 'create', mode: 'create', customer: CUSTOMER, settings: null })).length

describe('requiredRows', () => {
  it('lists the seven Aljex reds plus Shipment type, the customer ref and one Ready to factor row on an empty form; only the defaulted type is done', () => {
    const rows = requiredRows(emptyValues(), 'create')
    expect(rows.map((r) => r.key)).toEqual(['customer', 'shipmentType', 'pickup', 'ready', 'equipment', 'weight', 'description', 'division', 'customer:ref:po', 'factorReady'])
    expect(rows.filter((r) => r.done).map((r) => r.key)).toEqual(['shipmentType'])
    expect(requiredProgress(rows)).toEqual({ done: 1, total: 10, ready: false })
    expect(rows.find((r) => r.key === 'factorReady')).toMatchObject({ label: 'Ready to factor (7 missing)', card: 'rates' })
    expect(rows.find((r) => r.key === 'customer')?.card).toBe('header')
  })

  it('a cleared shipment type is an undone row that points at the Freight card select', () => {
    const v = emptyValues(); v.shipmentType = ''
    const row = requiredRows(v, 'create').find((r) => r.key === 'shipmentType')
    expect(row).toMatchObject({ done: false, fieldKey: 'f-shipping-shipmentType', card: 'freight' })
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

  it('a blank carrier origin adds no required row', () => {
    const v = filledValues()
    v.carrier.originCity = ''
    v.carrier.originState = ''
    v.carrier.carrierId = 'car-1'
    const rows = requiredRows(v, 'create', { customer: CUSTOMER })
    expect(gate(v)).toBe(0)
    expect(rows.filter((r) => !r.done)).toHaveLength(0)
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
    expect(proPreview({ shipmentPrefix: 'S', nextShipmentNumber: 14913 } as never)).toBe('S014914')
    // Production: the numeric scheme shows the plain next number (the counter holds the last one issued).
    expect(proPreview({ proScheme: 'NUMERIC', nextShipmentNumber: 20000 } as never)).toBe('20001')
  })
})
