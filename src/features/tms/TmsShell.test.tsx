// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { LayoutDashboard, Package, Truck } from 'lucide-react'
import { TmsShell } from './TmsShell'
import type { TmsNavSection } from './TmsShell'

const SECTIONS: TmsNavSection[] = [
  {
    key: 'BROKERAGE',
    name: 'BROKERAGE',
    brand: 'BCAT Logistics',
    items: [
      { to: '/tms/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/tms/shipments', label: 'Shipments', icon: Package },
    ],
  },
  {
    key: 'ASSETS',
    name: 'ASSETS',
    brand: 'Ivan Cartage',
    items: [{ to: '/dispatch', label: 'Fleet dispatch', icon: Truck }],
  },
]

const VIEWS = [
  { slug: 'dispatch', name: 'Dispatch' },
  { slug: 'pod-collection', name: 'POD collection' },
]

function renderShell(activePath = '/tms/shipments', onSearch?: (q: string) => void) {
  return render(
    <MemoryRouter initialEntries={[activePath]}>
      <TmsShell
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

  it('marks the item matching activePath active and leaves the others alone', () => {
    renderShell('/tms/shipments')
    expect(screen.getByRole('link', { name: /Shipments/ })).toHaveClass('tms-active')
    expect(screen.getByRole('link', { name: /Dashboard/ })).not.toHaveClass('tms-active')
  })

  it('treats a deeper path as active on its parent item', () => {
    renderShell('/tms/shipments/view/dispatch')
    expect(screen.getByRole('link', { name: /^Shipments$/ })).toHaveClass('tms-active')
    expect(screen.getByRole('link', { name: 'Dispatch' })).toHaveClass('tms-active')
  })

  it('lists the shipment views as children of Shipments', () => {
    renderShell()
    const dispatch = screen.getByRole('link', { name: 'Dispatch' })
    expect(dispatch).toHaveAttribute('href', '/tms/shipments/view/dispatch')
    expect(screen.getByRole('link', { name: 'POD collection' })).toHaveAttribute(
      'href',
      '/tms/shipments/view/pod-collection'
    )
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
