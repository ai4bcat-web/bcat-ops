// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ShipmentViewRecord } from '@/types/tms'

const shell = vi.hoisted(() => ({ props: null as { shipmentViews: { slug: string }[] } | null }))
vi.mock('@/features/tms/TmsShell', () => ({
  TmsShell: (props: { shipmentViews: { slug: string }[] }) => {
    shell.props = props
    return null
  },
}))

const auth = vi.hoisted(() => ({
  user: { email: 'rep@bcatcorp.com', groups: [] as string[], userId: 'u1' },
  isOwner: false,
  isAdmin: false,
  hasPageAccess: () => true,
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

const data = vi.hoisted(() => ({ views: [] as ShipmentViewRecord[], profiles: [] as unknown[] }))
vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: () => ({ views: data.views, loading: false, error: null, refresh: vi.fn() }),
  useOwnershipDivisions: () => ({ divisions: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/lib/apiClient', () => ({ listUserProfiles: vi.fn(async () => data.profiles) }))

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

const sidebarSlugs = async (expected: number) => {
  render(<MemoryRouter><TmsLayout /></MemoryRouter>)
  // The profile read settles a tick after the first paint; the rail is read after it.
  await waitFor(() => expect(shell.props?.shipmentViews).toHaveLength(expected))
  return (shell.props?.shipmentViews ?? []).map((v) => v.slug)
}

beforeEach(() => {
  shell.props = null
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
})
