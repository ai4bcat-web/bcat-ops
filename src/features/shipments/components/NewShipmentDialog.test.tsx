// @vitest-environment jsdom
/**
 * The one creation door.
 *
 * Three things have to hold here and nothing in the type system catches any of them.
 * A shipment number comes off an atomic counter and can only be voided, so raising this
 * form must write NOTHING — the drawer's old create mode minted the record on open-then-
 * save and every abandoned form left a dead permanent number behind. A broker no
 * directory record matches has to be recordable as typed text without a Customer record
 * being invented for it. And the side effects that used to hang off `addLoad` and the
 * drawer's create branch — the Batory appointment ladder and intake linking — have to
 * still run, because deleting the create path would otherwise drop them silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store/useAppStore'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const createShipmentMock = vi.fn()
const createApptTaskMock = vi.fn(async () => ({}))
const updateIntakeItemMock = vi.fn(async () => ({}))
const notifySlackStatusChangeMock = vi.fn()
// A stop typed off a tender is filed in the directory on the way out, and the dialog puts
// the new record's id on the stop — so this has to answer with one.
const createLocationMock = vi.fn(async (_input: unknown) => ({ id: 'loc-filed-1' }))
const updateLoadMock = vi.fn(async (_id: string, _patch: Record<string, unknown>) => ({}))
const notifyApptNeededMock = vi.fn(async (_input: unknown) => 'ts-appts-1')
const createApptMoveTaskMock = vi.fn(async (_input: unknown) => ({ id: 'task-move-1' }))

vi.mock('@/lib/apiClient', () => ({
  createShipment: (...a: unknown[]) => createShipmentMock(...a),
  createApptTask: (...a: unknown[]) => createApptTaskMock(...(a as [])),
  updateIntakeItem: (...a: unknown[]) => updateIntakeItemMock(...(a as [])),
  notifySlackStatusChange: (...a: unknown[]) => notifySlackStatusChangeMock(...a),
  createLocation: (...a: unknown[]) => createLocationMock(...(a as [unknown])),
  updateLoad: (...a: unknown[]) => updateLoadMock(...(a as [string, Record<string, unknown>])),
  notifyApptNeeded: (...a: unknown[]) => notifyApptNeededMock(...(a as [unknown])),
  createApptMoveTask: (...a: unknown[]) => createApptMoveTaskMock(...(a as [unknown])),
  getTmsSettings: async () => null,
}))

// The detail is a whole page of its own; the only thing these tests care about is THAT it
// is what a created shipment hands over to, never the load drawer.
vi.mock('./ShipmentDrawer', () => ({
  ShipmentDrawer: ({ shipmentId }: { shipmentId: string | null }) =>
    shipmentId ? <div data-testid="shipment-detail">{shipmentId}</div> : null,
}))

const addCustomerMock = vi.fn()
const BATORY = {
  id: 'cust-batory', name: 'BATORY FOODS INC', status: 'ACTIVE', active: true,
  createdAt: '2024-01-01T00:00:00.000Z', apptWorkflow: 'BATORY', factored: false,
}
const AXLE = {
  id: 'cust-axle', name: 'Axle Logistics, LLC', status: 'ACTIVE', active: true,
  createdAt: '2024-01-01T00:00:00.000Z', apptWorkflow: null, factored: false,
}
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({
    customers: [BATORY, AXLE], locations: [], loading: false, error: null,
    refresh: vi.fn(), addCustomer: addCustomerMock, addLocation: vi.fn(),
    saveCustomer: vi.fn(), saveLocation: vi.fn(),
    archiveCustomer: vi.fn(), archiveLocation: vi.fn(),
  }),
}))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
/*
 * `useLoads` is deliberately NOT mocked: it reads the real store, and the store being
 * EMPTY at the moment the effects run is the condition the tests below are about.
 */
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'ryne@bcatcorp.com' }, isAdmin: true, isOwner: true }),
  useAuthUser: () => ({ email: 'ryne@bcatcorp.com' }),
}))

const { NewShipmentDialog } = await import('./NewShipmentDialog')

const bundleFor = (over: Record<string, unknown> = {}) => ({
  shipment: { id: 'shp-9', number: 'BC100100', customerName: 'BATORY FOODS INC' },
  orders: [{ id: 'ord-9' }],
  loads: [{ id: 'load-9', aljexId: 'BC100100-1', pickupAppt: '2026-10-09T17:00:00.000Z' }],
  ...over,
})

