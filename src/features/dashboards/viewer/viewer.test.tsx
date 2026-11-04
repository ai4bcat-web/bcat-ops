// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as auth from '@/hooks/useAuth'
import * as api from '@/lib/apiClient'
import type { DashRunResult, DashboardSpec } from '@/lib/dashboards/types'
import { DashboardHome } from './DashboardHome'
import { SCOPED_BANNER } from './labels'

const classicMounted = vi.fn()
vi.mock('@/features/tms/dashboard/DashboardPage', () => ({
  DashboardPage: () => { classicMounted(); return <div data-testid="classic-dashboard" /> },
}))
vi.mock('@/lib/apiClient', () => ({ listDashboards: vi.fn(), dashboardPreview: vi.fn(), getDashboard: vi.fn() }))

const SPEC = vi.hoisted(() => ({
  v: 1, title: 'Overview', scope: { kind: 'ME' },
  filters: { window: { preset: 'THIS_MONTH' }, divisions: [], customerIds: [], repIds: [], modes: [] },
  widgets: [{ id: 'w1', type: 'KPI', title: 'Revenue', size: 'S', query: { id: 'fin.summary', params: {} } }],
}) as unknown as DashboardSpec)
vi.mock('@/lib/dashboards/builtin', () => ({ OVERVIEW_SPEC: SPEC }))

function signIn(groups: string[], email = 'rep@example.test') {
  vi.spyOn(auth, 'useAuth').mockReturnValue({ user: { userId: 'u1', email, groups } } as unknown as ReturnType<typeof auth.useAuth>)
}

function run(viewAll: boolean): DashRunResult {
  return {
    results: [{ widgetId: 'w1', ok: true, kind: 'kpis', series: { kpis: [{ label: 'Revenue', value: 5000, format: 'cents' }], rows: [], groups: [], valueFormat: 'cents' } }],
    resolved: { from: '2026-11-01', to: '2026-11-30', months: ['2026-11'] },
    visibility: { viewAll, ownedCustomers: 2, teamKeys: [] }, asOf: '2026-11-04T00:00:00Z', ms: 5,
  }
}

function mount() {
  return render(<MemoryRouter initialEntries={['/tms/dashboard']}><DashboardHome /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listDashboards).mockResolvedValue({ company: [], mine: [] })
})

describe('DashboardHome', () => {
  it('hides New dashboard without the create claim and shows it with the claim', async () => {
    signIn(['page-tms', 'role-AR_AP'])
    vi.mocked(api.dashboardPreview).mockResolvedValue(run(true))
    const first = mount()
    await screen.findByTestId('classic-dashboard')
    expect(screen.queryByTestId('dash-new')).toBeNull()
    first.unmount()
    signIn(['page-tms', 'role-AR_AP', 'claim-DASHBOARDS_CREATE'])
    mount()
    expect(await screen.findByTestId('dash-new')).toBeInTheDocument()
  })

  it('never mounts the classic page for a viewer without see-all; runs the scoped Overview with the banner', async () => {
    signIn(['page-tms', 'role-CUSTOMER_REP'])
    vi.mocked(api.dashboardPreview).mockResolvedValue(run(false))
    mount()
    expect(await screen.findByText(SCOPED_BANNER)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('$50.00')).toBeInTheDocument())
    expect(classicMounted).not.toHaveBeenCalled()
    expect(api.dashboardPreview).toHaveBeenCalledWith({ builtin: 'OVERVIEW' })
  })
})
