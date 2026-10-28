// @vitest-environment jsdom
/**
 * The sidebar is the only place a page announces itself, and a page nobody can reach is
 * a page nobody uses. This covers the two things that silently break: a nav item shown
 * to somebody who has not been granted its page, and a badge key wired into `navItems`
 * that `getBadgeCount` never answers — which renders as no badge at all, forever.
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

const { NavBar } = await import('./NavBar')

function renderNav() {
  render(<MemoryRouter><NavBar /></MemoryRouter>)
}

describe('NavBar', () => {
  it('shows the quotes pages and the to-reply badge to a granted user', () => {
    access.pages = ['loads', 'quotes']
    renderNav()
    expect(screen.getByText('Quotes')).toBeTruthy()
    expect(screen.getByText('Lane Rates')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('hides both quotes pages from a user without the grant', () => {
    access.pages = ['loads']
    renderNav()
    expect(screen.queryByText('Quotes')).toBeNull()
    expect(screen.queryByText('Lane Rates')).toBeNull()
    expect(screen.queryByText('3')).toBeNull()
  })
})
