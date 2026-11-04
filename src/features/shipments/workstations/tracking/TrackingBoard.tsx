/**
 * Load Tracking: every shipment whose rate confirmation went out, in the shared dense grid.
 *
 * - Header filters per column (type-ahead, multi-select, date range, numeric range), click-to-sort,
 *   column chooser, drag reorder and resize, all persisted per user.
 * - Group by (default Assignee) in the header bar, with My loads / All / Unassigned quick tabs.
 * - A row click opens the shipment's own Tracking tab: the board has no detail pane, so the
 *   shipment page and this table can never drift. Rows are stamped with
 *   data-testid="tracking-row", data-status, data-shipment-id and data-tracker-id.
 */
import { useCallback, useMemo, useState } from 'react'
import { Heart, Link2, MoreHorizontal, Plus, Search, X } from 'lucide-react'
import { TrackerPicker } from '@/components/TrackerPicker'
import { BoardMapView } from '../../board/BoardMapView'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import {
  ClearFiltersButton,
  ColumnsButton,
  DensityToggle,
  DenseKpiStrip,
  SummaryToggle,
  type DenseKpi,
} from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount,
  filterRows,
  nextSort,
  orderByGroup,
  reorderKeys,
  sortDenseRows,
  type DenseColumnFilter,
  type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { TmsBadge, TmsButton, TmsIconButton, TmsInput, TmsSegmentedTabs, TmsSelect, type TmsTone } from '@/features/tms/kit'
import { formatBoardDateTime } from '@/lib/date'
import { CHECK_CALL_TYPE_LABELS } from '@/lib/checkCalls'
import type { EffectiveTrackingPrefs } from '@/lib/trackingPrefs'
import { boardStatusOf, type BoardStatusKey, type ShipmentRow } from '../../shipmentViews'
import { relativeTime as relativeTimeOf } from '../motion'
import {
  POD_LABELS,
  TRACKING_ACTIONS_COLUMN,
  TRACKING_DEFAULT_COLUMNS,
  TRACKING_GROUPERS,
  motionText,
  nextCheckMinutes,
  docsText,
  trackingColumns,
} from './trackingColumns'
import { nextEventText } from './nextEventText'
import {
  UNASSIGNED_KEY,
  durationText,
  etaOf,
  focusRows,
  hasDocsToReview,
  hasException,
  isCheckCallDue,
  nextCheckCallStateOf,
  podStateOf,
  type PodState,
  type TrackingFocus,
} from './trackingTable'
import type { TrackingBoardProps } from './types'

/** Rows one page holds; "Show more" adds another page. The grid virtualises, so the DOM stays small. */
const PAGE_SIZE = 100

const LIFECYCLE_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'pod', label: 'POD due' },
  { key: 'closed', label: 'Closed' },
]

const VIEW_TABS = [
  { key: 'table', label: 'Table View' },
  { key: 'map', label: 'Map View' },
]

const GROUP_OPTIONS = [
  ...Object.entries(TRACKING_GROUPERS).map(([value, g]) => ({ value, label: g.label })),
  { value: 'none', label: 'None' },
]

const STATUS_TONES: Record<BoardStatusKey | 'CANCELED', TmsTone> = {
  OPEN: 'blue',
  COVERED: 'turquoise',
  DISPATCHED: 'blue',
  ARRIVED: 'blue',
  DEPARTED: 'blue',
  DELIVERED: 'green',
  HOLD: 'orange',
  RESERVED: 'turquoise',
  VOIDED: 'red',
  CANCELED: 'red',
}

const POD_TONES: Record<Exclude<PodState, 'NOT_DUE'>, TmsTone> = {
  NEEDED: 'orange',
  REQUESTED: 'blue',
  IN_REVIEW: 'turquoise',
  RECEIVED: 'green',
  UNKNOWN: 'gray',
}

