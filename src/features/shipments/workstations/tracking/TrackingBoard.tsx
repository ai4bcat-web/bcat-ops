/**
 * The Tracking table: every shipment whose rate confirmation went out, grouped by the
 * person tracking it. One section per assignee (a single section when one assignee tab is
 * selected); each row carries PRO, customer, lane, status with the next event, last
 * location + age + motion, ETA, next check call, POD state, carrier DOT/MC and the tracker.
 *
 * A row click opens the shipment's own Tracking tab — the board has no detail pane, so the
 * shipment page and this table can never drift. Rows are stamped with
 * data-testid="tracking-row", data-status, data-shipment-id and data-tracker-id.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown,
  Filter,
  Heart,
  Link2,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { TrackerPicker } from '@/components/TrackerPicker'
import { BoardFilterPanel } from '../../board/BoardFilterPanel'
import { BoardGrid, type BoardGridColumn, type BoardGridSort } from '../../board/BoardGrid'
import { BoardMapView } from '../../board/BoardMapView'
import { TmsBadge, TmsButton, TmsIconButton, TmsInput, TmsSegmentedTabs, TmsSelect, type TmsTone } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { boardStatusOf, type BoardStatusKey, type ShipmentRow } from '../../shipmentViews'
import { relativeTime as relativeTimeOf, motionOf } from '../motion'
import { nextEventText } from './nextEventText'
import {
  MAX_ASSIGNEE_TABS,
  UNASSIGNED_KEY,
  durationText,
  etaOf,
  nextCheckCallStateOf,
  podStateOf,
  type PodState,
} from './trackingTable'
import type { TrackingBoardProps } from './types'

/** Rows a tracker group draws before "Show more" (a long queue must not mount thousands of rows). */
const GROUP_ROW_CAP = 100

const LIFECYCLE_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'pod', label: 'POD due' },
  { key: 'closed', label: 'Closed' },
]

const VIEW_TABS = [
  { key: 'table', label: 'Table View' },
  { key: 'map', label: 'Map View' },
]

const COLUMNS: BoardGridColumn[] = [
  { key: 'shipment', header: 'Shipment #', sortable: true, width: 150 },
  { key: 'customer', header: 'Customer', sortable: true, width: 160 },
  { key: 'lane', header: 'Lane', sortable: true, width: 230 },
  { key: 'status', header: 'Status', sortable: true, width: 190 },
  { key: 'lastLocation', header: 'Last Location', sortable: true, width: 200 },
  { key: 'eta', header: 'ETA', sortable: true, width: 170 },
  { key: 'nextCheckCall', header: 'Next Check Call', sortable: true, width: 160 },
  { key: 'pod', header: 'POD', sortable: false, width: 110 },
  { key: 'carrier', header: 'Carrier DOT/MC', sortable: false, width: 190 },
  { key: 'tracker', header: 'Tracker', sortable: false, width: 150 },
  { key: 'actions', header: '', sortable: false, width: 44 },
]

