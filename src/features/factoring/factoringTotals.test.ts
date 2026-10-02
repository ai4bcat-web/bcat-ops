/**
 * The queue could tell you how many invoices were waiting and not what they were worth,
 * which is the figure anyone actually plans around.
 *
 * The rule that matters most here is the one about rows with no rate: they are counted,
 * never priced at zero. A total that silently swallows what it could not price reads as
 * complete and is not.
 */
import { describe, it, expect } from 'vitest'
import { invoiceAmountOf, totalsByStatus, money } from './factoringTotals'
import type { FactoringItem, FactoringItemStatus } from '@/types'

function item(
  status: FactoringItemStatus,
  amount?: number | string | null,
  over: Partial<FactoringItem> = {},
): FactoringItem {
  return {
    id: 'x', proNumber: 'x', status,
    subject: '', fromEmail: '', receivedAt: '2026-10-02T00:00:00Z', messageId: 'm',
    otrReadiness:
      amount === undefined
        ? null
        : { ready: false, payload: amount === null ? {} : { InvoiceAmount: amount }, sources: {}, missingFields: [], missingDocuments: [], warnings: [] },
    ...over,
  } as unknown as FactoringItem
}

describe('invoiceAmountOf', () => {
  it('reads the amount the invoice would actually be submitted with', () => {
    expect(invoiceAmountOf(item('NEED_TO_FACTOR', 800))).toBe(800)
  })

  it('accepts an amount that resolved as a string', () => {
    expect(invoiceAmountOf(item('NEED_TO_FACTOR', '1,850.50'))).toBe(1850.5)
  })

  it('is null for a row nobody has prepared', () => {
    expect(invoiceAmountOf(item('NEED_TO_FACTOR'))).toBeNull()
  })

  it('is null when the row is prepared but the rate never resolved', () => {
    expect(invoiceAmountOf(item('NEED_TO_FACTOR', null))).toBeNull()
  })

  it('is null rather than zero for a value that is not a number', () => {
    // Zero would quietly join the total as a real invoice worth nothing.
    expect(invoiceAmountOf(item('NEED_TO_FACTOR', 'TBD'))).toBeNull()
  })
})

describe('totalsByStatus', () => {
  const rows = [
    item('NEED_TO_FACTOR', 800),
    item('NEED_TO_FACTOR', 1200),
    item('NEED_TO_FACTOR'),            // no rate yet
    item('PENDING_WITH_OTR', 2500),
    item('FACTORED', 1000),
  ]

  it('sums each status separately', () => {
    const t = totalsByStatus(rows)
    expect(t.NEED_TO_FACTOR.total).toBe(2000)
    expect(t.PENDING_WITH_OTR.total).toBe(2500)
    expect(t.FACTORED.total).toBe(1000)
  })

  it('rolls everything into ALL', () => {
    const t = totalsByStatus(rows)
    expect(t.ALL.total).toBe(5500)
    expect(t.ALL.count).toBe(5)
  })

  it('counts a row with no rate without pricing it at zero', () => {
    const t = totalsByStatus(rows)
    expect(t.NEED_TO_FACTOR.count).toBe(3)
    expect(t.NEED_TO_FACTOR.missingRate).toBe(1)
    // 2000, not 2000-and-a-silent-gap.
    expect(t.NEED_TO_FACTOR.total).toBe(2000)
  })

  it('reports zeros for a status with nothing in it', () => {
    const t = totalsByStatus([item('FACTORED', 10)])
    expect(t.NEED_TO_FACTOR).toEqual({ count: 0, total: 0, missingRate: 0 })
  })

  it('handles an empty queue', () => {
    const t = totalsByStatus([])
    expect(t.ALL).toEqual({ count: 0, total: 0, missingRate: 0 })
  })
})

describe('money', () => {
  it('shows cents, because this is a figure someone reconciles', () => {
    expect(money(12480)).toBe('$12,480.00')
    expect(money(1850.5)).toBe('$1,850.50')
    expect(money(0)).toBe('$0.00')
  })
})