beforeEach(() => {
  createShipmentMock.mockReset()
  createShipmentMock.mockResolvedValue(bundleFor())
  createApptTaskMock.mockClear()
  updateIntakeItemMock.mockClear()
  notifySlackStatusChangeMock.mockClear()
  addCustomerMock.mockClear()
  updateLoadMock.mockClear()
  notifyApptNeededMock.mockClear()
  createApptMoveTaskMock.mockClear()
  // No `onCreateLoad` has been delivered yet — the state a create actually starts from.
  useAppStore.setState({ loads: [] })
})

/** The form is a Radix Dialog, so everything is portalled out of the render container. */
const inputs = () => [...document.body.querySelectorAll('input')]
const save = () => fireEvent.click(screen.getByRole('button', { name: /create shipment/i }))

/** Pick a customer record the way the directory combobox is actually driven: type, pick. */
const pickCustomer = (name: string) => {
  const box = screen.getByPlaceholderText('Select customer…')
  fireEvent.focus(box)
  fireEvent.change(box, { target: { value: name.slice(0, 5) } })
  fireEvent.click(screen.getByText(name))
}

/** Both stops need a date before the form will validate. */
const fillStopDates = (date: string) => {
  for (const el of inputs().filter((i) => i.type === 'date')) {
    fireEvent.change(el, { target: { value: date } })
  }
}

describe('nothing is written until Save', () => {
  it('writes nothing when the form is merely opened', () => {
    render(<NewShipmentDialog open onClose={vi.fn()} />)
    expect(screen.getByText('New shipment')).toBeTruthy()
    expect(createShipmentMock).not.toHaveBeenCalled()
  })

  it('writes nothing when the form is abandoned', () => {
    const onClose = vi.fn()
    const { rerender } = render(<NewShipmentDialog open onClose={onClose} />)
    pickCustomer('Axle Logistics, LLC')
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    rerender(<NewShipmentDialog open={false} onClose={onClose} />)
    expect(createShipmentMock).not.toHaveBeenCalled()
  })

  it('creates exactly once on Save and opens the shipment detail', async () => {
    render(<NewShipmentDialog open onClose={vi.fn()} prefill={{ dateStr: '2026-10-09' }} />)
    pickCustomer('Axle Logistics, LLC')
    fillStopDates('2026-10-09')
    save()

    await waitFor(() => expect(createShipmentMock).toHaveBeenCalledTimes(1))
    expect(createShipmentMock.mock.calls[0][0]).toMatchObject({ customerId: 'cust-axle', source: 'MANUAL' })
    await waitFor(() => expect(screen.getByTestId('shipment-detail').textContent).toBe('shp-9'))
  })
})

describe('a broker no record matches', () => {
  /*
   * The whole reason `Shipment.customerId` became optional. Inventing a Customer record
   * from typed text puts a name nobody verified onto an invoice; refusing to record the
   * freight at all was what produced the orphan loads this cutover deleted.
   */
  it('sends customerName, no customerId, and creates no Customer record', async () => {
    render(<NewShipmentDialog open onClose={vi.fn()} prefill={{ dateStr: '2026-10-09' }} />)
    fireEvent.click(screen.getByText(/No matching customer/i))
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'Someone Freight Co' } })
    fillStopDates('2026-10-09')
    save()

    await waitFor(() => expect(createShipmentMock).toHaveBeenCalledTimes(1))
    const input = createShipmentMock.mock.calls[0][0] as Record<string, unknown>
    expect(input.customerName).toBe('Someone Freight Co')
    expect('customerId' in input).toBe(false)
    expect(addCustomerMock).not.toHaveBeenCalled()
  })

  it('says the shipment will read as customer-not-linked', () => {
    render(<NewShipmentDialog open onClose={vi.fn()} />)
    fireEvent.click(screen.getByText(/No matching customer/i))
    expect(screen.getByText(/Customer not linked/)).toBeTruthy()
  })

  it('refuses to save with neither a record nor typed text', () => {
    render(<NewShipmentDialog open onClose={vi.fn()} prefill={{ dateStr: '2026-10-09' }} />)
    fillStopDates('2026-10-09')
    save()
    expect(createShipmentMock).not.toHaveBeenCalled()
  })
})

