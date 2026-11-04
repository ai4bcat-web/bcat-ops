/**
 * The map between the summary strip and the SMS / e-mail panes: a 28 px header that is
 * always there and a ~232 px body that collapses (and remembers it did). The header carries
 * the current position text, its age and source, the ETA (the strip's own — one ETA, never a
 * second computation), the miles still to go and the provider badge.
 *
 * The panel adds no timer: it reads `tracking`, which polls every 60 s. The route comes from
 * the server once per load (cached there per lane); the Google chunk loads only while open.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LocateFixed } from 'lucide-react'
import { TmsBadge } from '@/features/tms/kit'
import { getLoadRoute, type LoadRoute } from '@/lib/apiClient'
import { sourceLabel, remainingMiles } from '@/lib/trackingPings'
import type { LoadTracking } from '@/hooks/useLoadTracking'
import type { ShipmentBundle, TrackingLinkRecord } from '@/types/tms'
import { etaText, type TrackingSummary } from '../trackingSummary'
import { ProviderMenu } from './ProviderMenu'
import { RouteMapView } from './RouteMapView'
import { ageLabel, buildMapModel, pinsOfStops, providerLabel } from './mapModel'

export const MAP_COLLAPSED_KEY = 'tms.tracking.map.collapsed'

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(MAP_COLLAPSED_KEY) === '1' } catch { return false }
}

export function TrackingMapPanel({ bundle, tracking, summary, links, onProviderChanged }: {
  bundle: ShipmentBundle
  tracking: LoadTracking
  summary: TrackingSummary
  links: TrackingLinkRecord[]
  onProviderChanged: () => void
}) {
  const load = bundle.loads[0] ?? null
  const leg = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [recenter, setRecenter] = useState(0)
  const [fetched, setFetched] = useState<{ key: string; route: LoadRoute | null } | null>(null)

  const stopPins = useMemo(() => pinsOfStops(load?.stops), [load?.stops])
  // The route is re-asked for when the booked stops move, not on every render.
  const routeKey = `${load?.id ?? ''}|${stopPins.map((p) => `${p.lat},${p.lng}`).join(';')}`
  const loadId = load?.id ?? null

  useEffect(() => {
    if (collapsed || !loadId) return
    let live = true
    getLoadRoute(loadId)
      .then((route) => { if (live) setFetched({ key: routeKey, route }) })
      .catch(() => { if (live) setFetched({ key: routeKey, route: null }) })
    return () => { live = false }
  }, [collapsed, loadId, routeKey])

  const route = fetched?.key === routeKey ? fetched.route : null
  const pins = stopPins.length > 0
    ? stopPins
    : (route?.waypoints ?? []).map((w) => ({ type: w.type, lat: w.lat, lng: w.lng, name: w.name }))

  const model = useMemo(() => buildMapModel({
    mode: 'staff', pins, fixes: tracking.fixes, current: tracking.current,
    route: route?.encoded ?? null, routeSource: route?.source ?? 'NONE', routeReason: route?.reason ?? null, nowMs: tracking.nowMs,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pins` is derived from stopPins/route, both listed
  }), [stopPins, route, tracking.fixes, tracking.current, tracking.nowMs])

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try { window.localStorage.setItem(MAP_COLLAPSED_KEY, next ? '1' : '0') } catch { /* private mode: it just will not be remembered */ }
  }

  const current = tracking.current
  const togo = current && model.path.length > 1 ? remainingMiles(model.path, current.fix) : null
  const providerLink = links.find((l) => l.kind === 'PROVIDER_TRACK' && l.status === 'ACTIVE') ?? null
  const place = current ? current.fix.place ?? `${current.fix.lat.toFixed(3)}, ${current.fix.lng.toFixed(3)}` : null

  return (
    <section className="tms-map-panel" data-testid="tracking-map-panel" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="tms-map-head">
        <button type="button" className="tms-icon-btn" aria-label={collapsed ? 'Show map' : 'Hide map'} aria-expanded={!collapsed}
          data-testid="tracking-map-toggle" onClick={toggle}>
          {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </button>
        <strong>Map</strong>
        <span className="tms-map-head-text" data-testid="tracking-map-current" data-tone={current?.tone ?? 'none'}>
          {current ? (
            <>
              <span className={`tms-map-tone tms-map-tone-${current.tone}`} aria-hidden />
              {[place, ageLabel(current.ageMinutes), sourceLabel(current.fix.source)].join(' · ')}
              {current.tone === 'stale' ? <span className="tms-muted"> · stale</span> : null}
            </>
          ) : <span className="tms-muted">No position yet</span>}
        </span>
        {current?.overlay ? <TmsBadge tone="orange" data-testid="tracking-map-approx">approx.</TmsBadge> : null}
        {summary.eta ? <span className="tms-map-chip" data-testid="tracking-map-eta">ETA {etaText(summary.eta)}</span> : null}
        {togo != null ? <span className="tms-map-chip" data-testid="tracking-map-togo">~{Math.round(togo).toLocaleString('en-US')} mi to go</span> : null}
        {providerLink ? <TmsBadge tone="gray" data-testid="tracking-map-provider">{providerLabel(providerLink.provider)} · STUB</TmsBadge> : null}
        <span className="tms-map-head-end">
          {!collapsed && model.bounds ? (
            <button type="button" className="tms-icon-btn" aria-label="Recenter map" title="Recenter" data-testid="tracking-map-recenter"
              onClick={() => setRecenter((n) => n + 1)}>
              <LocateFixed size={14} aria-hidden />
            </button>
          ) : null}
          <ProviderMenu leg={leg} active={providerLink} onChanged={onProviderChanged} />
        </span>
      </div>
      {!collapsed && (
        <div className="tms-map-body">
          {model.empty ? (
            <p className="tms-map-empty tms-muted" data-testid="tracking-map-empty">{model.empty}</p>
          ) : (
            <RouteMapView model={model} fitKey={load?.id ?? ''} recenter={recenter} />
          )}
        </div>
      )}
    </section>
  )
}
