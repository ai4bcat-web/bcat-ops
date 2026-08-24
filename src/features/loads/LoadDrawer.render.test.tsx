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
