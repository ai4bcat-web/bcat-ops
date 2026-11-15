// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TmsHeadBand } from './TmsListCard'

describe('TmsHeadBand collapse', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })

  it('starts collapsed with the compact numbers, and remembers when opened', () => {
    render(<TmsHeadBand collapseKey="t.cards" compact={<span>compact</span>} cards={<span>cards</span>} bottom={<span>tabs</span>} />)
    expect(screen.getByText('compact')).toBeTruthy()
    expect(screen.queryByText('cards')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /show details/i }))
    expect(screen.getByText('cards')).toBeTruthy()
    expect(screen.queryByText('compact')).toBeNull()
    expect(localStorage.getItem('t.cards')).toBe('open')
  })

  it('opens straight away when the viewer left it open', () => {
    localStorage.setItem('t.cards', 'open')
    render(<TmsHeadBand collapseKey="t.cards" compact={<span>compact</span>} cards={<span>cards</span>} />)
    expect(screen.getByText('cards')).toBeTruthy()
  })

  it('without a collapse key the cards always show', () => {
    render(<TmsHeadBand cards={<span>cards</span>} />)
    expect(screen.getByText('cards')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
