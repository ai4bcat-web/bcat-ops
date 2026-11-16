/**
 * The shipment editor's POD / Rate confirmation boxes, the order gate the board caches, and the release gate give
 * ONE answer (Ryne 2026-11-16: 14938 showed POD "On file" in the editor but NEED on the board, and RC the other way).
 */
import { describe, expect, it } from 'vitest'
import { countsAsPresent, evaluateDocGate, shipmentDocPresence } from './shipmentDocuments'
import { evaluateReleaseGate } from './releaseGate'
import type { ShipmentDocumentRecord } from '@/types/tms'

const doc = (over: Partial<ShipmentDocumentRecord>): ShipmentDocumentRecord => ({
  id: over.id ?? 'd1', shipmentId: 's1', type: 'POD', status: 'ACTIVE', audience: 'ALL', source: 'UPLOAD', name: 'x.pdf',
  s3Key: 'k', contentType: 'application/pdf', ...over,
}) as ShipmentDocumentRecord
const ownLeg = { id: 'lc1', status: 'ACTIVE', kind: 'OWN_ASSET', rateConStatus: null } as never
const base = { orders: [{ id: 'o1' }], loads: [{ id: 'l1', orderId: 'o1', rateConfirmKey: null as string | null }], loadCarriers: [ownLeg], shipment: { revDivision: 'ASSETS' } }

describe('driver-app PODs count while they wait for review', () => {
  it('a driver page waiting for review is on file; a carrier-portal upload waiting for review is not', () => {
    expect(countsAsPresent(doc({ source: 'DRIVER_APP', reviewStatus: 'PENDING' }))).toBe(true)
    expect(countsAsPresent(doc({ source: 'CARRIER_PORTAL' as never, reviewStatus: 'PENDING' }))).toBe(false)
    expect(countsAsPresent(doc({ source: 'DRIVER_APP', reviewStatus: 'REJECTED' }))).toBe(false)
  })
  it('the gate lists it as present and as pending review until an accepted copy exists', () => {
    const pending = doc({ source: 'DRIVER_APP', reviewStatus: 'PENDING', loadId: 'l1' })
    const gate = evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [ownLeg], documents: [pending], scope: 'CUSTOMER' })
    expect(gate.present).toContain('POD')
    expect(gate.pendingReview).toEqual(['POD'])
    const upload = doc({ id: 'd2', orderId: 'o1' })
    expect(evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [ownLeg], documents: [pending, upload], scope: 'CUSTOMER' }).pendingReview).toEqual([])
  })
  it('the release gate lets a driver POD through (Move to billing accepts it)', () => {
    const r = evaluateReleaseGate({
      shipment: { status: 'DELIVERED', revDivision: 'ASSETS' },
      order: { arStatus: 'DOCS_NEEDED', references: [], invoiceId: null },
      requiredDocTypes: ['POD'], requiredReferenceCodes: [], openIncidentCount: 0,
      documents: [{ type: 'POD', status: 'ACTIVE', reviewStatus: 'PENDING', source: 'DRIVER_APP' }],
      legs: [],
    } as never)
    expect(r.missing.map((m) => m.detail)).not.toContain('POD')
  })
})

describe('shipmentDocPresence: the editor box says what the board cell says', () => {
  it('14938: driver image + office upload POD on file; the customer tender on the load is the rate confirmation', () => {
    const docs = [doc({ source: 'DRIVER_APP', reviewStatus: 'PENDING', loadId: 'l1' }), doc({ id: 'd2', orderId: 'o1' })]
    const loads = [{ id: 'l1', orderId: 'o1', rateConfirmKey: 'rate-confirms/l1/rate-confirm.pdf' }]
    expect(shipmentDocPresence({ ...base, loads, documents: docs }, 'POD')).toBe('PRESENT')
    expect(shipmentDocPresence({ ...base, loads, documents: docs }, 'RATE_CON')).toBe('PRESENT')
  })
  it('only a driver page: REVIEW; nothing: MISSING; a BCAT-generated carrier rate con never counts', () => {
    expect(shipmentDocPresence({ ...base, documents: [doc({ source: 'DRIVER_APP', reviewStatus: 'PENDING', loadId: 'l1' })] }, 'POD')).toBe('REVIEW')
    expect(shipmentDocPresence({ ...base, documents: [] }, 'POD')).toBe('MISSING')
    const loads = [{ id: 'l1', orderId: 'o1', rateConfirmKey: 'rate-confirms/carrier/l1/lc1-v1.pdf' }]
    expect(shipmentDocPresence({ ...base, loads, documents: [] }, 'RATE_CON')).toBe('MISSING')
  })
  it('a file filed on the shipment itself counts for its only order', () => {
    const rc = doc({ type: 'RATE_CON' })
    expect(shipmentDocPresence({ ...base, documents: [rc] }, 'RATE_CON')).toBe('PRESENT')
    expect(evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [ownLeg], documents: [rc], scope: 'CUSTOMER', soleOrder: true }).present).toContain('RATE_CON')
    expect(evaluateDocGate({ order: { id: 'o1' }, loadIds: ['l1'], loadCarriers: [ownLeg], documents: [rc], scope: 'CUSTOMER', soleOrder: false }).present).not.toContain('RATE_CON')
  })
})