describe('the Batory appointment ladder survives the cutover', () => {
  /*
   * Batory bookings go through request-and-confirm: Dennis asks for a time, the shipper
   * grants it, two screenshots evidence it. The stop statuses start the ladder and the two
   * tasks chase it — both used to live inside `addLoad`.
   */
  it('starts the stops on the ladder and raises both appointment tasks', async () => {
    render(<NewShipmentDialog open onClose={vi.fn()} prefill={{ dateStr: '2026-10-09' }} />)
    pickCustomer('BATORY FOODS INC')
    fillStopDates('2026-10-09')
    save()

    await waitFor(() => expect(createShipmentMock).toHaveBeenCalledTimes(1))
    const input = createShipmentMock.mock.calls[0][0] as { load: { stops: Array<{ type: string; apptStatus?: string }> } }
    expect(input.load.stops.find((s) => s.type === 'pickup')?.apptStatus).toBe('need_request')
    expect(input.load.stops.find((s) => s.type === 'delivery')?.apptStatus).toBe('need_book')

    await waitFor(() => expect(createApptTaskMock).toHaveBeenCalledTimes(2))
    const kinds = createApptTaskMock.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual(['request_pickup', 'pick_delivery_time'])
  })

  it('raises no appointment tasks for anyone else', async () => {
    render(<NewShipmentDialog open onClose={vi.fn()} prefill={{ dateStr: '2026-10-09' }} />)
    pickCustomer('Axle Logistics, LLC')
    fillStopDates('2026-10-09')
    save()

    await waitFor(() => expect(createShipmentMock).toHaveBeenCalledTimes(1))
    expect(createApptTaskMock).not.toHaveBeenCalled()
  })
})

describe('an intake-built shipment closes its intake item', () => {
  it('marks the item DONE, links the load and carries the PRO', async () => {
    render(
      <NewShipmentDialog
        open
        onClose={vi.fn()}
        prefill={{ dateStr: '2026-10-09', intakeItemId: 'intake-3' }}
      />,
    )
    pickCustomer('Axle Logistics, LLC')
    fillStopDates('2026-10-09')
    save()

    await waitFor(() => expect(updateIntakeItemMock).toHaveBeenCalledTimes(1))
    expect(updateIntakeItemMock.mock.calls[0]).toEqual([
      'intake-3',
      { builtLoadId: 'load-9', status: 'DONE', proNumber: 'BC100100-1' },
    ])
    expect(notifySlackStatusChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({ intakeItemId: 'intake-3', newStatus: 'DONE', proNumber: 'BC100100-1' }),
    )
  })

  it('leaves intake alone when the form was not opened from an item', async () => {
    render(<NewShipmentDialog open onClose={vi.fn()} prefill={{ dateStr: '2026-10-09' }} />)
    pickCustomer('Axle Logistics, LLC')
    fillStopDates('2026-10-09')
    save()

    await waitFor(() => expect(createShipmentMock).toHaveBeenCalledTimes(1))
    expect(updateIntakeItemMock).not.toHaveBeenCalled()
  })
})

/**
 * Moved here from LoadDrawer.render.test.tsx with the behaviour it covers.
 *
 * Build Load prefills the stop details off the tender — but a Batory tender must arrive
 * with its appointments blank. Their bookings go through the request-and-confirm ladder, so
 * a date lifted off the tender is a time nobody agreed, sitting in the exact field that
 * ladder exists to fill, and the shipment reads as booked when nothing has been booked. The
 * facility and city still prefill, because that part is not in dispute — only the
 * appointment and the facility instructions, which the ladder also establishes by hand.
 */
const tenderFor = (customer: string, customerId?: string) => ({
  format: 'E2OPEN' as const,
  reference: '208663813',
  pickupNumber: 'SO-77',
  customer,
  ...(customerId ? { customerId } : {}),
  stops: [
    {
      type: 'pickup' as const, name: "BATORY'S OAKLEY", street: '2234 W 43RD STREET',
      city: 'CHICAGO', state: 'IL', zip: '60609', dateStr: '2026-10-09', time: '08:00',
      instructions: 'Appointments required',
    },
    {
      type: 'delivery' as const, name: 'MIDWEST FOODS', street: '1 MAIN ST',
      city: 'DES MOINES', state: 'IA', zip: '50301', dateStr: '2026-10-10', time: '14:00',
      instructions: '48 Hour Notice',
    },
  ],
})

const renderWithTender = (customer: string, customerId?: string) =>
  render(
    <NewShipmentDialog
      open
      onClose={vi.fn()}
      prefill={{ dateStr: '2026-10-09', tender: tenderFor(customer, customerId) }}
    />,
  )

const fieldValues = (type: string) => inputs().filter((el) => el.type === type).map((el) => el.value)

const textValues = () => [
  ...inputs().filter((el) => el.type === 'text').map((el) => el.value),
  ...[...document.body.querySelectorAll('textarea')].map((el) => el.value),
]

