import { describe, expect, it } from 'vitest'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'
import { fromArPayment, filterReceived, type ReceivedFilter } from './paymentsReceived'
import {
  SEARCH_RESULT_CAP, invoiceSearch, invoiceSearchState, ledgerSearch, looksLikeInvoiceNumber, poMapOf,
} from './search'

const names = (id: string) => ({ c1: 'AUTO SHIPPER', c2: 'BATORY FOODS' } as Record<string, string>)[id] ?? ''

const pay = (over: Partial<ArPaymentRecord>): ArPaymentRecord => ({
  id: 'p1', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-04-30T12:00:00.000Z', method: 'CARD', reference: 'SQUARE043026',
  amountCents: 148_900, appliedCents: 148_900, unappliedCents: 0, applications: [{ invoiceId: '13365', amountCents: 148_900 }],
  createdBy: 'ryne@bcatcorp.com', ...over,
})

const inv = (id: string, over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id, number: id, customerId: 'c1', status: 'PAID', invoiceDate: '2026-11-27', totalCents: 148_900, paidCents: 148_900, balanceCents: 0,
  shipmentNumber: id.split('-')[0], references: [], ...over,
} as unknown as InvoiceRecord)

describe('payments received search', () => {
  const rows = [
    fromArPayment(pay({}), names),
    fromArPayment(pay({ id: 'p2', customerId: 'c2', reference: '555', receivedAt: '2026-11-20T12:00:00.000Z', applications: [{ invoiceId: '14000-2', amountCents: 100 }], amountCents: 100, appliedCents: 100 }), names),
  ]
  const noPo = new Map<string, string>()

  it('finds an April payment by invoice number although the default range is this month', () => {
    const THIS_MONTH: ReceivedFilter = { from: '2026-11-01', to: '2026-11-30', customers: [], types: [], methods: [], divisions: [], unappliedOnly: false }
    expect(filterReceived(rows, THIS_MONTH, () => []).map((r) => r.id)).not.toContain('p1')
    // The page lifts the date range while a term is typed, then narrows by the term.
    const lifted = filterReceived(rows, { ...THIS_MONTH, from: '', to: '' }, () => [])
    expect(ledgerSearch(lifted, '13365', noPo).map((r) => r.id)).toEqual(['p1'])
  })

  it('matches by PRO of a suffixed invoice, by reference, by customer name and by PO', () => {
    expect(ledgerSearch(rows, '14000', noPo).map((r) => r.id)).toEqual(['p2'])
    expect(ledgerSearch(rows, 'square0430', noPo).map((r) => r.id)).toEqual(['p1'])
    expect(ledgerSearch(rows, 'batory', noPo).map((r) => r.id)).toEqual(['p2'])
    const withPo = poMapOf([inv('13365', { references: [{ code: 'PO', value: 'PO-77' }] } as Partial<InvoiceRecord>)])
    expect(ledgerSearch(rows, 'po-77', withPo).map((r) => r.id)).toEqual(['p1'])
  })

  it('an empty term keeps every row', () => {
    expect(ledgerSearch(rows, '  ', noPo)).toHaveLength(2)
  })
})

describe('invoice search', () => {
  const cust = (id: string) => (id === 'c1' ? 'AUTO SHIPPER' : 'BATORY FOODS')

  it('finds a paid invoice outside every window, an open one and a void one, once each', () => {
    const open = [inv('14100', { status: 'ISSUED', paidCents: 0, balanceCents: 5_000, customerId: 'c2' })]
    const recent = [inv('13365'), inv('14100', { status: 'ISSUED' })]
    const looked = [inv('13365'), inv('13366', { status: 'VOID', balanceCents: 0 })]
    const { rows, total } = invoiceSearch([open, recent, looked], '133', cust)
    expect(rows.map((r) => r.id).sort()).toEqual(['13365', '13366'])
    expect(total).toBe(2)
    expect(invoiceSearchState(rows.find((r) => r.id === '13366')!)).toBe('Void')
    expect(invoiceSearchState(rows.find((r) => r.id === '13365')!)).toBe('Paid')
  })

  it('narrows to the picked customer and matches the customer name', () => {
    const all = [inv('1', { customerId: 'c1' }), inv('2', { customerId: 'c2' })]
    expect(invoiceSearch([all], 'batory', cust).rows.map((r) => r.id)).toEqual(['2'])
    expect(invoiceSearch([all], 'a', cust, { customerId: 'c1' }).rows.map((r) => r.id)).toEqual(['1'])
  })

  it('caps the list and reports the full count', () => {
    const many = Array.from({ length: SEARCH_RESULT_CAP + 5 }, (_, i) => inv(String(20000 + i)))
    const r = invoiceSearch([many], '2000', cust)
    expect(r.rows.length).toBeLessThanOrEqual(SEARCH_RESULT_CAP)
    expect(r.total).toBeGreaterThanOrEqual(r.rows.length)
  })

  it('names the states', () => {
    expect(invoiceSearchState({ status: 'ISSUED' })).toBe('Open')
    expect(invoiceSearchState({ status: 'PARTIAL' })).toBe('Partly paid')
  })
})

describe('looksLikeInvoiceNumber', () => {
  it('accepts numbers and suffixed numbers, not names or short terms', () => {
    expect(looksLikeInvoiceNumber('13365')).toBe(true)
    expect(looksLikeInvoiceNumber('13365-2')).toBe(true)
    expect(looksLikeInvoiceNumber('ab')).toBe(false)
    expect(looksLikeInvoiceNumber('auto shipper')).toBe(false)
  })
})
