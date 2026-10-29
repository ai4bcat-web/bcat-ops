import { ChevronLeft, Filter, Settings, SlidersHorizontal } from 'lucide-react'
import { TmsButton, TmsIconButton, TmsSelect } from '@/features/tms/kit'
import { BoardCheckbox, BoardRadio, BoardSectionTitle } from './parts'
import { BoardTagPicker } from './BoardTagPicker'
import type {
  BoardColumnTemplateOption,
  BoardDateFilter,
  BoardDateKey,
  BoardDetailDef,
  BoardDetailKey,
  BoardFilterSet,
  BoardFilterSetOption,
  BoardStatusKey,
} from './types'

const DATE_KEYS: BoardDateKey[] = ['ship', 'pickup', 'delivery', 'created']
const DATE_LABELS: Record<BoardDateKey, string> = {
  ship: 'Ship',
  pickup: 'Pick up',
  delivery: 'Delivery',
  created: 'Created',
}

const STATUS_LABELS: Record<BoardStatusKey, string> = {
  OPEN: 'Open',
  COVERED: 'Covered',
  DISPATCHED: 'Dispatched',
  ARRIVED: 'Arrived',
  DEPARTED: 'Departed',
  DELIVERED: 'Delivered',
  HOLD: 'Hold',
  RESERVED: 'Reserved',
  VOIDED: 'Voided',
}

const FLAG_LABELS: Record<keyof NonNullable<BoardFilterSet['flags']>, string> = {
  checkCallDue: 'Check call due',
  checkCallOverdue: 'Check call overdue',
  openExceptions: 'Open exceptions',
  docsMissing: 'Missing documents',
}

const FLAG_KEYS = Object.keys(FLAG_LABELS) as Array<keyof typeof FLAG_LABELS>

export interface BoardFilterPanelProps {
  collapsed: boolean
  onToggleCollapse: () => void
  /** Active view name shown in the view selector. */
  viewName: string
  filterSets: BoardFilterSetOption[]
  activeFilterSetId: string | null
  filterSetDirty: boolean
  onSelectFilterSet: (id: string) => void
  onCreateFilterSet: () => void
  onUpdateFilterSet: () => void
  onRevertFilterSet: () => void
  onDeleteFilterSet: () => void
  columnTemplates?: BoardColumnTemplateOption[]
  activeColumnTemplateId?: string | null
  onSelectColumnTemplate?: (id: string) => void
  onManageColumnTemplates?: () => void
  statuses: BoardStatusKey[]
  statusCounts: Record<BoardStatusKey, number>
  selectedStatuses: BoardStatusKey[]
  onToggleStatus: (status: BoardStatusKey) => void
  detailDefs: BoardDetailDef[]
  detailFilters: Partial<Record<BoardDetailKey, { values: string[]; exclude: boolean }>>
  onDetailChange: (key: BoardDetailKey, values: string[]) => void
  onDetailExcludeChange: (key: BoardDetailKey, exclude: boolean) => void
  dateFilters: Partial<Record<BoardDateKey, BoardDateFilter>>
  onDateChange: (key: BoardDateKey, filter: BoardDateFilter) => void
  flags: BoardFilterSet['flags']
  onFlagChange: (key: keyof NonNullable<BoardFilterSet['flags']>, checked: boolean) => void
  onClearFilters: () => void
  onResetFilters: () => void
  activeFilterCount: number
  /** localStorage namespace for per-facet recent values. */
  recentStorageKey: string
}

/**
 * The collapsible left filter panel for the Aljex-style shipments board.
 *
 * The page owns every value and callback; this component only arranges controls.
 */
