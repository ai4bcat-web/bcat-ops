import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShipmentBundle } from '@/types/tms'
import { CUSTOMER, filledValues, storedBundle } from './testFixtures'
import { emptyValues, valuesFromBundle } from './model'

const api = vi.hoisted(() => ({
  createShipment: vi.fn(), saveOrderForm: vi.fn(), getShipmentBundle: vi.fn(), setRevTag: vi.fn(), clearRevTag: vi.fn(),
  setSalesRep: vi.fn(), assignCarrierRep: vi.fn(), submitOrder: vi.fn(), updateOrderDetails: vi.fn(), updateStop: vi.fn(),
  updateStopDetails: vi.fn(), recalcCharges: vi.fn(), updateLoadCarrierDetails: vi.fn(), setEta: vi.fn(),
  prepareDocumentUpload: vi.fn(), commitDocument: vi.fn(), putPresignedFile: vi.fn(), createLocation: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('../newShipmentEffects', () => ({
  applyNewShipmentEffects: vi.fn(async () => undefined),
  linkStopsToDirectory: vi.fn(async (stops: unknown[]) => stops),
}))

import { runCover, runCreate, runEditSave, runSaveDraft, runSubmit } from './pipelines'

const ctx = { customer: CUSTOMER, locations: [], settings: null, actorName: 'zz', isBatory: false }
const at = (b: ShipmentBundle, updatedAt: string, patch: object = {}): ShipmentBundle =>
  ({ ...b, shipment: { ...b.shipment, ...patch, updatedAt } }) as ShipmentBundle

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()) })

function wireCreate(values = filledValues()) {
  const saved = storedBundle(values)
  api.createShipment.mockImplementation(async () => at(storedBundle(values), 'u1', { revDivision: null, salesRepId: null }))
  api.saveOrderForm.mockImplementation(async () => at(saved, 'u2', { revDivision: null, salesRepId: null }))
  api.setRevTag.mockImplementation(async () => at(saved, 'u3', { salesRepId: null }))
  api.setSalesRep.mockImplementation(async () => at(saved, 'u4'))
  return saved
}

