import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Mail, MessageSquare, Phone, Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsCard, TmsEmptyState, TmsField, TmsInput, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import {
  CHECK_CALL_CHANNELS, CHECK_CALL_MILESTONES, CHANNEL_DISABLED_REASON, MILESTONE_LABELS,
  isChannelEnabled, type CheckCallChannel, type CheckCallMilestone, type CheckCallPlan,
} from '@/lib/checkCallPlan'
import type { CustomerRecord, ShipmentBundle, ShipmentMessageRecord, TmsSettings } from '@/types/tms'
import type { ShipmentRow } from '../../shipmentViews'
import { TrackingDetailMap } from './TrackingDetailMap'
import { resolveCheckCallPlanWithSource, type CheckCallPlanSource } from './checkCallPlanSource'

const CHANNEL_ICONS: Record<CheckCallChannel, typeof Mail> = {
  EMAIL: Mail,
  SMS: MessageSquare,
  VOICE: Phone,
}

type RecipientKey = 'driver' | 'dispatcher'
type ComposerChannel = 'EMAIL' | 'SMS'

interface TrackingDetailPanelProps {
  row: ShipmentRow
  bundle: ShipmentBundle | null
  messages: ShipmentMessageRecord[]
  loading: boolean
  customers: CustomerRecord[]
  settings: TmsSettings | null
  userName?: string | null
  mapsKey?: string
  mapsMapId?: string
  onSendMessage: (input: {
    channel: ComposerChannel
    to: string | null
    subject: string | null
    body: string
  }) => Promise<void>
  onSavePlan: (loadId: string, plan: CheckCallPlan, expectedUpdatedAt?: string) => Promise<void>
  onRefresh: () => void | Promise<void>
}

function firstName(name: string | null | undefined): string {
  if (!name) return 'you'
  return name.split(/[@\s]/)[0] ?? name
}

function sourceLabel(source: CheckCallPlanSource, sourceName: string | null): string {
  switch (source) {
    case 'load': return 'Overridden for this shipment'
    case 'customer': return sourceName ? `Inherited from ${sourceName}` : 'Inherited from customer'
    case 'org': return `Inherited from ${sourceName ?? 'BCAT'} default`
    default: return 'Default plan'
  }
}

function partyLabel(m: ShipmentMessageRecord): string {
  if (m.authorKind === 'AGENT') return 'BCAT Tracking Assistant'
  if (m.authorKind === 'PERSON' && m.authorName) return m.authorName
  if (m.party) return m.party.toLowerCase()
  return m.direction === 'IN' ? 'inbound' : 'outbound'
}

function authorBadge(m: ShipmentMessageRecord): { text: string; title: string } {
  if (m.authorKind === 'AGENT') return { text: 'Agent', title: 'Sent by BCAT Tracking Assistant' }
  if (m.authorKind === 'PERSON') {
    const name = m.authorName ?? 'a person'
    return { text: `Person — ${firstName(name)}`, title: `Sent by ${name}` }
  }
  return { text: 'Unknown', title: 'Sender not recorded' }
}

