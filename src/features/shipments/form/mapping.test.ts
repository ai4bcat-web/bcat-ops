import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/apiClient', () => ({}))
vi.mock('../newShipmentEffects', () => ({}))
import { CUSTOMER, filledValues, storedBundle } from './testFixtures'
import {
  calculateTotalsFromPicks, financialPreview, rebaseCharges, toBookCarrierDraft, toCharges, toCreateInput,
  toSaveOrderFormInput, toSpecialRequirements, toStops, toUpdateOrderDetailsInput,
} from './mapping'
import { emptyValues, lockedFields, readExtras, valuesFromBundle, withExtras, type ShipmentFormValues } from './model'
import { diffStopOps } from './pipelines'
import { applyShipmentType } from './shipmentType'
import type { ShipmentBundle } from '@/types/tms'
import { rateConLinesFor } from '@/lib/carrierBill'
import { invoiceLinesFor } from '@/lib/invoiceBuild'

const strip = (v: ShipmentFormValues) => ({
  ...v,
  ship: { ...v.ship, officeLabel: '' },
  rates: { ...v.rates, customer: { ...v.rates.customer, lineId: '' }, fscLineId: '', lines: v.rates.lines.map((l) => ({ ...l, id: '' })) },
  checkCall: undefined,
  docs: undefined,
})

describe('form → payload → form', () => {
  it('round-trips a fully filled create (every Aljex section)', () => {
    const values = filledValues()
    const back = valuesFromBundle(storedBundle({ ...values, ship: { ...values.ship, flags: { ...values.ship.flags } } }), { customer: CUSTOMER })
    expect(strip(back)).toEqual(strip(values))
  })

  it('round-trips an edit: change a field, save, read back only that change', () => {
    const values = filledValues()
    const first = valuesFromBundle(storedBundle(values), { customer: CUSTOMER })
    const edited: ShipmentFormValues = {
      ...first,
      ship: { ...first.ship, description: 'Frozen goods', flags: { ...first.ship.flags, hot: false }, temp: { ...first.ship.temp, unit: 'F', min: '34', max: '36' } },
    }
    const second = valuesFromBundle(storedBundle(edited), { customer: CUSTOMER })
    expect(strip(second)).toEqual(strip(edited))
    expect(second.ship.flags.hot).toBe(false)
  })

  it('round-trips the chosen shipment type through specialRequirements.form and keeps the stored mode in step', () => {
    const values = applyShipmentType(filledValues(), 'AIR')
    expect(toSpecialRequirements(values).form?.shipmentType).toBe('AIR')
    expect(values.mode).toBe('AIR')
    const back = valuesFromBundle(storedBundle(values), { customer: CUSTOMER })
    expect(back).toMatchObject({ shipmentType: 'AIR', mode: 'AIR' })
  })

  it('keeps the account state of a typed-name customer', () => {
    const v = emptyValues()
    v.customer = { ...v.customer, useTyped: true, typedName: 'Typed Co' }
    const input = toCreateInput(v)
    expect(input.customerName).toBe('Typed Co')
    expect(input.customerId).toBeUndefined()
  })
})

describe('CREATE_SHIPMENT input', () => {
  it('carries only the whitelisted bag, stops with client ids, and no rateCents', () => {
    const input = toCreateInput(filledValues())
    expect(input.customerId).toBe('cus-1')
    expect(input.source).toBe('MANUAL')
    expect(input.load).not.toHaveProperty('rateCents')
    expect(input.load?.stops?.map((s) => s.id)).toEqual(['stp-a', 'stp-b', 'stp-c'])
    expect(input.load).toMatchObject({ tmsId: 'PO-77', pickupNumber: 'PU-1', equipmentType: 'Dry Van', commodity: 'Canned goods', weight: 42000, pieces: 24, piecesUnit: 'pieces', cargoValueCents: 2500050, miles: 640, hot: true })
  })
})

