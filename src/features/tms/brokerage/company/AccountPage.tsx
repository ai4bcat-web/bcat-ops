/**
 * My Brokerage → Company → Account.
 *
 * Read-only stack and integration summary. BCAT has no subscription billing, so
 * this page shows the running environment instead of a Stripe portal.
 */
import { useEffect, useState } from 'react'
import { Cloud } from 'lucide-react'
import { TmsBadge, TmsCard } from '@/features/tms/kit'
import { getAccountInfo } from '@/lib/apiClient'
import type { AccountInfo } from '@/lib/apiClient'
import { ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function healthTone(health: string) {
  switch (health) {
    case 'OK': return 'green'
    case 'INVALID_CREDENTIALS': return 'red'
    case 'UNABLE_TO_VERIFY': return 'orange'
    default: return 'gray'
  }
}

function statusTone(status: string) {
  switch (status) {
    case 'CONNECTED': return 'green'
    case 'DISCONNECTED': return 'red'
    default: return 'gray'
  }
}

export function AccountPage() {
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAccountInfo()
      .then((result) => {
        if (cancelled) return
        setInfo(result)
      })
      .catch((err) => {
        if (cancelled) return
        setError(messageOf(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <TmsCard>
        <Loading />
      </TmsCard>
    )
  }

  if (!info) {
    return (
      <TmsCard title="Account">
        <ErrorText>Could not load account information.</ErrorText>
      </TmsCard>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={Cloud}
        title="Account"
        description="Stack environment and connected integrations. BCAT owns this software; there is no subscription or per-seat charge."
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}

          <Panel>
            <GroupLabel>Stack</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <div>
                <div className="tms-field-label">Region</div>
                <div style={{ fontSize: 14 }}>{info.stack.region}</div>
              </div>
              <div>
                <div className="tms-field-label">User pool</div>
                <div style={{ fontSize: 14, wordBreak: 'break-all' }}>{info.stack.userPoolId}</div>
              </div>
              <div>
                <div className="tms-field-label">AppSync URL</div>
                <div style={{ fontSize: 14, wordBreak: 'break-all' }}>{info.stack.appSyncUrl}</div>
              </div>
              <div>
                <div className="tms-field-label">Storage bucket</div>
                <div style={{ fontSize: 14, wordBreak: 'break-all' }}>{info.stack.storageBucket}</div>
              </div>
            </div>
          </Panel>
        </Stack>
      </SettingsCard>

      <TmsCard title="Integrations">
        {info.integrations.length === 0 ? (
          <p className="tms-muted">No integration rows loaded.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {info.integrations.map((integration) => (
              <Panel key={integration.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{integration.provider}</div>
                  <div className="tms-field-hint">{integration.kind} · {integration.mode}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <TmsBadge tone={statusTone(integration.status)}>{integration.status}</TmsBadge>
                  <TmsBadge tone={healthTone(integration.health)}>{integration.health}</TmsBadge>
                </div>
              </Panel>
            ))}
          </div>
        )}
      </TmsCard>

      <TmsCard title="Billing">
        <p style={{ margin: 0, fontSize: 14 }}>
          There is no subscription, seat count or prorated charge. AWS infrastructure and
          model usage are the only running costs; manage those limits on the AI Agents page.
        </p>
      </TmsCard>
    </div>
  )
}

export default AccountPage
