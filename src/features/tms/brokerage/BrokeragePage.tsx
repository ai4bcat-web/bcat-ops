/**
 * Settings — the settings of the business and the desks run from it.
 *
 * One page, eleven tabs, each its own URL under `/tms/brokerage/*` so a tab can be
 * linked and bookmarked. The h1 and the tab strip live here; every tab body is just a
 * body (no title row of its own), which is why `SettingsPage`, `UsersPage`,
 * `CommissionsPage`, `ReportsPage` and `AuditPage` render no heading.
 *
 * Access is enforced twice over, on purpose. A tab a caller may not open is not drawn
 * at all — that is tidiness — and the route behind it is still wrapped in the same
 * `RequirePage` / `RequireAdmin` guard the standalone routes carried before Step R,
 * because a typed URL must be refused whether or not the tab was ever visible.
 */
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { RequireAdmin, RequirePage } from '@/components/RequirePage'
import { DormantPage } from '@/components/RequireModels'
import { TmsPage, TmsTabs } from '@/features/tms/kit'
import { AuditPage } from '@/features/audit/AuditPage'
import { CommissionsPage } from '@/features/commissions/CommissionsPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import DivisionsPage from '@/features/tms/settings/DivisionsPage'
import AiAgentsPage from '@/features/tms/settings/AiAgentsPage'
import { IntegrationsTab } from '@/features/tms/integrations/IntegrationsTab'
import { CompanyTab } from '@/features/tms/brokerage/company/CompanyTab'
import { AljexReconciliationPage } from '@/features/tms/brokerage/company/AljexReconciliationPage'
import { ALJEX_SIGNOFF_PAGE_KEY } from '@/lib/aljexReconcile'
import { UsersPage } from '@/features/users/UsersPage'
import { DemoPage } from './DemoPage'
import { SpotQuoterSettingsPage } from '@/features/tms/settings/SpotQuoterSettingsPage'
import { CarrierSalesSettingsPage } from '@/features/tms/settings/CarrierSalesSettingsPage'
import { useAuth } from '@/hooks/useAuth'
import { TMS_PAGE_KEY } from '@/lib/navSections'

const ROOT = '/tms/brokerage'

interface BrokerageTab {
  key: string
  label: string
  /** The path under `/tms/brokerage`; '' is the Settings tab at the root. */
  path: string
  /** Any one of these page keys opens the tab. Empty means owner/ADMIN only. */
  pages: string[]
}

/**
 * The tab strip, in the order Ryne reads it: what the business is set to, then the
 * people, then the money the people earned, then the numbers, then the record, then
 * the divisions editor that decides how everything above is sliced.
 */
const TABS: BrokerageTab[] = [
  { key: 'settings', label: 'Settings', path: '', pages: ['settings', TMS_PAGE_KEY] },
  { key: 'users', label: 'Users', path: 'users', pages: [] },
  { key: 'commissions', label: 'Commissions', path: 'commissions', pages: ['commissions', TMS_PAGE_KEY] },
  { key: 'reports', label: 'Reports', path: 'reports', pages: ['reports', TMS_PAGE_KEY] },
  { key: 'audit', label: 'Audit', path: 'audit', pages: ['audit', TMS_PAGE_KEY] },
  { key: 'divisions', label: 'Divisions & ownership', path: 'divisions', pages: [] },
  { key: 'integrations', label: 'Integrations', path: 'integrations', pages: [] },
  { key: 'ai-agents', label: 'AI Agents', path: 'ai-agents', pages: [] },
  { key: 'spot-quoter', label: 'Spot quoter & e-mail', path: 'spot-quoter', pages: [] },
  { key: 'carrier-sales', label: 'Carrier Sales', path: 'carrier-sales', pages: [] },
  { key: 'company', label: 'Company', path: 'company', pages: [] },
  { key: 'demo', label: 'Demo', path: 'demo', pages: [TMS_PAGE_KEY] },
]

