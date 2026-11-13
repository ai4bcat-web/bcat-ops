import { describe, expect, it } from 'vitest'
import {
  EMPTY_OWED_FILTER, divisionMatches, dueBucketOf, inDueBucket, owedFilterActive, owedFilterCount,
  owedSelectionLabel, partyOptions, readOwedFilter, summarizeOwed, writeOwedFilter,
} from './owedFilters'

const asOf = '2026-11-12'

describe('dueBucketOf', () => {
  it('buckets by calendar days from today', () => {
    expect(dueBucketOf('2026-11-11', asOf)).toBe('past')
    expect(dueBucketOf('2026-11-12', asOf)).toBe('week')
    expect(dueBucketOf('2026-11-19', asOf)).toBe('week')
    expect(dueBucketOf('2026-11-20', asOf)).toBe('month')
    expect(dueBucketOf('2026-12-12', asOf)).toBe('month')
    expect(dueBucketOf('2026-12-13', asOf)).toBe('later')
    expect(dueBucketOf('2026-12-12T00:00:00.000Z', asOf)).toBe('month')
    expect(dueBucketOf(null, asOf)).toBe('none')
    expect(dueBucketOf('', asOf)).toBe('none')
  })

  it('notDue covers every bucket that is not past due or undated', () => {
    expect(inDueBucket('2026-11-15', asOf, 'notDue')).toBe(true)
    expect(inDueBucket('2027-03-01', asOf, 'notDue')).toBe(true)
    expect(inDueBucket('2026-11-01', asOf, 'notDue')).toBe(false)
    expect(inDueBucket(null, asOf, 'notDue')).toBe(false)
    expect(inDueBucket(null, asOf, 'none')).toBe(true)
    expect(inDueBucket('2026-11-01', asOf, null)).toBe(true)
  })
})

describe('summarizeOwed', () => {
  it('totals open balances by bucket and finds the next due date', () => {
    const s = summarizeOwed([
      { dueAt: '2026-11-01', balanceCents: 10_000 },
      { dueAt: '2026-11-14', balanceCents: 20_000 },
      { dueAt: '2026-11-30', balanceCents: 30_000 },
      { dueAt: '2027-01-30', balanceCents: 40_000 },
      { dueAt: null, balanceCents: 5_000 },
      { dueAt: '2026-11-13', balanceCents: 0 },
    ], asOf)
    expect(s.totalCents).toBe(105_000)
    expect(s.count).toBe(5)
    expect(s.buckets.past).toEqual({ cents: 10_000, count: 1 })
    expect(s.buckets.week).toEqual({ cents: 20_000, count: 1 })
    expect(s.buckets.month).toEqual({ cents: 30_000, count: 1 })
    expect(s.buckets.later).toEqual({ cents: 40_000, count: 1 })
    expect(s.buckets.notDue).toEqual({ cents: 90_000, count: 3 })
    expect(s.buckets.none).toEqual({ cents: 5_000, count: 1 })
    expect(s.nextDueAt).toBe('2026-11-14')
  })

  it('has no next due date when everything is late or undated', () => {
    expect(summarizeOwed([{ dueAt: '2026-10-01', balanceCents: 1 }], asOf).nextDueAt).toBeNull()
  })
})

describe('divisionMatches', () => {
  it('a division matches itself and its sub-divisions; a sub-division only itself', () => {
    expect(divisionMatches('ASSETS/LOCAL', ['ASSETS'])).toBe(true)
    expect(divisionMatches('ASSETS', ['ASSETS'])).toBe(true)
    expect(divisionMatches('ASSETSX', ['ASSETS'])).toBe(false)
    expect(divisionMatches('ASSETS/OO', ['ASSETS/LOCAL'])).toBe(false)
    expect(divisionMatches('BROKERAGE', ['ASSETS/LOCAL', 'BROKERAGE'])).toBe(true)
    expect(divisionMatches(null, [])).toBe(true)
    expect(divisionMatches(null, ['BROKERAGE'])).toBe(false)
  })
})

describe('URL round trip', () => {
  it('reads and writes customer, division and due, leaving other params alone', () => {
    const f = { parties: ['cus-1', 'cus-2'], divisions: ['ASSETS/LOCAL'], due: 'past' as const }
    const params = writeOwedFilter(new URLSearchParams('tab=x'), f, 'customer')
    expect(params.get('tab')).toBe('x')
    expect(readOwedFilter(params, 'customer')).toEqual(f)
    const cleared = writeOwedFilter(params, EMPTY_OWED_FILTER, 'customer')
    expect(cleared.toString()).toBe('tab=x')
  })

  it('drops an unknown due bucket', () => {
    expect(readOwedFilter(new URLSearchParams('due=soon'), 'carrier').due).toBeNull()
  })
})

describe('labels and counts', () => {
  it('counts each kind of filter once', () => {
    expect(owedFilterActive(EMPTY_OWED_FILTER)).toBe(false)
    expect(owedFilterCount({ parties: ['a', 'b'], divisions: [], due: 'week' })).toBe(2)
  })

  it('names the selection', () => {
    const name = (k: string) => ({ a: 'Royal Group', b: 'Batory', c: 'ACF' } as Record<string, string>)[k] ?? k
    expect(owedSelectionLabel({ parties: ['a'], divisions: [], due: null }, name, name)).toBe('Owed by Royal Group')
    expect(owedSelectionLabel({ parties: ['a', 'b', 'c'], divisions: ['BROKERAGE'], due: null }, name, (k) => k.toLowerCase()))
      .toBe('Owed by Royal Group + 2 more · brokerage')
  })

  it('lists each party once, by name', () => {
    expect(partyOptions([
      { id: 'b', name: 'Zed' }, { id: 'a', name: 'Acme' }, { id: 'b', name: 'Zed' }, { id: null, name: 'x' },
    ])).toEqual([{ key: 'a', label: 'Acme' }, { key: 'b', label: 'Zed' }])
  })
})
