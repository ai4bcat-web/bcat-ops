import { describe, expect, it } from 'vitest'
import type { LocationRecord } from '@/types/tms'
import { emptyStop } from '../model'
import { draftFromStop, findDuplicate, onceStopPatch, upsertInputOf, validateDraft } from './newLocation'

const loc = (o: Partial<LocationRecord>) => ({ id: 'l1', name: 'ZZ Dock', street: '1 Dock Rd', city: 'Joliet', state: 'IL', zip: '60431', country: 'US', active: true, createdAt: '', updatedAt: '', ...o }) as LocationRecord
const draft = (o = {}) => ({ ...draftFromStop({ ...emptyStop('pickup'), name: 'ZZ Yard' }), street: '9 Yard Ln', city: 'Joliet', state: 'IL', zip: '60431', ...o })

describe('draftFromStop / validateDraft', () => {
  it('prefills from the stop, with the type following the stop kind', () => {
    expect(draftFromStop({ ...emptyStop('delivery'), name: 'X' }).facilityType).toBe('RECEIVER')
    expect(draftFromStop({ ...emptyStop('pickup'), name: ' Typed ' }).name).toBe('Typed')
    expect(draftFromStop(emptyStop('pickup'), 'Other').name).toBe('Other')
  })
  it('requires name, city, two-letter state and a 5/9-digit zip; e-mail must look like one', () => {
    expect(Object.keys(validateDraft(draftFromStop(emptyStop('pickup')))).sort()).toEqual(['city', 'name', 'state', 'zip'])
    expect(validateDraft(draft())).toEqual({})
    expect(validateDraft(draft({ zip: '604' })).zip).toBeTruthy()
    expect(validateDraft(draft({ state: 'Illinois' })).state).toBeTruthy()
    expect(validateDraft(draft({ email: 'nope' })).email).toBeTruthy()
    expect(validateDraft(draft({ zip: '60431-1234', email: 'a@b.co' }))).toEqual({})
  })
})

describe('findDuplicate', () => {
  it('same normalised name (or alias) in the same zip', () => {
    expect(findDuplicate(draft({ name: ' zz  DOCK ' }), [loc({})])).toMatchObject({ why: 'name' })
    expect(findDuplicate(draft({ name: 'Old Name' }), [loc({ aliases: ['Old Name'] })])).toMatchObject({ why: 'name' })
  })
  it('same address + zip under another name', () => {
    expect(findDuplicate(draft({ street: '1 dock rd.' }), [loc({})])).toMatchObject({ why: 'address' })
  })
  it('a same name in another zip, an archived row and a merged row are not duplicates', () => {
    expect(findDuplicate(draft({ name: 'ZZ Dock' }), [loc({ zip: '75001' })])).toBeNull()
    expect(findDuplicate(draft({ name: 'ZZ Dock' }), [loc({ active: false })])).toBeNull()
    expect(findDuplicate(draft({ name: 'ZZ Dock' }), [loc({ mergedIntoId: 'x' })])).toBeNull()
  })
})

describe('what gets sent and what Use once leaves', () => {
  it('upsert input carries the source and the appointment rule', () => {
    const d = draft({ apptRequired: true, street2: 'Dock 4', state: 'il' })
    expect(upsertInputOf(d, 'intake')).toMatchObject({ name: 'ZZ Yard', street: '9 Yard Ln, Dock 4', state: 'IL', apptRule: 'APPT', facilityType: 'SHIPPER', createdFrom: 'intake' })
    expect(upsertInputOf(draft(), 'shipment-form')).toMatchObject({ apptRule: null, createdFrom: 'shipment-form' })
  })
  it('use once keeps the typed address and drops any directory link and pin', () => {
    expect(onceStopPatch(draft())).toMatchObject({ name: 'ZZ Yard', locationId: '', geo: null, address1: '9 Yard Ln', city: 'Joliet', state: 'IL', zip: '60431' })
  })
})
