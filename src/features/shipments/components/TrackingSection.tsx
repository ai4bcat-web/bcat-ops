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
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Check, Clock, Cog, Link2, MapPin, PhoneCall, Send, Smartphone, Truck, Users,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FleetMiniMap } from '@/features/dashboard/FleetMiniMap'
import { getTmsSettings, listDivisions, textDriver, type TruckLocation } from '@/lib/apiClient'
import { checkCallState, CHECK_CALL_TYPE_LABELS, INCIDENT_TYPE_LABELS } from '@/lib/checkCalls'
import { LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { formatDateTime, formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { useLoadTracking } from '@/hooks/useLoadTracking'
import type { TimelineItem } from '@/lib/trackingTimeline'
import type {
  ChargeCodeDef, CheckCallSource, CustomerRecord, ShipmentBundle, TmsSettings,
} from '@/types/tms'
import { CustomerLinkDialog } from './CustomerLinkDialog'
import { LogCheckCallDialog, type CheckCallFormValues } from './LogCheckCallDialog'
import { TrackingLinkDialog } from './TrackingLinkDialog'
import type { ShipmentActions } from '../useShipmentActions'

const HOUR_MS = 3_600_000

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

/**
 * A map pin in the shape `FleetMiniMap` reads. The map takes fleet rows, and a tracking
 * pin is not one — it has no odometer, no sync and often no unit number — so the fields
 * it does not have are filled in rather than faked with plausible values.
 */
function pin(id: string, label: string, lat: number, lon: number, at: string): TruckLocation {
  return {
    truckId: id, unitNumber: label, lat, lon,
    bearing: null, speed: null, locatedAt: at, description: null,
    motion: null, motionSince: null, odometer: null,
    source: 'TRACKING', syncedAt: at, createdAt: at, updatedAt: at,
  }
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

  const pins = useMemo(() => {
    const out: TruckLocation[] = []
    const fix = tracking.lastKnown
    if (fix) out.push(pin('last-known', 'Last known', fix.lat, fix.lng, fix.at))
    for (const item of tracking.timeline) {
      if (item.kind === 'check_call' && item.row.type === 'TRACKING_PING' && item.row.lat != null && item.row.lng != null) {
        out.push(pin(`ping-${item.row.id}`, 'Driver ping', item.row.lat, item.row.lng, item.at))
      }
    }
    return out
  }, [tracking.lastKnown, tracking.timeline])

  if (!load) {
    return <p className="text-sm text-muted-foreground">This shipment has no load to track yet.</p>
  }

  const saveReminder = (iso: string | null) => {
    void actions.tracking.setNextCheckCall(iso).then(() => setReminderDraft(null)).catch(() => { /* reported */ })
  }

  const tone = state === 'OVERDUE'
    ? 'border-destructive/40 bg-destructive/5 text-destructive'
    : state === 'DUE'
      ? 'border-amber-500/40 bg-amber-500/5 text-amber-700'
      : 'border-border'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]" data-testid="tracking-provider">
          {(load.trackingProvider ?? 'NONE').replace(/_/g, ' ')}
        </Badge>
        {(load.openIncidentCount ?? 0) > 0 && (
          <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
            {load.openIncidentCount} open exception{load.openIncidentCount === 1 ? '' : 's'}
          </Badge>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDialog({ kind: 'check_call' })} disabled={actions.busy}>
            <PhoneCall size={14} className="mr-1" />Log check call
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'carrier_link' })} disabled={!loadCarrier}>
            <Send size={14} className="mr-1" />Send tracking link
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'customer_link' })}>
            <Users size={14} className="mr-1" />Customer link
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border p-3 text-sm" data-testid="last-known">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Last known</p>
        {tracking.lastKnown || load.lastKnownAt ? (
          <p className="mt-0.5">
            <MapPin size={13} className="mr-1 inline text-muted-foreground" />
            {[load.lastKnownCity, load.lastKnownState].filter(Boolean).join(', ')
              || (tracking.lastKnown ? `${tracking.lastKnown.lat.toFixed(3)}, ${tracking.lastKnown.lng.toFixed(3)}` : 'position unknown')}
            <span className="text-muted-foreground">
              {' · '}{ago(tracking.lastKnown?.at ?? load.lastKnownAt ?? new Date().toISOString(), now)}
              {' · '}{(tracking.lastKnown?.source ?? load.lastKnownSource ?? 'MANUAL').replace(/_/g, ' ').toLowerCase()}
            </span>
          </p>
        ) : (
          <p className="mt-0.5 text-muted-foreground">Nobody has reported a position on this load yet.</p>
        )}
      </div>

      <div className={`space-y-2 rounded-lg border p-3 text-sm ${tone}`} data-testid="check-call-banner">
        <div className="flex flex-wrap items-center gap-2">
          <Clock size={14} />
          <span className="font-medium">
            {state === 'NONE' && 'No check call scheduled'}
            {state === 'SCHEDULED' && `Next check call ${formatDateTime(load.nextCheckCallAt)}`}
            {state === 'DUE' && `Check call due — ${formatDateTime(load.nextCheckCallAt)}`}
            {state === 'OVERDUE' && `Check call overdue since ${formatDateTime(load.nextCheckCallAt)}`}
          </span>
          {load.nextCheckCallNote && <span className="text-muted-foreground">· {load.nextCheckCallNote}</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="outline" size="sm" className="h-7"
              onClick={() => setReminderDraft(formatDateTimeInput(load.nextCheckCallAt ?? new Date().toISOString()))}
            >
              Edit reminder
            </Button>
            <Button
              variant="outline" size="sm" className="h-7"
              onClick={() => saveReminder(new Date(now + HOUR_MS).toISOString())}
              disabled={actions.busy}
            >
              Snooze 1 h
            </Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => saveReminder(null)} disabled={actions.busy}>
              No reminder
            </Button>
          </div>
        </div>
        {reminderDraft != null && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Reminder time"
              type="datetime-local"
              value={reminderDraft}
              onChange={(e) => setReminderDraft(e.target.value)}
              className="h-9 w-56 text-sm"
            />
            <Button size="sm" className="h-9" disabled={actions.busy} onClick={() => saveReminder(reminderDraft ? fromDateTimeInput(reminderDraft) : null)}>
              Save
            </Button>
            <Button variant="ghost" size="sm" className="h-9" onClick={() => setReminderDraft(null)}>Cancel</Button>
          </div>
        )}
      </div>

      {loadCarrier && (
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">ETAs</p>
          <div className="mt-1 flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Pickup</Label>
              <Input
                aria-label="Pickup ETA"
                type="datetime-local"
                value={pickupEta ?? (loadCarrier.pickupEtaAt ? formatDateTimeInput(loadCarrier.pickupEtaAt) : '')}
                onChange={(e) => setPickupEta(e.target.value)}
                className="h-9 w-56 text-sm"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Delivery</Label>
              <Input
                aria-label="Delivery ETA"
                type="datetime-local"
                value={deliveryEta ?? (loadCarrier.deliveryEtaAt ? formatDateTimeInput(loadCarrier.deliveryEtaAt) : '')}
                onChange={(e) => setDeliveryEta(e.target.value)}
                className="h-9 w-56 text-sm"
              />
            </div>
            <Button
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
            </Button>
          </div>
        </div>
      )}

      <FleetMiniMap locations={pins} />

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Timeline</p>
        {tracking.error && <p className="text-sm text-destructive">{tracking.error}</p>}
        {tracking.timeline.length === 0 && !tracking.loading && (
          <p className="text-sm text-muted-foreground">Nothing has been logged on this load yet.</p>
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

function TimelineRow({ item, busy, onResolve }: {
  item: TimelineItem
  busy: boolean
  onResolve: (checkCallId: string) => void
}) {
  if (item.kind === 'position') {
    return (
      <li className="flex items-start gap-2 rounded-lg border border-border p-2 text-sm">
        <Truck size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p>{item.description ?? `${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}`}</p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(item.at)} · Motive{item.speed != null ? ` · ${Math.round(item.speed)} mph` : ''}
          </p>
        </div>
      </li>
    )
  }

  if (item.kind === 'link') {
    return (
      <li className="flex items-start gap-2 rounded-lg border border-border p-2 text-sm">
        <Link2 size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p>Tracking link {item.row.kind === 'CUSTOMER_VIEW' ? 'sent to the customer' : 'sent to the driver'}</p>
          <p className="text-xs text-muted-foreground">
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
    <li className={`flex items-start gap-2 rounded-lg border p-2 text-sm ${isOpenIncident ? 'border-destructive/40 bg-destructive/5' : 'border-border'}`}>
      <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{CHECK_CALL_TYPE_LABELS[row.type]}</span>
          {row.incidentType && (
            <Badge variant="outline" className="text-[10px]">{INCIDENT_TYPE_LABELS[row.incidentType]}</Badge>
          )}
          {row.statusAfter && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {row.statusBefore ? LOAD_WORKFLOW_STATUS_LABELS[row.statusBefore] : '—'}
              {' → '}
              <Badge variant="outline" className="text-[10px]">{LOAD_WORKFLOW_STATUS_LABELS[row.statusAfter]}</Badge>
            </span>
          )}
        </div>
        {row.note && <p className="whitespace-pre-wrap break-words">{row.note}</p>}
        <p className="text-xs text-muted-foreground">
          {formatDateTime(row.at)}
          {[row.city, row.state].filter(Boolean).length > 0 ? ` · ${[row.city, row.state].filter(Boolean).join(', ')}` : ''}
          {row.personName ? ` · ${row.personName}` : ''}
          {' · '}{row.source.replace(/_/g, ' ').toLowerCase()}
          {' · '}{row.createdBy}
        </p>
        {row.resolvedAt && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check size={12} />Resolved {formatDateTime(row.resolvedAt)}{row.resolvedBy ? ` by ${row.resolvedBy}` : ''}
            {row.resolutionNote ? ` — ${row.resolutionNote}` : ''}
          </p>
        )}
      </div>
      {isOpenIncident && (
        <Button variant="outline" size="sm" className="h-7 shrink-0" disabled={busy} onClick={() => onResolve(row.id)}>
          <AlertTriangle size={13} className="mr-1" />Resolve
        </Button>
      )}
    </li>
  )
}
