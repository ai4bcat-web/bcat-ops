// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { toast } from 'sonner'
import { BuildingBanner } from './BuildingBanner'
import type { ShipmentRecord } from '@/types/tms'

const completeBuild = vi.hoisted(() => vi.fn())
const onReload = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  completeBuild,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const WHEN = '2026-04-03T12:00:00.000Z'

function shipment(over: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id: 'shp-1',
    number: 'S000001',
    status: 'OPEN',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'FTL',
    source: 'MANUAL',
    buildState: 'BUILDING',
    missingFields: ['pickupAddress', 'deliveryAddress', 'billTo', 'salesRep', 'revenueDivision'],
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  } as ShipmentRecord
}

beforeEach(() => {
  vi.clearAllMocks()
  completeBuild.mockResolvedValue({ shipment: shipment({ buildState: 'BUILT', missingFields: [] }), missingFields: [], requiredFields: [] })
  onReload.mockResolvedValue(undefined)
})

describe('BuildingBanner', () => {
  it('renders nothing when the shipment is already BUILT', () => {
    render(<BuildingBanner shipment={shipment({ buildState: 'BUILT', missingFields: [] })} onReload={onReload} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the Needs sentence and a chip for each missing field', () => {
    render(<BuildingBanner shipment={shipment()} onReload={onReload} />)
    expect(screen.getByText(/Needs:/)).toBeInTheDocument()
    expect(screen.getByText('Pickup address')).toBeInTheDocument()
    expect(screen.getByText('Delivery address')).toBeInTheDocument()
    expect(screen.getByText('Bill-to party')).toBeInTheDocument()
    expect(screen.getByText('Sales rep')).toBeInTheDocument()
    expect(screen.getByText('Revenue division')).toBeInTheDocument()
  })

  it('calls completeBuild and reloads when Mark built is pressed', async () => {
    render(<BuildingBanner shipment={shipment()} onReload={onReload} />)
    fireEvent.click(screen.getByRole('button', { name: /Mark built/i }))
    await waitFor(() => expect(completeBuild).toHaveBeenCalledWith({ shipmentId: 'shp-1', expectedUpdatedAt: WHEN }))
    expect(onReload).toHaveBeenCalled()
  })

  it('toasts the server sentence when completeBuild is refused', async () => {
    completeBuild.mockRejectedValue(new Error('Still needs pickup address'))
    render(<BuildingBanner shipment={shipment()} onReload={onReload} />)
    fireEvent.click(screen.getByRole('button', { name: /Mark built/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Still needs pickup address'))
    expect(onReload).not.toHaveBeenCalled()
  })
})
