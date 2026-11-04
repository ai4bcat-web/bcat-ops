/**
 * The rep's own Gmail settings, opened from the Spot inbox. Everything here is about the
 * signed-in rep's connection: pause, what to watch, the reply signature, the auto-send
 * switch (OFF by default, with every gate spelled out before it can be turned on), what is
 * stored and who can see it, and how to disconnect.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsDrawer, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { ErrorText, Hint, Panel, Stack } from '@/features/settings/settingsKit'
import { spotAction } from '@/lib/apiClient'
import { resolveRepSettings, resolveSpotSettings } from '@/lib/spot/settings'
import type { SpotStatusView } from '@/lib/spot/types'
import { AUTO_SEND_GATES, firstNameOf } from './spotRules'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function RepSettingsDrawer({
  open,
  onOpenChange,
  status,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: SpotStatusView
  onChanged: () => void
}) {
  const connection = status.connection
  const org = resolveSpotSettings(status.settings)
  const rep = resolveRepSettings(connection?.settings)

  const [label, setLabel] = useState(rep.watchLabel ?? '')
  const [lookback, setLookback] = useState(String(rep.lookbackDays))
  const [signature, setSignature] = useState(rep.signature)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoDialog, setAutoDialog] = useState(false)
  const [typed, setTyped] = useState('')
  const [disconnectDialog, setDisconnectDialog] = useState(false)
  const [purgeDialog, setPurgeDialog] = useState(false)

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      toast.success(done)
      onChanged()
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!connection) {
    return (
      <TmsDrawer open={open} onOpenChange={onOpenChange} title="Gmail settings" size="md">
        <TmsAlert tone="blue">Connect Gmail first; the settings belong to your connection.</TmsAlert>
      </TmsDrawer>
    )
  }

  const paused = connection.status === 'PAUSED'
  const autoReason = !org.enabled
    ? 'The spot quoter is switched off by an admin.'
    : !org.allowAutoSend
      ? 'An admin has not allowed auto-send for the company, so this switch cannot be turned on.'
      : null
  const firstName = firstNameOf(connection.userEmail)
  const gmail = connection.mode === 'SIMULATED' ? 'Simulated inbox (dev only)' : (connection.googleEmail ?? connection.userEmail)

  const saveSettings = () => {
    const days = Number(lookback)
    return run(
      () =>
        spotAction('SPOT_SAVE_MY_SETTINGS', {
          settings: { watchLabel: label.trim() || null, lookbackDays: days, signature },
          expectedVersion: connection.version,
        }),
      'Settings saved',
    )
  }

  const turnAutoSend = (on: boolean) =>
    run(
      () => spotAction('SPOT_SAVE_MY_SETTINGS', { settings: { autoSend: on }, expectedVersion: connection.version }),
      on ? 'Auto-send is ON' : 'Auto-send is OFF',
    )

  return (
    <TmsDrawer open={open} onOpenChange={onOpenChange} title="Gmail settings" description={gmail} size="md">
      <Stack>
        {error ? <ErrorText>{error}</ErrorText> : null}

        <Panel>
          <p className="tms-flush">
            <strong data-testid="spot-settings-account">{gmail}</strong>{' '}
            <TmsBadge tone={connection.status === 'CONNECTED' ? 'green' : 'orange'}>{connection.status}</TmsBadge>
          </p>
          <Hint>Read your inbox · Create drafts and send mail on your behalf. Your password is never shared with us.</Hint>
          {connection.connectedAt ? <Hint>Connected {connection.connectedAt.slice(0, 10)}</Hint> : null}
        </Panel>

        <div className="tms-spot-switch">
          <TmsButton
            data-testid="spot-pause"
            disabled={busy || connection.status === 'NEEDS_RECONNECT' || connection.status === 'DISCONNECTED'}
            onClick={() => void run(() => spotAction('SPOT_SET_PAUSED', { paused: !paused }), paused ? 'Watching resumed' : 'Watching paused')}
          >
            {paused ? 'Resume watching' : 'Pause watching'}
          </TmsButton>
          <Hint>{paused ? 'Your inbox is not being read right now.' : 'New mail is checked every few minutes.'}</Hint>
        </div>

        <TmsField label="Watch only this label" hint="Optional. Leave empty to look at your whole inbox.">
          <TmsInput data-testid="spot-label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </TmsField>
        <TmsField label="Look back (days)" hint="How far back the first check reads.">
          <TmsInput data-testid="spot-lookback" inputMode="numeric" value={lookback} onChange={(e) => setLookback(e.target.value)} />
        </TmsField>
        <TmsField label="Reply signature" hint="Appended once to the draft. Gmail does not add its own.">
          <TmsTextarea data-testid="spot-signature" rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} />
        </TmsField>
        <div>
          <TmsButton variant="primary" data-testid="spot-settings-save" disabled={busy} onClick={() => void saveSettings()}>
            Save settings
          </TmsButton>
        </div>

        <Panel>
          <label className="tms-spot-switch">
            <input
              type="checkbox"
              role="switch"
              data-testid="spot-autosend-toggle"
              aria-label="Auto-send"
              checked={rep.autoSend}
              disabled={busy || (autoReason != null && !rep.autoSend)}
              onChange={(e) => {
                if (e.target.checked) {
                  setTyped('')
                  setAutoDialog(true)
                } else void turnAutoSend(false)
              }}
            />
            <strong>Auto-send</strong>
            <TmsBadge tone={rep.autoSend ? 'orange' : 'gray'}>{rep.autoSend ? 'ON' : 'OFF'}</TmsBadge>
          </label>
          <Hint>
            Off by default. When it is off, replies are only ever Gmail drafts and you press Send yourself.
          </Hint>
          {autoReason ? <p className="tms-field-hint tms-flush" data-testid="spot-autosend-reason">{autoReason}</p> : null}
        </Panel>

        <Panel>
          <p className="tms-spot-section-title">What is stored and who can see it</p>
          <p className="tms-flush" data-testid="spot-storage-note">
            Only e-mails recognised as quote requests, and the replies in their threads, are kept — for {org.retentionDays} days
            ({org.dismissedRetentionDays} days once dismissed). Nothing else from your mailbox is retained. They are visible
            to you, to managers and to admins.
          </p>
        </Panel>

        <div className="tms-spot-actions">
          <TmsButton data-testid="spot-purge" disabled={busy} onClick={() => setPurgeDialog(true)}>
            Delete my stored requests
          </TmsButton>
          <TmsButton variant="destructive" data-testid="spot-disconnect" disabled={busy} onClick={() => setDisconnectDialog(true)}>
            Disconnect
          </TmsButton>
        </div>
      </Stack>

      <TmsDialog
        open={autoDialog}
        onOpenChange={setAutoDialog}
        title="Turn on auto-send?"
        description="Replies will be sent from your Gmail without you pressing Send, but only when all of this is true:"
        footer={
          <>
            <TmsButton onClick={() => setAutoDialog(false)}>Cancel</TmsButton>
            <TmsButton
              variant="primary"
              data-testid="spot-autosend-confirm"
              disabled={busy || typed.trim().toLowerCase() !== firstName.toLowerCase() || firstName === ''}
              onClick={async () => {
                if (await turnAutoSend(true)) setAutoDialog(false)
              }}
            >
              Turn on auto-send
            </TmsButton>
          </>
        }
      >
        <ul className="tms-spot-gates">
          {AUTO_SEND_GATES.map((gate) => <li key={gate}>{gate}</li>)}
        </ul>
        <TmsField label={`Type your first name (“${firstName}”) to confirm`}>
          <TmsInput data-testid="spot-autosend-name" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </TmsField>
      </TmsDialog>

      <TmsDialog
        open={purgeDialog}
        onOpenChange={setPurgeDialog}
        title="Delete your stored requests?"
        description="This removes every spot request stored for you. Quotes already created are kept."
        footer={
          <>
            <TmsButton onClick={() => setPurgeDialog(false)}>Cancel</TmsButton>
            <TmsButton
              variant="destructive"
              data-testid="spot-purge-confirm"
              disabled={busy}
              onClick={async () => {
                if (await run(() => spotAction('SPOT_PURGE_MINE', {}), 'Stored requests deleted')) setPurgeDialog(false)
              }}
            >
              Delete
            </TmsButton>
          </>
        }
      />

      <TmsDialog
        open={disconnectDialog}
        onOpenChange={setDisconnectDialog}
        title="Disconnect Gmail?"
        description="Watching stops and our copy of your access is revoked. Choose what happens to the requests already stored."
        footer={
          <>
            <TmsButton onClick={() => setDisconnectDialog(false)}>Cancel</TmsButton>
            <TmsButton
              data-testid="spot-disconnect-keep"
              disabled={busy}
              onClick={async () => {
                if (await run(() => spotAction('SPOT_DISCONNECT', { purge: false }), 'Gmail disconnected')) setDisconnectDialog(false)
              }}
            >
              Disconnect, keep requests
            </TmsButton>
            <TmsButton
              variant="destructive"
              data-testid="spot-disconnect-purge"
              disabled={busy}
              onClick={async () => {
                if (await run(() => spotAction('SPOT_DISCONNECT', { purge: true }), 'Gmail disconnected and requests deleted')) setDisconnectDialog(false)
              }}
            >
              Disconnect and delete everything
            </TmsButton>
          </>
        }
      />
    </TmsDrawer>
  )
}
