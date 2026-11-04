// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

interface ShellProps {
  notificationCount?: number
  onOpenNotifications?: () => void
  fill?: boolean
  aside?: ReactNode
  children?: ReactNode
  breadcrumb: { label: string }[]
  activeSearch?: string
}
const shell = vi.hoisted(() => ({ props: null as unknown as ShellProps | null }))
vi.mock('@/features/tms/TmsShell', () => ({
  TmsShell: (props: ShellProps) => {
    shell.props = props
    return <div data-testid="shell">{props.children}{props.fill ? props.aside : null}</div>
  },
}))

const notifications = vi.hoisted(() => ({
  groups: [] as unknown[],
  count: 0,
}))
vi.mock('@/features/tms/notifications/useNotifications', () => ({
  useNotifications: () => ({ groups: notifications.groups, count: notifications.count, loading: false }),
}))

const initializeData = vi.hoisted(() => vi.fn())
const loadReferenceData = vi.hoisted(() => vi.fn())
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (s: { initializeData: () => void; loadReferenceData: () => void }) => unknown) =>
    select({ initializeData, loadReferenceData }),
}))
vi.mock('@/features/dispatch/DispatchDrawer', () => ({ DispatchDrawer: () => <aside data-testid="dispatch-aside" /> }))
// The badge resolver has its own test; here the layout only needs its shape.
vi.mock('@/features/tms/useShellBadgeCounts', () => ({ useShellBadgeCounts: () => ({}) }))

const auth = vi.hoisted(() => ({
  user: { email: 'rep@bcatcorp.com', groups: [] as string[], userId: 'u1' },
  isOwner: false,
  isAdmin: false,
  hasPageAccess: () => true,
  logout: vi.fn(),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

const data = vi.hoisted(() => ({ profiles: [] as unknown[] }))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({
  useOwnershipDivisions: () => ({ divisions: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/apiClient', () => ({
  listUserProfiles: vi.fn(async () => data.profiles),
  listShipments: vi.fn(async () => []),
  listOrders: vi.fn(async () => []),
  listLoadSummaries: vi.fn(async () => []),
  listLoadCarriers: vi.fn(async () => []),
  listQuotes: vi.fn(async () => []),
  listLoadFinancials: vi.fn(async () => []),
  listCustomers: vi.fn(async () => []),
  listCarriers: vi.fn(async () => []),
  listDrivers: vi.fn(async () => []),
  listCheckCallWorklist: vi.fn(async () => []),
  listLoadCarriersByLoads: vi.fn(async () => new Map()),
}))

import { TmsLayout } from './TmsLayout'

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<TmsLayout />}>
          <Route path="/tms/dashboard" element={<div data-testid="page" />} />
          <Route path="/trucks" element={<div data-testid="page" />} />
          <Route path="/driver-view/:id" element={<div data-testid="page" />} />
          <Route path="/tms/shipments/intake/:id" element={<div data-testid="page" />} />
          <Route path="/tms/shipments" element={<div data-testid="page" />} />
          <Route path="/tms/shipments/:id" element={<div data-testid="page" />} />
          <Route path="/tms/shipments/new" element={<div data-testid="page" />} />
          <Route path="/tms/shipments/:id/edit" element={<div data-testid="page" />} />
          <Route path="/tms/tracking" element={<div data-testid="page" />} />
          <Route path="/tms/tracking/links" element={<div data-testid="page" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  // jsdom has no matchMedia; the legacy dispatch column asks whether this is a desktop.
  window.matchMedia = (() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  shell.props = null
  notifications.groups = []
  notifications.count = 0
  initializeData.mockClear()
  loadReferenceData.mockClear()
  auth.user = { email: 'rep@bcatcorp.com', groups: [], userId: 'u1' }
  data.profiles = [{ id: 'rep@bcatcorp.com', email: 'rep@bcatcorp.com', divisions: ['BROKERAGE'], createdBy: 's', updatedBy: 's', version: 1 }]
})

describe('TmsLayout', () => {
  it('runs legacy pages in fill mode, inside the host, with the dispatch column and the store', () => {
    renderAt('/trucks')
    expect(shell.props?.fill).toBe(true)
    expect(screen.getByTestId('page').closest('.tms-legacy-host')).not.toBeNull()
    expect(screen.getByTestId('dispatch-aside')).toBeTruthy()
    expect(initializeData).toHaveBeenCalledWith('rep@bcatcorp.com')
    expect(loadReferenceData).not.toHaveBeenCalled()
  })

  it('leaves /tms pages in page scroll: no host, no fill, no dispatch column, no store init', () => {
    renderAt('/tms/dashboard')
    expect(shell.props?.fill).toBe(false)
    expect(screen.getByTestId('page').closest('.tms-legacy-host')).toBeNull()
    expect(screen.queryByTestId('dispatch-aside')).toBeNull()
    expect(initializeData).not.toHaveBeenCalled()
    expect(loadReferenceData).toHaveBeenCalledTimes(1)
  })

  it('titles a legacy page that is not a nav item', () => {
    renderAt('/driver-view/x')
    expect(shell.props?.breadcrumb.map((c) => c.label)).toEqual(['Owner operator pay', 'Driver app'])
  })

  it('hands the shell the intake trail for an intake load', () => {
    renderAt('/tms/shipments/intake/abc')
    expect(shell.props?.breadcrumb.map((c) => c.label)).toEqual(['Shipments', 'Intake', 'Load'])
  })

  it('hands the shell the query string, so Active and All can tell the board lists apart', () => {
    renderAt('/tms/shipments?list=all')
    expect(shell.props?.activeSearch).toBe('?list=all')
  })

  it('runs the list pages dense (icon rail, full bleed) and every other /tms page normally', () => {
    for (const path of ['/tms/shipments', '/tms/shipments?list=all', '/tms/shipments/intake', '/tms/tracking', '/tms/shipments/new', '/tms/shipments/S-1/edit']) {
      const view = renderAt(path)
      expect(shell.props?.dense, path).toBe(true)
      view.unmount()
    }
    for (const path of ['/tms/dashboard', '/tms/shipments/S-1', '/tms/shipments/intake/abc', '/tms/tracking/links', '/trucks']) {
      const view = renderAt(path)
      expect(shell.props?.dense, path).toBe(false)
      view.unmount()
    }
  })

  it('hands the shell the notification total and a bell that opens the drawer on the item list', async () => {
    notifications.count = 3
    notifications.groups = [{
      kind: 'CHECK_CALLS', label: 'Check calls', total: 1, moreTo: '/tms/tracking?assignee=all&focus=checkcalls', moreLabel: 'Open worklist',
      items: [{ id: 'cc:s1', kind: 'CHECK_CALLS', severity: 'critical', title: 'L-1 — check call overdue', detail: 'Acme', at: null, to: '/tms/shipments/s1?tab=tracking' }],
    }]
    renderAt('/tms/dashboard')
    expect(shell.props?.notificationCount).toBe(3)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => shell.props?.onOpenNotifications?.())
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('link', { name: /L-1 — check call overdue/ })).toHaveAttribute('href', '/tms/shipments/s1?tab=tracking')
  })
})
