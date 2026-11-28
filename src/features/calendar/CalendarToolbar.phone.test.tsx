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
  currentView: 'day' as const, dateLabel: 'Nov 14, 2026', onPrev: vi.fn(), onNext: vi.fn(), onToday: vi.fn(), onViewChange: vi.fn(),
  drivers: [], visibleDriverIds: new Set<string>(), onVisibleDriversChange: vi.fn(),
}

describe('CalendarToolbar on a phone', () => {
  it('offers no List view, and keeps the filter chips behind a Filters button that counts the active ones', () => {
    render(<MemoryRouter><CalendarToolbar {...props} phone /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'List' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Day' })).toBeTruthy()
    const toggle = screen.getByRole('button', { name: /Filters \(1\)/ })
    const chips = document.getElementById('calendar-filters')!
    expect(chips.style.display).toBe('none')
    fireEvent.click(toggle)
    expect(chips.style.display).toBe('flex')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the desktop bar as it was: no List, no Filters button, chips inline', () => {
    render(<MemoryRouter><CalendarToolbar {...props} currentView="day" /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'List' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull()
    expect(document.getElementById('calendar-filters')!.style.display).toBe('flex')
    expect(screen.getByRole('button', { name: 'New Shipment' }).textContent).toContain('New Shipment')
  })
})

describe('CalendarToolbar on desktop', () => {
  it('wraps every filter chip onto its own line below the controls instead of clipping them', () => {
    render(<MemoryRouter><CalendarToolbar {...props} currentView="day" /></MemoryRouter>)
    const chips = document.getElementById('calendar-filters')!
    expect(chips.style.flexWrap).toBe('wrap')
    expect(chips.style.flex).toBe('1 1 100%')
    expect(chips.style.order).toBe('10')
    expect(chips.style.overflow).not.toBe('hidden')
    const bar = chips.parentElement!
    expect(bar.style.flexWrap).toBe('wrap')
    expect(bar.style.overflowX).not.toBe('auto')
    for (const name of ['Waiting for Detention', 'Waiting for TONU', 'Needs Appt']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeTruthy()
    }
  })
})

describe('CalendarToolbar views', () => {
  it('offers Day and Capacity only: Week and Month are gone', () => {
    render(<MemoryRouter><CalendarToolbar {...props} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'Day' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Capacity' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Week' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Month' })).toBeNull()
  })

  it('puts Capacity right after Day', () => {
    render(<MemoryRouter><CalendarToolbar {...props} /></MemoryRouter>)
    const tabs = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => t === 'Day' || t === 'Capacity')
    expect(tabs).toEqual(['Day', 'Capacity'])
  })

  it('hides the Capacity tab from someone who may not have it', () => {
    render(<MemoryRouter><CalendarToolbar {...props} capacityEnabled={false} /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'Capacity' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Day' })).toBeTruthy()
  })

  it('calls onViewChange with capacity when the tab is picked', () => {
    const onViewChange = vi.fn()
    render(<MemoryRouter><CalendarToolbar {...props} onViewChange={onViewChange} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Capacity' }))
    expect(onViewChange).toHaveBeenCalledWith('capacity')
  })

  it('steps the load filters and load search aside on Capacity, and keeps New Shipment', () => {
    render(<MemoryRouter><CalendarToolbar {...props} currentView="capacity" /></MemoryRouter>)
    expect(document.getElementById('calendar-filters')).toBeNull()
    expect(screen.queryByLabelText('Search loads')).toBeNull()
    expect(screen.getByRole('button', { name: 'New Shipment' })).toBeTruthy()
  })
})
