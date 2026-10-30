/**
 * The Tracking tab of a shipment: where the freight is, who said so, and what is due
 * next (spec §3.4, §6.2 `LoadCheckCall`).
 *
 * Everything on this tab is derived, never stored twice: the timeline is
 * `buildTimeline` over the check calls, the link pings and Motive's breadcrumbs; the
 * banner's tone is `checkCallState`, the same function the notifier Lambda sweeps with.
 * Every write goes through the shipment or tracking Lambda with the CAS token the tab
 * last read, and the bundle on screen is replaced by what the action answers with.
 */
import { useCallback, useContext, useEffect, useState } from 'react'
import {
  AlertTriangle, Check, Clock, Cog, Link2, MapPin, PhoneCall, Send, Smartphone, Truck, Users,
} from 'lucide-react'
import { TmsBadge, TmsButton, TmsCard, TmsInput } from '@/features/tms/kit'
import { Label } from '@/components/ui/label'
import { AuthContext } from '@/hooks/useAuth'
import {
  getTmsSettings, listDivisions, listShipmentMessages, saveLoadCheckCallPlan, sendShipmentMessage, textDriver,
} from '@/lib/apiClient'
import { checkCallState, CHECK_CALL_TYPE_LABELS, INCIDENT_TYPE_LABELS } from '@/lib/checkCalls'
import { LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { formatDateTime, formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { useLoadTracking } from '@/hooks/useLoadTracking'
import type { TimelineItem } from '@/lib/trackingTimeline'
import type {
  ChargeCodeDef, CheckCallSource, CustomerRecord, ShipmentBundle, ShipmentMessageRecord,
  TmsSettings, TrackingLinkRecord,
} from '@/types/tms'
import { CustomerLinkDialog } from './CustomerLinkDialog'
import { LogCheckCallDialog, type CheckCallFormValues } from './LogCheckCallDialog'
import { TrackingLinkDialog } from './TrackingLinkDialog'
import { TrackingDetailPanel } from '../workstations/tracking/TrackingDetailPanel'
import type { ShipmentActions } from '../useShipmentActions'

const HOUR_MS = 3_600_000
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

/** "14 min ago" below an hour, then hours, then days: an order of magnitude is enough. */
function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 1440)} d ago`
}

const SOURCE_ICON: Record<CheckCallSource, typeof PhoneCall> = {
  MANUAL: PhoneCall,
  DRIVER_APP: Smartphone,
  LINK: Link2,
  SYSTEM: Cog,
}

type TrackingDialog = { kind: 'check_call' } | { kind: 'carrier_link' } | { kind: 'customer_link' } | null

export function TrackingSection({ bundle, customer, catalog, actions }: {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  catalog: ChargeCodeDef[]
  actions: ShipmentActions
}) {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [brokerName, setBrokerName] = useState('BCAT Logistics')
  const [dialog, setDialog] = useState<TrackingDialog>(null)
  const [reminderDraft, setReminderDraft] = useState<string | null>(null)
  const [pickupEta, setPickupEta] = useState<string | null>(null)
  const [deliveryEta, setDeliveryEta] = useState<string | null>(null)

  const shipment = bundle.shipment
  const load = bundle.loads[0]
  const loadCarrier = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const divisionKey = load?.divisionKey ?? null

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    Promise.all([getTmsSettings().catch(() => null), listDivisions().catch(() => [])])
      .then(([s, divisions]) => {
        if (!live) return
        setSettings(s)
        const own = divisionKey ? divisions.find((d) => d.key === divisionKey) : divisions[0]
        if (own?.name) setBrokerName(own.name)
      })
    return () => { live = false }
  }, [divisionKey])

  // The thread reads and writes itself so the shared detail pane stays presentational;
  // the first read is the only one driven by an effect, later ones follow a send.
  const [messages, setMessages] = useState<ShipmentMessageRecord[]>([])
  const reloadMessages = useCallback(async () => {
    try {
      setMessages(await listShipmentMessages(shipment.id))
    } catch {
      // Keep the last good thread: a failed re-read must not erase what was on screen.
    }
  }, [shipment.id])

  useEffect(() => {
    let live = true
    listShipmentMessages(shipment.id)
      .then((rows) => { if (live) setMessages(rows) })
      .catch(() => { /* keep whatever the thread last showed */ })
    return () => { live = false }
  }, [shipment.id])

  const auth = useContext(AuthContext)

  const tracking = useLoadTracking({
    loadId: load?.id,
    shipmentId: shipment.id,
    truckId: loadCarrier?.truckId ?? null,
    load: { pickupAppt: load?.pickupAppt, deliveredAt: load?.deliveredAt },
    loadCarrier: { dispatchedAt: loadCarrier?.dispatchedAt },
  })

  // The hook's clock, frozen at the last poll — a DUE/OVERDUE tone only needs minute
  // granularity, and reading `Date.now()` during render is impure.
  const now = tracking.nowMs
  const state = checkCallState(load ?? {}, now, settings?.checkCallGraceMinutes)
  const carrierLink = tracking.links.find((l) => l.kind === 'CARRIER_PING' && l.status === 'ACTIVE') ?? null
  const customerLink = tracking.links.find((l) => l.kind === 'CUSTOMER_VIEW' && l.status === 'ACTIVE') ?? null

  if (!load) {
    return <p className="text-sm tms-muted">This shipment has no load to track yet.</p>
  }

  const saveReminder = (iso: string | null) => {
    void actions.tracking.setNextCheckCall(iso).then(() => setReminderDraft(null)).catch(() => { /* reported */ })
  }

  const tone = state === 'OVERDUE'
    ? 'border-[color:var(--tms-badge-red)]  text-[color:var(--tms-badge-red)]'
    : state === 'DUE'
      ? 'border-[color:var(--tms-badge-orange)] 0/5 text-[color:var(--tms-badge-orange)]'
      : 'border-[color:var(--tms-border)]'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <TmsBadge tone="gray" className="text-[10px]" data-testid="tracking-provider">
          {(load.trackingProvider ?? 'NONE').replace(/_/g, ' ')}
        </TmsBadge>
        {(load.openIncidentCount ?? 0) > 0 && (
          <TmsBadge tone="gray" className="border-[color:var(--tms-badge-red)] text-[10px] text-[color:var(--tms-badge-red)]">
            {load.openIncidentCount} open exception{load.openIncidentCount === 1 ? '' : 's'}
          </TmsBadge>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <TmsButton variant="primary" size="sm" onClick={() => setDialog({ kind: 'check_call' })} disabled={actions.busy}>
            <PhoneCall size={14} className="mr-1" />Log check call
          </TmsButton>
          <TmsButton size="sm" onClick={() => setDialog({ kind: 'carrier_link' })} disabled={!loadCarrier}>
            <Send size={14} className="mr-1" />Send tracking link
          </TmsButton>
          <TmsButton size="sm" onClick={() => setDialog({ kind: 'customer_link' })}>
            <Users size={14} className="mr-1" />Customer link
          </TmsButton>
        </div>
      </div>

      <TmsCard title="Last known">
        <div className="text-sm" data-testid="last-known">
        {tracking.lastKnown || load.lastKnownAt ? (
          <p className="mt-0.5">
            <MapPin size={13} className="mr-1 inline tms-muted" />
            {[load.lastKnownCity, load.lastKnownState].filter(Boolean).join(', ')
              || (tracking.lastKnown ? `${tracking.lastKnown.lat.toFixed(3)}, ${tracking.lastKnown.lng.toFixed(3)}` : 'position unknown')}
            <span className="tms-muted">
              {' · '}{ago(tracking.lastKnown?.at ?? load.lastKnownAt ?? new Date().toISOString(), now)}
              {' · '}{(tracking.lastKnown?.source ?? load.lastKnownSource ?? 'MANUAL').replace(/_/g, ' ').toLowerCase()}
            </span>
          </p>
        ) : (
          <p className="mt-0.5 tms-muted">Nobody has reported a position on this load yet.</p>
        )}
        {loadCarrier?.deliveryEtaAt && (
          <p className="mt-1" data-testid="delivery-eta">
            <Clock size={13} className="mr-1 inline tms-muted" />
            ETA to delivery {formatDateTime(loadCarrier.deliveryEtaAt)}
          </p>
        )}
        </div>
      </TmsCard>

      <div className={`space-y-2 rounded-[var(--tms-radius)] border p-3 text-sm ${tone}`} data-testid="check-call-banner">
        <div className="flex flex-wrap items-center gap-2">
          <Clock size={14} />
          <span className="font-medium">
            {state === 'NONE' && 'No check call scheduled'}
            {state === 'SCHEDULED' && `Next check call ${formatDateTime(load.nextCheckCallAt)}`}
            {state === 'DUE' && `Check call due — ${formatDateTime(load.nextCheckCallAt)}`}
            {state === 'OVERDUE' && `Check call overdue since ${formatDateTime(load.nextCheckCallAt)}`}
          </span>
          {load.nextCheckCallNote && <span className="tms-muted">· {load.nextCheckCallNote}</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            <TmsButton size="sm" className="h-7"
              onClick={() => setReminderDraft(formatDateTimeInput(load.nextCheckCallAt ?? new Date().toISOString()))}
            >
              Edit reminder
            </TmsButton>
            <TmsButton size="sm" className="h-7"
              onClick={() => saveReminder(new Date(now + HOUR_MS).toISOString())}
              disabled={actions.busy}
            >
              Snooze 1 h
            </TmsButton>
            <TmsButton variant="ghost" size="sm" className="h-7" onClick={() => saveReminder(null)} disabled={actions.busy}>
              No reminder
            </TmsButton>
          </div>
        </div>
        {reminderDraft != null && (
          <div className="flex flex-wrap items-center gap-2">
            <TmsInput
              aria-label="Reminder time"
              type="datetime-local"
              value={reminderDraft}
              onChange={(e) => setReminderDraft(e.target.value)}
              className="h-9 w-56 text-sm"
            />
            <TmsButton variant="primary" size="sm" className="h-9" disabled={actions.busy} onClick={() => saveReminder(reminderDraft ? fromDateTimeInput(reminderDraft) : null)}>
              Save
            </TmsButton>
            <TmsButton variant="ghost" size="sm" className="h-9" onClick={() => setReminderDraft(null)}>Cancel</TmsButton>
          </div>
        )}
      </div>

      {loadCarrier && (
        <div className="rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-3">
          <p className="text-xs uppercase tracking-wider tms-muted">ETAs</p>
          <div className="mt-1 flex flex-wrap items-end gap-3">
            <div>
              <Label className="tms-field-label">Pickup</Label>
              <TmsInput
                aria-label="Pickup ETA"
                type="datetime-local"
                value={pickupEta ?? (loadCarrier.pickupEtaAt ? formatDateTimeInput(loadCarrier.pickupEtaAt) : '')}
                onChange={(e) => setPickupEta(e.target.value)}
                className="h-9 w-56 text-sm"
              />
            </div>
            <div>
              <Label className="tms-field-label">Delivery</Label>
              <TmsInput
                aria-label="Delivery ETA"
                type="datetime-local"
                value={deliveryEta ?? (loadCarrier.deliveryEtaAt ? formatDateTimeInput(loadCarrier.deliveryEtaAt) : '')}
                onChange={(e) => setDeliveryEta(e.target.value)}
                className="h-9 w-56 text-sm"
              />
            </div>
            <TmsButton variant="primary"
              size="sm" className="h-9"
              disabled={actions.busy || (pickupEta == null && deliveryEta == null)}
              onClick={() => {
                void actions.tracking.setEta({
                  pickupEtaAt: pickupEta != null ? (pickupEta ? fromDateTimeInput(pickupEta) : null) : undefined,
                  deliveryEtaAt: deliveryEta != null ? (deliveryEta ? fromDateTimeInput(deliveryEta) : null) : undefined,
                }).then(() => { setPickupEta(null); setDeliveryEta(null) }).catch(() => { /* reported */ })
              }}
            >
              Save ETAs
            </TmsButton>
          </div>
        </div>
      )}

      {/* The same pane the tracking desk mounts: header, map, computed ETA, cadence
          and thread. It reads the load, so the tab and the page never drift. */}
      <TrackingDetailPanel
        row={shipment}
        bundle={bundle}
        messages={messages}
        loading={false}
        customers={customer ? [customer] : []}
        settings={settings}
        userName={auth?.user?.email ?? null}
        mapsKey={MAPS_KEY}
        mapsMapId={MAPS_MAP_ID}
        onSendMessage={async (input) => {
          await sendShipmentMessage({ shipmentId: shipment.id, ...input })
        }}
        onSavePlan={async (loadId, plan, expectedUpdatedAt) => {
          await saveLoadCheckCallPlan({ loadId, plan, expectedUpdatedAt })
        }}
        onRefresh={async () => {
          await Promise.all([reloadMessages(), actions.reload()])
        }}
      />

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider tms-muted">Timeline</p>
        {tracking.error && <p className="text-sm text-[color:var(--tms-badge-red)]">{tracking.error}</p>}
        {tracking.timeline.length === 0 && !tracking.loading && (
          <p className="text-sm tms-muted">Nothing has been logged on this load yet.</p>
        )}
        <ul className="space-y-2" data-testid="tracking-timeline">
          {tracking.timeline.map((item) => (
            <TimelineRow
              key={timelineKey(item)}
              item={item}
              busy={actions.busy}
              onResolve={(checkCallId) => {
                void actions.tracking.resolveIncident(checkCallId).then(() => tracking.refresh()).catch(() => { /* reported */ })
              }}
            />
          ))}
        </ul>
      </div>

      {dialog?.kind === 'check_call' && (
        <LogCheckCallDialog
          load={load}
          loadCarrier={loadCarrier}
          catalog={catalog}
          busy={actions.busy}
          onClose={() => { setDialog(null); void tracking.refresh() }}
          onSubmit={async (values: CheckCallFormValues) => { await actions.tracking.logCheckCall(values) }}
          onTextDriver={async (bodyText) => {
            if (!loadCarrier) return
            await textDriver({ loadCarrierId: loadCarrier.id, body: bodyText })
          }}
        />
      )}
      {dialog?.kind === 'carrier_link' && loadCarrier && (
        <TrackingLinkDialog
          loadCarrier={loadCarrier}
          loadNumber={load.loadNumber ?? load.aljexId ?? ''}
          link={carrierLink}
          settings={settings}
          brokerName={brokerName}
          onClose={() => { setDialog(null); void tracking.refresh() }}
          onChanged={() => { void actions.reload(); void tracking.refresh() }}
        />
      )}
      {dialog?.kind === 'customer_link' && (
        <CustomerLinkDialog
          shipment={shipment}
          customer={customer}
          link={customerLink}
          settings={settings}
          onClose={() => { setDialog(null); void tracking.refresh() }}
          onChanged={() => { void actions.reload(); void tracking.refresh() }}
        />
      )}

    </div>
  )
}

/** Stable per source: two rows can share an instant, never an identity. */
function timelineKey(item: TimelineItem): string {
  if (item.kind === 'check_call') return `cc-${item.row.id}`
  if (item.kind === 'link') return `link-${item.row.id}`
  return `pos-${item.truckId}-${item.locatedAt}`
}

/**
 * What a TrackingLink row says on the timeline. `sentAt` is stamped only when
 * something actually left — a COPY link, or a send Twilio/SES refused, has none.
 */
function linkRowLabel(row: TrackingLinkRecord): string {
  const who = row.kind === 'CUSTOMER_VIEW' ? 'customer' : 'driver'
  if (row.sentVia === 'COPY') return `Tracking link created to copy for the ${who}`
  if (!row.sentAt) return `Tracking link created for the ${who} — not sent`
  return `Tracking link ${row.sentVia === 'EMAIL' ? 'emailed' : 'texted'} to the ${who}`
}

function TimelineRow({ item, busy, onResolve }: {
  item: TimelineItem
  busy: boolean
  onResolve: (checkCallId: string) => void
}) {
  if (item.kind === 'position') {
    return (
      <li className="flex items-start gap-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-2 text-sm">
        <Truck size={14} className="mt-0.5 shrink-0 tms-muted" />
        <div className="min-w-0">
          <p>{item.description ?? `${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}`}</p>
          <p className="text-xs tms-muted">
            {formatDateTime(item.at)} · Motive{item.speed != null ? ` · ${Math.round(item.speed)} mph` : ''}
          </p>
        </div>
      </li>
    )
  }

  if (item.kind === 'link') {
    return (
      <li className="flex items-start gap-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-2 text-sm">
        <Link2 size={14} className="mt-0.5 shrink-0 tms-muted" />
        <div className="min-w-0">
          {/* Never assert a send that did not happen: on dev Twilio is unconfigured
              and SES is denied, so a COPY link is created, not sent. */}
          <p>{linkRowLabel(item.row)}</p>
          <p className="text-xs tms-muted">
            {formatDateTime(item.at)}{item.row.sentTo ? ` · ${item.row.sentTo}` : ''} · {item.row.status.toLowerCase()}
          </p>
        </div>
      </li>
    )
  }

  const row = item.row
  const Icon = SOURCE_ICON[row.source] ?? PhoneCall
  const isOpenIncident = row.incidentOpen === 'OPEN'

  return (
    <li className={`flex items-start gap-2 rounded-[var(--tms-radius)] border p-2 text-sm ${isOpenIncident ? 'border-[color:var(--tms-badge-red)] ' : 'border-[color:var(--tms-border)]'}`}>
      <Icon size={14} className="mt-0.5 shrink-0 tms-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{CHECK_CALL_TYPE_LABELS[row.type]}</span>
          {row.incidentType && (
            <TmsBadge tone="gray" className="text-[10px]">{INCIDENT_TYPE_LABELS[row.incidentType]}</TmsBadge>
          )}
          {row.statusAfter && (
            <span className="flex items-center gap-1 text-xs tms-muted">
              {row.statusBefore ? LOAD_WORKFLOW_STATUS_LABELS[row.statusBefore] : '—'}
              {' → '}
              <TmsBadge tone="gray" className="text-[10px]">{LOAD_WORKFLOW_STATUS_LABELS[row.statusAfter]}</TmsBadge>
            </span>
          )}
        </div>
        {row.note && <p className="whitespace-pre-wrap break-words">{row.note}</p>}
        <p className="text-xs tms-muted">
          {formatDateTime(row.at)}
          {[row.city, row.state].filter(Boolean).length > 0 ? ` · ${[row.city, row.state].filter(Boolean).join(', ')}` : ''}
          {row.personName ? ` · ${row.personName}` : ''}
          {' · '}{row.source.replace(/_/g, ' ').toLowerCase()}
          {' · '}{row.createdBy}
        </p>
        {row.resolvedAt && (
          <p className="flex items-center gap-1 text-xs tms-muted">
            <Check size={12} />Resolved {formatDateTime(row.resolvedAt)}{row.resolvedBy ? ` by ${row.resolvedBy}` : ''}
            {row.resolutionNote ? ` — ${row.resolutionNote}` : ''}
          </p>
        )}
      </div>
      {isOpenIncident && (
        <TmsButton size="sm" className="h-7 shrink-0" disabled={busy} onClick={() => onResolve(row.id)}>
          <AlertTriangle size={13} className="mr-1" />Resolve
        </TmsButton>
      )}
    </li>
  )
}
