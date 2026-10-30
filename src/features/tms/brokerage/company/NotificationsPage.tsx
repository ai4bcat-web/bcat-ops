/**
 * My Brokerage → Company → Notifications.
 *
 * Event subscriptions, webhook endpoints with secret rotation, and the global
 * pause switch.
 */
import { useEffect, useMemo, useState } from 'react'
import { Bell, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsCard, TmsField, TmsInput, TmsSelect, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { getTmsSettings, rotateWebhookSecret, saveTmsSettings } from '@/lib/apiClient'
import type { NotificationChannel, NotificationAudienceKind, NotificationWebhook, TmsSettings } from '@/types/tms'
import { EVENT_CATALOG } from '@/lib/brokerage/notifications'
import { ROLES, ROLE_LABELS } from '@/lib/roles'
import { CheckRow, ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { useAuthUser } from '@/hooks/useAuth'

const AUDIENCE_KINDS: NotificationAudienceKind[] = ['ROLE', 'TEAM', 'USER']
const CHANNELS = ['EMAIL', 'IN_APP', 'WEBHOOK'] as const

const KIND_LABELS: Record<NotificationAudienceKind, string> = {
  ROLE: 'Role',
  TEAM: 'Team',
  USER: 'User',
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  EMAIL: 'E-mail',
  IN_APP: 'In-app',
  WEBHOOK: 'Webhook',
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function subKey(event: string, channel: NotificationChannel): string {
  return `${event}:${channel}`
}

function last4(secret: string): string {
  return secret.slice(-4)
}

export function NotificationsPage() {
  const user = useAuthUser()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [webhooks, setWebhooks] = useState<NotificationWebhook[]>([])
  const [newWebhookUrl, setNewWebhookUrl] = useState('')
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([])
  const [rotated, setRotated] = useState<{ webhookId: string; secret: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    getTmsSettings()
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setWebhooks(s?.notificationWebhooks ?? [])
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

  const subscriptions = useMemo(() => settings?.notificationSubscriptions ?? [], [settings])
  const defaults = settings?.notificationDefaults ?? {}
  const teams = settings?.teams ?? []

  const subMap = useMemo(() => {
    const map: Record<string, (typeof subscriptions)[number]> = {}
    for (const s of subscriptions) {
      map[subKey(s.event, s.channel)] = s
    }
    return map
  }, [subscriptions])

  const setSubscriptions = (next: typeof subscriptions) => {
    setSettings((prev) => (prev ? { ...prev, notificationSubscriptions: next } : prev))
  }

  const setDefaults = (patch: typeof defaults) => {
    setSettings((prev) => (prev ? { ...prev, notificationDefaults: { ...prev.notificationDefaults, ...patch } } : prev))
  }

  const toggleChannel = (event: string, channel: NotificationChannel, checked: boolean) => {
    const key = subKey(event, channel)
    if (checked) {
      if (subMap[key]) return
      setSubscriptions([
        ...subscriptions,
        {
          event,
          channel,
          audience: { kind: 'USER', value: user?.email ?? '' },
          enabled: true,
        },
      ])
    } else {
      setSubscriptions(subscriptions.filter((s) => subKey(s.event, s.channel) !== key))
    }
  }

  const setAudience = (
    event: string,
    channel: NotificationChannel,
    kind: NotificationAudienceKind,
    value: string,
  ) => {
    const key = subKey(event, channel)
    setSubscriptions(
      subscriptions.map((s) =>
        subKey(s.event, s.channel) === key ? { ...s, audience: { kind, value } } : s,
      ),
    )
  }

  const toggleSubscriptionEnabled = (event: string, channel: NotificationChannel, enabled: boolean) => {
    const key = subKey(event, channel)
    setSubscriptions(
      subscriptions.map((s) => (subKey(s.event, s.channel) === key ? { ...s, enabled } : s)),
    )
  }

  const addWebhook = () => {
    const url = newWebhookUrl.trim()
    if (!url) { setError('Webhook URL is required.'); return }
    if (!url.startsWith('https://')) { setError('Webhook URL must use https.'); return }
    if (newWebhookEvents.length === 0) { setError('Select at least one event.'); return }
    const id = `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setWebhooks((prev) => [
      ...prev,
      {
        id,
        url,
        events: newWebhookEvents,
        active: true,
        createdAt: new Date().toISOString(),
        createdBy: user?.email ?? '',
        failureCount: 0,
        secretRef: null,
        secretLast4: null,
      },
    ])
    setNewWebhookUrl('')
    setNewWebhookEvents([])
    setError(null)
  }

  const removeWebhook = (id: string) => {
    setWebhooks((prev) => prev.filter((w) => w.id !== id))
  }

  const toggleWebhookActive = (id: string, active: boolean) => {
    setWebhooks((prev) => prev.map((w) => (w.id === id ? { ...w, active } : w)))
  }

  const handleRotate = async (id: string) => {
    setError(null)
    try {
      const result = await rotateWebhookSecret(id)
      setRotated(result)
      setWebhooks((prev) =>
        prev.map((w) =>
          w.id === id ? { ...w, secretLast4: last4(result.secret) } : w,
        ),
      )
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const patch: Parameters<typeof saveTmsSettings>[0] = {
        notificationSubscriptions: subscriptions,
        notificationWebhooks: webhooks,
        notificationDefaults: defaults,
      }
      const saved = await saveTmsSettings(patch, settings.updatedAt ?? undefined)
      setSettings(saved)
      setWebhooks(saved?.notificationWebhooks ?? [])
      toast.success('Notifications saved')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  const webhookColumns: Array<ColumnDef<NotificationWebhook>> = [
    { key: 'url', header: 'URL', render: (row) => <span style={{ wordBreak: 'break-all' }}>{row.url}</span> },
    {
      key: 'events',
      header: 'Events',
      render: (row) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {row.events.map((e) => (
            <span key={e} className="tms-badge tms-badge-gray" style={{ fontSize: 11 }}>{e}</span>
          ))}
        </span>
      ),
    },
    {
      key: 'active',
      header: 'Active',
      width: 80,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`Active ${row.url}`}
          checked={row.active}
          onChange={(e) => toggleWebhookActive(row.id, e.target.checked)}
          style={{ accentColor: 'var(--tms-primary)', width: 16, height: 16 }}
        />
      ),
    },
    {
      key: 'secret',
      header: 'Secret',
      width: 100,
      render: (row) => (
        <span className="tms-field-hint">{row.secretLast4 ? `••••${row.secretLast4}` : 'Not set'}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 140,
      render: (row) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <TmsButton size="sm" onClick={() => void handleRotate(row.id)}>Rotate</TmsButton>
          <TmsButton size="sm" variant="destructive" onClick={() => removeWebhook(row.id)}>
            <Trash2 size={14} />
          </TmsButton>
        </div>
      ),
    },
  ]

  if (loading) {
    return (
      <TmsCard>
        <Loading />
      </TmsCard>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={Bell}
        title="Notifications"
        description="Who receives which channel for each event, and where webhooks are sent."
        actions={
          <TmsButton variant="primary" onClick={() => void handleSave()} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </TmsButton>
        }
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}

          <Panel>
            <GroupLabel>Global pause</GroupLabel>
            <CheckRow
              label="Pause all notifications"
              checked={defaults.pauseAll === true}
              onChange={(v) => setDefaults({ pauseAll: v })}
            />
            <p className="tms-field-hint">When paused, subscriptions and webhooks are still stored but nothing is delivered.</p>
          </Panel>

          <Panel>
            <GroupLabel>Event catalog</GroupLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {EVENT_CATALOG.map((entry) => (
                <div
                  key={entry.event}
                  style={{
                    border: '1px solid var(--tms-border)',
                    borderRadius: 'var(--tms-radius)',
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{entry.label}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {entry.channels
                      .filter((c): c is NotificationChannel => (CHANNELS as readonly string[]).includes(c))
                      .map((channel) => {
                        const key = subKey(entry.event, channel)
                        const sub = subMap[key]
                        return (
                          <div key={channel} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <CheckRow
                              label={CHANNEL_LABELS[channel]}
                              checked={!!sub}
                              onChange={(v) => toggleChannel(entry.event, channel, v)}
                            />
                            {sub ? (
                              <div style={{ display: 'flex', gap: 8, paddingLeft: 25, alignItems: 'center', flexWrap: 'wrap' }}>
                                <TmsSelect
                                  aria-label="Audience kind"
                                  value={sub.audience.kind}
                                  onChange={(e) =>
                                    setAudience(
                                      entry.event,
                                      channel,
                                      e.target.value as NotificationAudienceKind,
                                      sub.audience.value,
                                    )
                                  }
                                  options={AUDIENCE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
                                  style={{ width: 100 }}
                                />
                                {sub.audience.kind === 'ROLE' ? (
                                  <TmsSelect
                                    aria-label="Role"
                                    value={sub.audience.value}
                                    onChange={(e) =>
                                      setAudience(entry.event, channel, 'ROLE', e.target.value)
                                    }
                                    options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                                  />
                                ) : sub.audience.kind === 'TEAM' ? (
                                  <TmsSelect
                                    aria-label="Team"
                                    value={sub.audience.value}
                                    onChange={(e) =>
                                      setAudience(entry.event, channel, 'TEAM', e.target.value)
                                    }
                                    options={teams.map((t) => ({ value: t.key, label: t.name }))}
                                    placeholder="Select team"
                                  />
                                ) : (
                                  <TmsInput
                                    aria-label="E-mail"
                                    type="email"
                                    value={sub.audience.value}
                                    onChange={(e) =>
                                      setAudience(entry.event, channel, 'USER', e.target.value)
                                    }
                                    placeholder="user@bcatcorp.com"
                                    style={{ minWidth: 220 }}
                                  />
                                )}
                                <CheckRow
                                  label="Enabled"
                                  checked={sub.enabled}
                                  onChange={(v) => toggleSubscriptionEnabled(entry.event, channel, v)}
                                />
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </Stack>
      </SettingsCard>

      <TmsCard title="Webhook endpoints">
        <Stack>
          <Panel>
            <GroupLabel>Add webhook</GroupLabel>
            <TmsField label="URL">
              <TmsInput
                type="url"
                value={newWebhookUrl}
                onChange={(e) => setNewWebhookUrl(e.target.value)}
                placeholder="https://api.example.com/bcat-webhook"
              />
            </TmsField>
            <TmsField label="Events">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {EVENT_CATALOG.map((e) => (
                  <CheckRow
                    key={e.event}
                    label={e.label}
                    checked={newWebhookEvents.includes(e.event)}
                    onChange={(v) =>
                      setNewWebhookEvents((prev) =>
                        v ? [...prev, e.event] : prev.filter((x) => x !== e.event),
                      )
                    }
                  />
                ))}
              </div>
            </TmsField>
            <TmsButton size="sm" onClick={addWebhook}>
              <Plus size={14} /> Add webhook
            </TmsButton>
          </Panel>

          {rotated ? (
            <Panel style={{ background: 'var(--tms-bg-elevated)' }}>
              <GroupLabel>New secret for {rotated.webhookId}</GroupLabel>
              <p className="tms-field-hint">Copy it now — it is shown only once.</p>
              <TmsInput readOnly value={rotated.secret} onFocus={(e) => e.target.select()} />
              <TmsButton size="sm" variant="ghost" onClick={() => setRotated(null)}>Dismiss</TmsButton>
            </Panel>
          ) : null}

          <TmsTable
            columns={webhookColumns}
            rows={webhooks}
            rowKey={(row) => row.id}
            empty={<span className="tms-muted">No webhooks configured.</span>}
          />
        </Stack>
      </TmsCard>
    </div>
  )
}

export default NotificationsPage
