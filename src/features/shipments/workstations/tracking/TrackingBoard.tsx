/**
 * The Chaine-style tracking table: one row per shipment with everything a tracker
 * scans for — PRO, lane, status with the next event, last known + age, motion,
 * next-stop miles + ETA, team and carrier DOT/MC. The toolbar carries search, the
 * collapsed type-ahead filter panel, sort, saved views, favorites, the link actions
 * and the Active/Closed lifecycle toggle; the recently-viewed chips sit beneath it.
 *
 * A row click opens the shipment's own Tracking tab — the board has no detail pane,
 * so the shipment page and this table can never drift. Rows are stamped with
 * data-testid="tracking-row", data-status and data-shipment-id for verification.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  ArrowUpDown,
  Filter,
  Heart,
  Link2,
  Map as MapIcon,
  MoreHorizontal,
  Plus,
  Save,
  Search,
  Settings2,
  Table2,
  X,
} from 'lucide-react'
import type { BoardFilterPanelProps } from '../../board/BoardFilterPanel'
import { BoardFilterPanel } from '../../board/BoardFilterPanel'
import { BoardGrid, type BoardGridColumn, type BoardGridSort } from '../../board/BoardGrid'
import { BoardMapView } from '../../board/BoardMapView'
import { TmsBadge, TmsButton, TmsIconButton, TmsInput, type TmsTone } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { trackingEtaEstimate, type ComputedTrackingEta } from '@/lib/trackingEta'
import type { Stop } from '@/types'
import { boardStatusOf, type BoardStatusKey, type ShipmentRow } from '../../shipmentViews'
import { relativeTime as relativeTimeOf, motionOf } from '../motion'
import { nextEventText } from './nextEventText'
import type { TrackingBoardProps } from './types'

const COLUMNS: BoardGridColumn[] = [
  { key: 'shipment', header: 'Shipment #', sortable: true, width: 170 },
  { key: 'origin', header: 'Origin', sortable: true, width: 160 },
  { key: 'destination', header: 'Destination', sortable: true, width: 160 },
  { key: 'status', header: 'Status', sortable: true, width: 190 },
  { key: 'tracking', header: 'Tracking & Last Location', sortable: false, width: 210 },
  { key: 'motion', header: 'Motion', sortable: true, width: 110 },
  { key: 'nextStop', header: 'Next Stop', sortable: false, width: 200 },
  { key: 'team', header: 'Team Members', sortable: false, width: 170 },
  { key: 'carrier', header: 'Carrier DOT/MC', sortable: false, width: 190 },
  { key: 'actions', header: '', sortable: false, width: 44 },
]

const SORTABLE: { key: string; label: string }[] = [
  { key: 'shipment', label: 'Shipment #' },
  { key: 'origin', label: 'Origin' },
  { key: 'destination', label: 'Destination' },
  { key: 'status', label: 'Status' },
  { key: 'motion', label: 'Motion' },
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

/** Ping coordinates land on the row with the data projection; read structurally so both compile. */
type RowWithPing = ShipmentRow & { lastKnownLat?: number | null; lastKnownLng?: number | null }

function motionText(row: ShipmentRow, nowMs: number): string {
  return motionOf({
    lastUpdateAt: row.lastUpdateAt,
    lastUpdatePlace: row.lastUpdatePlace,
    previousUpdateAt: row.previousUpdateAt ?? row.lastKnownAt,
    previousUpdatePlace: row.previousUpdatePlace ?? row.lastKnownSource,
    nowMs,
  })
}

/** The stop the shipment drives at next: delivery once it is rolling, pickup before. */
function nextStopOf(row: ShipmentRow): Stop | null {
  const stops = row.stops ?? []
  if (stops.length === 0) return null
  const status = boardStatusOf(row)
  const wantDelivery = status === 'DEPARTED' || status === 'ARRIVED'
  const typed = stops.filter((s) => (wantDelivery ? s.type === 'delivery' : s.type === 'pickup'))
  const pending = typed.filter((s) => !s.arrivedAt && !s.departedAt)
  return pending[0] ?? typed[0] ?? null
}

/** Miles + ETA from the last ping to the next stop; null when there is no fix to work from. */
function nextStopEta(row: ShipmentRow, nowMs: number): ComputedTrackingEta | null {
  const withPing = row as RowWithPing
  const lat = withPing.lastKnownLat
  const lng = withPing.lastKnownLng
  if (lat == null || lng == null) return null
  const stop = nextStopOf(row)
  const stopLat = stop?.address?.lat
  const stopLng = stop?.address?.lng
  if (!stop || stopLat == null || stopLng == null) return null
  const pingAt = row.lastUpdateAt ?? row.lastKnownAt
  if (!pingAt) return null
  try {
    return trackingEtaEstimate(
      { lat, lng },
      { lat: stopLat, lng: stopLng, appt: stop.appt ?? null },
      pingAt,
      new Date(nowMs).toISOString(),
    )
  } catch {
    return null
  }
}

