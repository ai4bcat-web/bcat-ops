// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { Load } from '@/types'

const h = vi.hoisted(() => ({
  createShipmentForLoad: vi.fn(),
  auth: { isAdmin: true, isOwner: false },
  loads: [] as unknown[],
  toastError: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({ createShipmentForLoad: h.createShipmentForLoad }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => h.auth }))
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ allLoads: h.loads as Load[], loads: [], updateLoad: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: h.toastError } }))

import { MintShipmentCard } from './MintShipmentCard'

const loads = [
  { id: 'load-1', pickupNumber: 'L001', shipmentId: 'ship-1', originCity: 'Chicago', destinationCity: 'Dallas', pickupAppt: '2026-01-01T00:00:00Z' },
  { id: 'load-2', pickupNumber: 'L002', shipmentId: null, originCity: 'Denver', destinationCity: 'Boise', pickupAppt: '2026-01-02T00:00:00Z' },
  { id: 'load-3', pickupNumber: 'L003', shipmentId: null, originCity: 'Reno', destinationCity: 'Provo', pickupAppt: '2026-01-05T00:00:00Z' },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.auth.isAdmin = true
  h.auth.isOwner = false
  h.loads = loads
})

describe('MintShipmentCard', () => {
  it('lists only loads without a shipment, newest pickup first, and mints the one clicked', async () => {
    h.createShipmentForLoad.mockResolvedValue({})
    render(<MintShipmentCard />)
    const rows = screen.getAllByTestId('mint-row')
    expect(rows.map((r) => r.getAttribute('data-load-id'))).toEqual(['load-3', 'load-2'])
    expect(screen.queryByText('L001')).toBeNull()

    fireEvent.click(within(rows[1]).getByRole('button', { name: /Create/ }))
    await waitFor(() => expect(h.createShipmentForLoad).toHaveBeenCalledWith('load-2'))
    // The minted load is not offered a second time.
    await waitFor(() => expect(screen.getAllByTestId('mint-row')).toHaveLength(1))
    expect(screen.queryByText('L002')).toBeNull()
  })

  it('keeps the load listed and shows the server refusal when minting fails', async () => {
    h.createShipmentForLoad.mockRejectedValue(new Error('Owner or ADMIN only.'))
    render(<MintShipmentCard />)
    fireEvent.click(within(screen.getAllByTestId('mint-row')[0]).getByRole('button', { name: /Create/ }))
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Owner or ADMIN only.'))
    expect(screen.getAllByTestId('mint-row')).toHaveLength(2)
  })

  it('says so when every load already has a shipment', () => {
    h.loads = [loads[0]]
    render(<MintShipmentCard />)
    expect(screen.getByText('Every load already has a shipment. Nothing to do.')).toBeInTheDocument()
  })

  it('offers no Create button to someone who is neither owner nor admin', () => {
    h.auth.isAdmin = false
    render(<MintShipmentCard />)
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull()
    expect(screen.getByText(/Only an owner or admin/)).toBeInTheDocument()
  })
})
