import { describe, it, expect } from 'vitest'
import { invoiceCustomerChangeRefusal, planInvoiceCustomerChange, retargetSearchKey, targetCustomerRefusal } from './invoiceCustomerChange'

const invoice = {
  id: '14937', number: '14937', status: 'ISSUED', customerId: 'old', customerName: 'Old Co', billToId: null,
  invoiceDate: '2026-11-10', paidCents: 0, writtenOffCents: 0, factoringItemId: null, sentAt: '2026-11-10T12:00:00Z',
  markedSentAt: null, sentCount: 1, termsDays: 30, dueAt: '2026-12-10', factored: false, revision: 1,
} as const
const settings = { defaultPaymentTermsDays: 30, factorRemitTo: { name: 'OTR Capital', address: null, email: null, noticeText: null }, invoiceTerms: null }
const division = { name: 'BCAT Logistics', legalName: null, remitToName: 'BCAT Logistics LLC', remitToAddress: null, remitToEmail: null }

describe('invoiceCustomerChange', () => {
  it('recomputes terms and due date from the invoice date and the new customer', () => {
    const plan = planInvoiceCustomerChange({ invoice, target: { id: 'new', name: 'New Co', billingMethod: 'MANUAL', paymentTermsDays: 120 } as never, billToId: null, revDivision: 'ASSETS', division, settings: settings as never, factoringRow: null })
    expect(plan.termsDays).toBe(120)
    expect(plan.dueAt).toBe('2027-03-10')
    expect(plan.termsText).toBe('Net 120')
    expect(plan.revision).toBe(2)
    expect(plan.remitTo.name).toBe('BCAT Logistics LLC')
    expect(plan.factoring).toBe('NONE')
  })

  it('a factored customer on an asset load remits to the factor; on a brokered load to BCAT', () => {
    const target = { id: 'new', name: 'New Co', billingMethod: 'FACTOR', paymentTermsDays: 30 } as never
    const assets = planInvoiceCustomerChange({ invoice, target, billToId: null, revDivision: 'ASSETS', division, settings: settings as never, factoringRow: null })
    expect(assets.factored).toBe(true)
    expect(assets.remitTo.name).toBe('OTR Capital')
    expect(assets.factoring).toBe('FACTOR_NEXT')
    const brokered = planInvoiceCustomerChange({ invoice, target, billToId: null, revDivision: 'BROKERAGE', division, settings: settings as never, factoringRow: null })
    expect(brokered.factored).toBe(false)
    expect(brokered.remitTo.name).toBe('BCAT Logistics LLC')
  })

  it('uses a chosen bill-to party and its terms', () => {
    const target = { id: 'new', name: 'New Co', billingMethod: 'MANUAL', paymentTermsDays: 30, billToParties: [{ id: 'b1', name: 'New Co AP', email: 'ap@new.co', paymentTermsDays: 45 }] } as never
    const plan = planInvoiceCustomerChange({ invoice, target, billToId: 'b1', revDivision: 'ASSETS', division, settings: settings as never, factoringRow: null })
    expect(plan.billTo.name).toBe('New Co AP')
    expect(plan.billToId).toBe('b1')
    expect(plan.termsDays).toBe(45)
  })

  it('refusals', () => {
    expect(invoiceCustomerChangeRefusal({ ...invoice, status: 'VOID' }, null)).toMatch(/void/)
    expect(invoiceCustomerChangeRefusal({ ...invoice, paidCents: 1 }, null)).toMatch(/Money/)
    expect(invoiceCustomerChangeRefusal(invoice, { id: 'f', status: 'NEED_TO_FACTOR', otrInvoiceId: '26152964' })).toMatch(/OTR/)
    expect(invoiceCustomerChangeRefusal(invoice, { id: 'f', status: 'FACTORED' })).toMatch(/OTR/)
    expect(invoiceCustomerChangeRefusal({ ...invoice, markedSentNote: 'Carried over from Aljex (cutoff)' }, null)).toMatch(/Aljex/)
    expect(invoiceCustomerChangeRefusal(invoice, { id: 'f', status: 'NEED_TO_FACTOR' })).toBeNull()
    expect(targetCustomerRefusal(invoice, { id: 'old', name: 'Old Co' } as never, null)).toMatch(/already billed/)
    expect(targetCustomerRefusal(invoice, { id: 'x', name: 'X', mergedIntoId: 'y' } as never, null)).toMatch(/merged/)
    expect(targetCustomerRefusal(invoice, null, null)).toMatch(/not found/)
  })

  it('swaps the customer name in the search key', () => {
    expect(retargetSearchKey('14937 cowtown express chicago', 'COWTOWN EXPRESS', 'Acme Co')).toBe('14937 acme co chicago')
    expect(retargetSearchKey('14937 chicago', null, 'Acme Co')).toBe('14937 chicago acme co')
  })
})