describe('stops', () => {
  it('Ready only → appt = ready, tbd; Appt present → exact + requestedStart; Must Deliver → requestedEnd', () => {
    const [first, second, last] = toStops(filledValues())
    expect(first).toMatchObject({ apptType: 'exact', city: 'Chicago, IL' })
    expect(first.requestedStart).toBeDefined()
    expect(first.requestedStart).not.toBe(first.appt)
    expect(second.apptType).toBe('tbd')
    expect(second.appt).toBe(second.requestedStart)
    expect(last.requestedEnd).toBeDefined()
    expect(last.instructions).toBe('Dock 9')
  })
  it('a pickup saved with no Ready is ready at its appointment; a delivery gets no Ready', () => {
    const v = filledValues()
    v.stops[0].ready = ''
    const stops = toStops(v)
    expect(stops[0].requestedStart).toBe(stops[0].appt)
    expect(stops[stops.length - 1].requestedStart).toBeUndefined()
  })
  it('a second pick keeps its ref on the stop, the first pickup on the order', () => {
    const v = filledValues()
    const stops = toStops(v)
    expect(stops[0].refs).toBeUndefined()
    expect(stops[1].refs?.[0]).toMatchObject({ code: 'PICKUP', value: 'PU-2' })
    const save = toSaveOrderFormInput(v, storedBundle(v), { draftSave: true })
    expect(save.order.references?.map((r) => r.code)).toEqual(['PO', 'pickup', 'delivery', 'BOL'])
  })
  it('Calculate Totals from Picks sums only pickup numbers', () => {
    const v = filledValues()
    v.stops[1].pieces = '6'; v.stops[1].weightLbs = '1000'
    v.stops[2].weightLbs = '99999'
    expect(calculateTotalsFromPicks(v.stops)).toEqual({ pieces: 30, weightLbs: 43000, picks: 2 })
    expect(calculateTotalsFromPicks(emptyValues().stops).picks).toBe(0)
  })
  it('diffs stop edits by id into the minimal ops', () => {
    const before = filledValues()
    const after = filledValues()
    after.stops[2].note = 'Dock 12'
    after.stops = [...after.stops.slice(0, 2).reverse(), after.stops[2]]
    const ops = diffStopOps(before, after)
    // swapping the picks also swaps which one the order-level Pick Up # belongs to
    expect(ops.map((o) => o.op).sort()).toEqual(['SET_DETAILS', 'SET_REFS', 'SET_REFS', 'SWAP'])
    expect(diffStopOps(before, before)).toEqual([])
  })
})

describe('special requirements', () => {
  it('converts °C to °F for tempF while the extras keep what was typed', () => {
    const sr = toSpecialRequirements(filledValues())
    expect(sr.tempF).toEqual({ target: 36, min: 34, max: 37 })
    expect(sr.form?.ship?.temp).toEqual({ unit: 'C', min: 1, max: 3, preCool: 0 })
  })
  it('preserves an imported customs-bond text while ticked, writes Y otherwise, clears when unticked', () => {
    const v = filledValues()
    expect(toSpecialRequirements(v, { customsBond: 'BOND-9' }).customsBond).toBe('BOND-9')
    expect(toSpecialRequirements(v).customsBond).toBe('Y')
    v.ship.flags.customsBonded = false
    expect(toSpecialRequirements(v, { customsBond: 'BOND-9' }).customsBond).toBeNull()
  })
  it('never mentions keys it does not own (other survives the patch merge)', () => {
    expect(Object.keys(toSpecialRequirements(filledValues()))).not.toContain('other')
  })
  it('extras accessor patches one group without touching the rest', () => {
    const sr = withExtras({ fsma: true, form: { v: 1, ship: { footage: 4 }, roles: { tariff: 'T' } } }, { ship: { truckMiles: 9, footage: undefined } })
    expect(sr.fsma).toBe(true)
    expect(readExtras({ specialRequirements: sr })).toEqual({ v: 1, ship: { truckMiles: 9 }, roles: { tariff: 'T' } })
  })
})

