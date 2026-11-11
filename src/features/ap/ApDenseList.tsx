/**
 * The AP desk's table: the same dense grid View and Load Review use (sticky header, per-column
 * filters, click-to-sort, Columns dialog, density toggle, saved layout, optional summary strip).
 *
 * `ApPage` builds a list config per view; this file draws it. Rows, money and the actions on a
 * row are the view's: nothing here decides what is owed or paid.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Eye, RefreshCw, Search } from 'lucide-react'
import { TmsButton, TmsFilterChip, TmsInput, TmsTabs, type TmsTabGroup } from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import {
  ClearFiltersButton, ColumnsButton, DensityToggle, DenseKpiStrip, SummaryToggle, type DenseKpi,
} from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount, filterRows, nextSort, reorderKeys, searchRows, sortDenseRows,
  type DenseColumn, type DenseColumnFilter, type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'

/** A dense column that also knows how to draw its cell. */
export interface ApColumn<T> extends DenseColumn<T> {
  render: (row: T) => ReactNode
}

export interface ApListConfig<T> {
  /** Names the saved column layout (`ap-bills`, `ap-awaiting`, ...). */
  gridId: string
  columns: ApColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** Muted text shown in the grid when no row is left. */
  emptyText?: ReactNode
  banner?: ReactNode
  /** Extra controls in the toolbar (selection summary, month picker, pay button). */
  actions?: ReactNode
  filterChips?: Array<{ key: string; label: string; value?: string | null; onClick?: () => void }>
  onAddFilter?: () => void
  /** Clears the page's own (non-grid) filters. */
  onClearFilters?: () => void
  kpis?: DenseKpi[]
  onRowClick?: (row: T) => void
  /** Reused by other lists (Drivers): the search box hint and the grid's accessible name. Default to the AP wording. */
  searchPlaceholder?: string
  ariaLabel?: string
}

/** The page head and the two tab strips: kept mounted while the views under them swap. */
export function ApChrome({ title, viewTabs, quickTabs, actions }: {
  title: string
  /** Page-level buttons, on the right of the title. */
  actions?: React.ReactNode
  viewTabs?: TmsTabGroup
  quickTabs: TmsTabGroup
}) {
  return (
    <>
      <div className="tms-page-head">
        <h1>{title}</h1>
        {viewTabs ? (
          <span className="tms-views-btn">
            <Eye size={15} aria-hidden="true" />
            Views
          </span>
        ) : null}
        {actions ? <div className="tms-page-actions">{actions}</div> : null}
      </div>
      {viewTabs ? <TmsTabs tabs={viewTabs.tabs} active={viewTabs.active} onSelect={viewTabs.onSelect} /> : null}
      <div className="tms-quick-tabs" role="tablist">
        {quickTabs.tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === quickTabs.active}
            className={`tms-quick-tab${tab.key === quickTabs.active ? ' tms-active' : ''}`}
            onClick={() => quickTabs.onSelect(tab.key)}
          >
            {tab.label}
            {tab.count === undefined ? null : <span className="tms-quick-tab-count">{tab.count}</span>}
          </button>
        ))}
      </div>
    </>
  )
}

/** Leading selection column and trailing action column stay out of the Columns chooser. */
const isLead = (c: { key: string }) => c.key === 'select'

export function ApDenseList<T>({ config, email, onRefresh }: {
  config: ApListConfig<T>
  email: string | null | undefined
  onRefresh?: () => void
}) {
  const {
    gridId, columns, rows, rowKey, emptyText, banner, actions, filterChips, onAddFilter, onClearFilters, kpis, onRowClick, searchPlaceholder, ariaLabel,
  } = config
  const [filters, setFilters] = useState<DenseFilters>({})
  const [search, setSearch] = useState('')

  const catalog = useMemo(() => columns.filter((c) => !c.fixed), [columns])
  const prefs = useDenseGridPrefs({
    gridId,
    email,
    defaultColumns: catalog.map((c) => c.key),
    validKeys: catalog.map((c) => c.key),
    defaultSort: null,
  })
  const lead = useMemo(() => columns.filter((c) => c.fixed && isLead(c)), [columns])
  const trail = useMemo(() => columns.filter((c) => c.fixed && !isLead(c)), [columns])
  const gridColumns = useMemo(() => [
    ...lead,
    ...prefs.columns.map((k) => catalog.find((c) => c.key === k)).filter((c): c is ApColumn<T> => c != null),
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

  const shown = useMemo(
    () => sortDenseRows(filterRows(searchRows(rows, columns, search), columns, filters), columns, prefs.sort),
    [rows, columns, filters, prefs.sort, search],
  )
  const renderCell = useCallback(
    (row: T, key: string) => columns.find((c) => c.key === key)?.render(row) ?? null,
    [columns],
  )
  const filterCount = activeFilterCount(filters)

  return (
    <div className="tms-dense-page tms-caps">
      <div className="tms-dense-bar">
        <Search size={14} className="tms-muted" aria-hidden="true" />
        <TmsInput className="tms-dense-search" aria-label="Search" data-testid="ap-search" placeholder={searchPlaceholder ?? 'Search bill, carrier, payee, amount…'} value={search} onChange={(e) => setSearch(e.target.value)} />
        {filterChips?.map((chip) => (
          <TmsFilterChip key={chip.key} label={chip.label} value={chip.value} onClick={chip.onClick} />
        ))}
        {onAddFilter ? (
          <TmsButton size="sm" variant="secondary" onClick={onAddFilter}>+ Filter</TmsButton>
        ) : null}
        {onClearFilters ? (
          <TmsButton size="sm" variant="secondary" onClick={onClearFilters}>Clear page filters</TmsButton>
        ) : null}
        <ClearFiltersButton count={filterCount} onClear={() => setFilters({})} />
        {actions}
        <span className="tms-dense-spacer" />
        <span className="tms-muted" data-testid="ap-count">
          {shown.length === rows.length ? `${rows.length} items` : `${shown.length} of ${rows.length} items`}
        </span>
        <ColumnsButton
          catalog={catalog}
          columns={prefs.columns}
          widths={prefs.widths}
          pinned={prefs.pinned}
          onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
        />
        <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
        {kpis && kpis.length > 0 ? <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} /> : null}
        {onRefresh ? (
          <TmsButton size="sm" aria-label="Refresh" onClick={onRefresh}><RefreshCw size={14} /></TmsButton>
        ) : null}
      </div>
      {banner}
      {kpis && kpis.length > 0 ? <DenseKpiStrip open={prefs.kpiOpen} items={kpis} /> : null}
      <div className="tms-dense-body" style={{ minHeight: 320, maxHeight: 'calc(100vh - 280px)' }}>
        <DenseGrid<T>
          aria-label={ariaLabel ?? `AP ${gridId.replace(/^ap-/, '')}`}
          recentKey={`tms:${gridId}:recent:${email || 'anon'}`}
          resetKey={`${search}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
          columns={gridColumns}
          rows={shown}
          fitRows={rows}
          rowKey={rowKey}
          renderCell={renderCell}
          density={prefs.density}
          userWidths={prefs.widths}
          stickyCount={Math.max(lead.length + 1, prefs.pinned.length + lead.length)}
          sort={prefs.sort}
          onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
          filters={filters}
          onFilterChange={setColumnFilter}
          onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
          onResize={prefs.setWidth}
          onRowClick={onRowClick}
          empty={emptyText}
        />
      </div>
    </div>
  )
}
