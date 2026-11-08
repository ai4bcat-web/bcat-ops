/**
 * The rep's own Gmail settings, opened from the Spot inbox. Everything here is about the
 * signed-in rep's connection: pause, what to watch, the reply signature,
 * what is
 * stored and who can see it, and how to disconnect.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsDrawer, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { ErrorText, Hint, Panel, Stack } from '@/features/settings/settingsKit'
import { spotAction } from '@/lib/apiClient'
import { resolveRepSettings, resolveSpotSettings } from '@/lib/spot/settings'
import type { SpotStatusView } from '@/lib/spot/types'

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

  return (
    <TmsDrawer open={open} onOpenChange={onOpenChange} title="Gmail settings" description={gmail} size="md">
      <Stack>
        {error ? <ErrorText>{error}</ErrorText> : null}

        <Panel>
          <p className="tms-flush">
            <strong data-testid="spot-settings-account">{gmail}</strong>{' '}
            <TmsBadge tone={connection.status === 'CONNECTED' ? 'green' : 'orange'}>{connection.status}</TmsBadge>
          </p>
          <Hint>Read-only access to your inbox. We never send or draft mail. Your password is never shared with us.</Hint>
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
        <TmsField label="Reply signature" hint="Added to the end of the suggested response.">
          <TmsTextarea data-testid="spot-signature" rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} />
        </TmsField>
        <div>
          <TmsButton variant="primary" data-testid="spot-settings-save" disabled={busy} onClick={() => void saveSettings()}>
            Save settings
          </TmsButton>
        </div>

        <Panel>
          <p className="tms-flush" data-testid="spot-readonly-copy">
            <strong>Read-only:</strong> BCAT Ops reads quote-request e-mails and never sends or drafts mail. You copy the
            suggested response and send it yourself.
          </p>
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
