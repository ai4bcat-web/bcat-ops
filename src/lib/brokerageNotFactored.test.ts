import { describe, expect, it } from 'vitest'
import { customerApEmailRequired, customerDocsNotRequired, customerFactorsForOtr, isBrokerageRevDivision } from './reviewRequirements'
import { isFactoredLoad } from './factorBilling'
import { factorGapsForLoad } from './factorReadyAtCreate'
import { invoiceData, invoiceReadiness } from './invoiceBuild'
import { isFactoredInvoice } from '../features/ar/sendReview'
import { billsThroughOtr } from '../features/ar/autoInvoice'
import type { CustomerRecord, InvoiceRecord } from '../types/tms'

// Ryne 2026-11-16: "We aren't factoring brokered loads. If the rev division is brokerage we aren't currently factoring it."
const FACTOR = { name: 'Cowtown', billingMethod: 'FACTOR' as const, factored: null, customerType: 'BROKER' as const, mcNumber: null }
const GAPPY = { customer: FACTOR, poNumber: null, customerRateCents: 0, pickup: null, delivery: null }

describe('one rule: a factored load is a factor-billed customer on a non-brokerage load', () => {
  it('the division decides, not only the customer', () => {
    expect(isBrokerageRevDivision('BROKERAGE')).toBe(true)
    expect(isBrokerageRevDivision(' brokerage ')).toBe(true)
    expect(isBrokerageRevDivision('ASSETS')).toBe(false)
    expect(customerFactorsForOtr(FACTOR, 'BROKERAGE')).toBe(false)
    expect(customerFactorsForOtr(FACTOR, 'ASSETS')).toBe(true)
    expect(customerFactorsForOtr(FACTOR, 'CAR_SHIPPING')).toBe(true)
    expect(isFactoredLoad(FACTOR, 'BROKERAGE')).toBe(false)
    expect(isFactoredLoad(FACTOR, 'ASSETS')).toBe(true)
    expect(isFactoredLoad({ billingMethod: 'MANUAL', factored: null }, 'ASSETS')).toBe(false)
  })

  it('a brokered load for a FACTOR customer has no OTR factoring gaps; an asset load for the same customer does', () => {
    expect(factorGapsForLoad({ ...GAPPY, revDivision: 'BROKERAGE' })).toEqual([])
    const asset = factorGapsForLoad({ ...GAPPY, revDivision: 'ASSETS' }).map((g) => g.code)
    expect(asset).toEqual(expect.arrayContaining(['PO_MISSING', 'RATE_MISSING', 'CUSTOMER_MC']))
  })

  it("a FACTOR customer's waivers apply on a brokered load (manual rules), never on a factored one", () => {
    const waiving = { ...FACTOR, reviewRequirements: ['revDivision', 'salesRep'] }
    expect(customerDocsNotRequired(waiving, null, 'BROKERAGE')).toEqual(['POD', 'RATE_CON'])
    expect(customerDocsNotRequired(waiving, null, 'ASSETS')).toEqual([])
    expect(customerApEmailRequired(waiving, null, 'BROKERAGE')).toBe(false)
    expect(customerApEmailRequired(waiving, null, 'ASSETS')).toBe(true)
  })
})

describe('invoicing a brokered load for a FACTOR customer', () => {
  const settings = { factorRemitTo: { name: 'OTR Capital', address: null, email: 'pay@otr.test', noticeText: 'Pay OTR' } }
  const division = { name: 'BCAT Logistics', legalName: 'BCAT Corp', remitToName: 'BCAT Corp', remitToAddress: null, remitToEmail: 'ar@bcat.test' }
  const base = {
    invoice: {
      number: 'INV-1', orderId: 'ord-1', invoiceDate: '2026-11-16', dueAt: '2026-12-16', termsDays: 30, shipmentNumber: '20015',
      customerName: 'Cowtown', lines: [], references: [], subtotalCents: 100000, totalCents: 100000,
    },
    customer: { name: 'Cowtown', factored: null, billingMethod: 'FACTOR', billingAddress: null, billingEmail: 'ap@cowtown.test' },
    division,
    settings,
  }

  it('prints BCAT remit-to and is not factored; the asset load still prints the factor', () => {
    const brokered = invoiceData({ ...base, bundle: { shipment: { number: '20015', revDivision: 'BROKERAGE' } } } as unknown as Parameters<typeof invoiceData>[0])
    expect(brokered.factored).toBe(false)
    expect(brokered.remitTo.name).toBe('BCAT Corp')
    const asset = invoiceData({ ...base, bundle: { shipment: { number: '14938', revDivision: 'ASSETS' } } } as unknown as Parameters<typeof invoiceData>[0])
    expect(asset.factored).toBe(true)
    expect(asset.remitTo.name).toBe('OTR Capital')
  })

  it('needs no factor remit-to to be ready, while an asset load does', () => {
    const input = {
      order: { id: 'ord-1', arStatus: 'UNBILLED', revenueCents: 100000, references: [] },
      customer: { name: 'Cowtown', factored: null, billingMethod: 'FACTOR', requiredReferences: null },
      settings: { factorRemitTo: null, defaultRequiredReferences: null },
      charges: [], gate: { missing: [] },
    }
    const brokered = invoiceReadiness({ ...input, shipment: { number: '20015', status: 'DELIVERED', revDivision: 'BROKERAGE' } } as unknown as Parameters<typeof invoiceReadiness>[0])
    expect(brokered.reasons.some((r) => /factor remit-to/.test(r))).toBe(false)
    const asset = invoiceReadiness({ ...input, shipment: { number: '14938', status: 'DELIVERED', revDivision: 'ASSETS' } } as unknown as Parameters<typeof invoiceReadiness>[0])
    expect(asset.reasons.some((r) => /factor remit-to/.test(r))).toBe(true)
  })

  it('a generated non-factored invoice is sent manually even for a FACTOR customer', () => {
    const customer = { billingMethod: 'FACTOR' } as CustomerRecord
    expect(isFactoredInvoice({ factored: false } as InvoiceRecord, customer)).toBe(false)
    expect(isFactoredInvoice({ factored: true } as InvoiceRecord, customer)).toBe(true)
    expect(billsThroughOtr({ factored: false, revDivision: 'BROKERAGE' }, customer)).toBe(false)
    expect(billsThroughOtr({ factored: false, revDivision: 'ASSETS' }, customer)).toBe(true)
  })
})
