// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BoardViewTabs } from './BoardViewTabs'

const TABS = [
  { id: 'v1', name: 'Active Shipments' },
  { id: 'v2', name: 'Dispatch' },
  { id: 'v3', name: 'Accounting' },
]

describe('BoardViewTabs', () => {
  it('renders tabs and marks the active one', () => {
    render(<BoardViewTabs tabs={TABS} activeTabId="v2" onSelect={vi.fn()} onNew={vi.fn()} onDuplicate={vi.fn()} />)
    expect(screen.getByRole('tab', { name: /^Dispatch$/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /^Active Shipments$/i })).toHaveAttribute('aria-selected', 'false')
  })

  it('raises onSelect when a tab is clicked', () => {
    const onSelect = vi.fn()
    render(<BoardViewTabs tabs={TABS} activeTabId="v1" onSelect={onSelect} onNew={vi.fn()} onDuplicate={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: /^Accounting$/i }))
    expect(onSelect).toHaveBeenCalledWith('v3')
  })

  it('raises onNew for the plus button', () => {
    const onNew = vi.fn()
    render(<BoardViewTabs tabs={TABS} activeTabId="v1" onSelect={vi.fn()} onNew={onNew} onDuplicate={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /New view/i }))
    expect(onNew).toHaveBeenCalled()
  })

  it('raises onDuplicate for the active tab', () => {
    const onDuplicate = vi.fn()
    render(<BoardViewTabs tabs={TABS} activeTabId="v2" onSelect={vi.fn()} onNew={vi.fn()} onDuplicate={onDuplicate} />)
    fireEvent.click(screen.getByRole('button', { name: /Duplicate Dispatch/i }))
    expect(onDuplicate).toHaveBeenCalledWith('v2')
  })
})