/** The deepest tab whose path the URL is on — '' only matches the bare root. */
function activeTab(pathname: string): string {
  const rest = pathname.startsWith(ROOT) ? pathname.slice(ROOT.length).replace(/^\//, '') : ''
  const segment = rest.split('/')[0]
  return TABS.find((t) => t.path === segment)?.key ?? 'settings'
}

/**
 * The reconciliation page is the one Company desk a non-admin may open: the per-user `aljexSignoff` grant
 * (AuthContext.hasPageAccess never opens that key for ADMIN/owner) lands on the bare page, with no Company strip.
 * Owner/ADMIN keep the whole Company tab around it. The Lambda decides who may decide and sign off.
 */
function ReconciliationRoute() {
  const { isOwner, isAdmin, hasPageAccess } = useAuth()
  if (isOwner || isAdmin) return <CompanyTab />
  if (hasPageAccess(ALJEX_SIGNOFF_PAGE_KEY)) return <DormantPage page="aljexReconciliation"><AljexReconciliationPage /></DormantPage>
  return <Navigate to={ROOT} replace />
}

export function BrokeragePage() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { isOwner, isAdmin, hasPageAccess } = useAuth()

  const everything = isOwner || isAdmin
  const visible = TABS.filter((t) => everything || (t.pages.length > 0 && t.pages.some(hasPageAccess)))
  const active = activeTab(pathname)

  return (
    <TmsPage title="Settings">
      <TmsTabs
        tabs={visible.map((t) => ({ key: t.key, label: t.label }))}
        active={active}
        onSelect={(key) => {
          const tab = TABS.find((t) => t.key === key)
          if (tab) navigate(tab.path ? `${ROOT}/${tab.path}` : ROOT)
        }}
      />

      <Routes>
        <Route index element={<RequirePage page={['settings', TMS_PAGE_KEY]}><SettingsPage /></RequirePage>} />
        <Route path="users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
        <Route path="commissions" element={<RequirePage page={['commissions', TMS_PAGE_KEY]}><DormantPage page="commissions"><CommissionsPage /></DormantPage></RequirePage>} />
        <Route path="reports" element={<RequirePage page={['reports', TMS_PAGE_KEY]}><DormantPage page="reports"><ReportsPage /></DormantPage></RequirePage>} />
        <Route path="audit" element={<RequirePage page={['audit', TMS_PAGE_KEY]}><AuditPage /></RequirePage>} />
        <Route path="divisions" element={<RequireAdmin><DormantPage page="divisions"><DivisionsPage /></DormantPage></RequireAdmin>} />
        {/* The tab owns its own index and `:provider` routes, so the strip stays lit
            on a deep link; the guard is here, where a typed URL still meets it. */}
        <Route path="integrations/*" element={<RequireAdmin><DormantPage page="integrations"><IntegrationsTab /></DormantPage></RequireAdmin>} />
        {/* The page carries its own inner tab strip under one path, so the route is a
            wildcard for the same reason Integrations is. */}
        <Route path="ai-agents/*" element={<RequireAdmin><DormantPage page="aiAgents"><AiAgentsPage /></DormantPage></RequireAdmin>} />
        <Route path="spot-quoter" element={<RequireAdmin><DormantPage page="spotQuoter"><SpotQuoterSettingsPage /></DormantPage></RequireAdmin>} />
        <Route path="carrier-sales" element={<RequireAdmin><CarrierSalesSettingsPage /></RequireAdmin>} />
        <Route path="company/data/aljex-reconciliation" element={<ReconciliationRoute />} />
        <Route path="company/*" element={<RequireAdmin><CompanyTab /></RequireAdmin>} />
        <Route path="demo" element={<RequirePage page={[TMS_PAGE_KEY]}><DormantPage page="demo"><DemoPage /></DormantPage></RequirePage>} />
        {/* An unknown tab is a stale link, not a dead end: Settings is the page's home. */}
        <Route path="*" element={<Navigate to={ROOT} replace />} />
      </Routes>
    </TmsPage>
  )
}

export default BrokeragePage
