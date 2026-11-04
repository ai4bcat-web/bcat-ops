/**
 * The Tracking tab of a shipment. The tracking view (strip, SMS and e-mail panes, recent
 * check calls) is the same component the Tracking drawer mounts; below it the page keeps
 * the ETA editor, the shared detail pane (map, computed ETA, cadence) and the full timeline.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Link2, PhoneCall, Smartphone, Truck, Users } from 'lucide-react'
import { TmsBadge, TmsButton, TmsCard, TmsInput, TmsTimeline, type TmsTimelineItem } from '@/features/tms/kit'
import { Label } from '@/components/ui/label'
import { getTmsSettings, saveLoadCheckCallPlan } from '@/lib/apiClient'
import { CHECK_CALL_TYPE_LABELS, INCIDENT_TYPE_LABELS } from '@/lib/checkCalls'
import { LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { formatDateTime, formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { useLoadTracking } from '@/hooks/useLoadTracking'
import type { TimelineItem } from '@/lib/trackingTimeline'
import type {
  ChargeCodeDef, CheckCallSource, CustomerRecord, ShipmentBundle, TmsSettings, TrackingLinkRecord,
} from '@/types/tms'
import { TrackingDetailPanel } from '../workstations/tracking/TrackingDetailPanel'
import { ShipmentTrackingView } from '../workstations/tracking/ShipmentTrackingView'
import { TrackingPrefsPopover } from '../workstations/tracking/TrackingPrefsPopover'
import type { ShipmentActions } from '../useShipmentActions'

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

const SOURCE_ICON: Record<CheckCallSource, typeof PhoneCall> = {
  MANUAL: PhoneCall,
  DRIVER_APP: Smartphone,
  LINK: Link2,
  SYSTEM: Users,
}

export function TrackingSection({ bundle, customer, catalog, actions }: {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  catalog: ChargeCodeDef[]
  actions: ShipmentActions
}) {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [pickupEta, setPickupEta] = useState<string | null>(null)
  const [deliveryEta, setDeliveryEta] = useState<string | null>(null)

  const shipment = bundle.shipment
  const load = bundle.loads[0]
  const loadCarrier = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    getTmsSettings().catch(() => null).then((s) => { if (live) setSettings(s) })
    return () => { live = false }
  }, [])

  const tracking = useLoadTracking({
    loadId: load?.id,
    shipmentId: shipment.id,
    truckId: loadCarrier?.truckId ?? null,
    load: { pickupAppt: load?.pickupAppt, deliveredAt: load?.deliveredAt },
    loadCarrier: { dispatchedAt: loadCarrier?.dispatchedAt },
  })

  if (!load) {
    return <p className="text-sm tms-muted">This shipment has no load to track yet.</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <TmsBadge tone="gray" className="text-[10px]" data-testid="tracking-provider">
          {(load.trackingProvider ?? 'NONE').replace(/_/g, ' ')}
        </TmsBadge>
        {(load.openIncidentCount ?? 0) > 0 && (
          <TmsBadge tone="gray" className="border-[color:var(--tms-badge-red)] text-[10px] text-[color:var(--tms-badge-red)]">
            {load.openIncidentCount} open exception{load.openIncidentCount === 1 ? '' : 's'}
          </TmsBadge>
        )}
        <div className="ml-auto">
          <TrackingPrefsPopover shipment={shipment} customer={customer} onSaved={() => actions.reload()} />
        </div>
      </div>

      <ShipmentTrackingView bundle={bundle} customer={customer} catalog={catalog} actions={actions} />

      {loadCarrier && (
        <TmsCard title="ETAs">
          <div className="flex flex-wrap items-end gap-3">
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
        </TmsCard>
      )}

      {/* The same pane the tracking desk mounts: header, map, computed ETA and cadence. */}
      <TrackingDetailPanel
        row={shipment}
        bundle={bundle}
        loading={false}
        customers={customer ? [customer] : []}
        settings={settings}
        mapsKey={MAPS_KEY}
        mapsMapId={MAPS_MAP_ID}
        onSavePlan={async (loadId, plan, expectedUpdatedAt) => {
          await saveLoadCheckCallPlan({ loadId, plan, expectedUpdatedAt })
        }}
        onRefresh={async () => { await actions.reload() }}
      />

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider tms-muted">Timeline</p>
        {tracking.error && <p className="text-sm text-[color:var(--tms-badge-red)]">{tracking.error}</p>}
        {tracking.timeline.length === 0 && !tracking.loading && (
          <p className="text-sm tms-muted">Nothing has been logged on this load yet.</p>
        )}
        <TmsTimeline
          data-testid="tracking-timeline"
          ariaLabel="Tracking events"
          items={tracking.timeline.map((item) => timelineEntry(item, actions.busy, (checkCallId) => {
            void actions.tracking.resolveIncident(checkCallId).then(() => tracking.refresh()).catch(() => { /* reported */ })
          }))}
        />
      </div>
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

