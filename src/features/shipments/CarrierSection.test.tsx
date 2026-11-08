// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierSection } from './components/CarrierSection'
import type { ShipmentActions } from './useShipmentActions'
import type { LoadCarrierRecord, ShipmentBundle } from '@/types/tms'
import type * as ApiClient from '@/lib/apiClient'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {} }) }))  // apiClient builds its client at import
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({
    drivers: [{ id: 'drv-1', name: 'Pavel Ivanov', phone: '', active: true, fleetGroup: 'LOCAL' }],
  }),
}))
vi.mock('@/hooks/useTrucks', () => ({ useTrucks: () => ({ equipment: [] }) }))
vi.mock('@/lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  getTmsSettings: vi.fn(async () => null),
  getCarrierBundle: vi.fn(async () => null),
}))
vi.mock('@/features/quotes/components/CarrierOffersCard', () => ({ CarrierOffersCard: () => null }))
vi.mock('./components/CarrierOffersSection', () => ({ CarrierOffersSection: () => null }))
vi.mock('./components/PostingsSection', () => ({ PostingsSection: () => null }))

const leg = (over: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord => ({
  id: 'lc-1', loadId: 'load-1', shipmentId: 'shp-1', kind: 'OWN_ASSET', status: 'ACTIVE',
  driverId: 'drv-1', driverName: 'Pavel Ivanov', ...over,
} as LoadCarrierRecord)

function bundleOf(loadCarriers: LoadCarrierRecord[], loadOver: Record<string, unknown> = {}): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', number: 'S1', status: 'OPEN', buildState: 'READY' },
    orders: [], charges: [], financials: [], documents: [],
    loads: [{ id: 'load-1', status: 'BOOKED', assignmentType: 'OWN_ASSET', stops: [], ...loadOver }],
    loadCarriers,
  } as unknown as ShipmentBundle
}

function actionsOf(dispatchLoad = vi.fn(async () => {})): ShipmentActions {
  return {
    busy: false, reload: vi.fn(async () => {}), dispatchLoad,
    load: { onAssignAsset: vi.fn(async () => {}) },
  } as unknown as ShipmentActions
}

function renderTab(bundle: ShipmentBundle, actions = actionsOf()) {
  render(<MemoryRouter><CarrierSection bundle={bundle} actions={actions} isAdmin={false} /></MemoryRouter>)
  return actions
}

describe('Carrier/Driver tab for an own-asset load', () => {
  it('says so, with an Assign driver button, when the load has no leg at all', () => {
    renderTab(bundleOf([]))
    expect(screen.getByTestId('own-asset-no-driver').textContent).toContain('No driver on this Ivan Cartage load')
    expect(screen.queryByText(/Nobody is on this load yet/)).toBeNull()
  })

  it('keeps the brokered empty state for a load that is not own fleet', () => {
    renderTab(bundleOf([], { assignmentType: 'NEED_TO_COVER' }))
    expect(screen.getByText(/Nobody is on this load yet/)).toBeTruthy()
    expect(screen.queryByTestId('own-asset-no-driver')).toBeNull()
  })

  it('flags a leg without a driver and will not dispatch it', () => {
    renderTab(bundleOf([leg({ driverId: null, driverName: null })]))
    expect(screen.getByTestId('own-asset-no-driver')).toBeTruthy()
    const dispatch = screen.getByRole('button', { name: /Dispatch/ }) as HTMLButtonElement
    expect(dispatch.disabled).toBe(true)
    expect(dispatch.title).toContain('driver')
  })

  it('shows the driver with Change driver, and calls LOCAL pay "paperwork (no settlement)"', () => {
    renderTab(bundleOf([leg()]))
    expect(screen.getByText('Pavel Ivanov', { selector: 'span' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Change driver/ })).toBeTruthy()
    expect(screen.getByTestId('own-fleet-settlement').textContent).toBe('paperwork (no settlement)')
    expect(screen.queryByTestId('own-asset-no-driver')).toBeNull()
  })

  it('shows a relay chip when the stops carry two drivers', () => {
    renderTab(bundleOf([leg()], {
      stops: [
        { id: 'p', type: 'pickup', driverId: 'drv-1' },
        { id: 'd', type: 'delivery', driverId: 'drv-2' },
      ],
    }))
    expect(screen.getByText('Relay: Pavel Ivanov → drv-2')).toBeTruthy()
  })

  it('shows the server\'s refusal inside the dispatch dialog and keeps it open', async () => {
    const dispatchLoad = vi.fn(async () => { throw new Error('Pavel Ivanov is inactive: pick an active driver before dispatching.') })
    renderTab(bundleOf([leg()]), actionsOf(dispatchLoad))
    fireEvent.click(screen.getByRole('button', { name: /^Dispatch$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dispatch' }))
    await waitFor(() => expect(screen.getByTestId('dispatch-error').textContent).toContain('is inactive'))
    expect(screen.getByTestId('dispatch-driver-name').textContent).toBe('Pavel Ivanov')
  })
})
