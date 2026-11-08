// @vitest-environment jsdom
/**
 * AT-plan on the Carrier tab: every live carrier gets its own block (own rate con, own Dispatch, own legs),
 * "Add carrier" opens the Cover dialog (which adds, never replaces), and one carrier renders as it always did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierSection } from './components/CarrierSection'
import type { ShipmentActions } from './useShipmentActions'
import type { LoadCarrierRecord, ShipmentBundle } from '@/types/tms'
import type * as ApiClient from '@/lib/apiClient'

vi.mock('aws-amplify/data', () => ({ generateClient: vi.fn(() => ({ graphql: vi.fn() })) }))
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useTrucks', () => ({ useTrucks: () => ({ equipment: [] }) }))
vi.mock('@/hooks/useTruckConfigs', () => ({ useTruckConfigs: () => ({ byId: new Map() }) }))
vi.mock('@/lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  getTmsSettings: vi.fn(async () => null),
  getCarrierBundle: vi.fn(async () => ({ carrier: null, contacts: [] })),
}))
vi.mock('@/features/quotes/components/CarrierOffersCard', () => ({ CarrierOffersCard: () => null }))
vi.mock('./components/CarrierOffersSection', () => ({ CarrierOffersSection: () => null }))
vi.mock('./components/PostingsSection', () => ({ PostingsSection: () => null }))
vi.mock('./components/CarrierLadderCard', () => ({ CarrierLadderCard: () => null }))
vi.mock('@/features/carriers/components/RateConPanel', () => ({
  RateConPanel: ({ loadCarrier }: { loadCarrier: { id: string } }) => <div data-testid="rate-con-panel" data-load-carrier-id={loadCarrier.id} />,
}))
vi.mock('@/features/carriers/cover/CoverCarrierDialog', () => ({
  CoverCarrierDialog: ({ shipmentId }: { shipmentId: string }) => <div data-testid="cover-dialog" data-shipment={shipmentId} />,
}))

const lc = (over: Partial<LoadCarrierRecord>): LoadCarrierRecord => ({
  id: 'lc-1', loadId: 'load-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Swift',
  sequence: 1, carrierRateCents: 60_000,
  ...over,
} as LoadCarrierRecord)

function bundleOf(loadCarriers: LoadCarrierRecord[], loadOver: Record<string, unknown> = {}): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', number: 'S1', status: 'BOOKED', buildState: 'READY' },
    orders: [], charges: [], financials: [], documents: [],
    loads: [{
      id: 'load-1', status: 'BOOKED', assignmentType: 'CARRIER',
      stops: [{ id: 'st-1', type: 'pickup', city: 'Dallas' }, { id: 'st-2', type: 'delivery', city: 'Austin' }],
      ...loadOver,
    }],
    loadCarriers,
  } as unknown as ShipmentBundle
}

const actions = { busy: false, reload: vi.fn(async () => {}), dispatchLoad: vi.fn(async () => {}), load: {} } as unknown as ShipmentActions
const renderTab = (bundle: ShipmentBundle) => render(<MemoryRouter><CarrierSection bundle={bundle} actions={actions} isAdmin={false} /></MemoryRouter>)

const TWO = [
  lc({}),
  lc({ id: 'lc-2', carrierId: 'car-2', carrierName: 'Heartland', sequence: 2, carrierRateCents: 20_000, legStopIds: ['st-2'] }),
]

beforeEach(() => { vi.clearAllMocks() })

describe('Carrier tab with several carriers', () => {
  it('lists every live carrier in booking order, each with its own rate con and legs; a bounced one is not listed', async () => {
    renderTab(bundleOf([TWO[1], lc({ id: 'lc-x', carrierName: 'Gone', status: 'BOUNCED', sequence: 3 }), TWO[0]]))
    const blocks = await screen.findAllByTestId('carrier-block')
    expect(blocks.map((b) => b.getAttribute('data-load-carrier-id'))).toEqual(['lc-1', 'lc-2'])
    expect(blocks[0].textContent).toContain('Carrier 1 · Swift')
    expect(blocks[1].textContent).toContain('Carrier 2 · Heartland')
    expect(screen.queryByText(/Gone/)).toBeNull()
    expect(screen.getAllByTestId('rate-con-panel').map((p) => p.getAttribute('data-load-carrier-id'))).toEqual(['lc-1', 'lc-2'])
    expect(blocks[0].textContent).toContain('All stops')
    expect(blocks[1].textContent).toContain('2. Austin')
  })

  it('Dispatch is per carrier: once the first has rolled and the load is DISPATCHED only the other still offers it', async () => {
    renderTab(bundleOf([lc({ dispatchedAt: '2026-11-04T10:00:00.000Z' }), TWO[1]], { status: 'DISPATCHED' }))
    const blocks = await screen.findAllByTestId('carrier-block')
    expect(within(blocks[0]).queryByRole('button', { name: 'Dispatch' })).toBeNull()
    expect(within(blocks[1]).getByRole('button', { name: 'Dispatch' })).toBeTruthy()
  })

  it('Add carrier opens the Cover dialog for this shipment; it is gone at four carriers and on an own-fleet load', async () => {
    renderTab(bundleOf(TWO))
    fireEvent.click(await screen.findByTestId('add-carrier-open'))
    expect(screen.getByTestId('cover-dialog').getAttribute('data-shipment')).toBe('shp-1')
    cleanup()

    const four = [1, 2, 3, 4].map((n) => lc({ id: `lc-${n}`, sequence: n, carrierName: `C${n}` }))
    renderTab(bundleOf(four))
    await screen.findAllByTestId('carrier-block')
    expect(screen.queryByTestId('add-carrier-open')).toBeNull()
    cleanup()

    renderTab(bundleOf([lc({ kind: 'OWN_ASSET', driverName: 'Ivan D', driverId: 'd1' })], { assignmentType: 'OWN_ASSET' }))
    await screen.findByTestId('own-fleet-links')
    expect(screen.queryByTestId('add-carrier-open')).toBeNull()
  })

  it('one carrier renders without any block chrome, as before', async () => {
    renderTab(bundleOf([TWO[0]]))
    expect((await screen.findAllByTestId('rate-con-panel')).length).toBe(1)
    expect(screen.queryByTestId('carrier-block')).toBeNull()
    expect(screen.queryByText(/Carrier 1 ·/)).toBeNull()
  })
})