describe('accessorial row with both amounts', () => {
  it('writes one CARRIER and one CUSTOMER charge; carrier lands on the rate con, customer on the invoice', () => {
    const v = emptyValues()
    v.rates.lines = [{ id: '', carrierLineId: '', release: '', paidTo: '', code: 'LUMPER', label: 'Lumper', carrierAmount: '40', customerAmount: '65', note: '' }]
    const out = toCharges(v, { orderId: 'o1', loadId: 'l1', activeLoadCarrierId: 'lc-1' }).filter((l) => l.code === 'LUMPER')
    expect(out.map((l) => [l.side, l.rateCents])).toEqual([['CUSTOMER', 6500], ['CARRIER', 4000]])
    const stored = out.map((c, i) => ({ ...c, id: `c${i}`, amountCents: c.rateCents }))
    const rc = rateConLinesFor(stored as never, { id: 'lc-1' }, 1, true)
    expect(rc.lines.map((l) => [l.code, l.amountCents])).toEqual([['LUMPER', 4000]])
    expect(rc.grossCents).toBe(4000)
    const inv = invoiceLinesFor(stored as never, 'o1')
    expect(inv.lines.map((l) => [l.code, l.amountCents])).toEqual([['LUMPER', 6500]])
    expect(inv.subtotalCents).toBe(6500)
  })
  it('one-sided rows write only that side', () => {
    const v = emptyValues()
    v.rates.lines = [{ id: '', carrierLineId: '', release: '', paidTo: '', code: 'TONU', label: '', carrierAmount: '', customerAmount: '25', note: '' }]
    expect(toCharges(v, { orderId: 'o', loadId: 'l', activeLoadCarrierId: 'lc-1' }).map((l) => l.side)).toEqual(['CUSTOMER'])
  })
})

describe('rates', () => {
  it('Per Hour is FLAT with count = hours; FSC % is basis points; accessorials share a release', () => {
    const lines = toCharges(filledValues(), { orderId: 'o', loadId: 'l' })
    const lh = lines.find((l) => l.code === 'LINEHAUL')!
    expect(lh).toMatchObject({ calculatedBy: 'FLAT', rateCents: 7500, count: 8, side: 'CUSTOMER' })
    expect(lines.find((l) => l.code === 'FSC')).toMatchObject({ calculatedBy: 'PERCENT', rateCents: 1250 })
    expect(lines.filter((l) => l.release).map((l) => [l.code, l.release])).toEqual([['LUMPER', 'R1'], ['DETENTION', 'R2']])
  })
  it('FSC/Mile wins over FSC %', () => {
    const v = filledValues(); v.rates.fscPerMile = '0.5'
    expect(toCharges(v, { orderId: 'o', loadId: 'l' }).find((l) => l.code === 'FSC')).toMatchObject({ calculatedBy: 'PER_MILE', rateCents: 50 })
  })
  it('never writes a carrier line before Cover, and writes both sides of a row after', () => {
    const v = filledValues()
    v.rates.carrier.lhRate = '1200'
    v.rates.lines[0].carrierAmount = '100'
    expect(toCharges(v, { orderId: 'o', loadId: 'l' }).some((l) => l.side === 'CARRIER')).toBe(false)
    const after = toCharges(v, { orderId: 'o', loadId: 'l', activeLoadCarrierId: 'lc-1' })
    expect(after.filter((l) => l.side === 'CARRIER').map((l) => l.code).sort()).toEqual(['LINEHAUL', 'LUMPER'])
    expect(after.filter((l) => l.side === 'CARRIER').every((l) => l.loadCarrierId === 'lc-1')).toBe(true)
    const draft = toBookCarrierDraft(v)
    expect(draft.carrierRateCents).toBe(120000)
    expect(draft.charges?.[0]).toMatchObject({ code: 'LUMPER', rateCents: 10000, side: 'CARRIER' })
  })
  it('% of Customer is flattened to the total', () => {
    const v = filledValues()
    v.rates.carrier = { ...v.rates.carrier, rateType: 'PCT_OF_CUSTOMER', payPct: '80' }
    expect(toBookCarrierDraft(v).carrierRateCents).toBe(Math.round(60000 * 0.8))
  })
  it('preview prices through computeFinancials and excludes SMR', () => {
    const v = filledValues(); v.rates.carrier.lhRate = '400'
    const p = financialPreview(v, CUSTOMER, null)
    expect(p.customerTotalLhCents).toBe(60000)
    expect(p.customerTotalCents).toBe(60000 + 7500 + 15000 + 9025)
    expect(p.carrierTotalCents).toBe(40000)
    expect(p.netCents).toBe(p.customerTotalCents - 40000)
  })
  it('passthrough rows are re-sent verbatim and survive a read of the bundle', () => {
    const v = filledValues()
    const bundle = storedBundle(v)
    bundle.charges.push({ id: 'qp', shipmentId: 'shp-1', side: 'CUSTOMER', code: 'QUICKPAY_FEE', calculatedBy: 'PERCENT', rateCents: 200, amountCents: 5, isRate: false, sortOrder: 99, createdBy: '', createdAt: '', updatedAt: '' })
    const read = valuesFromBundle(bundle)
    expect(read.rates.passthrough.map((p) => p.id)).toEqual(['qp'])
    const out = toCharges(read, { orderId: 'ord-1', loadId: 'ld-1' })
    expect(out.find((c) => c.id === 'qp')).toMatchObject({ code: 'QUICKPAY_FEE', calculatedBy: 'PERCENT', rateCents: 200 })
  })
  it('after CREATE the seeded default charge is adopted, not duplicated', () => {
    const v = filledValues()
    v.rates.lines = [{ id: '', carrierLineId: '', release: '', paidTo: '', code: 'FUEL_ADJ', label: '', carrierAmount: '', customerAmount: '25', note: '' }]
    const bundle = storedBundle(v)
    bundle.charges = [{ id: 'srv-1', shipmentId: 'shp-1', side: 'CUSTOMER', code: 'FUEL_ADJ', calculatedBy: 'FLAT', rateCents: 2500, count: 1, amountCents: 2500, isRate: false, sortOrder: 5, createdBy: '', createdAt: '', updatedAt: '' }]
    const rebased = rebaseCharges(v, bundle)
    expect(rebased.rates.lines).toHaveLength(1)
    expect(rebased.rates.lines[0].id).toBe('srv-1')
  })
})

