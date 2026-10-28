// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ShipmentDetail } from './components/ShipmentDetail'
import type { ShipmentActions } from './useShipmentActions'
import type {
  LoadChargeRecord, OrderRecord, ShipmentBundle, ShipmentLoad, ShipmentRecord, ShipmentStatus,
} from '@/types/tms'
import type { Stop } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/hooks/useTrucks', () => ({ useTrucks: () => ({ equipment: [] }) }))
vi.mock('@/features/loads/LoadDriverDocs', () => ({
  LoadDriverDocs: ({ kind }: { kind: string }) => <div>docs:{kind}</div>,
}))
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  getCarrierBundle: vi.fn(async () => null),
  listDivisions: vi.fn(async () => []),
  getRateConfirmUrl: vi.fn(async () => ''),
}))
vi.mock('@/lib/carrierRateCon', () => ({
  buildRateConPdf: vi.fn(),
  rateConPdfBase64: vi.fn(() => ''),
  rateConFilename: vi.fn(() => 'rate-con.pdf'),
}))
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: [], loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))

const stops: Stop[] = [
  { id: 'p1', type: 'pickup', sequence: 0, appt: '2026-04-01T13:00:00.000Z', driverId: null, name: 'Acme Dock 4', city: 'Chicago, IL' },
  { id: 'd1', type: 'delivery', sequence: 1, appt: '2026-04-02T13:00:00.000Z', driverId: null, name: 'Globex DC', city: 'Dallas, TX' },
]

const charges: LoadChargeRecord[] = [{
  id: 'ch-1', shipmentId: 'shp-1', side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT',
  rateCents: 200000, amountCents: 200000, isRate: true, sortOrder: 0,
  createdBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}]

function bundle(status: ShipmentStatus): ShipmentBundle {
  const shipment: ShipmentRecord = {
    id: 'shp-1', number: 'S000001', status, customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL', originCity: 'Chicago, IL', destinationCity: 'Dallas, TX',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const order: OrderRecord = {
    id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', mode: 'FTL', equipmentType: "53' Dry Van",
    arStatus: 'DOCS_NEEDED', references: [], freight: [],
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const load: ShipmentLoad = { id: 'load-1', stops, miles: 900, status: 'BOOKED', loadNumber: 'S000001-1', leg: 1 }
  return { shipment, orders: [order], loads: [load], loadCarriers: [], charges, financials: [] }
}

const actions = {
  busy: false,
  saveForm: vi.fn(async () => {}),
  submit: vi.fn(async () => {}),
  stopAction: vi.fn(async () => {}),
  saveCharges: vi.fn(async () => {}),
  shipment: {
    onDuplicate: vi.fn(async () => {}), onSetStatus: vi.fn(async () => {}), onDelete: vi.fn(async () => {}),
    onRestore: vi.fn(async () => {}), onTenderRespond: vi.fn(async () => {}),
  },
  bookCarrier: vi.fn(async () => {}),
  setQuickPay: vi.fn(async () => {}),
  sendRateCon: vi.fn(async () => {}),
  voidRateCon: vi.fn(async () => {}),
  dispatchLoad: vi.fn(async () => {}),
  load: {
    onSetLoadStatus: vi.fn(async () => {}), onAssignAsset: vi.fn(async () => {}), onAssignCarrier: vi.fn(async () => {}),
    onBookCarrier: vi.fn(async () => {}), onRemoveCarrier: vi.fn(async () => {}), onSetArStatus: vi.fn(async () => {}),
  },
} satisfies ShipmentActions

function renderDetail(status: ShipmentStatus = 'BOOKED') {
  render(
    <ShipmentDetail
      bundle={bundle(status)}
      customer={null}
      locations={[]}
      catalog={[]}
      pricing={null}
      marginFloorBps={null}
      requiredReferences={[]}
      credit={null}
      currentUser="ryne@bcatcorp.com"
      isAdmin={false}
      actions={actions}
    />,
  )
}

describe('ShipmentDetail', () => {
  it('opens on Summary with the shipment’s own facts', () => {
    renderDetail()
    expect(screen.getByRole('tab', { name: 'Summary' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Acme Freight')).toBeTruthy()
    expect(screen.getByText('Chicago, IL')).toBeTruthy()
    expect(screen.getByText('$2000.00')).toBeTruthy()
  })

  it('shows all five tabs and switches between them', async () => {
    renderDetail()
    for (const name of ['Summary', 'Details', 'Stops', 'Documents', 'Financials']) {
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('tab', { name: 'Stops' }))
    await waitFor(() => expect(screen.getByText('Acme Dock 4')).toBeTruthy())
    expect(screen.getByText('Globex DC')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    await waitFor(() => expect(screen.getByText('S000001-1')).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }))
    await waitFor(() => expect(screen.getByText('docs:POD')).toBeTruthy())
    expect(screen.getByText('docs:RATECON')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Financials' }))
    await waitFor(() => expect(screen.getByTestId('financial-totals')).toBeTruthy())
  })

  it('shows the draft editor instead of tabs while the shipment is a draft', () => {
    renderDetail('DRAFT')
    expect(screen.queryByRole('tab', { name: 'Summary' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Submit order' })).toBeTruthy()
  })

  it('refuses stop edits on a canceled shipment', async () => {
    renderDetail('CANCELED')
    fireEvent.click(screen.getByRole('tab', { name: 'Stops' }))
    await waitFor(() => expect((screen.getByLabelText('Stop 1 actions') as HTMLButtonElement).disabled).toBe(true))
  })
})
