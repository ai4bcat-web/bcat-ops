/**
 * The dense, spreadsheet-style grid every TMS list page shares (Shipments Active / All / Intake
 * and Load Tracking).
 *
 * Presentational: the page owns the rows (already filtered, sorted and paged), the filters,
 * the sort and the persisted layout (`useDenseGridPrefs`); the grid draws them.
 *
 * - Sticky header and sticky leading column(s); the rest scrolls horizontally.
 * - Fixed-height rows (compact 30px / comfortable 40px) that truncate with a tooltip, so the
 *   list can be virtualised exactly: only the rows in view (plus overscan) are mounted.
 * - Click a header to sort, the funnel to filter that column, drag a header to reorder and drag
 *   its edge to resize.
 * - Optional group header rows (Load Tracking's Group by).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { ArrowDown, ArrowUp, Filter } from 'lucide-react'
import {
  CHECK_COLUMN_WIDTH,
  ROW_HEIGHT,
  clampWidth,
  columnWidths,
  filterKindOf,
  isFilterActive,
  virtualWindow,
  type DenseColumn,
  type DenseColumnFilter,
  type DenseDensity,
  type DenseFilters,
  type DenseSort,
} from './denseGridModel'
import { DenseFilterPopover } from './DenseFilterPopover'
import './dense-grid.css'

/** Rows mounted above and below the viewport. */
const OVERSCAN = 8
/** Used until the scroll container has been measured (and under jsdom, which never measures). */
const FALLBACK_VIEWPORT = 720
/** Matches `.tms-dg-popover` width in dense-grid.css. */
const POPOVER_WIDTH = 280

export interface DenseGridProps<T> {
  /** The visible columns, in order. */
  columns: DenseColumn<T>[]
  /** The rows to draw: already filtered, sorted and paged. */
  rows: T[]
  /** Rows the auto-fit widths and the filter options are drawn from (the list before header filters). */
  fitRows?: readonly T[]
  rowKey: (row: T) => string
  /** The cell body; falls back to the column's text. */
  renderCell?: (row: T, columnKey: string) => ReactNode
  density: DenseDensity
  /** Widths the user dragged, by column key. */
  userWidths: Record<string, number>
  sort: DenseSort | null
  onSort: (key: string) => void
  filters: DenseFilters
  onFilterChange: (key: string, next: DenseColumnFilter | null) => void
  onReorder?: (from: string, to: string) => void
  onResize?: (key: string, width: number) => void
  /** Leading columns that stay put while the rest scrolls. At least 1. */
  stickyCount?: number
  selectable?: boolean
  selectedIds?: ReadonlySet<string>
  onToggle?: (id: string) => void
  onToggleAll?: () => void
  onRowClick?: (row: T) => void
  onRowDoubleClick?: (row: T) => void
  /** Extra data-* attributes stamped on each <tr>. */
  rowAttrs?: (row: T) => Record<string, string>
  toneOf?: (row: T) => string
  /** Rows must arrive ordered by group; a header row is drawn wherever the key changes. */
  groupKeyOf?: (row: T) => string
  renderGroupHeader?: (key: string, shown: T[]) => ReactNode
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode
  /** Scroll returns to the top when this changes (a new filter, sort, tab or search). */
  resetKey?: string
  /** Namespaces the filter pickers' recently-used values. */
  recentKey: string
  'aria-label': string
  testId?: string
}

type Item<T> = { kind: 'row'; row: T } | { kind: 'group'; key: string; rows: T[] }

function buildItems<T>(rows: readonly T[], groupKeyOf: ((row: T) => string) | undefined): Item<T>[] {
  if (!groupKeyOf) return rows.map((row) => ({ kind: 'row', row }))
  const items: Item<T>[] = []
  let current: { kind: 'group'; key: string; rows: T[] } | null = null
  for (const row of rows) {
    const key = groupKeyOf(row)
    if (!current || current.key !== key) {
      current = { kind: 'group', key, rows: [] }
      items.push(current)
    }
    current.rows.push(row)
    items.push({ kind: 'row', row })
  }
  return items
}

