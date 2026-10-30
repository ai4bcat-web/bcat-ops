/**
 * My Brokerage → Company.
 *
 * One tab with an inner strip of six pages: the business identity, how money is
 * collected, how the product looks, how notifications leave, how data is imported,
 * and the account itself. `BrokeragePage` owns the h1, so this body renders no
 * heading of its own.
 */
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { TmsTabs } from '@/features/tms/kit'
import { BillingPage } from './BillingPage'
import { BrandingPage } from './BrandingPage'
import { CompanyPage } from './CompanyPage'
import { NotificationsPage } from './NotificationsPage'
import { ImportPage } from './ImportPage'
import { AljexImportPage } from './AljexImportPage'
import { AccountPage } from './AccountPage'

const ROOT = '/tms/brokerage/company'

const TABS = [
  { key: 'company', label: 'Company' },
  { key: 'billing', label: 'Billing' },
  { key: 'branding', label: 'Branding' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'import', label: 'Import' },
  { key: 'aljex-import', label: 'Aljex import' },
  { key: 'account', label: 'Account' },
] as const

type CompanyTabKey = (typeof TABS)[number]['key']

/** The deepest inner tab the URL is on — '' only matches the bare root. */
function activeTab(pathname: string): CompanyTabKey {
  const rest = pathname.startsWith(ROOT) ? pathname.slice(ROOT.length).replace(/^\//, '') : ''
  const segment = rest.split('/')[0]
  return (TABS.find((t) => t.key === segment)?.key ?? 'company') as CompanyTabKey
}

export function CompanyTab() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const active = activeTab(pathname)

  return (
    <div>
      <TmsTabs
        tabs={[...TABS]}
        active={active}
        onSelect={(key) => navigate(`${ROOT}/${key}`)}
      />
      <div style={{ marginTop: 16 }}>
        <Routes>
          <Route index element={<Navigate to={`${ROOT}/company`} replace />} />
          <Route path="company" element={<CompanyPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="branding" element={<BrandingPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="aljex-import" element={<AljexImportPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<Navigate to={`${ROOT}/company`} replace />} />
        </Routes>
      </div>
    </div>
  )
}

export default CompanyTab
