/**
 * Quotes › Spot inbox. A rep's quote requests that arrived by e-mail, with the fields read
 * from each, a suggested rate and a suggested response. The mailbox is read-only: nothing
 * is sent or drafted from here; the rep copies the response and sends it from Gmail.
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Settings } from 'lucide-react'
import { TmsAlert, TmsBadge, TmsButton, TmsEmptyState, TmsPage, TmsSelect, TmsTable, TmsTabs, type ColumnDef } from '@/features/tms/kit'
import { spotAction } from '@/lib/apiClient'
import { SPOT_FIXTURES } from '@/lib/spot/fixtures'
import { resolveSpotSettings } from '@/lib/spot/settings'
import type { SpotRequestRow, SpotSuggestion } from '@/lib/spot/types'
import { AddRequestDialog } from './AddRequestDialog'
import { RepSettingsDrawer } from './RepSettingsDrawer'
import { SpotRequestDrawer } from './SpotRequestDrawer'
import { laneText, money, relativeTime } from './spotHelpers'
import { PROSPECT_STATUSES, useCustomerList } from './useCustomerIndex'
import {
  SPOT_CALLBACK_PATH, SPOT_TABS, useSpotCounts, useSpotRequests, useSpotStatus,
} from './useSpotRequests'
import { OUTCOME_LABEL, OUTCOME_TONE } from '@/features/quotes/quoteViews'
import { spotOutcome } from './spotHelpers'
import './spot.css'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const STATUS_TONE: Record<string, 'blue' | 'green' | 'orange' | 'gray' | 'red'> = {
  NEW: 'blue', NEEDS_INFO: 'orange', SENT: 'green', WON: 'green', LOST: 'red', DISMISSED: 'gray',
}
const MATCH_CHIP: Record<string, string> = { EMAIL: 'Known contact', DOMAIN: 'Domain match', AMBIGUOUS: 'Ambiguous', NONE: 'Unknown sender' }

export function SpotInboxPage() {
  const { status, loading: statusLoading, error: statusError, refresh: refreshStatus } = useSpotStatus()
  const [params, setParams] = useSearchParams()
  const [tabKey, setTabKey] = useState('new')
  const tab = SPOT_TABS.find((t) => t.key === tabKey) ?? SPOT_TABS[0]
  const connection = status?.connection ?? null
  const live = connection?.status === 'CONNECTED' || connection?.status === 'PAUSED'
  const { rows, loading, error, refresh } = useSpotRequests({ tab, enabled: !!live })
  const { counts, refresh: refreshCounts } = useSpotCounts()
  const { customers } = useCustomerList()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fixtureId, setFixtureId] = useState('')
  const openId = params.get('request')

  const select = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('request', id)
    else next.delete('request')
    setParams(next, { replace: true })
  }
  const refreshAll = () => { refresh(); refreshCounts(); refreshStatus() }

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await work()
      toast.success(done)
      refreshAll()
    } catch (err) {
      toast.error(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const connectGmail = async () => {
    setBusy(true)
    try {
      const { url } = await spotAction('SPOT_OAUTH_START', { redirectUri: `${window.location.origin}${SPOT_CALLBACK_PATH}` })
      window.location.assign(url)
    } catch (err) {
      toast.error(messageOf(err))
      setBusy(false)
    }
  }

  const checkNow = () =>
    act(async () => {
      const { stats } = await spotAction('SPOT_POLL_NOW', {})
      toast.message(`Checked ${stats.listed} message${stats.listed === 1 ? '' : 's'}; ${stats.stored} new request${stats.stored === 1 ? '' : 's'}`)
    }, 'Inbox checked')

  const loadSample = () =>
    act(async () => {
      await spotAction('SPOT_SIM_INJECT', { fixtureId })
      await spotAction('SPOT_POLL_NOW', {})
    }, 'Sample mail loaded')

  if (statusLoading || !status) {
    return (
      <TmsPage title="Spot inbox">
        {statusError ? <TmsAlert tone="red">{statusError}</TmsAlert> : <p className="tms-muted">Loading…</p>}
      </TmsPage>
    )
  }

  const org = resolveSpotSettings(status.settings)
  const simulated = connection?.mode === 'SIMULATED'
  const notConfigured = status.gmailProvider.mode === 'STUB' && !connection
  const needsReconnect = connection?.status === 'NEEDS_RECONNECT'
  const customerById = Object.fromEntries(customers.map((c) => [c.id, c]))

  const connChip = !connection || connection.status === 'DISCONNECTED'
    ? <TmsBadge tone="gray" data-testid="spot-conn-chip">Not connected</TmsBadge>
    : needsReconnect
      ? <TmsBadge tone="red" data-testid="spot-conn-chip">Needs reconnect</TmsBadge>
      : simulated
        ? <TmsBadge tone="orange" data-testid="spot-simulated-badge">SIMULATED INBOX</TmsBadge>
        : <TmsBadge tone="green" data-testid="spot-conn-chip">Gmail connected · {connection.googleEmail ?? connection.userEmail}</TmsBadge>

  const companyChip = (row: SpotRequestRow) => {
    const c = row.customerId ? customerById[row.customerId] : null
    if (c) return <TmsBadge tone="blue">{c.status && PROSPECT_STATUSES[c.status] ? 'Prospect' : 'Customer'}</TmsBadge>
    return <TmsBadge tone="gray">{MATCH_CHIP[row.matchHow ?? 'NONE']}</TmsBadge>
  }

  const columns: Array<ColumnDef<SpotRequestRow>> = [
    { key: 'received', header: 'Received', render: (r) => <span data-testid={`spot-row-${r.id}`}>{relativeTime(r.receivedAt)}</span> },
    {
      key: 'from',
      header: 'From',
      render: (r) => (
        <span className="tms-spot-from">
          <span className="tms-spot-from-name">{r.fromName || r.fromEmail || 'Unknown'} {companyChip(r)}</span>
          <span className="tms-spot-from-sub">{r.subject}</span>
        </span>
      ),
    },
    { key: 'lane', header: 'Lane', render: (r) => laneText(r.extraction) },
    { key: 'equipment', header: 'Equipment', render: (r) => r.extraction?.equipmentType?.replace('_', ' ').toLowerCase() ?? '—' },
    { key: 'pickup', header: 'Pickup', render: (r) => r.extraction?.pickupDate ?? '—' },
    { key: 'weight', header: 'Weight', render: (r) => (r.extraction?.weightLbs != null ? `${r.extraction.weightLbs.toLocaleString()} lb` : '—') },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (r) => (r.classification ? <TmsBadge tone={r.classification.confidence === 'high' ? 'green' : 'orange'}>{r.classification.confidence}</TmsBadge> : '—'),
    },
    {
      key: 'price',
      header: 'Our price',
      render: (r) => <span className="tms-spot-numbers">{money((r.suggestion as SpotSuggestion | null | undefined)?.suggestedCents)}</span>,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) => {
        const outcome = spotOutcome(r.status)
        return outcome ? <TmsBadge tone={OUTCOME_TONE[outcome]} data-testid="spot-outcome">{OUTCOME_LABEL[outcome]}</TmsBadge> : <span className="tms-muted">—</span>
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <>
          <TmsBadge tone={STATUS_TONE[r.status] ?? 'gray'}>{r.status.replace('_', ' ').toLowerCase()}</TmsBadge>
          {r.needsAttention ? <TmsBadge tone="orange"> replied</TmsBadge> : null}
        </>
      ),
    },
  ]

  const tabs = SPOT_TABS.map((t) => ({
    key: t.key,
    label: t.label,
    count: t.key === 'new' ? counts?.new : t.key === 'needs-info' ? counts?.needsInfo : undefined,
  }))

  return (
    <TmsPage
      title="Spot inbox"
      actions={
        <>
          <TmsButton data-testid="spot-add" disabled={!live} onClick={() => setAddOpen(true)}>Add request</TmsButton>
          <TmsButton data-testid="spot-settings" disabled={!connection} onClick={() => setSettingsOpen(true)}>
            <Settings size={14} aria-hidden="true" /> Settings
          </TmsButton>
        </>
      }
    >
      <div className="tms-spot-strip">
        {connChip}
        {connection?.lastPollAt ? <span className="tms-muted">Checked {relativeTime(connection.lastPollAt)}</span> : null}
        <TmsBadge tone="gray" data-testid="spot-readonly-chip">Read-only mailbox</TmsBadge>
        <span className="tms-spot-strip-spacer" />
        {simulated ? (
          <>
            <TmsSelect
              aria-label="Sample mail"
              data-testid="spot-sim-fixture"
              value={fixtureId}
              placeholder="Sample mail…"
              options={SPOT_FIXTURES.map((f) => ({ value: f.id, label: `${f.label.toLowerCase().replace('_', ' ')} · ${f.note}` }))}
              onChange={(e) => setFixtureId(e.target.value)}
            />
            <TmsButton data-testid="spot-sim-load" disabled={busy || !fixtureId} onClick={() => void loadSample()}>Load sample mail</TmsButton>
          </>
        ) : null}
        <TmsButton data-testid="spot-poll-now" disabled={busy || !live} onClick={() => void checkNow()}>Check now</TmsButton>
      </div>

      {!org.enabled ? (
        <div className="tms-spot-banner">
          <TmsAlert tone="orange" title="Spot quoter is switched off by an admin">
            <span data-testid="spot-disabled">New mail is not being read until an admin switches it back on.</span>
          </TmsAlert>
        </div>
      ) : null}

      {notConfigured ? (
        <div className="tms-spot-banner">
          <TmsAlert tone="blue" title="Gmail sign-in is not set up yet">
            <span data-testid="spot-not-configured">
              Gmail sign-in is not set up yet. An admin adds the Google OAuth client under Settings → Integrations → Google
              (Gmail sign-in). Nothing is read from anyone’s mailbox until then.{' '}
              <Link to="/tms/brokerage/integrations">Open Integrations</Link>
            </span>
            {status.devStack ? (
              <div className="tms-spot-banner-actions">
                <TmsButton
                  variant="primary"
                  data-testid="spot-connect-simulated"
                  disabled={busy}
                  onClick={() => void act(() => spotAction('SPOT_CONNECT_SIMULATED', {}), 'Simulated inbox connected')}
                >
                  Use simulated inbox
                </TmsButton>
              </div>
            ) : null}
          </TmsAlert>
        </div>
      ) : null}

      {!notConfigured && (!connection || connection.status === 'DISCONNECTED') ? (
        <div className="tms-spot-banner">
          <TmsAlert tone="blue" title="Connect your Gmail">
            Your quote requests will appear here with a suggested rate, and BCAT Ops only reads quote-request e-mails — it never sends or drafts mail. You copy the suggested response and send it yourself.
            <div className="tms-spot-banner-actions">
              <TmsButton variant="primary" data-testid="spot-connect" disabled={busy} onClick={() => void connectGmail()}>Connect Gmail</TmsButton>
            </div>
          </TmsAlert>
        </div>
      ) : null}

      {needsReconnect ? (
        <div className="tms-spot-banner">
          <TmsAlert tone="red" title="Gmail needs to be reconnected">
            Google stopped accepting the saved access, so nothing is being read.
            <div className="tms-spot-banner-actions">
              <TmsButton variant="primary" data-testid="spot-reconnect" disabled={busy} onClick={() => void connectGmail()}>Reconnect</TmsButton>
            </div>
          </TmsAlert>
        </div>
      ) : null}

      {live ? (
        <>
          <TmsTabs tabs={tabs} active={tab.key} onSelect={setTabKey} />
          {error ? <TmsAlert tone="red">{error}</TmsAlert> : null}
          <TmsTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => select(r.id)}
            empty={
              <TmsEmptyState
                compact
                title={loading ? 'Loading…' : 'Nothing here'}
                message={loading ? undefined : 'Quote requests that arrive by e-mail will show up in this tab.'}
              />
            }
          />
        </>
      ) : null}

      <SpotRequestDrawer requestId={openId} status={status} onClose={() => select(null)} onChanged={refreshAll} />
      <RepSettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} status={status} onChanged={refreshAll} />
      <AddRequestDialog open={addOpen} onOpenChange={setAddOpen} onAdded={(id) => { refreshAll(); select(id) }} />
    </TmsPage>
  )
}
