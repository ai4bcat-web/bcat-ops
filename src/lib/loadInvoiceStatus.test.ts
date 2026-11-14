import { describe, expect, it } from 'vitest'
import { loadInvoiceStatusOf, loadInvoiceStatusText } from './loadInvoiceStatus'

const inv = (over: Partial<Parameters<typeof loadInvoiceStatusOf>[1] & object> = {}) => ({
  status: 'ISSUED' as const, paidCents: 0, balanceCents: 100_00, ...over,
})

describe('loadInvoiceStatusOf', () => {
  it('reads Not invoiced before the release and Ready to invoice after it', () => {
    expect(loadInvoiceStatusOf(null).key).toBe('NOT_INVOICED')
    expect(loadInvoiceStatusOf({ arStatus: 'DOCS_NEEDED' }).key).toBe('NOT_INVOICED')
    expect(loadInvoiceStatusOf({ arStatus: 'UNBILLED', readyToInvoiceAt: '2026-11-10' }).key).toBe('READY')
  })

  it('treats an unsent, unpaid invoice as the AR draft in Ready to invoice', () => {
    expect(loadInvoiceStatusOf({ arStatus: 'UNPAID', invoiceId: 'i1' }, inv()).key).toBe('READY')
  })

  it('reads Outstanding once sent, Partially paid with a balance left, Paid at zero', () => {
    expect(loadInvoiceStatusOf({ arStatus: 'UNPAID', invoiceId: 'i1' }, inv({ sentAt: '2026-11-11' })).key).toBe('OUTSTANDING')
    expect(loadInvoiceStatusOf({ arStatus: 'UNPAID', invoiceId: 'i1' }, inv({ markedSentAt: '2026-11-11', paidCents: 40_00, balanceCents: 60_00, status: 'PARTIAL' })).key).toBe('PARTIAL')
    const paid = loadInvoiceStatusOf({ arStatus: 'PAID', invoiceId: 'i1' }, inv({ status: 'PAID', paidCents: 100_00, balanceCents: 0, paidAt: '2026-11-12T15:00:00Z' }))
    expect(paid.key).toBe('PAID')
    expect(loadInvoiceStatusText(paid, () => 'Nov 12, 2026')).toBe('Paid Nov 12, 2026')
  })

  it('falls back to the order cache without the invoice row', () => {
    expect(loadInvoiceStatusOf({ arStatus: 'UNPAID', invoiceId: 'i1' }).key).toBe('OUTSTANDING')
    expect(loadInvoiceStatusOf({ arStatus: 'PAID', paidAt: '2026-11-01' }).paidAt).toBe('2026-11-01')
  })

  it('reads the OTR queue: pending, funded and rejected', () => {
    const order = { arStatus: 'UNPAID' as const, invoiceId: 'i1', factoringItemId: 'f1' }
    expect(loadInvoiceStatusOf(order, inv(), { status: 'PENDING_WITH_OTR', otrInvoiceId: 'o1' }).key).toBe('FACTORING_PENDING')
    expect(loadInvoiceStatusOf(order, inv(), { status: 'FACTORED' }).key).toBe('FACTORED')
    const rejected = loadInvoiceStatusOf(order, inv(), { status: 'PENDING_WITH_OTR', manualReason: 'NO_BUY', otrError: 'Broker on no-buy list' })
    expect(rejected.key).toBe('OTR_REJECTED')
    expect(rejected.reason).toContain('no-buy')
  })

  it('a paid invoice wins over a stale OTR row, and a void invoice is ignored', () => {
    expect(loadInvoiceStatusOf({ arStatus: 'PAID' }, inv({ status: 'PAID', balanceCents: 0, paidCents: 100_00 }), { status: 'PENDING_WITH_OTR' }).key).toBe('PAID')
    expect(loadInvoiceStatusOf({ arStatus: 'UNBILLED' }, inv({ status: 'VOID' })).key).toBe('READY')
  })

  it('keeps the two flat AR states', () => {
    expect(loadInvoiceStatusOf({ arStatus: 'INVOICE_NOT_NEEDED' }).key).toBe('NO_INVOICE')
    expect(loadInvoiceStatusOf({ arStatus: 'LEGACY' }).key).toBe('LEGACY')
  })
})
