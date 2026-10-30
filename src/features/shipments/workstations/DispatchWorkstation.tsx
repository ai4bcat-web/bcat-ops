/**
 * The Dispatch workstation — a coverage workbench, not the shipments board.
 *
 * Left: the shared board filter panel narrowed to freight that still needs or just
 * got coverage (OPEN and COVERED). Right: the coverage queue, and for the selected
 * shipment a "Find coverage" panel that shows posting state, parsed carrier offers,
 * what is covering it now, and carriers that have run this lane before.
 *
 * Routing lives in the sidebar agent; this module only renders `/tms/dispatch`.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Truck } from 'lucide-react'
import { toast } from 'sonner'

import { BoardFilterPanel } from '@/features/shipments/board/BoardFilterPanel'
import { teamRepIdsFor, useBoardFilters } from '@/features/shipments/board/useBoardFilters'
import { TmsBadge, TmsButton, TmsCard, TmsEmptyState } from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit'
import { useShipmentActions, type ShipmentActions } from '@/features/shipments/useShipmentActions'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { useShipmentViews } from '@/features/tms/useShipmentViews'
import {
  getCarrierBundle,
  getShipmentBundle,
  getTmsSettings,
  listActivePostings,
  listCarriers,
  listCarrierOffers,
  listDivisions,
  listLoadCarriers,
  listShipmentPostings,
} from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { formatCents } from '@/lib/tmsDirectory'
import { descriptorOf } from '@/lib/integrations/registry'
import {
  buildRateConInput,
  buildRateConPdf,
  rateConPdfBase64,
  rateConRecipients,
} from './dispatch/rateCon'
import {
  coverageStateOf,
  suggestCarriers,
  RATE_CON_STATUS_LABELS,
  type CoverageState,
  type LaneHistoryEntry,
  type SuggestedCarrier,
} from './coverage'
import { PostingPanel } from './dispatch/PostingPanel'
import { OfferQueue } from './dispatch/OfferQueue'
import {
  EMPTY_BOARD_FILTER_SET,
  type BoardStatusKey,
  type ShipmentRow,
} from '../shipmentViews'
import type {
  CarrierRecord,
  CustomerRecord,
  Division,
  LoadCarrierRecord,
  QuoteRecord,
  ShipmentBundle,
  ShipmentPostingRecord,
  TmsSettings,
} from '@/types/tms'
import type { CarrierOfferVetting } from '@/lib/apiClient'

const BASE_FILTERS = { ...EMPTY_BOARD_FILTER_SET, statuses: ['OPEN', 'COVERED'] as BoardStatusKey[] }

const COVERAGE_TONE: Record<CoverageState, TmsTone> = {
  NEEDS_COVERAGE: 'red',
  COVERED: 'orange',
  RATE_CON_SIGNED: 'green',
  DISPATCHED: 'blue',
}

const COVERAGE_LABEL: Record<CoverageState, string> = {
  NEEDS_COVERAGE: 'Needs coverage',
  COVERED: 'Covered',
  RATE_CON_SIGNED: 'Rate con signed',
  DISPATCHED: 'Dispatched',
}

function laneLabel(row: ShipmentRow): string {
  const origin = [row.originCity, row.fromState].filter(Boolean).join(', ') || '—'
  const dest = [row.destinationCity, row.toState].filter(Boolean).join(', ') || '—'
  return `${origin} → ${dest}`
}

function postedBoardLabels(postings: ShipmentPostingRecord[]): string {
  const boards = postings
    .filter((p) => p.status === 'POSTED')
    .map((p) => descriptorOf(p.provider)?.label ?? p.provider)
  return boards.length > 0 ? boards.join(', ') : 'Not posted'
}

export function DispatchWorkstation() {
  const { user, isOwner, isAdmin } = useAuth()
  const { shipments: allRows, loading: rowsLoading, error: rowsError, refresh: refreshRows } = useShipments()
  const { customers } = useDirectory()
  const staff = useStaff(user?.email ?? '')
  const viewsState = useShipmentViews()

  const [viewSlug, setViewSlug] = useState('')
  const [activeLegsByShipment, setActiveLegsByShipment] = useState<Record<string, LoadCarrierRecord>>({})
  const [carriers, setCarriers] = useState<CarrierRecord[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)

  const caller = useMemo(
    () =>
      viewCallerOf({
        groups: user?.groups,
        divisions: staff.me?.divisions,
        isOwner: isOwner || false,
        isAdmin: isAdmin || false,
      }),
    [user?.groups, staff.me?.divisions, isOwner, isAdmin],
  )
  const visibleViews = useMemo(
    () => viewsVisibleTo(viewsState.views, caller),
    [viewsState.views, caller],
  )

  const viewer = useMemo(
    () => ({ userId: user?.userId ?? null, teamRepIds: teamRepIdsFor(staff.me, settings?.teams) }),
    [user?.userId, staff.me, settings?.teams],
  )

  const loadSupport = useCallback(async () => {
    const [lcs, cs, set] = await Promise.all([
      listLoadCarriers(),
      listCarriers(),
      getTmsSettings(),
    ])
    const byShipment: Record<string, LoadCarrierRecord> = {}
    for (const lc of lcs) {
      if (lc.status !== 'ACTIVE' || !lc.shipmentId) continue
      const held = byShipment[lc.shipmentId]
      if (!held || (lc.createdAt ?? '') > (held.createdAt ?? '')) {
        byShipment[lc.shipmentId] = lc
      }
    }
    return { byShipment, carriers: cs, settings: set }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadSupport()
      .then((data) => {
        if (cancelled) return
        setActiveLegsByShipment(data.byShipment)
        setCarriers(data.carriers)
        setSettings(data.settings)
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load dispatch data')
      })
    return () => { cancelled = true }
  }, [loadSupport])

  const filters = useBoardFilters({
    rows: allRows,
    customers,
    staffNameOf: staff.nameOf,
    views: visibleViews,
    viewSlug,
    onSelectView: setViewSlug,
    storageKey: 'tms-dispatch',
    baseFilters: BASE_FILTERS,
    viewer,
  })

  const refreshAll = useCallback(async () => {
    await refreshRows()
    await loadSupport()
  }, [refreshRows, loadSupport])

  if (rowsError) {
    return (
      <div className="tms-board-shell flex h-full flex-col">
        <TmsEmptyState
          title="Could not load shipments"
          message={rowsError}
          actionLabel="Try again"
          onAction={refreshRows}
        />
      </div>
    )
  }

  return (
    <div className="tms-board-shell flex h-full flex-col" data-testid="dispatch-workstation">
      <header className="tms-board-toolbar flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-3">
          <Truck size={18} />
          <span className="font-semibold">Dispatch</span>
        </div>
        <TmsButton size="sm" variant="secondary" onClick={() => { void refreshAll() }}>
          Refresh
        </TmsButton>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <BoardFilterPanel {...filters.panelProps} />
        {rowsLoading && filters.rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm tms-muted">
            Loading shipments…
          </div>
        ) : (
          <DispatchBody
            rows={filters.rows}
            allRows={allRows}
            customers={customers}
            activeLegsByShipment={activeLegsByShipment}
            carriers={carriers}
            settings={settings}
            refreshAll={refreshAll}
          />
        )}
      </div>
    </div>
  )
}

interface DispatchBodyProps {
  rows: ShipmentRow[]
  allRows: ShipmentRow[]
  customers: CustomerRecord[]
  activeLegsByShipment: Record<string, LoadCarrierRecord>
  carriers: CarrierRecord[]
  settings: TmsSettings | null
  refreshAll: () => Promise<void>
}

export function DispatchBody({
  rows,
  allRows,
  customers,
  activeLegsByShipment,
  carriers,
  settings,
  refreshAll,
}: DispatchBodyProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadedBundle, setSelectedBundle] = useState<ShipmentBundle | null>(null)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [divisions, setDivisions] = useState<Division[]>([])
  const [activePostings, setActivePostings] = useState<ShipmentPostingRecord[]>([])
  const [offersByShipment, setOffersByShipment] = useState<Record<string, (QuoteRecord & { vetting: CarrierOfferVetting })[]>>({})
  const [shipmentPostings, setShipmentPostings] = useState<ShipmentPostingRecord[]>([])
  // Neither fetch below sets state synchronously: each loading flag is derived
  // from which inputs the last completed fetch belonged to.
  const [coverageRows, setCoverageRows] = useState<ShipmentRow[] | null>(null)
  const coverageLoading = coverageRows !== rows
  const [bundleReadyFor, setBundleReadyFor] = useState<string | null>(null)
  const loadingBundle = selectedId !== null && bundleReadyFor !== selectedId
  // A bundle from a previous selection must never be read as this one's.
  const selectedBundle = loadedBundle && loadedBundle.shipment.id === selectedId ? loadedBundle : null

  useEffect(() => {
    let live = true
    listDivisions().then((d) => { if (live) setDivisions(d) }).catch(() => {})
    return () => { live = false }
  }, [])

  // Load the queue-level coverage signals once: where freight is live and how many
  // offers each row has, so a dispatcher can see where the work is without clicking.
  useEffect(() => {
    let live = true
    Promise.all([
      listActivePostings(),
      Promise.all(rows.map((r) => listCarrierOffers(r.id).catch(() => ({ offers: [] })))),
    ])
      .then(([postings, offersResults]) => {
        if (!live) return
        setActivePostings(postings)
        const byShipment: Record<string, (QuoteRecord & { vetting: CarrierOfferVetting })[]> = {}
        rows.forEach((row, i) => { byShipment[row.id] = offersResults[i].offers })
        setOffersByShipment(byShipment)
      })
      .catch(() => {})
      .finally(() => { if (live) setCoverageRows(rows) })
    return () => { live = false }
  }, [rows])

  // The fetch owns every state change: clearing the panel synchronously here would
  // re-render the whole queue on each selection for no visible gain. A bundle that
  // belongs to a different shipment is ignored at the point it is read, below.
  useEffect(() => {
    if (!selectedId) return
    let live = true
    Promise.all([
      getShipmentBundle(selectedId),
      listShipmentPostings(selectedId),
    ])
      .then(([bundle, postings]) => {
        if (!live) return
        setSelectedBundle(bundle)
        setShipmentPostings(postings)
        setBundleError(null)
      })
      .catch((err) => { if (live) setBundleError(err instanceof Error ? err.message : 'Could not load shipment') })
      .finally(() => { if (live) setBundleReadyFor(selectedId) })
    return () => { live = false }
  }, [selectedId])

  const actions = useShipmentActions(selectedBundle, (next) => {
    setSelectedBundle(next)
  })

  const queueRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aNeeds = a.assignmentType ? 0 : 1
      const bNeeds = b.assignmentType ? 0 : 1
      if (aNeeds !== bNeeds) return aNeeds - bNeeds
      return (a.shipDate ?? '').localeCompare(b.shipDate ?? '')
    })
  }, [rows])

  const laneHistory = useMemo(() => {
    const entries: LaneHistoryEntry[] = []
    for (const row of allRows) {
      if (!row.fromState || !row.toState) continue
      const leg = activeLegsByShipment[row.id]
      if (!leg || !leg.carrierId) continue
      entries.push({
        carrierId: leg.carrierId,
        originState: row.fromState,
        destinationState: row.toState,
        rateCents: leg.carrierRateCents ?? 0,
        bookedAt: leg.bookedAt ?? row.updatedAt,
      })
    }
    return entries
  }, [allRows, activeLegsByShipment])

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  )

  const suggestions = useMemo<SuggestedCarrier[]>(() => {
    if (!selectedRow?.fromState || !selectedRow.toState) return []
    return suggestCarriers({
      originState: selectedRow.fromState,
      destinationState: selectedRow.toState,
      carriers,
      history: laneHistory,
    })
  }, [selectedRow, carriers, laneHistory])

  const activeLegForSelected = useMemo(() => {
    if (!selectedBundle) return activeLegsByShipment[selectedId ?? ''] ?? null
    return selectedBundle.loadCarriers.find((lc) => lc.status === 'ACTIVE') ?? null
  }, [selectedBundle, selectedId, activeLegsByShipment])

  const postingsFor = useCallback(
    (shipmentId: string) => activePostings.filter((p) => p.shipmentId === shipmentId),
    [activePostings],
  )

  const refreshPostings = useCallback(async () => {
    if (!selectedId) return
    const [postings, active] = await Promise.all([
      listShipmentPostings(selectedId),
      listActivePostings(),
    ])
    setShipmentPostings(postings)
    setActivePostings(active)
  }, [selectedId])

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex w-1/2 min-w-0 flex-col border-r">
        <div className="border-b px-3 py-2 text-sm font-medium tms-muted">
          Coverage queue ({queueRows.length})
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {queueRows.length === 0 ? (
            <TmsEmptyState
              title="No freight needs coverage"
              message="Try widening the filter or clearing the search."
            />
          ) : (
            queueRows.map((row) => (
              <CoverageQueueCard
                key={row.id}
                row={row}
                customers={customers}
                activeLeg={activeLegsByShipment[row.id] ?? null}
                postings={postingsFor(row.id)}
                offers={offersByShipment[row.id] ?? []}
                selected={selectedId === row.id}
                onClick={() => { setSelectedId(row.id); setBundleError(null) }}
              />
            )))
          }
        </div>
      </div>

      <div className="flex w-1/2 min-w-0 flex-col">
        {!selectedRow || !selectedId ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <TmsEmptyState
              title="Select a shipment"
              message="Pick a freight card from the queue to find coverage."
            />
          </div>
        ) : loadingBundle ? (
          <div className="flex flex-1 items-center justify-center text-sm tms-muted">
            Loading shipment details…
          </div>
        ) : bundleError ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <TmsEmptyState title="Could not load shipment" message={bundleError} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <ActiveLegCard leg={activeLegForSelected} />
            <PostingPanel
              shipmentId={selectedId}
              postings={shipmentPostings}
              loading={coverageLoading}
              onChange={refreshPostings}
            />
            <OfferQueue
              shipmentId={selectedId}
              offers={offersByShipment[selectedId] ?? []}
              selectedBundle={selectedBundle}
              actions={actions}
              settings={settings}
              divisions={divisions}
              refreshAll={refreshAll}
            />
            <SuggestionsCard
              suggestions={suggestions}
              selectedBundle={selectedBundle}
              activeLeg={activeLegForSelected}
              actions={actions}
              settings={settings}
              divisions={divisions}
              refreshAll={refreshAll}
            />
          </div>
        )}
      </div>
    </div>
  )
}

interface CoverageQueueCardProps {
  row: ShipmentRow
  customers: CustomerRecord[]
  activeLeg: LoadCarrierRecord | null
  postings: ShipmentPostingRecord[]
  offers: (QuoteRecord & { vetting: CarrierOfferVetting })[]
  selected: boolean
  onClick: () => void
}

function CoverageQueueCard({ row, customers, activeLeg, postings, offers, selected, onClick }: CoverageQueueCardProps) {
  const customer = row.customerId ? customers.find((c) => c.id === row.customerId) : undefined
  const customerName = customer?.name ?? row.customerName ?? '—'

  const state = coverageStateOf({
    assignmentType: row.assignmentType,
    loadStatus: row.loadStatus,
    carrierId: activeLeg?.carrierId ?? null,
    dispatchedAt: activeLeg?.dispatchedAt ?? null,
    rateConSignedAt: activeLeg?.rateConSignedAt ?? null,
  })

  const posted = postedBoardLabels(postings)

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="coverage-card"
      data-selected={selected}
      className={`w-full text-left rounded-lg border p-3 transition-colors hover:bg-[var(--tms-surface-hover)] ${
        selected ? 'ring-1 ring-[var(--tms-primary)] bg-[var(--tms-surface-selected)]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{row.number}</span>
            <span className="truncate text-sm font-medium">{customerName}</span>
          </div>
          <div className="mt-1 text-sm tms-muted truncate">{laneLabel(row)}</div>
          <div className="mt-1 text-xs tms-muted">
            {row.shipDate ? `PU ${formatDateTime(row.shipDate)}` : 'No pickup appointment'}
          </div>
        </div>
        <TmsBadge tone={COVERAGE_TONE[state]}>{COVERAGE_LABEL[state]}</TmsBadge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <Fact label="Equipment" value={row.equipmentType ?? '—'} />
        <Fact label="Commodity" value={row.commodity ?? '—'} />
        <Fact label="Customer rate" value={row.revenueCents != null ? `$${formatCents(row.revenueCents)}` : '—'} />
        <Fact label="Posted" value={posted} />
      </div>

      {offers.length > 0 && (
        <div className="mt-2 text-xs tms-muted" data-testid="offer-count">
          Offers ({offers.length})
        </div>
      )}
    </button>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs tms-muted">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}

interface ActiveLegCardProps {
  leg: LoadCarrierRecord | null
}

function ActiveLegCard({ leg }: ActiveLegCardProps) {
  return (
    <TmsCard title="Covering now">
      {leg ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Fact label="Carrier" value={leg.carrierName ?? '—'} />
          <Fact label="MC" value={leg.carrierMc ?? '—'} />
          <Fact
            label="Dispatcher"
            value={
              [leg.dispatcherName, leg.dispatcherPhone].filter(Boolean).join(' · ') || '—'
            }
          />
          <Fact label="Driver" value={leg.driverName ?? '—'} />
          <Fact
            label="Rate"
            value={leg.carrierRateCents != null ? `$${formatCents(leg.carrierRateCents)}` : '—'}
          />
          <Fact
            label="Rate con"
            value={RATE_CON_STATUS_LABELS[leg.rateConStatus ?? 'NOT_SENT']}
          />
        </dl>
      ) : (
        <p className="text-sm tms-muted">Nothing is covering this shipment yet.</p>
      )}
    </TmsCard>
  )
}

interface SuggestionsCardProps {
  suggestions: SuggestedCarrier[]
  selectedBundle: ShipmentBundle | null
  activeLeg: LoadCarrierRecord | null
  actions: ShipmentActions
  settings: TmsSettings | null
  divisions: Division[]
  refreshAll: () => Promise<void>
}

function SuggestionsCard({
  suggestions,
  selectedBundle,
  activeLeg,
  actions,
  settings,
  divisions,
  refreshAll,
}: SuggestionsCardProps) {
  const handleAssign = useCallback(
    async (suggestion: SuggestedCarrier) => {
      if (!selectedBundle) return
      try {
        await actions.bookCarrier({
          carrierId: suggestion.carrier.id,
          carrierRateCents: suggestion.lastRateCents ?? 0,
        })
        toast.success(`${suggestion.carrier.name} assigned`)
        await actions.reload()
        await refreshAll()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not assign carrier')
      }
    },
    [actions, refreshAll, selectedBundle],
  )

  const handleSendRateCon = useCallback(
    async (suggestion: SuggestedCarrier) => {
      if (!selectedBundle) return
      const loadCarrier = selectedBundle.loadCarriers.find(
        (lc) => lc.status === 'ACTIVE' && lc.carrierId === suggestion.carrier.id,
      )
      if (!loadCarrier) {
        toast.error('This carrier is not actively covering the shipment.')
        return
      }
      try {
        const carrierBundle = await getCarrierBundle(suggestion.carrier.id)
        const doc = await buildRateConPdf(
          buildRateConInput(
            selectedBundle,
            loadCarrier,
            carrierBundle.carrier,
            settings,
            divisions,
          ),
        )
        const to = rateConRecipients(carrierBundle.carrier, carrierBundle.contacts)
        if (to.length === 0) {
          toast.error('No rate-con recipient found for this carrier.')
          return
        }
        await actions.sendRateCon({
          loadCarrierId: loadCarrier.id,
          pdfBase64: rateConPdfBase64(doc),
          to,
          expiresHours: 72,
        })
        toast.success('Rate con sent')
        await actions.reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not send rate con')
      }
    },
    [actions, divisions, settings, selectedBundle],
  )

  return (
    <TmsCard title="Suggested carriers">
      {suggestions.length === 0 ? (
        <p className="text-sm tms-muted">No carriers have run this lane before.</p>
      ) : (
        <div className="space-y-3">
          {suggestions.map((suggestion) => (
            <SuggestionRow
              key={suggestion.carrier.id}
              suggestion={suggestion}
              active={activeLeg?.carrierId === suggestion.carrier.id}
              busy={actions.busy}
              onAssign={() => { void handleAssign(suggestion) }}
              onSendRateCon={() => { void handleSendRateCon(suggestion) }}
            />
          ))}
        </div>
      )}
    </TmsCard>
  )
}

interface SuggestionRowProps {
  suggestion: SuggestedCarrier
  active: boolean
  busy: boolean
  onAssign: () => void
  onSendRateCon: () => void
}

function SuggestionRow({ suggestion, active, busy, onAssign, onSendRateCon }: SuggestionRowProps) {
  const { carrier, loadsOnLane, lastRateCents, lastLoadAt, flags, clean } = suggestion
  return (
    <div
      className={`rounded border p-3 ${clean ? '' : 'bg-[var(--tms-surface-subtle)]'}`}
      data-testid="suggested-carrier"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{carrier.name}</div>
          <div className="text-xs tms-muted">MC {carrier.mcNumber ?? '—'}</div>
        </div>
        <div className="text-right text-xs tms-muted shrink-0">
          <div>{loadsOnLane} load{loadsOnLane === 1 ? '' : 's'} on lane</div>
          {lastLoadAt && <div>last {formatDateTime(lastLoadAt)}</div>}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {flags.length === 0 ? (
          <TmsBadge tone="green">Clean</TmsBadge>
        ) : (
          flags.map((flag) => <TmsBadge key={flag} tone="red">{flag}</TmsBadge>)
        )}
      </div>

      <div className="mt-2 text-sm tms-muted">
        Last rate{' '}
        {lastRateCents != null ? `$${formatCents(lastRateCents)}` : '—'}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <TmsButton
          size="sm"
          variant="primary"
          disabled={busy || active}
          onClick={onAssign}
        >
          {active ? 'Assigned' : 'Assign carrier'}
        </TmsButton>
        <TmsButton
          size="sm"
          disabled={busy || !active}
          onClick={onSendRateCon}
        >
          Send rate con
        </TmsButton>
      </div>
    </div>
  )
}
