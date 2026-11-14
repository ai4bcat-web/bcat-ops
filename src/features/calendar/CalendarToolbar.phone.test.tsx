// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/store/useAppStore', () => {
  const state = { searchQuery: '', filters: { needsAppt: true }, setSearchQuery: vi.fn(), toggleFilter: vi.fn() }
  return { useAppStore: (sel: (s: typeof state) => unknown) => sel(state) }
})
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}))
vi.mock('@/components/DriverFilterMenu', () => ({ DriverFilterMenu: () => <span>Drivers</span> }))

import { CalendarToolbar } from './CalendarToolbar'

const props = {
  currentView: 'list' as const, dateLabel: 'Nov 14, 2026', onPrev: vi.fn(), onNext: vi.fn(), onToday: vi.fn(), onViewChange: vi.fn(),
  drivers: [], visibleDriverIds: new Set<string>(), onVisibleDriversChange: vi.fn(),
}

describe('CalendarToolbar on a phone', () => {
  it('offers the List view (labelled Unassigned), and keeps the filter chips behind a Filters button that counts the active ones', () => {
    render(<MemoryRouter><CalendarToolbar {...props} phone /></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'Unassigned' })).toBeTruthy()
    const toggle = screen.getByRole('button', { name: /Filters \(1\)/ })
    const chips = document.getElementById('calendar-filters')!
    expect(chips.style.display).toBe('none')
    fireEvent.click(toggle)
    expect(chips.style.display).toBe('flex')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the desktop bar as it was: no List, no Filters button, chips inline', () => {
    render(<MemoryRouter><CalendarToolbar {...props} currentView="day" /></MemoryRouter>)
    // Only the Unassigned filter chip; the List view (labelled Unassigned on a phone) is not offered.
    expect(screen.getAllByRole('button', { name: 'Unassigned' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull()
    expect(document.getElementById('calendar-filters')!.style.display).toBe('flex')
    expect(screen.getByRole('button', { name: 'New Shipment' }).textContent).toContain('New Shipment')
  })
})
