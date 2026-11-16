// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReviewFixPanel } from './ReviewFixPanel'
import { anchorForReason, otrChecks } from './reviewFix'
import type { CustomerRecord, ShipmentBundle } from '@/types/tms'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), customers: vi.fn(), stop: vi.fn(), order: vi.fn(), customer: vi.fn(), link: vi.fn(), assign: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle: mocks.bundle,
  listCustomers: mocks.customers,
  updateStop: mocks.stop,
  updateOrderDetails: mocks.order,
  patchCustomer: mocks.customer,
  setShipmentCustomer: mocks.link,
  assignAsset: mocks.assign,
}))
vi.mock('@/hooks/useOwnFleetRoster', () => ({ useOwnFleetRoster: () => [] }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const royal = { id: 'cus-royal', name: 'THE ROYAL GROUP', billingMethod: 'FACTOR', customerType: 'BROKER', mcNumber: '123456', paymentTermsDays: 30, updatedAt: 'u1' } as CustomerRecord
// 20002's shape: Cicero, IL → Newton, IA, stop 2 has no appointment and no ZIP on the consignee.
const bundle = {
  shipment: { id: 'shp-20002', number: '20002', status: 'DELIVERED', updatedAt: 's1', customerId: 'cus-royal' },
  orders: [{ id: 'o-1', customerId: 'cus-royal', revenueCents: 165000, references: [{ code: 'PO', value: 'FR-113188-3', level: 'ORDER', visibility: 'CUSTOMER' }] }],
  loads: [{ id: 'load-1', updatedAt: 'l1', stops: [
    { id: 's1', type: 'pickup', name: 'SHIPPER', city: 'CICERO, IL', address: { city: 'CICERO', state: 'IL', zip: '60804' }, appt: '2026-11-09T14:00:00.000Z', sequence: 0, driverId: null },
    { id: 's2', type: 'delivery', name: 'CONSIGNEE', city: 'NEWTON, IA', address: { city: 'NEWTON', state: 'IA', zip: null }, appt: '', sequence: 1, driverId: null },
  ] }],
  loadCarriers: [{ id: 'lc-1', status: 'ACTIVE', kind: 'CARRIER' }],
  charges: [],
  financials: [],
  documents: [{ id: 'd1', type: 'RATE_CON', status: 'ACTIVE', reviewStatus: 'APPROVED' }],
} as unknown as ShipmentBundle

beforeEach(() => {
  mocks.bundle.mockResolvedValue(bundle)
  mocks.customers.mockResolvedValue([royal])
  mocks.stop.mockResolvedValue(bundle)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ReviewFixPanel', () => {
  it('edits the stop 2 appointment in the rail through UPDATE_STOP (no "Fix in stops tab")', async () => {
    const onSaved = vi.fn()
    render(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set(['STOP_INCOMPLETE'])} onSaved={onSaved} />)
    const appt = await screen.findByLabelText('Stop 2 appointment')
    fireEvent.change(appt, { target: { value: '2026-11-10T09:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save appointment' }))
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled())
    expect(mocks.stop.mock.calls[0][0]).toMatchObject({ loadId: 'load-1', expectedUpdatedAt: 'l1', op: 'SET_APPT', stopId: 's2', patch: { apptType: 'exact' } })
    expect(mocks.stop.mock.calls[0][0].patch.appt).toMatch(/^2026-11-10T1[45]:00:00/)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('saves a stop ZIP with the location kept', async () => {
    render(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set()} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Stop 2 ZIP'), { target: { value: '50208' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save location' }))
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled())
    expect(mocks.stop.mock.calls[0][0]).toMatchObject({ op: 'SET_LOCATION', stopId: 's2', patch: { name: 'CONSIGNEE', city: 'NEWTON, IA', address: { city: 'NEWTON', state: 'IA', zip: '50208' } } })
  })

  it('shows the OTR checklist for a factored customer, flagging the consignee ZIP and the POD', async () => {
    render(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set()} onSaved={vi.fn()} />)
    const list = await screen.findByTestId('otr-checklist')
    expect(list.textContent).toContain('Consignee ZIP')
    expect(list.querySelectorAll('.lr-chip-bad')).toHaveLength(2)
    expect([...list.querySelectorAll('.lr-chip-bad')].map((li) => li.textContent)).toEqual(['Consignee ZIPFix', 'POD on fileFix'])
  })

  it('writes the PO as a customer-visible order reference', async () => {
    mocks.order.mockResolvedValue(bundle)
    render(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set(['FACTOR_PO_MISSING'])} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Customer ref (PO)'), { target: { value: 'FR-999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save PO' }))
    await waitFor(() => expect(mocks.order).toHaveBeenCalled())
    expect(mocks.order.mock.calls[0][0]).toEqual({ shipmentId: 'shp-20002', expectedUpdatedAt: 's1', order: { references: [{ code: 'PO', value: 'FR-999', level: 'ORDER', visibility: 'CUSTOMER' }] } })
  })
})

describe('reviewFix helpers', () => {
  it('sends every former "open tab" reason to an editor in the rail', () => {
    expect(anchorForReason('STOP_INCOMPLETE', 'stops')).toBe('stops')
    expect(anchorForReason('FACTOR_DELIVERY_ZIP', 'stops')).toBe('stops')
    expect(anchorForReason('NO_CUSTOMER', 'overview')).toBe('customer')
    expect(anchorForReason('FACTOR_CUSTOMER_MC', 'overview')).toBe('customer')
    expect(anchorForReason('FACTOR_PO_MISSING', 'overview')).toBe('ref')
    expect(anchorForReason('REFERENCE_MISSING', 'overview')).toBe('ref')
    expect(anchorForReason('DOC_MISSING', 'documents')).toBe('documents')
    expect(anchorForReason('EXPENSE_MISSING', 'carrierPay')).toBe('charges')
    expect(anchorForReason('NOT_DELIVERED', 'tracking')).toBe('stops')
    expect(anchorForReason('DRIVER_MISSING', 'carrier')).toBe('driver')
  })

  it('asks nothing of a customer billed manually', () => {
    expect(otrChecks(bundle, { ...royal, billingMethod: 'MANUAL' })).toEqual([])
  })
})
