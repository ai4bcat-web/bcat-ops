/**
 * A self-contained dense list: the View board's grid with its own header filters, click-to-sort,
 * Columns dialog, Compact/Comfortable toggle and a layout saved per browser. For pages that
 * already own their search, tabs and toolbar (Maintenance, PODs, Disputes) and only need the
 * table itself to match the board.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { DenseGrid } from './DenseGrid'
import { ClearFiltersButton, ColumnsButton, DensityToggle } from './DenseControls'
import {
  activeFilterCount, filterRows, nextSort, reorderKeys, sortDenseRows,
  type DenseColumn, type DenseColumnFilter, type DenseFilters, type DenseSort,
} from './denseGridModel'
import { useDenseGridPrefs } from './useDenseGridPrefs'

/** A dense column that also draws its cell. */
export interface DenseTableColumn<T> extends DenseColumn<T> {
  render?: (row: T) => ReactNode
}

export interface DenseTableProps<T> {
  /** Names the saved layout: `maintenance-tasks`, `pods`, ... */
  gridId: string
  columns: DenseTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  defaultSort?: DenseSort | null
  onRowClick?: (row: T) => void
  toneOf?: (row: T) => string
  empty?: ReactNode
  'aria-label': string
  /** Extra controls on the left of the table's header bar. */
  toolbar?: ReactNode
  maxHeight?: string
  testId?: string
}

export function DenseTable<T>({
  gridId, columns, rows, rowKey, defaultSort = null, onRowClick, toneOf, empty, toolbar, maxHeight, testId,
  'aria-label': ariaLabel,
}: DenseTableProps<T>) {
  const [filters, setFilters] = useState<DenseFilters>({})
  const catalog = useMemo(() => columns.filter((c) => !c.fixed), [columns])
  const lead = useMemo(() => columns.filter((c) => c.fixed && columns.indexOf(c) === 0), [columns])
  const trail = useMemo(() => columns.filter((c) => c.fixed && !lead.includes(c)), [columns, lead])
  const prefs = useDenseGridPrefs({
    gridId: `table:${gridId}`,
    email: null,
    defaultColumns: catalog.map((c) => c.key),
    validKeys: catalog.map((c) => c.key),
    defaultSort,
  })
  const gridColumns = useMemo(() => [
    ...lead,
    ...prefs.columns.map((k) => catalog.find((c) => c.key === k)).filter((c): c is DenseTableColumn<T> => c != null),
    ...trail,
  ], [lead, trail, catalog, prefs.columns])

  const setColumnFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setFilters((prev) => {
      const copy = { ...prev }
      if (next) copy[key] = next
      else delete copy[key]
      return copy
    })
  }, [])
  const shown = useMemo(() => sortDenseRows(filterRows(rows, columns, filters), columns, prefs.sort), [rows, columns, filters, prefs.sort])
  const renderCell = useCallback((row: T, key: string) => {
    const col = columns.find((c) => c.key === key)
    return col?.render ? col.render(row) : col?.text(row) ?? null
  }, [columns])
  const filterCount = activeFilterCount(filters)

  return (
    <div className="tms-dense-page" data-testid={testId}>
      <div className="tms-dense-bar">
        {toolbar}
        <ClearFiltersButton count={filterCount} onClear={() => setFilters({})} />
        <span className="tms-dense-spacer" />
        <span className="tms-muted">{shown.length === rows.length ? `${rows.length} items` : `${shown.length} of ${rows.length} items`}</span>
        <ColumnsButton
          catalog={catalog}
          columns={prefs.columns}
          widths={prefs.widths}
          pinned={prefs.pinned}
          onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
        />
        <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
      </div>
      <div className="tms-dense-body" style={{ minHeight: 240, maxHeight: maxHeight ?? 'calc(100vh - 300px)' }}>
        <DenseGrid<T>
          aria-label={ariaLabel}
          recentKey={`tms:table:${gridId}:recent`}
          resetKey={`${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
          columns={gridColumns}
          rows={shown}
          fitRows={rows}
          rowKey={rowKey}
          renderCell={renderCell}
          density={prefs.density}
          userWidths={prefs.widths}
          stickyCount={Math.max(lead.length + 1, lead.length + prefs.pinned.length)}
          sort={prefs.sort}
          onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
          filters={filters}
          onFilterChange={setColumnFilter}
          onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
          onResize={prefs.setWidth}
          onRowClick={onRowClick}
          toneOf={toneOf}
          empty={empty}
        />
      </div>
    </div>
  )
}
