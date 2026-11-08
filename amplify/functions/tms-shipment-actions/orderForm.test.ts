import { describe, it, expect } from 'vitest'
import {
  mergeSpecialRequirements,
  validateCarrierDetails,
  validateFormExtras,
  validateSpecialRequirementsV2,
  validateStopDetailsPatch,
} from './orderForm'

const IMPORTED = {
  escort: true,
  oversize: true,
  permit: true,
  blind: true,
  sealRequired: true,
  tempControl: true,
  customsBond: 'Y',
  palletsIn: 4,
  palletsOut: 2,
  form: { v: 1, ship: { truckMiles: 812 }, customer: { emails: ['ops@example.com'] } },
}

describe('special requirements patch', () => {
  it('keeps every imported flag and the form extras when the order editor saves its five keys', () => {
    const stored = { ...IMPORTED, team: false }
    const editorPayload = { team: true, tarps: false, straps: false, liftgate: null, hazmat: false }
    const merged = mergeSpecialRequirements(stored, validateSpecialRequirementsV2(editorPayload))
    expect(merged).toMatchObject(IMPORTED)
    expect(merged).toMatchObject({ team: true, tarps: false })
    expect(merged).not.toHaveProperty('liftgate')
  })

  it('clears one key on an explicit null and everything on a null payload', () => {
    const merged = mergeSpecialRequirements(IMPORTED, validateSpecialRequirementsV2({ escort: null }))
    expect(merged).not.toHaveProperty('escort')
    expect(merged).toMatchObject({ oversize: true, form: IMPORTED.form })
    expect(mergeSpecialRequirements(IMPORTED, validateSpecialRequirementsV2(null))).toBeNull()
  })

  it('reads a stored value that arrived as a JSON string', () => {
    const merged = mergeSpecialRequirements(JSON.stringify(IMPORTED), validateSpecialRequirementsV2({ fsma: true }))
    expect(merged).toMatchObject({ ...IMPORTED, fsma: true })
  })

  it('replaces tempF as a unit and treats inside as tri-state', () => {
    const merged = mergeSpecialRequirements(
      { tempF: { target: 34, min: 30, max: 36 }, inside: true },
      validateSpecialRequirementsV2({ tempF: { min: 33 }, inside: false }),
    )
    expect(merged?.tempF).toEqual({ target: null, min: 33, max: null })
    expect(merged?.inside).toBe(false)
  })

  it('rejects a negative pallet count', () => {
    expect(() => validateSpecialRequirementsV2({ palletsIn: -1 })).toThrow(/palletsIn/)
  })
})

describe('validateFormExtras shipmentType', () => {
  it('keeps a known type key, drops an empty one, and refuses an unknown one', () => {
    expect(validateFormExtras({ v: 1, shipmentType: 'REEFER' })).toEqual({ v: 1, shipmentType: 'REEFER' })
    expect(validateFormExtras({ v: 1, shipmentType: '' })).toEqual({ v: 1 })
    expect(() => validateFormExtras({ v: 1, shipmentType: 'SPACESHIP' })).toThrow(/form\.shipmentType/)
    expect(() => validateFormExtras({ v: 1, shipmentType: 7 })).toThrow(/form\.shipmentType/)
  })
})

describe('validateFormExtras', () => {
  it('refuses an unknown key and names its path', () => {
    expect(() => validateFormExtras({ v: 1, ship: { bogus: 1 } })).toThrow(/form\.ship\.bogus/)
    expect(() => validateFormExtras({ v: 1, nope: {} })).toThrow(/form\.nope/)
  })

  it('refuses a seventh e-mail, an invalid address, long instructions and a negative count', () => {
    const seven = Array.from({ length: 7 }, (_, i) => `a${i}@example.com`)
    expect(() => validateFormExtras({ customer: { emails: seven } })).toThrow(/at most 6/)
    expect(() => validateFormExtras({ customer: { emails: ['not-an-email'] } })).toThrow(/valid email/)
    expect(() => validateFormExtras({ instructions: { special: 'x'.repeat(421) } })).toThrow(/420/)
    expect(() => validateFormExtras({ ship: { footage: -3 } })).toThrow(/footage/)
  })

  it('lower-cases and de-duplicates e-mails and drops empty sections', () => {
    const out = validateFormExtras({
      customer: { emails: ['Ops@Example.com', 'ops@example.com', ''] },
      roles: { tariff: '' },
    })
    expect(out).toEqual({ v: 1, customer: { emails: ['ops@example.com'] } })
  })
})

describe('validateCarrierDetails', () => {
  it('names a money key and refuses unknown ones', () => {
    expect(() => validateCarrierDetails({ carrierRateCents: 5 })).toThrow(/carrierRateCents/)
    expect(() => validateCarrierDetails({ sealNumbr: 'x' })).toThrow(/sealNumbr/)
  })

  it('keeps present keys, clears blanks and needs at least one key', () => {
    expect(validateCarrierDetails({ loadCarrierId: 'x', expectedUpdatedAt: 'y', sealNumber: ' S1 ', vin: '' }))
      .toEqual({ sealNumber: 'S1', vin: null })
    expect(() => validateCarrierDetails({ loadCarrierId: 'x', expectedUpdatedAt: 'y' })).toThrow(/Nothing to change/)
  })
})

describe('validateStopDetailsPatch', () => {
  it('writes present keys, clears nulls and refuses a stray key', () => {
    expect(validateStopDetailsPatch({ instructions: 'Dock 4', pieces: null, weightLbs: 900 }))
      .toEqual({ instructions: 'Dock 4', pieces: null, weightLbs: 900 })
    expect(() => validateStopDetailsPatch({ appt: 'x' })).toThrow(/appt/)
    expect(() => validateStopDetailsPatch({ pieces: -1 })).toThrow(/pieces/)
  })
})

describe('multi-carrier form extras and leg details', () => {
  it('keeps up to four carrier slots and refuses a fifth or an unknown key', () => {
    const slot = (n: number) => ({ slot: `s${n}`, draft: { rateType: 'FLAT', lhRateCents: 90_000 }, driverEmail1: 'A@Example.com' })
    const out = validateFormExtras({ v: 1, carriers: [slot(0), slot(1)] })
    expect(out.carriers).toEqual([
      { slot: 's0', draft: { rateType: 'FLAT', lhRateCents: 90_000 }, driverEmail1: 'a@example.com' },
      { slot: 's1', draft: { rateType: 'FLAT', lhRateCents: 90_000 }, driverEmail1: 'a@example.com' },
    ])
    expect(() => validateFormExtras({ v: 1, carriers: [0, 1, 2, 3, 4].map(slot) })).toThrow(/at most 4/)
    expect(() => validateFormExtras({ v: 1, carriers: [{ slot: 's0', rate: 1 }] })).toThrow(/rate/)
  })

  it('takes legs and a tracking override on the carrier details, and refuses a confirmed mode', () => {
    expect(validateCarrierDetails({ loadCarrierId: 'lc', expectedUpdatedAt: 'x', legStopIds: ['a', 'a', 'b'] }))
      .toEqual({ legStopIds: ['a', 'b'] })
    expect(validateCarrierDetails({ loadCarrierId: 'lc', expectedUpdatedAt: 'x', trackingPrefs: null }))
      .toEqual({ trackingPrefs: null })
    expect(() => validateCarrierDetails({ loadCarrierId: 'lc', expectedUpdatedAt: 'x', trackingPrefs: { mode: 'MANUAL', confirmed: true } }))
      .toThrow(/cannot confirm/)
  })
})
