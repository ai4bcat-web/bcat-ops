// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { BookCarrierDialog, type BookCarrierFields } from './BookCarrierDialog'
import type { CarrierRecord, ShipmentBundle, TmsSettings, UserProfileRecord } from '@/types/tms'

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
// The own-fleet roster: our Driver records, their trucks and the truck's work phone.
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({
    drivers: [
      { id: 'd1', name: 'Alvaro Ruiz', phone: '+13125550101', active: true, assignedTruckId: 't1', assignedTrailerId: 'tr1' },
      { id: 'd2', name: 'Gone Driver', phone: '', active: false },
    ],
  }),
}))
vi.mock('@/hooks/useTrucks', () => ({
  useTrucks: () => ({
    equipment: [
      { id: 't1', type: 'truck', unitNumber: '12', active: true },
      { id: 'tr1', type: 'trailer', unitNumber: 'R-7', active: true },
    ],
  }),
}))
vi.mock('@/hooks/useTruckConfigs', () => ({
  useTruckConfigs: () => ({ byId: new Map([['t1', { truckId: 't1', unitNumber: '12', phone: '+13125550100' }]]) }),
}))
// The carrier-rep field is a RepPicker, so the dialog reads the staff directory.
const staff = vi.hoisted(() => [
  {
    id: 'dana@bcatcorp.com', email: 'dana@bcatcorp.com', name: 'Dana Carr', role: 'CARRIER_REP',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1,
  },
] as UserProfileRecord[])
vi.mock('@/lib/apiClient', () => ({
  getTmsSettings, getCarrierBundle, bookCarrier, listUserProfiles: vi.fn(async () => staff),
}))

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

function renderDialog(initial?: Partial<BookCarrierFields>) {
  return render(
    <BookCarrierDialog
      bundle={bundle}
      isAdmin={false}
      busy={false}
      onClose={vi.fn()}
      onConfirm={(input) => bookCarrier({ loadId: 'load-1', expectedUpdatedAt: bundle.shipment.updatedAt, ...input })}
      onRateCon={vi.fn()}
      initial={initial}
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

  it('sends the picked carrier rep with the booking', async () => {
    state.carrier = carrier()
    renderDialog()
    await pickCarrierAndRate()

    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    fireEvent.click(screen.getByRole('tab', { name: '3. Dispatch' }))
    fireEvent.click(await screen.findByText('Pick a carrier rep…'))
    fireEvent.click(await screen.findByRole('option', { name: /Dana Carr/ }))

    await waitFor(() => expect(bookButton().disabled).toBe(false))
    fireEvent.click(bookButton())
    await waitFor(() => expect(bookCarrier).toHaveBeenCalledTimes(1))
    expect(bookCarrier.mock.calls[0][0]).toMatchObject({ carrierRepId: 'dana@bcatcorp.com' })
  })

  it('opens prefilled from the shipment form but still gates on the preflight warnings', async () => {
    state.carrier = carrier()
    renderDialog({
      carrierId: 'car-1',
      carrierRateCents: 150000,
      charges: [{ side: 'CARRIER', code: 'LUMPER', calculatedBy: 'FLAT', rateCents: 7500, count: 1 }],
      driverName: 'Sam Roe',
      truckNumber: 'T-9',
    })

    // Straight to the Money step with the typed rate in place — no re-picking.
    expect((await screen.findByLabelText('Carrier rate') as HTMLInputElement).value).toBe('1500.00')
    await waitFor(() => expect(screen.getByText('Preflight')).toBeTruthy())
    expect(bookButton().disabled).toBe(true)

    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    await waitFor(() => expect(bookButton().disabled).toBe(false))
    fireEvent.click(bookButton())
    await waitFor(() => expect(bookCarrier).toHaveBeenCalledTimes(1))
    expect(bookCarrier.mock.calls[0][0]).toMatchObject({
      carrierId: 'car-1',
      carrierRateCents: 150000,
      driverName: 'Sam Roe',
      truckNumber: 'T-9',
      charges: [expect.objectContaining({ side: 'CARRIER', code: 'LUMPER', rateCents: 7500 })],
    })
  })

  it('offers "Find & invite a carrier" on the pick step, and carries the load and the typed search to the Find & Invite page', async () => {
    state.carrier = carrier()
    const onClose = vi.fn()
    const Where = () => <p data-testid="where">{useLocation().pathname + useLocation().search}</p>
    render(
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<><Where /><BookCarrierDialog bundle={bundle} isAdmin={false} busy={false} onClose={onClose} onConfirm={vi.fn()} onRateCon={vi.fn()} /></>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('Search carriers'), { target: { value: 'Ivan Cartage' } })
    fireEvent.click(screen.getByRole('button', { name: /Find & invite a carrier/ }))

    const where = screen.getByTestId('where').textContent!
    expect(where.startsWith('/tms/carriers/find?')).toBe(true)
    const params = new URLSearchParams(where.split('?')[1])
    expect(params.get('shipmentId')).toBe('shp-1')
    expect(params.get('loadId')).toBe('load-1')
    expect(params.get('q')).toBe('Ivan Cartage')
    expect(onClose).toHaveBeenCalled()
    await act(async () => {})
  })

  describe('Ivan Cartage (own fleet)', () => {
    async function toDispatchStep() {
      state.carrier = carrier({ name: 'Ivan Cartage' })
      renderDialog()
      fireEvent.click(screen.getByText('Ivan Cartage'))
      const rate = await screen.findByLabelText('Carrier rate')
      fireEvent.change(rate, { target: { value: '0.00' } })
      fireEvent.blur(rate)
      await waitFor(() => expect(screen.getByText('Preflight')).toBeTruthy())
      for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
      fireEvent.click(screen.getByRole('tab', { name: '3. Dispatch' }))
      // The Dispatch step mounts the RepPicker, which loads the staff directory.
      await act(async () => {})
    }

    it('takes the driver from the roster only: a select, no typed driver, phone, truck or trailer', async () => {
      await toDispatchStep()
      const picker = await screen.findByLabelText('Driver') as HTMLSelectElement
      expect(picker.tagName).toBe('SELECT')
      expect([...picker.options].map((o) => o.text)).toEqual(['Pick a driver', 'Alvaro Ruiz · Truck 12 · Trailer R-7 · (312) 555-0100'])
      for (const label of ['Driver phone', 'Truck #', 'Trailer #']) expect(screen.queryByLabelText(label)).toBeNull()
    })

    it('will not book without a driver, then sends the driver id with the numbers the record filled', async () => {
      await toDispatchStep()
      await waitFor(() => expect(bookButton().disabled).toBe(false))
      fireEvent.click(bookButton())
      expect(await screen.findByText('Pick the driver from our driver list.')).toBeTruthy()
      expect(bookCarrier).not.toHaveBeenCalled()

      fireEvent.change(screen.getByLabelText('Driver'), { target: { value: 'd1' } })
      fireEvent.click(bookButton())
      await waitFor(() => expect(bookCarrier).toHaveBeenCalledTimes(1))
      const sent = bookCarrier.mock.calls[0][0] as Record<string, unknown>
      expect(sent).toMatchObject({ driverId: 'd1', driverPhone: '+13125550100', truckNumber: '12', trailerNumber: 'R-7' })
      expect(sent).not.toHaveProperty('driverName')
    })
  })
})
