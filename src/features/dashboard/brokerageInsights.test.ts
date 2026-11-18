import { describe, it, expect } from 'vitest'
import type { Measures, MonthMeasures, RepMonthRow } from '@/lib/brokerageRevenue'
import { brokerageInsights } from './brokerageInsights'

const m = (month: string, loads: number, rev: number, exp: number): MonthMeasures => ({
  month, loads, revenueCents: rev, expenseCents: exp, profitCents: rev - exp, marginBps: rev > 0 ? Math.round(((rev - exp) / rev) * 10000) : null,
})
const rep = (key: string, label: string, profit: number): RepMonthRow => {
  const total: Measures = { loads: 1, revenueCents: profit * 2, expenseCents: profit, profitCents: profit, marginBps: 5000 }
  return { repKey: key, label, byMonth: [total], total }
}

describe('brokerageInsights', () => {
  it('compares the last finished month with the one before, and reports the month in progress and the top rep', () => {
    const rows = [m('2026-09', 5, 500_000, 400_000), m('2026-10', 8, 900_000, 700_000), m('2026-11', 2, 200_000, 150_000)]
    const reps = [rep('a', 'Ryne B', 300_000), rep('b', 'Ivan Cartage', 100_000)]
    const grand = rows.reduce<Measures>((s, r) => ({ loads: s.loads + r.loads, revenueCents: s.revenueCents + r.revenueCents, expenseCents: s.expenseCents + r.expenseCents, profitCents: s.profitCents + r.profitCents, marginBps: null }), { loads: 0, revenueCents: 0, expenseCents: 0, profitCents: 0, marginBps: null })
    const out = brokerageInsights(rows, reps, { ...grand, profitCents: 400_000 }, '2026-11')
    const text = out.map((i) => i.text)
    expect(text[0]).toBe('Oct profit was $2.0k, up 100% from Sep.')
    expect(text.some((t) => t.startsWith('Nov so far: $500 profit on 2 loads'))).toBe(true)
    expect(text.some((t) => t.includes('Ryne B brings in 75% of profit'))).toBe(true)
    expect(out.length).toBeLessThanOrEqual(4)
  })

  it('says nothing it cannot back up when there is only one finished month', () => {
    const rows = [m('2026-10', 3, 300_000, 200_000)]
    const out = brokerageInsights(rows, [], { loads: 3, revenueCents: 300_000, expenseCents: 200_000, profitCents: 100_000, marginBps: 3333 }, '2026-11')
    expect(out).toEqual([])
  })
})

describe('the month so far is read against the same days of last month', () => {
  const m = (month: string, loads: number, profitCents: number): MonthMeasures => ({ month, loads, revenueCents: profitCents * 4, expenseCents: profitCents * 3, profitCents, marginBps: 2500 })
  const rows = [m('2026-09', 10, 3_000_000), m('2026-10', 12, 4_400_000), m('2026-11', 6, 157_000)]
  const grand = { loads: 6, revenueCents: 628_000, expenseCents: 471_000, profitCents: 157_000, marginBps: 2500 }

  it('uses "Oct 1–18 was …" when the day rows are known', () => {
    const out = brokerageInsights(rows, [], grand, '2026-11', { month: '2026-10', through: 18, measures: { loads: 7, revenueCents: 2_000_000, expenseCents: 1_500_000, profitCents: 500_000, marginBps: 2500 } })
    expect(out.find((i) => i.key === 'pace')?.text).toBe('Nov so far: $1.57k profit on 6 loads. Oct 1–18 was $5.0k.')
  })

  it('falls back to last month in full without them (a rep sees month totals only)', () => {
    const out = brokerageInsights(rows, [], grand, '2026-11', null)
    expect(out.find((i) => i.key === 'pace')?.text).toBe('Nov so far: $1.57k profit on 6 loads. Oct finished at $44.0k.')
  })
})