function lateText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} d`
}

const FOCUS_EMPTY: Record<TrackingFocus, string> = {
  checkcalls: 'No check calls are due.',
  docs: 'No carrier uploads are waiting on review.',
  exceptions: 'No open exceptions.',
}

function modeText(p: EffectiveTrackingPrefs): string {
  if (p.mode === 'MANUAL') return 'Manual'
  return p.mode === 'AGENT' ? 'Agent' : 'Not set'
}

function emptyMessage(props: Pick<TrackingBoardProps, 'activeAssignee' | 'includeUnsent' | 'lifecycle'>): string {
  if (props.activeAssignee === 'me') return 'Nothing assigned to you — pick All.'
  if (props.activeAssignee !== 'all') return 'Nothing in this view.'
  if (!props.includeUnsent && props.lifecycle === 'active') return 'No shipments with a sent rate confirmation yet.'
  return 'No shipments in this view.'
}

export function TrackingBoard(props: TrackingBoardProps) {
  const {
    rows,
    assigneeTabs,
    activeAssignee,
    onSelectAssignee,
    lifecycle,
    onLifecycle,
    includeUnsent,
    onIncludeUnsent,
    loading,
    error,
    nowMs,
    mapsKey,
    mapsMapId,
    query,
    setQuery,
    favorites,
    onToggleFavorite,
    onOpenShipment,
    onCreateShipment,
    onCreateCustomerUrl,
    onRequestCheckCall,
    onRequestPod,
    onLogCheckCall,
    onSnooze,
    onReviewDocs,
    focus,
    onFocus,
    graceMinutes,
    prefsOf,
    onAssignTracker,
    email,
    nameOf,
    recent,
    onOpenRecent,
    onRemoveRecent,
  } = props

  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [mapVisible, setMapVisible] = useState(false)
  const [filters, setFilters] = useState<DenseFilters>({})
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  const allColumns = useMemo(() => trackingColumns({ nowMs, nameOf, prefsOf }), [nowMs, nameOf, prefsOf])
  const prefs = useDenseGridPrefs({
    gridId: 'tracking',
    email,
    defaultColumns: TRACKING_DEFAULT_COLUMNS,
    validKeys: allColumns.map((c) => c.key),
    defaultSort: { key: 'lastLocation', dir: 'asc' },
    defaultGroupBy: 'assignee',
  })
  const gridColumns = useMemo(
    () => [...prefs.columns.map((k) => allColumns.find((c) => c.key === k)).filter((c) => c != null), TRACKING_ACTIONS_COLUMN],
    [prefs.columns, allColumns],
  )

  const focused = useMemo(() => focusRows(rows, focus, nowMs, graceMinutes), [rows, focus, nowMs, graceMinutes])
  const fitRows = useMemo(() => (favoritesOnly ? focused.filter((r) => favorites.has(r.id)) : focused), [focused, favoritesOnly, favorites])
  const focusTabs = useMemo(
    () => [
      { key: 'all', label: 'All' },
      { key: 'checkcalls', label: 'Check calls due', count: rows.filter((r) => isCheckCallDue(r, nowMs, graceMinutes)).length },
      { key: 'docs', label: 'Docs to review', count: rows.filter(hasDocsToReview).length },
      { key: 'exceptions', label: 'Exceptions', count: rows.filter(hasException).length },
    ],
    [rows, nowMs, graceMinutes],
  )
  const grouper = prefs.groupBy ? TRACKING_GROUPERS[prefs.groupBy] : undefined
  const { ordered, groups } = useMemo(() => {
    const filtered = filterRows(fitRows, allColumns, filters)
    const sorted = sortDenseRows(filtered, allColumns, prefs.sort)
    if (!grouper) return { ordered: sorted, groups: [] }
    const grouped = orderByGroup(sorted, (r) => grouper.describe(r, nameOf), grouper.firstKey)
    return { ordered: grouped.rows, groups: grouped.groups }
  }, [fitRows, allColumns, filters, prefs.sort, grouper, nameOf])
  const shown = useMemo(() => ordered.slice(0, pageSize), [ordered, pageSize])
  const hidden = ordered.length - shown.length
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const setColumnFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setFilters((prev) => {
      const copy = { ...prev }
      if (next) copy[key] = next
      else delete copy[key]
      return copy
    })
    setPageSize(PAGE_SIZE)
  }, [])

  const rowAttrs = useCallback(
    (row: ShipmentRow) => ({
      'data-testid': 'tracking-row',
      'data-status': boardStatusOf(row),
      'data-shipment-id': row.id,
      'data-tracker-id': row.trackerId ?? '',
    }),
    [],
  )

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const toggleAll = useCallback(() => {
    const ids = shown.map((r) => r.id)
    setSelectedIds((prev) => (ids.every((id) => prev.includes(id)) ? prev.filter((id) => !ids.includes(id)) : [...new Set([...prev, ...ids])]))
  }, [shown])

  const reassign = useCallback(async (ids: string[], trackerId: string | null) => {
    await onAssignTracker(ids, trackerId)
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)))
  }, [onAssignTracker])

  const renderCell = useCallback(
    (row: ShipmentRow, key: string) => {
      switch (key) {
        case 'shipment':
          return (
            <ShipmentCell
              row={row}
              onOpen={() => onOpenShipment(row.id)}
              favorites={favorites}
              onToggleFavorite={() => onToggleFavorite(row.id)}
            />
          )
        case 'customer':
          return <span>{row.customerName ?? '—'}</span>
        case 'lane':
          return <span>{row.originCity ?? '—'} → {row.destinationCity ?? '—'}</span>
        case 'pickup':
          return <span>{row.pickupAppt ? formatBoardDateTime(row.pickupAppt) : '—'}</span>
        case 'delivery':
          return <span>{row.deliveryAppt ? formatBoardDateTime(row.deliveryAppt) : '—'}</span>
        case 'status':
          return <StatusCell row={row} nowMs={nowMs} />
        case 'lastLocation':
          return <LastLocationCell row={row} nowMs={nowMs} />
        case 'ping':
          return <span>{relativeTimeOf(row.lastUpdateAt ?? row.lastKnownAt, nowMs) ?? '—'}</span>
        case 'eta':
          return <EtaCell row={row} nowMs={nowMs} />
        case 'nextCheck':
          return <NextCheckCallCell row={row} nowMs={nowMs} />
        case 'pod':
          return <PodCell row={row} />
        case 'carrier':
          return <CarrierCell row={row} />
        case 'tracker':
          return <TrackerCell row={row} />
        case 'checkCalls':
          return <CheckCallsCell row={row} nowMs={nowMs} />
        case 'docs':
          return <DocsCell row={row} />
        case 'mode':
          return prefsOf ? <span>{modeText(prefsOf(row))}</span> : null
        case 'actions':
          return (
            <RowMenu
              row={row}
              onOpen={() => onOpenShipment(row.id)}
              onCreateCustomerUrl={() => onCreateCustomerUrl(row)}
              onRequestCheckCall={() => onRequestCheckCall(row)}
              onRequestPod={() => onRequestPod(row)}
              onLogCheckCall={() => onLogCheckCall(row)}
              onSnooze={() => onSnooze(row)}
              onReviewDocs={() => onReviewDocs(row)}
              onAssignTracker={(trackerId) => onAssignTracker([row.id], trackerId)}
            />
          )
        default:
          return null
      }
    },
    [favorites, onOpenShipment, onToggleFavorite, onCreateCustomerUrl, onRequestCheckCall, onRequestPod, onLogCheckCall, onSnooze, onReviewDocs, onAssignTracker, nowMs, prefsOf],
  )

  const kpis = useMemo<DenseKpi[]>(() => {
    if (!prefs.kpiOpen) return []
    let moving = 0
    let overdue = 0
    let late = 0
    let unassigned = 0
    let podNeeded = 0
    let docsReview = 0
    for (const r of ordered) {
      if (motionText(r, nowMs) === 'Moving') moving += 1
      if ((nextCheckMinutes(r, nowMs) ?? 0) < 0) overdue += 1
      if (etaOf(r, nowMs)?.lateMinutes) late += 1
      if (!r.trackerId) unassigned += 1
      if (podStateOf(r) === 'NEEDED') podNeeded += 1
      if (hasDocsToReview(r)) docsReview += 1
    }
    return [
      { label: 'Loads', value: ordered.length },
      { label: 'Moving', value: moving, tone: 'good' },
      { label: 'Check calls overdue', value: overdue, tone: overdue > 0 ? 'bad' : undefined },
      { label: 'Running late', value: late, tone: late > 0 ? 'warn' : undefined },
      { label: 'Unassigned', value: unassigned, tone: unassigned > 0 ? 'warn' : undefined },
      { label: 'POD needed', value: podNeeded, tone: podNeeded > 0 ? 'warn' : undefined },
      { label: 'Docs to review', value: docsReview, tone: docsReview > 0 ? 'warn' : undefined },
    ]
  }, [prefs.kpiOpen, ordered, nowMs])

  const groupLabels = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups])
  const renderGroupHeader = useCallback(
    (key: string, shownRows: ShipmentRow[]) => {
      const group = groupLabels.get(key)
      const selectedHere = shownRows.filter((r) => selectedSet.has(r.id)).map((r) => r.id)
      const count = group?.count ?? shownRows.length
      return (
        <>
          <span className="tms-tracking-group-title">
            {prefs.groupBy === 'assignee' && key === UNASSIGNED_KEY ? <TmsBadge tone="orange">{group?.label ?? 'Unassigned'}</TmsBadge> : group?.label ?? key}
          </span>
          <span className="tms-tracking-group-count" aria-label={`${count} shipment${count === 1 ? '' : 's'}`}>{count}</span>
          {prefs.groupBy === 'assignee' && selectedHere.length > 0 && (
            <span className="tms-tracking-group-reassign">
              <TrackerPicker
                value={null}
                allowClear={false}
                aria-label={`Reassign ${selectedHere.length} selected`}
                placeholder={`Reassign ${selectedHere.length} selected to…`}
                onChange={(id) => { if (id) void reassign(selectedHere, id) }}
              />
            </span>
          )}
        </>
      )
    },
    [groupLabels, selectedSet, prefs.groupBy, reassign],
  )

  const filterCount = activeFilterCount(filters)
  const unassignedCount = assigneeTabs.find((t) => t.key === UNASSIGNED_KEY)?.count ?? 0

  return (
    <div className="tms-dense-page tms-tracking-board">
      <div className="tms-dense-bar">
        <span className="tms-dense-title">Load tracking</span>
        <Search size={14} className="tms-muted" aria-hidden="true" />
        <TmsInput
          placeholder="Search shipments..."
          aria-label="Search shipments"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPageSize(PAGE_SIZE) }}
          className="tms-dense-search"
        />
        {!focus && (
          <TmsSegmentedTabs
            aria-label="Shipment lifecycle"
            size="sm"
            tabs={LIFECYCLE_TABS}
            active={lifecycle}
            onSelect={(key) => onLifecycle(key as typeof lifecycle)}
          />
        )}
        <div data-testid="tracking-focus-tabs">
          <TmsSegmentedTabs
            aria-label="Focus"
            size="sm"
            tabs={focusTabs}
            active={focus ?? 'all'}
            onSelect={(key) => onFocus(key === 'all' ? null : (key as TrackingFocus))}
          />
        </div>
        <div data-testid="tracking-assignee-tabs">
          <TmsSegmentedTabs aria-label="Assignee" size="sm" tabs={assigneeTabs} active={activeAssignee} onSelect={onSelectAssignee} />
        </div>
        {unassignedCount > 0 && activeAssignee !== UNASSIGNED_KEY && <TmsBadge tone="orange">{unassignedCount} unassigned</TmsBadge>}
        <label className="tms-dense-group-by">
          Group by
          <TmsSelect
            aria-label="Group by"
            className="tms-dense-select"
            value={prefs.groupBy ?? 'none'}
            onChange={(e) => { prefs.setGroupBy(e.target.value === 'none' ? null : e.target.value); setPageSize(PAGE_SIZE) }}
            options={GROUP_OPTIONS}
          />
        </label>
        <TmsButton
          size="sm"
          variant={includeUnsent ? 'primary' : 'secondary'}
          aria-pressed={includeUnsent}
          title="Also list loads whose rate confirmation was not sent through the TMS (Aljex-era or own-fleet loads)"
          onClick={() => onIncludeUnsent(!includeUnsent)}
        >
          Include loads without a TMS rate con
        </TmsButton>
        <TmsButton size="sm" variant={favoritesOnly ? 'primary' : 'secondary'} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)}>
          <Heart size={14} /> My Favorites
        </TmsButton>
        <ClearFiltersButton count={filterCount} onClear={() => { setFilters({}); setPageSize(PAGE_SIZE) }} />
        <span className="tms-dense-spacer" />
        <TmsButton
          size="sm"
          variant="secondary"
          disabled={shown.length === 0}
          title={shown.length === 0 ? 'No shipment in view' : `Create a customer link for ${shown[0].number}`}
          onClick={() => { if (shown[0]) onCreateCustomerUrl(shown[0]) }}
        >
          <Link2 size={14} /> Create Customer URL
        </TmsButton>
        <TmsButton size="sm" variant="primary" onClick={onCreateShipment}>
          <Plus size={14} /> Create Shipment
        </TmsButton>
        <ColumnsButton
          catalog={allColumns}
          columns={prefs.columns}
          widths={prefs.widths}
          pinned={prefs.pinned}
          onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
        />
        <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
        <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} />
        <TmsSegmentedTabs
          className="tms-tracking-view-toggle"
          aria-label="Table or map"
          size="sm"
          tabs={VIEW_TABS}
          active={mapVisible ? 'map' : 'table'}
          onSelect={(key) => setMapVisible(key === 'map')}
        />
      </div>
      <DenseKpiStrip open={prefs.kpiOpen} items={kpis} />
      {recent.length > 0 && (
        <div className="tms-tracking-recent-row">
          <span className="tms-tracking-recent-label">Recently viewed loads</span>
          {recent.map((r) => (
            <span key={r.id} className="tms-tracking-recent-chip">
              <button type="button" className="tms-tracking-recent-pro" onClick={() => onOpenRecent(r.id)}>
                {r.number}
              </button>
              <TmsIconButton shape="plain" aria-label={`Remove ${r.number} from recently viewed`} onClick={() => onRemoveRecent(r.id)}>
                <X size={10} />
              </TmsIconButton>
            </span>
          ))}
        </div>
      )}
      {error && <p className="tms-tracking-error">{error}</p>}
      <div className="tms-dense-body" data-testid="tracking-list">
        {loading && rows.length === 0 ? (
          <p className="tms-tracking-empty">Loading shipments…</p>
        ) : mapVisible && ordered.length > 0 ? (
          <BoardMapView rows={ordered} apiKey={mapsKey} mapId={mapsMapId} onOpenShipment={onOpenShipment} />
        ) : (
          <DenseGrid<ShipmentRow>
            aria-label="Load tracking"
            recentKey={`tms:tracking:recent:${email ?? 'anon'}`}
            resetKey={`${query}|${lifecycle}|${activeAssignee}|${focus ?? ''}|${includeUnsent}|${favoritesOnly}|${prefs.groupBy}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
            columns={gridColumns}
            rows={shown}
            fitRows={fitRows}
            rowKey={(r) => r.id}
            renderCell={renderCell}
            density={prefs.density}
            userWidths={prefs.widths}
            stickyCount={Math.max(1, prefs.pinned.length)}
            sort={prefs.sort}
            onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
            filters={filters}
            onFilterChange={setColumnFilter}
            onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
            onResize={prefs.setWidth}
            selectable
            selectedIds={selectedSet}
            onToggle={toggleOne}
            onToggleAll={toggleAll}
            onRowClick={(row) => onOpenShipment(row.id)}
            rowAttrs={rowAttrs}
            groupKeyOf={grouper ? (row) => grouper.describe(row, nameOf).key : undefined}
            renderGroupHeader={renderGroupHeader}
            empty={
              <span data-testid="tracking-empty">
                {rows.length === 0 ? emptyMessage({ activeAssignee, includeUnsent, lifecycle }) : fitRows.length === 0 && focus ? FOCUS_EMPTY[focus] : 'No shipments match the column filters.'}
              </span>
            }
          />
        )}
      </div>
      <div className="tms-dense-foot">
        <span>
          <strong>{ordered.length}</strong> shipment{ordered.length === 1 ? '' : 's'}
          {hidden > 0 && <> · showing {shown.length}</>}
        </span>
        {hidden > 0 && (
          <TmsButton size="sm" onClick={() => setPageSize((n) => n + PAGE_SIZE)}>
            {`Show ${Math.min(hidden, PAGE_SIZE)} more`}
          </TmsButton>
        )}
        {selectedIds.length > 0 && <span>{selectedIds.length} selected</span>}
      </div>
    </div>
  )
}

