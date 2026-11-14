/**
 * The one table every AR view draws: the shared dense grid (sticky header, per-column
 * filters, click-to-sort, Columns dialog, density toggle, saved layout) that the Shipments
 * board and Load Review use. Each view hands over its columns and rows; this owns the
 * filter state, the saved layout and the toolbar, so the six views cannot drift apart.
 *
 * Mount it with `key={view}`: filters belong to one view's columns and are dropped with it.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { TmsInput } from '@/features/tms/kit'
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

/** One view's grid: a unique `gridId` keeps each view's saved layout apart. */
export interface ArGrid<T> {
  gridId: string
  /** The grid's accessible name. */
  label: string
  /** Every column. `fixed` ones (the tick box, the row action) stay out of the Columns dialog. */
  columns: Array<DenseColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  renderCell?: (row: T, key: string) => ReactNode
  empty: ReactNode
  kpis?: DenseKpi[]
  /** Phone cards: which columns go on top (DenseGrid's `cardLayout`). */
  cardLayout?: DenseCardLayout
  /** Optional grouping: rows are re-ordered by group after sort and filter, a header row per group. */
  group?: {
    keyOf: (row: T) => string
    order: (rows: T[]) => T[]
    header: (key: string, rows: T[]) => ReactNode
  }
}

export function ArDenseTable<T>({ grid, pageFilters }: {
  grid: ArGrid<T>
  /** Filters the page holds outside the grid (customer, division, due); Clear filters clears them too. */
  pageFilters?: { count: number; onClear: () => void }
}) {
  const email = useAuthUser()?.email ?? ''
  const { gridId, label, columns: catalogAll, rows, rowKey, renderCell, empty, kpis, group, cardLayout } = grid
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
    defaultColumns: movable.map((c) => c.key),
    validKeys: movable.map((c) => c.key),
    defaultSort: null,
  })
  const gridColumns = useMemo(() => [
    ...leading,
    ...prefs.columns.map((k) => movable.find((c) => c.key === k)).filter((c): c is DenseColumn<T> => c != null),
    ...trailing,
  ], [leading, movable, trailing, prefs.columns])

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
    return group ? group.order(sorted) : sorted
  }, [rows, catalogAll, filters, prefs.sort, search, group])

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
        <ColumnsButton
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
        />
      </div>
    </div>
  )
}