export function BoardFilterPanel({
  collapsed,
  onToggleCollapse,
  viewName,
  filterSets,
  activeFilterSetId,
  filterSetDirty,
  onSelectFilterSet,
  onCreateFilterSet,
  onUpdateFilterSet,
  onRevertFilterSet,
  onDeleteFilterSet,
  columnTemplates,
  activeColumnTemplateId,
  onSelectColumnTemplate,
  onManageColumnTemplates,
  statuses,
  statusCounts,
  selectedStatuses,
  onToggleStatus,
  detailDefs,
  detailFilters,
  onDetailChange,
  onDetailExcludeChange,
  dateFilters,
  onDateChange,
  flags,
  onFlagChange,
  onClearFilters,
  onResetFilters,
  activeFilterCount,
  recentStorageKey,
}: BoardFilterPanelProps) {
  if (collapsed) {
    return (
      <aside className="tms-board-panel tms-board-panel-collapsed" aria-label="Filters collapsed">
        <TmsIconButton
          shape="square"
          aria-label="Expand filters"
          title="Expand filters"
          onClick={onToggleCollapse}
        >
          <SlidersHorizontal size={18} />
          {activeFilterCount > 0 ? (
            <span className="tms-board-count">{activeFilterCount}</span>
          ) : null}
        </TmsIconButton>
      </aside>
    )
  }

  return (
    <aside className="tms-board-panel" aria-label="Filters">
      <div className="tms-board-panel-head">
        <span className="tms-board-panel-title">
          <Filter size={16} />
          Filters
        </span>
        <TmsIconButton
          shape="plain"
          aria-label="Collapse filters"
          title="Collapse filters"
          onClick={onToggleCollapse}
        >
          <ChevronLeft size={18} />
        </TmsIconButton>
      </div>

      <div className="tms-board-panel-body">
        {/* View */}
        <section className="tms-board-panel-section">
          <BoardSectionTitle hint={filterSetDirty ? `Unsaved changes · ${viewName}` : viewName}>
            View
          </BoardSectionTitle>
          <div className="tms-board-panel-row">
            <TmsSelect
              className="tms-board-panel-select"
              value={activeFilterSetId ?? ''}
              onChange={(e) => onSelectFilterSet(e.target.value)}
              options={filterSets.map((fs) => ({ value: fs.id, label: fs.name }))}
              placeholder="Select a view"
              aria-label="View"
            />
          </div>
          <div className="tms-board-panel-actions">
            <TmsButton
              size="sm"
              variant="primary"
              onClick={onUpdateFilterSet}
              disabled={!filterSetDirty || !activeFilterSetId}
            >
              Save
            </TmsButton>
            <TmsButton size="sm" variant="secondary" onClick={onCreateFilterSet}>
              Save as view
            </TmsButton>
            <TmsButton size="sm" variant="secondary" onClick={onRevertFilterSet} disabled={!activeFilterSetId}>
              Revert
            </TmsButton>
            <TmsButton size="sm" variant="destructive" onClick={onDeleteFilterSet} disabled={!activeFilterSetId}>
              Delete
            </TmsButton>
          </div>
        </section>

        {/* Column template */}
        {columnTemplates ? (
          <section className="tms-board-panel-section">
            <BoardSectionTitle>Column Templates</BoardSectionTitle>
            <div className="tms-board-panel-row">
              <TmsSelect
                className="tms-board-panel-select"
                value={activeColumnTemplateId ?? ''}
                onChange={(e) => onSelectColumnTemplate?.(e.target.value)}
                options={columnTemplates.map((ct) => ({ value: ct.id, label: ct.name }))}
                placeholder="Select a template"
              />
              <TmsIconButton shape="square" aria-label="Manage column templates" title="Manage" onClick={onManageColumnTemplates}>
                <Settings size={16} />
              </TmsIconButton>
            </div>
          </section>
        ) : null}

        {/* Statuses */}
        <section className="tms-board-panel-section">
          <BoardSectionTitle>Statuses</BoardSectionTitle>
          <div className="tms-board-status-grid">
            {statuses.map((status) => (
              <BoardCheckbox
                key={status}
                id={`tms-status-${status}`}
                label={
                  <span className="tms-board-status-label">
                    {STATUS_LABELS[status]}{' '}
                    <span className="tms-board-status-count">{statusCounts[status] ?? 0}</span>
                  </span>
                }
                checked={selectedStatuses.includes(status)}
                onChange={() => onToggleStatus(status)}
              />
            ))}
          </div>
        </section>

        {/* Details */}
        <section className="tms-board-panel-section">
          <BoardSectionTitle hint="Exclude inverts a filter">Details</BoardSectionTitle>
          <div className="tms-board-detail-list">
            {detailDefs.map((def) => {
              const current = detailFilters[def.key] ?? { values: [], exclude: false }
              return (
                <div key={def.key} className="tms-board-detail-row">
                  <BoardTagPicker
                    facet={def.key}
                    label={def.label}
                    options={def.options}
                    values={current.values}
                    exclude={current.exclude}
                    onChange={(values) => onDetailChange(def.key, values)}
                    onExcludeChange={(exclude) => onDetailExcludeChange(def.key, exclude)}
                    recentStorageKey={recentStorageKey}
                  />
                </div>
              )
            })}
          </div>
        </section>

        {/* Dates */}
        <section className="tms-board-panel-section">
          {DATE_KEYS.map((key) => {
            const filter = dateFilters[key] ?? { mode: 'FIXED', date: null, from: null, to: null }
            return (
              <fieldset key={key} className="tms-board-date-group">
                <legend className="tms-board-date-legend">{DATE_LABELS[key]}</legend>
                <div className="tms-board-date-modes">
                  <BoardRadio
                    name={`tms-date-${key}`}
                    label="Fixed"
                    value="FIXED"
                    checked={filter.mode === 'FIXED'}
                    onChange={() => onDateChange(key, { mode: 'FIXED', date: filter.date ?? null })}
                  />
                  <BoardRadio
                    name={`tms-date-${key}`}
                    label="Range"
                    value="RANGE"
                    checked={filter.mode === 'RANGE'}
                    onChange={() => onDateChange(key, { mode: 'RANGE', from: filter.from ?? null, to: filter.to ?? null })}
                  />
                </div>
                {filter.mode === 'FIXED' ? (
                  <input
                    type="date"
                    className="tms-input"
                    value={filter.date ?? ''}
                    onChange={(e) => onDateChange(key, { ...filter, mode: 'FIXED', date: e.target.value || null })}
                  />
                ) : (
                  <div className="tms-board-date-range">
                    <input
                      type="date"
                      className="tms-input"
                      placeholder="From"
                      value={filter.from ?? ''}
                      onChange={(e) =>
                        onDateChange(key, { ...filter, mode: 'RANGE', from: e.target.value || null })
                      }
                    />
                    <input
                      type="date"
                      className="tms-input"
                      placeholder="To"
                      value={filter.to ?? ''}
                      onChange={(e) =>
                        onDateChange(key, { ...filter, mode: 'RANGE', to: e.target.value || null })
                      }
                    />
                  </div>
                )}
              </fieldset>
            )
          })}
        </section>

        {/* Tracking & paperwork */}
        <section className="tms-board-panel-section">
          <BoardSectionTitle>Tracking &amp; paperwork</BoardSectionTitle>
          <div className="tms-board-status-grid">
            {FLAG_KEYS.map((key) => (
              <BoardCheckbox
                key={key}
                id={`tms-flag-${key}`}
                label={FLAG_LABELS[key]}
                checked={Boolean(flags?.[key])}
                onChange={() => onFlagChange(key, !flags?.[key])}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="tms-board-panel-foot">
        <TmsButton variant="secondary" onClick={onClearFilters}>
          Clear filters
        </TmsButton>
        <TmsButton variant="primary" onClick={onResetFilters}>
          Reset filters
        </TmsButton>
      </div>
    </aside>
  )
}

export default BoardFilterPanel
