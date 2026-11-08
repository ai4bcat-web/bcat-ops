// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { TmsGauge } from './TmsGauge'

const filled = (c: HTMLElement) => c.querySelectorAll('line[data-filled="true"]').length

describe('TmsGauge', () => {
  it('fills the rounded share of ticks and shows the label', () => {
    const { container } = render(<TmsGauge value={0.5} label="$412k" sub="of $500k" ariaLabel="Revenue" />)
    expect(filled(container)).toBe(18)
    expect(screen.getByText('$412k')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Revenue' })).toBeInTheDocument()
  })

  it('caps the arc at full while the label may say more than 100%', () => {
    const { container } = render(<TmsGauge value={1.4} label="140%" ariaLabel="Over" />)
    expect(filled(container)).toBe(36)
  })

  it('is empty with a dash when there is no value', () => {
    const { container } = render(<TmsGauge value={null} label="$0" ariaLabel="None" />)
    expect(filled(container)).toBe(0)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('$0')).toBeNull()
  })
})
