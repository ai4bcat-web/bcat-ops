import { describe, it, expect } from 'vitest'
import {
  canEmailTo,
  documentKey,
  evaluateDocGate,
  nextVersion,
  normalizeRequiredDocTypes,
  requiredDocTypesFor,
  supersede,
} from './shipmentDocuments'
import type {
  LoadCarrierRecord,
  ShipmentDocumentRecord,
  ShipmentDocumentType,
} from '../types/tms'

type GateCarrier = Pick<LoadCarrierRecord, 'id' | 'status' | 'rateConStatus'>

function doc(
  type: ShipmentDocumentType,
  overrides: Partial<ShipmentDocumentRecord> = {},
): ShipmentDocumentRecord {
  return {
    id: `sdoc-${type.toLowerCase()}`,
    shipmentId: 'shp-1',
    orderId: 'ord-1',
    loadId: 'ld-1',
    type,
    name: `${type.toLowerCase()}.pdf`,
    s3Key: `shipment-docs/shp-1/sdoc-${type.toLowerCase()}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    version: 1,
    reviewStatus: 'ACCEPTED',
    uploadedBy: 'ops@bcat.test',
    uploadedAt: '2026-03-02T12:00:00.000Z',
    createdBy: 'ops@bcat.test',
    ...overrides,
  }
}

function carrier(id: string, overrides: Partial<GateCarrier> = {}): GateCarrier {
  return { id, status: 'ACTIVE', rateConStatus: 'NOT_SENT', ...overrides }
}

/** The Ready-to-invoice gate for a one-order, one-load, one-assignment shipment. */
function customerGate(
  documents: ShipmentDocumentRecord[],
  required: string[] = ['POD'],
  loadCarriers: GateCarrier[] = [carrier('lc-1')],
) {
  return evaluateDocGate({
    order: { id: 'ord-1' },
    loadIds: ['ld-1'],
    loadCarriers,
    documents,
    customer: { requiredDocsForInvoice: required },
    scope: 'CUSTOMER',
  })
}

describe('normalizeRequiredDocTypes', () => {
  it('maps what people actually typed onto the vocabulary', () => {
    expect(
      normalizeRequiredDocTypes(['Proof of delivery', 'Rate confirmation', 'scale ticket']),
    ).toEqual({ types: ['POD', 'RATE_CON', 'WEIGHT_TICKET'], unrecognised: [] })
  })

  it('ignores case, spacing and separators', () => {
    expect(
      normalizeRequiredDocTypes(['  pod  ', 'RATE-CON', 'weight   ticket', 'Bill Of Lading']).types,
    ).toEqual(['POD', 'RATE_CON', 'WEIGHT_TICKET', 'BOL'])
  })

  it('keeps one entry per type however many ways it was written', () => {
    expect(normalizeRequiredDocTypes(['POD', 'Proof of Delivery', 'signed pod']).types).toEqual(['POD'])
  })

  it('reports what it could not map instead of dropping it', () => {
    const result = normalizeRequiredDocTypes(['POD', 'Signed BOL in triplicate', null, '  ', undefined])
    expect(result.types).toEqual(['POD'])
    expect(result.unrecognised).toEqual(['Signed BOL in triplicate'])
  })
})

describe('requiredDocTypesFor', () => {
  const settings = { defaultRequiredDocs: ['POD', 'Carrier invoice'] }

  it('lets the customer list replace the org default rather than add to it', () => {
    expect(requiredDocTypesFor({ requiredDocsForInvoice: ['BOL'] }, settings).types).toEqual(['BOL'])
  })

  it('falls back to the org default when the customer asked for nothing', () => {
    expect(requiredDocTypesFor({ requiredDocsForInvoice: [] }, settings).types).toEqual([
      'POD',
      'CARRIER_INVOICE',
    ])
    expect(requiredDocTypesFor(null, settings).types).toEqual(['POD', 'CARRIER_INVOICE'])
  })

  it('does not fall back when the customer said something we could not map', () => {
    const result = requiredDocTypesFor({ requiredDocsForInvoice: ['Signed delivery log'] }, settings)
    expect(result.types).toEqual([])
    expect(result.unrecognised).toEqual(['Signed delivery log'])
  })
})

describe('evaluateDocGate — customer scope', () => {
  it('is satisfied by an accepted, active row on the order', () => {
    const result = customerGate([doc('POD')])
    expect(result.missing).toEqual([])
    expect(result.present).toContain('POD')
    expect(result.ready).toBe(true)
  })

  const notPresent: [string, Partial<ShipmentDocumentRecord>][] = [
    ['PENDING review', { reviewStatus: 'PENDING' }],
    ['REJECTED review', { reviewStatus: 'REJECTED' }],
    ['VOID', { status: 'VOID' }],
    ['SUPERSEDED', { status: 'SUPERSEDED' }],
  ]

  it.each(notPresent)('does not count a %s row', (_label, overrides) => {
    const result = customerGate([doc('POD', overrides)])
    expect(result.missing).toEqual(['POD'])
    expect(result.ready).toBe(false)
  })

  it('accepts a POD filed under the active carrier assignment', () => {
    const result = customerGate([doc('POD', { orderId: null, loadId: null, loadCarrierId: 'lc-1' })])
    expect(result.ready).toBe(true)
  })

  it('ignores the same POD once that assignment bounced', () => {
    const result = customerGate(
      [doc('POD', { orderId: null, loadCarrierId: 'lc-1' })],
      ['POD'],
      [carrier('lc-1', { status: 'BOUNCED' })],
    )
    expect(result.missing).toEqual(['POD'])
  })

  it('counts a signed rate confirmation but not one merely sent', () => {
    expect(
      customerGate([], ['Rate confirmation'], [carrier('lc-1', { rateConStatus: 'SIGNED' })]).missing,
    ).toEqual([])
    expect(
      customerGate([], ['Rate confirmation'], [carrier('lc-1', { rateConStatus: 'SENT' })]).missing,
    ).toEqual(['RATE_CON'])
  })
})

describe('evaluateDocGate — carrier scope', () => {
  function carrierGate(documents: ShipmentDocumentRecord[], requiredCarrierUploadTypes?: string[]) {
    return evaluateDocGate({
      loadIds: ['ld-1'],
      loadCarriers: [carrier('lc-1'), carrier('lc-2')],
      documents,
      settings: requiredCarrierUploadTypes ? { requiredCarrierUploadTypes } : null,
      scope: 'CARRIER',
      loadCarrierId: 'lc-1',
    })
  }

  it('asks for the org carrier-upload list, not the customer gate list', () => {
    const result = carrierGate([], ['Proof of delivery', 'Weight ticket'])
    expect(result.required).toEqual(['POD', 'WEIGHT_TICKET'])
  })

  it('asks for POD and the carrier invoice when the org set nothing', () => {
    expect(carrierGate([]).required).toEqual(['POD', 'CARRIER_INVOICE'])
  })

  it('only counts rows filed against the assignment being evaluated', () => {
    const result = carrierGate(
      [
        doc('POD', { id: 'sdoc-a', orderId: null, loadCarrierId: 'lc-1' }),
        doc('WEIGHT_TICKET', { id: 'sdoc-b', orderId: null, loadCarrierId: 'lc-2' }),
      ],
      ['POD', 'Weight ticket'],
    )
    expect(result.present).toEqual(['POD'])
    expect(result.missing).toEqual(['WEIGHT_TICKET'])
  })
})

describe('nextVersion', () => {
  const docs = [
    doc('BOL', { version: 1 }),
    doc('BOL', { version: 2 }),
    doc('POD', { version: 1 }),
  ]

  it('counts versions per type', () => {
    expect(nextVersion(docs, 'BOL', 'ld-1')).toBe(3)
    expect(nextVersion(docs, 'POD', 'ld-1')).toBe(2)
  })

  it('starts each leg of a two-leg shipment at v1', () => {
    expect(nextVersion(docs, 'BOL', 'ld-2')).toBe(1)
    expect(nextVersion(docs, 'BOL', null)).toBe(1)
  })
})

describe('supersede', () => {
  const docs = [
    doc('BOL', { id: 'older', status: 'SUPERSEDED', version: 1 }),
    doc('BOL', { id: 'current', version: 2 }),
    doc('BOL', { id: 'other-leg', loadId: 'ld-2' }),
    doc('POD', { id: 'pod-current' }),
  ]

  it('returns the one active row of that type on that load', () => {
    expect(supersede(docs, { type: 'BOL', loadId: 'ld-1' })?.id).toBe('current')
    expect(supersede(docs, { type: 'BOL', loadId: 'ld-2' })?.id).toBe('other-leg')
  })

  it('returns nothing when this is the first of its kind', () => {
    expect(supersede(docs, { type: 'BOL', loadId: 'ld-3' })).toBeNull()
    expect(supersede(docs, { type: 'LOAD_SUMMARY', loadId: 'ld-1' })).toBeNull()
  })
})

describe('canEmailTo', () => {
  const active = { status: 'ACTIVE' as const, reviewStatus: 'ACCEPTED' as const }

  it('never lets an internal document leave', () => {
    expect(canEmailTo({ ...active, audience: 'INTERNAL' }, 'CUSTOMER')).toBe(false)
    expect(canEmailTo({ ...active, audience: 'INTERNAL' }, 'CARRIER')).toBe(false)
  })

  it('keeps each side to its own paperwork', () => {
    expect(canEmailTo({ ...active, audience: 'CUSTOMER' }, 'CUSTOMER')).toBe(true)
    expect(canEmailTo({ ...active, audience: 'CUSTOMER' }, 'CARRIER')).toBe(false)
    expect(canEmailTo({ ...active, audience: 'CARRIER' }, 'CARRIER')).toBe(true)
    expect(canEmailTo({ ...active, audience: 'CARRIER' }, 'CUSTOMER')).toBe(false)
  })

  it('sends a shared document to both', () => {
    expect(canEmailTo({ ...active, audience: 'ALL' }, 'CUSTOMER')).toBe(true)
    expect(canEmailTo({ ...active, audience: 'ALL' }, 'CARRIER')).toBe(true)
  })

  it('holds back anything still under review or voided', () => {
    expect(canEmailTo({ ...active, audience: 'ALL', reviewStatus: 'PENDING' }, 'CUSTOMER')).toBe(false)
    expect(canEmailTo({ ...active, audience: 'ALL', reviewStatus: 'REJECTED' }, 'CARRIER')).toBe(false)
    expect(canEmailTo({ ...active, audience: 'ALL', status: 'VOID' }, 'CUSTOMER')).toBe(false)
  })
})

describe('documentKey', () => {
  it('keeps the shipment, the document id and a scrubbed name', () => {
    expect(documentKey('shp-1', 'sdoc-9', 'POD scan (final).pdf', 'application/pdf')).toBe(
      'shipment-docs/shp-1/sdoc-9-POD_scan__final_.pdf',
    )
  })

  it('drops any path the browser or phone sent with the name', () => {
    expect(documentKey('shp-1', 'sdoc-9', 'C:\\Users\\Driver\\pod.pdf', 'application/pdf')).toBe(
      'shipment-docs/shp-1/sdoc-9-pod.pdf',
    )
    expect(documentKey('shp-1', 'sdoc-9', '../../other-shipment/pod.pdf', 'application/pdf')).toBe(
      'shipment-docs/shp-1/sdoc-9-pod.pdf',
    )
  })

  it('takes the extension from the content type, not from the name', () => {
    expect(documentKey('shp-1', 'sdoc-9', 'pod.pdf', 'image/jpeg')).toBe(
      'shipment-docs/shp-1/sdoc-9-pod.jpg',
    )
  })

  it('still produces a usable key for a name made entirely of junk', () => {
    expect(documentKey('shp-1', 'sdoc-9', '***', 'application/pdf')).toBe(
      'shipment-docs/shp-1/sdoc-9-document.pdf',
    )
  })
})
