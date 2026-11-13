import { describe, expect, it } from 'vitest'
import { invoiceAttachmentPlan, invoiceEmailDocuments, isCustomerRateCon, isMergeablePodType } from './invoiceDelivery'
import { carrierDocumentReason, carrierPayAmounts, carrierPayInText } from './carrierPayGuard'
import type { ShipmentDocumentRecord } from '../types/tms'

let n = 0
function doc(over: Partial<ShipmentDocumentRecord>): ShipmentDocumentRecord {
  n += 1
  return {
    id: `d${n}`, shipmentId: 's1', orderId: 'o1', loadId: null, loadCarrierId: null,
    type: 'POD', name: `doc${n}.pdf`, status: 'ACTIVE', audience: 'ALL', reviewStatus: null,
    source: 'UPLOAD', s3Key: `shipment-docs/d${n}.pdf`, contentType: 'application/pdf', sizeBytes: 1000,
    createdAt: `2026-11-1${n % 10}T00:00:00Z`,
    ...over,
  } as unknown as ShipmentDocumentRecord
}

describe('invoice e-mail attachments (Ryne, 2026-11-12)', () => {
  const pod = doc({ type: 'POD' })
  const carrierRc = doc({ type: 'RATE_CON', source: 'GENERATED', audience: 'ALL', orderId: null, loadCarrierId: 'lc1' })
  const signedRc = doc({ type: 'RATE_CON', source: 'CARRIER_PORTAL', audience: 'ALL' })
  const customerRc = doc({ type: 'CUSTOMER_RATE_CON', audience: 'INTERNAL' })
  const customerSectionRc = doc({ type: 'RATE_CON', audience: 'CARRIER', source: 'UPLOAD' })
  const bol = doc({ type: 'BOL' })
  const carrierInvoice = doc({ type: 'CARRIER_INVOICE', audience: 'ALL' })
  const all = [pod, carrierRc, signedRc, customerRc, customerSectionRc, bol, carrierInvoice]

  it('a brokerage invoice never carries any rate confirmation, and always the POD', () => {
    const out = invoiceEmailDocuments(all, { attachIds: [bol.id, carrierRc.id, customerRc.id], orderId: 'o1', loadIds: [], ivan: false })
    expect(out.map((d) => d.id)).toEqual([pod.id, bol.id])
    expect(out.some((d) => d.type === 'RATE_CON' || d.type === 'CUSTOMER_RATE_CON')).toBe(false)
  })

  it('an Ivan Cartage invoice carries the customer rate con, never a generated or carrier-signed one', () => {
    const out = invoiceEmailDocuments(all, { attachIds: [], orderId: 'o1', loadIds: [], ivan: true }).map((d) => d.id)
    expect(out).toContain(customerRc.id)
    expect(out).toContain(customerSectionRc.id)
    expect(out).toContain(pod.id)
    expect(out).not.toContain(carrierRc.id)
    expect(out).not.toContain(signedRc.id)
    expect(out).not.toContain(carrierInvoice.id)
  })

  it('no attached document is ever a generated carrier rate con', () => {
    for (const ivan of [true, false]) {
      const out = invoiceEmailDocuments(all, { attachIds: all.map((d) => d.id), orderId: 'o1', loadIds: [], ivan })
      expect(out.some((d) => d.source === 'GENERATED' && d.type === 'RATE_CON')).toBe(false)
      expect(out.some((d) => d.loadCarrierId != null)).toBe(false)
    }
  })

  it('a POD filed after the invoice still goes; a rejected one does not', () => {
    const late = doc({ type: 'POD', loadId: 'l1', orderId: null })
    const rejected = doc({ type: 'POD', reviewStatus: 'REJECTED' })
    const out = invoiceEmailDocuments([late, rejected], { attachIds: [], orderId: 'o1', loadIds: ['l1'], ivan: false })
    expect(out.map((d) => d.id)).toEqual([late.id])
  })

  it('plan: brokerage RC is not included, Ivan RC missing is flagged, POD missing is flagged', () => {
    const pdf = { name: 'Invoice 1.pdf', sizeBytes: 500 }
    expect(invoiceAttachmentPlan([pod], { ivan: false }, pdf)).toMatchObject({ invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'NOT_INCLUDED', count: 1, totalBytes: 1500 })
    expect(invoiceAttachmentPlan([], { ivan: true }, pdf)).toMatchObject({ pod: 'MISSING', rateCon: 'MISSING', count: 1 })
    expect(invoiceAttachmentPlan([customerRc], { ivan: true }, null)).toMatchObject({ invoicePdf: 'MISSING', rateCon: 'ATTACHED' })
  })

  it('plan: PODs ride inside the invoice PDF; the BOL and a customer rate con stay separate files', () => {
    const pdf = { name: 'Invoice 20027 PO1.pdf', sizeBytes: 500 }
    const plan = invoiceAttachmentPlan([pod, bol, customerRc], { attachIds: [bol.id], ivan: true }, pdf)
    expect(plan.items.find((i) => i.documentId === pod.id)?.inInvoicePdf).toBe(true)
    expect(plan.items.find((i) => i.documentId === bol.id)?.inInvoicePdf).toBeUndefined()
    expect(plan.items.find((i) => i.documentId === customerRc.id)?.inInvoicePdf).toBeUndefined()
    expect(plan.count).toBe(3)
    // No invoice PDF to merge into: the POD goes as its own file.
    expect(invoiceAttachmentPlan([pod], { ivan: false }, null).items[0].inInvoicePdf).toBeUndefined()
  })

  it('plan: a POD that cannot be merged is named before anyone presses Send', () => {
    const heic = doc({ type: 'POD', name: 'IMG_0042.HEIC', contentType: 'image/heic' })
    const phone = doc({ type: 'POD', name: 'pod.jpg', contentType: 'application/octet-stream' })
    const plan = invoiceAttachmentPlan([heic, phone, pod], { ivan: false }, { name: 'Invoice 1.pdf', sizeBytes: 1 })
    expect(plan.unmergeablePods).toEqual(['IMG_0042.HEIC'])
    expect(isMergeablePodType('image/png', 'x.png')).toBe(true)
    expect(isMergeablePodType('application/msword', 'pod.doc')).toBe(false)
  })

  it('isCustomerRateCon follows the OTR submit rule', () => {
    expect(isCustomerRateCon(customerRc)).toBe(true)
    expect(isCustomerRateCon(customerSectionRc)).toBe(true)
    expect(isCustomerRateCon(carrierRc)).toBe(false)
    expect(isCustomerRateCon(signedRc)).toBe(false)
  })
})

