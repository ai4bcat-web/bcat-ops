// @vitest-environment jsdom
/**
 * The TMS shell sidebar is the only place the MVMNT nav renders: the pinned freight list
 * with its data-driven children, business sections, and the collapse / active behaviour.
 * What breaks silently here is which row lights: a child that stays lit on its sibling's
 * page, or a parent that does not open under a page that lives elsewhere (Accounting on
 * /tms/vendors).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { LayoutDashboard, LineChart, Package, Truck } from 'lucide-react'
import { TmsShell } from './TmsShell'
import type { TmsCompanyOption, TmsNavItem, TmsNavSection, TmsShellProps } from './TmsShell'

const PINNED: TmsNavItem[] = [
  { to: '/tms/dashboard', label: 'Company Dashboard', icon: LayoutDashboard },
  {
    to: '/tms/rates',
    label: 'Quotes',
    icon: LineChart,
    badgeKey: 'quotesToReply',
    children: [
      { to: '/tms/rates', label: 'Quotes', badgeKey: 'quotesToReply', exclude: ['/tms/rates/lanes'] },
      { to: '/tms/rates/lanes', label: 'Lane rates' },
    ],
  },
  {
    to: '/tms/shipments',
    label: 'Shipments',
    icon: Package,
    children: [
      { to: '/tms/shipments', label: 'Active', exact: true, params: { list: null } },
      { to: '/tms/shipments?list=all', label: 'All', exact: true, params: { list: 'all' } },
      { to: '/tms/shipments/intake', label: 'Intake', badgeKey: 'intakeLoads' },
    ],
  },
  {
    to: '/tms/tracking',
    label: 'Load Tracking',
    icon: Truck,
    badgeKey: 'loadTracking',
  },
  {
    to: '/tms/invoicing',
    label: 'Accounting',
    icon: Truck,
    group: true,
    badgeKey: 'accounting',
    children: [
      { to: '/tms/invoicing', label: 'Accounts Receivable', exclude: ['/tms/invoicing/payable'] },
      { to: '/tms/invoicing/payable', label: 'Accounts Payable' },
      { to: '/tms/vendors', label: 'Vendors' },
    ],
  },
]

/** The brokerage is the pinned block, so only the fleet is a business section here. */
const SECTIONS: TmsNavSection[] = [
  {
    key: 'ASSETS',
    name: 'ASSETS',
    brand: 'Ivan Cartage',
    items: [{ to: '/dispatch', label: 'Fleet dispatch', icon: Truck }],
  },
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
  it('shows each section as NAME [Brand], and the pinned block has no header', () => {
    renderShell()
    expect(screen.getByText(/ASSETS/)).toHaveTextContent('ASSETS [Ivan Cartage]')
    expect(screen.queryByText(/BROKERAGE/)).not.toBeInTheDocument()
  })

  it('pins Company Dashboard first', () => {
    renderShell()
    const pinned = rail().getAllByRole('link', { name: /^Company Dashboard$|^Quotes$|^Shipments$/ })
    expect(pinned[0]).toHaveAttribute('href', '/tms/dashboard')
    expect(pinned[1]).toHaveAttribute('href', '/tms/rates')
  })

  it('marks the item matching activePath active and leaves the others alone', () => {
    renderShell('/tms/shipments')
    expect(rail().getByRole('link', { name: /^Shipments$/ })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: /^Company Dashboard$/ })).not.toHaveClass('tms-active')
  })

  it('lights Active on the bare board and All on ?list=all, never both', () => {
    const { unmount } = renderShell('/tms/shipments')
    expect(rail().getByRole('link', { name: 'Active' })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'All' })).not.toHaveClass('tms-active')
    unmount()
    renderShell('/tms/shipments', undefined, { activeSearch: '?list=all' })
    expect(rail().getByRole('link', { name: 'All' })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'Active' })).not.toHaveClass('tms-active')
  })

  it('lights the Intake child, not Active, on an intake review page, and nothing on a shipment page', () => {
    const { unmount } = renderShell('/tms/shipments/intake/abc')
    expect(rail().getByRole('link', { name: 'Intake' })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'Active' })).not.toHaveClass('tms-active')
    unmount()
    renderShell('/tms/shipments/SHP-1')
    expect(rail().getByRole('link', { name: 'Active' })).not.toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'Shipments' })).toHaveClass('tms-active')
  })

  it('does not light the Quotes child on the Lane rates page', () => {
    renderShell('/tms/rates/lanes')
    expect(rail().getByRole('link', { name: 'Lane rates' })).toHaveClass('tms-active')
    const [parent, child] = rail().getAllByRole('link', { name: /^Quotes/ })
    expect(parent).toHaveClass('tms-active')
    expect(child).not.toHaveClass('tms-active')
  })

  it('lights Accounts Receivable on an invoice but not on the payable side', () => {
    const { unmount } = renderShell('/tms/invoicing/invoices/INV-1')
    expect(rail().getByRole('link', { name: 'Accounts Receivable' })).toHaveClass('tms-active')
    unmount()
    renderShell('/tms/invoicing/payable')
    expect(rail().getByRole('link', { name: 'Accounts Receivable' })).not.toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'Accounts Payable' })).toHaveClass('tms-active')
  })

  it('lights the Accounting header, opened, on a page that lives outside its own path', () => {
    renderShell('/tms/vendors')
    expect(rail().getByRole('link', { name: 'Accounting' })).toHaveClass('tms-active')
    expect(rail().getByRole('link', { name: 'Vendors' })).toHaveClass('tms-active')
  })

  it('sends a group header to its first visible child and lights it only through a child', () => {
    const group: TmsNavItem = {
      to: '/tms/vendors',
      label: 'Accounting',
      icon: Truck,
      group: true,
      children: [{ to: '/tms/vendors', label: 'Vendors' }, { to: '/tms/factors', label: 'Factoring' }],
    }
    const { unmount } = renderShell('/tms/dashboard', undefined, { pinned: [group] })
    expect(rail().getByRole('link', { name: 'Accounting' })).toHaveAttribute('href', '/tms/vendors')
    expect(rail().getByRole('link', { name: 'Accounting' })).not.toHaveClass('tms-active')
    unmount()
    renderShell('/tms/factors', undefined, { pinned: [group] })
    expect(rail().getByRole('link', { name: 'Accounting' })).toHaveClass('tms-active')
  })

  it('lists Active, All and Intake (with its count) under Shipments — no views, no Dispatch', () => {
    renderShell('/tms/shipments', undefined, { badgeCounts: { intakeLoads: 3 } })
    expect(rail().getByRole('link', { name: 'Active' })).toHaveAttribute('href', '/tms/shipments')
    expect(rail().getByRole('link', { name: 'All' })).toHaveAttribute('href', '/tms/shipments?list=all')
    expect(rail().getByRole('link', { name: /^Intake/ })).toHaveAttribute('href', '/tms/shipments/intake')
    expect(rail().getByRole('link', { name: /^Intake/ })).toHaveTextContent('3')
    expect(rail().queryByRole('link', { name: 'Dispatch' })).not.toBeInTheDocument()
    expect(screen.queryByText('Views')).not.toBeInTheDocument()
  })

  it('renders a parent with no children as one link with its badge and no caret', () => {
    renderShell('/tms/tracking', undefined, { badgeCounts: { loadTracking: 5 } })
    expect(rail().getByRole('link', { name: /^Load Tracking/ })).toHaveTextContent('5')
    expect(rail().queryByRole('button', { name: /Load Tracking/ })).not.toBeInTheDocument()
    expect(rail().queryByRole('link', { name: 'Check calls' })).not.toBeInTheDocument()
    expect(rail().getByRole('link', { name: /^Accounting/ })).not.toHaveTextContent(/\d/)
  })

  it('has no Help link to the retired Academy', () => {
    renderShell()
    expect(screen.queryByRole('link', { name: 'Help' })).not.toBeInTheDocument()
  })

  it('collapses the children when the caret is clicked', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Shipments' }))
    expect(rail().queryByRole('link', { name: 'Intake' })).not.toBeInTheDocument()
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

  it('dense pages show the sidebar as an icon rail that opens on hover and closes on leave, without touching the saved preference', () => {
    const { container } = renderShell('/tms/shipments', undefined, { dense: true })
    const shell = container.querySelector('.tms-shell') as HTMLElement
    const sidebar = container.querySelector('.tms-sidebar') as HTMLElement
    expect(shell).toHaveClass('tms-dense', 'tms-is-collapsed')
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()

    fireEvent.mouseEnter(sidebar)
    expect(shell).not.toHaveClass('tms-is-collapsed')
    fireEvent.mouseLeave(sidebar)
    expect(shell).toHaveClass('tms-is-collapsed')
    expect(window.localStorage.getItem('tms-sidebar-collapsed')).toBe('0')
  })

  it('a click on the rail button pins the full sidebar open on a dense page', () => {
    const { container } = renderShell('/tms/shipments', undefined, { dense: true })
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(container.querySelector('.tms-shell')).not.toHaveClass('tms-is-collapsed')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(container.querySelector('.tms-shell')).toHaveClass('tms-is-collapsed')
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

  it('narrows the rail to the chosen business, always keeps the pinned freight list, and restores on All businesses', () => {
    renderShell('/tms/dashboard', undefined, { companies: COMPANIES })
    expect(rail().getByRole('link', { name: 'Fleet dispatch' })).toBeInTheDocument()

    // Choosing the brokerage folds the fleet section; the pinned block never folds.
    fireEvent.click(screen.getByRole('button', { name: /^Business:/ }))
    fireEvent.click(screen.getByRole('option', { name: 'BCAT Logistics' }))
    expect(rail().queryByRole('link', { name: 'Fleet dispatch' })).not.toBeInTheDocument()
    expect(rail().getByRole('link', { name: 'Company Dashboard' })).toBeInTheDocument()
    expect(window.localStorage.getItem('tms-company')).toBe('BROKERAGE')

    fireEvent.click(screen.getByRole('button', { name: /^Business:/ }))
    fireEvent.click(screen.getByRole('option', { name: 'Ivan Cartage' }))
    expect(rail().getByRole('link', { name: 'Fleet dispatch' })).toBeInTheDocument()
    expect(rail().getByRole('link', { name: 'Company Dashboard' })).toBeInTheDocument()
    expect(window.localStorage.getItem('tms-company')).toBe('ASSETS')

    fireEvent.click(screen.getByRole('button', { name: /^Business:/ }))
    fireEvent.click(screen.getByRole('option', { name: 'All businesses' }))
    expect(rail().getByRole('link', { name: 'Fleet dispatch' })).toBeInTheDocument()
    expect(window.localStorage.getItem('tms-company')).toBeNull()
  })

  it('treats a stored business that is not offered as All businesses', () => {
    window.localStorage.setItem('tms-company', 'GONE')
    renderShell('/tms/dashboard', undefined, { companies: COMPANIES })
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

  it('renders the bell as a button that opens notifications, with the count only when there is one, and none without a handler', () => {
    const onOpenNotifications = vi.fn()
    const { unmount } = renderShell('/tms/shipments', undefined, { notificationCount: 4, onOpenNotifications })
    const bell = screen.getByRole('button', { name: 'Notifications: 4' })
    expect(bell).toHaveTextContent('4')
    expect(bell).toHaveAttribute('aria-haspopup', 'dialog')
    fireEvent.click(bell)
    expect(onOpenNotifications).toHaveBeenCalledTimes(1)
    unmount()

    const second = renderShell('/tms/shipments', undefined, { onOpenNotifications })
    expect(screen.getByRole('button', { name: 'Notifications' })).not.toHaveTextContent(/\d/)
    second.unmount()

    renderShell()
    expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument()
  })

  it('renders the breadcrumb with linked crumbs and the last one current', () => {
    renderShell('/tms/shipments/intake/abc', undefined, {
      breadcrumb: [{ label: 'Shipments', to: '/tms/shipments' }, { label: 'Intake', to: '/tms/shipments/intake' }, { label: 'Load' }],
    })
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    expect(trail.getByRole('link', { name: 'Dashboard home' })).toHaveAttribute('href', '/tms/dashboard')
    expect(trail.getByRole('link', { name: 'Shipments' })).toHaveAttribute('href', '/tms/shipments')
    expect(trail.getByText('Load')).toHaveAttribute('aria-current', 'page')
  })

  it('renders a legacy badge key and omits zero or absent counts', () => {
    renderShell('/tms/shipments', undefined, {
      sections: [{
        key: 'ASSETS', name: 'ASSETS', brand: null,
        items: [
          { to: '/intake', label: 'Intake inbox', icon: Truck, badgeKey: 'intake' },
          { to: '/pods', label: 'PODs', icon: Truck, badgeKey: 'pods' },
          { to: '/fuel', label: 'Fuel', icon: Truck, badgeKey: 'fuel' },
        ],
      }],
      badgeCounts: { intake: 4, pods: 0 },
    })
    expect(rail().getByRole('link', { name: /^Intake inbox/ })).toHaveTextContent('4')
    expect(rail().getByRole('link', { name: /^PODs/ })).not.toHaveTextContent('0')
    expect(rail().getByRole('link', { name: /^Fuel/ })).toHaveTextContent(/^Fuel$/)
  })

  it('fill mode marks the shell and mounts the aside beside the page', () => {
    const { container } = renderShell('/trucks', undefined, { fill: true, aside: <aside>dispatch</aside> })
    expect(container.querySelector('.tms-shell')).toHaveClass('tms-fill')
    expect(screen.getByText('dispatch')).toBeInTheDocument()
  })

  it('does not mount the aside outside fill mode', () => {
    renderShell('/tms/shipments', undefined, { aside: <aside>dispatch</aside> })
    expect(screen.queryByText('dispatch')).not.toBeInTheDocument()
  })

  describe('phone drawer', () => {
    const hamburger = () => screen.getByRole('button', { name: 'Open menu' })

    it('opens from the hamburger, closes on Escape and returns focus to it', () => {
      const { container } = renderShell()
      expect(hamburger()).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(hamburger())
      expect(hamburger()).toHaveAttribute('aria-expanded', 'true')
      expect(container.querySelector('.tms-shell')).toHaveClass('tms-nav-open')
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(container.querySelector('.tms-shell')).not.toHaveClass('tms-nav-open')
      expect(hamburger()).toHaveFocus()
    })

    it('closes when a nav link is followed or the backdrop is tapped', () => {
      const { container } = renderShell()
      fireEvent.click(hamburger())
      fireEvent.click(rail().getByRole('link', { name: 'Company Dashboard' }))
      expect(container.querySelector('.tms-shell')).not.toHaveClass('tms-nav-open')
      fireEvent.click(hamburger())
      fireEvent.click(container.querySelector('.tms-nav-backdrop')!)
      expect(container.querySelector('.tms-shell')).not.toHaveClass('tms-nav-open')
    })
  })
})