export function DenseGrid<T>({
  columns,
  rows,
  fitRows,
  rowKey,
  renderCell,
  density,
  userWidths,
  sort,
  onSort,
  filters,
  onFilterChange,
  onReorder,
  onResize,
  stickyCount = 1,
  selectable = false,
  selectedIds,
  onToggle,
  onToggleAll,
  onRowClick,
  onRowDoubleClick,
  rowAttrs,
  toneOf,
  groupKeyOf,
  renderGroupHeader,
  empty,
  resetKey,
  recentKey,
  'aria-label': ariaLabel,
  testId,
}: DenseGridProps<T>) {
  const rowHeight = ROW_HEIGHT[density]
  const scrollRef = useRef<HTMLDivElement>(null)
  const [topRow, setTopRow] = useState(0)
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT)
  const [openFilter, setOpenFilter] = useState<{ key: string; top?: number; bottom?: number; left: number; maxHeight: number } | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})

  const fit = fitRows ?? rows
  const widths = useMemo(() => {
    const base = columnWidths(columns, userWidths)
    return { ...base, ...liveWidths }
  }, [columns, userWidths, liveWidths])

  const items = useMemo(() => buildItems(rows, groupKeyOf), [rows, groupKeyOf])
  const win = virtualWindow(items.length, rowHeight, topRow * rowHeight, viewport, OVERSCAN)
  const mounted = items.slice(win.start, win.end)

  // Measure the scroll container so the window follows the real viewport.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const measure = () => {
      if (el.clientHeight > 0) setViewport(el.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A new filter, sort or tab starts at the top (the scroll event resets the window).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [resetKey])

  const lastLeft = useRef(0)
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const next = Math.floor(e.currentTarget.scrollTop / rowHeight)
      setTopRow((prev) => (prev === next ? prev : next))
      // The popover is anchored to its header cell: when the columns slide under it, close it.
      const left = e.currentTarget.scrollLeft
      if (left !== lastLeft.current) {
        lastLeft.current = left
        setOpenFilter(null)
      }
    },
    [rowHeight],
  )

  // Close the filter popover on an outside click or Escape.
  useEffect(() => {
    if (!openFilter) return undefined
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.tms-dg-popover') || target.closest('.tms-dg-filter-btn')) return
      setOpenFilter(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenFilter(null)
    }
    const onResize = () => setOpenFilter(null)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [openFilter])

  // Sticky offsets: the checkbox column, then the leading columns, left to right.
  const sticky = Math.max(1, stickyCount)
  const checkWidth = selectable ? CHECK_COLUMN_WIDTH : 0
  const stickyLeft = useMemo(() => {
    const lefts: Record<string, number> = {}
    let left = checkWidth
    columns.slice(0, sticky).forEach((col) => {
      lefts[col.key] = left
      left += widths[col.key]
    })
    return lefts
  }, [columns, sticky, widths, checkWidth])
  const lastSticky = columns[Math.min(sticky, columns.length) - 1]?.key

  const tableWidth = checkWidth + columns.reduce((sum, col) => sum + widths[col.key], 0)

  const startResize = (col: DenseColumn<T>, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = widths[col.key]
    let latest = startWidth
    const move = (ev: MouseEvent) => {
      latest = clampWidth(startWidth + ev.clientX - startX)
      setLiveWidths((prev) => ({ ...prev, [col.key]: latest }))
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      setLiveWidths((prev) => {
        const rest = { ...prev }
        delete rest[col.key]
        return rest
      })
      onResize?.(col.key, latest)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const toggleFilter = (key: string, button: HTMLElement) => {
    if (openFilter?.key === key) {
      setOpenFilter(null)
      return
    }
    const rect = button.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8))
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    // Open downwards unless there is clearly more room above (a short window or a low header).
    const up = below < 220 && above > below
    setOpenFilter(
      up
        ? { key, bottom: window.innerHeight - rect.top + 4, maxHeight: above, left }
        : { key, top: rect.bottom + 4, maxHeight: below, left },
    )
  }

  const openColumn = openFilter ? columns.find((c) => c.key === openFilter.key) : undefined
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selectedIds?.has(rowKey(r)))
  const someSelected = selectable && rows.some((r) => selectedIds?.has(rowKey(r)))

  return (
    <div className="tms-dg" data-density={density} style={{ '--dg-row-h': `${rowHeight}px` } as CSSProperties}>
      <div ref={scrollRef} className="tms-dg-scroll" onScroll={onScroll} data-testid={testId}>
        <table className="tms-dg-table" aria-label={ariaLabel} style={{ width: tableWidth }}>
          <colgroup>
            {selectable && <col style={{ width: CHECK_COLUMN_WIDTH }} />}
            {columns.map((col) => (
              <col key={col.key} style={{ width: widths[col.key] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="tms-dg-sticky tms-dg-check" style={{ left: 0 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected
                    }}
                    onChange={() => onToggleAll?.()}
                  />
                </th>
              )}
              {columns.map((col) => {
                const kind = filterKindOf(col)
                const active = isFilterActive(filters[col.key])
                const sortable = col.sortable !== false && col.header !== ''
                const isSticky = col.key in stickyLeft
                const direction = sort?.key === col.key ? sort.dir : null
                return (
                  <th
                    key={col.key}
                    scope="col"
                    className={[
                      isSticky ? 'tms-dg-sticky' : '',
                      col.key === lastSticky ? 'tms-dg-sticky-last' : '',
                      dropKey === col.key && dragKey !== col.key ? 'tms-dg-drop' : '',
                    ].filter(Boolean).join(' ') || undefined}
                    style={isSticky ? { left: stickyLeft[col.key] } : undefined}
                    aria-sort={direction ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
                    draggable={!col.fixed && onReorder != null}
                    onDragStart={(e) => {
                      setDragKey(col.key)
                      try {
                        e.dataTransfer.setData('text/plain', col.key)
                        e.dataTransfer.effectAllowed = 'move'
                      } catch {
                        /* synthetic drag events carry no dataTransfer */
                      }
                    }}
                    onDragOver={(e) => {
                      if (dragKey && !col.fixed) {
                        e.preventDefault()
                        setDropKey(col.key)
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragKey && dragKey !== col.key && !col.fixed) onReorder?.(dragKey, col.key)
                      setDragKey(null)
                      setDropKey(null)
                    }}
                    onDragEnd={() => {
                      setDragKey(null)
                      setDropKey(null)
                    }}
                  >
                    <div className="tms-dg-th">
                      {sortable ? (
                        <button type="button" className="tms-dg-sort" onClick={() => onSort(col.key)} title={`Sort by ${col.header}`}>
                          <span className="tms-dg-th-label">{col.header}</span>
                          {direction === 'asc' && <ArrowUp size={11} aria-hidden="true" />}
                          {direction === 'desc' && <ArrowDown size={11} aria-hidden="true" />}
                        </button>
                      ) : (
                        <span className="tms-dg-th-label">{col.header}</span>
                      )}
                      {kind && (
                        <button
                          type="button"
                          className={`tms-dg-filter-btn${active ? ' tms-active' : ''}`}
                          aria-label={`Filter ${col.header}`}
                          aria-pressed={active}
                          aria-expanded={openFilter?.key === col.key}
                          onClick={(e) => toggleFilter(col.key, e.currentTarget)}
                        >
                          <Filter size={11} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {!col.fixed && onResize && (
                      <span
                        className="tms-dg-resize"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${col.header}`}
                        onMouseDown={(e) => startResize(col, e)}
                      />
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {win.padTop > 0 && (
              <tr aria-hidden="true" className="tms-dg-spacer" style={{ height: win.padTop }}>
                <td colSpan={columns.length + (selectable ? 1 : 0)} />
              </tr>
            )}
            {mounted.map((item) => {
              if (item.kind === 'group') {
                return (
                  <tr key={`g:${item.key}`} className="tms-dg-group" data-testid="dense-group" data-group-key={item.key}>
                    <td colSpan={columns.length + (selectable ? 1 : 0)}>
                      <div className="tms-dg-group-head">{renderGroupHeader ? renderGroupHeader(item.key, item.rows) : item.key}</div>
                    </td>
                  </tr>
                )
              }
              const row = item.row
              const id = rowKey(row)
              const selected = selectedIds?.has(id) ?? false
              return (
                <tr
                  key={id}
                  data-tone={toneOf?.(row)}
                  data-selected={selected}
                  {...rowAttrs?.(row)}
                  className={onRowClick ? 'tms-dg-clickable' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
                >
                  {selectable && (
                    <td className="tms-dg-sticky tms-dg-check" style={{ left: 0 }}>
                      <input
                        type="checkbox"
                        aria-label={`Select row ${id}`}
                        checked={selected}
                        onChange={() => onToggle?.(id)}
                        // Ticking a row must not also open it.
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                  )}
                  {columns.map((col) => {
                    const isSticky = col.key in stickyLeft
                    return (
                      <td
                        key={col.key}
                        className={[
                          isSticky ? 'tms-dg-sticky' : '',
                          col.key === lastSticky ? 'tms-dg-sticky-last' : '',
                          col.align === 'right' ? 'tms-dg-right' : '',
                          col.fixed ? 'tms-dg-fixed' : '',
                        ].filter(Boolean).join(' ') || undefined}
                        style={isSticky ? { left: stickyLeft[col.key] } : undefined}
                        title={col.fixed ? undefined : col.text(row)}
                      >
                        {renderCell ? renderCell(row, col.key) : col.text(row)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {win.padBottom > 0 && (
              <tr aria-hidden="true" className="tms-dg-spacer" style={{ height: win.padBottom }}>
                <td colSpan={columns.length + (selectable ? 1 : 0)} />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && empty != null && <div className="tms-dg-empty">{empty}</div>}
      </div>

      {openColumn && openFilter && (
        <div
          className="tms-dg-popover"
          style={{ top: openFilter.top, bottom: openFilter.bottom, left: openFilter.left, maxHeight: Math.max(160, openFilter.maxHeight) }}
          role="dialog"
          aria-label={`${openColumn.header} filter`}
        >
          <DenseFilterPopover
            column={openColumn}
            rows={fit}
            value={filters[openColumn.key]}
            onChange={(next) => onFilterChange(openColumn.key, next)}
            recentKey={recentKey}
          />
        </div>
      )}
    </div>
  )
}
