// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ShipmentViewRecord } from '@/types/tms'

interface ShellProps {
  shipmentViews: { slug: string }[]
  fill?: boolean
  aside?: ReactNode
  children?: ReactNode
  breadcrumb: { label: string }[]
}
const shell = vi.hoisted(() => ({ props: null as unknown as ShellProps | null }))
vi.mock('@/features/tms/TmsShell', () => ({
  TmsShell: (props: ShellProps) => {
    shell.props = props
    return <div data-testid="shell">{props.children}{props.fill ? props.aside : null}</div>
  },
}))

const initializeData = vi.hoisted(() => vi.fn())
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (select: (s: { initializeData: () => void }) => unknown) => select({ initializeData }),
}))
vi.mock('@/features/dispatch/DispatchDrawer', () => ({ DispatchDrawer: () => <aside data-testid="dispatch-aside" /> }))
// The badge resolver has its own test; here the layout only needs its shape.
vi.mock('@/features/tms/useShellBadgeCounts', () => ({ useShellBadgeCounts: () => ({}), movingShipments: () => [] }))

const auth = vi.hoisted(() => ({
  user: { email: 'rep@bcatcorp.com', groups: [] as string[], userId: 'u1' },
  isOwner: false,
  isAdmin: false,
  hasPageAccess: () => true,
  logout: vi.fn(),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

const data = vi.hoisted(() => ({ views: [] as ShipmentViewRecord[], profiles: [] as unknown[] }))
vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: () => ({ views: data.views, loading: false, error: null, refresh: vi.fn() }),
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
  listLoadCarriersByLoad: vi.fn(async () => []),
}))

import { TmsLayout } from './TmsLayout'

const view = (slug: string, audience: ShipmentViewRecord['audience']): ShipmentViewRecord => ({
  id: slug,
  slug,
  name: slug,
  department: null,
  description: null,
  filters: {},
  columns: null,
  sort: null,
  isDefault: false,
  audience,
  sortOrder: 10,
  active: true,
  createdBy: 'seed',
  updatedBy: 'seed',
  version: 1,
})

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<TmsLayout />}>
          <Route path="/tms/dashboard" element={<div data-testid="page" />} />
          <Route path="/trucks" element={<div data-testid="page" />} />
          <Route path="/driver-view/:id" element={<div data-testid="page" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )

const sidebarSlugs = async (expected: number) => {
  render(<MemoryRouter><TmsLayout /></MemoryRouter>)
  // The profile read settles a tick after the first paint; the rail is read after it.
  await waitFor(() => expect(shell.props?.shipmentViews).toHaveLength(expected))
  return (shell.props?.shipmentViews ?? []).map((v) => v.slug)
}

beforeEach(() => {
  // jsdom has no matchMedia; the legacy dispatch column asks whether this is a desktop.
  window.matchMedia = (() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  shell.props = null
  initializeData.mockClear()
  auth.user = { email: 'rep@bcatcorp.com', groups: [], userId: 'u1' }
  data.views = [view('everyone', null), view('managers', { roles: ['MANAGER'] }), view('assets', { divisions: ['ASSETS'] })]
  data.profiles = [{ id: 'rep@bcatcorp.com', email: 'rep@bcatcorp.com', divisions: ['BROKERAGE'], createdBy: 's', updatedBy: 's', version: 1 }]
})

describe('TmsLayout', () => {
  it('offers the rail exactly the views this caller may open', async () => {
    expect(await sidebarSlugs(1)).toEqual(['everyone'])
  })

  it('reads the role off the role- group, so a roles-only view reaches the rail', async () => {
    auth.user = { email: 'rep@bcatcorp.com', groups: ['role-MANAGER'], userId: 'u1' }
    expect(await sidebarSlugs(2)).toContain('managers')
  })

  it('offers a division-scoped view once the profile works in that division', async () => {
    data.profiles = [{ id: 'rep@bcatcorp.com', email: 'rep@bcatcorp.com', divisions: ['ASSETS'], createdBy: 's', updatedBy: 's', version: 1 }]
    expect(await sidebarSlugs(2)).toContain('assets')
  })

  it('runs legacy pages in fill mode, inside the host, with the dispatch column and the store', () => {
    renderAt('/trucks')
    expect(shell.props?.fill).toBe(true)
    expect(screen.getByTestId('page').closest('.tms-legacy-host')).not.toBeNull()
    expect(screen.getByTestId('dispatch-aside')).toBeTruthy()
    expect(initializeData).toHaveBeenCalledWith('rep@bcatcorp.com')
  })

  it('leaves /tms pages in page scroll: no host, no fill, no dispatch column, no store init', () => {
    renderAt('/tms/dashboard')
    expect(shell.props?.fill).toBe(false)
    expect(screen.getByTestId('page').closest('.tms-legacy-host')).toBeNull()
    expect(screen.queryByTestId('dispatch-aside')).toBeNull()
    expect(initializeData).not.toHaveBeenCalled()
  })

  it('titles a legacy page that is not a nav item', () => {
    renderAt('/driver-view/x')
    expect(shell.props?.breadcrumb.map((c) => c.label)).toEqual(['Owner operator pay', 'Driver app'])
  })
})
