// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { TmsSegmentedTabs } from './TmsSegmentedTabs'

const tabs = [
  { key: 'a', label: 'Active', count: 0 },
  { key: 'b', label: 'Inbox', count: 5 },
  { key: 'c', label: 'Done' },
]

function Harness() {
  const [active, setActive] = useState('a')
  return <TmsSegmentedTabs tabs={tabs} active={active} onSelect={setActive} />
}

describe('TmsSegmentedTabs', () => {
  it('exposes tab roles with aria-selected and shows a zero count', () => {
    render(<Harness />)
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Inbox/ })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('arrows move and wrap; Home/End jump; focus follows', () => {
    render(<Harness />)
    const sel = () => screen.getByRole('tab', { selected: true }).textContent
    fireEvent.keyDown(screen.getByRole('tab', { name: /Active/ }), { key: 'ArrowLeft' })
    expect(sel()).toContain('Done')
    expect(screen.getByRole('tab', { name: /Done/ })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: /Done/ }), { key: 'ArrowRight' })
    expect(sel()).toContain('Active')
    fireEvent.keyDown(screen.getByRole('tab', { name: /Active/ }), { key: 'End' })
    expect(sel()).toContain('Done')
    fireEvent.keyDown(screen.getByRole('tab', { name: /Done/ }), { key: 'Home' })
    expect(sel()).toContain('Active')
  })
})
