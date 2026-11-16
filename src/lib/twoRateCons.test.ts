import { describe, expect, it } from 'vitest'
import { invoiceEmailDocuments } from './invoiceDelivery'
import { carrierDocumentReason } from './carrierPayGuard'
import { DOCUMENT_TYPE_LABELS, isBcatRateCon, isRegularRateCon, presentDocTypes } from './shipmentDocuments'
import { docCellOf } from '@/features/shipments/shipmentViews'
import type { ShipmentDocumentRecord } from '../types/tms'

// Ryne 2026-11-16: two kinds of rate confirmation. The regular one (the customer's / broker's) goes with an asset load's
// invoice; a BCAT Rate Confirmation (ours to a carrier) never goes with any invoice; the RC column is asset loads only.

const doc = (over: Partial<ShipmentDocumentRecord>): ShipmentDocumentRecord => ({
  id: 'd1', shipmentId: 's1', orderId: 'o1', loadId: 'l1', loadCarrierId: null, stopId: null, type: 'RATE_CON',
  name: 'rc.pdf', s3Key: 'shipment-docs/s1/d1.pdf', contentType: 'application/pdf', sizeBytes: 10,
  source: 'UPLOAD', audience: 'ALL', status: 'ACTIVE', createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
  ...over,
} as ShipmentDocumentRecord)

describe('two rate confirmations', () => {
  it('labels them apart', () => {
    expect(DOCUMENT_TYPE_LABELS.BCAT_RATE_CON).toBe('BCAT Rate Confirmation')
    expect(DOCUMENT_TYPE_LABELS.RATE_CON).toBe('Rate confirmation')
  })

  it('tells a BCAT one from a regular one, old rows included', () => {
    expect(isBcatRateCon(doc({ type: 'BCAT_RATE_CON' }))).toBe(true)
    expect(isBcatRateCon(doc({ source: 'GENERATED' }))).toBe(true)
    expect(isBcatRateCon(doc({ loadCarrierId: 'lc1' }))).toBe(true)
    expect(isRegularRateCon(doc({}))).toBe(true)
    expect(isRegularRateCon(doc({ type: 'CUSTOMER_RATE_CON' }))).toBe(true)
    expect(isRegularRateCon(doc({ type: 'BCAT_RATE_CON' }))).toBe(false)
  })

  it('never attaches a BCAT Rate Confirmation to an invoice, asset or brokered', () => {
    const bcat = doc({ id: 'b', type: 'BCAT_RATE_CON', audience: 'ALL', loadCarrierId: 'lc1' })
    for (const ivan of [true, false]) {
      const out = invoiceEmailDocuments([bcat], { attachIds: ['b'], orderId: 'o1', loadIds: ['l1'], ivan })
      expect(out.map((d) => d.id)).not.toContain('b')
    }
    expect(carrierDocumentReason(bcat, false)).toMatch(/BCAT Rate Confirmation/)
    expect(carrierDocumentReason(bcat, true)).toMatch(/BCAT Rate Confirmation/)
  })

  it('attaches the regular rate confirmation to an asset load invoice, and not to a brokered one', () => {
    const rc = doc({ id: 'r' })
    expect(invoiceEmailDocuments([rc], { orderId: 'o1', loadIds: ['l1'], ivan: true }).map((d) => d.id)).toEqual(['r'])
    expect(invoiceEmailDocuments([rc], { orderId: 'o1', loadIds: ['l1'], ivan: false }).map((d) => d.id)).toEqual([])
    // Uploaded to the shipment's Rate confirmation box (no order named): still the asset invoice's.
    const box = doc({ id: 'x', orderId: null, loadId: null })
    expect(invoiceEmailDocuments([box], { orderId: 'o1', loadIds: ['l1'], ivan: true }).map((d) => d.id)).toEqual(['x'])
  })

  it('a BCAT Rate Confirmation (or a carrier signature) is never the customer-side rate confirmation', () => {
    const base = { loadCarriers: [{ id: 'lc1', status: 'ACTIVE' as const, rateConStatus: 'SIGNED' as const, kind: 'CARRIER' as const }], orderId: 'o1', loadIds: ['l1'] }
    expect(presentDocTypes({ ...base, documents: [doc({ type: 'BCAT_RATE_CON', loadCarrierId: 'lc1' })], scope: 'CUSTOMER' })).not.toContain('RATE_CON')
    expect(presentDocTypes({ ...base, documents: [doc({})], scope: 'CUSTOMER' })).toContain('RATE_CON')
    // Paying the carrier: its signed BCAT rate con is the paperwork.
    expect(presentDocTypes({ ...base, documents: [], scope: 'CARRIER', loadCarrierId: 'lc1' })).toContain('RATE_CON')
  })

  it('the RC column is N/A on every non-asset load and for a waiving customer, and ✓ / NEED on asset loads', () => {
    const row = { status: 'DELIVERED', voidedAt: null, deletedAt: null, assignmentType: null, docsMissing: [], rateConSignedAt: null, rateConStatus: null, rateConOnFile: false } as never
    const brokeredFactored = { ...(row as object), revDivision: 'BROKERAGE', customerFactors: true, docsPresent: [] }
    expect(docCellOf(brokeredFactored as never, 'RATE_CON')).toBe('NA')
    const asset = { ...(row as object), revDivision: 'ASSETS', docsPresent: [], docsMissing: ['RATE_CON'], docsRequired: ['RATE_CON'] }
    expect(docCellOf(asset as never, 'RATE_CON')).toBe('MISSING')
    expect(docCellOf({ ...asset, docsPresent: ['RATE_CON'], docsMissing: [] } as never, 'RATE_CON')).toBe('PRESENT')
    // Batory / Carlyn / Bulk Systems / Rojac: RC unticked on the customer.
    expect(docCellOf({ ...asset, docsNotRequired: ['RATE_CON'] } as never, 'RATE_CON')).toBe('NA')
  })
})
