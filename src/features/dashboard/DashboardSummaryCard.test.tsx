// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DashboardSummaryCard } from './DashboardSummaryCard'

const rows = [{ key: 'a', label: 'Pending', count: 2, cents: 1000, color: 'red' }]
const groups = [{ key: 'g', label: 'Factoring', rows: [{ key: 'b', label: 'Waiting', count: 1, cents: 500, color: 'blue' }] }]

describe('DashboardSummaryCard layout (Ryne 2026-11-16: fit the dashboard on one page)', () => {
  it('puts the groups in a column beside the rows when groupsBeside is set', () => {
    render(<DashboardSummaryCard title="AR" icon={null} headline={1500} sublabel="open" rows={rows} groups={groups} groupsBeside onOpen={() => {}} testId="c" />)
    expect(screen.getByTestId('c-body').style.display).toBe('grid')
    expect(screen.getByText('Factoring')).toBeTruthy()
  })
  it('stacks the groups under the rows by default and renders the extra slot', () => {
    render(<DashboardSummaryCard title="AR" icon={null} headline={1500} sublabel="open" rows={rows} groups={groups} extra={<div data-testid="x" />} onOpen={() => {}} testId="d" />)
    expect(screen.getByTestId('d-body').style.display).toBe('flex')
    expect(screen.getByTestId('x')).toBeTruthy()
  })
})