function ShipmentCell({
  row,
  favorites,
  onOpen,
  onToggleFavorite,
}: {
  row: ShipmentRow
  favorites: Set<string>
  onOpen: () => void
  onToggleFavorite: () => void
}) {
  return (
    <div className="tms-tracking-shipment-cell">
      <button
        type="button"
        className="tms-tracking-favorited"
        onClick={(e) => { e.stopPropagation(); onToggleFavorite() }}
        aria-label={favorites.has(row.id) ? 'Unfavorite' : 'Favorite'}
      >
        <Heart size={14} fill={favorites.has(row.id) ? 'currentColor' : 'none'} />
      </button>
      <button type="button" className="tms-tracking-pro" onClick={(e) => { e.stopPropagation(); onOpen() }}>
        {row.number}
      </button>
    </div>
  )
}

function StatusCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const status = boardStatusOf(row)
  const event = nextEventText(row, nowMs)
  return (
    <div className="tms-tracking-status-cell">
      <TmsBadge tone={row.trackingFlaggedAt ? 'red' : STATUS_TONES[status]}>{status}</TmsBadge>
      {event && <span className="tms-tracking-next-event">{event}</span>}
      {row.trackingFlaggedAt && (
        <TmsBadge tone="red" title={row.trackingFlagReason ?? 'Tracking escalation'}>
          Tracking flag
        </TmsBadge>
      )}
    </div>
  )
}

function LastLocationCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const place = row.lastUpdatePlace ?? row.lastKnownCity ?? '—'
  const when = relativeTimeOf(row.lastUpdateAt ?? row.lastKnownAt, nowMs)
  const text = motionText(row, nowMs)
  const tone: TmsTone = text === 'Moving' ? 'green' : text === 'Stopped' ? 'orange' : 'gray'
  return (
    <div className="tms-tracking-tracking-cell">
      <span>{place}</span>
      <TmsBadge tone={tone}>{text}</TmsBadge>
      {when && <span className="tms-tracking-last-place">{when}</span>}
    </div>
  )
}

function EtaCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const eta = etaOf(row, nowMs)
  if (!eta) return <span className="tms-tracking-cell-muted">—</span>
  return (
    <div className="tms-tracking-nextstop-cell" title={eta.estimated ? 'Estimate from the last ping' : 'Reported by the carrier'}>
      <span>
        {formatBoardDateTime(eta.at)}
        {eta.estimated && <span className="tms-tracking-cell-muted"> est.</span>}
      </span>
      {eta.lateMinutes ? <TmsBadge tone="red">Late {lateText(eta.lateMinutes)}</TmsBadge> : null}
    </div>
  )
}

function NextCheckCallCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const next = nextCheckCallStateOf(row, nowMs)
  if (next.kind === 'NONE') return <span className="tms-tracking-cell-muted">—</span>
  if (next.kind === 'OVERDUE') return <TmsBadge tone="red" title={formatBoardDateTime(next.at)}>overdue {durationText(next.minutes)}</TmsBadge>
  return <span title={formatBoardDateTime(next.at)}>in {durationText(next.minutes)}</span>
}

