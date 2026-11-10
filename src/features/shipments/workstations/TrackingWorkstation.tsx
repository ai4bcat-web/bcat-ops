/**
 * The tracking desk inside the TMS shell: the table of every shipment whose rate
 * confirmation was sent, grouped by the person tracking it.
 *
 * - Rows: shipments with a sent rate con (`isRateConSent`), narrowed by lifecycle
 *   (Active · POD due · Closed), then by search, then by the assignee quick tab
 *   (`?assignee=`: `me`, `all`, `unassigned`, or a user id). Column filters, sort, Group by
 *   and the layout live in the board's dense grid.
 * - `?focus=checkcalls|docs|exceptions` narrows the same rows to what the retired Check calls
 *   and Document review worklists listed; with a focus the lifecycle is Active + POD due.
 * - A row click opens the shipment's tracking drawer, driven by `?shipment=<id>`, so a
 *   deep link or a notification opens it on the grid.
 * - Log check call, Snooze and Review documents are row actions: the same dialogs and CAS
 *   tokens the shipment's Tracking tab and the old worklists used.
 *
 * Customer links are a row callback here; the Manage Customer Links page (off the sidebar,
 * linked from the drawer and Settings) owns listing, revoke and extend.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { monthsCovering } from '@/lib/shipmentWindows'
import { useStaff } from '@/hooks/useStaff'
import type { ChargeCodeDef, CustomerRecord, ShipmentBundle, TrackingLinkRecord, TmsSettings } from '@/types/tms'
import {
  assignTracker,
  getShipmentBundle,
  getTmsSettings,
  listTrackingLinksByShipment,
  logCheckCall,
  requestPod,
  runCheckCallPlan,
  setNextCheckCall,
  textDriver,
} from '@/lib/apiClient'
import { effectiveTrackingPrefs } from '@/lib/trackingPrefs'
import { DocumentReviewDialog } from '@/features/documents/DocumentReviewDialog'
import { CustomerLinkDialog } from '../components/CustomerLinkDialog'
import { LogCheckCallDialog } from '../components/LogCheckCallDialog'
import { TrackingBoard } from './tracking/TrackingBoard'
import { TrackingDrawer } from './tracking/TrackingDrawer'
import {
  assigneeTabs as buildAssigneeTabs,
  defaultAssignee,
  lifecycleRows as trackingLifecycleRows,
  parseFocus,
  rowsForAssignee,
  type TrackingFocus,
} from './tracking/trackingTable'
import type { TrackingLifecycle } from './tracking/types'
import { useTrackingFavorites } from './tracking/useTrackingFavorites'
import { matchesQuery, type ShipmentRow } from '../shipmentViews'

const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

interface CustomerLinkDialogTarget {
  bundle: ShipmentBundle
  customerLink: TrackingLinkRecord | null
  settings: TmsSettings | null
}

interface LogCallTarget {
  bundle: ShipmentBundle
}

const HOUR_MS = 3_600_000

export function TrackingWorkstation() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const { customers } = useDirectory({ locations: false })
  const staff = useStaff(user?.email)
  const myId = staff.me?.id ?? user?.userId ?? null

  const [lifecycle, setLifecycle] = useState<TrackingLifecycle>('active')
  const focus = parseFocus(searchParams.get('focus'))
  const drawerShipmentId = searchParams.get('shipment')
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
    lifecycle === 'closed' && !focus ? { kind: 'window', months: closedMonths } : { kind: 'working' },
  )
  const [customerLinkTarget, setCustomerLinkTarget] = useState<CustomerLinkDialogTarget | null>(null)
  const [logCallTarget, setLogCallTarget] = useState<LogCallTarget | null>(null)
  const [logBusy, setLogBusy] = useState(false)
  const [reviewTarget, setReviewTarget] = useState<{ id: string; number: string } | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  useEffect(() => {
    let alive = true
    getTmsSettings().then((s) => { if (alive) setSettings(s) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const { favorites, toggleFavorite } = useTrackingFavorites(user?.email)

  // Clock refresh every minute so relative times stay honest.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // A focus lists open work: the Active and POD-due lifecycles together (a delivered load with
  // an upload in review is lifecycle `pod`). No Closed fetch.
  const lifecycleRows = useMemo(
    () => focus
      ? [...trackingLifecycleRows(shipments, 'active', includeUnsent), ...trackingLifecycleRows(shipments, 'pod', includeUnsent)]
      : trackingLifecycleRows(shipments, lifecycle, includeUnsent),
    [shipments, includeUnsent, lifecycle, focus],
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

  const selectFocus = useCallback(
    (next: TrackingFocus | null) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev)
        if (next) params.set('focus', next)
        else params.delete('focus')
        return params
      }, { replace: true })
    },
    [setSearchParams],
  )

  const openShipment = useCallback(
    (id: string) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev)
        params.set('shipment', id)
        return params
      })
    },
    [setSearchParams],
  )

  const closeDrawer = useCallback(() => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.delete('shipment')
      return params
    }, { replace: true })
  }, [setSearchParams])

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

  const handleLogCheckCall = useCallback(async (row: ShipmentRow) => {
    try {
      setLogCallTarget({ bundle: await getShipmentBundle(row.id) })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the check call form')
    }
  }, [])

  const handleSnooze = useCallback(async (row: ShipmentRow) => {
    try {
      const { loads } = await getShipmentBundle(row.id)
      const load = loads[0]
      if (!load?.updatedAt) throw new Error('That shipment has no load to snooze')
      await setNextCheckCall({
        loadId: load.id,
        expectedUpdatedAt: load.updatedAt,
        nextCheckCallAt: new Date(Date.now() + HOUR_MS).toISOString(),
      })
      toast.success(`${row.number}: snoozed an hour`)
      await refreshShipments()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not snooze that check call')
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

  const customerById = useMemo(() => new Map<string, CustomerRecord>(customers.map((c) => [c.id, c])), [customers])
  const prefsOf = useCallback(
    (row: ShipmentRow) => effectiveTrackingPrefs({ customer: row.customerId ? customerById.get(row.customerId) : null }),
    [customerById],
  )

  const logLoad = logCallTarget?.bundle.loads[0]
  const logToken = logLoad?.updatedAt
  const logCarrier = logCallTarget?.bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null

  return (
    <div className="tms-dense-page">
      {lifecycle === 'closed' && !focus && (
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
          onCreateShipment={() => navigate('/tms/shipments/new')}
          focus={focus}
          onFocus={selectFocus}
          graceMinutes={settings?.checkCallGraceMinutes}
          prefsOf={prefsOf}
          onCreateCustomerUrl={(row) => { void openCustomerLinkDialog(row) }}
          onRequestCheckCall={handleRequestCheckCall}
          onRequestPod={handleRequestPod}
          onLogCheckCall={handleLogCheckCall}
          onSnooze={handleSnooze}
          onReviewDocs={(row) => setReviewTarget({ id: row.id, number: row.number })}
          onAssignTracker={handleAssignTracker}
          email={user?.email}
          nameOf={staff.nameOf}
          onLockReleased={() => { void refreshShipments() }}
        />
      </div>
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
      {logLoad && logToken && (
        <LogCheckCallDialog
          load={logLoad}
          loadCarrier={logCarrier}
          catalog={(settings?.chargeCodes ?? []) as ChargeCodeDef[]}
          busy={logBusy}
          onClose={() => { setLogCallTarget(null); void refreshShipments() }}
          onSubmit={async (values) => {
            setLogBusy(true)
            try {
              await logCheckCall({ loadId: logLoad.id, expectedUpdatedAt: logToken, ...values })
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Could not log that check call')
              throw err
            } finally {
              setLogBusy(false)
            }
          }}
          onTextDriver={async (body) => {
            if (!logCarrier) return
            await textDriver({ loadCarrierId: logCarrier.id, body })
          }}
        />
      )}
      {reviewTarget && (
        <DocumentReviewDialog
          shipmentId={reviewTarget.id}
          label={reviewTarget.number}
          onClose={() => setReviewTarget(null)}
          onDecided={() => { void refreshShipments() }}
        />
      )}
      <TrackingDrawer shipmentId={drawerShipmentId} onClose={closeDrawer} onChanged={() => { void refreshShipments() }} />
    </div>
  )
}

export default TrackingWorkstation
