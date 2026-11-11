import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { TmsAlert, TmsButton, TmsTabs } from '@/features/tms/kit'
import { DashboardPage } from '@/features/tms/dashboard/DashboardPage'
import { listDashboards } from '@/lib/apiClient'
import type { DashboardSummary } from '@/lib/dashboards/types'
import { DashboardCards } from './DashboardCards'
import { ScopedOverview } from './ScopedOverview'
import { AssistantChat } from '../assistant/AssistantChat'
import { useDashboardAccess } from './useDashboardAccess'
import './viewer.css'

type TabKey = 'overview' | 'ask' | 'company' | 'mine'

/**
 * `/tms/dashboard`: tabs above the untouched Company Dashboard. Viewers without "see all" never
 * mount `DashboardPage` (its hooks read every row from AppSync); they get the server-run Overview.
 */
export function DashboardHome() {
  const access = useDashboardAccess()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: TabKey = raw === 'company' || raw === 'mine' || raw === 'ask' ? raw : 'overview'
  const [lists, setLists] = useState<{ company: DashboardSummary[]; mine: DashboardSummary[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listDashboards().then(
      (l) => { if (live) setLists(l) },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Could not load dashboards.') },
    )
    return () => { live = false }
  }, [])

  const goNew = () => navigate('/tms/dashboard/new')
  const emptyAction = access.create ? { label: 'New dashboard', onClick: goNew } : undefined

  return (
    <>
      <div className="dash-home-bar">
        <TmsTabs
          active={tab}
          onSelect={(key) => setParams(key === 'overview' ? {} : { tab: key }, { replace: true })}
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'ask', label: 'Ask BCAT' },
            { key: 'company', label: 'Company dashboards', count: lists?.company.length },
            { key: 'mine', label: 'My dashboards', count: lists?.mine.length },
          ]}
        />
        {access.create ? (
          <TmsButton type="button" variant="primary" className="dash-new" data-testid="dash-new" onClick={goNew}>
            <Plus size={16} aria-hidden="true" /> New dashboard
          </TmsButton>
        ) : null}
      </div>
      {tab === 'ask' ? <AssistantChat /> : tab === 'overview' ? (access.viewAll ? <DashboardPage /> : <ScopedOverview />) : error ? (
        <TmsAlert tone="red" title="Could not load dashboards">{error}</TmsAlert>
      ) : !lists ? (
        <div className="dash-skeleton tms-chart-card" aria-busy="true" />
      ) : tab === 'company' ? (
        <DashboardCards items={lists.company} emptyTitle="No company dashboards yet." emptyAction={emptyAction} />
      ) : (
        <DashboardCards items={lists.mine} emptyTitle="You have no dashboards yet." emptyAction={emptyAction} />
      )}
    </>
  )
}

export default DashboardHome