export function TrackingDetailPanel({
  row,
  bundle,
  messages,
  loading,
  customers,
  settings,
  userName,
  mapsKey,
  mapsMapId,
  onSendMessage,
  onSavePlan,
  onRefresh,
}: TrackingDetailPanelProps) {
  const load = useMemo(() => bundle?.loads[0] ?? null, [bundle])
  const carrier = useMemo(() => {
    if (!load) return null
    return bundle?.loadCarriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE') ?? null
  }, [bundle, load])

  const customer = useMemo(
    () => customers.find((c) => c.id === row.customerId) ?? null,
    [customers, row.customerId],
  )

  const resolved = useMemo(
    () => resolveCheckCallPlanWithSource(load, customer, settings),
    [load, customer, settings],
  )

  const [plan, setPlan] = useState<CheckCallPlan>(resolved.plan)
  const [prevResolvedPlan, setPrevResolvedPlan] = useState(resolved.plan)
  if (prevResolvedPlan !== resolved.plan) {
    setPrevResolvedPlan(resolved.plan)
    setPlan(resolved.plan)
  }

  const [busy, setBusy] = useState(false)
  const [recipient, setRecipient] = useState<RecipientKey>('driver')
  const [channel, setChannel] = useState<ComposerChannel>('SMS')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  // When the selected row changes, reset the composer during render so the
  // panel never paints one frame of the stale recipient or message.
  const [prevRowId, setPrevRowId] = useState(row.id)
  if (prevRowId !== row.id) {
    setPrevRowId(row.id)
    setRecipient('driver')
    setChannel('SMS')
    setSubject('')
    setBody('')
  }

  const recipientAddress = useMemo(() => {
    if (!carrier) return null
    if (recipient === 'driver') {
      return channel === 'EMAIL' ? null : (carrier.driverPhone ?? null)
    }
    return channel === 'EMAIL' ? (carrier.dispatcherEmail ?? null) : (carrier.dispatcherPhone ?? null)
  }, [carrier, recipient, channel])

  const recipientAvailable = Boolean(recipientAddress)
  const canSendVoice = false

  const signature = useMemo(() => {
    const name = firstName(userName)
    return `— ${name}, BCAT Tracking`
  }, [userName])

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    [messages],
  )

  const lastKnown = useMemo(() => {
    const lat = load?.lastKnownLat
    const lng = load?.lastKnownLng
    if (lat == null || lng == null) return null
    return { lat, lng }
  }, [load])

  const deliveryStop = useMemo(
    () => load?.stops?.find((s) => s.type === 'delivery') ?? load?.stops?.[load.stops.length - 1] ?? null,
    [load],
  )
  const deliveryPoint = useMemo(() => {
    const lat = deliveryStop?.address?.lat
    const lng = deliveryStop?.address?.lng
    if (lat == null || lng == null) return null
    return { lat, lng }
  }, [deliveryStop])

  const toggleChannel = useCallback((c: CheckCallChannel) => {
    if (!isChannelEnabled(c)) return
    setPlan((p) => ({
      ...p,
      channels: p.channels.includes(c) ? p.channels.filter((x) => x !== c) : [...p.channels, c],
    }))
  }, [])

  const toggleMilestone = useCallback((m: CheckCallMilestone) => {
    setPlan((p) => ({
      ...p,
      milestones: p.milestones.includes(m) ? p.milestones.filter((x) => x !== m) : [...p.milestones, m],
    }))
  }, [])

  const savePlan = useCallback(async () => {
    if (!load?.id) {
      toast.error('No load to save the check-call plan against.')
      return
    }
    setBusy(true)
    try {
      await onSavePlan(load.id, plan, load.updatedAt ?? undefined)
      toast.success('Check-call plan saved')
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }, [load, plan, onSavePlan, onRefresh])

  const send = useCallback(async () => {
    if (!body.trim() || !recipientAvailable) return
    setBusy(true)
    try {
      await onSendMessage({
        channel,
        to: recipientAddress ?? null,
        subject: channel === 'EMAIL' ? (subject.trim() || null) : null,
        body: body.trim(),
      })
      toast.success('Message sent')
      setBody('')
      setSubject('')
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }, [body, recipientAvailable, recipientAddress, channel, subject, onSendMessage, onRefresh])

  if (loading) {
    return (
      <div className="tms-tracking-detail">
        <p className="tms-tracking-detail-empty">Loading shipment details…</p>
      </div>
    )
  }

  if (!load) {
    return (
      <div className="tms-tracking-detail">
        <TmsEmptyState title="No load" message="This shipment has no load to track yet." />
      </div>
    )
  }

  return (
    <div className="tms-tracking-detail" data-testid="tracking-detail">
      {row.trackingFlaggedAt && (
        <div className="tms-thread-flag" role="alert" data-testid="detail-flag">
          <AlertTriangle size={16} aria-hidden />
          <div>
            <strong>Tracking flagged</strong>
            {row.trackingFlagReason && <p>{row.trackingFlagReason}</p>}
            <p className="tms-muted">{formatDateTime(row.trackingFlaggedAt)}</p>
          </div>
        </div>
      )}

      <TmsCard title="Map & ETA" flush>
        <TrackingDetailMap
          apiKey={mapsKey}
          mapId={mapsMapId}
          lastKnown={lastKnown}
          delivery={deliveryPoint}
          deliveryName={deliveryStop?.name ?? row.destinationCity}
        />
        <div className="tms-tracking-detail-eta">
          <span className="tms-tracking-detail-eta-label">Delivery ETA</span>
          <span className="tms-tracking-detail-eta-value" data-testid="detail-eta">
            {carrier?.deliveryEtaAt ? formatDateTime(carrier.deliveryEtaAt) : 'No ETA'}
          </span>
        </div>
      </TmsCard>

      <TmsCard title="Check-call plan">
        <div className="tms-checkcall-editor">
          <p className="tms-tracking-detail-source" data-testid="plan-source">
            {sourceLabel(resolved.source, resolved.sourceName)}
          </p>

          <TmsField label="Interval (hours)">
            <TmsInput
              type="number"
              min={1}
              max={24}
              value={String(plan.intervalHours)}
              onChange={(e) => setPlan((p) => ({ ...p, intervalHours: Math.max(1, Math.min(24, Number(e.target.value) || 1)) }))}
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
              type="number"
              min={5}
              value={String(plan.escalateAfterMinutes)}
              onChange={(e) => setPlan((p) => ({ ...p, escalateAfterMinutes: Math.max(5, Number(e.target.value) || 5) }))}
            />
          </TmsField>

          <div className="tms-checkcall-actions">
            <TmsButton size="sm" disabled={busy} onClick={() => void savePlan()}>
              Save plan
            </TmsButton>
          </div>
        </div>
      </TmsCard>

      <TmsCard title={`Thread — ${row.number}`}>
        {sortedMessages.length === 0 ? (
          <TmsEmptyState title="No messages" message="Send a message to start the thread." />
        ) : (
          <ul className="tms-thread-list" data-testid="detail-thread">
            {sortedMessages.map((m) => (
              <ThreadRow key={m.id} message={m} />
            ))}
          </ul>
        )}

        <div className="tms-thread-composer" data-testid="thread-composer">
          <div className="tms-thread-composer-top">
            <TmsSelect
              aria-label="Recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value as RecipientKey)}
              options={[
                { value: 'driver', label: 'Driver' },
                { value: 'dispatcher', label: 'Dispatcher' },
              ]}
            />
            <TmsSelect
              aria-label="Channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as ComposerChannel)}
            >
              <option value="SMS">SMS</option>
              <option value="EMAIL">E-mail</option>
              <option value="VOICE" disabled>{canSendVoice ? 'Voice' : 'Voice (voice is not switched on yet)'}</option>
            </TmsSelect>
            {channel === 'EMAIL' && (
              <TmsInput
                aria-label="Subject"
                placeholder="Subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
          </div>
          <TmsField
            label="Message"
            hint={
              <span className="tms-thread-signature-preview">
                The server will sign it: <em>{signature}</em>
              </span>
            }
          >
            <TmsTextarea
              aria-label="Message body"
              placeholder="Type a message…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
          </TmsField>
          <div className="tms-thread-composer-foot">
            <TmsButton
              variant="primary"
              size="sm"
              disabled={busy || !body.trim() || !recipientAvailable}
              onClick={() => void send()}
            >
              <Send size={14} aria-hidden /> Send
            </TmsButton>
          </div>
          {!recipientAvailable && (
            <p className="tms-thread-composer-error">
              {recipient === 'driver'
                ? `This driver has no ${channel === 'EMAIL' ? 'e-mail' : 'phone'} on file.`
                : `This dispatcher has no ${channel === 'EMAIL' ? 'e-mail' : 'phone'} on file.`}
            </p>
          )}
        </div>
      </TmsCard>
    </div>
  )
}

function ThreadRow({ message }: { message: ShipmentMessageRecord }) {
  const Icon = CHANNEL_ICONS[message.channel] ?? Mail
  const isOutbound = message.direction === 'OUT'
  const notSent = message.status === 'NOT_SENT'
  const author = authorBadge(message)

  return (
    <li className={`tms-thread-row${isOutbound ? ' tms-thread-out' : ' tms-thread-in'}`}>
      <div className="tms-thread-bubble">
        <div className="tms-thread-meta">
          <Icon size={14} aria-hidden />
          <TmsBadge tone={statusToneFor(message.status)}>{message.status}</TmsBadge>
          <span className="tms-thread-party" title={author.title}>{partyLabel(message)}</span>
          <TmsBadge tone="gray" title={author.title} data-testid="thread-author">
            {author.text}
          </TmsBadge>
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