describe('tender prefill, Batory vs everyone else', () => {
  it('prefills the booked appointment date and time for a non-Batory tender', () => {
    renderWithTender('Axle Logistics, LLC', AXLE.id)
    // The appointment is a date input plus a time input, not one datetime field.
    expect(fieldValues('date')).toEqual(expect.arrayContaining(['2026-10-09', '2026-10-10']))
    expect(fieldValues('time')).toEqual(expect.arrayContaining(['08:00', '14:00']))
  })

  it('prefills the facility, city and instructions for a non-Batory tender', () => {
    renderWithTender('Axle Logistics, LLC', AXLE.id)
    const values = textValues()
    expect(values).toContain("BATORY'S OAKLEY")
    expect(values).toContain('DES MOINES, IA')
    expect(values.join('\n')).toContain('48 Hour Notice')
  })

  it('leaves every appointment date and time blank for a Batory tender', () => {
    renderWithTender('BATORY FOODS INC', BATORY.id)
    // Nothing carried over at all — not the tender's times, not even the plan date.
    expect(fieldValues('date').filter(Boolean)).toEqual([])
    expect(fieldValues('time').filter(Boolean)).toEqual([])
  })

  it('still prefills the Batory facility and city — only the appointment is withheld', () => {
    renderWithTender('BATORY FOODS INC', BATORY.id)
    const values = textValues()
    expect(values).toContain("BATORY'S OAKLEY")
    expect(values).toContain('CHICAGO, IL')
  })

  it('withholds the facility instructions on a Batory tender', () => {
    renderWithTender('BATORY FOODS INC', BATORY.id)
    expect(textValues().join('\n')).not.toContain('48 Hour Notice')
  })

  it('says why the Batory appointments are blank, so nobody hunts for the date', () => {
    renderWithTender('BATORY FOODS INC', BATORY.id)
    expect(screen.getByText(/Batory load/i)).toBeTruthy()
  })

  it('says nothing about Batory on anyone else\'s tender', () => {
    renderWithTender('Axle Logistics, LLC', AXLE.id)
    expect(screen.queryByText(/Batory load/i)).toBeNull()
  })
})

/*
 * CREATE_SHIPMENT builds the leg server-side, so it only lands in `store.loads` when the
 * `onCreateLoad` subscription delivers it — and every side effect below runs the instant
 * the mutation resolves, which normally beats the subscription. Put through
 * `useAppStore.updateLoad` these writes would hit its `if (!before) return` guard and
 * disappear with no error at all; the deleted `addLoad` only hid that by pushing the row
 * into the store itself. So: an empty store, a real `useLoads`, and the writes still land.
 */
describe('the new load is written before the store has heard of it', () => {
  it('attaches the intake tender PDF to a load no subscription has delivered', async () => {
    render(
      <NewShipmentDialog
        open
        onClose={vi.fn()}
        prefill={{
          dateStr: '2026-10-09',
          intakeItemId: 'intake-7',
          tender: { ...tenderFor('Axle Logistics, LLC', AXLE.id), rateConKey: 'tender-pdfs/intake-7.pdf' },
        }}
      />,
    )
    pickCustomer('Axle Logistics, LLC')
    fillStopDates('2026-10-09')
    save()

    // The intake item is linked after the PDF is attached, so this having run means the
    // attach already had its chance.
    await waitFor(() => expect(updateIntakeItemMock).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().loads).toEqual([])
    expect(updateLoadMock).toHaveBeenCalledTimes(1)
    expect(updateLoadMock.mock.calls[0][0]).toBe('load-9')
    expect(updateLoadMock.mock.calls[0][1]).toMatchObject({ rateConfirmKey: 'tender-pdfs/intake-7.pdf' })
  })

  it('remembers the #appts-ivan thread on a load no subscription has delivered', async () => {
    render(<NewShipmentDialog open onClose={vi.fn()} prefill={{ dateStr: '2026-10-09' }} />)
    pickCustomer('Axle Logistics, LLC')
    // The pickup goes on NEED: the appointment type that earns a #appts-ivan post.
    fireEvent.click(screen.getAllByLabelText('NEED')[0])
    fillStopDates('2026-10-09')
    save()

    await waitFor(() => expect(notifyApptNeededMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(updateLoadMock).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().loads).toEqual([])
    const [id, patch] = updateLoadMock.mock.calls[0]
    expect(id).toBe('load-9')
    const stops = patch.stops as { type: string; apptThreadTs?: string }[]
    expect(stops.find((s) => s.type === 'pickup')?.apptThreadTs).toBe('ts-appts-1')
  })
})
