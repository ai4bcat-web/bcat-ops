/**
 * The card exists to be trusted about an amount, so the cases that matter are the ones
 * where a total could quietly be wrong.
 */
import { describe, it, expect } from 'vitest'
import { factoringTotals, itemAmount } from './factoringTotals'
import type { FactoringItem, Load } from '../types'

const item = (over: Partial<FactoringItem>): Pick<FactoringItem, 'status' | 'otrAmount' | 'loadId'> =>
  ({ status: 'NEED_TO_FACTOR', ...over }) as FactoringItem

const load = (id: string, rate: number | null): Pick<Load, 'id' | 'rate'> => ({ id, rate } as Load)

describe('itemAmount — which figure to believe', () => {
  it('values an unsubmitted row off the load, because nothing has been sent yet', () => {
    const rates = new Map([['l1', 104500]])
    expect(itemAmount(item({ loadId: 'l1' }), rates)).toBe(104500)
  })

  it('prefers OTR’s figure once submitted, even when the load also has a rate', () => {
    // A load edited after submission does not change what was invoiced.
    const rates = new Map([['l1', 999900]])
    expect(itemAmount(item({ status: 'PENDING_WITH_OTR', otrAmount: 61780, loadId: 'l1' }), rates)).toBe(61780)
  })

  it('says it cannot value a row rather than calling it zero', () => {
    expect(itemAmount(item({ loadId: 'missing' }), new Map())).toBeNull()
    expect(itemAmount(item({}), new Map())).toBeNull()
  })

  it('treats a zero or negative figure as no figure', () => {
    expect(itemAmount(item({ status: 'FACTORED', otrAmount: 0, loadId: 'l1' }), new Map([['l1', 0]]))).toBeNull()
  })
})

describe('factoringTotals', () => {
  const loads = [load('a', 100000), load('b', 50000), load('c', 25000)]

  it('totals each bucket separately', () => {
    const t = factoringTotals([
      item({ status: 'NEED_TO_FACTOR', loadId: 'a' }),
      item({ status: 'NEED_TO_FACTOR', loadId: 'b' }),
      item({ status: 'PENDING_WITH_OTR', otrAmount: 61780, loadId: 'c' }),
      item({ status: 'FACTORED', otrAmount: 92150 }),
    ], loads)

    expect(t.needToFactor).toEqual({ count: 2, amount: 150000, unvalued: 0 })
    expect(t.pendingWithOtr).toEqual({ count: 1, amount: 61780, unvalued: 0 })
    expect(t.factored).toEqual({ count: 1, amount: 92150, unvalued: 0 })
  })

  it('counts what it could not value instead of hiding it in the total', () => {
    // A total that quietly omits rows reads as money that does not exist.
    const t = factoringTotals([
      item({ status: 'NEED_TO_FACTOR', loadId: 'a' }),
      item({ status: 'NEED_TO_FACTOR', loadId: 'nope' }),
    ], loads)
    expect(t.needToFactor.count).toBe(2)
    expect(t.needToFactor.amount).toBe(100000)
    expect(t.needToFactor.unvalued).toBe(1)
  })

  it('counts outstanding as what is still owed — waiting plus sent-and-unpaid', () => {
    const t = factoringTotals([
      item({ status: 'NEED_TO_FACTOR', loadId: 'a' }),
      item({ status: 'PENDING_WITH_OTR', otrAmount: 61780 }),
      item({ status: 'FACTORED', otrAmount: 92150 }),
    ], loads)
    // Factored is paid; it is not outstanding.
    expect(t.outstandingAmount).toBe(100000 + 61780)
    expect(t.outstandingCount).toBe(2)
  })

  it('leaves ARCHIVED out of the money entirely', () => {
    const t = factoringTotals([
      item({ status: 'ARCHIVED', otrAmount: 500000 }),
      item({ status: 'NEED_TO_FACTOR', loadId: 'b' }),
    ], loads)
    expect(t.outstandingAmount).toBe(50000)
    expect(t.needToFactor.count).toBe(1)
  })

  it('returns zeroes rather than NaN for an empty queue', () => {
    const t = factoringTotals([], [])
    expect(t.outstandingAmount).toBe(0)
    expect(t.needToFactor).toEqual({ count: 0, amount: 0, unvalued: 0 })
  })
})
