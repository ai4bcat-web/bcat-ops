// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { TimeOffPage } from './TimeOffPage'
import { isApproved } from '@/lib/timeOff'
import type { DriverAvailability } from '@/lib/apiClient'

const reviewTimeOff = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ all: [] as unknown[] }))

vi.mock('@/lib/staffTimeOff', () => ({ reviewTimeOff, addStaffPtoDay: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'office@bcat.test' } }) }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ drivers: [
    { id: 'd1', name: 'Chad Salerno', active: true },
    { id: 'd2', name: 'Ivan Petrov', active: true },
  ] }),
}))
vi.mock('@/hooks/useDriverAvailability', () => ({
  useDriverAvailability: () => ({
    all: state.all,
    availabilities: (state.all as DriverAvailability[]).filter(isApproved),
    loading: false,
    refresh,
    createAvailability: vi.fn(), updateAvailability: vi.fn(), deleteAvailability: vi.fn(),
  }),
}))

function row(over: Partial<DriverAvailability>): DriverAvailability {
  return {
    id: 'a', driverId: 'd1', type: 'FULL_DAY_OFF', startDate: '2099-01-10', endDate: '2099-01-10',
    createdBy: 'office', createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z', ...over,
  }
}

const upcoming = () => screen.getByText(/Upcoming & active time off/).parentElement!.parentElement!
const requests = () => screen.getByRole('region', { name: 'Requests' })

beforeEach(() => {
  reviewTimeOff.mockReset().mockResolvedValue({ status: 'APPROVED' })
  refresh.mockReset().mockResolvedValue(undefined)
  state.all = [
    row({ id: 'p', type: 'PTO', status: 'PENDING', source: 'DRIVER', hours: 8, note: 'pending note' }),
    row({ id: 'd', status: 'DENIED', note: 'denied note' }),
    row({ id: 'ok', status: 'APPROVED', note: 'approved note' }),
    row({ id: 'legacy', driverId: 'd2', note: 'legacy note' }),
  ]
})

describe('TimeOffPage', () => {
  it('shows a pending request only in Requests, never in Upcoming', () => {
    render(<TimeOffPage />)
    expect(within(requests()).getByText('pending note')).toBeInTheDocument()
    expect(within(upcoming()).queryByText('pending note')).toBeNull()
  })

  it('lists approved rows and rows with no status in Upcoming', () => {
    render(<TimeOffPage />)
    expect(within(upcoming()).getByText('approved note')).toBeInTheDocument()
    expect(within(upcoming()).getByText('legacy note')).toBeInTheDocument()
  })

  it('hides denied rows until Show denied is ticked, then badges them', () => {
    render(<TimeOffPage />)
    expect(screen.queryByText('denied note')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show denied'))
    const list = within(upcoming())
    expect(list.getByText('denied note')).toBeInTheDocument()
    expect(list.getByText('Denied')).toBeInTheDocument()
    expect(within(requests()).queryByText('denied note')).toBeNull()
  })

  it('approving calls the server for that row and refreshes', async () => {
    render(<TimeOffPage />)
    fireEvent.click(within(requests()).getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(reviewTimeOff).toHaveBeenCalledWith('p', 'APPROVE', undefined)
  })
})