function PodCell({ row }: { row: ShipmentRow }) {
  const state = podStateOf(row)
  if (state === 'NOT_DUE') return <span className="tms-tracking-cell-muted">—</span>
  return <TmsBadge tone={POD_TONES[state]}>{POD_LABELS[state]}</TmsBadge>
}

function CheckCallsCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const next = nextCheckCallStateOf(row, nowMs)
  const last = row.lastCheckCallType
    ? `${(CHECK_CALL_TYPE_LABELS as Record<string, string>)[row.lastCheckCallType] ?? row.lastCheckCallType} ${relativeTimeOf(row.lastCheckCallAt ?? null, nowMs) ?? ''}`.trim()
    : null
  if (!last && next.kind === 'NONE' && !hasException(row)) return <span className="tms-tracking-cell-muted">—</span>
  return (
    <span className="tms-tracking-tracking-cell">
      {last && <span>{last}</span>}
      {next.kind === 'OVERDUE' && <TmsBadge tone="red" title={formatBoardDateTime(next.at)}>overdue {durationText(next.minutes)}</TmsBadge>}
      {next.kind === 'UPCOMING' && <span className="tms-tracking-cell-muted" title={formatBoardDateTime(next.at)}>due in {durationText(next.minutes)}</span>}
      {hasException(row) && <TmsBadge tone="red">{row.openIncidentCount} exception{row.openIncidentCount === 1 ? '' : 's'}</TmsBadge>}
    </span>
  )
}

