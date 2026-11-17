/**
 * The Carriers page: three URL-backed tabs. Find & Invite is first and the default
 * (`/tms/carriers/find`); the Carrier list is second (`/tms/carriers`); Remit e-mails is third (`/tms/carriers/remit`). A carrier's own page
 * (`/tms/carriers/:id`) stays the list board with that profile open.
 */
import { useNavigate } from 'react-router-dom'
import { TmsTabs } from '@/features/tms/kit'
import { CarriersPage } from './CarriersPage'
import { FindInvitePage } from './find/FindInvitePage'
import { RemitDirectoryPage } from './remit/RemitDirectoryPage'

type CarriersTabKey = 'find' | 'list' | 'remit'

const CARRIERS_TABS: Array<{ key: CarriersTabKey; label: string; to: string }> = [
  { key: 'find', label: 'Find & Invite', to: '/tms/carriers/find' },
  { key: 'list', label: 'Carrier list', to: '/tms/carriers' },
  { key: 'remit', label: 'Remit e-mails', to: '/tms/carriers/remit' },
]

export function CarriersHub({ tab }: { tab: CarriersTabKey }) {
  const navigate = useNavigate()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
      <div style={{ padding: '0 var(--tms-gutter)' }}>
        <TmsTabs
          tabs={CARRIERS_TABS.map(({ key, label }) => ({ key, label }))}
          active={tab}
          onSelect={(key) => navigate(CARRIERS_TABS.find((t) => t.key === key)!.to)}
        />
      </div>
      {tab === 'find' ? <FindInvitePage /> : tab === 'remit' ? <RemitDirectoryPage /> : <CarriersPage />}
    </div>
  )
}
