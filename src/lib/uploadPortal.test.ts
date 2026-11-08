import { describe, it, expect } from 'vitest'
import { MAX_PORTAL_BYTES } from './shipmentDocuments'
import { carrierUploadView, portalUploadAllowed, uploadLinkUsable } from './uploadPortal'
import type { ShipmentDocumentRecord, ShipmentDocumentType, TrackingLinkRecord } from '../types/tms'
import type { Stop } from '../types'

/**
 * Values that exist on the shipment but must never reach a carrier. The view is
 * asserted against these by name, so a field added later that quietly carries one
 * of them fails here.
 */
const PRIVATE = {
  customerName: 'Acme Foods',
  reference: 'PO-99812',
  customerRate: '2850.00',
  customerRateCents: '285000',
}

function doc(
  id: string,
  type: ShipmentDocumentType,
  overrides: Partial<ShipmentDocumentRecord> = {},
): ShipmentDocumentRecord {
  return {
    id,
    shipmentId: 'shp-1',
    loadId: 'ld-1',
    loadCarrierId: 'lc-1',
    type,
    name: `${id}.pdf`,
    s3Key: `shipment-docs/shp-1/${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 4096,
    source: 'CARRIER_PORTAL',
    audience: 'ALL',
    status: 'ACTIVE',
    version: 1,
    reviewStatus: 'PENDING',
    uploadLinkId: 'tl-1',
    uploadedBy: 'link:abc12345',
    uploadedAt: '2026-03-04T15:00:00.000Z',
    createdBy: 'link:abc12345',
    ...overrides,
  }
}

const STOPS: Stop[] = [
  { id: 'pu1', type: 'pickup', sequence: 0, name: 'Midwest Cold', city: 'Chicago, IL', appt: '2026-03-02T14:00:00.000Z', driverId: null },
  { id: 'de1', type: 'delivery', sequence: 1, name: 'Gateway DC', city: 'Dallas, TX', appt: '2026-03-04T20:00:00.000Z', driverId: null },
]

function view(documents: ShipmentDocumentRecord[], neededTypes: string[] | null = ['POD', 'Carrier invoice']) {
  return carrierUploadView({
    link: { id: 'tl-1', expiresAt: '2026-04-03T20:00:00.000Z', neededTypes },
    load: { loadNumber: 'L-10042', aljexId: null, stops: STOPS },
    loadCarrier: { id: 'lc-1', carrierName: 'Blue Line Trucking' },
    documents,
    brokerName: 'BCAT Logistics',
    contactPhone: '+15125550100',
    nowIso: '2026-03-04T21:00:00.000Z',
  })
}

describe('carrierUploadView', () => {
  it('carries nothing about the customer, the references or the money', () => {
    const serialized = JSON.stringify(
      view([
        doc('sdoc-mine', 'POD'),
        // Another assignment's paperwork, named after the customer's PO.
        doc('sdoc-theirs', 'POD', {
          loadCarrierId: 'lc-2',
          uploadLinkId: 'tl-2',
          name: `${PRIVATE.reference}-${PRIVATE.customerName}.pdf`,
        }),
      ]),
    )
    for (const secret of Object.values(PRIVATE)) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('lists only what this link itself sent', () => {
    const result = view([
      doc('sdoc-a', 'POD', { uploadedAt: '2026-03-04T16:00:00.000Z' }),
      doc('sdoc-b', 'CARRIER_INVOICE', { uploadedAt: '2026-03-04T15:00:00.000Z' }),
      doc('sdoc-other-link', 'POD', { uploadLinkId: 'tl-9' }),
      doc('sdoc-other-carrier', 'POD', { loadCarrierId: 'lc-2' }),
      doc('sdoc-voided', 'POD', { status: 'VOID' }),
    ])
    expect(result.uploads.map((u) => u.id)).toEqual(['sdoc-b', 'sdoc-a'])
  })

  it('treats a file waiting for review as arrived, and a refused one as missing', () => {
    const result = view([
      doc('sdoc-pending', 'POD', { reviewStatus: 'PENDING' }),
      doc('sdoc-refused', 'CARRIER_INVOICE', { reviewStatus: 'REJECTED' }),
    ])
    expect(result.needed).toEqual([
      { type: 'POD', label: 'Proof of delivery', satisfied: true },
      { type: 'CARRIER_INVOICE', label: 'Carrier invoice', satisfied: false },
    ])
  })

  it('asks for POD and the carrier invoice when the link was minted without a list', () => {
    expect(view([], null).needed.map((n) => n.type)).toEqual(['POD', 'CARRIER_INVOICE'])
  })
})

describe('uploadLinkUsable', () => {
  const link: Pick<TrackingLinkRecord, 'kind' | 'status' | 'expiresAt'> = {
    kind: 'CARRIER_UPLOAD',
    status: 'ACTIVE',
    expiresAt: '2026-03-05T00:00:00.000Z',
  }
  const now = '2026-03-04T21:00:00.000Z'

  it('accepts a live upload link', () => {
    expect(uploadLinkUsable(link, now)).toBe(true)
  })

  it('refuses a revoked, expired, missing or differently-purposed link', () => {
    expect(uploadLinkUsable({ ...link, status: 'REVOKED' }, now)).toBe(false)
    expect(uploadLinkUsable({ ...link, expiresAt: '2026-03-04T20:00:00.000Z' }, now)).toBe(false)
    expect(uploadLinkUsable({ ...link, kind: 'CUSTOMER_VIEW' }, now)).toBe(false)
    expect(uploadLinkUsable(null, now)).toBe(false)
  })
})

describe('portalUploadAllowed', () => {
  it('accepts a POD photo', () => {
    expect(portalUploadAllowed('POD', 'image/jpeg', 3_000_000)).toEqual({ ok: true })
  })

  it('refuses a type the carrier has no business filing', () => {
    expect(portalUploadAllowed('BOL', 'application/pdf', 1024).ok).toBe(false)
    expect(portalUploadAllowed('INVOICE', 'application/pdf', 1024).ok).toBe(false)
  })

  it('refuses anything that is not a PDF, JPG or PNG', () => {
    expect(portalUploadAllowed('POD', 'image/heic', 1024).ok).toBe(false)
    expect(portalUploadAllowed('POD', 'application/zip', 1024).ok).toBe(false)
  })

  it('refuses an empty file and one over the portal ceiling', () => {
    expect(portalUploadAllowed('POD', 'application/pdf', 0).ok).toBe(false)
    expect(portalUploadAllowed('POD', 'application/pdf', MAX_PORTAL_BYTES + 1).ok).toBe(false)
    expect(portalUploadAllowed('POD', 'application/pdf', MAX_PORTAL_BYTES).ok).toBe(true)
  })
})
