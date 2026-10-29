// @vitest-environment jsdom
/**
 * The sidebar is the only place a page announces itself, and a page nobody can reach is
 * a page nobody uses. This covers the three things that silently break: a nav item shown
 * to somebody who has not been granted its page, a badge key wired into the nav config
 * that `getBadgeCount` never answers — which renders as no badge at all, forever — and
 * the division grouping, which is what decides whether a broker sees the fleet's pages.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const access = { pages: ['loads', 'quotes'] }

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { email: 'rep@bcatcorp.com' },
    logout: vi.fn(),
    isOwner: false,
    hasPageAccess: (key: string) => access.pages.includes(key),
  }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (state: { loads: unknown[]; maintenanceTasks: unknown[] }) => unknown) =>
    select({ loads: [], maintenanceTasks: [] }),
}))
vi.mock('@/hooks/useIntakeItems', () => ({ useIntakeItems: () => ({ items: [] }) }))
vi.mock('@/hooks/useReviewQueue', () => ({ useReviewQueue: () => ({ pendingCount: 0 }) }))
vi.mock('@/hooks/useTruckDocAlerts', () => ({ useTruckDocAlerts: () => ({ outOfDateCount: 0 }) }))
vi.mock('@/hooks/useDispatch', () => ({ useDispatchUnread: () => 0 }))
vi.mock('@/hooks/useCheckCallWorklist', () => ({ useCheckCallWorklist: () => ({ dueCount: 0 }) }))
vi.mock('@/hooks/useDocumentReviewQueue', () => ({ useDocumentReviewQueue: () => ({ pendingCount: 0 }) }))
vi.mock('@/hooks/useArToInvoiceCount', () => ({ useArToInvoiceCount: () => 0 }))
vi.mock('@/hooks/useApToReviewCount', () => ({ useApToReviewCount: () => 0 }))
vi.mock('@/hooks/useQuotesToReplyCount', () => ({ useQuotesToReplyCount: () => 3 }))
// The divisions poll: `null` is the pre-load state, where the seeds supply the sections.
vi.mock('@/features/tms/useShipmentViews', () => ({
  useOwnershipDivisions: () => ({ divisions: null, loading: false, error: null, refresh: vi.fn() }),
}))

// Imported after the mocks above are registered, so the sidebar's data hooks resolve to
// them rather than to Amplify clients this test has no configuration for.
const { NavBar } = await import('./NavBar')

function renderNav() {
  render(<MemoryRouter><NavBar /></MemoryRouter>)
}

describe('NavBar', () => {
  it('shows the Brokerage pages a grant opens, with the to-reply badge', () => {
    access.pages = ['loads', 'quotes']
    renderNav()
    expect(screen.getByText('BROKERAGE [BCAT Logistics]')).toBeTruthy()
    expect(screen.getByText('Shipments')).toBeTruthy()
    expect(screen.getByText('Rates').closest('a')?.getAttribute('href')).toBe('/tms/rates')
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('hides the rates page from a user without the quotes grant', () => {
    access.pages = ['loads']
    renderNav()
    expect(screen.queryByText('Rates')).toBeNull()
    expect(screen.queryByText('3')).toBeNull()
  })

  it('opens the whole Brokerage section on the one `tms` grant, and no fleet section', () => {
    access.pages = ['tms']
    renderNav()
    expect(screen.getByText('BROKERAGE [BCAT Logistics]')).toBeTruthy()
    expect(screen.getByText('Academy')).toBeTruthy()
    expect(screen.getByText('My Brokerage')).toBeTruthy()
    expect(screen.queryByText('ASSETS [Ivan Cartage]')).toBeNull()
  })

  it('groups a fleet user under the asset business instead', () => {
    access.pages = ['calendar', 'trucks']
    renderNav()
    expect(screen.getByText('ASSETS [Ivan Cartage]')).toBeTruthy()
    expect(screen.queryByText('BROKERAGE [BCAT Logistics]')).toBeNull()
    expect(screen.getByText('Calendar')).toBeTruthy()
  })
})
