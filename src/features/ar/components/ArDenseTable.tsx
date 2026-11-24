/**
 * The one table every AR view draws: the shared dense grid (sticky header, per-column
 * filters, click-to-sort, Columns dialog, density toggle, saved layout) that the Shipments
 * board and Load Review use. Each view hands over its columns and rows; this owns the
 * filter state, the saved layout and the toolbar, so the six views cannot drift apart.
 *
 * Mount it with `key={view}`: filters belong to one view's columns and are dropped with it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Download, Search } from 'lucide-react'
import { TmsButton, TmsInput } from '@/features/tms/kit'
import { downloadCsv } from '@/lib/directoryCsv'
import { selectedRowsCsv } from '../selectedExport'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import type { DenseCardLayout } from '@/features/tms/grid/denseCardLayout'
import {
  ClearFiltersButton, ColumnsButton, DenseKpiStrip, DensityToggle, SummaryToggle, type DenseKpi,
} from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount, filterRows, nextSort, reorderKeys, searchRows, sortDenseRows,
  type DenseColumn, type DenseColumnFilter, type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { useAuthUser } from '@/hooks/useAuth'

/** A column that may draw its own header cell (a select-all checkbox), given the rows the grid shows after search and filters. */
export type ArColumn<T> = DenseColumn<T> & { renderHeader?: (shown: T[]) => ReactNode }

/** One view's grid: a unique `gridId` keeps each view's saved layout apart. */
export interface ArGrid<T> {
  gridId: string
  /** The grid's accessible name. */
  label: string
  /** Every column. `fixed` ones (the tick box, the row action) stay out of the Columns dialog. */
  columns: Array<ArColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  renderCell?: (row: T, key: string) => ReactNode
  empty: ReactNode
  kpis?: DenseKpi[]
  /** Phone cards: which columns go on top (DenseGrid's `cardLayout`). */
  cardLayout?: DenseCardLayout
  /** A row (or phone card) opens its detail. */
  onRowClick?: (row: T) => void
  /** The rows left after the grid's own filters, search and sort, for a page that totals or acts on what is shown. */
  onFiltered?: (rows: T[]) => void
  /** The columns shown before anyone changes the layout (default: every movable one). */
  defaultColumns?: string[]
  /**
   * "Export selected": the ticked rows (ids as `idOf` reads them) as a CSV of the columns shown, in the grid's order.
   * The button appears only when this is set; with nothing ticked it stays disabled.
   */
  selection?: { ids: readonly string[]; idOf: (row: T) => string; filename: string }
  /** Optional grouping: rows are re-ordered by group after sort and filter, a header row per group. */
  group?: {
    keyOf: (row: T) => string
    /** `sorted` is true when the user picked a sort: groups then follow the sorted rows instead of their default order. */
    order: (rows: T[], sorted?: boolean) => T[]
    header: (key: string, rows: T[]) => ReactNode
  }
}