describe('create pipeline', () => {
  it('CREATE → SAVE_ORDER_FORM → tag → rep, each on the previous response, no money on create', async () => {
    wireCreate()
    const res = await runCreate(filledValues(), ctx, { draftSave: false })
    expect(res.ok).toBe(true)
    expect(res.createdShipmentId).toBe('shp-1')
    expect(res.steps.map((s) => s.step)).toEqual(['create', 'save', 'revTag', 'salesRep', 'dispatcher', 'effects'])
    expect(api.createShipment.mock.calls[0][0].load).not.toHaveProperty('rateCents')
    expect(api.saveOrderForm.mock.calls[0][0]).toMatchObject({ expectedUpdatedAt: 'u1', shipmentId: 'shp-1' })
    expect(api.saveOrderForm.mock.calls[0][0]).not.toHaveProperty('draftSave')
    expect(api.setRevTag.mock.calls[0][0]).toMatchObject({ divisionCode: 'BCAT', subdivisionCode: 'FOOD' })
    expect(api.setSalesRep.mock.calls[0][0]).toMatchObject({ repId: 'rep-1' })
    expect(api.assignCarrierRep).not.toHaveBeenCalled()
  })

  it('Save draft sends draftSave and survives with only a typed customer', async () => {
    const v = emptyValues(); v.customer.useTyped = true; v.customer.typedName = 'Typed'
    api.createShipment.mockImplementation(async () => at(storedBundle(v), 'u1'))
    api.saveOrderForm.mockImplementation(async () => at(storedBundle(v), 'u2'))
    const res = await runCreate(v, { ...ctx, customer: null }, { draftSave: true })
    expect(res.ok).toBe(true)
    expect(api.saveOrderForm.mock.calls[0][0].draftSave).toBe(true)
    expect(api.setRevTag).not.toHaveBeenCalled()
  })

  it('a failing client validation calls nothing', async () => {
    const res = await runCreate(emptyValues(), ctx, { draftSave: false })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/required fields missing/)
    expect(api.createShipment).not.toHaveBeenCalled()
  })

  it('a failure after CREATE never calls it again on Retry', async () => {
    const saved = wireCreate()
    api.saveOrderForm.mockRejectedValueOnce(new Error('This shipment changed'))
    const first = await runCreate(filledValues(), ctx, { draftSave: false })
    expect(first.ok).toBe(false)
    expect(first.createdShipmentId).toBe('shp-1')
    expect(first.message).toBe('This shipment changed')
    expect(first.failedSteps).toEqual(expect.arrayContaining(['save', 'revTag', 'salesRep']))
    expect(first.failedSteps).not.toContain('create')

    api.getShipmentBundle.mockResolvedValue(at(saved, 'u9', { revDivision: null, salesRepId: null }))
    const done = first.steps.filter((s) => s.ok).map((s) => s.step)
    const retry = await runCreate(filledValues(), ctx, { draftSave: false, resume: { shipmentId: first.createdShipmentId!, done } })
    expect(retry.ok).toBe(true)
    expect(api.createShipment).toHaveBeenCalledTimes(1)
    expect(api.saveOrderForm.mock.calls[1][0].expectedUpdatedAt).toBe('u9')
  })

  it('the tag step is skipped when the server already holds the value', async () => {
    const v = filledValues()
    const saved = storedBundle(v)
    api.createShipment.mockImplementation(async () => at(saved, 'u1'))
    api.saveOrderForm.mockImplementation(async () => at(saved, 'u2'))
    const res = await runCreate(v, ctx, { draftSave: false })
    expect(res.ok).toBe(true)
    expect(api.setRevTag).not.toHaveBeenCalled()
    expect(api.setSalesRep).not.toHaveBeenCalled()
  })

  it('sends no carrier charge before Cover even when carrier money is typed', async () => {
    const v = filledValues(); v.rates.carrier.lhRate = '900'; v.rates.lines[0].carrierAmount = '50'
    wireCreate(v)
    await runCreate(v, ctx, { draftSave: false })
    const charges = api.saveOrderForm.mock.calls[0][0].charges as { side: string }[]
    expect(charges.some((c) => c.side === 'CARRIER')).toBe(false)
  })

  it('uploads queued documents only after the save, one result per file', async () => {
    const v = filledValues()
    v.docs.queued = [{ file: new File(['x'], 'a.txt', { type: 'text/plain' }), audience: 'INTERNAL', type: 'OTHER' }]
    wireCreate(v)
    api.prepareDocumentUpload.mockResolvedValue({ uploadUrl: 'u', s3Key: 'k', documentId: 'd' })
    api.putPresignedFile.mockResolvedValue(undefined)
    api.commitDocument.mockResolvedValue({})
    const res = await runCreate(v, ctx, { draftSave: false })
    expect(res.ok).toBe(true)
    expect(api.commitDocument.mock.calls[0][0]).toMatchObject({ audience: 'INTERNAL', shipmentId: 'shp-1' })
    expect(api.saveOrderForm.mock.invocationCallOrder[0]).toBeLessThan(api.prepareDocumentUpload.mock.invocationCallOrder[0])
  })
})

