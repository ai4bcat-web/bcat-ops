// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { TmsKpiCard } from './TmsKpiCard'

describe('TmsKpiCard', () => {
  it('shows a gain as +pct in the good tone', () => {
    render(<TmsKpiCard label="Revenue" value="$10" delta={{ pct: 40.93 }} />)
    const delta = screen.getByText('+40.93%')
    expect(delta).toHaveClass('tms-delta-good')
    expect(screen.getByText('vs last month')).toBeInTheDocument()
  })

  it('shows a loss as -pct in the bad tone', () => {
    render(<TmsKpiCard label="Revenue" value="$10" delta={{ pct: -1.63 }} />)
    expect(screen.getByText('-1.63%')).toHaveClass('tms-delta-bad')
  })

  it('shows zero as flat', () => {
    render(<TmsKpiCard label="Revenue" value="$10" delta={{ pct: 0 }} />)
    expect(screen.getByText('0.00%')).toHaveClass('tms-delta-flat')
  })

  it('flips the tone, not the sign, when positive is not good', () => {
    render(<TmsKpiCard label="Open AR" value="$10" delta={{ pct: 5 }} positiveIsGood={false} />)
    expect(screen.getByText('+5.00%')).toHaveClass('tms-delta-bad')
  })

  it('renders an em dash and no delta when the value is unknown', () => {
    render(<TmsKpiCard label="Revenue" value={null} delta={{ pct: 5 }} sub="12 shipments" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('+5.00%')).toBeNull()
  })

  it('shows sub only when there is no delta', () => {
    const { rerender } = render(<TmsKpiCard label="Revenue" value="$10" sub="12 shipments" />)
    expect(screen.getByText('12 shipments')).toBeInTheDocument()
    rerender(<TmsKpiCard label="Revenue" value="$10" sub="12 shipments" delta={{ pct: 1, label: 'vs prior' }} />)
    expect(screen.queryByText('12 shipments')).toBeNull()
    expect(screen.getByText('vs prior')).toBeInTheDocument()
  })
})
