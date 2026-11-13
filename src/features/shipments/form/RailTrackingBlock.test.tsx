// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShipmentBundle } from '@/types/tms'

const api = vi.hoisted(() => ({
  listTruckLocations: vi.fn(),
  listCheckCallsByLoad: vi.fn(),
  listTrackingLinksByShipment: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/features/dashboard/FleetMiniMap', () => ({ FleetMiniMap: () => <div data-testid="mini-map" /> }))

import { useAppStore } from '@/store/useAppStore'
import { RailTrackingBlock } from './RailTrackingBlock'

const recent = () => new Date(Date.now() - 5 * 60_000).toISOString()

const bundle = (loadCarriers: unknown[]) => ({
  shipment: { id: 'sh-1' }, orders: [], loads: [{ id: 'l-1', status: 'IN_TRANSIT', stops: [] }],
  loadCarriers, charges: [], financials: [], documents: [],
}) as unknown as ShipmentBundle

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.listTruckLocations.mockResolvedValue([])
  api.listCheckCallsByLoad.mockResolvedValue([])
  api.listTrackingLinksByShipment.mockResolvedValue([])
  useAppStore.setState({
    drivers: [{ id: 'd-1', name: 'Manuel', phone: '', active: true, fleetGroup: 'LOCAL' }] as never,
    equipment: [{ id: 'eq-9', type: 'truck', unitNumber: '309' }] as never,
  })
})

describe('RailTrackingBlock', () => {
  it('own fleet: shows the ELD place and age with a map', async () => {
    api.listTruckLocations.mockResolvedValue([{ truckId: 'eq-9', unitNumber: '309', lat: 43, lon: -88, speed: 60, motion: 'MOVING', locatedAt: recent(), description: '4 mi N of Waukesha, WI' }])
    render(<div className="tms-shell"><RailTrackingBlock bundle={bundle([{ id: 'lc-1', loadId: 'l-1', kind: 'OWN_ASSET', status: 'ACTIVE', driverId: 'd-1', truckId: 'eq-9' }])} /></div>)
    expect(await screen.findByText('4 mi N of Waukesha, WI')).toBeTruthy()
    expect(screen.getByTestId('rail-tracking-kind').textContent).toBe('Ivan driver · ELD')
    expect(screen.getByTestId('rail-tracking-age').textContent).toBe('Updated 5 min ago')
    expect(screen.getByTestId('mini-map')).toBeTruthy()
  })

  it('brokered without a link: says so and offers Send Tracking Link', async () => {
    const onSend = vi.fn()
    render(<RailTrackingBlock bundle={bundle([{ id: 'lc-2', loadId: 'l-1', kind: 'CARRIER', status: 'ACTIVE', carrierName: 'LANDSTAR RANGER INC' }])} onSendTrackingLink={onSend} />)
    await waitFor(() => expect(api.listTrackingLinksByShipment).toHaveBeenCalledWith('sh-1'))
    expect(screen.getByTestId('rail-tracking-link').textContent).toBe('Link not sent')
    expect(screen.getByTestId('rail-tracking-empty').textContent).toMatch(/No tracking link/)
    fireEvent.click(screen.getByTestId('rail-tracking-send'))
    expect(onSend).toHaveBeenCalled()
    expect(api.listTruckLocations).not.toHaveBeenCalled()
  })

  it('renders nothing before the first save', () => {
    const { container } = render(<RailTrackingBlock bundle={null} />)
    expect(container.textContent).toBe('')
  })
})
