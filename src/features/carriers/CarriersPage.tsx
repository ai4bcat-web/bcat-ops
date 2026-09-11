import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Mail, Users, Send } from 'lucide-react'
import { useIsMobile } from '@/hooks/useIsMobile'
import { ListsTab } from './ListsTab'
import { CampaignsTab } from './CampaignsTab'
import { RepliesTab } from './RepliesTab'

type TabKey = 'lists' | 'campaigns' | 'replies'

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: 'lists', label: 'Lists', icon: Users },
  { key: 'campaigns', label: 'Campaigns', icon: Send },
  { key: 'replies', label: 'Replies', icon: Mail },
]

export function CarriersPage() {
  const location = useLocation()
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<TabKey>('lists')
  const preselectedCampaignId = (location.state as { campaignId?: string } | null)?.campaignId

  useEffect(() => {
    const stateTab = (location.state as { tab?: TabKey } | null)?.tab
    if (stateTab) setTab(stateTab)
  }, [location.state])

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16, minHeight: '100%' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Carriers</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
            Email-blast carrier lists through Instantly and manage replies in one shared inbox.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid var(--ds-border)' }}>
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              data-testid={`carriers-tab-${key}`}
              onClick={() => setTab(key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 13, fontWeight: 500, padding: '8px 12px',
                border: 'none', borderBottom: `2px solid ${tab === key ? 'var(--ds-blue)' : 'transparent'}`,
                background: 'transparent', color: tab === key ? 'var(--ds-blue-dark)' : 'var(--ds-t3)',
                cursor: 'pointer', fontFamily: 'inherit', marginBottom: -1,
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'lists' && <ListsTab />}
          {tab === 'campaigns' && <CampaignsTab />}
          {tab === 'replies' && <RepliesTab preselectedCampaignId={preselectedCampaignId} />}
        </div>
      </div>
    </div>
  )
}
