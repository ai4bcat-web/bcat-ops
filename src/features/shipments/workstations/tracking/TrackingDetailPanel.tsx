import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Mail, MessageSquare, Phone, Play, FileImage } from 'lucide-react'
import { APIProvider, useApiIsLoaded } from '@vis.gl/react-google-maps'
import { toast } from 'sonner'
import { TmsButton, TmsCard, TmsEmptyState, TmsField, TmsInput } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { trackingEtaEstimate, trackingEtaFromMatrix } from '@/lib/trackingEta'
import type { ComputedTrackingEta, EtaToStopInput, EtaToStopStop } from '@/lib/trackingEta'
import { runCheckCallPlan, requestPod, saveLoadCheckCallPlan } from '@/lib/apiClient'
import {
  CHECK_CALL_CHANNELS, CHECK_CALL_MILESTONES, CHANNEL_DISABLED_REASON, MILESTONE_LABELS,
  isChannelEnabled,
} from '@/lib/checkCallPlan'
import type { CheckCallChannel, CheckCallMilestone, CheckCallPlan } from '@/lib/checkCallPlan'
import type { Stop } from '@/types'
import type { CustomerRecord, ShipmentBundle, ShipmentMessageRecord, TmsSettings } from '@/types/tms'
import type { ShipmentRow } from '@/features/shipments/shipmentViews'
import { TrackingDetailMap, googleMapsExtras } from './TrackingDetailMap'
import { TrackingConversation } from './TrackingConversation'
import { resolveCheckCallPlanWithSource } from './checkCallPlanSource'

const CHANNEL_ICONS: Record<CheckCallChannel, typeof Mail> = { EMAIL: Mail, SMS: MessageSquare, VOICE: Phone }

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
  onSendMessage: (input: { channel: 'EMAIL' | 'SMS'; to: string | null; subject: string | null; body: string }) => Promise<void>
  onSavePlan: (loadId: string, plan: CheckCallPlan, expectedUpdatedAt?: string) => Promise<void>
  onRefresh: () => void | Promise<void>
}

export function TrackingDetailPanel(props: TrackingDetailPanelProps) {
  // A keyed session discards drafts, pending Google answers and operation state
  // together when the shipment changes; old async completions cannot edit the new one.
  return <DetailSession key={props.row.id} {...props} />
}

