import { Children, isValidElement, useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Eye, Plus, RefreshCw, Search } from 'lucide-react'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import { ClearFiltersButton, ColumnsButton, DensityToggle } from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount, filterRows, nextSort, reorderKeys, sortDenseRows,
  type DenseColumn, type DenseColumnFilter, type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { TmsEmptyState } from './TmsEmptyState'
import { TmsFilterChip } from './TmsFilterChip'
import { TmsKeyHint } from './TmsKeyHint'
import type { ColumnDef, TmsSort } from './TmsTable'
import { TmsTabs } from './TmsTabs'
import { TmsTabStrip } from './TmsTabStrip'
import type { TmsTab } from './TmsTabs'

export interface TmsTabGroup {
  tabs: TmsTab[]
  active: string
  onSelect: (key: string) => void
}

export interface TmsListPageProps<T> {
  /** The page's h1. Ignored when `embedded` — the host page already has one. */
  title: ReactNode
  primaryAction?: { label: string; onClick: () => void }
  /** Saved department views, shown as a tab strip under the title row. */
  viewTabs?: TmsTabGroup
  /** Status quick-tabs with counts, directly above the table. */
  quickTabs?: TmsTabGroup
  /** Draw the quick-tabs as the folder-tab strip (as on Shipments), right under the title row, instead of the pills above the table. */
  folderTabs?: boolean
  filterChips?: Array<{ key: string; label: string; value?: string | null; onClick?: () => void }>
  onAddFilter?: () => void
  search?: { value: string; onChange: (value: string) => void; placeholder?: string }
  onRefresh?: () => void
  /** Extra buttons beside the primary pill (document export, overflow menu). */
  actions?: ReactNode
  columns: Array<ColumnDef<T>>
  rows: T[]
  rowKey: (row: T) => string
  sort?: TmsSort | null
  onSort?: (key: string) => void
  onRowClick?: (row: T) => void
  onRowDoubleClick?: (row: T) => void
  page?: { from: number; to: number; total: number; pageSize: number; onPageSize?: (size: number) => void }
  /** The muted second line of the empty state. */
  emptyText?: ReactNode
  onClearFilters?: () => void
  /** The field picker label, e.g. "13 Fields". */
  fieldsLabel?: string
  onFields?: () => void
  footerExtra?: ReactNode
  /** Rendered between the quick-tabs and the table: a KPI strip, a totals card. */
  banner?: ReactNode
  /**
   * Rendered as a list *inside* another page (a tab body): the title row is dropped,
   * because the host page already carries the h1. Everything below it — filters, tabs,
   * table, footer — is identical, so an embedded list and a full one cannot drift apart.
   */
  embedded?: boolean
  /** Names the saved column layout (which columns, widths, density, sort). Defaults to the title. */
  gridId?: string
}