describe('SAVE_ORDER_FORM / UPDATE_ORDER_DETAILS inputs', () => {
  it('pins frt-main first, from the top fields, with the Built-gate numbers', () => {
    const v = filledValues()
    const save = toSaveOrderFormInput(v, storedBundle(v), { draftSave: true })
    expect(save.draftSave).toBe(true)
    expect(save.order.freight?.[0]).toMatchObject({ id: 'frt-main', description: 'Canned goods', weightLbs: 42000, qty: 24, freightClass: '70' })
    expect(save.order.freight?.[1]?.id).toBe('frt-2')
    expect(save.order).toMatchObject({ customerNotes: 'y'.repeat(260), internalNotes: 'Internal', billToId: 'bt-1', customerContactId: 'ct-1' })
    expect(save.shipmentFlags).toEqual({ osd: true })
    expect(save.loadFields).toMatchObject({ pieces: 24, piecesUnit: 'pieces', hot: true, weight: 42000 })
  })
  it('a strict save omits draftSave', () => {
    const v = filledValues()
    expect(toSaveOrderFormInput(v, storedBundle(v), { draftSave: false })).not.toHaveProperty('draftSave')
  })
  it('the edit payload never carries mode, stops or charges, and drops invoice-owned keys', () => {
    const v = filledValues()
    const bundle = storedBundle(v, { status: 'OPEN' }) as ShipmentBundle
    const input = toUpdateOrderDetailsInput(v, bundle)
    expect(input.order).not.toHaveProperty('mode')
    expect(input).not.toHaveProperty('stops')
    expect(input).not.toHaveProperty('charges')
    ;(bundle.orders[0] as { invoiceId?: string }).invoiceId = 'inv-1'
    const invoiced = toUpdateOrderDetailsInput(v, bundle)
    expect(invoiced.order).not.toHaveProperty('references')
    expect(invoiced.order).toHaveProperty('internalNotes')
  })
})

describe('locks', () => {
  it('a non-draft shipment locks mode and customer; a voided one locks everything', () => {
    const open = lockedFields(storedBundle(filledValues(), { status: 'OPEN' }))
    expect(open.fields.mode).toBeTruthy()
    expect(open.fields.customer).toBeTruthy()
    expect(open.fields.rates).toBeUndefined()
    const bundle = storedBundle(filledValues())
    ;(bundle.shipment as { voidedAt?: string }).voidedAt = 'x'
    expect(lockedFields(bundle).fields.all).toBeTruthy()
  })
})