function DetailSession({ row, bundle, messages, loading, customers, settings, userName, mapsKey, mapsMapId, onSendMessage, onSavePlan, onRefresh }: TrackingDetailPanelProps) {
  const load = bundle?.shipment.id === row.id ? bundle.loads[0] ?? null : null
  const carrier = bundle?.loadCarriers.find((c) => c.loadId === load?.id && c.status === 'ACTIVE') ?? null
  const customer = customers.find((c) => c.id === row.customerId) ?? null
  const resolved = useMemo(() => resolveCheckCallPlanWithSource(load, customer, settings), [load, customer, settings])
  const [plan, setPlan] = useState(resolved.plan)
  const [previousPlan, setPreviousPlan] = useState(resolved.plan)
  if (previousPlan !== resolved.plan) {
    setPreviousPlan(resolved.plan)
    setPlan(resolved.plan)
  }
  const [busy, setBusy] = useState(false)
  const [runResult, setRunResult] = useState<{ action: string; reason: string } | null>(null)

  const lastKnown = useMemo(() => {
    if (load?.lastKnownLat == null || load.lastKnownLng == null) return null
    return { lat: load.lastKnownLat, lng: load.lastKnownLng }
  }, [load?.lastKnownLat, load?.lastKnownLng])
  const deliveryStop = useMemo(() => {
    let final: Stop | null = null
    for (const stop of load?.stops ?? []) {
      if (stop.type === 'delivery' && !stop.arrivedAt && (!final || stop.sequence > final.sequence)) final = stop
    }
    return final
  }, [load?.stops])
  const destination = useMemo(() => {
    if (deliveryStop?.address?.lat == null || deliveryStop.address.lng == null) return null
    return {
      lat: deliveryStop.address.lat, lng: deliveryStop.address.lng,
      appt: deliveryStop.apptType === 'tbd' || deliveryStop.apptType === 'fcfs'
        ? null : deliveryStop.apptEnd || deliveryStop.appt || null,
    }
  }, [deliveryStop])
  const pingAt = load?.lastKnownAt ?? null
  const now = useMemo(() => new Date().toISOString(), [pingAt])
  const estimate = useMemo(() => {
    if (!lastKnown || !destination || !pingAt) return null
    try { return trackingEtaEstimate(lastKnown, destination, pingAt, now) } catch { return null }
  }, [lastKnown, destination, pingAt, now])

  const perform = async (action: 'save' | 'clear' | 'run' | 'pod') => {
    if (!load || busy) return
    setBusy(true)
    try {
      if (action === 'save') await onSavePlan(load.id, plan, load.updatedAt ?? undefined)
      if (action === 'clear') await saveLoadCheckCallPlan({ loadId: load.id, plan: null, expectedUpdatedAt: load.updatedAt ?? undefined })
      if (action === 'run') {
        const result = await runCheckCallPlan({ shipmentId: row.id })
        setRunResult({ action: result.action, reason: result.reason })
      }
      if (action === 'pod') await requestPod({ shipmentId: row.id })
      toast.success(action === 'pod' ? 'POD requested' : action === 'run' ? 'Check-call plan run' : 'Check-call plan saved')
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Tracking action failed')
    } finally { setBusy(false) }
  }

  const toggleChannel = (channel: CheckCallChannel) => {
    if (!isChannelEnabled(channel)) return
    setPlan((p) => ({ ...p, channels: p.channels.includes(channel) ? p.channels.filter((c) => c !== channel) : [...p.channels, channel] }))
  }
  const toggleMilestone = (milestone: CheckCallMilestone) => {
    setPlan((p) => ({ ...p, milestones: p.milestones.includes(milestone) ? p.milestones.filter((m) => m !== milestone) : [...p.milestones, milestone] }))
  }
  const map = <TrackingDetailMap apiKey={mapsKey} mapId={mapsMapId} lastKnown={lastKnown} delivery={destination} deliveryName={deliveryStop?.name ?? row.destinationCity} />
  const reason = !lastKnown || !pingAt ? 'No timestamped position reported yet.' : !destination ? 'No pending delivery with coordinates.' : 'Position or timestamp is invalid.'

  return (
    <div className="tms-tracking-detail" data-testid="tracking-detail" data-shipment-id={row.id}>
      {loading ? <p className="tms-tracking-detail-empty">Loading shipment details…</p> : !load ? (
        <TmsEmptyState title="No load" message="This shipment has no load to track yet." />
      ) : <>
        <header className="rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-3" data-testid="tracking-detail-header">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="m-0 text-base font-semibold">PRO {row.number}</h2>
            <span className="tms-muted text-sm">{customer?.name ?? row.customerName ?? '—'}</span>
          </div>
          <dl className="m-0 mt-2 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="tms-muted text-xs">Carrier</dt><dd className="m-0">{carrier?.kind === 'OWN_ASSET' ? 'Own fleet' : carrier?.carrierName ?? 'No carrier assigned'}</dd></div>
            <div><dt className="tms-muted text-xs">Driver</dt><dd className="m-0">{carrier?.driverName ?? '—'} {carrier?.driverPhone && <a href={`tel:${carrier.driverPhone}`}>{carrier.driverPhone}</a>}</dd></div>
            <div><dt className="tms-muted text-xs">Dispatcher</dt><dd className="m-0">{carrier?.dispatcherName ?? '—'} {carrier?.dispatcherPhone && <a href={`tel:${carrier.dispatcherPhone}`}>{carrier.dispatcherPhone}</a>}</dd></div>
          </dl>
        </header>
        {row.trackingFlaggedAt && <div className="tms-thread-flag" role="alert" data-testid="detail-flag">
          <AlertTriangle size={16} aria-hidden /><div><strong>Tracking flagged</strong><p>{row.trackingFlagReason}</p><p className="tms-muted">{formatDateTime(row.trackingFlaggedAt)}</p></div>
        </div>}
        <TmsCard title="Map & ETA" flush>
          {mapsKey ? <APIProvider apiKey={mapsKey}>
            {map}
            <GoogleEta key={`${pingAt}/${destination?.lat}/${destination?.lng}/${destination?.appt}`} from={lastKnown} stop={destination} pingAt={pingAt} now={now} estimate={estimate} reason={reason} />
          </APIProvider> : <>{map}<EtaView eta={estimate} pingAt={pingAt} appt={destination?.appt} reason={reason} /></>}
        </TmsCard>
        <div data-testid="tracking-cadence">
          <TmsCard title="Check-call plan">
            <div className="tms-checkcall-editor">
              <p className="tms-tracking-detail-source" data-testid="plan-source">
                {resolved.source === 'load' ? 'Overridden for this shipment' : resolved.source === 'customer' ? `Inherited from ${resolved.sourceName ?? 'customer'}` : `Inherited from ${resolved.sourceName ?? 'BCAT'} default`}
              </p>
              <TmsField label="Interval (hours)"><TmsInput type="number" min={1} max={24} value={String(plan.intervalHours)} onChange={(e) => setPlan((p) => ({ ...p, intervalHours: Math.max(1, Math.min(24, Number(e.target.value) || 1)) }))} /></TmsField>
              <div><span className="tms-field-label">Channels</span><div className="tms-checkcall-channels">
                {CHECK_CALL_CHANNELS.map((c) => {
                  const enabled = isChannelEnabled(c)
                  const Icon = CHANNEL_ICONS[c]
                  return <label key={c} className={`tms-checkcall-channel${enabled ? '' : ' tms-checkcall-channel-disabled'}`} title={CHANNEL_DISABLED_REASON[c] ?? ''}>
                    <input type="checkbox" checked={plan.channels.includes(c)} disabled={!enabled} onChange={() => toggleChannel(c)} /><Icon size={14} aria-hidden /><span>{c}</span>
                    {!enabled && <span className="tms-checkcall-channel-reason">{CHANNEL_DISABLED_REASON[c]}</span>}
                  </label>
                })}
              </div></div>
              <div><span className="tms-field-label">Milestones</span><div className="tms-checkcall-channels">
                {CHECK_CALL_MILESTONES.map((m) => <label key={m} className="tms-checkcall-channel"><input type="checkbox" checked={plan.milestones.includes(m)} onChange={() => toggleMilestone(m)} /><span>{MILESTONE_LABELS[m]}</span></label>)}
              </div></div>
              <TmsField label="Escalate after (minutes)"><TmsInput type="number" min={5} max={1440} value={String(plan.escalateAfterMinutes)} onChange={(e) => setPlan((p) => ({ ...p, escalateAfterMinutes: Math.max(5, Math.min(1440, Number(e.target.value) || 5)) }))} /></TmsField>
              <div className="tms-checkcall-actions">
                <TmsButton size="sm" disabled={busy} onClick={() => void perform('save')}>Save plan</TmsButton>
                {resolved.source === 'load' && <TmsButton size="sm" disabled={busy} onClick={() => void perform('clear')}>Clear override</TmsButton>}
                <TmsButton size="sm" disabled={busy} onClick={() => void perform('run')}><Play size={14} aria-hidden /> Run check call now</TmsButton>
                <TmsButton size="sm" disabled={busy} onClick={() => void perform('pod')}><FileImage size={14} aria-hidden /> Request POD</TmsButton>
              </div>
              {runResult && <div className="tms-checkcall-result" data-testid="run-result"><strong>{runResult.action}</strong> — {runResult.reason}</div>}
            </div>
          </TmsCard>
        </div>
        <TmsCard title={`Thread — ${row.number}`}>
          <TrackingConversation conversationKey={row.id} messages={messages} userName={userName}
            driver={{ name: carrier?.driverName, phone: carrier?.driverPhone }}
            dispatcher={{ name: carrier?.dispatcherName, phone: carrier?.dispatcherPhone, email: carrier?.dispatcherEmail }}
            onSendMessage={onSendMessage} onRefresh={onRefresh} />
        </TmsCard>
      </>}
    </div>
  )
}

