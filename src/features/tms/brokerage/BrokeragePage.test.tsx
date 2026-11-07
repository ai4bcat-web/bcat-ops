// @vitest-environment jsdom
/**
 * Settings is eleven desks behind one tab strip, and the only thing that can go
 * quietly wrong is access: a tab drawn for somebody who may not open it, or a tab
 * missing for somebody who may. The guard behind each route is the boundary — these
 * assertions are about the strip agreeing with it, and about a tab actually routing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const auth = vi.hoisted(() => ({
  isOwner: false,
  isAdmin: false,
  loading: false,
  grants: [] as string[],
  // `AuthContext.hasPageAccess` is itself open for the owner and ADMIN; the guards
  // rely on that, so the stand-in has to behave the same way.
  hasPageAccess: (key: string) => auth.isOwner || auth.isAdmin || auth.grants.includes(key),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

// Each tab body is its own page with its own tests; here they are stand-ins, so this
// file is about the strip, the routes and the guards and nothing else.
vi.mock('@/features/settings/SettingsPage', () => ({ SettingsPage: () => <p>settings body</p> }))
vi.mock('@/features/users/UsersPage', () => ({ UsersPage: () => <p>users body</p> }))
vi.mock('@/features/commissions/CommissionsPage', () => ({ CommissionsPage: () => <p>commissions body</p> }))
vi.mock('@/features/reports/ReportsPage', () => ({ ReportsPage: () => <p>reports body</p> }))
vi.mock('@/features/audit/AuditPage', () => ({ AuditPage: () => <p>audit body</p> }))
vi.mock('@/features/tms/settings/DivisionsPage', () => ({ default: () => <p>divisions body</p> }))
vi.mock('@/features/tms/integrations/IntegrationsTab', () => ({ IntegrationsTab: () => <p>integrations body</p> }))
vi.mock('@/features/tms/settings/AiAgentsPage', () => ({ default: () => <p>ai agents body</p> }))
vi.mock('./DemoPage', () => ({ DemoPage: () => <p>demo body</p> }))
vi.mock('@/features/tms/settings/SpotQuoterSettingsPage', () => ({ SpotQuoterSettingsPage: () => <p>spot quoter body</p> }))
vi.mock('@/features/tms/settings/CarrierSalesSettingsPage', () => ({ CarrierSalesSettingsPage: () => <p>carrier sales body</p> }))
vi.mock('./company/CompanyTab', () => ({ default: () => <p>company body</p>, CompanyTab: () => <p>company body</p> }))

vi.mock('./company/AljexReconciliationPage', () => ({ AljexReconciliationPage: () => <p>reconciliation body</p> }))

import { BrokeragePage } from './BrokeragePage'

function draw(at = '/tms/brokerage') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/tms/brokerage/*" element={<BrokeragePage />} />
        <Route path="/tms/dashboard" element={<p>tms dashboard landing</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent)

beforeEach(() => {
  auth.isOwner = false
  auth.isAdmin = false
  auth.grants = []
})

describe('BrokeragePage', () => {
  it('gives an admin every desk, Settings first, under a Settings heading', () => {
    auth.isAdmin = true
    draw()

    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument()
    expect(tabNames()).toEqual([
      'Settings', 'Users', 'Commissions', 'Reports', 'Audit', 'Divisions & ownership',
      'Integrations', 'AI Agents', 'Spot quoter & e-mail', 'Carrier Sales', 'Company', 'Demo',
    ])
    expect(screen.getByText('settings body')).toBeInTheDocument()
  })

  it('hides the owner/ADMIN-only desks from a broker holding only the tms grant', () => {
    auth.grants = ['tms']
    draw()

    expect(tabNames()).toEqual(['Settings', 'Commissions', 'Reports', 'Audit', 'Demo'])
  })

  it('never draws Integrations for a broker holding only the tms grant', () => {
    auth.grants = ['tms']
    draw()

    expect(tabNames()).not.toContain('Integrations')
  })

  it('refuses a typed /integrations URL from a tms-grant user', () => {
    auth.grants = ['tms']
    draw('/tms/brokerage/integrations')

    expect(screen.queryByText('integrations body')).toBeNull()
    expect(screen.getByText('tms dashboard landing')).toBeInTheDocument()
  })

  it('opens Integrations for an admin, deep link included', () => {
    auth.isAdmin = true
    draw('/tms/brokerage/integrations/dat')

    expect(screen.getByText('integrations body')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Integrations' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a reports-only user the one desk their grant opens', () => {
    auth.grants = ['reports']
    draw('/tms/brokerage/reports')

    expect(tabNames()).toEqual(['Reports'])
    expect(screen.getByText('reports body')).toBeInTheDocument()
  })

  it('routes a tab click and marks the tab it landed on', async () => {
    auth.isAdmin = true
    draw()

    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }))

    await waitFor(() => expect(screen.getByText('audit body')).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Audit' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'false')
  })

  it('refuses a desk a grant does not open even when the URL is typed', () => {
    auth.grants = ['tms']
    draw('/tms/brokerage/users')

    expect(screen.queryByText('users body')).toBeNull()
  })

  it('opens the spot quoter desk for an admin and refuses it to a tms-grant user', () => {
    auth.isAdmin = true
    const admin = draw('/tms/brokerage/spot-quoter')
    expect(screen.getByText('spot quoter body')).toBeInTheDocument()
    admin.unmount()

    auth.isAdmin = false
    auth.grants = ['tms']
    draw('/tms/brokerage/spot-quoter')
    expect(screen.queryByText('spot quoter body')).toBeNull()
  })

  it('opens the Carrier Sales desk for an admin and refuses it to a tms-grant user', () => {
    auth.isAdmin = true
    const admin = draw('/tms/brokerage/carrier-sales')
    expect(screen.getByText('carrier sales body')).toBeInTheDocument()
    admin.unmount()

    auth.isAdmin = false
    auth.grants = ['tms']
    draw('/tms/brokerage/carrier-sales')
    expect(screen.queryByText('carrier sales body')).toBeNull()
  })

  it('opens the deep-linked divisions desk for an owner', () => {
    auth.isOwner = true
    draw('/tms/brokerage/divisions')

    expect(screen.getByText('divisions body')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Divisions & ownership' })).toHaveAttribute('aria-selected', 'true')
  })

  it('lets the aljexSignoff grant open only the reconciliation route, and nothing else under Company', () => {
    auth.grants = ['aljexSignoff']
    const recon = draw('/tms/brokerage/company/data/aljex-reconciliation')
    expect(screen.getByText('reconciliation body')).toBeInTheDocument()
    expect(screen.queryByText('company body')).toBeNull()
    recon.unmount()

    draw('/tms/brokerage/company/billing')
    expect(screen.queryByText('company body')).toBeNull()
    expect(screen.queryByText('reconciliation body')).toBeNull()
  })

  it('sends a user without the grant away from the reconciliation route', () => {
    auth.grants = ['tms']
    draw('/tms/brokerage/company/data/aljex-reconciliation')

    expect(screen.queryByText('reconciliation body')).toBeNull()
    expect(screen.queryByText('company body')).toBeNull()
  })

  it('shows an admin the reconciliation route inside the Company tab', () => {
    auth.isAdmin = true
    draw('/tms/brokerage/company/data/aljex-reconciliation')

    expect(screen.getByText('company body')).toBeInTheDocument()
  })
})
