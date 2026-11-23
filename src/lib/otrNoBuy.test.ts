import { describe, expect, it } from 'vitest'
import { noBuyColumnText, noBuySummary, otrNoBuyByCustomer } from './otrNoBuy'
import type { FactoringItem } from '@/types'

const item = (over: Partial<FactoringItem>): FactoringItem => ({
  id: 'p', proNumber: '14000', status: 'ARCHIVED', subject: '', fromEmail: '', receivedAt: '', messageId: '',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', ...over,
})

describe('otrNoBuyByCustomer', () => {
  it('flags a customer whose row carried a broker-check No buy, even after the row was archived', () => {
    const map = otrNoBuyByCustomer([item({ customerId: 'c1', brokerCheckResult: 'NO_BUY', brokerCheckedAt: '2026-11-05T10:00:00Z', status: 'ARCHIVED' })])
    expect(map.get('c1')).toEqual([{ pro: '14000', at: '2026-11-05T10:00:00Z', reason: 'OTR will not buy this invoice' }])
  })

  it('flags a manual No buy and uses the typed OTR reason', () => {
    const map = otrNoBuyByCustomer([item({ customerId: 'c2', manualReason: 'NO_BUY', otrError: 'Debtor not approved', manualInvoicedAt: '2026-11-07' })])
    expect(map.get('c2')?.[0]).toMatchObject({ reason: 'Debtor not approved', at: '2026-11-07' })
  })

  it('does not flag approved, manual-by-choice or plain rows', () => {
    const map = otrNoBuyByCustomer([
      item({ customerId: 'c3', brokerCheckResult: 'APPROVED' }),
      item({ customerId: 'c4', manualReason: 'MANUAL' }),
      item({ customerId: 'c5' }),
    ])
    expect(map.size).toBe(0)
  })

  it('finds the customer through the invoice when the row names none, and skips rows with no customer at all', () => {
    const rows = [item({ id: 'a', invoiceId: 'i1', manualReason: 'NO_BUY' }), item({ id: 'b', manualReason: 'NO_BUY' })]
    const map = otrNoBuyByCustomer(rows, (id) => (id === 'i1' ? 'c6' : null))
    expect([...map.keys()]).toEqual(['c6'])
  })

  it('lists several no-buys newest first', () => {
    const map = otrNoBuyByCustomer([
      item({ id: 'o', proNumber: '1', customerId: 'c7', manualReason: 'NO_BUY', manualInvoicedAt: '2026-10-01' }),
      item({ id: 'n', proNumber: '2', customerId: 'c7', manualReason: 'NO_BUY', manualInvoicedAt: '2026-11-01' }),
    ])
    expect(map.get('c7')?.map((e) => e.pro)).toEqual(['2', '1'])
    expect(noBuySummary(map.get('c7')!, (d) => d)).toBe('OTR has said No buy on PRO 2 (2026-11-01) and 1 more.')
  })

  it('column text is empty for an unflagged customer', () => {
    expect(noBuyColumnText(undefined)).toBe('')
    expect(noBuyColumnText([{ pro: '1', at: null, reason: 'x' }])).toBe('No buy')
  })
})
