import { describe, expect, it } from 'vitest'
import { loadExtraDocTypes, validateLoadRequiredDocTypes } from './loadRequiredDocs'
import { requiredDocTypesForRelease } from './releaseGate'
import { evaluateDocGate } from './shipmentDocuments'

describe('per-load required documents', () => {
  it('keeps known extras in picker order and refuses anything else', () => {
    expect(validateLoadRequiredDocTypes(['WEIGHT_TICKET', 'LUMPER_RECEIPT', 'LUMPER_RECEIPT'])).toEqual(['LUMPER_RECEIPT', 'WEIGHT_TICKET'])
    expect(validateLoadRequiredDocTypes(null)).toEqual([])
    expect(() => validateLoadRequiredDocTypes(['INVOICE'])).toThrow(/must be one of/)
    expect(() => validateLoadRequiredDocTypes('BOL')).toThrow(/must be an array/)
  })

  it('unions the extras of several loads and ignores stray values', () => {
    expect(loadExtraDocTypes([{ requiredDocTypes: ['TEMP_LOG'] }, { requiredDocTypes: ['lumper receipt', 'nonsense'] }, {}]))
      .toEqual(['LUMPER_RECEIPT', 'TEMP_LOG'])
  })

  it('adds the extras to the release list after the defaults', () => {
    const carrier = [{ kind: 'CARRIER' as const, status: 'ACTIVE', carrierName: 'X', driverId: null, deliveryDriverId: null, chargesFinalizedAt: null, rateConStatus: 'SIGNED', carrierRateCents: 1 }]
    const out = requiredDocTypesForRelease([], carrier, ['LUMPER_RECEIPT'])
    expect(out).toContain('POD')
    expect(out).toContain('RATE_CON')
    expect(out.at(-1)).toBe('LUMPER_RECEIPT')
  })

  it('makes the cached customer gate wait for a ticked extra', () => {
    const gate = evaluateDocGate({
      scope: 'CUSTOMER',
      order: { id: 'o1' },
      loadIds: ['l1'],
      loadCarriers: [],
      documents: [],
      customer: { requiredDocsForInvoice: ['POD'] },
      settings: null,
      extraDocTypes: ['LUMPER_RECEIPT'],
    })
    expect(gate.required).toEqual(['POD', 'RATE_CON', 'LUMPER_RECEIPT'])
    expect(gate.missing).toEqual(['POD', 'RATE_CON', 'LUMPER_RECEIPT'])
  })

  it('leaves the rate confirmation off a car-shipping load', () => {
    const gate = evaluateDocGate({
      scope: 'CUSTOMER',
      order: { id: 'o1' },
      loadIds: ['l1'],
      loadCarriers: [],
      documents: [],
      customer: { requiredDocsForInvoice: ['POD'] },
      settings: null,
      carShipper: true,
    })
    expect(gate.required).toEqual(['POD'])
    expect(requiredDocTypesForRelease([], [], [], { carShipper: true })).toEqual(['POD'])
  })
})