function timelineEntry(item: TimelineItem, busy: boolean, onResolve: (checkCallId: string) => void): TmsTimelineItem {
  if (item.kind === 'position') {
    return {
      id: timelineKey(item),
      tone: 'gray',
      title: <><Truck size={13} className="tms-timeline-icon" aria-hidden />{item.description ?? `${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}`}</>,
      at: formatDateTime(item.at),
      description: `Motive${item.speed != null ? ` · ${Math.round(item.speed)} mph` : ''}`,
    }
  }

  if (item.kind === 'link') {
    // Never assert a send that did not happen: on dev Twilio is unconfigured
    // and SES is denied, so a COPY link is created, not sent.
    return {
      id: timelineKey(item),
      tone: 'blue',
      title: <><Link2 size={13} className="tms-timeline-icon" aria-hidden />{linkRowLabel(item.row)}</>,
      at: formatDateTime(item.at),
      description: `${item.row.sentTo ? `${item.row.sentTo} · ` : ''}${item.row.status.toLowerCase()}`,
    }
  }

  const row = item.row
  const Icon = SOURCE_ICON[row.source] ?? PhoneCall
  const isOpenIncident = row.incidentOpen === 'OPEN'
  const where = [row.city, row.state].filter(Boolean).join(', ')

  return {
    id: timelineKey(item),
    tone: isOpenIncident ? 'red' : 'green',
    title: <><Icon size={13} className="tms-timeline-icon" aria-hidden />{CHECK_CALL_TYPE_LABELS[row.type]}</>,
    tag: (
      <>
        {row.incidentType && <TmsBadge tone="gray">{INCIDENT_TYPE_LABELS[row.incidentType]}</TmsBadge>}
        {row.statusAfter && (
          <span className="tms-timeline-status-move">
            {row.statusBefore ? LOAD_WORKFLOW_STATUS_LABELS[row.statusBefore] : '—'}
            {' → '}
            <TmsBadge tone="gray">{LOAD_WORKFLOW_STATUS_LABELS[row.statusAfter]}</TmsBadge>
          </span>
        )}
      </>
    ),
    at: formatDateTime(row.at),
    description: (
      <>
        {row.note && <p className="whitespace-pre-wrap break-words">{row.note}</p>}
        <p>
          {[where, row.personName, row.source.replace(/_/g, ' ').toLowerCase(), row.createdBy].filter(Boolean).join(' · ')}
        </p>
        {row.resolvedAt && (
          <p className="flex items-center gap-1">
            <Check size={12} />Resolved {formatDateTime(row.resolvedAt)}{row.resolvedBy ? ` by ${row.resolvedBy}` : ''}
            {row.resolutionNote ? ` — ${row.resolutionNote}` : ''}
          </p>
        )}
        {isOpenIncident && (
          <TmsButton size="sm" className="h-7" disabled={busy} onClick={() => onResolve(row.id)}>
            <AlertTriangle size={13} className="mr-1" />Resolve
          </TmsButton>
        )}
      </>
    ),
  }
}
