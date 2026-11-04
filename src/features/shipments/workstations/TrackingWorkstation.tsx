/**
 * The tracking desk inside the TMS shell: the table of every shipment whose rate
 * confirmation was sent, grouped by the person tracking it.
 *
 * - Rows: shipments with a sent rate con (`isRateConSent`), narrowed by lifecycle
 *   (Active · POD due · Closed), then by search, then by the assignee quick tab
 *   (`?assignee=`: `me`, `all`, `unassigned`, or a user id). Column filters, sort, Group by
 *   and the layout live in the board's dense grid.
 * - A row click opens the shipment's own Tracking tab, where the conversation lives.
 *   Old `?shipment=` / `?tab=inbox` bookmarks redirect there.
 *
 * Customer links are one toolbar/row callback here; the Manage Customer Links page owns
 * listing, revoke and extend.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { monthsCovering } from '@/lib/shipmentWindows'
import { useStaff } from '@/hooks/useStaff'
import type { ShipmentBundle, TrackingLinkRecord, TmsSettings } from '@/types/tms'
import {
  assignTracker,
  getShipmentBundle,
  getTmsSettings,
  listTrackingLinksByShipment,
  requestPod,
  runCheckCallPlan,
} from '@/lib/apiClient'
import { CreateShipmentDialog } from '../components/CreateShipmentDialog'
import { CustomerLinkDialog } from '../components/CustomerLinkDialog'
import { TrackingBoard } from './tracking/TrackingBoard'
import {
  assigneeTabs as buildAssigneeTabs,
  defaultAssignee,
  lifecycleRows as trackingLifecycleRows,
  rowsForAssignee,
} from './tracking/trackingTable'
import type { TrackingLifecycle } from './tracking/types'
import { useRecentlyViewed } from './tracking/useRecentlyViewed'
import { useTrackingFavorites } from './tracking/useTrackingFavorites'
import { matchesQuery, type ShipmentRow } from '../shipmentViews'

const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

interface CustomerLinkDialogTarget {
  bundle: ShipmentBundle
  customerLink: TrackingLinkRecord | null
  settings: TmsSettings | null
}

export function TrackingWorkstation() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const { customers } = useDirectory({ locations: false })
  const staff = useStaff(user?.email)
  const myId = staff.me?.id ?? user?.userId ?? null

  const [lifecycle, setLifecycle] = useState<TrackingLifecycle>('active')
  const [includeUnsent, setIncludeUnsent] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Active and POD-due loads are open work, so they ride the shared working set the shell already
  // holds. Closed loads (POD received, canceled) are history: they are fetched, for this month and
  // last month only, when the Closed toggle is opened.
  const monthKey = new Date(nowMs).toISOString().slice(0, 7)
  const closedMonths = useMemo(
    () => monthsCovering(`${monthKey}-01`, `${monthKey}-01`, 1).slice(0, 2),
    [monthKey],
  )
  const { shipments, loading: shipmentsLoading, error: shipmentsError, refresh: refreshShipments } = useShipments(
    lifecycle === 'closed' ? { kind: 'window', months: closedMonths } : { kind: 'working' },
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [customerLinkTarget, setCustomerLinkTarget] = useState<CustomerLinkDialogTarget | null>(null)

  const { favorites, toggleFavorite } = useTrackingFavorites(user?.email)
  const { recent, push: pushRecent, remove: removeRecent } = useRecentlyViewed(user?.email)

  // Clock refresh every minute so relative times stay honest.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // Old Inbox bookmarks (`?tab=inbox&shipment=<id>`) land on the shipment's Tracking tab.
  const legacyShipmentId = searchParams.get('shipment')
  useEffect(() => {
    if (legacyShipmentId) navigate(`/tms/shipments/${legacyShipmentId}?tab=tracking`, { replace: true })
  }, [legacyShipmentId, navigate])

  const lifecycleRows = useMemo(
    () => trackingLifecycleRows(shipments, lifecycle, includeUnsent),
    [shipments, includeUnsent, lifecycle],
  )

  const [query, setQuery] = useState('')
  const searchedRows = useMemo(
    () => (query ? lifecycleRows.filter((r) => matchesQuery(r, query)) : lifecycleRows),
    [lifecycleRows, query],
  )

  const tabs = useMemo(() => buildAssigneeTabs(searchedRows, myId), [searchedRows, myId])
  const activeAssignee = searchParams.get('assignee') ?? defaultAssignee(searchedRows, myId)
  const rows = useMemo(
    () => rowsForAssignee(searchedRows, activeAssignee, myId),
    [searchedRows, activeAssignee, myId],
  )

  const selectAssignee = useCallback(
    (key: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('assignee', key)
        return next
      }, { replace: true })
    },
    [setSearchParams],
  )

  const openShipment = useCallback(
    (id: string) => {
      const row = shipments.find((r) => r.id === id)
      if (row) pushRecent(id, row.number)
      navigate(`/tms/shipments/${id}?tab=tracking`)
    },
    [navigate, shipments, pushRecent],
  )

  const openCustomerLinkDialog = useCallback(async (row: ShipmentRow) => {
    try {
      const [bundle, currentSettings, links] = await Promise.all([
        getShipmentBundle(row.id),
        getTmsSettings(),
        listTrackingLinksByShipment(row.id),
      ])
      const customerLink = links.find((l) => l.kind === 'CUSTOMER_VIEW' && l.status === 'ACTIVE' && !l.revokedAt
        && Date.parse(l.expiresAt) > Date.now()) ?? null
      setCustomerLinkTarget({ bundle, customerLink, settings: currentSettings })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open customer link')
    }
  }, [])

  const handleRequestCheckCall = useCallback(async (row: ShipmentRow) => {
    try {
      const result = await runCheckCallPlan({ shipmentId: row.id })
      toast.success(`${row.number}: ${result.reason}`)
      await refreshShipments()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not request a check call')
    }
  }, [refreshShipments])

  const handleRequestPod = useCallback(async (row: ShipmentRow) => {
    try {
      await requestPod({ shipmentId: row.id })
      toast.success(`POD requested for ${row.number}`)
      await refreshShipments()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not request the POD')
    }
  }, [refreshShipments])

  const handleAssignTracker = useCallback(async (shipmentIds: string[], trackerId: string | null) => {
    try {
      const result = await assignTracker({ shipmentIds, trackerId })
      if (result.updated.length > 0) {
        toast.success(
          `${result.updated.length} shipment${result.updated.length === 1 ? '' : 's'} ${trackerId ? `assigned to ${staff.nameOf(trackerId)}` : 'unassigned'}`,
        )
      }
      for (const skipped of result.skipped) toast.error(`${skipped.shipmentId}: ${skipped.reason}`)
      await refreshShipments()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not assign the tracker')
    }
  }, [refreshShipments, staff])

  return (
    <div className="tms-dense-page">
      {lifecycle === 'closed' && (
        <p className="tms-field-hint" role="status" style={{ margin: 0, padding: '4px 8px' }}>
          Closed loads: last 2 months. Older ones: Shipments → All.
        </p>
      )}
      <div className="tms-dense-body">
        <TrackingBoard
          rows={rows}
          assigneeTabs={tabs}
          activeAssignee={activeAssignee}
          onSelectAssignee={selectAssignee}
          lifecycle={lifecycle}
          onLifecycle={setLifecycle}
          includeUnsent={includeUnsent}
          onIncludeUnsent={setIncludeUnsent}
          loading={shipmentsLoading}
          error={shipmentsError}
          nowMs={nowMs}
          mapsKey={MAPS_KEY}
          mapsMapId={MAPS_MAP_ID}
          query={query}
          setQuery={setQuery}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          onOpenShipment={openShipment}
          onCreateShipment={() => setCreateOpen(true)}
          onManageLinks={() => navigate('/tms/tracking/links')}
          onCreateCustomerUrl={(row) => { void openCustomerLinkDialog(row) }}
          onRequestCheckCall={handleRequestCheckCall}
          onRequestPod={handleRequestPod}
          onAssignTracker={handleAssignTracker}
          email={user?.email}
          nameOf={staff.nameOf}
          recent={recent}
          onOpenRecent={openShipment}
          onRemoveRecent={removeRecent}
        />
      </div>
      <CreateShipmentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refreshShipments} />
      {customerLinkTarget && (
        <CustomerLinkDialog
          shipment={customerLinkTarget.bundle.shipment}
          customer={customers.find((c) => c.id === customerLinkTarget.bundle.shipment.customerId) ?? null}
          link={customerLinkTarget.customerLink}
          settings={customerLinkTarget.settings}
          onClose={() => setCustomerLinkTarget(null)}
          onChanged={() => { void refreshShipments() }}
        />
      )}
    </div>
  )
}

export default TrackingWorkstation
