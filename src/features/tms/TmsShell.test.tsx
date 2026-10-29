// @vitest-environment jsdom
/**
 * The TMS shell sidebar is the only place the MVMNT nav renders: pinned pages,
 * business sections, and the Shipments row with its fixed workstation children plus
 * saved board views under a labelled group. These tests guard that shape and the
 * collapse / active behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { LayoutDashboard, Package, Truck } from 'lucide-react'
import { TmsShell } from './TmsShell'
import type { TmsNavItem, TmsNavSection } from './TmsShell'

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

function renderShell(activePath = '/tms/shipments', onSearch?: (q: string) => void) {
  return render(
    <MemoryRouter initialEntries={[activePath]}>
      <TmsShell
        pinned={PINNED}
        sections={SECTIONS}
        activePath={activePath}
        pageTitle="Shipments"
        user={{ initial: 'R', email: 'ryne@bcatcorp.com' }}
        shipmentViews={VIEWS}
        onSearch={onSearch}
      >
        <div>page body</div>
      </TmsShell>
    </MemoryRouter>
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('TmsShell', () => {
  it('shows each section as NAME [Brand]', () => {
    renderShell()
    expect(screen.getByText(/BROKERAGE/)).toHaveTextContent('BROKERAGE [BCAT Logistics]')
    expect(screen.getByText(/ASSETS/)).toHaveTextContent('ASSETS [Ivan Cartage]')
  })

  it('pins Company Dashboard first and Shipments second', () => {
    renderShell()
    const pinned = screen.getAllByRole('link', { name: /^Company Dashboard$|^Shipments$/ })
    expect(pinned[0]).toHaveAttribute('href', '/tms/dashboard')
    expect(pinned[1]).toHaveAttribute('href', '/tms/shipments')
  })

  it('marks the item matching activePath active and leaves the others alone', () => {
    renderShell('/tms/shipments')
    expect(screen.getByRole('link', { name: /^Shipments$/ })).toHaveClass('tms-active')
    expect(screen.getByRole('link', { name: /^Company Dashboard$/ })).not.toHaveClass('tms-active')
  })

  it('treats a deeper board view as active on the Shipments parent and on Active Shipments', () => {
    renderShell('/tms/shipments/view/brokerage-board')
    expect(screen.getByRole('link', { name: /^Shipments$/ })).toHaveClass('tms-active')
    expect(screen.getByRole('link', { name: 'Active Shipments' })).toHaveClass('tms-active')
    expect(screen.getByRole('link', { name: 'Brokerage Board' })).toHaveClass('tms-active')
  })

  it('renders the four fixed workstation pages before the Views group', () => {
    renderShell()
    expect(screen.getByRole('link', { name: 'Active Shipments' })).toHaveAttribute('href', '/tms/shipments')
    expect(screen.getByRole('link', { name: 'Dispatch' })).toHaveAttribute('href', '/tms/dispatch')
    expect(screen.getByRole('link', { name: 'Tracking' })).toHaveAttribute('href', '/tms/tracking')
    expect(screen.getByRole('link', { name: 'Documents' })).toHaveAttribute('href', '/tms/documents')
  })

  it('lists the saved views under the Views group', () => {
    renderShell()
    expect(screen.getByRole('link', { name: 'Brokerage Board' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/brokerage-board'
    )
    expect(screen.getByRole('link', { name: 'POD collection' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/pod-collection'
    )
    expect(screen.getByText('Views')).toBeInTheDocument()
  })

  it('collapses the children when the caret is clicked', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Shipments' }))
    expect(screen.queryByRole('link', { name: 'POD collection' })).not.toBeInTheDocument()
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
})
