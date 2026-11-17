import { describe, it, expect } from 'vitest'
import { canChangeMethod, currentInvoiceMethod, isMethodPinned, methodChangeBlocker, methodForLoad } from './invoiceMethod'

const draft = { status: 'ISSUED', factored: true, factoringItemId: '14916', sentCount: 0, paidCents: 0, writtenOffCents: 0 }

describe('invoice method', () => {
  it('reads the method off the invoice: factored flag or a pointer to a queue row', () => {
    expect(currentInvoiceMethod({ factored: true })).toBe('FACTOR')
    expect(currentInvoiceMethod({ factored: false, factoringItemId: '14916' })).toBe('FACTOR')
    expect(currentInvoiceMethod({ factored: false, factoringItemId: null })).toBe('MANUAL')
    expect(currentInvoiceMethod({})).toBe('MANUAL')
  })

  it('reads what the profile wants: factor-billed customers factor, except brokered loads', () => {
    expect(methodForLoad({ billingMethod: 'FACTOR' }, 'ASSETS')).toBe('FACTOR')
    expect(methodForLoad({ billingMethod: 'MANUAL', factored: true }, 'ASSETS')).toBe('MANUAL')
    expect(methodForLoad({ billingMethod: 'FACTOR' }, 'BROKERAGE')).toBe('MANUAL')
    expect(methodForLoad(null, 'ASSETS')).toBe('MANUAL')
  })

  it('lets an unsent, unpaid draft change, with or without a queue row not yet with OTR', () => {
    expect(methodChangeBlocker(draft, { status: 'NEED_TO_FACTOR' })).toBeNull()
    expect(methodChangeBlocker(draft, { status: 'ARCHIVED' })).toBeNull()
    expect(methodChangeBlocker({ ...draft, factoringItemId: null, factored: false }, null)).toBeNull()
    expect(canChangeMethod(draft, { status: 'NEED_TO_FACTOR' })).toBe(true)
  })

  it('refuses once the bill has left the building', () => {
    expect(methodChangeBlocker({ ...draft, sentAt: '2026-11-16T10:00:00Z' }, null)).toMatch(/already gone to the customer/)
    expect(methodChangeBlocker({ ...draft, markedSentAt: '2026-10-01T12:00:00Z' }, null)).toMatch(/already gone to the customer/)
    expect(methodChangeBlocker({ ...draft, sentCount: 2 }, null)).toMatch(/already gone/)
    expect(methodChangeBlocker({ ...draft, paidCents: 100 }, null)).toMatch(/Money/)
    expect(methodChangeBlocker({ ...draft, status: 'PAID' }, null)).toMatch(/paid/)
    expect(methodChangeBlocker({ ...draft, status: 'VOID' }, null)).toMatch(/void/)
    expect(methodChangeBlocker(draft, { status: 'PENDING_WITH_OTR', otrInvoiceId: '26170636' })).toMatch(/OTR/)
    expect(methodChangeBlocker(draft, { status: 'FACTORED' })).toMatch(/OTR/)
  })

  it('knows a method somebody chose for one invoice', () => {
    expect(isMethodPinned({ manualReason: 'PIN_MANUAL' })).toBe(true)
    expect(isMethodPinned({ manualReason: 'PIN_FACTOR' })).toBe(true)
    expect(isMethodPinned({ manualReason: 'CUSTOMER_METHOD' })).toBe(false)
    expect(isMethodPinned({ manualReason: 'NO_BUY' })).toBe(false)
    expect(isMethodPinned(null)).toBe(false)
  })
})
