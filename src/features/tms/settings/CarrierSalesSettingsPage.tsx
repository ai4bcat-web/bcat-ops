/**
 * Settings › Carrier Sales (ADMIN). The listening mailbox(es) for carrier offers (Gmail, read-only), the
 * Cowtown voice-agent webhook secret, the matching rules and — on the dev stack only — a simulated inbox.
 * Numbers and states only: no mail content is shown here.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox, Mic, ShieldCheck, SlidersHorizontal, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsField, TmsInput, TmsSelect, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { CheckRow, ErrorText, Hint, Loading, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { SPOT_CALLBACK_PATH } from '@/features/spot-quoter/useSpotRequests'
import { relativeTime } from '@/features/spot-quoter/spotHelpers'
import {
  CARRIER_INBOX_CALL_FIXTURES, CARRIER_INBOX_MAIL_FIXTURES,
} from '@/lib/carrierInbox/fixtures'
import type { CarrierInboxMailbox, CarrierInboxMailboxStatus, CarrierInboxRunStats } from '@/lib/carrierInbox/types'
import {
  csConnectSimulated, csDisconnect, csOauthStart, csPollNow, csRotateVoiceSecret, csSaveSettings, csSetPaused,
  csSimInjectCall, csSimInjectMail, csSimReset,
} from '@/features/tms/carrierSales/csClient'
import type { CarrierInboxConfigView } from '@/features/tms/carrierSales/csClient'
import { useCarrierInboxStatus } from '@/features/tms/carrierSales/useCarrierInboxStatus'

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const MAX_POLL_SLICES = 15

const STATUS_TONE: Record<CarrierInboxMailboxStatus, 'green' | 'orange' | 'red' | 'gray' | 'blue'> = {
  CONNECTED: 'green', SIMULATED: 'orange', PENDING: 'blue', NEEDS_RECONNECT: 'red', PAUSED: 'gray', NOT_CONNECTED: 'gray',
}

interface DraftMailbox extends Omit<CarrierInboxMailbox, 'addresses'> { addressesText: string }

const csv = (v: string): string[] => v.split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean)

function digest(s: CarrierInboxRunStats | null | undefined): string {
  if (!s) return '—'
  return `listed ${s.listed} · dropped ${s.stage1Rejected + s.stage2Rejected + s.notOffer} · filed ${s.filed + s.threadOnly + s.coveredLate} · unmatched ${s.suggested + s.unmatched} · errors ${s.errors}`
}

const NUMBER_FIELDS: Array<{ key: 'autoFileMinScore' | 'suggestMinScore' | 'unmatchedRetentionDays' | 'modelCallsPerDay'; label: string; hint: string }> = [
  { key: 'autoFileMinScore', label: 'Auto-file at match score', hint: '0.80–0.99. Only an exact load or posting reference can reach it; lane + date alone never files by itself.' },
  { key: 'suggestMinScore', label: 'Suggest a load from score', hint: 'Below the auto-file score: the offer waits in Unmatched with a suggested load.' },
  { key: 'unmatchedRetentionDays', label: 'Keep unmatched offers (days)', hint: '7–90. Dismissing deletes at once.' },
  { key: 'modelCallsPerDay', label: 'AI reads per day', hint: 'The spend control: each candidate message or call is one read. 0 stops classification.' },
]

export function CarrierSalesSettingsPage() {
  const { data: status, loading, error, refresh } = useCarrierInboxStatus()
  const [seeded, setSeeded] = useState<CarrierInboxConfigView | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [mailboxes, setMailboxes] = useState<DraftMailbox[]>([])
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [boardDomains, setBoardDomains] = useState('')
  const [ignore, setIgnore] = useState('')
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [add, setAdd] = useState({ label: '', account: '', addresses: '', gmailLabel: '' })
  const [simBox, setSimBox] = useState('')
  const [mailFixture, setMailFixture] = useState(CARRIER_INBOX_MAIL_FIXTURES[0]?.id ?? '')
  const [callFixture, setCallFixture] = useState(CARRIER_INBOX_CALL_FIXTURES[0]?.id ?? '')

  // Seed the form once per loaded settings version (not on every 60 s poll of the status).
  if (status && (seeded === null || seeded.version !== status.config.version)) {
    const c = status.config
    setSeeded(c)
    setEnabled(c.enabled)
    setMailboxes(c.mailboxes.map((m) => ({ ...m, addressesText: m.addresses.join(', ') })))
    setNumbers({
      autoFileMinScore: String(c.autoFileMinScore), suggestMinScore: String(c.suggestMinScore),
      unmatchedRetentionDays: String(c.unmatchedRetentionDays), modelCallsPerDay: String(c.modelCallsPerDay),
    })
    setBoardDomains(c.boardSenderDomains.join(', '))
    setIgnore(c.ignoreSenders.join(', '))
    setVoiceEnabled(c.voice.enabled)
    setSimBox(c.mailboxes[0]?.id ?? '')
  }

  if (loading && !status) return <Loading />
  if (!status) return <ErrorText>{error ?? 'Carrier Sales settings did not load.'}</ErrorText>

  const saved = new Set(status.config.mailboxes.map((m) => m.id))
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key)
    try { await fn(); if (ok) toast.success(ok); await refresh() } catch (e) { toast.error(messageOf(e)) } finally { setBusy(null) }
  }

  const save = async () => {
    setBusy('save')
    setSaveError(null)
    try {
      await csSaveSettings({
        ...status.config,
        enabled,
        mailboxes: mailboxes.map(({ addressesText, ...m }) => ({ ...m, addresses: csv(addressesText) })),
        autoFileMinScore: Number(numbers.autoFileMinScore),
        suggestMinScore: Number(numbers.suggestMinScore),
        unmatchedRetentionDays: Number(numbers.unmatchedRetentionDays),
        modelCallsPerDay: Number(numbers.modelCallsPerDay),
        boardSenderDomains: csv(boardDomains),
        ignoreSenders: csv(ignore),
        voice: { enabled: voiceEnabled, maxTranscriptChars: status.config.voice.maxTranscriptChars, secretHash: null, rotatedAt: null },
      }, status.config.version)
      toast.success('Carrier Sales settings saved')
      await refresh()
    } catch (e) { setSaveError(messageOf(e)) } finally { setBusy(null) }
  }

  const addMailbox = () => {
    const account = add.account.trim().toLowerCase()
    if (!account || !add.addresses.trim()) { setSaveError('A mailbox needs the Google account to connect and at least one distribution address.'); return }
    let n = mailboxes.length + 1
    while (mailboxes.some((m) => m.id === `m${n}`)) n += 1
    setMailboxes([...mailboxes, {
      id: `m${n}`, label: add.label.trim() || account, account, addressesText: add.addresses,
      gmailLabel: add.gmailLabel.trim() || null, mode: 'GOOGLE', paused: false,
    }])
    setAdd({ label: '', account: '', addresses: '', gmailLabel: '' })
    setSaveError(null)
  }

  const connect = (id: string) => run(`connect-${id}`, async () => {
    const { url } = await csOauthStart(id, `${window.location.origin}${SPOT_CALLBACK_PATH}`)
    window.location.assign(url)
  })

  const pollNow = (id: string) => run(`poll-${id}`, async () => {
    for (let i = 0; i < MAX_POLL_SLICES; i += 1) {
      const r = await csPollNow(id)
      if (r.done) return
    }
  }, 'Mailbox reviewed')

  const columns: Array<ColumnDef<DraftMailbox>> = [
    {
      key: 'mailbox', header: 'Mailbox', width: 260,
      render: (m) => (
        <span data-testid={`cs-settings-mailbox-${m.id}`} style={{ display: 'grid', gap: 4 }}>
          <TmsInput aria-label={`Label for ${m.id}`} value={m.label} onChange={(e) => setMailboxes(mailboxes.map((x) => (x.id === m.id ? { ...x, label: e.target.value } : x)))} />
          <span className="tms-muted" style={{ fontSize: 12 }}>{m.account}</span>
          <TmsInput aria-label={`Distribution addresses for ${m.id}`} value={m.addressesText} placeholder="loads@…, bids@…" onChange={(e) => setMailboxes(mailboxes.map((x) => (x.id === m.id ? { ...x, addressesText: e.target.value } : x)))} />
        </span>
      ),
    },
    {
      key: 'status', header: 'Status', width: 150,
      render: (m) => {
        const st = status.state.mailboxes[m.id]
        const label: CarrierInboxMailboxStatus = !saved.has(m.id) ? 'NOT_CONNECTED' : st?.status ?? (m.mode === 'SIMULATED' ? 'SIMULATED' : 'NOT_CONNECTED')
        return (
          <span style={{ display: 'grid', gap: 2 }}>
            <TmsBadge tone={STATUS_TONE[label]}>{label.replace('_', ' ')}</TmsBadge>
            {st?.googleEmail ? <span className="tms-muted" style={{ fontSize: 12 }}>{st.googleEmail}</span> : null}
            {!saved.has(m.id) ? <span className="tms-muted" style={{ fontSize: 12 }}>Unsaved</span> : null}
          </span>
        )
      },
    },
    {
      key: 'poll', header: 'Last check', width: 280,
      render: (m) => {
        const st = status.state.mailboxes[m.id]
        return (
          <span style={{ display: 'grid', gap: 2, fontSize: 12 }}>
            <span>{st?.lastPollAt ? `${st.lastPollOk === false ? 'failed · ' : 'ok · '}${relativeTime(st.lastPollAt)}` : 'never'}</span>
            <span className="tms-muted">{digest(st?.lastStats)}</span>
            {st?.lastError ? <span className="tms-field-error">{st.lastError}</span> : null}
          </span>
        )
      },
    },
    {
      key: 'act', header: '', width: 380,
      render: (m) => {
        const st = status.state.mailboxes[m.id]
        const isSaved = saved.has(m.id)
        const live = st?.status === 'CONNECTED' || st?.status === 'SIMULATED' || st?.status === 'PAUSED'
        return (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {m.mode === 'GOOGLE' ? (
              <TmsButton size="sm" variant="primary" data-testid={`cs-settings-connect-${m.id}`} disabled={!isSaved || busy !== null} title={isSaved ? undefined : 'Save settings first'}
                onClick={() => { void connect(m.id) }}>
                {live ? 'Reconnect' : 'Connect'}
              </TmsButton>
            ) : null}
            <TmsButton size="sm" data-testid={`cs-settings-poll-now-${m.id}`} disabled={!isSaved || !live || busy !== null} onClick={() => { void pollNow(m.id) }}>Review now</TmsButton>
            <TmsButton size="sm" disabled={!isSaved || !live || busy !== null} onClick={() => { void run(`pause-${m.id}`, () => csSetPaused(m.id, !m.paused)) }}>{m.paused ? 'Resume' : 'Pause'}</TmsButton>
            <TmsButton size="sm" disabled={!isSaved || !live || busy !== null} onClick={() => { void run(`disc-${m.id}`, () => csDisconnect(m.id), 'Disconnected') }}>Disconnect</TmsButton>
            <TmsButton size="sm" variant="destructive" disabled={busy !== null} onClick={() => setMailboxes(mailboxes.filter((x) => x.id !== m.id))}>Remove</TmsButton>
          </span>
        )
      },
    },
  ]

  const voice = status.state.voice
  const voiceUrl = voice.url ? `${voice.url.replace(/\/+$/, '')}/carrier-call` : null

  return (
    <div className="tms-spot-grid-cards" data-testid="cs-settings-page">
      <SettingsCard icon={Inbox} title="Status" description="Where carrier offers come from.">
        <Stack>
          <p className="tms-flush">
            Google sign-in:{' '}
            <TmsBadge tone={status.gmailProvider.mode === 'LIVE' ? 'green' : 'gray'} data-testid="cs-settings-google-mode">{status.gmailProvider.mode}</TmsBadge>{' '}
            <Link to="/tms/brokerage/integrations">Open Integrations</Link>
          </p>
          {status.devStack ? <TmsBadge tone="orange" data-testid="cs-settings-simulated-badge">SIMULATED INBOX</TmsBadge> : null}
          <CheckRow label="Listen for carrier offers" checked={enabled} onChange={setEnabled} ariaLabel="Carrier inbox enabled" />
          <Hint>
            Read-only: BCAT Ops reads the carrier-sales mailbox and never sends, drafts or changes mail. Counter-offers go out by e-mail
            through the app, from the shipment, not from this mailbox.
          </Hint>
        </Stack>
      </SettingsCard>

      <SettingsCard
        icon={Inbox}
        title="Listening mailboxes"
        description="The Gmail account that receives the carrier-sales address (for example loads@…). Up to 5."
        actions={<TmsButton variant="primary" data-testid="cs-settings-save" disabled={busy !== null} onClick={() => { void save() }}>Save</TmsButton>}
      >
        <Stack>
          {saveError ? <ErrorText>{saveError}</ErrorText> : null}
          <div data-testid="cs-settings-mailboxes">
            <TmsTable columns={columns} rows={mailboxes} rowKey={(m) => m.id} empty={<Hint>No mailbox yet. Add one below, save, then connect it.</Hint>} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, alignItems: 'end' }}>
            <TmsField label="Label"><TmsInput data-testid="cs-settings-add-label" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} /></TmsField>
            <TmsField label="Google account to connect"><TmsInput data-testid="cs-settings-add-account" value={add.account} onChange={(e) => setAdd({ ...add, account: e.target.value })} /></TmsField>
            <TmsField label="Distribution address(es)"><TmsInput data-testid="cs-settings-add-addresses" value={add.addresses} onChange={(e) => setAdd({ ...add, addresses: e.target.value })} /></TmsField>
            <TmsField label="Gmail label (optional)" hint="Use when forwarding hides the address."><TmsInput value={add.gmailLabel} onChange={(e) => setAdd({ ...add, gmailLabel: e.target.value })} /></TmsField>
            <TmsButton data-testid="cs-settings-add-mailbox" disabled={mailboxes.length >= 5} onClick={addMailbox}>Add mailbox</TmsButton>
          </div>
        </Stack>
      </SettingsCard>

      <SettingsCard icon={Mic} title="Voice agent (Cowtown)" description="The agent POSTs each finished call here; the call becomes a phone offer.">
        <Stack>
          <CheckRow label="Accept calls from the voice agent" checked={voiceEnabled} onChange={setVoiceEnabled} ariaLabel="Voice agent enabled" />
          <p className="tms-flush" style={{ fontSize: 13 }}>
            Webhook URL:{' '}
            {voiceUrl ? <code data-testid="cs-settings-voice-url">{voiceUrl}</code> : <span className="tms-muted">shown after the first call — see the Amplify output <code>CarrierCallFunctionUrl</code></span>}
          </p>
          <p className="tms-flush" style={{ fontSize: 13 }}>
            Secret: {status.config.voice.hasSecret ? <TmsBadge tone="green">Set</TmsBadge> : <TmsBadge tone="orange">Not set</TmsBadge>}{' '}
            <TmsButton size="sm" data-testid="cs-settings-voice-rotate" disabled={busy !== null}
              onClick={() => { void run('rotate', async () => { setSecret((await csRotateVoiceSecret()).secret) }) }}>
              {status.config.voice.hasSecret ? 'Rotate secret' : 'Create secret'}
            </TmsButton>
          </p>
          {secret ? (
            <div data-testid="cs-settings-voice-secret" style={{ display: 'grid', gap: 6 }}>
              <code style={{ wordBreak: 'break-all' }}>{secret}</code>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <TmsButton size="sm" onClick={() => { void navigator.clipboard.writeText(secret).then(() => toast.success('Secret copied')) }}>Copy</TmsButton>
                <TmsButton size="sm" onClick={() => setSecret(null)}>Done</TmsButton>
                <Hint>Shown once. Give it to whoever runs the voice agent; it is not stored in readable form.</Hint>
              </span>
            </div>
          ) : null}
          <Hint>Last call: {voice.lastCallAt ? relativeTime(voice.lastCallAt) : 'never'} · {voice.calls24h} in the last 24 h{voice.lastError ? ` · ${voice.lastError}` : ''}</Hint>
          <details>
            <summary className="tms-muted" style={{ cursor: 'pointer', fontSize: 12 }}>What the agent must send</summary>
            <pre style={{ fontSize: 12, overflow: 'auto' }}>{`POST <webhook URL>   content-type: application/json
{ "secret": "<shown once>", "callSid": "CA…", "callerNumber": "+1312…",
  "startedAt": "ISO", "endedAt": "ISO", "durationSec": 189,
  "outcome": "TRANSFERRED | CALLBACK | VOICEMAIL | ABANDONED | …",
  "transcript": "…", "summary": "optional", "recordingUrl": "https://…",
  "structured": { "loadId": "", "mc": "", "carrierName": "", "rate": 1850 } }
200 ok · 401 bad secret · 503 retry with the same callSid`}</pre>
          </details>
        </Stack>
      </SettingsCard>

      <SettingsCard icon={SlidersHorizontal} title="Rules">
        <Stack>
          {NUMBER_FIELDS.map((f) => (
            <TmsField key={f.key} label={f.label} hint={f.hint}>
              <TmsInput data-testid={`cs-settings-${f.key}`} inputMode="decimal" value={numbers[f.key] ?? ''} onChange={(e) => setNumbers({ ...numbers, [f.key]: e.target.value })} />
            </TmsField>
          ))}
          <TmsField label="Load-board sender domains" hint="Mail from these is read as a board relay: the carrier is named in the body.">
            <TmsInput value={boardDomains} onChange={(e) => setBoardDomains(e.target.value)} />
          </TmsField>
          <TmsField label="Ignore senders" hint="Addresses or domains, comma separated.">
            <TmsInput value={ignore} onChange={(e) => setIgnore(e.target.value)} />
          </TmsField>
          <Hint>The server enforces the limits above, whatever is typed here. Remember to press Save in Listening mailboxes.</Hint>
        </Stack>
      </SettingsCard>

      <SettingsCard icon={ShieldCheck} title="What is stored">
        <Stack>
          <Hint>Only mail classified as an offer, an inquiry or a withdrawal is kept. Everything else is counted and dropped.</Hint>
          <Hint>Offers that match a load become part of that load’s record. Unmatched ones are deleted after the retention period, or when dismissed.</Hint>
          <Hint>Attachments are never stored. The mailbox is read-only and the app never sends mail from it.</Hint>
        </Stack>
      </SettingsCard>

      {status.devStack ? (
        <SettingsCard icon={Wrench} title="Dev panel" description="Dev stack only: a simulated inbox, no Google.">
          <Stack>
          <div data-testid="cs-settings-dev-panel" style={{ display: 'grid', gap: 8 }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <TmsSelect aria-label="Mailbox" value={simBox} onChange={(e) => setSimBox(e.target.value)}>
                {status.config.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </TmsSelect>
              <TmsButton size="sm" data-testid="cs-settings-sim-connect" disabled={!simBox || busy !== null}
                onClick={() => { void run('sim-connect', () => csConnectSimulated(simBox), 'Simulated mailbox connected') }}>Connect simulated mailbox</TmsButton>
            </span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <TmsSelect aria-label="Sample mail" value={mailFixture} onChange={(e) => setMailFixture(e.target.value)}>
                {CARRIER_INBOX_MAIL_FIXTURES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </TmsSelect>
              <TmsButton size="sm" data-testid="cs-settings-sim-mail" disabled={!simBox || busy !== null}
                onClick={() => { void run('sim-mail', () => csSimInjectMail(simBox, mailFixture), 'Sample mail loaded') }}>Load sample mail</TmsButton>
            </span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <TmsSelect aria-label="Sample call" value={callFixture} onChange={(e) => setCallFixture(e.target.value)}>
                {CARRIER_INBOX_CALL_FIXTURES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </TmsSelect>
              <TmsButton size="sm" data-testid="cs-settings-sim-call" disabled={busy !== null}
                onClick={() => { void run('sim-call', () => csSimInjectCall(callFixture), 'Call simulated') }}>Simulate inbound call</TmsButton>
            </span>
            <TmsButton size="sm" variant="destructive" data-testid="cs-settings-sim-reset" disabled={busy !== null}
              onClick={() => { void run('sim-reset', () => csSimReset(simBox || undefined), 'Simulated inbox reset') }}>Reset</TmsButton>
          </div>
          </Stack>
        </SettingsCard>
      ) : null}
    </div>
  )
}

export default CarrierSalesSettingsPage