function DocsCell({ row }: { row: ShipmentRow }) {
  if (hasDocsToReview(row)) return <TmsBadge tone="orange">{row.pendingDocReviewCount} to review</TmsBadge>
  const text = docsText(row)
  return <span className="tms-tracking-cell-muted">{text || '—'}</span>
}

function TrackerCell({ row }: { row: ShipmentRow }) {
  if (!row.trackerId) return <TmsBadge tone="orange">Unassigned</TmsBadge>
  return <span className="tms-tracking-team-cell">{row.trackerName ?? row.trackerId}</span>
}

function CarrierCell({ row }: { row: ShipmentRow }) {
  if (!row.carrierName && !row.carrierMc && !row.carrierDot) {
    return <span className="tms-tracking-cell-muted">—</span>
  }
  return (
    <div>
      <span>{row.carrierName ?? '—'}</span>
      <span className="tms-tracking-cell-muted">
        DOT {row.carrierDot ?? '—'} · MC {row.carrierMc ?? '—'}
      </span>
    </div>
  )
}

function RowMenu({
  row,
  onOpen,
  onCreateCustomerUrl,
  onRequestCheckCall,
  onRequestPod,
  onLogCheckCall,
  onSnooze,
  onReviewDocs,
  onAssignTracker,
}: {
  row: ShipmentRow
  onOpen: () => void
  onCreateCustomerUrl: () => void
  onRequestCheckCall: () => Promise<void>
  onRequestPod: () => Promise<void>
  onLogCheckCall: () => Promise<void>
  onSnooze: () => Promise<void>
  onReviewDocs: () => void
  onAssignTracker: (trackerId: string | null) => Promise<void>
}) {
  const [assigning, setAssigning] = useState(false)
  const [busy, setBusy] = useState(false)
  // The menu is position: fixed under the trigger so the grid's scroll container cannot clip it.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const place = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setAnchor({ top: rect.bottom, right: Math.max(8, window.innerWidth - rect.right) })
  }
  const status = boardStatusOf(row)
  const voided = status === 'VOIDED'
  const checkCallReason = voided ? 'This shipment is voided.' : undefined
  const podReason = voided ? 'This shipment is voided.' : status !== 'DELIVERED' ? 'A POD is requested once the shipment is delivered.' : undefined

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`tms-tracking-rowmenu${assigning ? ' tms-open' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={(e) => place(e.currentTarget)}
      onFocus={(e) => place(e.currentTarget)}
    >
      <TmsIconButton shape="plain" aria-label="Row actions">
        <MoreHorizontal size={14} />
      </TmsIconButton>
      <div className="tms-tracking-rowmenu-menu" style={anchor ? { position: 'fixed', top: anchor.top, right: anchor.right } : undefined}>
        <button type="button" className="tms-tracking-rowmenu-item" onClick={onOpen}>
          Open shipment
        </button>
        <button type="button" className="tms-tracking-rowmenu-item" onClick={onCreateCustomerUrl}>
          Create customer URL
        </button>
        <button
          type="button"
          className="tms-tracking-rowmenu-item"
          disabled={busy || voided}
          title={checkCallReason}
          onClick={() => { void run(onLogCheckCall) }}
        >
          Log check call…
        </button>
        <button
          type="button"
          className="tms-tracking-rowmenu-item"
          disabled={busy || voided}
          title={checkCallReason}
          onClick={() => { void run(onSnooze) }}
        >
          Snooze 1 h
        </button>
        <button
          type="button"
          className="tms-tracking-rowmenu-item"
          disabled={!hasDocsToReview(row)}
          title={hasDocsToReview(row) ? undefined : 'No carrier upload is waiting on review.'}
          onClick={onReviewDocs}
        >
          Review documents…
        </button>
        <button
          type="button"
          className="tms-tracking-rowmenu-item"
          disabled={busy || Boolean(checkCallReason)}
          title={checkCallReason}
          onClick={() => { void run(onRequestCheckCall) }}
        >
          Request check call
        </button>
        <button
          type="button"
          className="tms-tracking-rowmenu-item"
          disabled={busy || Boolean(podReason)}
          title={podReason}
          onClick={() => { void run(onRequestPod) }}
        >
          Request POD
        </button>
        <button
          type="button"
          className="tms-tracking-rowmenu-item"
          disabled={voided}
          title={voided ? 'This shipment is voided.' : undefined}
          aria-expanded={assigning}
          onClick={() => setAssigning((v) => !v)}
        >
          Assign tracker…
        </button>
        {assigning && (
          <div className="tms-tracking-rowmenu-picker">
            <TrackerPicker
              value={row.trackerId ?? null}
              aria-label={`Tracker for ${row.number}`}
              onChange={(id) => {
                setAssigning(false)
                void run(() => onAssignTracker(id))
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
