/**
 * A tracking desk rather than another board: appointments, location evidence and the
 * next human check call stay together. Shared filters narrow the same shipment rows;
 * live-link records verify tracking instead of treating a configured provider as proof.
 * Position history and the messaging agent are not invented ahead of Step P.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Link2, Map as MapIcon, Phone, Search, Table2 } from 'lucide-react'
import { toast } from 'sonner'
import { BoardFilterPanel } from '../board/BoardFilterPanel'
import { BoardMapView } from '../board/BoardMapView'
import { useBoardFilters } from '../board/useBoardFilters'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsTable, statusTone, type ColumnDef } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { useShipmentViews } from '@/features/tms/useShipmentViews'
import { getShipmentBundle, getTmsSettings, listCarrierPingLinks, listTrackingLinksByShipment, logCheckCall, textDriver } from '@/lib/apiClient'
import { checkCallState } from '@/lib/checkCalls'
import { formatDateTime } from '@/lib/date'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { LogCheckCallDialog, type CheckCallFormValues } from '../components/LogCheckCallDialog'
import { TrackingLinkDialog } from '../components/TrackingLinkDialog'
import { motionOf, relativeTime } from './motion'
import { boardStatusOf, EMPTY_BOARD_FILTER_SET, type BoardFilterSet, type ShipmentRow } from '../shipmentViews'
import type { ShipmentBundle, TmsSettings, TrackingLinkRecord } from '@/types/tms'

const BASE_FILTERS: BoardFilterSet = { ...EMPTY_BOARD_FILTER_SET, statuses: ['DISPATCHED', 'DEPARTED', 'ARRIVED'] }
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

function nextEventText(row: ShipmentRow, nowMs: number): string | null {
  const status = boardStatusOf(row)
  if (status === 'VOIDED' || status === 'CANCELED') return null
  if (status === 'DELIVERED') {
    const ago = relativeTime(row.deliveredAt, nowMs)
    return ago ? `Delivered ${ago}` : null
  }
  const destination = status === 'DEPARTED' || status === 'ARRIVED'
  const relative = relativeTime(destination ? row.deliveryAppt : row.pickupAppt, nowMs)
  if (!relative) return null
  const event = destination ? 'Delivery' : 'Pickup'
  return relative.startsWith('in ') ? `${event} starts ${relative}` : `${event} appointment ${relative}`
}

interface ActionTarget {
  kind: 'check' | 'link'
  bundle: ShipmentBundle
  settings: TmsSettings | null
  link: TrackingLinkRecord | null
}

export function TrackingWorkstation() {
  const navigate = useNavigate()
  const { user, isOwner, isAdmin } = useAuth()
  const { shipments, loading, error, refresh } = useShipments()
  const { customers } = useDirectory()
  const staff = useStaff(user?.email)
  const viewsState = useShipmentViews()
  const [viewSlug, setViewSlug] = useState('')
  const [mapVisible, setMapVisible] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [links, setLinks] = useState<TrackingLinkRecord[]>([])
  const [linksError, setLinksError] = useState<string | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [target, setTarget] = useState<ActionTarget | null>(null)
  const [opening, setOpening] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(false)
  const [savingView, setSavingView] = useState(false)

  const refreshLinks = useCallback(() => listCarrierPingLinks().then((rows) => {
    setLinks(rows)
    setLinksError(null)
  }).catch((err: unknown) => {
    setLinks([])
    setLinksError(err instanceof Error ? err.message : 'Tracking links could not be verified')
  }), [])

  useEffect(() => {
    let alive = true
    getTmsSettings().then((value) => { if (alive) setSettings(value) })
      .catch((err: unknown) => { if (alive) toast.error(err instanceof Error ? err.message : 'Tracking settings unavailable') })
    void refreshLinks()
    const timer = window.setInterval(() => {
      setNowMs(Date.now())
      if (document.visibilityState === 'visible') void refreshLinks()
    }, 60_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [refreshLinks])

  const liveShipmentIds = useMemo(() => new Set(links.filter((link) =>
    link.kind === 'CARRIER_PING' && link.status === 'ACTIVE' && !link.revokedAt && Date.parse(link.expiresAt) > nowMs,
  ).map((link) => link.shipmentId)), [links, nowMs])
  const caller = useMemo(() => viewCallerOf({ groups: user?.groups, divisions: staff.me?.divisions, isOwner, isAdmin }),
    [user?.groups, staff.me?.divisions, isOwner, isAdmin])
  const visibleViews = useMemo(() => viewsVisibleTo(viewsState.views, caller), [viewsState.views, caller])
  const { query, setQuery, filters, setFilters, rows, panelProps, createView } = useBoardFilters({
    rows: shipments, customers, staffNameOf: staff.nameOf, views: visibleViews,
    viewSlug, onSelectView: setViewSlug, onViewsChanged: viewsState.refresh,
    onCreateView: () => { setViewName(''); setShared(false); setSaveOpen(true) },
    storageKey: 'tms-tracking', baseFilters: BASE_FILTERS,
  })
  const activeOnly = !filters.statuses.length || !filters.statuses.every((status) => status === 'DELIVERED' || status === 'VOIDED')
  const displayRows = useMemo(() => rows.filter((row) => {
    const status = boardStatusOf(row)
    const closed = status === 'DELIVERED' || status === 'VOIDED'
    return activeOnly ? !closed : closed
  }), [rows, activeOnly])

  const openShipment = useCallback((id: string) => navigate(`/tms/shipments/${id}?tab=tracking`), [navigate])
  const openAction = useCallback(async (row: ShipmentRow, kind: ActionTarget['kind']) => {
    setOpening(true)
    try {
      const [bundle, currentSettings, currentLinks] = await Promise.all([
        getShipmentBundle(row.id), getTmsSettings(),
        kind === 'link' ? listTrackingLinksByShipment(row.id) : Promise.resolve([]),
      ])
      const load = bundle.loads[0]
      if (!load) throw new Error('This shipment has no load to track yet.')
      const carrier = bundle.loadCarriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE')
      if (kind === 'link' && !carrier) throw new Error('Assign a carrier before creating a tracking link.')
      const link = currentLinks.find((l) => l.kind === 'CARRIER_PING' && l.loadCarrierId === carrier?.id
        && l.status === 'ACTIVE' && !l.revokedAt && Date.parse(l.expiresAt) > Date.now()) ?? null
      setTarget({ kind, bundle, settings: currentSettings, link })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open tracking action')
    } finally { setOpening(false) }
  }, [])
  const load = target?.bundle.loads[0]
  const carrier = target?.bundle.loadCarriers.find((c) => c.loadId === load?.id && c.status === 'ACTIVE') ?? null

  const submitCheckCall = async (values: CheckCallFormValues) => {
    if (!load?.updatedAt) throw new Error('No load selected')
    try {
      await logCheckCall({ loadId: load.id, expectedUpdatedAt: load.updatedAt, ...values })
      toast.success('Check call logged')
      void refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Check call failed')
      throw err
    }
    // The dialog closes only after its optional text is sent, never before.
  }

  const columns = useMemo<ColumnDef<ShipmentRow>[]>(() => [
    { key: 'shipment', header: 'Shipment #', width: 180, render: (row) => {
      const team = settings?.teams?.find((t) => row.officeTeamKeys?.includes(t.key))
      return <div>
        <button type="button" className="font-semibold hover:underline" onClick={(e) => { e.stopPropagation(); openShipment(row.id) }}>{row.number}</button>
        <div className="text-xs tms-muted">{row.dispatcherAssignedId ? staff.nameOf(row.dispatcherAssignedId) : team?.name ?? 'Unassigned'}</div>
      </div>
    } },
    { key: 'origin', header: 'Origin', width: 180, render: (row) => <div>
      <div>{row.originCity ?? '—'}</div><div className="text-xs tms-muted">{formatDateTime(row.pickupAppt)}</div>
    </div> },
    { key: 'destination', header: 'Destination', width: 180, render: (row) => <div>
      <div>{row.destinationCity ?? '—'}</div><div className="text-xs tms-muted">{formatDateTime(row.deliveryAppt)}</div>
    </div> },
    { key: 'status', header: 'Status', width: 210, render: (row) => {
      const status = boardStatusOf(row)
      const event = nextEventText(row, nowMs)
      return <div className="flex flex-col items-start gap-1">
        <TmsBadge tone={statusTone(status)}>{status.charAt(0) + status.slice(1).toLowerCase()}</TmsBadge>
        {event && <TmsBadge tone="gray">{event}</TmsBadge>}
      </div>
    } },
    { key: 'tracking', header: 'Tracking & Last Location', width: 250, render: (row) => {
      const relative = relativeTime(row.lastUpdateAt, nowMs)
      return <div className="flex flex-col items-start gap-1">
        {liveShipmentIds.has(row.id) && <TmsBadge tone="green">Tracking</TmsBadge>}
        <span className="text-xs">{row.lastUpdatePlace ?? 'Location unavailable'}{relative ? `, ${relative}` : ''}</span>
        <span className="text-xs tms-muted">Latest ping source unavailable</span>
        {row.trackingProvider && row.trackingProvider !== 'NONE' && <span className="text-xs tms-muted">Provider: {row.trackingProvider.replace(/_/g, ' ')}</span>}
      </div>
    } },
    { key: 'motion', header: 'Motion', width: 120, render: (row) => {
      const motion = motionOf({ lastUpdateAt: row.lastUpdateAt, lastUpdatePlace: row.lastUpdatePlace, nowMs })
      return <TmsBadge tone={motion === 'Moving' ? 'green' : 'gray'} title="Two position fixes are required; the shipment list currently provides only one.">{motion}</TmsBadge>
    } },
    { key: 'nextCheckCall', header: 'Next check call', width: 180, render: (row) => {
      const state = checkCallState(row, nowMs, settings?.checkCallGraceMinutes)
      return <div className="flex flex-col items-start gap-1">
        <span className="text-xs">{formatDateTime(row.nextCheckCallAt)}</span>
        {state === 'OVERDUE' && <TmsBadge tone="red">Overdue</TmsBadge>}
        {state === 'DUE' && <TmsBadge tone="orange">Due</TmsBadge>}
      </div>
    } },
    { key: 'actions', header: 'Actions', width: 100, render: (row) => <div className="flex gap-1">
      <TmsButton size="sm" variant="ghost" disabled={opening} title="Log check call" aria-label={`Log check call for ${row.number}`}
        onClick={(e) => { e.stopPropagation(); void openAction(row, 'check') }}><Phone size={14} /></TmsButton>
      <TmsButton size="sm" variant="ghost" disabled={opening} title="Tracking link" aria-label={`Tracking link for ${row.number}`}
        onClick={(e) => { e.stopPropagation(); void openAction(row, 'link') }}><Link2 size={14} /></TmsButton>
    </div> },
  ], [settings, staff, openShipment, nowMs, liveShipmentIds, opening, openAction])

  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <div className="tms-board-toolbar flex items-center gap-3 border-b px-3 py-2"><MapIcon size={18} /><h1 className="font-semibold">Tracking</h1></div>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <BoardFilterPanel {...panelProps} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
          <Search size={16} className="tms-muted" />
          <TmsInput placeholder="Search shipments..." aria-label="Search shipments" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 w-64" />
          <div className="flex gap-1" role="group" aria-label="Shipment lifecycle">
            <TmsButton size="sm" variant={activeOnly ? 'primary' : 'secondary'} aria-pressed={activeOnly}
              onClick={() => setFilters({ ...filters, statuses: [] })}>Active</TmsButton>
            <TmsButton size="sm" variant={!activeOnly ? 'primary' : 'secondary'} aria-pressed={!activeOnly}
              onClick={() => setFilters({ ...filters, statuses: ['DELIVERED', 'VOIDED'] })}>Closed</TmsButton>
          </div>
          <div className="ml-auto flex gap-1" role="group" aria-label="Tracking presentation">
            <TmsButton size="sm" variant={!mapVisible ? 'primary' : 'secondary'} aria-pressed={!mapVisible} onClick={() => setMapVisible(false)}><Table2 size={14} />Table view</TmsButton>
            <TmsButton size="sm" variant={mapVisible ? 'primary' : 'secondary'} aria-pressed={mapVisible} onClick={() => setMapVisible(true)}><MapIcon size={14} />Map view</TmsButton>
          </div>
        </div>
        {error && <p role="alert" className="p-3 text-sm text-red-600">{error}</p>}
        {linksError && <p role="status" className="px-3 py-2 text-xs tms-muted">Live tracking links unavailable: {linksError}</p>}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading && !shipments.length ? <p role="status">Loading shipments…</p> : mapVisible ?
            <BoardMapView rows={displayRows} apiKey={MAPS_KEY} mapId={MAPS_MAP_ID} onOpenShipment={openShipment} /> :
            <TmsTable columns={columns} rows={displayRows} rowKey={(row) => row.id} onRowClick={(row) => openShipment(row.id)}
              empty={<p className="py-8 text-center text-sm tms-muted">{error ? 'Shipments could not be loaded.' : `No ${activeOnly ? 'active' : 'closed'} shipments match.`}</p>} />}
        </div>
        <p className="border-t px-3 py-2 text-xs tms-muted">The per-shipment SMS and e-mail thread and the tracking agent arrive with Step P.</p>
      </div>
    </div>
    <TmsDialog open={saveOpen} onOpenChange={setSaveOpen} title="Save tracking view" footer={
      <TmsButton disabled={!viewName.trim() || savingView} onClick={async () => {
        setSavingView(true)
        try { await createView(viewName.trim(), shared); setSaveOpen(false); toast.success('View saved') }
        catch (err) { toast.error(err instanceof Error ? err.message : 'View could not be saved') }
        finally { setSavingView(false) }
      }}>{savingView ? 'Saving…' : 'Save view'}</TmsButton>
    }>
      <label className="block text-sm">View name<TmsInput value={viewName} onChange={(e) => setViewName(e.target.value)} /></label>
      <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Shared view</label>
    </TmsDialog>
    {target?.kind === 'check' && load && <LogCheckCallDialog load={load} loadCarrier={carrier} catalog={target.settings?.chargeCodes ?? []} busy={false}
      onClose={() => setTarget(null)} onSubmit={submitCheckCall} onTextDriver={async (body) => {
        if (!carrier) throw new Error('No carrier assignment to text')
        const result = await textDriver({ loadCarrierId: carrier.id, body })
        if (result.smsStatus !== 'SENT') throw new Error(result.smsError ?? 'The check call was saved, but the text was not sent.')
      }} />}
    {target?.kind === 'link' && load && carrier && <TrackingLinkDialog loadCarrier={carrier} loadNumber={load.loadNumber ?? target.bundle.shipment.number}
      link={target.link} settings={target.settings} brokerName="BCAT Logistics" onClose={() => setTarget(null)}
      onChanged={() => { void refresh(); void refreshLinks() }} />}
  </div>
}

export default TrackingWorkstation