const SORTABLE: { key: string; label: string }[] = [
  { key: 'shipment', label: 'Shipment #' },
  { key: 'customer', label: 'Customer' },
  { key: 'lane', label: 'Lane' },
  { key: 'status', label: 'Status' },
  { key: 'lastLocation', label: 'Last location' },
  { key: 'eta', label: 'ETA' },
  { key: 'nextCheckCall', label: 'Next check call' },
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

const POD_BADGES: Record<Exclude<PodState, 'NOT_DUE'>, { tone: TmsTone; label: string }> = {
  NEEDED: { tone: 'orange', label: 'POD needed' },
  REQUESTED: { tone: 'blue', label: 'Requested' },
  IN_REVIEW: { tone: 'turquoise', label: 'In review' },
  RECEIVED: { tone: 'green', label: 'Received' },
  UNKNOWN: { tone: 'gray', label: 'Not checked' },
}

function motionText(row: ShipmentRow, nowMs: number): string {
  return motionOf({
    lastUpdateAt: row.lastUpdateAt,
    lastUpdatePlace: row.lastUpdatePlace,
    previousUpdateAt: row.previousUpdateAt ?? row.lastKnownAt,
    previousUpdatePlace: row.previousUpdatePlace ?? row.lastKnownSource,
    nowMs,
  })
}

function lateText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} d`
}

/** Missing values sort last in either direction. */
const NO_VALUE = Number.POSITIVE_INFINITY

function sortRows(rows: ShipmentRow[], sort: BoardGridSort | null, nowMs: number): ShipmentRow[] {
  if (!sort) return rows
  const dir = sort.dir === 'asc' ? 1 : -1
  const sorted = [...rows]
  sorted.sort((a, b) => {
    let av: string | number
    let bv: string | number
    switch (sort.key) {
      case 'shipment':
        av = a.number
        bv = b.number
        break
      case 'customer':
        av = a.customerName ?? ''
        bv = b.customerName ?? ''
        break
      case 'lane':
        av = a.originCity ?? ''
        bv = b.originCity ?? ''
        break
      case 'status': {
        const statusOrder: Record<string, number> = {
          OPEN: 1, COVERED: 2, DISPATCHED: 3, ARRIVED: 4, DEPARTED: 5, DELIVERED: 6, HOLD: 7, RESERVED: 8, VOIDED: 9,
        }
        av = statusOrder[boardStatusOf(a)] ?? 99
        bv = statusOrder[boardStatusOf(b)] ?? 99
        break
      }
      case 'lastLocation': {
        const motionOrder: Record<string, number> = { Moving: 1, Stopped: 2, 'No signal': 3 }
        const am = motionOrder[motionText(a, nowMs)] ?? 99
        const bm = motionOrder[motionText(b, nowMs)] ?? 99
        if (am !== bm) {
          av = am
          bv = bm
        } else {
          // Within the same motion, newest ping first so the board surfaces the shipments
          // a tracker should look at right now.
          const ad = new Date(a.lastUpdateAt ?? a.lastKnownAt ?? 0).getTime()
          const bd = new Date(b.lastUpdateAt ?? b.lastKnownAt ?? 0).getTime()
          return bd - ad
        }
        break
      }
      case 'eta': {
        const at = etaOf(a, nowMs)?.at
        const bt = etaOf(b, nowMs)?.at
        av = at ? Date.parse(at) : NO_VALUE
        bv = bt ? Date.parse(bt) : NO_VALUE
        if (av === bv) return 0
        if (av === NO_VALUE) return 1
        if (bv === NO_VALUE) return -1
        break
      }
      case 'nextCheckCall': {
        const an = nextCheckCallStateOf(a, nowMs)
        const bn = nextCheckCallStateOf(b, nowMs)
        av = an.kind === 'NONE' ? NO_VALUE : Date.parse(an.at)
        bv = bn.kind === 'NONE' ? NO_VALUE : Date.parse(bn.at)
        if (av === bv) return 0
        if (av === NO_VALUE) return 1
        if (bv === NO_VALUE) return -1
        break
      }
      default:
        av = a.number
        bv = b.number
    }
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return 0
  })
  return sorted
}

function emptyMessage(props: Pick<TrackingBoardProps, 'activeAssignee' | 'includeUnsent' | 'lifecycle'>): string {
  if (props.activeAssignee === 'me') return 'Nothing assigned to you — pick All.'
  if (props.activeAssignee !== 'all') return 'Nothing in this view.'
  if (!props.includeUnsent && props.lifecycle === 'active') return 'No shipments with a sent rate confirmation yet.'
  return 'No shipments in this view.'
}

export function TrackingBoard(props: TrackingBoardProps) {
  const {
    groups,
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
    onManageLinks,
    onCreateCustomerUrl,
    onRequestCheckCall,
    onRequestPod,
    onAssignTracker,
    panelProps,
    recent,
    onOpenRecent,
    onRemoveRecent,
  } = props

  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [mapVisible, setMapVisible] = useState(false)
  const [sort, setSort] = useState<BoardGridSort | null>({ key: 'lastLocation', dir: 'asc' })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // Groups render at most GROUP_ROW_CAP rows until "Show more" (a tracker's queue can be long).
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  // The grid's row handler cannot see the event, so a click that landed on a selection
  // checkbox is noted on the way down and swallowed by the row handler on the way up.
  const checkboxClick = useRef(false)

  const visibleGroups = useMemo(
    () =>
      groups.map((g) => {
        const sorted = sortRows(g.rows, sort, nowMs)
        return { ...g, rows: favoritesOnly ? sorted.filter((r) => favorites.has(r.id)) : sorted }
      }).filter((g) => !favoritesOnly || g.rows.length > 0),
    [groups, sort, nowMs, favoritesOnly, favorites],
  )
  const allRows = useMemo(() => visibleGroups.flatMap((g) => g.rows), [visibleGroups])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const onSort = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      return prev.dir === 'asc' ? { key, dir: 'desc' } : null
    })
  }, [])

  const handleRowClick = useCallback((row: ShipmentRow) => {
    if (checkboxClick.current) {
      checkboxClick.current = false
      return
    }
    onOpenShipment(row.id)
  }, [onOpenShipment])

  const rowDataAttrs = useCallback(
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

  const toggleGroup = useCallback((shownRows: ShipmentRow[]) => {
    const ids = shownRows.map((r) => r.id)
    setSelectedIds((prev) => {
      const all = ids.every((id) => prev.includes(id))
      return all ? prev.filter((id) => !ids.includes(id)) : [...new Set([...prev, ...ids])]
    })
  }, [])

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
          return <LaneCell row={row} />
        case 'status':
          return <StatusCell row={row} nowMs={nowMs} />
        case 'lastLocation':
          return <LastLocationCell row={row} nowMs={nowMs} />
        case 'eta':
          return <EtaCell row={row} nowMs={nowMs} />
        case 'nextCheckCall':
          return <NextCheckCallCell row={row} nowMs={nowMs} />
        case 'pod':
          return <PodCell row={row} />
        case 'carrier':
          return <CarrierCell row={row} />
        case 'tracker':
          return <TrackerCell row={row} />
        case 'actions':
          return (
            <RowMenu
              row={row}
              onOpen={() => onOpenShipment(row.id)}
              onCreateCustomerUrl={() => onCreateCustomerUrl(row)}
              onRequestCheckCall={() => onRequestCheckCall(row)}
              onRequestPod={() => onRequestPod(row)}
              onAssignTracker={(trackerId) => onAssignTracker([row.id], trackerId)}
            />
          )
        default:
          return null
      }
    },
    [favorites, onOpenShipment, onToggleFavorite, onCreateCustomerUrl, onRequestCheckCall, onRequestPod, onAssignTracker, nowMs],
  )

  // Tabs beyond the eighth fold into a select so the strip never wraps off screen.
  const shownTabs = assigneeTabs.slice(0, MAX_ASSIGNEE_TABS)
  const overflowTabs = assigneeTabs.slice(MAX_ASSIGNEE_TABS)
  const activeInOverflow = overflowTabs.some((t) => t.key === activeAssignee)
  const unassignedCount = assigneeTabs.find((t) => t.key === UNASSIGNED_KEY)?.count ?? 0

  return (
    <div className="tms-tracking-board">
      <div className="tms-tracking-toolbar">
        <div className="tms-tracking-toolbar-row">
          <Search size={16} className="tms-tracking-toolbar-icon" />
          <TmsInput
            placeholder="Search shipments..."
            aria-label="Search shipments"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="tms-tracking-search"
          />
          <SortDropdown sort={sort} onSort={onSort} />
          <TmsButton
            size="sm"
            variant={favoritesOnly ? 'primary' : 'secondary'}
            aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
          >
            <Heart size={14} /> My Favorites
          </TmsButton>
          <TmsButton size="sm" variant="secondary" onClick={onManageLinks}>
            <Settings2 size={14} /> Manage links
          </TmsButton>
          <TmsButton
            size="sm"
            variant="secondary"
            disabled={allRows.length === 0}
            title={allRows.length === 0 ? 'No shipment in view' : `Create a customer link for ${allRows[0].number}`}
            onClick={() => { if (allRows[0]) onCreateCustomerUrl(allRows[0]) }}
          >
            <Link2 size={14} /> Create Customer URL
          </TmsButton>
          <TmsButton
            size="sm"
            variant={panelProps.collapsed ? 'secondary' : 'primary'}
            aria-expanded={!panelProps.collapsed}
            onClick={() => panelProps.onToggleCollapse()}
          >
            <Filter size={14} /> Filters
          </TmsButton>
          <TmsButton size="sm" variant="primary" onClick={onCreateShipment}>
            <Plus size={14} /> Create Shipment
          </TmsButton>
          <TmsSegmentedTabs
            className="tms-tracking-toggle-group"
            aria-label="Shipment lifecycle"
            size="sm"
            tabs={LIFECYCLE_TABS}
            active={lifecycle}
            onSelect={(key) => onLifecycle(key as typeof lifecycle)}
          />
          <TmsButton
            size="sm"
            variant={includeUnsent ? 'primary' : 'secondary'}
            aria-pressed={includeUnsent}
            title="Also list loads whose rate confirmation was not sent through the TMS (Aljex-era or own-fleet loads)"
            onClick={() => onIncludeUnsent(!includeUnsent)}
          >
            Include loads without a TMS rate con
          </TmsButton>
        </div>
        <div className="tms-tracking-assignee-tabs" data-testid="tracking-assignee-tabs">
          <TmsSegmentedTabs
            aria-label="Assignee"
            size="sm"
            tabs={shownTabs}
            active={activeAssignee}
            onSelect={onSelectAssignee}
          />
          {overflowTabs.length > 0 && (
            <TmsSelect
              aria-label="More assignees"
              value={activeInOverflow ? activeAssignee : ''}
              onChange={(e) => { if (e.target.value) onSelectAssignee(e.target.value) }}
              placeholder="More assignees"
              options={overflowTabs.map((t) => ({ value: t.key, label: `${t.label} (${t.count})` }))}
            />
          )}
          {unassignedCount > 0 && <TmsBadge tone="orange">{unassignedCount} unassigned</TmsBadge>}
        </div>
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
        <TmsSegmentedTabs
          className="tms-tracking-view-toggle"
          aria-label="Table or map"
          size="sm"
          tabs={VIEW_TABS}
          active={mapVisible ? 'map' : 'table'}
          onSelect={(key) => setMapVisible(key === 'map')}
        />
      </div>
      {error && <p className="tms-tracking-error">{error}</p>}
      <div className="tms-tracking-board-main">
        <BoardFilterPanel {...panelProps} />
        <div className="tms-tracking-board-content">
          <div className="tms-tracking-table-pane" data-testid="tracking-list">
            {loading && allRows.length === 0 ? (
              <p className="tms-tracking-empty">Loading shipments…</p>
            ) : allRows.length === 0 ? (
              <p className="tms-tracking-empty" data-testid="tracking-empty">{emptyMessage({ activeAssignee, includeUnsent, lifecycle })}</p>
            ) : mapVisible ? (
              <BoardMapView rows={allRows} apiKey={mapsKey} mapId={mapsMapId} onOpenShipment={onOpenShipment} />
            ) : (
              <div
                className="tms-tracking-groups"
                onClickCapture={(e) => {
                  const target = e.target as HTMLElement
                  checkboxClick.current = target instanceof HTMLInputElement && target.type === 'checkbox'
                }}
              >
                {visibleGroups.map((group) => {
                  const shown = expandedGroups.has(group.key) ? group.rows : group.rows.slice(0, GROUP_ROW_CAP)
                  const hiddenCount = group.rows.length - shown.length
                  const selectedHere = shown.filter((r) => selectedSet.has(r.id)).map((r) => r.id)
                  return (
                    <section
                      key={group.key}
                      className="tms-tracking-group"
                      data-testid="tracking-group"
                      data-group-key={group.key}
                      aria-label={`${group.label} — ${group.rows.length} shipment${group.rows.length === 1 ? '' : 's'}`}
                    >
                      <header className="tms-tracking-group-head">
                        <h3 className="tms-tracking-group-title">
                          {group.trackerId === null ? <TmsBadge tone="orange">{group.label}</TmsBadge> : group.label}
                        </h3>
                        <span className="tms-tracking-group-count">{group.rows.length}</span>
                        {selectedHere.length > 0 && (
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
                      </header>
                      <BoardGrid
                        columns={COLUMNS}
                        rows={shown}
                        rowKey={(row) => row.id}
                        selectedIds={selectedIds}
                        selectable
                        rowDataAttrs={rowDataAttrs}
                        toneOf={() => ''}
                        onToggle={toggleOne}
                        onToggleAll={() => toggleGroup(shown)}
                        sort={sort}
                        onSort={onSort}
                        onRowClick={handleRowClick}
                        renderCell={renderCell}
                      />
                      {hiddenCount > 0 && (
                        <div className="tms-tracking-footer">
                          <TmsButton
                            size="sm"
                            onClick={() => setExpandedGroups((prev) => new Set(prev).add(group.key))}
                          >
                            {`Show ${hiddenCount} more`}
                          </TmsButton>
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>
            )}
            <div className="tms-tracking-footer">
              <span>
                <strong>{allRows.length}</strong> shipment{allRows.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        </div>
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

function LaneCell({ row }: { row: ShipmentRow }) {
  return (
    <div>
      <div>{row.originCity ?? '—'} → {row.destinationCity ?? '—'}</div>
      <div className="tms-tracking-cell-muted">
        {row.pickupAppt ? formatDateTime(row.pickupAppt) : 'No pickup appt'}
        {' → '}
        {row.deliveryAppt ? formatDateTime(row.deliveryAppt) : 'No delivery appt'}
      </div>
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
      <div>{place}</div>
      {when && <div className="tms-tracking-last-place">{when}</div>}
      <TmsBadge tone={tone}>{text}</TmsBadge>
    </div>
  )
}

function EtaCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const eta = etaOf(row, nowMs)
  if (!eta) return <span className="tms-tracking-cell-muted">—</span>
  return (
    <div className="tms-tracking-nextstop-cell" title={eta.estimated ? 'Estimate from the last ping' : 'Reported by the carrier'}>
      <div>
        {formatDateTime(eta.at)}
        {eta.estimated && <span className="tms-tracking-cell-muted"> est.</span>}
      </div>
      <div className="tms-tracking-cell-muted">
        {eta.lateMinutes ? <TmsBadge tone="red">Late {lateText(eta.lateMinutes)}</TmsBadge> : 'on time'}
      </div>
    </div>
  )
}

function NextCheckCallCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const next = nextCheckCallStateOf(row, nowMs)
  if (next.kind === 'NONE') return <span className="tms-tracking-cell-muted">—</span>
  if (next.kind === 'OVERDUE') return <TmsBadge tone="red" title={formatDateTime(next.at)}>overdue {durationText(next.minutes)}</TmsBadge>
  return <span title={formatDateTime(next.at)}>in {durationText(next.minutes)}</span>
}

function PodCell({ row }: { row: ShipmentRow }) {
  const state = podStateOf(row)
  if (state === 'NOT_DUE') return <span className="tms-tracking-cell-muted">—</span>
  const badge = POD_BADGES[state]
  return <TmsBadge tone={badge.tone}>{badge.label}</TmsBadge>
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
      <div>{row.carrierName ?? '—'}</div>
      <div className="tms-tracking-cell-muted">
        DOT {row.carrierDot ?? '—'} · MC {row.carrierMc ?? '—'}
      </div>
    </div>
  )
}

function RowMenu({
  row,
  onOpen,
  onCreateCustomerUrl,
  onRequestCheckCall,
  onRequestPod,
  onAssignTracker,
}: {
  row: ShipmentRow
  onOpen: () => void
  onCreateCustomerUrl: () => void
  onRequestCheckCall: () => Promise<void>
  onRequestPod: () => Promise<void>
  onAssignTracker: (trackerId: string | null) => Promise<void>
}) {
  const [assigning, setAssigning] = useState(false)
  const [busy, setBusy] = useState(false)
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
    >
      <TmsIconButton shape="plain" aria-label="Row actions">
        <MoreHorizontal size={14} />
      </TmsIconButton>
      <div className="tms-tracking-rowmenu-menu">
        <button type="button" className="tms-tracking-rowmenu-item" onClick={onOpen}>
          Open shipment
        </button>
        <button type="button" className="tms-tracking-rowmenu-item" onClick={onCreateCustomerUrl}>
          Create customer URL
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

function SortDropdown({ sort, onSort }: { sort: BoardGridSort | null; onSort: (key: string) => void }) {
  return (
    <div className="tms-tracking-views-dropdown">
      <TmsButton size="sm" variant="secondary">
        <ArrowUpDown size={14} /> Sort
      </TmsButton>
      <div className="tms-tracking-views-menu">
        {SORTABLE.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`tms-tracking-views-item${sort?.key === s.key ? ' tms-active' : ''}`}
            onClick={() => onSort(s.key)}
          >
            {s.label}
            {sort?.key === s.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
        ))}
      </div>
    </div>
  )
}
