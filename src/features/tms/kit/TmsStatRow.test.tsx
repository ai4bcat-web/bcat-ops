// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TmsStatRow } from './TmsStatRow'

describe('TmsStatRow', () => {
  it('renders a null value as an em dash, never $0.00', () => {
    render(<TmsStatRow items={[{ label: 'Revenue', value: null }]} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/\$0/)).toBeNull()
  })

  it('applies the tone class to the value', () => {
    render(<TmsStatRow items={[{ label: 'Late', value: '3', tone: 'bad' }]} />)
    expect(screen.getByText('3')).toHaveClass('tms-kpi-value-bad')
  })

  it('renders a clickable tile as a button named by its label and fires onClick', () => {
    const onClick = vi.fn()
    render(<TmsStatRow items={[{ label: 'Docs needed', value: '4', onClick }]} />)
    fireEvent.click(screen.getByRole('button', { name: /Docs needed/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('uses ariaLabel as the tile name and caps columns at min(items, 4)', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: String(i) }))
    const { container, rerender } = render(<TmsStatRow items={items} aria-label="Totals" />)
    expect(container.firstChild).toHaveClass('tms-stat-row-4')
    rerender(<TmsStatRow items={items.slice(0, 3)} />)
    expect(container.firstChild).toHaveClass('tms-stat-row-3')
    rerender(<TmsStatRow items={[{ label: 'A', value: '1', ariaLabel: 'Need to factor: $2.00' }]} />)
    expect(screen.getByLabelText('Need to factor: $2.00')).toBeInTheDocument()
  })
})
