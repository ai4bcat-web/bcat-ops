// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { TmsTimeline } from './TmsTimeline'

describe('TmsTimeline', () => {
  const items = [
    { id: 'a', title: 'First', state: 'done' as const },
    { id: 'b', title: 'Second', state: 'current' as const },
    { id: 'c', title: 'Third', state: 'upcoming' as const },
  ]

  it('maps state to data-state and marks exactly one current step, in order', () => {
    render(<TmsTimeline items={items} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'current', 'upcoming'])
    expect(rows.map((r) => r.textContent)).toEqual(['First', 'Second', 'Third'])
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
  })

  it('tone recolours without changing state; state defaults to done', () => {
    render(<TmsTimeline items={[{ id: 'x', title: 'Void', tone: 'red' }]} />)
    const row = screen.getByRole('listitem')
    expect(row).toHaveAttribute('data-state', 'done')
    expect(row).toHaveClass('tms-timeline-red')
  })

  it('renders `empty` when there are no items', () => {
    render(<TmsTimeline items={[]} empty={<p>Nothing yet</p>} />)
    expect(screen.getByText('Nothing yet')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })
})
