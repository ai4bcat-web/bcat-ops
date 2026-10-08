// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { Load } from '@/types'

const state = vi.hoisted(() => ({
  loads: [] as Load[],
  drivers: [{ id: 'drv-jason', name: 'Jason Smith', active: true, fleetGroup: 'LOCAL', driverType: 'COMPANY' }],
  updateLoad: vi.fn().mockResolvedValue(undefined),
  setSelectedLoad: vi.fn(),
}))
vi.mock('@/store/useAppStore', () => ({ useAppStore: (sel: (s: typeof state) => unknown) => sel(state) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'fleet@bcatcorp.com' } }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { EldLogsWidget } = await import('./EldLogsWidget')

const far = (over: Partial<Load> = {}): Load => ({
  id: 'L1', aljexId: '14570', originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN',
  pickupAppt: '2026-10-07T13:00:00.000Z', deliveryAppt: '2026-10-07T20:00:00.000Z',
  pickupDriverId: 'drv-jason', deliveryDriverId: 'drv-jason', readyToInvoice: false,
  ...over,
} as unknown as Load)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-08T18:00:00Z'))
})

describe('EldLogsWidget', () => {
  it('lists a recent run outside the radius with the driver, counts it as unconfirmed, and records the tick', async () => {
    state.loads = [far()]
    render(<MemoryRouter><EldLogsWidget /></MemoryRouter>)
    expect(screen.getByText('1 to confirm')).toBeInTheDocument()
    expect(screen.getByText('Jason Smith')).toBeInTheDocument()
    expect(screen.getByText('Ivan local')).toBeInTheDocument()
    expect(screen.getByText('Logs required')).toBeInTheDocument()
    expect(screen.getByText(/INDIANAPOLIS, IN · \d+ air mi/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Logs handled for PRO 14570/ }))
    await waitFor(() => expect(state.updateLoad).toHaveBeenCalledWith('L1', expect.objectContaining({ eldLogsReviewedBy: 'fleet@bcatcorp.com' })))
  })

  it('shows who confirmed and when, and lets it be reopened', async () => {
    state.loads = [far({ eldLogsReviewedAt: '2026-10-08T10:00:00Z', eldLogsReviewedBy: 'jenny@bcatcorp.com' })]
    render(<MemoryRouter><EldLogsWidget /></MemoryRouter>)
    expect(screen.queryByText(/to confirm/)).toBeNull()
    expect(screen.getByText(/jenny@bcatcorp.com/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Logs handled/ }))
    await waitFor(() => expect(state.updateLoad).toHaveBeenCalledWith('L1', { eldLogsReviewedAt: null, eldLogsReviewedBy: null }))
  })

  it('leaves a local run out and says so', () => {
    state.loads = [far({ destinationCity: 'Waukegan, IL' })]
    render(<MemoryRouter><EldLogsWidget /></MemoryRouter>)
    expect(screen.getByText(/No runs left the radius in the last 30 days/)).toBeInTheDocument()
  })

  it('opens the load from its PRO', () => {
    state.loads = [far()]
    render(<MemoryRouter><EldLogsWidget /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: '14570' }))
    expect(state.setSelectedLoad).toHaveBeenCalledWith('L1', 'view')
  })
})
