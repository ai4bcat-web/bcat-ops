import { describe, it, expect } from 'vitest'

import { billedPaperworkRefusal, invoiceHasGoneOut } from './documents'

const pod = { id: 'd1', type: 'POD' }
const rc = { id: 'd2', type: 'RATE_CON' }
const bol = { id: 'd3', type: 'BOL' }

describe('billedPaperworkRefusal', () => {
  it('a POD or rate con on an invoiced load cannot be removed or retyped', () => {
    for (const orders of [[{ invoiceId: 'inv1' }], [{ arStatus: 'UNPAID' }], [{ arStatus: 'PAID' }]]) {
      expect(billedPaperworkRefusal({ orders }, pod)).toMatch(/already invoiced/)
      expect(billedPaperworkRefusal({ orders }, rc)).toMatch(/already invoiced/)
    }
  })

  it('before invoicing, and for other paperwork, nothing is refused', () => {
    expect(billedPaperworkRefusal({ orders: [{ arStatus: 'DOCS_NEEDED' }] }, pod)).toBeNull()
    expect(billedPaperworkRefusal({ orders: [{ arStatus: 'UNBILLED' }] }, rc)).toBeNull()
    expect(billedPaperworkRefusal({ orders: [{ invoiceId: 'inv1' }] }, bol)).toBeNull()
  })
})

describe('invoiceHasGoneOut (a draft invoice may still have its POD and rate con fixed from Ready to Invoice)', () => {
  const draft = { status: 'ISSUED', sentCount: 0, paidCents: 0 }

  it('an unsent, unpaid, unfactored invoice is a draft, also with a queue row still waiting for OTR', () => {
    expect(invoiceHasGoneOut(draft, null)).toBe(false)
    expect(invoiceHasGoneOut(draft, { status: 'NEED_TO_FACTOR' })).toBe(false)
    expect(invoiceHasGoneOut(draft, { status: 'MANUAL_INVOICE' })).toBe(false)
    expect(invoiceHasGoneOut(null, null)).toBe(false)
  })

  it('an e-mailed, marked-sent, paid, partly paid or OTR-held invoice has gone out', () => {
    expect(invoiceHasGoneOut({ ...draft, sentAt: '2026-11-16T10:00:00Z' }, null)).toBe(true)
    expect(invoiceHasGoneOut({ ...draft, markedSentAt: '2026-10-01T12:00:00Z' }, null)).toBe(true)
    expect(invoiceHasGoneOut({ ...draft, sentCount: 2 }, null)).toBe(true)
    expect(invoiceHasGoneOut({ ...draft, paidCents: 5000 }, null)).toBe(true)
    expect(invoiceHasGoneOut({ ...draft, status: 'PARTIAL' }, null)).toBe(true)
    expect(invoiceHasGoneOut({ ...draft, status: 'PAID' }, null)).toBe(true)
    expect(invoiceHasGoneOut({ ...draft, otrInvoiceId: '26170636' }, null)).toBe(true)
    expect(invoiceHasGoneOut(draft, { status: 'PENDING_WITH_OTR' })).toBe(true)
    expect(invoiceHasGoneOut(draft, { status: 'FACTORED' })).toBe(true)
  })
})