function GoogleEta({ from, stop, pingAt, now, estimate, reason }: {
  from: EtaToStopInput | null; stop: EtaToStopStop | null; pingAt: string | null; now: string; estimate: ComputedTrackingEta | null; reason: string
}) {
  const loaded = useApiIsLoaded()
  const [routed, setRouted] = useState<{ key: string; eta: ComputedTrackingEta } | null>(null)
  const key = `${from?.lat}/${from?.lng}/${stop?.lat}/${stop?.lng}/${stop?.appt}/${pingAt}`
  useEffect(() => {
    if (!loaded || !from || !stop || !pingAt) return
    const Service = googleMapsExtras()?.DistanceMatrixService
    if (!Service) return
    let live = true
    try {
      new Service().getDistanceMatrix({ origins: [from], destinations: [stop], travelMode: 'DRIVING' }, (response, status) => {
        const leg = response?.rows[0]?.elements[0]
        if (!live || status !== 'OK' || leg?.status !== 'OK' || !leg.distance || !leg.duration) return
        try {
          setRouted({ key, eta: trackingEtaFromMatrix(stop, pingAt, now, { distanceMeters: leg.distance.value, durationSeconds: leg.duration.value }) })
        } catch { /* Invalid provider answer leaves the labelled estimate visible. */ }
      })
    } catch { /* Disabled/referrer-restricted API leaves the labelled estimate visible. */ }
    return () => { live = false }
  }, [loaded, from, stop, pingAt, now, key])
  return <EtaView eta={routed?.key === key ? routed.eta : estimate} pingAt={pingAt} appt={stop?.appt} reason={reason} />
}

function EtaView({ eta, pingAt, appt, reason }: { eta: ComputedTrackingEta | null; pingAt: string | null; appt?: string | null; reason: string }) {
  return <section data-testid="tracking-eta" className="p-3 text-sm" aria-label="Delivery ETA">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="tms-muted">Delivery ETA</span><strong>{eta ? formatDateTime(eta.etaAt) : 'Unavailable'}</strong></div>
    <p className="tms-muted mt-1 text-xs">{eta?.basisLabel ?? reason}</p>
    {eta && <p className="mt-1 text-xs">{Math.round(eta.miles)} mi · {Math.round(eta.driveMinutes)} min driving · Ping {formatDateTime(pingAt)}</p>}
    {appt && <p className="mt-1 text-xs">Appointment {formatDateTime(appt)}{eta ? eta.lateBy != null ? ` · ${eta.lateBy} min late` : ' · On time' : ''}</p>}
    {eta && <p className="tms-muted mt-1 text-xs">Driving estimate only; excludes breaks and intermediate stops.</p>}
  </section>
}