/** The words a rendered cell shows, for search, filters and the tooltip when a column gives no `text`. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).filter(Boolean).join(' ')
  if (isValidElement<{ children?: ReactNode }>(node)) return Children.toArray(node.props.children).map(nodeText).filter(Boolean).join(' ')
  return ''
}

function slug(value: ReactNode): string {
  return nodeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list'
}

const PAGE_SIZES = [20, 50, 100, 200]
const FOOTER_HINTS = ['F', '\u2193', ']', 'Enter', 'Tab', 'Esc']

/** The MVMNT list page, top to bottom exactly as MVMNT_UI_REFERENCE §2 describes it. */
export function TmsListPage<T>({
  title,
  primaryAction,
  viewTabs,
  quickTabs,
  folderTabs,
  filterChips,
  onAddFilter,
  search,
  onRefresh,
  actions,
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  onRowDoubleClick,
  page,
  emptyText,
  onClearFilters,
  fieldsLabel,
  onFields,
  footerExtra,
  banner,
  embedded,
  gridId,
}: TmsListPageProps<T>) {
  // The layout is per browser (localStorage); list pages render in tests and drawers without an AuthProvider.
  const email: string | null = null
  const [filters, setFilters] = useState<DenseFilters>({})
  const dense = useMemo<Array<DenseColumn<T> & { render: (row: T) => ReactNode }>>(
    () => columns.map((col) => ({
      key: col.key,
      header: col.header,
      render: col.render,
      text: col.text ?? ((row: T) => nodeText(col.render(row))),
      sortValue: col.sortValue,
      // A page that sorts its own rows (server paging) only offers the columns it marks sortable.
      sortable: onSort ? !!col.sortable : col.sortable !== false,
      filter: col.filter,
      width: col.width,
      align: col.align,
    })),
    [columns, onSort],
  )
  const keys = useMemo(() => dense.map((c) => c.key), [dense])
  // Pages that swap their column set (one list per tab) keep one saved layout per set.
  const layoutId = `list:${gridId ?? slug(title)}:${[...keys].sort().join(',')}`
  const prefs = useDenseGridPrefs({
    gridId: layoutId,
    email,
    defaultColumns: keys,
    validKeys: keys,
    defaultSort: null,
  })
  const shownKeys = prefs.columns
  const gridColumns = useMemo(
    () => shownKeys.map((k) => dense.find((c) => c.key === k)).filter((c): c is (typeof dense)[number] => c != null),
    [shownKeys, dense],
  )
  const setColumnFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setFilters((prev) => {
      const copy = { ...prev }
      if (next) copy[key] = next
      else delete copy[key]
      return copy
    })
  }, [])
  const activeSort = onSort ? (sort ?? null) : prefs.sort
  const shown = useMemo(() => {
    const filtered = filterRows(rows, dense, filters)
    return onSort ? filtered : sortDenseRows(filtered, dense, prefs.sort)
  }, [rows, dense, filters, onSort, prefs.sort])
  const renderCell = useCallback((row: T, key: string) => dense.find((c) => c.key === key)?.render(row) ?? null, [dense])
  const filterCount = activeFilterCount(filters)

  return (
    <div className="tms-page">
      {embedded ? null : (
        <div className="tms-page-head">
          <h1>{title}</h1>
          {viewTabs ? (
            <span className="tms-views-btn">
              <Eye size={15} aria-hidden="true" />
              Views
            </span>
          ) : null}
          <div className="tms-page-actions">
            {primaryAction ? (
              <button type="button" className="tms-btn tms-btn-primary" onClick={primaryAction.onClick}>
                <Plus size={16} aria-hidden="true" />
                {primaryAction.label}
              </button>
            ) : null}
            {actions}
          </div>
        </div>
      )}

      {quickTabs && folderTabs ? <TmsTabStrip tabs={quickTabs.tabs} active={quickTabs.active} onSelect={quickTabs.onSelect} /> : null}

      {viewTabs ? <TmsTabs tabs={viewTabs.tabs} active={viewTabs.active} onSelect={viewTabs.onSelect} /> : null}

      {search || onRefresh || filterChips?.length || fieldsLabel ? (
        <div className="tms-filter-row">
          {search ? (
            <div className="tms-search tms-filter-search">
              <Search className="tms-search-icon" size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label="Search"
                placeholder={search.placeholder ?? 'Search'}
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
              />
            </div>
          ) : null}
          {onRefresh ? (
            <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Refresh" onClick={onRefresh}>
              <RefreshCw size={15} />
            </button>
          ) : null}
          {filterChips?.map((chip) => (
            <TmsFilterChip key={chip.key} label={chip.label} value={chip.value} onClick={chip.onClick} />
          ))}
          {fieldsLabel ? (
            <button type="button" className="tms-fields-btn" onClick={onFields}>
              {fieldsLabel}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      {onAddFilter ? (
        <div>
          <button type="button" className="tms-add-filter" onClick={onAddFilter}>
            <Plus size={14} aria-hidden="true" />
            Filter
          </button>
        </div>
      ) : null}

      {quickTabs && !folderTabs ? (
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
      ) : null}

      {banner}

      <div className="tms-dense-page" data-testid="tms-list-grid">
        <div className="tms-dense-bar">
          <ClearFiltersButton count={filterCount} onClear={() => setFilters({})} />
          <span className="tms-dense-spacer" />
          <span className="tms-muted">
            {shown.length === rows.length ? `${rows.length} items` : `${shown.length} of ${rows.length} items`}
          </span>
          <ColumnsButton
            catalog={dense}
            columns={shownKeys}
            widths={prefs.widths}
            pinned={prefs.pinned}
            onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
          />
          <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
        </div>
        <div className="tms-dense-body" style={{ minHeight: 240, maxHeight: 'calc(100vh - 280px)' }}>
          <DenseGrid<T>
            aria-label={nodeText(title) || 'List'}
            recentKey={`tms:list:${gridId ?? slug(title)}:recent:${email || 'anon'}`}
            resetKey={`${JSON.stringify(filters)}|${JSON.stringify(activeSort)}`}
            columns={gridColumns}
            rows={shown}
            fitRows={rows}
            rowKey={rowKey}
            renderCell={renderCell}
            density={prefs.density}
            userWidths={prefs.widths}
            stickyCount={Math.max(1, prefs.pinned.length)}
            sort={activeSort}
            onSort={(key) => (onSort ? onSort(key) : prefs.setSort(nextSort(prefs.sort, key)))}
            filters={filters}
            onFilterChange={setColumnFilter}
            onReorder={(from, to) => prefs.setColumns(reorderKeys(shownKeys, from, to))}
            onResize={prefs.setWidth}
            onRowClick={onRowClick}
            onRowDoubleClick={onRowDoubleClick}
            empty={
              <TmsEmptyState
                message={emptyText ?? 'Please try again using a different query.'}
                actionLabel={onClearFilters || filterCount ? 'Click here to clear all filters' : undefined}
                onAction={() => { setFilters({}); onClearFilters?.() }}
                actionKey="C"
              />
            }
          />
        </div>
      </div>

      <div className="tms-footer">
        <span className="tms-footer-count">
          Showing{' '}
          <strong>
            {page?.from ?? 0} &ndash; {page?.to ?? 0}
          </strong>{' '}
          of <strong>{page?.total ?? 0}</strong> items
        </span>
        {page?.onPageSize ? (
          <select
            className="tms-page-size"
            aria-label="Page size"
            value={page.pageSize}
            onChange={(e) => page.onPageSize?.(Number(e.target.value))}
          >
            {(PAGE_SIZES.includes(page.pageSize) ? PAGE_SIZES : [page.pageSize, ...PAGE_SIZES]).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        ) : page ? (
          <span className="tms-page-size">{page.pageSize}</span>
        ) : null}
        {footerExtra}
        <div className="tms-footer-hints">
          {FOOTER_HINTS.map((hint) => (
            <TmsKeyHint key={hint}>{hint}</TmsKeyHint>
          ))}
        </div>
      </div>
    </div>
  )
}

export default TmsListPage
