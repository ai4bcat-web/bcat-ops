// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// The widget reads the app store for drivers / equipment / loads; the ELD rows and the time clock
// come from the API client, so they are faked here. Nothing real is called.
const api = vi.hoisted(() => ({
  listTimeClockEntries: vi.fn(),
  listDispatchConversations: vi.fn(),
  listTruckLocations: vi.fn(),
}))
vi.mock('@/lib/apiClient', async (orig) => ({ ...(await orig<typeof import('@/lib/apiClient')>()), ...api }))
const mobile = vi.hoisted(() => ({ value: false }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }))
vi.mock('@/hooks/useLoads', async (orig) => ({ ...(await orig<typeof import('@/hooks/useLoads')>()), useEnsureLoadRange: () => true }))
vi.mock('./PerMileKpis', () => ({ PerMileKpis: () => null }))

import { DriverLeaderboardWidget } from './DriverLeaderboardWidget'
import { useAppStore } from '@/store/useAppStore'

const NOW = new Date('2026-11-18T18:00:00Z')
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

const fix = (over: Record<string, unknown> = {}) => ({
  truckId: 'eq-3114', unitNumber: '3114', lat: 41.59, lon: -87.35, bearing: null, speed: 0,
  locatedAt: minAgo(4), description: '2.1 mi NE of Gary, IN', motion: 'MOVING', motionSince: null, odometer: null,
  source: 'motive', syncedAt: minAgo(3), createdAt: minAgo(3), updatedAt: minAgo(3), ...over,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  api.listTimeClockEntries.mockResolvedValue([])
  api.listDispatchConversations.mockResolvedValue([])
  api.listTruckLocations.mockResolvedValue([fix()])
  mobile.value = false
  useAppStore.setState({
    drivers: [
      { id: 'd-ivan', name: 'Alden Ivan', active: true, type: 'company', assignedTruckId: 'eq-3114' },
      { id: 'd-none', name: 'Bea NoTruck', active: true, type: 'company', assignedTruckId: null },
    ] as never,
    equipment: [{ id: 'eq-3114', unitNumber: '3114', type: 'truck', active: true }] as never,
    loads: [],
  })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('DriverLeaderboardWidget current location', () => {
  it('wide screens: a "Current location" column beside hours, with the truck’s city and age', async () => {
    render(<DriverLeaderboardWidget />)
    await waitFor(() => expect(screen.getAllByText('Gary, IN').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Current location').length).toBeGreaterThan(0)
    const cells = screen.getAllByTestId('driver-location')
    expect(cells[0]).toHaveTextContent('Gary, IN')
    expect(cells[0]).toHaveTextContent('4 min ago')
    // A driver with no truck and no stop shows a dash, never an invented place.
    expect(cells.some((c) => c.textContent === '—')).toBe(true)
  })

  it('narrow screens: no column header; the location is a line under the driver’s name', async () => {
    mobile.value = true
    render(<DriverLeaderboardWidget />)
    await waitFor(() => expect(screen.getAllByText('Gary, IN').length).toBeGreaterThan(0))
    expect(screen.queryByText('Current location')).not.toBeInTheDocument()
    const row = screen.getByText('Alden Ivan').closest('div[style*="grid"]') as HTMLElement
    expect(within(row).getByTestId('driver-location')).toHaveTextContent('Gary, IN')
    expect(screen.getAllByText('Location unknown').length).toBeGreaterThan(0)
  })

  it('is always "now": stepping the week back does not change where the driver is', async () => {
    render(<DriverLeaderboardWidget />)
    await waitFor(() => expect(screen.getAllByText('Gary, IN').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByLabelText('Previous week'))
    await waitFor(() => expect(screen.getAllByText(/Last week/).length).toBeGreaterThan(0))
    expect(screen.getAllByTestId('driver-location')[0]).toHaveTextContent('Gary, IN')
  })

  it('a failed truck-location read leaves the leaderboard up, with dashes', async () => {
    api.listTruckLocations.mockRejectedValue(new Error('offline'))
    render(<DriverLeaderboardWidget />)
    await waitFor(() => expect(screen.getByText('Alden Ivan')).toBeInTheDocument())
    expect(screen.getAllByTestId('driver-location').every((c) => c.textContent === '—')).toBe(true)
  })
})
