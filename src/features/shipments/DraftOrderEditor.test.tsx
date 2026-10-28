// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DraftOrderEditor } from './components/DraftOrderEditor'
import type { CreditSummary } from '@/lib/customerCredit'
import type { OrderRecord, RequiredReference, ShipmentBundle, ShipmentLoad, ShipmentRecord } from '@/types/tms'
import type { Stop } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const shipment: ShipmentRecord = {
  id: 'shp-1', number: 'S000001', status: 'DRAFT', customerId: 'cust-1', customerName: 'Acme Freight',
  mode: 'FTL', source: 'MANUAL', createdBy: 'a@b.c', updatedBy: 'a@b.c',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const order: OrderRecord = {
  id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', mode: 'FTL', equipmentType: "53' Dry Van",
  references: [], freight: [], createdBy: 'a@b.c', updatedBy: 'a@b.c',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const stops: Stop[] = [
  { id: 'p1', type: 'pickup', sequence: 0, appt: '2026-04-01T13:00:00.000Z', driverId: null, name: 'Acme Dock 4', city: 'Chicago, IL' },
  { id: 'd1', type: 'delivery', sequence: 1, appt: '2026-04-02T13:00:00.000Z', driverId: null, name: 'Globex DC', city: 'Dallas, TX' },
]

const load: ShipmentLoad = { id: 'load-1', stops, miles: 900, status: 'SOURCING' }

function bundle(patch: Partial<ShipmentBundle> = {}): ShipmentBundle {
  return { shipment, orders: [order], loads: [load], loadCarriers: [], charges: [], financials: [], ...patch }
}

const credit: CreditSummary = {
  policy: {
    creditLimitCents: 500000, freeCreditRequired: false, creditUsageWarningBps: 8000, maxDaysLate: 60,
    source: { creditLimitCents: 'customer', freeCreditRequired: 'org', creditUsageWarningBps: 'org', maxDaysLate: 'org' },
  },
  byBucket: { OPEN: 0, ACTIVE: 0, DELIVERED: 0, INVOICED: 0 },
  usedCents: 0, availableCents: 500000, usageBps: 0, warning: false, hold: false, blockReasons: [],
}

function renderEditor(over: Partial<React.ComponentProps<typeof DraftOrderEditor>> = {}) {
  const onSaveForm = vi.fn(async () => {})
  const onSubmit = vi.fn(async () => {})
  render(
    <DraftOrderEditor
      bundle={bundle()}
      customer={null}
      requiredReferences={[]}
      catalog={[]}
      pricing={null}
      marginFloorBps={null}
      locations={[]}
      credit={credit}
      currentUser="ryne@bcatcorp.com"
      onSaveForm={onSaveForm}
      onSubmit={onSubmit}
      onStopAction={vi.fn(async () => {})}
      onSaveCharges={vi.fn(async () => {})}
      {...over}
    />,
  )
  return { onSaveForm, onSubmit }
}

describe('DraftOrderEditor', () => {
  it('renders every section of the truckload draft', () => {
    renderEditor()
    for (const title of ['General', 'Stops', 'Shipment contents', 'Financials', 'References', 'Notes', 'Equipment + Driver']) {
      expect(screen.getByText(title)).toBeTruthy()
    }
  })

  it('drops the Equipment + Driver section for a non-truckload mode', async () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'LTL' } })
    await waitFor(() => expect(screen.queryByText('Equipment + Driver')).toBeNull())
  })

  it('submits a complete draft', async () => {
    const { onSaveForm, onSubmit } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Submit order' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(undefined))
    // Submit re-saves first so the server never scores a stale draft.
    expect(onSaveForm).toHaveBeenCalled()
  })

  it('blocks submit and names the problem when a delivery stop is missing', async () => {
    const onlyPickup = bundle({ loads: [{ ...load, stops: [stops[0]] }] })
    const { onSubmit } = renderEditor({ bundle: onlyPickup })

    expect(screen.getByText('Add at least one delivery stop.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Submit order' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Submit order' }))
    await waitFor(() => expect(onSubmit).not.toHaveBeenCalled())
  })

  it('blocks submit until a required reference is supplied', async () => {
    const required: RequiredReference[] = [{ code: 'PO', label: 'PO number', level: 'ORDER', display: true, countOnNewOrder: 1 }]
    renderEditor({ requiredReferences: required })

    expect(screen.getByText('PO number: 1 value required, 0 entered.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Submit order' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }))
    fireEvent.change(screen.getByLabelText('Reference code 1'), { target: { value: 'PO' } })
    fireEvent.change(screen.getByLabelText('Reference value 1'), { target: { value: '4471' } })

    await waitFor(() => expect((screen.getByRole('button', { name: 'Submit order' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('blocks submit when the truckload equipment type is cleared', async () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('Equipment type'), { target: { value: '' } })

    await waitFor(() => expect(screen.getByText('Truckload orders need an equipment type.')).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Submit order' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('autosaves the draft when a field loses focus', async () => {
    const { onSaveForm } = renderEditor()
    const costCenter = screen.getByLabelText('Cost center')
    fireEvent.change(costCenter, { target: { value: 'CC-12' } })
    fireEvent.blur(costCenter)

    await waitFor(() => expect(onSaveForm).toHaveBeenCalledWith(expect.objectContaining({ costCenter: 'CC-12' })))
  })

  it('passes the carrier rep through the assign variant of submit', async () => {
    const { onSubmit } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Submit and assign to a carrier rep' }))

    await waitFor(() => expect(screen.getByLabelText('Carrier rep')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Carrier rep'), { target: { value: 'rep@bcatcorp.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit and assign' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('rep@bcatcorp.com'))
  })

  it('warns when the order is larger than the available credit', () => {
    const short: CreditSummary = { ...credit, availableCents: 10000 }
    renderEditor({
      bundle: bundle({
        charges: [{
          id: 'ch-1', shipmentId: 'shp-1', side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT',
          rateCents: 200000, amountCents: 200000, isRate: true, sortOrder: 0,
          createdBy: 'a@b.c', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }),
      credit: short,
    })
    expect(screen.getByText('Order exceeds available credit — submit will be refused.')).toBeTruthy()
  })
})
