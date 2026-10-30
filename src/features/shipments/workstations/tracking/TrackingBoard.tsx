import { useCallback, useMemo, useState } from 'react'
import {
  Filter,
  Heart,
  Link2,
  Map as MapIcon,
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
import { TmsBadge, TmsButton, TmsIconButton, TmsInput } from '@/features/tms/kit'
import { boardRowTone, type ShipmentRow } from '../../shipmentViews'
import { relativeTime as relativeTimeOf } from '../motion'
import { motionOf } from '../motion'
import { nextEventText } from './nextEventText'
import { TrackingDetailPanel } from './TrackingDetailPanel'
import type { TrackingBoardProps } from './types'

const COLUMNS: BoardGridColumn[] = [
  { key: 'shipment', header: 'Shipment #', sortable: true, width: 180 },
  { key: 'origin', header: 'Origin', sortable: true, width: 170 },
  { key: 'destination', header: 'Destination', sortable: true, width: 170 },
  { key: 'status', header: 'Status', sortable: true, width: 200 },
  { key: 'tracking', header: 'Tracking & Last Location', sortable: false, width: 260 },
  { key: 'motion', header: 'Motion', sortable: true, width: 110 },
]

function motionText(row: ShipmentRow, nowMs: number): string {
  const extended = row as ShipmentRow & { previousUpdateAt?: string | null; previousUpdatePlace?: string | null }
  return motionOf({
    lastUpdateAt: row.lastUpdateAt,
    lastUpdatePlace: row.lastUpdatePlace,
    previousUpdateAt: extended.previousUpdateAt ?? row.lastKnownAt,
    previousUpdatePlace: extended.previousUpdatePlace ?? row.lastKnownSource,
    nowMs,
  })
}

function sortRows(rows: ShipmentRow[], sort: BoardGridSort | null): ShipmentRow[] {
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
        av = statusOrder[a.status] ?? 99
        bv = statusOrder[b.status] ?? 99
        break
      }
      case 'motion': {
        const motionOrder: Record<string, number> = { Moving: 1, Stopped: 2, 'No signal': 3 }
        av = motionOrder[motionText(a, Date.now())] ?? 99
        bv = motionOrder[motionText(b, Date.now())] ?? 99
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
    mapVisible,
    setMapVisible,
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
    selectedId,
    onSelect,
    selectedBundle,
    selectedMessages,
    detailLoading,
    customers,
    settings,
    userName,
    onSendMessage,
    onSavePlan,
    onRefreshDetail,
  } = props

  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sort, setSort] = useState<BoardGridSort | null>(null)
  const [page, setPage] = useState(1)
  const pageSize = 50

  const filteredRows = useMemo(() => {
    const base = sortRows(rows, sort)
    if (!favoritesOnly) return base
    return base.filter((r) => favorites.has(r.id))
  }, [rows, sort, favoritesOnly, favorites])

  const total = filteredRows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const pageRows = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredRows.slice(start, start + pageSize)
  }, [filteredRows, page, pageSize])

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? pageRows[0] ?? null,
    [rows, selectedId, pageRows],
  )

  const onSort = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      return prev.dir === 'asc' ? { key, dir: 'desc' } : null
    })
    setPage(1)
  }, [])

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
              <div className="tms-tracking-cell-muted">{row.pickupAppt ?? 'No pickup appt'}</div>
            </div>
          )
        case 'destination':
          return (
            <div>
              <div>{row.destinationCity ?? '—'}</div>
              <div className="tms-tracking-cell-muted">{row.deliveryAppt ?? 'No delivery appt'}</div>
            </div>
          )
        case 'status':
          return <StatusCell row={row} nowMs={nowMs} />
        case 'tracking':
          return <TrackingCell row={row} nowMs={nowMs} />
        case 'motion':
          return <MotionCell row={row} nowMs={nowMs} />
        default:
          return null
      }
    },
    [favorites, onOpenShipment, onToggleFavorite, nowMs],
  )

  const handleRowClick = useCallback((row: ShipmentRow) => {
    onSelect(row.id)
  }, [onSelect])

  return (
    <div className="tms-tracking-board">
      <div className="tms-tracking-toolbar">
        <div className="tms-tracking-toolbar-row">
          <Search size={16} className="tms-tracking-toolbar-icon" />
          <TmsInput
            placeholder="Search shipments..."
            aria-label="Search shipments"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1) }}
            className="tms-tracking-search"
          />
          <ViewsDropdown {...panelProps} />
          <TmsButton size="sm" variant="ghost" onClick={onSaveView}>
            <Save size={14} /> Save view
          </TmsButton>
          <TmsButton
            size="sm"
            variant={favoritesOnly ? 'primary' : 'secondary'}
            onClick={() => setFavoritesOnly((v) => !v)}
          >
            <Heart size={14} /> My Favorites
          </TmsButton>
          <TmsButton size="sm" variant="secondary" onClick={onManageLinks}>
            <Settings2 size={14} /> Manage links
          </TmsButton>
          <TmsButton size="sm" variant="secondary" onClick={onCreateCustomerUrl}>
            <Link2 size={14} /> Create Customer URL
          </TmsButton>
          <TmsButton size="sm" variant="secondary" onClick={() => panelProps.onToggleCollapse()}>
            <Filter size={14} /> Filter
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
        <div className="tms-tracking-view-toggle">
          <TmsButton size="sm" variant={!mapVisible ? 'primary' : 'secondary'} onClick={() => setMapVisible(false)}>
            <Table2 size={14} /> Table View
          </TmsButton>
          <TmsButton size="sm" variant={mapVisible ? 'primary' : 'secondary'} onClick={() => setMapVisible(true)}>
            <MapIcon size={14} /> Map View
          </TmsButton>
        </div>
      </div>
      {error && <p className="tms-tracking-error">{error}</p>}
      <div className="tms-tracking-board-main">
        <BoardFilterPanel {...panelProps} />
        <div className="tms-tracking-board-content">
          <div className="tms-tracking-list-pane">
            {loading && !rows.length ? (
              <p className="tms-tracking-empty">Loading shipments…</p>
            ) : mapVisible ? (
              <BoardMapView rows={pageRows} apiKey={mapsKey} mapId={mapsMapId} onOpenShipment={onOpenShipment} />
            ) : (
              <BoardGrid
                columns={COLUMNS}
                rows={pageRows}
                rowKey={(row) => row.id}
                selectedIds={selectedId ? [selectedId] : []}
                toneOf={(row) => boardRowTone(row)}
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
                <strong>{total}</strong> shipment{total === 1 ? '' : 's'}
              </span>
              <span>
                Page <strong>{page}</strong> of {pageCount}
              </span>
              <div className="tms-tracking-footer-actions">
                <TmsButton size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Previous
                </TmsButton>
                <TmsButton size="sm" variant="secondary" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                  Next
                </TmsButton>
              </div>
            </div>
          </div>
          {selectedRow && (
            <div className="tms-tracking-detail-pane">
              <TrackingDetailPanel
                row={selectedRow}
                bundle={selectedBundle}
                messages={selectedMessages}
                loading={detailLoading}
                customers={customers}
                settings={settings}
                userName={userName}
                mapsKey={mapsKey}
                mapsMapId={mapsMapId}
                onSendMessage={onSendMessage}
                onSavePlan={onSavePlan}
                onRefresh={onRefreshDetail}
              />
            </div>
          )}
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
      <button type="button" className="tms-tracking-favorited" onClick={(e) => { e.stopPropagation(); onToggleFavorite() }} aria-label={favorites.has(row.id) ? 'Unfavorite' : 'Favorite'}>
        <Heart size={14} fill={favorites.has(row.id) ? 'currentColor' : 'none'} />
      </button>
      <div className="tms-tracking-avatar">{row.number.slice(0, 2).toUpperCase()}</div>
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
  const event = nextEventText(row, nowMs)
  return (
    <div className="tms-tracking-status-cell">
      <TmsBadge tone={row.trackingFlaggedAt ? 'red' : 'blue'}>{row.status}</TmsBadge>
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
  const tone = text === 'Moving' ? 'green' : text === 'Stopped' ? 'orange' : 'gray'
  return <TmsBadge tone={tone}>{text}</TmsBadge>
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
