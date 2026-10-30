/**
 * Step P8-UI — the Chaine-style tracking desk inside the TMS shell.
 *
 * Three top tabs (Inbox · Tracking · Booking) share one filtered shipment set.
 * The Tracking tab re-uses the R2 board components and saved-view model. The
 * Inbox tab reads per-shipment message threads; the Booking tab reads carrier
 * offers and active postings. Every action opens an existing dialog or calls an
 * existing Lambda; nothing is stubbed or "coming soon".
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { teamRepIdsFor, useBoardFilters } from '../board/useBoardFilters'
import { TmsButton, TmsDialog, TmsInput, TmsTabs } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { useShipmentViews } from '@/features/tms/useShipmentViews'
import type {
  QuoteRecord,
  ShipmentBundle,
  ShipmentMessageRecord,
  ShipmentPostingRecord,
  TrackingLinkRecord,
  TmsSettings,
} from '@/types/tms'
import type { CarrierOfferVetting } from '@/lib/apiClient'
import {
  assignCarrier,
  getShipmentBundle,
  getTmsSettings,
  listActivePostings,
  listCarrierOffers,
  listShipmentMessages,
  listTrackingLinksByShipment,
  saveLoadCheckCallPlan,
  sendSetupPacket,
  sendShipmentMessage,
} from '@/lib/apiClient'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import type { CheckCallPlan } from '@/lib/checkCallPlan'
import { CreateShipmentDialog } from '../components/CreateShipmentDialog'
import { CustomerLinkDialog } from '../components/CustomerLinkDialog'
import { TrackingLinkDialog } from '../components/TrackingLinkDialog'
import { BookingPanel } from './tracking/BookingPanel'
import { InboxPanel } from './tracking/InboxPanel'
import { TrackingBoard } from './tracking/TrackingBoard'
import { useRecentlyViewed } from './tracking/useRecentlyViewed'
import { useTrackingFavorites } from './tracking/useTrackingFavorites'
import { boardStatusOf, EMPTY_BOARD_FILTER_SET, type BoardFilterSet, type BoardStatusKey, type ShipmentRow } from '../shipmentViews'

const BASE_FILTERS: BoardFilterSet = { ...EMPTY_BOARD_FILTER_SET }
const ACTIVE_STATUSES: BoardStatusKey[] = ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'HOLD', 'RESERVED']
const CLOSED_STATUSES: BoardStatusKey[] = ['DELIVERED', 'VOIDED']
const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''
const MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined

type TabKey = 'inbox' | 'tracking' | 'booking'

interface LinkDialogTarget {
  bundle: ShipmentBundle
  settings: TmsSettings | null
  link: TrackingLinkRecord | null
}

interface CustomerLinkDialogTarget {
  bundle: ShipmentBundle
  customerLink: TrackingLinkRecord | null
  settings: TmsSettings | null
}

export function TrackingWorkstation() {
  const navigate = useNavigate()
  const { user, isOwner, isAdmin } = useAuth()
  const { shipments, loading: shipmentsLoading, error: shipmentsError, refresh: refreshShipments } = useShipments()
  const { customers } = useDirectory()
  const staff = useStaff(user?.email)
  const viewsState = useShipmentViews()
  const [tab, setTab] = useState<TabKey>('tracking')
  const [viewSlug, setViewSlug] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [mapVisible, setMapVisible] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const [messagesByShipment, setMessagesByShipment] = useState<Record<string, ShipmentMessageRecord[]>>({})
  const [offersByShipment, setOffersByShipment] = useState<Record<string, (QuoteRecord & { vetting: CarrierOfferVetting })[]>>({})
  const [postings, setPostings] = useState<ShipmentPostingRecord[]>([])
  // The tab fetches below never set state synchronously: each loading flag is
  // derived from which row set the last completed fetch belonged to.
  const [messagesReadyKey, setMessagesReadyKey] = useState<string | null>(null)
  const [offersReadyKey, setOffersReadyKey] = useState<string | null>(null)
  const [postingsReadyKey, setPostingsReadyKey] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedBundle, setSelectedBundle] = useState<ShipmentBundle | null>(null)
  const [selectedMessages, setSelectedMessages] = useState<ShipmentMessageRecord[]>([])
  const [detailReadyKey, setDetailReadyKey] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(false)
  const [savingView, setSavingView] = useState(false)

  const [linkTarget, setLinkTarget] = useState<LinkDialogTarget | null>(null)
  const [customerLinkTarget, setCustomerLinkTarget] = useState<CustomerLinkDialogTarget | null>(null)
  const [assignTarget, setAssignTarget] = useState<{ shipmentId: string; offerId: string } | null>(null)
  const [setupTarget, setSetupTarget] = useState<{ shipmentId: string; offerId: string; email: string } | null>(null)
  const [setupEmail, setSetupEmail] = useState('')
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

  const selectedShipment = useMemo(
    () => displayRows.find((r) => r.id === selectedId) ?? displayRows[0] ?? null,
    [displayRows, selectedId],
  )

  // Fetch the load, carrier and thread for the shipment selected in the Tracking tab.
  useEffect(() => {
    if (tab !== 'tracking') return
    const id = selectedShipment?.id
    let alive = true
    if (!id) {
      Promise.resolve()
        .then(() => {
          if (!alive) return
          setSelectedBundle(null)
          setSelectedMessages([])
          setDetailReadyKey('')
        })
      return () => { alive = false }
    }
    Promise.all([
      getShipmentBundle(id),
      listShipmentMessages(id),
    ])
      .then(([bundle, messages]) => {
        if (!alive) return
        setSelectedBundle(bundle)
        setSelectedMessages(messages)
      })
      .catch((err) => {
        if (!alive) return
        setSelectedBundle(null)
        setSelectedMessages([])
        toast.error(err instanceof Error ? err.message : 'Could not load shipment details')
      })
      .finally(() => { if (alive) setDetailReadyKey(id) })
    return () => { alive = false }
  }, [tab, selectedShipment?.id])

  const refreshDetail = useCallback(async () => {
    const id = selectedShipment?.id
    if (!id || tab !== 'tracking') return
    setDetailReadyKey(null)
    try {
      const [bundle, messages] = await Promise.all([
        getShipmentBundle(id),
        listShipmentMessages(id),
      ])
      setSelectedBundle(bundle)
      setSelectedMessages(messages)
    } catch (err) {
      setSelectedBundle(null)
      setSelectedMessages([])
      toast.error(err instanceof Error ? err.message : 'Could not refresh shipment details')
    } finally {
      setDetailReadyKey(id)
    }
  }, [selectedShipment?.id, tab])

  const handleSendMessage = useCallback(async (input: {
    channel: 'EMAIL' | 'SMS'
    to: string | null
    subject: string | null
    body: string
  }) => {
    const id = selectedShipment?.id
    if (!id) return
    await sendShipmentMessage({ shipmentId: id, ...input })
    await refreshDetail()
  }, [selectedShipment?.id, refreshDetail])

  const handleSavePlan = useCallback(async (loadId: string, plan: CheckCallPlan, expectedUpdatedAt?: string) => {
    await saveLoadCheckCallPlan({ loadId, plan, expectedUpdatedAt })
    await refreshDetail()
  }, [refreshDetail])

  const displayKey = useMemo(() => displayRows.map((r) => r.id).sort().join(','), [displayRows])
  const detailKey = useMemo(() => (tab === 'tracking' ? selectedShipment?.id ?? '' : ''), [tab, selectedShipment?.id])
  const messagesLoading = tab === 'inbox' && messagesReadyKey !== displayKey
  const offersLoading = tab === 'booking' && offersReadyKey !== displayKey
  const postingsLoading = tab === 'booking' && postingsReadyKey !== displayKey
  const detailLoading = tab === 'tracking' && detailKey !== '' && detailReadyKey !== detailKey

  // Fetch inbox messages for the filtered rows when the Inbox tab is open.
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

  // Fetch carrier offers and active postings when the Booking tab is open.
  useEffect(() => {
    if (tab !== 'booking') return
    let alive = true
    const ids = displayKey ? displayKey.split(',') : []
    Promise.all(
      ids.map((id) =>
        listCarrierOffers(id).then(({ offers }) => ({ id, offers })),
      ),
    )
      .then((results) => {
        if (!alive) return
        const next: Record<string, (QuoteRecord & { vetting: CarrierOfferVetting })[]> = {}
        for (const { id, offers } of results) next[id] = offers
        setOffersByShipment(next)
      })
      .catch(() => { if (alive) setOffersByShipment({}) })
      .finally(() => { if (alive) setOffersReadyKey(displayKey) })
    listActivePostings()
      .then((rows) => { if (alive) setPostings(rows) })
      .catch(() => { if (alive) setPostings([]) })
      .finally(() => { if (alive) setPostingsReadyKey(displayKey) })
    return () => { alive = false }
  }, [tab, displayKey])

  const openShipment = useCallback(
    (id: string) => {
      const row = shipments.find((r) => r.id === id)
      if (row) pushRecent(id, row.number)
      navigate(`/tms/shipments/${id}?tab=tracking`)
    },
    [navigate, shipments, pushRecent],
  )

  const openLinkDialog = useCallback(async (row: ShipmentRow) => {
    try {
      const [bundle, currentSettings, links] = await Promise.all([
        getShipmentBundle(row.id),
        getTmsSettings(),
        listTrackingLinksByShipment(row.id),
      ])
      const load = bundle.loads[0]
      const carrier = load
        ? bundle.loadCarriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE') ?? null
        : null
      if (!carrier) throw new Error('Assign a carrier before managing tracking links.')
      const link = links.find((l) => l.kind === 'CARRIER_PING' && l.loadCarrierId === carrier.id
        && l.status === 'ACTIVE' && !l.revokedAt && Date.parse(l.expiresAt) > Date.now()) ?? null
      setLinkTarget({ bundle, settings: currentSettings, link })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open tracking links')
    }
  }, [])

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

  const handleAssign = useCallback(async () => {
    if (!assignTarget) return
    try {
      const { shipmentId, offerId } = assignTarget
      const bundle = await getShipmentBundle(shipmentId)
      const load = bundle.loads[0]
      if (!load) throw new Error('Shipment has no load to assign.')
      const offer = offersByShipment[shipmentId]?.find((o) => o.id === offerId)
      if (!offer) throw new Error('Offer not found.')
      await assignCarrier({
        loadId: load.id,
        expectedUpdatedAt: load.updatedAt ?? undefined,
        carrierName: offer.carrierName ?? 'Carrier',
        carrierMc: offer.carrierMc ?? undefined,
        dispatcherName: offer.contactName ?? undefined,
        dispatcherEmail: offer.carrierEmail ?? undefined,
        carrierRateCents: offer.amountCents,
      })
      toast.success('Carrier assigned')
      setAssignTarget(null)
      void refreshShipments()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Assign failed')
    }
  }, [assignTarget, offersByShipment, refreshShipments])

  const handleSendSetupPacket = useCallback(async () => {
    if (!setupTarget) return
    try {
      await sendSetupPacket({
        shipmentId: setupTarget.shipmentId,
        quoteId: setupTarget.offerId,
        email: setupTarget.email,
      })
      toast.success('Setup packet sent')
      setSetupTarget(null)
      setSetupEmail('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Setup packet failed')
    }
  }, [setupTarget])

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
      { key: 'booking', label: 'Booking' },
    ],
    [],
  )

  const activeShipmentForDialogs = selectedShipment ?? displayRows[0]

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
        {tab === 'tracking' && (
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
            mapVisible={mapVisible}
            setMapVisible={setMapVisible}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            onOpenShipment={openShipment}
            onCreateShipment={() => setCreateOpen(true)}
            onManageLinks={() => { if (activeShipmentForDialogs) void openLinkDialog(activeShipmentForDialogs) }}
            onCreateCustomerUrl={() => { if (activeShipmentForDialogs) void openCustomerLinkDialog(activeShipmentForDialogs) }}
            onSaveView={() => panelProps.onCreateFilterSet()}
            panelProps={panelProps}
            recent={recent}
            onOpenRecent={openShipment}
            onRemoveRecent={removeRecent}
            selectedId={selectedId}
            onSelect={setSelectedId}
            selectedBundle={selectedBundle}
            selectedMessages={selectedMessages}
            detailLoading={detailLoading}
            customers={customers}
            settings={settings}
            userName={user?.email ?? null}
            onSendMessage={handleSendMessage}
            onSavePlan={handleSavePlan}
            onRefreshDetail={refreshDetail}
          />
        )}
        {tab === 'inbox' && (
          <InboxPanel
            rows={displayRows}
            messagesByShipment={messagesByShipment}
            loading={messagesLoading}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
        {tab === 'booking' && (
          <BookingPanel
            rows={displayRows}
            offersByShipment={offersByShipment}
            postings={postings}
            loading={offersLoading || postingsLoading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAssign={(shipmentId, offerId) => setAssignTarget({ shipmentId, offerId })}
            onSendSetupPacket={(shipmentId, offerId) => {
              const offer = offersByShipment[shipmentId]?.find((o) => o.id === offerId)
              setSetupEmail(offer?.carrierEmail ?? '')
              setSetupTarget({ shipmentId, offerId, email: offer?.carrierEmail ?? '' })
            }}
          />
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
      {linkTarget && (
        <TrackingLinkDialog
          loadCarrier={linkTarget.bundle.loadCarriers.find((c) => c.status === 'ACTIVE')!}
          loadNumber={linkTarget.bundle.loads[0]?.loadNumber ?? linkTarget.bundle.shipment.number}
          link={linkTarget.link}
          settings={linkTarget.settings}
          brokerName="BCAT Logistics"
          onClose={() => setLinkTarget(null)}
          onChanged={() => { void refreshShipments() }}
        />
      )}
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
      <TmsDialog open={assignTarget != null} onOpenChange={() => setAssignTarget(null)} title="Assign carrier" footer={
        <TmsButton onClick={handleAssign}>Assign</TmsButton>
      }>
        <p className="text-sm">Assign this carrier to the load?</p>
      </TmsDialog>
      <TmsDialog open={setupTarget != null} onOpenChange={() => { setSetupTarget(null); setSetupEmail('') }} title="Send setup packet" footer={
        <TmsButton disabled={!setupEmail.trim()} onClick={handleSendSetupPacket}>Send</TmsButton>
      }>
        <div className="space-y-3">
          <label className="block text-sm">
            Carrier e-mail
            <TmsInput value={setupEmail} onChange={(e) => setSetupEmail(e.target.value)} />
          </label>
        </div>
      </TmsDialog>
    </div>
  )
}

export default TrackingWorkstation
