/**
 * My Brokerage — the settings of the business and the desks run from it.
 *
 * One page, seven tabs, each its own URL under `/tms/brokerage/*` so a tab can be
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
import { TmsPage, TmsTabs } from '@/features/tms/kit'
import { AuditPage } from '@/features/audit/AuditPage'
import { CommissionsPage } from '@/features/commissions/CommissionsPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import DivisionsPage from '@/features/tms/settings/DivisionsPage'
import ShipmentViewsPage from '@/features/tms/settings/ShipmentViewsPage'
import { UsersPage } from '@/features/users/UsersPage'
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
 * the two taxonomy editors that decide how everything above is sliced.
 */
const TABS: BrokerageTab[] = [
  { key: 'settings', label: 'Settings', path: '', pages: ['settings', TMS_PAGE_KEY] },
  { key: 'users', label: 'Users', path: 'users', pages: [] },
  { key: 'commissions', label: 'Commissions', path: 'commissions', pages: ['commissions', TMS_PAGE_KEY] },
  { key: 'reports', label: 'Reports', path: 'reports', pages: ['reports', TMS_PAGE_KEY] },
  { key: 'audit', label: 'Audit', path: 'audit', pages: ['audit', TMS_PAGE_KEY] },
  { key: 'divisions', label: 'Divisions & ownership', path: 'divisions', pages: [] },
  { key: 'views', label: 'Shipment views', path: 'views', pages: [] },
]

/** The deepest tab whose path the URL is on — '' only matches the bare root. */
function activeTab(pathname: string): string {
  const rest = pathname.startsWith(ROOT) ? pathname.slice(ROOT.length).replace(/^\//, '') : ''
  const segment = rest.split('/')[0]
  return TABS.find((t) => t.path === segment)?.key ?? 'settings'
}

export function BrokeragePage() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { isOwner, isAdmin, hasPageAccess } = useAuth()

  const everything = isOwner || isAdmin
  const visible = TABS.filter((t) => everything || (t.pages.length > 0 && t.pages.some(hasPageAccess)))
  const active = activeTab(pathname)

  return (
    <TmsPage title="My Brokerage">
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
        <Route path="commissions" element={<RequirePage page={['commissions', TMS_PAGE_KEY]}><CommissionsPage /></RequirePage>} />
        <Route path="reports" element={<RequirePage page={['reports', TMS_PAGE_KEY]}><ReportsPage /></RequirePage>} />
        <Route path="audit" element={<RequirePage page={['audit', TMS_PAGE_KEY]}><AuditPage /></RequirePage>} />
        <Route path="divisions" element={<RequireAdmin><DivisionsPage /></RequireAdmin>} />
        <Route path="views" element={<RequireAdmin><ShipmentViewsPage /></RequireAdmin>} />
        {/* An unknown tab is a stale link, not a dead end: Settings is the page's home. */}
        <Route path="*" element={<Navigate to={ROOT} replace />} />
      </Routes>
    </TmsPage>
  )
}

export default BrokeragePage
