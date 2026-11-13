// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoadCarrierRecord, ShipmentBundle } from '@/types/tms'

const api = vi.hoisted(() => ({
  addCarrier: vi.fn(), updateLoadCarrierDetails: vi.fn(), setEta: vi.fn(), updateOrderDetails: vi.fn(), updateCarrierCharges: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('../newShipmentEffects', () => ({}))

import { CUSTOMER, filledValues, storedBundle } from './testFixtures'
import { financialPreview, toAddCarrierInput, toCharges, toSpecialRequirements } from './mapping'
import {
  PAID_TO_NONE, emptyCarrierSlot, emptyValues, syncCarrierSlots, upgradeValues, valuesFromBundle, type ShipmentFormValues,
} from './model'
import { runAddCarrier } from './pipelines'
import { deleteDraft, listDrafts, saveDraft } from './draftStore'
import { blockingIssues, validateForm } from './validation'

const lc = (id: string, sequence: number, over: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord =>
  ({ id, loadId: 'ld-1', status: 'ACTIVE', kind: 'CARRIER', sequence, carrierId: `car-${id}`, carrierName: `Carrier ${id}`, updatedAt: `u-${id}`, ...over }) as LoadCarrierRecord

/** Two booked carriers: A $600 linehaul, B $200 linehaul, a detention line paid to B. */
function twoCarrierValues(): ShipmentFormValues {
  const v = filledValues()
  v.rates.customer = { rateType: 'FLAT', hours: '', lhRate: '1000', lineId: '' }
  v.rates.fscPercent = ''
  v.rates.lines = [{ id: '', carrierLineId: '', release: '', paidTo: 'lc-b', code: 'DETENTION', label: '', carrierAmount: '50', customerAmount: '150', note: '' }]
  v.carrier = { ...v.carrier, loadCarrierId: 'lc-a', carrierId: 'car-lc-a' }
  v.rates.carrier = { ...v.rates.carrier, lhRate: '600' }
  const b = { ...emptyCarrierSlot('c1'), loadCarrierId: 'lc-b', carrierId: 'car-lc-b', carrierName: 'Carrier lc-b', rate: { rateType: 'FLAT' as const, hours: '', lhRate: '200', lineId: '', payPct: '', maxRate: '' } }
  return syncCarrierSlots(null, { ...v, carriers: [...v.carriers, b] })
}

function twoCarrierBundle(values: ShipmentFormValues): ShipmentBundle {
  const base = storedBundle(values)
  const charges = toCharges(values, { orderId: 'ord-1', loadId: 'ld-1', liveCarrierIds: ['lc-a', 'lc-b'] }).map((c, i) => ({
    ...c, id: c.id ?? `chg-${i}`, amountCents: c.rateCents * (c.count ?? 1), sortOrder: c.sortOrder ?? i, createdBy: 't', createdAt: '', updatedAt: '',
  }))
  return { ...base, loadCarriers: [lc('lc-b', 2), lc('lc-a', 1)], charges } as unknown as ShipmentBundle
}

describe('carrier slots <-> bundle', () => {
  it('round-trips two carriers: rates per slot, Paid to by loadCarrierId, nothing leaks onto the other carrier', () => {
    const values = twoCarrierValues()
    const bundle = twoCarrierBundle(values)
    const back = valuesFromBundle(bundle, { customer: CUSTOMER })
    expect(back.carriers.map((s) => [s.slot, s.loadCarrierId, s.rate.lhRate])).toEqual([['c0', 'lc-a', '600'], ['c1', 'lc-b', '200']])
    expect(back.rates.carrier).toBe(back.carriers[0].rate)
    expect(back.rates.lines.find((l) => l.code === 'DETENTION')).toMatchObject({ paidTo: 'lc-b', carrierAmount: '50', customerAmount: '150' })
    const sent = toCharges(back, { orderId: 'ord-1', loadId: 'ld-1', liveCarrierIds: ['lc-a', 'lc-b'] }).filter((c) => c.side === 'CARRIER')
    expect(sent.map((c) => [c.code, c.loadCarrierId, c.rateCents]).sort()).toEqual([['DETENTION', 'lc-b', 5000], ['LINEHAUL', 'lc-a', 60000], ['LINEHAUL', 'lc-b', 20000]])
  })

  it('"Not paid to a carrier" writes no carrier line, and a booking-order mismatch never moves a rate to another carrier', () => {
    const v = twoCarrierValues()
    v.rates.lines[0].paidTo = PAID_TO_NONE
    const lines = toCharges(v, { orderId: 'o', loadId: 'l', liveCarrierIds: ['lc-a', 'lc-b'] }).filter((c) => c.code === 'DETENTION')
    expect(lines.map((c) => c.side)).toEqual(['CUSTOMER'])
    // Slot c1 is not booked (only lc-a live): its rate is not sent under lc-a.
    const unbooked = twoCarrierValues()
    unbooked.carriers[1] = { ...unbooked.carriers[1], loadCarrierId: '' }
    const sent = toCharges(unbooked, { orderId: 'o', loadId: 'l', liveCarrierIds: ['lc-a'] }).filter((c) => c.code === 'LINEHAUL' && c.side === 'CARRIER')
    expect(sent.map((c) => c.loadCarrierId)).toEqual(['lc-a'])
  })

  it('a single carrier writes no carriers extras (legacy keys only)', () => {
    expect(toSpecialRequirements(filledValues()).form?.carriers).toBeUndefined()
    expect(toSpecialRequirements(twoCarrierValues()).form?.carriers?.map((c) => c.slot)).toEqual(['c0', 'c1'])
  })

  it('an unbooked extra slot keeps its rate draft through a save and reload', () => {
    const v = filledValues()
    v.carriers = [v.carriers[0], { ...emptyCarrierSlot('c1'), rate: { rateType: 'FLAT', hours: '', lhRate: '450', lineId: '', payPct: '', maxRate: '600' } }]
    const back = valuesFromBundle(storedBundle(v), { customer: CUSTOMER })
    expect(back.carriers).toHaveLength(2)
    expect(back.carriers[1]).toMatchObject({ slot: 'c1', loadCarrierId: '' })
    expect(back.carriers[1].rate).toMatchObject({ lhRate: '450', maxRate: '600' })
  })
})

describe('carrier slot sync and drafts', () => {
  it('an edit to carriers[0] reaches the legacy fields and the legacy fields reach carriers[0]', () => {
    const prev = emptyValues()
    const viaSlot = syncCarrierSlots(prev, { ...prev, carriers: [{ ...prev.carriers[0], seal: 'S-9', rate: { ...prev.carriers[0].rate, lhRate: '700' }, legStopIds: ['x'] }] })
    expect(viaSlot.carrier.seal).toBe('S-9')
    expect(viaSlot.rates.carrier.lhRate).toBe('700')
    expect(viaSlot.carriers[0].legStopIds).toEqual(['x'])
    const viaLegacy = syncCarrierSlots(prev, { ...prev, carrier: { ...prev.carrier, truckNo: '12' } })
    expect(viaLegacy.carriers[0].truckNo).toBe('12')
    expect(syncCarrierSlots(viaLegacy, viaLegacy)).toBe(viaLegacy)
  })

  beforeEach(() => { localStorage.clear() })
  it('a draft saved before carrier slots existed opens as a list of one, with nothing lost', () => {
    const old = filledValues() as Partial<ShipmentFormValues> & Record<string, unknown>
    old.carriers = undefined
    old.rates = { ...filledValues().rates, lines: filledValues().rates.lines.map(({ paidTo: _p, ...l }) => ({ ...l, carrierKey: 'Old Co' }) as never) }
    localStorage.setItem('tms:ship-form:draft:zz@example.invalid:old', JSON.stringify({ v: 1, savedAt: new Date().toISOString(), clientDraftId: 'old', values: old }))
    const [d] = listDrafts('zz@example.invalid')
    expect(d.values.carriers).toHaveLength(1)
    expect(d.values.carriers[0]).toMatchObject({ slot: 'c0', originCity: 'Gary', rate: { maxRate: '1500' } })
    expect(d.values.rates.lines.map((l) => l.paidTo)).toEqual(['', ''])
    expect(d.values.rates.lines[0]).not.toHaveProperty('carrierKey')
    expect(upgradeValues(d.values)).toEqual(d.values)
    saveDraft('zz@example.invalid', 'new', d.values)
    deleteDraft('zz@example.invalid', 'old')
    expect(listDrafts('zz@example.invalid')[0].values.carriers).toHaveLength(1)
  })
})

describe('money and validation across carriers', () => {
  it('rail totals sum every carrier and the margin comes from the summed gross', () => {
    const p = financialPreview(twoCarrierValues(), null, null)
    expect(p.carrierTotalLhCents).toBe(80000)
    expect(p.carrierTotalCents).toBe(85000)
    expect(p.customerTotalCents).toBe(100000 + 15000)
    expect(p.netCents).toBe(115000 - 85000)
    expect(p.carriers.map((c) => [c.slot, c.totalCents])).toEqual([['c0', 60000], ['c1', 25000]])
  })

  const opts = { level: 'submit' as const, mode: 'edit' as const, customer: null, settings: null }
  const errors = (v: ShipmentFormValues) => blockingIssues(validateForm(v, opts)).map((i) => i.id)

  it('mirrors the server: own fleet never mixes, a carrier needs a rate to submit, one carrier is unchanged', () => {
    const v = twoCarrierValues()
    expect(errors(v)).not.toContain('carrier:add:c1')
    v.carriers[1] = { ...v.carriers[1], isOwnFleet: true }
    expect(errors(v)).toContain('carrier:add:c1')
    const noRate = twoCarrierValues()
    noRate.carriers[1] = { ...noRate.carriers[1], rate: { ...noRate.carriers[1].rate, lhRate: '' } }
    expect(errors(noRate)).toContain('rates:carrierRate:c1')
    expect(validateForm(noRate, { ...opts, level: 'create' }).find((i) => i.id === 'rates:carrierRate:c1')?.severity).toBe('warn')
    const single = filledValues()
    single.carrier = { ...single.carrier, carrierId: 'car-1' }
    expect(validateForm(single, opts).some((i) => i.id.startsWith('rates:carrierRate'))).toBe(false)
  })

  it('legs: a removed stop blocks, an uncovered stop only warns', () => {
    const v = twoCarrierValues()
    v.carriers[0] = { ...v.carriers[0], legStopIds: [v.stops[0].id] }
    v.carriers[1] = { ...v.carriers[1], legStopIds: [v.stops[1].id] }
    const issues = validateForm(v, opts)
    expect(issues.find((i) => i.id === 'carrier:legs:uncovered:0')?.severity).toBe('warn')
    v.carriers[1] = { ...v.carriers[1], legStopIds: ['stp-gone'] }
    expect(errors(v)).toContain('carrier:legs:c1')
  })
})

describe('ADD_CARRIER from a slot', () => {
  beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()) })

  it('sends the slot directory carrier, rate, own charges and legs, then ties the booking back', async () => {
    const v = filledValues()
    v.carrier = { ...v.carrier, loadCarrierId: 'lc-a' }
    v.rates.lines = [{ id: '', carrierLineId: '', release: '', paidTo: 'c1', code: 'LUMPER', label: '', carrierAmount: '40', customerAmount: '', note: '' }]
    v.carriers = [
      v.carriers[0],
      { ...emptyCarrierSlot('c1'), carrierId: 'car-b', legStopIds: ['stp-c'], rate: { rateType: 'FLAT', hours: '', lhRate: '300', lineId: '', payPct: '', maxRate: '' } },
    ]
    const before = { ...storedBundle(v), loadCarriers: [lc('lc-a', 1)] } as unknown as ShipmentBundle
    const input = toAddCarrierInput(v, 'c1', before)
    expect(input).toMatchObject({ loadId: 'ld-1', carrierId: 'car-b', carrierRateCents: 30000, legStopIds: ['stp-c'] })
    expect(input.charges?.map((c) => [c.code, c.rateCents])).toEqual([['LUMPER', 4000]])
    // ADD_CARRIER writes the slot's own charges, so the follow-up does not write them again.
    const after = {
      ...before,
      loadCarriers: [lc('lc-a', 1), lc('lc-b', 2, { carrierId: 'car-b' })],
      charges: [...before.charges, { id: 'ch-l', side: 'CARRIER', loadId: 'ld-1', loadCarrierId: 'lc-b', code: 'LUMPER', calculatedBy: 'FLAT', rateCents: 4000, count: 1, amountCents: 4000, isRate: false, sortOrder: 10 }],
    } as unknown as ShipmentBundle
    api.addCarrier.mockResolvedValue(after)
    api.updateOrderDetails.mockResolvedValue(after)
    const res = await runAddCarrier(v, before, 'c1')
    expect(res.ok).toBe(true)
    expect(api.addCarrier).toHaveBeenCalledTimes(1)
    expect(api.updateCarrierCharges).not.toHaveBeenCalled()
    const sr = api.updateOrderDetails.mock.calls[0][0].order.specialRequirements
    expect(sr.form.carriers.find((c: { slot: string }) => c.slot === 'c1')).toMatchObject({ loadCarrierId: 'lc-b' })
  })

  it('refuses before any call when the slot has no directory carrier', async () => {
    const v = filledValues()
    v.carriers = [v.carriers[0], emptyCarrierSlot('c1')]
    const res = await runAddCarrier(v, storedBundle(v), 'c1')
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/Pick the carrier/)
    expect(api.addCarrier).not.toHaveBeenCalled()
  })
})
