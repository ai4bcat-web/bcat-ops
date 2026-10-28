// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BookCarrierDialog, type BookCarrierFields } from './BookCarrierDialog'
import type { CarrierRecord, ShipmentBundle, TmsSettings } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

// The directory answer the dialog reads; each test installs the carrier it needs before
// rendering, so one set of mocks covers both the blocked and the warned case.
const state = vi.hoisted(() => ({ carrier: null as unknown as CarrierRecord }))

vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: [state.carrier], loading: false, error: null, refresh: vi.fn(), replace: vi.fn() }),
}))

const { getTmsSettings, getCarrierBundle, bookCarrier } = vi.hoisted(() => ({
  getTmsSettings: vi.fn(),
  getCarrierBundle: vi.fn(),
  bookCarrier: vi.fn(async (_input: BookCarrierFields & { loadId: string; expectedUpdatedAt: string }) => ({})),
}))
vi.mock('@/lib/apiClient', () => ({ getTmsSettings, getCarrierBundle, bookCarrier }))

/** Only W9 and the carrier agreement are required, so the warning set is exactly two. */
const settings: TmsSettings = {
  id: 'default',
  allowedCarrierStatuses: ['ACTIVE'],
  requiredCarrierDocs: ['W9', 'CARRIER_AGREEMENT'],
  bookingRequiredFields: [],
  insuranceWarnDays: 30,
}

function carrier(patch: Partial<CarrierRecord> = {}): CarrierRecord {
  return {
    id: 'car-1',
    name: 'Reliable Freight',
    type: 'TL',
    status: 'ACTIVE',
    mcNumber: '123456',
    dotNumber: '7654321',
    authorityStatus: 'ACTIVE',
    insurancePolicies: [
      { id: 'p1', type: 'AUTO_LIABILITY', limitCents: 100_000_00, expiresAt: '2031-01-01T00:00:00.000Z' },
      { id: 'p2', type: 'CARGO', limitCents: 100_000_00, expiresAt: '2031-01-01T00:00:00.000Z' },
    ],
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

const bundle: ShipmentBundle = {
  shipment: {
    id: 'shp-1', number: 'S000001', status: 'OPEN', customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  orders: [],
  loads: [{ id: 'load-1', status: 'SOURCING', loadNumber: 'S000001-1', pickupAppt: '2026-12-01T13:00:00.000Z' }],
  loadCarriers: [],
  charges: [],
  financials: [],
}

function renderDialog() {
  return render(
    <BookCarrierDialog
      bundle={bundle}
      isAdmin={false}
      busy={false}
      onClose={vi.fn()}
      onConfirm={(input) => bookCarrier({ loadId: 'load-1', expectedUpdatedAt: bundle.shipment.updatedAt, ...input })}
      onRateCon={vi.fn()}
    />,
  )
}

/** Pick the carrier, then type the rate — the gate has nothing to judge without both. */
async function pickCarrierAndRate() {
  fireEvent.click(screen.getByText('Reliable Freight'))
  const rate = await screen.findByLabelText('Carrier rate')
  fireEvent.change(rate, { target: { value: '1500.00' } })
  fireEvent.blur(rate)
  await waitFor(() => expect(screen.getByText('Preflight')).toBeTruthy())
}

function bookButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Book' }) as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
  getTmsSettings.mockResolvedValue(settings)
  getCarrierBundle.mockImplementation(async () => ({
    carrier: state.carrier, contacts: [], paymentMethods: [], documents: [], loadCarriers: [],
  }))
})

describe('BookCarrierDialog', () => {
  it('refuses to book a carrier whose authority is inactive, and says why', async () => {
    state.carrier = carrier({ authorityStatus: 'INACTIVE' })
    renderDialog()
    await pickCarrierAndRate()

    expect(screen.getByText("The carrier's operating authority is inactive.")).toBeTruthy()
    expect(bookButton().disabled).toBe(true)
  })

  it('books only once every warning has been acknowledged', async () => {
    state.carrier = carrier()
    renderDialog()
    await pickCarrierAndRate()

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes).toHaveLength(2)
    expect(bookButton().disabled).toBe(true)

    fireEvent.click(boxes[0])
    expect(bookButton().disabled).toBe(true)

    fireEvent.click(boxes[1])
    await waitFor(() => expect(bookButton().disabled).toBe(false))

    fireEvent.click(bookButton())
    await waitFor(() => expect(bookCarrier).toHaveBeenCalledTimes(1))
    expect(bookCarrier.mock.calls[0][0]).toMatchObject({
      carrierId: 'car-1',
      carrierRateCents: 150000,
      acknowledgeWarnings: ['MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT'],
    })
  })
})
