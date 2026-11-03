// @vitest-environment jsdom
/**
 * The TMS shell sidebar is the only place the MVMNT nav renders: pinned pages,
 * business sections, and the Shipments row with its fixed workstation children plus
 * saved board views under a labelled group. These tests guard that shape and the
 * collapse / active behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { LayoutDashboard, Package, Truck } from 'lucide-react'
import { TmsShell } from './TmsShell'
import type { TmsCompanyOption, TmsNavItem, TmsNavSection, TmsShellProps } from './TmsShell'

const PINNED: TmsNavItem[] = [
  { to: '/tms/dashboard', label: 'Company Dashboard', icon: LayoutDashboard },
  { to: '/tms/shipments', label: 'Shipments', icon: Package },
]

const SECTIONS: TmsNavSection[] = [
  {
    key: 'BROKERAGE',
    name: 'BROKERAGE',
    brand: 'BCAT Logistics',
    items: [{ to: '/tms/rates', label: 'Rates', icon: LayoutDashboard }],
  },
  {
    key: 'ASSETS',
    name: 'ASSETS',
    brand: 'Ivan Cartage',
    items: [{ to: '/dispatch', label: 'Fleet dispatch', icon: Truck }],
  },
]

const VIEWS = [
  { slug: 'brokerage-board', name: 'Brokerage Board' },
  { slug: 'pod-collection', name: 'POD collection' },
]

const COMPANIES: TmsCompanyOption[] = [
  { code: 'BROKERAGE', name: 'BCAT Logistics' },
  { code: 'ASSETS', name: 'Ivan Cartage' },
]

function renderShell(
  activePath = '/tms/shipments',
  onSearch?: (q: string) => void,
  extra: Partial<TmsShellProps> = {},
) {
  return render(
    <MemoryRouter initialEntries={[activePath]}>
      <TmsShell
        pinned={PINNED}
        sections={SECTIONS}
        activePath={activePath}
        breadcrumb={[{ label: 'Shipments' }]}
        user={{ initial: 'R', email: 'ryne@bcatcorp.com' }}
        shipmentViews={VIEWS}
        onSearch={onSearch}
        {...extra}
      >
        <div>page body</div>
      </TmsShell>
    </MemoryRouter>
  )
}

/** Rail links only: the breadcrumb renders a "Shipments" link of its own. */
const rail = () => within(screen.getByRole('navigation', { name: 'TMS sections' }))

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-tms-theme')
})

