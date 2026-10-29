/**
 * The Dispatch workstation — a coverage workbench, not the shipments board.
 *
 * Left: the shared board filter panel narrowed to freight that still needs or just
 * got coverage (OPEN and COVERED). Right: the coverage queue, and for the selected
 * shipment a "Find coverage" panel that shows what is covering it now, carriers that
 * have run this lane before with their vetting flags, and the assign / rate-con
 * actions from the existing shipment page. Parsed e-mail/SMS carrier offers are
 * explicitly left to Step P.
 *
 * Routing lives in the sidebar agent; this module only renders `/tms/dispatch`.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Truck } from 'lucide-react'
import { toast } from 'sonner'

import { BoardFilterPanel } from '@/features/shipments/board/BoardFilterPanel'
import { useBoardFilters } from '@/features/shipments/board/useBoardFilters'
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
  listCarriers,
  listDivisions,
  listLoadCarriers,
} from '@/lib/apiClient'
import { buildRateConPdf, rateConPdfBase64, type RateConInput } from '@/lib/carrierRateCon'
import { formatDateTime } from '@/lib/date'
import { quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import { formatCents } from '@/lib/tmsDirectory'
import {
  coverageStateOf,
  suggestCarriers,
  RATE_CON_STATUS_LABELS,
  type CoverageState,
  type LaneHistoryEntry,
  type SuggestedCarrier,
} from './coverage'
import {
  EMPTY_BOARD_FILTER_SET,
  type BoardStatusKey,
  type ShipmentRow,
} from '../shipmentViews'
import type {
  CarrierContactRecord,
  CarrierRecord,
  CustomerRecord,
  Division,
  LoadCarrierRecord,
  RateConRequiredField,
  ShipmentBundle,
  TmsSettings,
} from '@/types/tms'

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

const DEFAULT_REQUIRED_FIELDS: RateConRequiredField[] = ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER']

function laneLabel(row: ShipmentRow): string {
  const origin = [row.originCity, row.fromState].filter(Boolean).join(', ') || '—'
  const dest = [row.destinationCity, row.toState].filter(Boolean).join(', ') || '—'
  return `${origin} → ${dest}`
}

function postedLabel(datPostedAt: string | null | undefined): string {
  if (!datPostedAt) return 'Not posted'
  const then = new Date(datPostedAt)
  if (Number.isNaN(then.getTime())) return 'Posted to DAT'
  return `Posted to DAT ${formatDistanceToNow(then, { addSuffix: true })}`
}

function buildRateConInput(
  bundle: ShipmentBundle,
  loadCarrier: LoadCarrierRecord,
  carrier: CarrierRecord,
  settings: TmsSettings | null,
  divisions: Division[],
): RateConInput {
  const load = bundle.loads[0]
  const division = divisions.find((d) => d.key === load?.divisionKey) ?? null

  const charges = bundle.charges
    .filter(
      (c) =>
        c.side === 'CARRIER' &&
        (c.loadCarrierId == null || c.loadCarrierId === loadCarrier.id),
    )
    .map((c) => ({ label: c.label || c.code, amountCents: c.amountCents }))
  const totalCents = charges.reduce((sum, c) => sum + c.amountCents, 0)

  const tier =
    loadCarrier.quickPayDays != null
      ? tierFor(loadCarrier.quickPayDays, quickPayTiersOf(settings))
      : null

  return {
    division,
    carrier: {
      name: carrier.name ?? loadCarrier.carrierName ?? 'Carrier',
      mcNumber: carrier.mcNumber ?? loadCarrier.carrierMc ?? null,
      dotNumber: carrier.dotNumber ?? null,
      phone: carrier.phone ?? null,
      email: carrier.email ?? null,
    },
    loadCarrier,
    loadNumber: load?.loadNumber ?? load?.id ?? '',
    equipmentType: load?.equipmentType ?? null,
    commodity: load?.commodity ?? null,
    weightLbs: load?.weight ?? null,
    stops: (load?.stops ?? []).map((s) => {
      const visibility = (s.refs ?? []).filter(
        (r) => r.visibility === 'CARRIER' || r.visibility === 'ALL',
      )
      return {
        kind: s.type === 'pickup' ? 'PICKUP' : 'DELIVERY',
        name: s.name ?? null,
        address: s.address?.street ?? null,
        city: s.address?.city ?? s.city ?? null,
        state: s.address?.state ?? null,
        zip: s.address?.zip ?? null,
        apptAt: s.appt ?? null,
        apptEnd: s.apptEnd ?? null,
        apptType: s.apptType ?? null,
        references: visibility.map((r) => ({
          label: r.label || r.code,
          value: r.value,
        })),
        instructions: s.stopNotes ?? null,
      }
    }),
    charges,
    totalCents,
    quickPay:
      tier && loadCarrier.quickPayFeeCents != null
        ? {
            days: tier.days,
            feeBps: tier.feeBps,
            feeCents: loadCarrier.quickPayFeeCents,
            netCents: (loadCarrier.carrierRateCents ?? totalCents) - loadCarrier.quickPayFeeCents,
          }
        : null,
    paymentTermsDays:
      loadCarrier.paymentTermsDays ?? settings?.defaultCarrierTermsDays ?? null,
    terms: settings?.rateConTerms ?? '',
    requiredFields:
      (settings?.rateConRequiredFields as RateConRequiredField[] | null) ??
      DEFAULT_REQUIRED_FIELDS,
  }
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
  const [loadingBundle, setLoadingBundle] = useState(false)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [divisions, setDivisions] = useState<Division[]>([])
  // A bundle from a previous selection must never be read as this one's.
  const selectedBundle = loadedBundle && loadedBundle.shipment.id === selectedId ? loadedBundle : null

  useEffect(() => {
    let live = true
    listDivisions().then((d) => { if (live) setDivisions(d) }).catch(() => {})
    return () => { live = false }
  }, [])
  // The fetch owns every state change: clearing the panel synchronously here would
  // re-render the whole queue on each selection for no visible gain. A bundle that
  // belongs to a different shipment is ignored at the point it is read, below.
  useEffect(() => {
    if (!selectedId) return
    let live = true
    getShipmentBundle(selectedId)
      .then((bundle) => { if (live) { setSelectedBundle(bundle); setBundleError(null) } })
      .catch((err) => { if (live) setBundleError(err instanceof Error ? err.message : 'Could not load shipment') })
      .finally(() => { if (live) setLoadingBundle(false) })
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
                selected={selectedId === row.id}
                onClick={() => { setSelectedId(row.id); setLoadingBundle(true); setBundleError(null) }}
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
            <SuggestionsCard
              suggestions={suggestions}
              selectedBundle={selectedBundle}
              activeLeg={activeLegForSelected}
              actions={actions}
              settings={settings}
              divisions={divisions}
              refreshAll={refreshAll}
            />
            <StepPNotice />
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
  selected: boolean
  onClick: () => void
}

function CoverageQueueCard({ row, customers, activeLeg, selected, onClick }: CoverageQueueCardProps) {
  const customer = row.customerId ? customers.find((c) => c.id === row.customerId) : undefined
  const customerName = customer?.name ?? row.customerName ?? '—'

  const state = coverageStateOf({
    assignmentType: row.assignmentType,
    loadStatus: row.loadStatus,
    carrierId: activeLeg?.carrierId ?? null,
    dispatchedAt: activeLeg?.dispatchedAt ?? null,
    rateConSignedAt: activeLeg?.rateConSignedAt ?? null,
  })

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
        <Fact label="Posted" value={postedLabel(row.datPostedAt)} />
      </div>
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

function rateConRecipients(
  carrier: CarrierRecord,
  contacts: CarrierContactRecord[],
): string[] {
  const fromContacts = contacts
    .filter((c) => c.active !== false && c.email)
    .filter((c) => c.rateConRecipient || c.types?.includes('DISPATCH'))
    .map((c) => c.email as string)
  const fallbacks = [carrier.dispatcherEmail, carrier.email].filter((e): e is string => Boolean(e))
  return Array.from(new Set([...fromContacts, ...fallbacks]))
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

function StepPNotice() {
  return (
    <p className="px-1 text-sm tms-muted">
      Carrier offers parsed from e-mail and text arrive with Step P.
    </p>
  )
}
