import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Mail, Users, Send, RefreshCw } from 'lucide-react'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useCarrierCapacity } from '@/hooks/useCarrierBlast'
import type { CarrierCapacity } from '@/lib/apiClient'
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
  const { capacity, loading, error, refresh } = useCarrierCapacity()

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

        <CapacityBanner capacity={capacity} loading={loading} error={error} onRefresh={refresh} />

        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'lists' && <ListsTab />}
          {tab === 'campaigns' && <CampaignsTab capacity={capacity} />}
          {tab === 'replies' && <RepliesTab preselectedCampaignId={preselectedCampaignId} />}
        </div>
      </div>
    </div>
  )
}

function formatUpdated(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function CapacityBanner({
  capacity,
  loading,
  error,
  onRefresh,
}: {
  capacity: CarrierCapacity | null
  loading: boolean
  error: Error | null
  onRefresh: () => void
}) {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!capacity) {
    return (
      <div
        style={{
          background: 'var(--ds-bg)',
          border: '1px solid var(--ds-border)',
          borderRadius: 10,
          padding: 12,
          fontSize: 13,
          color: 'var(--ds-t3)',
        }}
      >
        {loading ? 'Loading sending capacity…' : error ? `Capacity unavailable: ${error.message}` : 'Capacity unavailable'}
      </div>
    )
  }

  const isDepleted = capacity.availableToday === 0
  const updatedMs = Math.max(0, now - new Date(capacity.asOf).getTime())
  const updatedText = formatUpdated(updatedMs)

  return (
    <div
      data-testid="capacity-banner"
      style={{
        background: isDepleted ? 'var(--ds-red-bg)' : 'var(--ds-blue-bg)',
        border: isDepleted ? '1px solid var(--ds-red)' : '1px solid var(--ds-blue)',
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: isDepleted ? 'var(--ds-red)' : 'var(--ds-blue-dark)',
            }}
          >
            {capacity.availableToday} emails available to send today
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ds-t2)', marginTop: 4 }}>
            {capacity.mailboxes} mailboxes × {capacity.perMailboxLimit}/day - {capacity.sentToday} already sent today - {capacity.reservedForJobsDone} reserved for JobsDone OS
          </div>
          {isDepleted && (
            <div style={{ fontSize: 12, color: 'var(--ds-red)', fontWeight: 600, marginTop: 6 }}>
              Today's capacity is used up; sending resumes tomorrow.
            </div>
          )}
          <div
            style={{
              fontSize: 12,
              color: capacity.jobsDone.reachable ? 'var(--ds-t3)' : 'var(--ds-amber)',
              marginTop: 6,
            }}
          >
            {capacity.jobsDone.reachable
              ? `JobsDone OS: ${capacity.jobsDone.sharedClientsActive} active shared client${capacity.jobsDone.sharedClientsActive === 1 ? '' : 's'}.`
              : "Couldn't reach JobsDone OS - holding the full reserve to be safe."}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh capacity"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--ds-t3)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          <RefreshCw size={14} />
          updated {updatedText}
        </button>
      </div>
    </div>
  )
}