describe('TmsShell', () => {
  it('shows each section as NAME [Brand]', () => {
    renderShell()
    expect(screen.getByText(/BROKERAGE/)).toHaveTextContent('BROKERAGE [BCAT Logistics]')
    expect(screen.getByText(/ASSETS/)).toHaveTextContent('ASSETS [Ivan Cartage]')
  })

  it('pins Company Dashboard first and Shipments second', () => {
    renderShell()
    const pinned = rail().getAllByRole('link', { name: /^Company Dashboard$|^Shipments$/ })
    expect(pinned[0]).toHaveAttribute('href', '/tms/dashboard')
    expect(pinned[1]).toHaveAttribute('href', '/tms/shipments')
  })

  it('marks the item matching activePath active and leaves the others alone', () => {
    renderShell('/tms/shipments')
    expect(rail().getByRole('link', { name: /^Shipments$/ })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: /^Company Dashboard$/ })).not.toHaveClass('tms-active')
  })

  it('treats a deeper board view as active on the Shipments parent and on Active Shipments', () => {
    renderShell('/tms/shipments/view/brokerage-board')
    expect(rail().getByRole('link', { name: /^Shipments$/ })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'Active Shipments' })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'Brokerage Board' })).toHaveClass('tms-active')
  })

  it('renders the four fixed workstation pages before the Views group', () => {
    renderShell()
    expect(rail().getByRole('link', { name: 'Active Shipments' })).toHaveAttribute('href', '/tms/shipments')
    expect(rail().getByRole('link', { name: 'Dispatch' })).toHaveAttribute('href', '/tms/dispatch')
    expect(rail().getByRole('link', { name: 'Tracking' })).toHaveAttribute('href', '/tms/tracking')
    expect(rail().getByRole('link', { name: 'Documents' })).toHaveAttribute('href', '/tms/documents')
  })

  it('lists the saved views under the Views group', () => {
    renderShell()
    expect(rail().getByRole('link', { name: 'Brokerage Board' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/brokerage-board'
    )
    expect(rail().getByRole('link', { name: 'POD collection' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/pod-collection'
    )
    expect(screen.getByText('Views')).toBeInTheDocument()
  })

  it('collapses the children when the caret is clicked', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Shipments' }))
    expect(rail().queryByRole('link', { name: 'POD collection' })).not.toBeInTheDocument()
  })

  it('focuses the search on ctrl+k', () => {
    renderShell()
    const input = screen.getByLabelText('Search anything')
    expect(input).not.toHaveFocus()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(input).toHaveFocus()
  })

  it('reports what was typed into the search', () => {
    const onSearch = vi.fn()
    renderShell('/tms/shipments', onSearch)
    fireEvent.change(screen.getByLabelText('Search anything'), { target: { value: 'BCAT1042' } })
    expect(onSearch).toHaveBeenCalledWith('BCAT1042')
  })

  it('remembers the collapsed sidebar in localStorage', () => {
    const { unmount } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(window.localStorage.getItem('tms-sidebar-collapsed')).toBe('1')
    unmount()

    renderShell()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('flips the page theme from the toggle and remembers it across a remount', () => {
    const { unmount } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement.getAttribute('data-tms-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
    unmount()
    expect(document.documentElement.hasAttribute('data-tms-theme')).toBe(false)

    renderShell()
    expect(document.documentElement.getAttribute('data-tms-theme')).toBe('dark')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(document.documentElement.hasAttribute('data-tms-theme')).toBe(false)
  })

  it('has no switcher menu for fewer than two businesses', () => {
    renderShell('/tms/shipments', undefined, { companies: [COMPANIES[0]] })
    expect(screen.queryByRole('button', { name: /^Business:/ })).not.toBeInTheDocument()
  })

  it('narrows the rail to the chosen business and restores it on All businesses', () => {
    renderShell('/tms/dashboard', undefined, { companies: COMPANIES })
    expect(rail().getByRole('link', { name: 'Rates' })).toBeInTheDocument()
    expect(rail().getByRole('link', { name: 'Fleet dispatch' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Business:/ }))
    fireEvent.click(screen.getByRole('option', { name: 'Ivan Cartage' }))
    expect(rail().queryByRole('link', { name: 'Rates' })).not.toBeInTheDocument()
    expect(rail().getByRole('link', { name: 'Fleet dispatch' })).toBeInTheDocument()
    // Pinned rows are never folded away.
    expect(rail().getByRole('link', { name: 'Company Dashboard' })).toBeInTheDocument()
    expect(window.localStorage.getItem('tms-company')).toBe('ASSETS')

    fireEvent.click(screen.getByRole('button', { name: /^Business:/ }))
    fireEvent.click(screen.getByRole('option', { name: 'All businesses' }))
    expect(rail().getByRole('link', { name: 'Rates' })).toBeInTheDocument()
    expect(window.localStorage.getItem('tms-company')).toBeNull()
  })

  it('treats a stored business that is not offered as All businesses', () => {
    window.localStorage.setItem('tms-company', 'GONE')
    renderShell('/tms/dashboard', undefined, { companies: COMPANIES })
    expect(rail().getByRole('link', { name: 'Rates' })).toBeInTheDocument()
    expect(rail().getByRole('link', { name: 'Fleet dispatch' })).toBeInTheDocument()
  })

  it('logs out from the user card, and offers no button when there is no handler', () => {
    const onLogout = vi.fn()
    const { unmount } = renderShell('/tms/shipments', undefined, { onLogout })
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
    unmount()

    renderShell()
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument()
  })

  it('links the bell to the check calls page and shows the due count only when there is one', () => {
    const { unmount } = renderShell('/tms/shipments', undefined, { notificationCount: 4 })
    const bell = screen.getByRole('link', { name: 'Check calls due: 4' })
    expect(bell).toHaveAttribute('href', '/tms/check-calls')
    expect(bell).toHaveTextContent('4')
    unmount()

    renderShell()
    expect(screen.getByRole('link', { name: 'Check calls' })).not.toHaveTextContent(/\d/)
  })

  it('renders the breadcrumb with linked crumbs and the last one current', () => {
    renderShell('/tms/shipments/view/mine', undefined, {
      breadcrumb: [{ label: 'Shipments', to: '/tms/shipments' }, { label: 'Mine' }],
    })
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    expect(trail.getByRole('link', { name: 'Dashboard home' })).toHaveAttribute('href', '/tms/dashboard')
    expect(trail.getByRole('link', { name: 'Shipments' })).toHaveAttribute('href', '/tms/shipments')
    expect(trail.getByText('Mine')).toHaveAttribute('aria-current', 'page')
  })

  it('counts moving shipments on Tracking and lists them when it is expanded', () => {
    renderShell('/tms/shipments', undefined, {
      badgeCounts: { tracking: 2 },
      trackedLoads: [
        { id: 'a', label: 'SHP-1', sub: 'Acme', to: '/tms/shipments/a' },
        { id: 'b', label: 'SHP-2', sub: null, to: '/tms/shipments/b' },
      ],
    })
    expect(rail().getByRole('link', { name: /^Tracking/ })).toHaveTextContent('2')
    expect(rail().queryByRole('link', { name: /SHP-1/ })).not.toBeInTheDocument()

    fireEvent.click(rail().getByRole('button', { name: 'Expand Tracking' }))
    expect(rail().getByRole('link', { name: /SHP-1/ })).toHaveAttribute('href', '/tms/shipments/a')
    expect(rail().getByRole('link', { name: /SHP-2/ })).toHaveAttribute('href', '/tms/shipments/b')
  })
})
