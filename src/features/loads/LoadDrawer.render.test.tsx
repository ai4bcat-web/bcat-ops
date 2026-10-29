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
  setSelectedLoad: vi.fn(), updateLoad: vi.fn(), refreshCalendarData: vi.fn(),
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

  // Ryne, 2026-10-28: a PRO number is permanent, so no screen may offer to delete a
  // load. The drawer is the last place one was reachable from.
  it('offers Edit Load in the pinned footer and no way to delete the load', () => {
    state = baseState('view')
    render(<LoadDrawer />)
    expect(screen.getByText(/Edit Load/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})

/*
 * The create-mode prefill coverage that used to live here moved with the behaviour: the
 * drawer no longer creates anything, so the Batory-vs-everyone-else tender rules are
 * pinned on the form that now owns them —
 * src/features/shipments/components/NewShipmentDialog.test.tsx.
 */
describe('the drawer never creates a record', () => {
  it('edits a leg and offers no way to mint one', () => {
    state = baseState('edit')
    render(<LoadDrawer />)
    expect(screen.getByRole('button', { name: /save changes/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /create load/i })).toBeNull()
  })

  /*
   * The customer belongs to the shipment. Editing it here wrote Load.customerId while the
   * Shipment and the Order stayed unresolved, so the release gate and the AR worklist
   * disagreed with what the calendar showed.
   */
  it('shows the customer read-only and points at the shipment detail', () => {
    state = baseState('edit')
    render(<LoadDrawer />)
    const customer = [...document.body.querySelectorAll('input')]
      .find((el) => el.value === 'Metz Logistics')
    expect(customer?.disabled).toBe(true)
    expect(screen.getByText(/change the customer on the shipment detail/i)).toBeTruthy()
  })

  /*
   * `aljexId` is field-level read-only to clients now: the PRO claim owns it, so the only
   * way to move one is SET_LOAD_PRO, which takes a new claim and never releases the old.
   */
  it('offers Pro # only through the claim action, never as an editable field', () => {
    state = baseState('edit')
    render(<LoadDrawer />)
    const proField = [...document.body.querySelectorAll('input')].find((el) => el.value === '55501')
    expect(proField?.readOnly).toBe(true)
    expect(screen.getByRole('button', { name: 'Change Pro #' })).toBeTruthy()
  })
})
