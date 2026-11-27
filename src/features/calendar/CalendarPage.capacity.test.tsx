// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { toolbar, auth } = vi.hoisted(() => ({
  toolbar: { props: null as null | Record<string, unknown> },
  auth: { email: 'dennis@bcatcorp.com' },
}))
vi.mock('@/store/useAppStore', () => {
  const state = {
    searchQuery: '', filters: {}, newShipmentPrefill: null, closeNewShipment: vi.fn(), equipment: [],
    refreshCalendarData: vi.fn().mockResolvedValue(undefined), ensureLoadRange: vi.fn().mockResolvedValue(undefined), loadedMonths: new Set<string>(), selectedLoadId: null,
  }
  const useAppStore = (sel: (s: typeof state) => unknown) => sel(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: [] }), useEnsureLoadRange: () => true }))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useDriverAvailability', () => ({
  useDriverAvailability: () => ({ availabilities: [], refresh: vi.fn(), createAvailability: vi.fn(), deleteAvailability: vi.fn() }),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: auth.email, groups: [] }, hasPageAccess: () => true }) }))
vi.mock('./CalendarToolbar', () => ({ CalendarToolbar: (p: Record<string, unknown>) => { toolbar.props = p; return null } }))
vi.mock('./PlannerView', () => ({ PlannerView: () => <div>DAY BOARD</div> }))
vi.mock('./CapacityBoard', () => ({ CapacityBoard: (p: { from: string; to: string }) => <div>CAPACITY {p.from} to {p.to}</div> }))
vi.mock('./DriverAvailabilityModal', () => ({ DriverAvailabilityModal: () => null }))
vi.mock('./CalendarPaperwork', () => ({ CalendarPaperworkProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('./useLoadReviewMarks', () => ({ useLoadReviewMarks: (loads: unknown[]) => loads }))

import { CalendarPage } from './CalendarPage'

const pick = (view: string) => act(() => { (toolbar.props!.onViewChange as (v: string) => void)(view) })

describe('CalendarPage views', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-27T15:00:00Z')) // a Friday
    auth.email = 'dennis@bcatcorp.com'
  })
  afterEach(() => { vi.useRealTimers() })

  it('opens on Day and switches to the Capacity board, today through Sunday', () => {
    render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    expect(screen.getByText('DAY BOARD')).toBeTruthy()
    expect(toolbar.props!.capacityEnabled).toBe(true)
    pick('capacity')
    expect(screen.getByText('CAPACITY 2026-11-27 to 2026-11-29')).toBeTruthy()
    expect(screen.queryByText('DAY BOARD')).toBeNull()
    pick('day')
    expect(screen.getByText('DAY BOARD')).toBeTruthy()
  })

  it('steps the Capacity range by its own length and Today brings it back', () => {
    render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    pick('capacity')
    act(() => { (toolbar.props!.onNext as () => void)() })
    expect(screen.getByText('CAPACITY 2026-11-30 to 2026-12-02')).toBeTruthy()
    act(() => { (toolbar.props!.onPrev as () => void)(); (toolbar.props!.onPrev as () => void)() })
    expect(screen.getByText('CAPACITY 2026-11-24 to 2026-11-26')).toBeTruthy()
    act(() => { (toolbar.props!.onToday as () => void)() })
    expect(screen.getByText('CAPACITY 2026-11-27 to 2026-11-29')).toBeTruthy()
  })

  it('never shows the Capacity board to someone limited to the fleet profiles', () => {
    auth.email = 'jason@bcatcorp.com'
    render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    expect(toolbar.props!.capacityEnabled).toBe(false)
    pick('capacity')
    expect(screen.queryByText(/CAPACITY/)).toBeNull()
    expect(screen.getByText('DAY BOARD')).toBeTruthy()
    expect(toolbar.props!.currentView).toBe('day')
  })
})
