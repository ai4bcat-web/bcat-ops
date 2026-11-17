// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Sparkline, type TrendPoint } from './Sparkline'
import { legacyTrendFrom } from './useLegacyTrend'
import { ROLLUP_SCHEMA_VERSION } from '@/lib/dashboardRollup'

const pts = (partialLast: boolean): TrendPoint[] => [
  { month: '2026-09', label: 'Sep 26', value: 100 },
  { month: '2026-10', label: 'Oct 26', value: 140 },
  { month: '2026-11', label: 'Nov 26', value: 20, partial: partialLast },
]

describe('Sparkline', () => {
  it('draws the month in progress dashed so a half month is not read as a drop', () => {
    render(<Sparkline points={pts(true)} label="Loads" format={(v) => `${v} loads`} />)
    expect(screen.getByTestId('kpi-sparkline-partial')).toBeInTheDocument()
    expect(screen.getByTestId('kpi-sparkline')).toHaveTextContent('Nov 26 · so far')
    expect(screen.getByRole('img')).toHaveAccessibleName(/Nov 26 20 loads \(to date\)/)
  })
  it('has no dashed segment when every month is finished, and nothing with fewer than two months', () => {
    const { rerender } = render(<Sparkline points={pts(false)} label="Loads" format={String} />)
    expect(screen.queryByTestId('kpi-sparkline-partial')).not.toBeInTheDocument()
    rerender(<Sparkline points={pts(false).slice(0, 1)} label="Loads" format={String} />)
    expect(screen.queryByTestId('kpi-sparkline')).not.toBeInTheDocument()
  })
})

describe('legacyTrendFrom', () => {
  const row = (month: string, n: number, rev: number) => ({
    id: `LG:${month}`, schemaVersion: ROLLUP_SCHEMA_VERSION, computedAt: '2026-11-17T12:00:00Z',
    payload: { v: 1, days: { [`${month}-05`]: { 'd1|d1': { n, rev, rated: n } } } },
  }) as never
  it('turns month rows into one point per month, skipping months with no row and marking the current one', () => {
    const drivers = [{ id: 'd1', type: 'owner_op' }] as never
    const t = legacyTrendFrom([row('2026-10', 8, 800_000), row('2026-11', 2, 150_000)], ['2026-09', '2026-10', '2026-11'], '2026-11', drivers)
    expect(t.loads.map((p) => [p.month, p.value, !!p.partial])).toEqual([['2026-10', 8, false], ['2026-11', 2, true]])
    expect(t.revenue.map((p) => p.value)).toEqual([800_000, 150_000])
  })
})
