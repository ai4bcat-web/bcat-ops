// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { ReviewFixPanel } from './ReviewFixPanel'
import { RailSaveContext, runPendingSaves, type PendingSave, type RailSaveRegistry } from './railSave'
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

/** The drawer's part of the rail save: a registry and one Save changes button. */
function Rail({ children }: { children: ReactNode }) {
  const pending = useRef(new Map<string, PendingSave>())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const [, setCount] = useState(0)
  const registry = useMemo<RailSaveRegistry>(() => ({
    set: (key, save) => { if (save) pending.current.set(key, save); else pending.current.delete(key); setCount(pending.current.size) },
    errorOf: (key) => errors.get(key) ?? null,
  }), [errors])
  return <RailSaveContext.Provider value={registry}>
    {children}
    <button type="button" onClick={() => void runPendingSaves(new Map(pending.current)).then(setErrors)}>Save changes</button>
  </RailSaveContext.Provider>
}
const inRail = (ui: ReactNode) => render(<Rail>{ui}</Rail>)

beforeEach(() => {
  mocks.bundle.mockResolvedValue(bundle)
  mocks.customers.mockResolvedValue([royal])
  mocks.stop.mockResolvedValue(bundle)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ReviewFixPanel', () => {
  it('edits the stop 2 appointment in the rail through UPDATE_STOP (no "Fix in stops tab")', async () => {
    const onSaved = vi.fn()
    inRail(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set(['STOP_INCOMPLETE'])} onSaved={onSaved} />)
    const appt = await screen.findByLabelText('Stop 2 appointment')
    fireEvent.change(appt, { target: { value: '2026-11-10T09:00' } })
    expect(screen.getAllByTestId('lr-unsaved').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled())
    expect(mocks.stop.mock.calls[0][0]).toMatchObject({ loadId: 'load-1', expectedUpdatedAt: 'l1', op: 'SET_APPT', stopId: 's2', patch: { apptType: 'exact' } })
    expect(mocks.stop.mock.calls[0][0].patch.appt).toMatch(/^2026-11-10T1[45]:00:00/)
  })

  it('saves a stop ZIP with the location kept', async () => {
    inRail(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set()} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Stop 2 ZIP'), { target: { value: '50208' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled())
    expect(mocks.stop.mock.calls[0][0]).toMatchObject({ op: 'SET_LOCATION', stopId: 's2', patch: { name: 'CONSIGNEE', city: 'NEWTON, IA', address: { city: 'NEWTON', state: 'IA', zip: '50208' } } })
  })

  it('shows the OTR checklist for a factored customer, flagging the POD and asking no ZIP (OTR v2 takes none)', async () => {
    render(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set()} onSaved={vi.fn()} />)
    const list = await screen.findByTestId('otr-checklist')
    expect(list.textContent).not.toContain('ZIP')
    expect([...list.querySelectorAll('.lr-chip-bad')].map((li) => li.textContent)).toEqual(['POD on fileFix'])
  })

  it('writes the PO as a customer-visible order reference', async () => {
    mocks.order.mockResolvedValue(bundle)
    inRail(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set(['FACTOR_PO_MISSING'])} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Customer ref (PO)'), { target: { value: 'FR-999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.order).toHaveBeenCalled())
    expect(mocks.order.mock.calls[0][0]).toEqual({ shipmentId: 'shp-20002', expectedUpdatedAt: 's1', order: { references: [{ code: 'PO', value: 'FR-999', level: 'ORDER', visibility: 'CUSTOMER' }] } })
  })

  it('saves a customer billing-method change as a patch (ICAT: Manual → Factor), with the PO and a stop in one Save', async () => {
    const icat = { id: 'cus-icat', name: 'ICAT LOGISTICS, INC', billingMethod: 'MANUAL', customerType: null, mcNumber: '468137', apEmail: 'apinvoices@icatlogistics.com', paymentTermsDays: 30, updatedAt: 'c1' } as unknown as CustomerRecord
    mocks.customers.mockResolvedValue([icat])
    mocks.bundle.mockResolvedValue({ ...bundle, shipment: { ...bundle.shipment, customerId: 'cus-icat' }, orders: [{ ...bundle.orders[0], customerId: 'cus-icat' }] })
    mocks.customer.mockResolvedValue({ ...icat, billingMethod: 'FACTOR', updatedAt: 'c2' })
    mocks.order.mockResolvedValue(bundle)
    inRail(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set(['FACTOR_BILLING_METHOD'])} onSaved={vi.fn()} />)
    await screen.findByText(/These change ICAT LOGISTICS/)
    fireEvent.change(screen.getByLabelText('Billing method'), { target: { value: 'FACTOR' } })
    fireEvent.change(screen.getByLabelText('Customer ref (PO)'), { target: { value: '1118019-B' } })
    fireEvent.change(screen.getByLabelText('Stop 2 ZIP'), { target: { value: '50208' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled())
    // Only the edited field goes up, and the customer saves first.
    expect(mocks.customer).toHaveBeenCalledWith('cus-icat', { billingMethod: 'FACTOR', changeReason: 'Load Review', changeSource: 'LOAD_REVIEW' }, 'c1')
    expect(mocks.customer.mock.invocationCallOrder[0]).toBeLessThan(mocks.order.mock.invocationCallOrder[0])
    expect(mocks.order.mock.invocationCallOrder[0]).toBeLessThan(mocks.stop.mock.invocationCallOrder[0])
  })

  it('keeps a failed section edited and shows a plain-English error while the others save', async () => {
    mocks.order.mockRejectedValue(new Error('The shipment changed since you loaded it (version)'))
    inRail(<ReviewFixPanel shipmentId="shp-20002" readOnly={false} busy={false} failing={new Set()} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Customer ref (PO)'), { target: { value: 'FR-999' } })
    fireEvent.change(screen.getByLabelText('Stop 2 ZIP'), { target: { value: '50208' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled())
    expect(await screen.findByText(/Customer ref \(PO\) could not be saved because someone else changed it/)).toBeTruthy()
    expect((screen.getByLabelText('Customer ref (PO)') as HTMLInputElement).value).toBe('FR-999')
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
