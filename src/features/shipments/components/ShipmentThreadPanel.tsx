/**
 * Step P8 — the shipment thread and the check-call plan on the Tracking tab.
 *
 * The conversation sits under the timeline because it is the record of what the
 * tracking agent and the dispatcher said to each other. The check-call plan editor
 * is here because the tracking agent reads it, and a tracker should see the plan
 * beside the messages it produces.
 *
 * On dev, outbound SES/Twilio are inert: a NOT_SENT row carries the exact message
 * the app would have sent, and the UI prints it so a human can see what would have
 * gone out. Voice is deferred and shown greyed out with the reason from the shared
 * channel vocabulary.
 */
import { useEffect, useMemo, useState } from 'react'
import { Mail, MessageSquare, Phone, Send, AlertTriangle, Play, FileImage } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/useAppStore'
import {
  TmsBadge, TmsButton, TmsCard, TmsEmptyState, TmsField, TmsInput, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import {
  listShipmentMessages, sendShipmentMessage, runCheckCallPlan, saveLoadCheckCallPlan, requestPod, graphqlErrorText,
} from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import {
  CHECK_CALL_CHANNELS, CHECK_CALL_MILESTONES, CHANNEL_DISABLED_REASON,
  MILESTONE_LABELS, isChannelEnabled, normalizeCheckCallPlan, type CheckCallChannel, type CheckCallMilestone,
  type CheckCallPlan,
} from '@/lib/checkCallPlan'
import { resolveCheckCallPlan } from '@/lib/flowDefaults'
import type { CustomerRecord, LoadCarrierRecord, ShipmentLoad, ShipmentMessageRecord, TmsSettings } from '@/types/tms'

/** Surface the API error without letting a missing/broken helper escape as an unhandled rejection. */
const threadErrorText = (err: unknown): string => {
  try {
    return graphqlErrorText(err) || 'Something went wrong.'
  } catch {
    return err instanceof Error ? err.message : 'Something went wrong.'
  }
}

const CHANNEL_ICONS: Record<CheckCallChannel, typeof Mail> = {
  EMAIL: Mail,
  SMS: MessageSquare,
  VOICE: Phone,
}

type Recipient = 'DRIVER' | 'DISPATCHER'

function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0] || email
  const part = local.split(/[._]/)[0] || local
  if (!part) return 'BCAT'
  return part[0].toUpperCase() + part.slice(1).toLowerCase()
}

function planHasOverride(subject?: { checkCallPlan?: unknown } | null): boolean {
  return normalizeCheckCallPlan(subject?.checkCallPlan) != null
}

function checkCallPlanSource(
  settings: TmsSettings | null | undefined,
  customer: CustomerRecord | null | undefined,
  load: ShipmentLoad | null | undefined,
): string {
  if (planHasOverride(load)) return 'set on this shipment'
  if (planHasOverride(customer)) return customer?.name ? `inherited from ${customer.name}` : 'inherited from customer'
  if (normalizeCheckCallPlan(settings?.defaultCheckCallPlan) != null) return 'org default'
  return 'built-in default'
}

export interface ShipmentThreadPanelProps {
  shipmentId: string
  shipmentNumber: string
  lane?: string | null
  load?: ShipmentLoad | null
  loadCarrier?: LoadCarrierRecord | null
  customer?: CustomerRecord | null
  settings?: TmsSettings | null
  trackingFlaggedAt?: string | null
  trackingFlagReason?: string | null
  onReload?: () => void | Promise<void>
}