describe('carrier pay guard', () => {
  it('blocks carrier documents by type or origin', () => {
    expect(carrierDocumentReason(doc({ type: 'CARRIER_INVOICE' }), false)).toMatch(/Carrier invoice/)
    expect(carrierDocumentReason(doc({ type: 'LOAD_SUMMARY' }), false)).toMatch(/Load summary/)
    expect(carrierDocumentReason(doc({ type: 'RATE_CON', source: 'GENERATED' }), false)).toMatch(/rate confirmation/i)
    expect(carrierDocumentReason(doc({ type: 'CUSTOMER_RATE_CON' }), true)).toBeNull()
    expect(carrierDocumentReason(doc({ type: 'POD' }), false)).toBeNull()
  })

  it('finds the carrier pay amount or carrier-pay wording in text', () => {
    const carrier = carrierPayAmounts([{ side: 'CARRIER', amountCents: 147000, loadCarrierId: 'lc1' }, { side: 'CUSTOMER', amountCents: 175000 }])
    expect(carrierPayInText('Total due $1,470.00', carrier)).toMatch(/1,470.00/)
    expect(carrierPayInText('Rate 1470.00 flat', carrier)).toMatch(/1470.00/)
    expect(carrierPayInText('Total $11,470.00', carrier)).toBeNull()
    expect(carrierPayInText('Linehaul $1,750.00', carrier)).toBeNull()
    expect(carrierPayInText('Please remit Carrier Pay within 30 days', [])).toMatch(/carrier pay/i)
    // The same number on the customer side proves nothing.
    expect(carrierPayInText('Total $1,750.00', [175000], [175000])).toBeNull()
  })
})
