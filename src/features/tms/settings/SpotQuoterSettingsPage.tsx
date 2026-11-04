/**
 * My Brokerage → Spot quoter & e-mail (ADMIN). Company-wide policy for the per-rep Gmail
 * spot quoter: whether it runs, how long a stored request lives, whether reps may switch
 * on auto-send at all and the caps behind it. The Reps table shows connection state and
 * poll counters only — numbers and states, never a subject or a body.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsTable, type ColumnDef } from '@/features/tms/kit'
import { CheckRow, ErrorText, Hint, Loading, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { listGmailConnections, spotAction } from '@/lib/apiClient'
import { resolveSpotSettings, validateSpotSettings, type ResolvedSpotSettings } from '@/lib/spot/settings'
import { useSpotStatus } from '@/features/spot-quoter/useSpotRequests'
import { relativeTime } from '@/features/spot-quoter/spotHelpers'
import type { SpotConnectionView } from '@/lib/spot/types'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type NumberKey = Exclude<keyof ResolvedSpotSettings, 'enabled' | 'allowAutoSend'>
const NUMBER_FIELDS: Array<{ key: NumberKey; label: string; hint: string }> = [
  { key: 'retentionDays', label: 'Keep a request for (days)', hint: 'The mail text is deleted automatically after this.' },
  { key: 'dismissedRetentionDays', label: 'Keep a dismissed request for (days)', hint: 'Long enough that the same thread is not found again.' },
  { key: 'autoSendDailyCapPerRep', label: 'Auto-send limit per rep per day', hint: 'Only matters when a rep has auto-send on.' },
  { key: 'autoSendDailyCapPerCustomer', label: 'Auto-send limit per customer per day', hint: 'Per rep and customer.' },
  { key: 'autoSendMinSamples', label: 'Loads of history needed to auto-send', hint: 'Used when there is no live DAT price.' },
  { key: 'modelCallsPerRepPerDay', label: 'AI reads per rep per day', hint: 'The spend control: each candidate mail is one read.' },
  { key: 'maxMessagesPerRepPerRun', label: 'Mails checked per rep per run', hint: 'Caps one poll of one inbox.' },
]

const pollText = (c: SpotConnectionView): string => {
  const s = c.lastPollStats
  return s ? `${s.listed}/${s.stage1Rejected + s.stage2Rejected}/${s.modelCalls}/${s.stored}` : '—'
}

export function SpotQuoterSettingsPage() {
  const { status, loading, error, refresh } = useSpotStatus()
  const [enabled, setEnabled] = useState(true)
  const [allowAuto, setAllowAuto] = useState(false)
  const [numbers, setNumbers] = useState<Record<NumberKey, string> | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reps, setReps] = useState<SpotConnectionView[] | null>(null)
  const [repsError, setRepsError] = useState<string | null>(null)
  const [disconnectAll, setDisconnectAll] = useState(false)
  const [seeded, setSeeded] = useState<unknown>(null)

  // Seed the form once per loaded settings row (not on every poll of the status).
  if (status && seeded !== status.settings) {
    const s = resolveSpotSettings(status.settings)
    setSeeded(status.settings)
    setEnabled(s.enabled)
    setAllowAuto(s.allowAutoSend)
    setNumbers(Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, String(s[f.key])])) as Record<NumberKey, string>)
  }

  const loadReps = useCallback(() => {
    let live = true
    listGmailConnections()
      .then((rows) => { if (live) { setReps(rows); setRepsError(null) } })
      .catch((err: unknown) => { if (live) setRepsError(messageOf(err)) })
    return () => { live = false }
  }, [])
  useEffect(() => loadReps(), [loadReps])

  const save = async () => {
    if (!numbers) return
    const patch = {
      enabled,
      allowAutoSend: allowAuto,
      ...Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, Number(numbers[f.key])])),
    }
    const checked = validateSpotSettings(patch)
    if (!checked.ok) {
      setSaveError(checked.error)
      return
    }
    setBusy(true)
    setSaveError(null)
    try {
      await spotAction('SPOT_SAVE_SETTINGS', {
        settings: checked.value,
        expectedVersion: status?.settings.version ?? undefined,
      })
      toast.success('Spot quoter settings saved')
      refresh()
    } catch (err) {
      setSaveError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (userId: string, purge = false) => {
    try {
      await spotAction('SPOT_ADMIN_DISCONNECT', { userId, purge })
      toast.success('Disconnected')
    } catch (err) {
      toast.error(messageOf(err))
    } finally {
      loadReps()
    }
  }

  const columns: Array<ColumnDef<SpotConnectionView>> = [
    { key: 'rep', header: 'Rep', render: (c) => c.userEmail },
    { key: 'status', header: 'Status', render: (c) => <TmsBadge tone={c.status === 'CONNECTED' ? 'green' : 'gray'}>{c.status}</TmsBadge> },
    { key: 'mode', header: 'Mode', render: (c) => (c.mode === 'SIMULATED' ? <TmsBadge tone="orange">SIMULATED</TmsBadge> : 'Gmail') },
    {
      key: 'poll',
      header: 'Last poll',
      render: (c) => (c.lastPollAt ? `${c.lastPollOk === false ? 'failed · ' : 'ok · '}${relativeTime(c.lastPollAt)}` : 'never'),
    },
    { key: 'counts', header: 'listed / rejected / model / stored', render: (c) => <span className="tms-spot-numbers">{pollText(c)}</span> },
    { key: 'auto', header: 'Auto-send', render: (c) => (c.settings?.autoSend ? 'ON' : 'off') },
    {
      key: 'act',
      header: '',
      render: (c) => (
        <TmsButton
          size="sm"
          data-testid={`spot-admin-disconnect-${c.id}`}
          disabled={c.status === 'DISCONNECTED'}
          onClick={() => void disconnect(c.id)}
        >
          Disconnect
        </TmsButton>
      ),
    },
  ]

  if (loading || !status || !numbers) {
    return error ? <ErrorText>{error}</ErrorText> : <Loading />
  }

  const connected = (reps ?? []).filter((c) => c.status !== 'DISCONNECTED')

  return (
    <div className="tms-spot-grid-cards" data-testid="spot-settings-page">
      <SettingsCard icon={Mail} title="Status" description="Where the spot quoter gets its mail and its market price.">
        <Stack>
          <p className="tms-flush">
            Gmail sign-in:{' '}
            <TmsBadge tone={status.gmailProvider.mode === 'LIVE' ? 'green' : 'gray'} data-testid="spot-gmail-mode">
              {status.gmailProvider.mode}
            </TmsBadge>{' '}
            <Link to="/tms/brokerage/integrations">Open Integrations</Link>
          </p>
          <p className="tms-flush">
            DAT RateView:{' '}
            <TmsBadge tone={status.datProvider.mode === 'LIVE' ? 'green' : 'gray'} data-testid="spot-dat-mode">
              {status.datProvider.mode}
            </TmsBadge>{' '}
            <Link to="/tms/brokerage/integrations">Open Integrations</Link>
          </p>
          <Hint>One service DAT login serves every rep. Until it is set up, prices carry a STUB label and are never auto-sent.</Hint>
          {status.devStack ? <Hint>This is the dev stack: sending from Gmail is disabled and a simulated inbox is available.</Hint> : null}
        </Stack>
      </SettingsCard>

      <SettingsCard
        icon={SlidersHorizontal}
        title="Policy"
        actions={<TmsButton variant="primary" data-testid="spot-policy-save" disabled={busy} onClick={() => void save()}>Save</TmsButton>}
      >
        <Stack>
          {saveError ? <ErrorText>{saveError}</ErrorText> : null}
          <CheckRow label="The spot quoter is on" checked={enabled} onChange={setEnabled} ariaLabel="Spot quoter enabled" />
          <CheckRow
            label="Let reps turn on auto-send (each rep and each customer must also opt in)"
            checked={allowAuto}
            onChange={setAllowAuto}
            ariaLabel="Allow auto-send"
          />
          {NUMBER_FIELDS.map((f) => (
            <TmsField key={f.key} label={f.label} hint={f.hint}>
              <TmsInput
                data-testid={`spot-policy-${f.key}`}
                inputMode="numeric"
                value={numbers[f.key]}
                onChange={(e) => setNumbers({ ...numbers, [f.key]: e.target.value })}
              />
            </TmsField>
          ))}
        </Stack>
      </SettingsCard>

      <SettingsCard icon={ShieldCheck} title="Who can see what">
        <Stack>
          <Hint>
            Only e-mails recognised as quote requests, and the replies in their threads, are stored. Every other message is
            looked at only as far as needed to rule it out, and nothing of it is kept.
          </Hint>
          <Hint>
            A rep sees their own requests. Managers, admins and the owner see everyone’s. Reps see the customers they own,
            plus customers nobody owns yet; managers see all. Quote replies are drafts in the rep’s own Gmail.
          </Hint>
        </Stack>
      </SettingsCard>

      <SettingsCard
        icon={Users}
        title="Reps"
        description="Connection state and counters only. No mail content is shown here."
        actions={
          <TmsButton variant="destructive" data-testid="spot-disconnect-all" disabled={connected.length === 0} onClick={() => setDisconnectAll(true)}>
            Disconnect all
          </TmsButton>
        }
      >
        {repsError ? <ErrorText>{repsError}</ErrorText> : null}
        <TmsTable columns={columns} rows={reps ?? []} rowKey={(c) => c.id} empty={<Hint>No rep has connected a mailbox yet.</Hint>} />
      </SettingsCard>

      <TmsDialog
        open={disconnectAll}
        onOpenChange={setDisconnectAll}
        title="Disconnect every rep?"
        description="Watching stops for everyone and each stored access is revoked. Stored requests are kept until they expire."
        footer={
          <>
            <TmsButton onClick={() => setDisconnectAll(false)}>Cancel</TmsButton>
            <TmsButton
              variant="destructive"
              data-testid="spot-disconnect-all-confirm"
              onClick={async () => {
                await Promise.all(connected.map((c) => disconnect(c.id)))
                setDisconnectAll(false)
              }}
            >
              Disconnect all
            </TmsButton>
          </>
        }
      />
    </div>
  )
}

export default SpotQuoterSettingsPage
