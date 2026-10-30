/**
 * Step P8-UI rebuild — the tracking desk inside the TMS shell.
 *
 * Two top tabs, both deep-linkable through the URL (`?tab=`):
 *
 * - **Tracking** — the Chaine-style table of the filtered shipment set. A row click
 *   opens the shipment's own Tracking tab; the table itself has no detail pane.
 * - **Inbox** — tracking conversations: a Chaine conversation list on the left and
 *   the shared TrackingConversation on the right, deep-linked with `?shipment=`.
 *
 * Booking is gone: offers, vetting, assign and setup packets live on the Dispatch
 * workstation (OfferQueue + PostingPanel). Customer links are one toolbar/row
 * callback here; the Manage Customer Links page owns listing, revoke and extend.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { teamRepIdsFor, useBoardFilters } from '../board/useBoardFilters'
import { TmsButton, TmsDialog, TmsInput, TmsTabs } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { useShipmentViews } from '@/features/tms/useShipmentViews'
import type {
  ShipmentBundle,
  ShipmentMessageRecord,
  TrackingLinkRecord,
  TmsSettings,
} from '@/types/tms'
import {
  getShipmentBundle,
  getTmsSettings,
  listShipmentMessages,
  listTrackingLinksByShipment,
  sendShipmentMessage,
} from '@/lib/apiClient'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { CreateShipmentDialog } from '../components/CreateShipmentDialog'
import { CustomerLinkDialog } from '../components/CustomerLinkDialog'
import { InboxPanel } from './tracking/InboxPanel'
import { TrackingBoard } from './tracking/TrackingBoard'
import { TrackingConversation } from './tracking/TrackingConversation'
import { useRecentlyViewed } from './tracking/useRecentlyViewed'
import { useTrackingFavorites } from './tracking/useTrackingFavorites'
import { boardStatusOf, EMPTY_BOARD_FILTER_SET, type BoardFilterSet, type BoardStatusKey, type ShipmentRow } from '../shipmentViews'

const BASE_FILTERS: BoardFilterSet = { ...EMPTY_BOARD_FILTER_SET }
const ACTIVE_STATUSES: BoardStatusKey[] = ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'HOLD', 'RESERVED']
const CLOSED_STATUSES: BoardStatusKey[] = ['DELIVERED', 'VOIDED']
const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

type TabKey = 'inbox' | 'tracking'

interface CustomerLinkDialogTarget {
  bundle: ShipmentBundle
  customerLink: TrackingLinkRecord | null
  settings: TmsSettings | null
}

export function TrackingWorkstation() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user, isOwner, isAdmin } = useAuth()
  const { shipments, loading: shipmentsLoading, error: shipmentsError, refresh: refreshShipments } = useShipments()
  const { customers } = useDirectory()
  const staff = useStaff(user?.email)
  const viewsState = useShipmentViews()
  const [viewSlug, setViewSlug] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const [messagesByShipment, setMessagesByShipment] = useState<Record<string, ShipmentMessageRecord[]>>({})
  const [messagesReadyKey, setMessagesReadyKey] = useState<string | null>(null)
  const [conversationBundle, setConversationBundle] = useState<ShipmentBundle | null>(null)
  const [bundleReadyKey, setBundleReadyKey] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(false)
  const [savingView, setSavingView] = useState(false)

  const [customerLinkTarget, setCustomerLinkTarget] = useState<CustomerLinkDialogTarget | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    getTmsSettings()
      .then((s) => { if (!cancelled) setSettings(s) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const { favorites, toggleFavorite } = useTrackingFavorites(user?.email)
  const { recent, push: pushRecent, remove: removeRecent } = useRecentlyViewed(user?.email)

  // Clock refresh every minute so relative times stay honest.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const caller = useMemo(
    () => viewCallerOf({ groups: user?.groups, divisions: staff.me?.divisions, isOwner, isAdmin }),
    [user?.groups, staff.me?.divisions, isOwner, isAdmin],
  )
  const visibleViews = useMemo(() => viewsVisibleTo(viewsState.views, caller), [viewsState.views, caller])

  const viewer = useMemo(
    () => ({ userId: user?.userId ?? null, teamRepIds: teamRepIdsFor(staff.me, settings?.teams) }),
    [user?.userId, staff.me, settings?.teams],
  )

  const {
    query,
    setQuery,
    setFilters,
    rows: filteredRows,
    panelProps,
    createView,
  } = useBoardFilters({
    rows: shipments,
    customers,
    staffNameOf: staff.nameOf,
    views: visibleViews,
    viewSlug,
    onSelectView: setViewSlug,
    onViewsChanged: viewsState.refresh,
    onCreateView: () => { setViewName(''); setShared(false); setSaveOpen(true) },
    storageKey: 'tms-tracking',
    baseFilters: { ...BASE_FILTERS, statuses: ACTIVE_STATUSES },
    viewer,
  })

  // Active / Closed toggle drives the status filter set so the panel stays in sync.
  useEffect(() => {
    const statuses = activeOnly ? ACTIVE_STATUSES : CLOSED_STATUSES
    setFilters((prev) => ({ ...prev, statuses }))
  }, [activeOnly, setFilters])

  const displayRows = useMemo(() => {
    return filteredRows.filter((r) => {
      const status = boardStatusOf(r)
      const closed = status === 'DELIVERED' || status === 'VOIDED'
      return activeOnly ? !closed : closed
    })
  }, [filteredRows, activeOnly])

  // ── URL-owned tab + conversation selection ────────────────────────────────
  const tab: TabKey = searchParams.get('tab') === 'inbox' ? 'inbox' : 'tracking'
  const setTab = useCallback(
    (key: TabKey) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (key === 'tracking') next.delete('tab')
        else next.set('tab', key)
        return next
      })
    },
    [setSearchParams],
  )

  const requestedId = searchParams.get('shipment')
  // A deep-linked shipment keeps its (possibly still empty) conversation; without a
  // link, fall back to the busiest conversation, then the first row.
  const selectedConversationId = useMemo(() => {
    if (requestedId && displayRows.some((r) => r.id === requestedId)) return requestedId
    const busiest = displayRows.find((r) => (messagesByShipment[r.id] ?? []).length > 0)
    return busiest?.id ?? displayRows[0]?.id ?? null
  }, [displayRows, requestedId, messagesByShipment])

  const selectConversation = useCallback(
    (id: string) => {
      if (requestedId === id) return
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('shipment', id)
        return next
      })
    },
    [requestedId, setSearchParams],
  )

  // Landing on the Inbox without a deep link says the fallback in the URL (replace:
  // the user never asked for this entry).
  useEffect(() => {
    if (tab !== 'inbox' || requestedId || !selectedConversationId) return
    const next = new URLSearchParams(searchParams)
    next.set('shipment', selectedConversationId)
    setSearchParams(next, { replace: true })
  }, [tab, requestedId, selectedConversationId, searchParams, setSearchParams])

  // A fetch resolves after the user may have moved on; only the selection that
  // asked may commit.
  const conversationIdRef = useRef<string | null>(null)
  conversationIdRef.current = selectedConversationId

  const displayKey = useMemo(() => displayRows.map((r) => r.id).sort().join(','), [displayRows])
  const messagesLoading = tab === 'inbox' && messagesReadyKey !== displayKey
  const bundleLoading = selectedConversationId != null && bundleReadyKey !== selectedConversationId

  // The conversation list reads every filtered shipment's traffic when the Inbox opens.
  useEffect(() => {
    if (tab !== 'inbox') return
    let alive = true
    const ids = displayKey ? displayKey.split(',') : []
    Promise.all(
      ids.map((id) =>
        listShipmentMessages(id).then((rows) => ({ id, rows })),
      ),
    )
      .then((results) => {
        if (!alive) return
        const next: Record<string, ShipmentMessageRecord[]> = {}
        for (const { id, rows } of results) next[id] = rows
        setMessagesByShipment(next)
      })
      .catch(() => { if (alive) setMessagesByShipment({}) })
      .finally(() => { if (alive) setMessagesReadyKey(displayKey) })
    return () => { alive = false }
  }, [tab, displayKey])

  // The framed conversation needs the bundle for the driver/dispatcher contacts.
  useEffect(() => {
    if (tab !== 'inbox') return
    const id = selectedConversationId
    if (!id) return
    let alive = true
    getShipmentBundle(id)
      .then((bundle) => { if (alive) setConversationBundle(bundle) })
      .catch((err) => {
        if (!alive) return
        setConversationBundle(null)
        toast.error(err instanceof Error ? err.message : 'Could not load the conversation')
      })
      .finally(() => { if (alive) setBundleReadyKey(id) })
    return () => { alive = false }
  }, [tab, selectedConversationId])

  const refreshConversation = useCallback(async () => {
    const id = conversationIdRef.current
    if (!id) return
    try {
      const messages = await listShipmentMessages(id)
      if (conversationIdRef.current !== id) return
      setMessagesByShipment((prev) => ({ ...prev, [id]: messages }))
    } catch (err) {
      if (conversationIdRef.current !== id) return
      toast.error(err instanceof Error ? err.message : 'Could not refresh the conversation')
    }
  }, [])

  const handleSendMessage = useCallback(async (input: {
    channel: 'EMAIL' | 'SMS'
    to: string | null
    subject: string | null
    body: string
    documentIds?: string[]
    party?: 'DRIVER' | 'DISPATCHER'
  }) => {
    const id = conversationIdRef.current
    if (!id) return
    await sendShipmentMessage({ shipmentId: id, ...input })
    await refreshConversation()
  }, [refreshConversation])

  const activeLeg = useMemo(() => {
    const load = conversationBundle?.loads[0]
    if (!load) return null
    return conversationBundle?.loadCarriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE') ?? null
  }, [conversationBundle])

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

  const saveView = useCallback(async () => {
    if (!viewName.trim()) return
    setSavingView(true)
    try {
      await createView(viewName.trim(), shared)
      setSaveOpen(false)
      toast.success('View saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'View could not be saved')
    } finally {
      setSavingView(false)
    }
  }, [createView, shared, viewName])

  const tabs = useMemo(
    () => [
      { key: 'inbox', label: 'Inbox' },
      { key: 'tracking', label: 'Tracking' },
    ],
    [],
  )

  return (
    <div className="tms-board-shell flex h-full flex-col">
      <div className="tms-board-toolbar flex items-center justify-between border-b px-3 py-2">
        <TmsTabs tabs={tabs} active={tab} onSelect={(key) => setTab(key as TabKey)} />
      </div>
      <div className="tms-tracking-breadcrumb-bar px-3 py-1">
        <span className="tms-tracking-division">{panelProps.viewName}</span>
        <span className="tms-tracking-breadcrumb-sep">›</span>
        <span>Shipments</span>
      </div>
      <div className="flex flex-1 overflow-hidden">
        {tab === 'tracking' ? (
          <TrackingBoard
            rows={displayRows}
            loading={shipmentsLoading}
            error={shipmentsError}
            nowMs={nowMs}
            mapsKey={MAPS_KEY}
            mapsMapId={MAPS_MAP_ID}
            query={query}
            setQuery={setQuery}
            activeOnly={activeOnly}
            setActiveOnly={setActiveOnly}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            onOpenShipment={openShipment}
            onCreateShipment={() => setCreateOpen(true)}
            onManageLinks={() => navigate('/tms/tracking/links')}
            onCreateCustomerUrl={(row) => { void openCustomerLinkDialog(row) }}
            onSaveView={() => panelProps.onCreateFilterSet()}
            panelProps={panelProps}
            recent={recent}
            onOpenRecent={openShipment}
            onRemoveRecent={removeRecent}
          />
        ) : (
          <InboxPanel
            rows={displayRows}
            messagesByShipment={messagesByShipment}
            loading={messagesLoading}
            selectedId={selectedConversationId}
            onSelect={selectConversation}
          >
            <TrackingConversation
              variant="inbox"
              bundle={conversationBundle}
              messages={selectedConversationId ? messagesByShipment[selectedConversationId] ?? [] : []}
              loading={messagesLoading || bundleLoading}
              userName={user?.email ?? null}
              driver={activeLeg ? { name: activeLeg.driverName, phone: activeLeg.driverPhone } : null}
              dispatcher={activeLeg ? { name: activeLeg.dispatcherName, phone: activeLeg.dispatcherPhone, email: activeLeg.dispatcherEmail } : null}
              conversationKey={selectedConversationId ?? ''}
              onSendMessage={handleSendMessage}
              onRefresh={refreshConversation}
            />
          </InboxPanel>
        )}
      </div>
      <CreateShipmentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refreshShipments} />
      <TmsDialog open={saveOpen} onOpenChange={setSaveOpen} title="Save tracking view" footer={
        <TmsButton disabled={!viewName.trim() || savingView} onClick={saveView}>
          {savingView ? 'Saving…' : 'Save view'}
        </TmsButton>
      }>
        <div className="space-y-3">
          <label className="block text-sm">
            View name
            <TmsInput value={viewName} onChange={(e) => setViewName(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Shared view
          </label>
        </div>
      </TmsDialog>
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
