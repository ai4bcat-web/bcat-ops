// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { refreshCalendarData, ensureLoadRange } = vi.hoisted(() => ({
  refreshCalendarData: vi.fn().mockResolvedValue(undefined),
  ensureLoadRange: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/store/useAppStore', () => {
  const state = {
    searchQuery: '', filters: {}, newShipmentPrefill: null, closeNewShipment: vi.fn(), equipment: [],
    refreshCalendarData, ensureLoadRange, loadedMonths: new Set<string>(), selectedLoadId: null,
  }
  const useAppStore = (sel: (s: typeof state) => unknown) => sel(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/hooks/useLoads', () => ({
  useLoads: () => ({ loads: [] }),
  useEnsureLoadRange: (from: string, to: string) => { void ensureLoadRange(from, to); return true },
}))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useDriverAvailability', () => ({
  useDriverAvailability: () => ({ availabilities: [], refresh: vi.fn(), createAvailability: vi.fn(), deleteAvailability: vi.fn() }),
}))
vi.mock('./CalendarToolbar', () => ({ CalendarToolbar: () => null }))
vi.mock('./PlannerView', () => ({ PlannerView: () => null }))
vi.mock('./GridCalendarView', () => ({ GridCalendarView: () => null }))
vi.mock('./DriverAvailabilityModal', () => ({ DriverAvailabilityModal: () => null }))
vi.mock('./CalendarPaperwork', () => ({ CalendarPaperworkProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('./useLoadReviewMarks', () => ({ useLoadReviewMarks: (loads: unknown[]) => loads }))

import { CalendarPage } from './CalendarPage'

describe('CalendarPage poll', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('refreshes only the visible day window, never the whole table', () => {
    render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    const [from, to] = ensureLoadRange.mock.calls[0] as [string, string]
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refreshCalendarData).toHaveBeenCalledWith({ from, to })
  })
})
