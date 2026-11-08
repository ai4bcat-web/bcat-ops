import type { ReactNode } from 'react'
import { ChevronDown, Eye, Plus, RefreshCw, Search } from 'lucide-react'
import { TmsEmptyState } from './TmsEmptyState'
import { TmsFilterChip } from './TmsFilterChip'
import { TmsKeyHint } from './TmsKeyHint'
import { TmsTable } from './TmsTable'
import type { ColumnDef, TmsSort } from './TmsTable'
import { TmsTabs } from './TmsTabs'
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
}

const PAGE_SIZES = [20, 50, 100, 200]
const FOOTER_HINTS = ['F', '\u2193', ']', 'Enter', 'Tab', 'Esc']

/** The MVMNT list page, top to bottom exactly as MVMNT_UI_REFERENCE §2 describes it. */
export function TmsListPage<T>({
  title,
  primaryAction,
  viewTabs,
  quickTabs,
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
}: TmsListPageProps<T>) {
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

      {quickTabs ? (
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

      <TmsTable
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        sort={sort}
        onSort={onSort}
        onRowClick={onRowClick}
        onRowDoubleClick={onRowDoubleClick}
        empty={
          <TmsEmptyState
            message={emptyText ?? 'Please try again using a different query.'}
            actionLabel={onClearFilters ? 'Click here to clear all filters' : undefined}
            onAction={onClearFilters}
            actionKey="C"
          />
        }
      />

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