export function ShipmentThreadPanel({
  shipmentId, shipmentNumber, lane, load, loadCarrier, customer, settings,
  trackingFlaggedAt, trackingFlagReason, onReload,
}: ShipmentThreadPanelProps) {
  const [messages, setMessages] = useState<ShipmentMessageRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [runResult, setRunResult] = useState<{ action: string; reason: string } | null>(null)

  const [recipient, setRecipient] = useState<Recipient>('DRIVER')
  const [channel, setChannel] = useState<'EMAIL' | 'SMS'>('SMS')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  const actorEmail = useAppStore((s) => s.currentUserEmail)
  const authorFirstName = firstNameFromEmail(actorEmail)

  const resolvedPlan = useMemo(
    () => resolveCheckCallPlan(settings, customer, load),
    [settings, customer, load],
  )
  const hasOverride = planHasOverride(load)
  const sourceLabel = useMemo(
    () => checkCallPlanSource(settings, customer, load),
    [settings, customer, load],
  )

  const initialPlan = useMemo(() => normalizeCheckCallPlan(load?.checkCallPlan) ?? resolvedPlan, [load?.checkCallPlan, resolvedPlan])
  const [plan, setPlan] = useState<CheckCallPlan>(initialPlan)

  // When the load's saved plan changes underneath the panel (e.g. a reload after
  // run-now), adopt it — adjusting during render, not in an effect, so the edit
  // form never paints one frame of the stale plan.
  const [prevInitialPlan, setPrevInitialPlan] = useState(initialPlan)
  if (prevInitialPlan !== initialPlan) {
    setPrevInitialPlan(initialPlan)
    setPlan(initialPlan)
  }

  const defaultTo = useMemo(() => {
    if (recipient === 'DRIVER') return channel === 'SMS' ? (loadCarrier?.driverPhone ?? '') : ''
    return channel === 'SMS' ? (loadCarrier?.dispatcherPhone ?? '') : (loadCarrier?.dispatcherEmail ?? '')
  }, [recipient, channel, loadCarrier])

  const [to, setTo] = useState(defaultTo)

  // When the recipient/channel/carrier changes, reset the address field
  // during render so the composer never paints one frame of the stale address.
  const [prevDefaultTo, setPrevDefaultTo] = useState(defaultTo)
  if (prevDefaultTo !== defaultTo) {
    setPrevDefaultTo(defaultTo)
    setTo(defaultTo)
  }

  const refresh = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const rows = await listShipmentMessages(shipmentId)
      setMessages(rows)
    } catch (err) {
      const message = threadErrorText(err)
      setLoadError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  // The first read is the only one driven by an effect; every later refresh is
  // kicked off by a user action (send, run-now) and owns its spinner.
  useEffect(() => {
    let live = true
    listShipmentMessages(shipmentId)
      .then((rows) => {
        if (!live) return
        setMessages(rows)
        setLoadError(null)
      })
      .catch((err) => {
        if (!live) return
        const message = threadErrorText(err)
        setLoadError(message)
        toast.error(message)
      })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [shipmentId])

  const send = async () => {
    if (!body.trim()) return
    setBusy(true)
    try {
      await sendShipmentMessage({
        shipmentId,
        channel,
        to: to.trim() || null,
        subject: channel === 'EMAIL' ? (subject.trim() || null) : null,
        body: body.trim(),
      })
      toast.success('Message sent')
      setBody('')
      setSubject('')
      setTo(defaultTo)
      await refresh()
      await onReload?.()
    } catch (err) {
      toast.error(threadErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const runNow = async () => {
    setBusy(true)
    setRunResult(null)
    try {
      const result = await runCheckCallPlan({ shipmentId })
      setRunResult({ action: result.action, reason: result.reason })
      await refresh()
      await onReload?.()
    } catch (err) {
      toast.error(threadErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const savePlan = async () => {
    if (!load?.id) {
      toast.error('No load to save the check-call plan against.')
      return
    }
    setBusy(true)
    try {
      await saveLoadCheckCallPlan({ loadId: load.id, plan, expectedUpdatedAt: load.updatedAt ?? undefined })
      toast.success('Check-call plan saved')
      await onReload?.()
    } catch (err) {
      toast.error(threadErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const clearPlanOverride = async () => {
    if (!load?.id) {
      toast.error('No load to clear the check-call plan against.')
      return
    }
    setBusy(true)
    try {
      await saveLoadCheckCallPlan({ loadId: load.id, plan: null, expectedUpdatedAt: load.updatedAt ?? undefined })
      toast.success('Check-call plan cleared back to inheritance')
      setPlan(resolvedPlan)
      await onReload?.()
    } catch (err) {
      toast.error(threadErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const requestPodNow = async () => {
    setBusy(true)
    try {
      await requestPod({ shipmentId })
      toast.success('POD requested')
      await refresh()
      await onReload?.()
    } catch (err) {
      toast.error(threadErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleChannel = (c: CheckCallChannel) => {
    if (!isChannelEnabled(c)) return
    setPlan((p) => ({ ...p, channels: p.channels.includes(c) ? p.channels.filter((x) => x !== c) : [...p.channels, c] }))
  }

  const toggleMilestone = (m: CheckCallMilestone) => {
    setPlan((p) => ({ ...p, milestones: p.milestones.includes(m) ? p.milestones.filter((x) => x !== m) : [...p.milestones, m] }))
  }

  const updateNumber = (
    key: 'intervalHours' | 'escalateAfterMinutes',
    value: string,
    min: number,
    max: number,
    fallback: number,
  ) => {
    if (value === '') {
      setPlan((p) => ({ ...p, [key]: fallback }))
      return
    }
    const n = Number(value)
    if (Number.isNaN(n)) return
    setPlan((p) => ({ ...p, [key]: Math.max(min, Math.min(max, n)) }))
  }

  const title = lane ? `Thread — Load ${shipmentNumber} — ${lane}` : `Thread — Load ${shipmentNumber}`

  const channelOptions = useMemo(() => CHECK_CALL_CHANNELS.map((c) => {
    const disabled = !isChannelEnabled(c)
    const reason = CHANNEL_DISABLED_REASON[c]
    return {
      value: c,
      label: c === 'EMAIL' ? 'E-mail' : c + (disabled && reason ? ` — ${reason}` : ''),
      disabled,
    }
  }), [])

  return (
    <div className="tms-thread-panel">
      {trackingFlaggedAt && (
        <div className="tms-thread-flag" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <div>
            <strong>Tracking flagged</strong>
            {trackingFlagReason && <p>{trackingFlagReason}</p>}
            <p className="tms-muted">{formatDateTime(trackingFlaggedAt)}</p>
          </div>
        </div>
      )}

      <TmsCard title="Check-call plan">
        <div className="tms-checkcall-editor">
          <div className="tms-checkcall-source" data-testid="check-call-source">
            <span className="tms-field-label">Effective plan</span>
            <span className="tms-muted">{sourceLabel}</span>
            {hasOverride && (
              <TmsButton variant="ghost" size="sm" disabled={busy} onClick={clearPlanOverride}>
                Clear override
              </TmsButton>
            )}
          </div>

          <TmsField label="Interval (hours)">
            <TmsInput
              type="number" min={1} max={24}
              value={String(plan.intervalHours)}
              onChange={(e) => updateNumber('intervalHours', e.target.value, 1, 24, resolvedPlan.intervalHours)}
            />
          </TmsField>

          <div>
            <span className="tms-field-label">Channels</span>
            <div className="tms-checkcall-channels">
              {CHECK_CALL_CHANNELS.map((c) => {
                const enabled = isChannelEnabled(c)
                const Icon = CHANNEL_ICONS[c]
                return (
                  <label
                    key={c}
                    className={`tms-checkcall-channel${!enabled ? ' tms-checkcall-channel-disabled' : ''}`}
                    title={CHANNEL_DISABLED_REASON[c] ?? ''}
                  >
                    <input
                      type="checkbox"
                      checked={plan.channels.includes(c)}
                      disabled={!enabled}
                      onChange={() => toggleChannel(c)}
                    />
                    <Icon size={14} aria-hidden />
                    <span>{c}</span>
                    {!enabled && <span className="tms-checkcall-channel-reason">{CHANNEL_DISABLED_REASON[c]}</span>}
                  </label>
                )
              })}
            </div>
          </div>

          <div>
            <span className="tms-field-label">Milestones</span>
            <div className="tms-checkcall-channels">
              {CHECK_CALL_MILESTONES.map((m) => (
                <label key={m} className="tms-checkcall-channel">
                  <input
                    type="checkbox"
                    checked={plan.milestones.includes(m)}
                    onChange={() => toggleMilestone(m)}
                  />
                  <span>{MILESTONE_LABELS[m]}</span>
                </label>
              ))}
            </div>
          </div>

          <TmsField label="Escalate after (minutes)">
            <TmsInput
              type="number" min={5}
              value={String(plan.escalateAfterMinutes)}
              onChange={(e) => updateNumber('escalateAfterMinutes', e.target.value, 5, 24 * 60, resolvedPlan.escalateAfterMinutes)}
            />
          </TmsField>

          <div className="tms-checkcall-actions">
            <TmsButton size="sm" disabled={busy} onClick={savePlan}>Save plan</TmsButton>
            <TmsButton size="sm" disabled={busy} onClick={runNow}><Play size={14} aria-hidden /> Run check call now</TmsButton>
            <TmsButton size="sm" disabled={busy} onClick={requestPodNow}><FileImage size={14} aria-hidden /> Request POD</TmsButton>
          </div>

          {runResult && (
            <div className="tms-checkcall-result" data-testid="run-result">
              <strong>{runResult.action}</strong>
              <span>— {runResult.reason}</span>
            </div>
          )}
        </div>
      </TmsCard>

      <TmsCard title={title}>
        {loadError && (
          <div className="mb-4 flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <span className="flex-1">{loadError}</span>
            <TmsButton size="sm" disabled={loading} onClick={() => void refresh()}>Retry</TmsButton>
          </div>
        )}
        {loading ? (
          <p className="tms-muted text-sm">Loading thread…</p>
        ) : messages.length === 0 ? (
          <TmsEmptyState title="No messages" message="Send a message or run the check-call plan to start the thread." />
        ) : (
          <ul className="tms-thread-list" data-testid="shipment-thread">
            {messages.map((m) => (
              <ThreadRow key={m.id} message={m} />
            ))}
          </ul>
        )}

        <div className="tms-thread-composer">
          <div className="tms-thread-composer-top">
            <TmsSelect
              aria-label="Recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value as Recipient)}
              options={[
                { value: 'DRIVER', label: loadCarrier?.driverName ? `Driver — ${loadCarrier.driverName}` : 'Driver' },
                { value: 'DISPATCHER', label: loadCarrier?.dispatcherName ? `Dispatcher — ${loadCarrier.dispatcherName}` : 'Dispatcher' },
              ]}
            />
            <TmsSelect
              aria-label="Channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'EMAIL' | 'SMS')}
              options={channelOptions}
            />
            <TmsInput
              aria-label="To"
              placeholder="To"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            {channel === 'EMAIL' && (
              <TmsInput
                aria-label="Subject"
                placeholder="Subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
          </div>
          <TmsTextarea
            aria-label="Message"
            placeholder="Type a message…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
          />
          <div className="tms-thread-composer-foot">
            <div className="tms-thread-signature" data-testid="signature-preview">
              — {authorFirstName}, BCAT Tracking
            </div>
            <TmsButton variant="primary" size="sm" disabled={busy || !body.trim()} onClick={send}>
              <Send size={14} aria-hidden /> Send
            </TmsButton>
          </div>
        </div>
      </TmsCard>
    </div>
  )
}

function ThreadRow({ message }: { message: ShipmentMessageRecord }) {
  const Icon = CHANNEL_ICONS[message.channel] ?? Mail
  const isOutbound = message.direction === 'OUT'
  const notSent = message.status === 'NOT_SENT'
  const authorKind = message.authorKind ?? 'PERSON'
  const authorName = message.authorName ?? (authorKind === 'AGENT' ? 'BCAT Tracking Assistant' : message.createdBy)

  return (
    <li className={`tms-thread-row${isOutbound ? ' tms-thread-out' : ' tms-thread-in'}`}>
      <div className="tms-thread-bubble">
        <div className="tms-thread-meta">
          <Icon size={14} aria-hidden />
          <TmsBadge tone={statusToneFor(message.status)}>{message.status}</TmsBadge>
          <span className="tms-thread-party" data-testid="message-author">{authorName}</span>
          <span className="tms-thread-author-kind" data-testid="message-author-kind">{authorKind === 'AGENT' ? 'agent' : 'person'}</span>
          <span className="tms-thread-party">{message.party ?? message.direction}</span>
          {message.to && <span className="tms-muted">→ {message.to}</span>}
          <span className="tms-muted tms-thread-time">{formatDateTime(message.at)}</span>
        </div>
        {message.subject && <p className="tms-thread-subject">{message.subject}</p>}
        <p className="tms-thread-body">{message.body}</p>
        {notSent && message.body && (
          <div className="tms-thread-not-sent">
            <strong>Would have sent:</strong>
            <p data-testid="not-sent-body">{message.body}</p>
          </div>
        )}
      </div>
    </li>
  )
}

function statusToneFor(status: ShipmentMessageRecord['status']) {
  switch (status) {
    case 'SENT': return 'green' as const
    case 'RECEIVED': return 'blue' as const
    case 'FAILED': return 'red' as const
    default: return 'gray' as const
  }
}
