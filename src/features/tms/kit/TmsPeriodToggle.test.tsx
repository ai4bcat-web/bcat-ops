// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TmsPeriodToggle } from './TmsPeriodToggle'
import { TmsKpiCard } from './TmsKpiCard'

describe('TmsPeriodToggle', () => {
  it('marks the selected chip and reports a click', () => {
    const onChange = vi.fn()
    render(<TmsPeriodToggle value="W" onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'W' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'D' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'M' }))
    expect(onChange).toHaveBeenCalledWith('M')
  })

  it('moves the selection with the arrow keys, wrapping around', () => {
    const onChange = vi.fn()
    render(<TmsPeriodToggle value="M" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'M' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('D')
    fireEvent.keyDown(screen.getByRole('button', { name: 'M' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('W')
  })

  it('renders only the options it is given', () => {
    render(<TmsPeriodToggle value="D" onChange={() => {}} options={['D', 'M']} />)
    expect(screen.queryByRole('button', { name: 'W' })).toBeNull()
  })

  it('appears on a KPI card only when asked for', () => {
    const { rerender } = render(<TmsKpiCard label="Fuel" value="$1" />)
    expect(screen.queryByRole('group')).toBeNull()
    rerender(<TmsKpiCard label="Fuel" value="$1" period={{ value: 'D', onChange: () => {} }} />)
    expect(screen.getByRole('group', { name: 'Fuel period' })).toBeInTheDocument()
  })
})