describe('edit pipelines', () => {
  it('Save draft on an existing DRAFT is a lenient SAVE_ORDER_FORM', async () => {
    const v = filledValues(); const b = storedBundle(v)
    api.saveOrderForm.mockResolvedValue(b)
    const res = await runSaveDraft(v, ctx, b)
    expect(res.ok).toBe(true)
    expect(api.saveOrderForm.mock.calls[0][0].draftSave).toBe(true)
    expect(api.createShipment).not.toHaveBeenCalled()
  })

  it('a non-DRAFT edit never calls SAVE_ORDER_FORM and skips every empty diff', async () => {
    const b = storedBundle(filledValues(), { status: 'OPEN' })
    const unchanged = valuesFromBundle(b, { customer: CUSTOMER })
    const res = await runEditSave(unchanged, ctx, b)
    expect(res.ok).toBe(true)
    for (const f of Object.values(api)) expect(f).not.toHaveBeenCalled()
  })

  it('edits compose UPDATE_ORDER_DETAILS then stop ops then RECALC_CHARGES', async () => {
    const b = storedBundle(filledValues(), { status: 'OPEN' })
    const edited = valuesFromBundle(b, { customer: CUSTOMER })
    edited.ship.description = 'Changed'
    edited.stops[2].note = 'New dock'
    edited.rates.customer.lhRate = '80'
    api.updateOrderDetails.mockResolvedValue(at(b, 'u5'))
    api.updateStopDetails.mockResolvedValue(at(b, 'u6'))
    api.recalcCharges.mockResolvedValue(at(b, 'u7'))
    const res = await runEditSave(edited, ctx, b)
    expect(res.ok).toBe(true)
    expect(api.saveOrderForm).not.toHaveBeenCalled()
    expect(api.updateOrderDetails.mock.calls[0][0].loadFields.commodity).toBe('Changed')
    expect(api.updateStopDetails.mock.calls[0][0]).toMatchObject({ stopId: 'stp-c', patch: { instructions: 'New dock' } })
    expect(api.recalcCharges.mock.calls[0][0].expectedVersion).toBe(3)
    expect(api.updateOrderDetails.mock.invocationCallOrder[0]).toBeLessThan(api.updateStopDetails.mock.invocationCallOrder[0])
    expect(api.updateStopDetails.mock.invocationCallOrder[0]).toBeLessThan(api.recalcCharges.mock.invocationCallOrder[0])
  })

  it('a frozen shipment never re-sends charges', async () => {
    const b = storedBundle(filledValues(), { status: 'OPEN' })
    ;(b as { financials: unknown[] }).financials = [{ loadId: 'ld-1', frozenAt: 'x' }]
    const edited = valuesFromBundle(b, { customer: CUSTOMER })
    edited.rates.customer.lhRate = '99'
    await runEditSave(edited, ctx, b)
    expect(api.recalcCharges).not.toHaveBeenCalled()
  })

  it('a stop op failure keeps the earlier step and names the stopped ones', async () => {
    const b = storedBundle(filledValues(), { status: 'OPEN' })
    const edited = valuesFromBundle(b, { customer: CUSTOMER })
    edited.ship.description = 'Changed'; edited.stops[2].note = 'x'; edited.rates.customer.lhRate = '81'
    api.updateOrderDetails.mockResolvedValue(at(b, 'u5'))
    api.updateStopDetails.mockRejectedValue(new Error('The truck has been here'))
    const res = await runEditSave(edited, ctx, b)
    expect(res.ok).toBe(false)
    expect(res.message).toBe('The truck has been here')
    expect(res.failedSteps[0]).toBe('stops')
    expect(res.failedSteps).toContain('charges')
    expect(res.bundle?.shipment.updatedAt).toBe('u5')
  })
})

describe('submit and cover', () => {
  it('Submit saves strictly then submits; a refusal is shown verbatim and the draft stays saved', async () => {
    const v = filledValues(); const b = storedBundle(v)
    api.saveOrderForm.mockResolvedValue(at(b, 'u2'))
    api.submitOrder.mockRejectedValue(new Error('Credit hold: over limit'))
    const res = await runSubmit(v, ctx, b)
    expect(res.ok).toBe(false)
    expect(res.message).toBe('Credit hold: over limit')
    expect(api.saveOrderForm.mock.calls[0][0]).not.toHaveProperty('draftSave')
    expect(api.submitOrder.mock.calls[0][0]).toMatchObject({ shipmentId: 'shp-1', expectedUpdatedAt: 'u2' })
  })

  it('Submit does nothing on a form that fails the Submit rules', async () => {
    const v = filledValues(); v.customer.billToId = ''
    const res = await runSubmit(v, ctx, storedBundle(v))
    expect(res.ok).toBe(false)
    expect(api.saveOrderForm).not.toHaveBeenCalled()
    expect(api.submitOrder).not.toHaveBeenCalled()
  })

  it('Cover applies seal / ref / ETA and re-ties the extras to the booked assignment', async () => {
    const v = filledValues(); v.carrier.seal = 'S-1'; v.carrier.carrierRef = 'T-9'; v.carrier.puEta = '2026-11-10T07:00'
    const b = storedBundle(v, { status: 'OPEN' })
    ;(b as { loadCarriers: unknown[] }).loadCarriers = [{ id: 'lc-1', status: 'ACTIVE', kind: 'CARRIER', updatedAt: 'lu' }]
    api.updateLoadCarrierDetails.mockResolvedValue(b)
    api.setEta.mockResolvedValue({ bundle: b })
    api.updateOrderDetails.mockResolvedValue(b)
    const res = await runCover(v, b)
    expect(res.ok).toBe(true)
    expect(api.updateLoadCarrierDetails.mock.calls[0][0]).toMatchObject({ loadCarrierId: 'lc-1', sealNumber: 'S-1', tripNumber: 'T-9' })
    expect(api.setEta.mock.calls[0][0].pickupEtaAt).toMatch(/Z$/)
    const sr = api.updateOrderDetails.mock.calls[0][0].order.specialRequirements
    expect(sr.form.carrier.loadCarrierId).toBe('lc-1')
    expect(sr.form.rates?.carrierDraft).toBeUndefined()
  })
})