function lateText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} d`
}

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
      case 'origin':
        av = a.originCity ?? ''
        bv = b.originCity ?? ''
        break
      case 'destination':
        av = a.destinationCity ?? ''
        bv = b.destinationCity ?? ''
        break
      case 'status': {
        const statusOrder: Record<string, number> = {
          OPEN: 1, COVERED: 2, DISPATCHED: 3, ARRIVED: 4, DEPARTED: 5, DELIVERED: 6, HOLD: 7, RESERVED: 8, VOIDED: 9,
        }
        av = statusOrder[boardStatusOf(a)] ?? 99
        bv = statusOrder[boardStatusOf(b)] ?? 99
        break
      }
      case 'motion': {
        const motionOrder: Record<string, number> = { Moving: 1, Stopped: 2, 'No signal': 3 }
        av = motionOrder[motionText(a, nowMs)] ?? 99
        bv = motionOrder[motionText(b, nowMs)] ?? 99
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

export function TrackingBoard(props: TrackingBoardProps) {
  const {
    rows,
    loading,
    error,
    nowMs,
    mapsKey,
    mapsMapId,
    query,
    setQuery,
    activeOnly,
    setActiveOnly,
    favorites,
    onToggleFavorite,
    onOpenShipment,
    onCreateShipment,
    onManageLinks,
    onCreateCustomerUrl,
    onSaveView,
    panelProps,
    recent,
    onOpenRecent,
    onRemoveRecent,
  } = props

  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [mapVisible, setMapVisible] = useState(false)
  const [sort, setSort] = useState<BoardGridSort | null>(null)

  const listRows = useMemo(() => {
    const sorted = sortRows(rows, sort, nowMs)
    if (!favoritesOnly) return sorted
    return sorted.filter((r) => favorites.has(r.id))
  }, [rows, sort, nowMs, favoritesOnly, favorites])

  const onSort = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      return prev.dir === 'asc' ? { key, dir: 'desc' } : null
    })
  }, [])

  const handleRowClick = useCallback((row: ShipmentRow) => {
    onOpenShipment(row.id)
  }, [onOpenShipment])

  const rowDataAttrs = useCallback(
    (row: ShipmentRow) => ({
      'data-testid': 'tracking-row',
      'data-status': boardStatusOf(row),
      'data-shipment-id': row.id,
    }),
    [],
  )

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
        case 'origin':
          return (
            <div>
              <div>{row.originCity ?? '—'}</div>
              <div className="tms-tracking-cell-muted">{row.pickupAppt ? formatDateTime(row.pickupAppt) : 'No pickup appt'}</div>
            </div>
          )
        case 'destination':
          return (
            <div>
              <div>{row.destinationCity ?? '—'}</div>
              <div className="tms-tracking-cell-muted">{row.deliveryAppt ? formatDateTime(row.deliveryAppt) : 'No delivery appt'}</div>
            </div>
          )
        case 'status':
          return <StatusCell row={row} nowMs={nowMs} />
        case 'tracking':
          return <TrackingCell row={row} nowMs={nowMs} />
        case 'motion':
          return <MotionCell row={row} nowMs={nowMs} />
        case 'nextStop':
          return <NextStopCell row={row} nowMs={nowMs} />
        case 'team':
          return <TeamCell row={row} />
        case 'carrier':
          return <CarrierCell row={row} />
        case 'actions':
          return (
            <RowMenu
              onOpen={() => onOpenShipment(row.id)}
              onCreateCustomerUrl={() => onCreateCustomerUrl(row)}
            />
          )
        default:
          return null
      }
    },
    [favorites, onOpenShipment, onToggleFavorite, onCreateCustomerUrl, nowMs],
  )

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
          <ViewsDropdown {...panelProps} />
          <TmsButton size="sm" variant="ghost" onClick={onSaveView}>
            <Save size={14} /> Save view
          </TmsButton>
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
            disabled={listRows.length === 0}
            title={listRows.length === 0 ? 'No shipment in view' : `Create a customer link for ${listRows[0].number}`}
            onClick={() => { if (listRows[0]) onCreateCustomerUrl(listRows[0]) }}
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
          <div className="tms-tracking-toggle-group" role="group" aria-label="Shipment lifecycle">
            <TmsButton size="sm" variant={activeOnly ? 'primary' : 'secondary'} aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>
              Active
            </TmsButton>
            <TmsButton size="sm" variant={!activeOnly ? 'primary' : 'secondary'} aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>
              Closed
            </TmsButton>
          </div>
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
        <div className="tms-tracking-view-toggle" role="group" aria-label="Table or map">
          <TmsButton size="sm" variant={!mapVisible ? 'primary' : 'secondary'} aria-pressed={!mapVisible} onClick={() => setMapVisible(false)}>
            <Table2 size={14} /> Table View
          </TmsButton>
          <TmsButton size="sm" variant={mapVisible ? 'primary' : 'secondary'} aria-pressed={mapVisible} onClick={() => setMapVisible(true)}>
            <MapIcon size={14} /> Map View
          </TmsButton>
        </div>
      </div>
      {error && <p className="tms-tracking-error">{error}</p>}
      <div className="tms-tracking-board-main">
        <BoardFilterPanel {...panelProps} />
        <div className="tms-tracking-board-content">
          <div className="tms-tracking-table-pane" data-testid="tracking-list">
            {loading && !rows.length ? (
              <p className="tms-tracking-empty">Loading shipments…</p>
            ) : mapVisible ? (
              <BoardMapView rows={listRows} apiKey={mapsKey} mapId={mapsMapId} onOpenShipment={onOpenShipment} />
            ) : (
              <BoardGrid
                columns={COLUMNS}
                rows={listRows}
                rowKey={(row) => row.id}
                selectedIds={[]}
                selectable={false}
                rowDataAttrs={rowDataAttrs}
                toneOf={() => ''}
                onToggle={() => {}}
                onToggleAll={() => {}}
                sort={sort}
                onSort={onSort}
                onRowClick={handleRowClick}
                renderCell={renderCell}
              />
            )}
            <div className="tms-tracking-footer">
              <span>
                <strong>{listRows.length}</strong> shipment{listRows.length === 1 ? '' : 's'}
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
      <div>
        <button type="button" className="tms-tracking-pro" onClick={(e) => { e.stopPropagation(); onOpen() }}>
          {row.number}
        </button>
        <div className="tms-tracking-cell-muted">{row.customerName ?? '—'}</div>
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

function TrackingCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const place = row.lastUpdatePlace ?? row.lastKnownCity ?? '—'
  const when = row.lastUpdateAt ? relativeTimeOf(row.lastUpdateAt, nowMs) : row.lastKnownAt ? relativeTimeOf(row.lastKnownAt, nowMs) : null
  return (
    <div className="tms-tracking-tracking-cell">
      <div>{place}</div>
      {when && <div className="tms-tracking-last-place">{when}</div>}
    </div>
  )
}

function MotionCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const text = motionText(row, nowMs)
  const tone: TmsTone = text === 'Moving' ? 'green' : text === 'Stopped' ? 'orange' : 'gray'
  return <TmsBadge tone={tone}>{text}</TmsBadge>
}

function NextStopCell({ row, nowMs }: { row: ShipmentRow; nowMs: number }) {
  const eta = nextStopEta(row, nowMs)
  if (!eta) return <span className="tms-tracking-cell-muted">—</span>
  const lateBy = eta.lateBy != null && eta.lateBy > 0 ? eta.lateBy : null
  return (
    <div className="tms-tracking-nextstop-cell" title={eta.basisLabel}>
      <div>
        {Math.round(eta.miles)} mi · ETA {formatDateTime(eta.etaAt)}
      </div>
      <div className="tms-tracking-cell-muted">
        {lateBy ? (
          <TmsBadge tone="red">Late {lateText(lateBy)}</TmsBadge>
        ) : (
          eta.basis === 'ESTIMATE' ? 'on time · estimate' : 'on time'
        )}
      </div>
    </div>
  )
}

function TeamCell({ row }: { row: ShipmentRow }) {
  const members: { role: string; name: string }[] = []
  const dispatcher = row.dispatcherAssignedName ?? row.dispatcherActualName
  if (dispatcher) members.push({ role: 'Dispatcher', name: dispatcher })
  if (row.salesRepName) members.push({ role: 'Sales', name: row.salesRepName })
  if (row.customerRepName) members.push({ role: 'Customer rep', name: row.customerRepName })
  if (members.length === 0) return <span className="tms-tracking-cell-muted">—</span>
  return (
    <div className="tms-tracking-team-cell" title={members.map((m) => `${m.role}: ${m.name}`).join('\n')}>
      {members.map((m) => m.name).join(' · ')}
    </div>
  )
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

function RowMenu({ onOpen, onCreateCustomerUrl }: { onOpen: () => void; onCreateCustomerUrl: () => void }) {
  return (
    <div className="tms-tracking-rowmenu" onClick={(e) => e.stopPropagation()}>
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
      </div>
    </div>
  )
}

function ViewsDropdown(panelProps: BoardFilterPanelProps) {
  const active = panelProps.filterSets.find((f) => f.id === panelProps.activeFilterSetId)
  return (
    <div className="tms-tracking-views-dropdown">
      <TmsButton size="sm" variant="secondary">
        <Save size={14} /> {active?.name ?? 'Views'}
      </TmsButton>
      <div className="tms-tracking-views-menu">
        {panelProps.filterSets.length === 0 && (
          <div className="tms-tracking-views-empty">No saved views</div>
        )}
        {panelProps.filterSets.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`tms-tracking-views-item${f.id === panelProps.activeFilterSetId ? ' tms-active' : ''}`}
            onClick={() => panelProps.onSelectFilterSet(f.id)}
          >
            {f.name}
          </button>
        ))}
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