export function ArDenseTable<T>({ grid, pageFilters }: {
  grid: ArGrid<T>
  /** Filters the page holds outside the grid (customer, division, due); Clear filters clears them too. */
  pageFilters?: { count: number; onClear: () => void }
}) {
  const email = useAuthUser()?.email ?? ''
  const { gridId, label, columns: catalogAll, rows, rowKey, renderCell, empty, kpis, group, cardLayout, onRowClick, onFiltered, defaultColumns, selection } = grid
  const [filters, setFilters] = useState<DenseFilters>({})
  const [search, setSearch] = useState('')

  // Fixed columns before the first movable one lead the grid; those after it trail it.
  const { leading, movable, trailing } = useMemo(() => {
    const first = catalogAll.findIndex((c) => !c.fixed)
    const last = catalogAll.length - 1 - [...catalogAll].reverse().findIndex((c) => !c.fixed)
    return {
      leading: catalogAll.filter((c, i) => c.fixed && i < first),
      movable: catalogAll.filter((c) => !c.fixed),
      trailing: catalogAll.filter((c, i) => c.fixed && i > last),
    }
  }, [catalogAll])

  const prefs = useDenseGridPrefs({
    gridId,
    email,
    defaultColumns: defaultColumns ? defaultColumns.filter((k) => movable.some((c) => c.key === k)) : movable.map((c) => c.key),
    validKeys: movable.map((c) => c.key),
    defaultSort: null,
  })
  const setFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setFilters((prev) => {
      const copy = { ...prev }
      if (next) copy[key] = next
      else delete copy[key]
      return copy
    })
  }, [])

  const filtered = useMemo(() => {
    const sorted = sortDenseRows(filterRows(searchRows(rows, catalogAll, search), catalogAll, filters), catalogAll, prefs.sort)
    return group ? group.order(sorted, prefs.sort != null) : sorted
  }, [rows, catalogAll, filters, prefs.sort, search, group])

  useEffect(() => { onFiltered?.(filtered) }, [filtered, onFiltered])

  // A column's own header (the select-all tick) sees the rows left after search and filters.
  const gridColumns = useMemo(() => [
    ...leading,
    ...prefs.columns.map((k) => movable.find((c) => c.key === k)).filter((c): c is ArColumn<T> => c != null),
    ...trailing,
  ].map((c) => (c.renderHeader ? { ...c, headerContent: c.renderHeader(filtered) } : c)),
  [leading, movable, trailing, prefs.columns, filtered])

  const exportSelected = () => {
    if (!selection) return
    const picked = new Set(selection.ids)
    const out = filtered.filter((row) => picked.has(selection.idOf(row)))
    const shown = prefs.columns.map((k) => movable.find((c) => c.key === k)).filter((c): c is ArColumn<T> => c != null)
    downloadCsv(`${selection.filename}-${new Date().toISOString().slice(0, 10)}.csv`, selectedRowsCsv(shown, out))
  }
  const selectedShown = useMemo(() => {
    if (!selection) return 0
    const picked = new Set(selection.ids)
    return filtered.filter((row) => picked.has(selection.idOf(row))).length
  }, [selection, filtered])

  return (
    <div className="tms-dense-page" data-testid={`ar-grid-${gridId}`}>
      <div className="tms-dense-bar">
        <Search size={14} className="tms-muted" aria-hidden="true" />
        <TmsInput className="tms-dense-search" aria-label="Search" data-testid="ar-search" placeholder="Search invoice, customer, PRO, amount…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="tms-muted">{filtered.length === rows.length ? `${rows.length} rows` : `${filtered.length} of ${rows.length} rows`}</span>
        <ClearFiltersButton
          count={activeFilterCount(filters) + (pageFilters?.count ?? 0)}
          onClear={() => { setFilters({}); pageFilters?.onClear() }}
        />
        <span className="tms-dense-spacer" />
        {selection ? (
          <TmsButton aria-label="Export selected rows" data-testid="ar-export-selected" disabled={selectedShown === 0}
            title={selectedShown === 0 ? 'Tick rows to export just those' : 'Download the ticked rows as a CSV'} onClick={exportSelected}>
            <Download size={14} aria-hidden="true" /> Export selected{selectedShown ? ` (${selectedShown})` : ''}
          </TmsButton>
        ) : null}
        <ColumnsButton sharedWithAll={prefs.layoutSharedWithAll}
          catalog={movable}
          columns={prefs.columns}
          widths={prefs.widths}
          pinned={prefs.pinned}
          onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
        />
        <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
        {kpis && kpis.length > 0 ? <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} /> : null}
      </div>
      {kpis ? <DenseKpiStrip open={prefs.kpiOpen} items={kpis} variant="cards" /> : null}
      <div className="tms-dense-body">
        <DenseGrid<T>
          aria-label={label}
          recentKey={`tms:${gridId}:recent:${email || 'anon'}`}
          resetKey={`${gridId}|${search}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
          columns={gridColumns}
          rows={filtered}
          fitRows={rows}
          rowKey={rowKey}
          renderCell={renderCell}
          density={prefs.density}
          userWidths={prefs.widths}
          stickyCount={leading.length + Math.max(1, prefs.pinned.length)}
          sort={prefs.sort}
          onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
          filters={filters}
          onFilterChange={setFilter}
          onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
          onResize={prefs.setWidth}
          empty={empty}
          groupKeyOf={group?.keyOf}
          renderGroupHeader={group?.header}
          cardLayout={cardLayout}
          onRowClick={onRowClick}
        />
      </div>
    </div>
  )
}
