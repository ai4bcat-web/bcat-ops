// @vitest-environment jsdom
/**
 * The loads drawer must be the SAME panel object as every other drawer, and must not
 * render when closed.
 *
 * Both of those have broken before. The drawer was a Radix Sheet with bg-white and
 * border-slate-200 hardcoded, so it ignored the theme tokens and read as a different
 * component from the driver/file panels. And when the Files page's driver drawer was
 * moved to SidePanel, the `open` gate the Sheet used to provide was dropped and the
 * page opened permanently stuck on the editor. Nothing in the type system catches
 * either one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Load } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const load = {
  id: 'l1', aljexId: '55501', tmsId: 'PO-9', pickupNumber: 'PU-1', customer: 'Metz Logistics',
  readyToInvoice: true, active: true, createdAt: '', updatedAt: '',
} as unknown as Load

let state: Record<string, unknown> = {}
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'ryne@bcatcorp.com' }, isAdmin: true, isOwner: true }),
  useAuthUser: () => ({ email: 'ryne@bcatcorp.com' }),
}))

vi.mock('@/features/pods/LoadPods', () => ({
  LoadPods: () => null,
}))

// The address book is loaded over the API; these tests only need it to exist and be empty.
// The Batory rule then falls through to the /batory/i name match, which is the same path a
// tender from an unlinked broker takes in production.
vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: () => ({
    customers: [], locations: [], loading: false, error: null,
    refresh: vi.fn(), addCustomer: vi.fn(), addLocation: vi.fn(),
    saveCustomer: vi.fn(), saveLocation: vi.fn(),
    archiveCustomer: vi.fn(), archiveLocation: vi.fn(),
  }),
}))

const { LoadDrawer } = await import('./LoadDrawer')

const baseState = (drawerMode: string | null) => ({
  loads: [load], drivers: [], equipment: [], selectedLoadId: 'l1', drawerMode,
  createPreFill: null, setSelectedLoad: vi.fn(), pendingIntakeItemId: null,
  setPendingIntakeItem: vi.fn(), updateLoad: vi.fn(), deleteLoad: vi.fn(), addLoad: vi.fn(),
  maintenanceInvoices: [], intakeItems: [],
})

beforeEach(() => { state = baseState(null) })

describe('LoadDrawer visibility', () => {
  it('renders NOTHING when no drawer is open', () => {
    const { container } = render(<LoadDrawer />)
    expect(container.textContent).toBe('')
  })

  it('opens on the load when drawerMode is set', () => {
    state = baseState('view')
    render(<LoadDrawer />)
    expect(screen.getAllByText(/55501/).length).toBeGreaterThan(0)
  })
})

describe('LoadDrawer uses the shared panel, not its own chrome', () => {
  it('is themed with the design tokens rather than a hardcoded white sheet', () => {
    state = baseState('view')
    const { container } = render(<LoadDrawer />)
    const html = container.innerHTML
    // SidePanel paints --ds-surface; the old Sheet hardcoded bg-white / border-slate-200.
    expect(html).toContain('var(--ds-surface)')
    expect(html).not.toContain('border-slate-200')
  })

  it('shows the invoice status badge as a header action', () => {
    state = baseState('view')
    render(<LoadDrawer />)
    // Appears twice by design: the header badge and the Status field in the body.
    expect(screen.getAllByText(/Ready to Invoice/i).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the load number as the panel title and the customer as its subtitle', () => {
    state = baseState('view')
    render(<LoadDrawer />)
    expect(screen.getAllByText('55501').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Metz/).length).toBeGreaterThan(0)
  })

  it('offers Delete and Edit Load in the pinned footer', () => {
    state = baseState('view')
    render(<LoadDrawer />)
    expect(screen.getByRole('button', { name: /Delete load/i })).toBeTruthy()
    expect(screen.getByText(/Edit Load/i)).toBeTruthy()
  })
})

/**
 * Build Load prefills the stop details off the tender — but a Batory tender must arrive
 * with its appointments blank.
 *
 * Batory bookings go through the request-and-confirm ladder: Dennis asks for a time, the
 * shipper grants it, and two screenshots evidence it. A date lifted off the tender is a
 * time nobody agreed, sitting in the exact field that ladder exists to fill, and the load
 * reads as booked when nothing has been booked. The facility and city still prefill,
 * because that part is not in dispute — only the appointment and the facility
 * instructions, which the ladder also establishes by hand, are withheld.
 */
const tenderFor = (customer: string) => ({
  format: 'E2OPEN' as const,
  reference: '208663813',
  pickupNumber: 'SO-77',
  customer,
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

const createWithTender = (customer: string) => ({
  ...baseState('create'),
  createPreFill: { dateStr: '2026-10-09', tender: tenderFor(customer) },
})

/*
 * Build Load is a Radix Dialog, so its fields are portalled to document.body — the render
 * container is empty, and a field's value lives on the DOM property, not in the markup.
 * Reading container.innerHTML would pass every one of these vacuously.
 */
const fieldValues = (type: string) =>
  [...document.body.querySelectorAll('input')].filter((el) => el.type === type).map((el) => el.value)

const textValues = () => [
  ...[...document.body.querySelectorAll('input')].filter((el) => el.type === 'text').map((el) => el.value),
  ...[...document.body.querySelectorAll('textarea')].map((el) => el.value),
]

describe('Build Load prefill, Batory vs everyone else', () => {
  it('prefills the booked appointment date and time for a non-Batory tender', () => {
    state = createWithTender('Axle Logistics, LLC')
    render(<LoadDrawer />)
    // The appointment is a date input plus a time input, not one datetime field.
    expect(fieldValues('date')).toEqual(expect.arrayContaining(['2026-10-09', '2026-10-10']))
    expect(fieldValues('time')).toEqual(expect.arrayContaining(['08:00', '14:00']))
  })

  it('prefills the facility, city and instructions for a non-Batory tender', () => {
    state = createWithTender('Axle Logistics, LLC')
    render(<LoadDrawer />)
    const values = textValues()
    expect(values).toContain("BATORY'S OAKLEY")
    expect(values).toContain('DES MOINES, IA')
    expect(values.join('\n')).toContain('48 Hour Notice')
  })

  it('leaves every appointment date and time blank for a Batory tender', () => {
    state = createWithTender('BATORY FOODS INC')
    render(<LoadDrawer />)
    // Nothing carried over at all — not the tender's times, not even the plan date.
    expect(fieldValues('date').filter(Boolean)).toEqual([])
    expect(fieldValues('time').filter(Boolean)).toEqual([])
  })

  it('still prefills the Batory facility and city — only the appointment is withheld', () => {
    state = createWithTender('BATORY FOODS INC')
    render(<LoadDrawer />)
    const values = textValues()
    expect(values).toContain("BATORY'S OAKLEY")
    expect(values).toContain('CHICAGO, IL')
  })

  it('withholds the facility instructions on a Batory tender', () => {
    state = createWithTender('BATORY FOODS INC')
    render(<LoadDrawer />)
    expect(textValues().join('\n')).not.toContain('48 Hour Notice')
  })

  it('says why the Batory appointments are blank, so nobody hunts for the date', () => {
    state = createWithTender('BATORY FOODS INC')
    render(<LoadDrawer />)
    expect(screen.getByText(/Batory load/i)).toBeTruthy()
  })

  it('says nothing about Batory on anyone else\'s tender', () => {
    state = createWithTender('Axle Logistics, LLC')
    render(<LoadDrawer />)
    expect(screen.queryByText(/Batory load/i)).toBeNull()
  })
})
