/**
 * Accounting · AP inbox: connect the read-only mailbox, when it is reviewed, and how far the
 * automation may go. Sits directly under `ApSettingsCard`. Admin only (the page gates it; the
 * Lambda enforces it). The Google client itself is entered under Settings › Integrations › Google.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { graphqlErrorText } from '@/lib/apiClient'
import { formatDigest } from '@/lib/apInbox/digest'
import {
  apInboxConnectSimulated, apInboxDisconnect, apInboxOauthStart, apInboxSaveSettings, type ApInboxStatusView,
} from '@/features/ap/inbox/apInboxClient'
import { useApInboxStatus, type ApInboxStatusHandle } from '@/features/ap/inbox/useApInbox'
import { SPOT_CALLBACK_PATH } from '@/features/spot-quoter/useSpotRequests'
import { formFromConfig, parseApInboxForm, type ApInboxForm } from './apInboxSettingsModel'
import { CheckRow, ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'

const PILL: Record<ApInboxStatusView['connection']['status'], string> = {
  NOT_CONNECTED: 'Not connected',
  PENDING: 'Waiting for Google',
  CONNECTED: 'Connected',
  NEEDS_RECONNECT: 'Needs reconnecting',
  SIMULATED: 'Simulated mailbox',
}

export function ApInboxSettingsCard() {
  const s = useApInboxStatus()
  return (
    <SettingsCard
      icon={Inbox}
      title="Accounting · AP inbox"
      description="A read-only mailbox is reviewed every day and on Review now. Carrier and vendor invoice e-mails update the matching bill's invoice number and dates, or wait for a person in Accounts Payable › AP inbox. Nothing is ever approved or paid from here."
    >
      <div data-testid="ap-inbox-settings-card">
        {s.status ? <CardBody status={s.status} sync={s} /> : s.error ? <ErrorText>{s.error}</ErrorText> : <Loading />}
      </div>
    </SettingsCard>
  )
}

function CardBody({ status, sync }: { status: ApInboxStatusView; sync: ApInboxStatusHandle }) {
  // Keyed by version: a save (or a reconnect elsewhere) re-seeds the form from the server's copy.
  return <Form key={status.config.version} status={status} sync={sync} />
}

function Form({ status, sync }: { status: ApInboxStatusView; sync: ApInboxStatusHandle }) {
  const { config, connection } = status
  const [form, setForm] = useState<ApInboxForm>(() => formFromConfig(config))
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof ApInboxForm>(key: K, value: ApInboxForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  const connected = connection.status === 'CONNECTED' || connection.status === 'SIMULATED'
  const line = formatDigest({ connection: connection.status, run: status.runs[0] ?? null, openCount: status.openCount, now: new Date(), runHourChicago: config.runHourChicago })

  const act = (work: Promise<unknown>, done: string) => {
    setBusy(true)
    setError(null)
    return work
      .then(() => { toast.success(done); return sync.refresh() })
      .catch((e: unknown) => { const t = graphqlErrorText(e); setError(t); toast.error(t) })
      .finally(() => setBusy(false))
  }

  const connect = () => {
    setBusy(true)
    setError(null)
    apInboxOauthStart(`${window.location.origin}${SPOT_CALLBACK_PATH}`)
      .then((r) => window.location.assign(r.url))
      .catch((e: unknown) => { setError(graphqlErrorText(e)); setBusy(false) })
  }

  const save = () => {
    const parsed = parseApInboxForm(form)
    if ('error' in parsed) { setError(parsed.error); return }
    setSaving(true)
    setError(null)
    apInboxSaveSettings(parsed.config, config.version)
      .then(() => { toast.success('AP inbox settings saved'); return sync.refresh() })
      .catch((e: unknown) => { const t = graphqlErrorText(e); setError(t); toast.error(t) })
      .finally(() => setSaving(false))
  }

  const reviewNow = () => {
    void sync.syncNow().then((failure) => { if (failure) setError(failure) })
  }

  return (
    <Stack>
      <Panel>
        <Stack gap={8}>
          <GroupLabel>Mailbox</GroupLabel>
          <TmsField label="Mailbox address">
            <TmsInput aria-label="AP inbox mailbox" value={form.mailbox} onChange={(e) => set('mailbox', e.target.value)} placeholder="ai4bcat@gmail.com" />
          </TmsField>
          <p className="tms-flush text-sm">
            <span data-testid="ap-inbox-status-pill"><strong>{PILL[connection.status]}</strong></span>
            {` · ${connection.googleEmail ?? config.mailbox}`}{connection.status === 'SIMULATED' ? ' (no Google account is read)' : ''}
          </p>
          {connection.lastError && <ErrorText>{connection.lastError}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            {connection.status !== 'SIMULATED' && (
              <TmsButton size="sm" data-testid="ap-inbox-connect" disabled={busy || !status.providerReady} onClick={connect}>
                {connection.status === 'CONNECTED' || connection.status === 'NEEDS_RECONNECT' ? 'Reconnect Google account' : 'Connect Google account'}
              </TmsButton>
            )}
            {(connection.status === 'CONNECTED' || connection.status === 'NEEDS_RECONNECT' || connection.status === 'SIMULATED') && (
              <TmsButton size="sm" data-testid="ap-inbox-disconnect" disabled={busy} onClick={() => void act(apInboxDisconnect(), 'AP inbox disconnected')}>
                Disconnect
              </TmsButton>
            )}
            {status.devStack && connection.status !== 'SIMULATED' && (
              <TmsButton size="sm" data-testid="ap-inbox-sim" disabled={busy} onClick={() => void act(apInboxConnectSimulated(), 'Simulated mailbox connected')}>
                Use simulated mailbox
              </TmsButton>
            )}
          </div>
          {!status.providerReady && (
            <Hint>The Google client is not entered yet. Enter the Client ID and Secret under <Link to="/tms/brokerage/integrations" className="underline">Settings › Integrations › Google</Link> first.</Hint>
          )}
          <Hint>
            The mailbox is read with read-only access; nothing is sent, labelled or deleted. While the Google app is in <em>Testing</em>, the account must be a listed test user and the connection expires every 7 days — reconnect here when the AP page says Google no longer accepts it.{' '}
            <Link to="/tms/brokerage/integrations" className="underline">Google settings</Link>
          </Hint>
        </Stack>
      </Panel>

      <Stack gap={8}>
        <GroupLabel>Schedule</GroupLabel>
        <CheckRow ariaLabel="AP inbox enabled" align="start" label="Review the mailbox every day" checked={form.enabled} disabled={!connected} onChange={(v) => set('enabled', v)} />
        <div className="flex flex-wrap gap-3">
          <TmsField label="Run hour (Chicago, 0–23)"><TmsInput aria-label="Run hour" inputMode="numeric" value={form.runHourChicago} onChange={(e) => set('runHourChicago', e.target.value)} /></TmsField>
          <TmsField label="First-run look-back (hours)"><TmsInput aria-label="Look-back hours" inputMode="numeric" value={form.lookbackHours} onChange={(e) => set('lookbackHours', e.target.value)} /></TmsField>
        </div>
      </Stack>

      <Stack gap={8}>
        <GroupLabel>Automation</GroupLabel>
        <CheckRow
          ariaLabel="AP inbox auto-update"
          align="start"
          label="Update bills automatically when the match is certain"
          checked={form.autoApply}
          onChange={(v) => set('autoApply', v)}
        />
        <Hint>Only a bill still waiting for its invoice number is touched, and only its invoice number, dates and (in review) amount. Status, approval, payee and payments never change, and every update can be undone. Turn this off to queue everything for a person.</Hint>
        <div className="flex flex-wrap gap-3">
          <TmsField label="Auto-update score (0.85–0.99)"><TmsInput aria-label="Auto-update score" inputMode="decimal" value={form.autoApplyMinScore} onChange={(e) => set('autoApplyMinScore', e.target.value)} /></TmsField>
          <TmsField label="Review floor (0.30+)"><TmsInput aria-label="Review floor" inputMode="decimal" value={form.reviewMinScore} onChange={(e) => set('reviewMinScore', e.target.value)} /></TmsField>
        </div>
        <div className="flex flex-wrap gap-3">
          <TmsField label="E-mails per run"><TmsInput aria-label="E-mails per run" inputMode="numeric" value={form.maxMessagesPerRun} onChange={(e) => set('maxMessagesPerRun', e.target.value)} /></TmsField>
          <TmsField label="Reads per run"><TmsInput aria-label="Reads per run" inputMode="numeric" value={form.maxModelCallsPerRun} onChange={(e) => set('maxModelCallsPerRun', e.target.value)} /></TmsField>
          <TmsField label="Auto-updates per run"><TmsInput aria-label="Auto-updates per run" inputMode="numeric" value={form.maxAutoAppliesPerRun} onChange={(e) => set('maxAutoAppliesPerRun', e.target.value)} /></TmsField>
        </div>
      </Stack>

      <Stack gap={8}>
        <GroupLabel>Retention</GroupLabel>
        <Hint>Only invoice e-mails are kept. Everything else is read and forgotten.</Hint>
        <div className="flex flex-wrap gap-3">
          <TmsField label="Dismissed (days)"><TmsInput aria-label="Dismissed retention days" inputMode="numeric" value={form.dismissedRetentionDays} onChange={(e) => set('dismissedRetentionDays', e.target.value)} /></TmsField>
          <TmsField label="Resolved (days)"><TmsInput aria-label="Resolved retention days" inputMode="numeric" value={form.resolvedRetentionDays} onChange={(e) => set('resolvedRetentionDays', e.target.value)} /></TmsField>
        </div>
        <TmsField label="Ignore senders" hint="One address or domain per line.">
          <TmsTextarea aria-label="Ignore senders" rows={3} value={form.ignoreSenders} onChange={(e) => set('ignoreSenders', e.target.value)} />
        </TmsField>
      </Stack>

      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex flex-wrap items-center gap-2">
        <TmsButton variant="primary" size="sm" data-testid="ap-inbox-save" disabled={saving} onClick={save}>
          <Save size={14} /> Save AP inbox settings
        </TmsButton>
        <TmsButton size="sm" data-testid="ap-inbox-sync" disabled={!connected || sync.syncing} onClick={reviewNow}>
          {sync.syncing && sync.progress ? `Reviewed ${sync.progress.reviewed}${sync.progress.remaining > 0 ? ` · ${sync.progress.remaining} left` : ''}…` : 'Review now'}
        </TmsButton>
      </div>
      <Hint>{line.text}{status.gapNote ? ` ${status.gapNote}` : ''}</Hint>
    </Stack>
  )
}
