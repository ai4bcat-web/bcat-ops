/**
 * The body of one column's header filter. The kind comes from the column: a type-ahead for
 * text, a multi-select for facets (the R2 tag picker once the list is long), a from/to date
 * range, a min/max number range. Every edit applies at once; Clear drops just this column.
 */
import { useMemo } from 'react'
import { BoardCheckbox } from '@/features/shipments/board/parts'
import { BoardTagPicker } from '@/features/shipments/board/BoardTagPicker'
import { facetOptions, filterKindOf, type DenseColumn, type DenseColumnFilter } from './denseGridModel'

/** At or under this many options the multi-select lists them all; above it, it is the type-ahead tag picker. */
const CHECKLIST_MAX = 12

export interface DenseFilterPopoverProps<T> {
  column: DenseColumn<T>
  /** The rows the facet options are counted from (before this grid's filters). */
  rows: readonly T[]
  value: DenseColumnFilter | undefined
  onChange: (next: DenseColumnFilter | null) => void
  /** Namespaces the tag picker's recently-used values. */
  recentKey: string
}

export function DenseFilterPopover<T>({ column, rows, value, onChange, recentKey }: DenseFilterPopoverProps<T>) {
  const kind = filterKindOf(column)
  const facets = useMemo(() => (kind === 'multi' ? facetOptions(rows, column) : []), [kind, rows, column])
  const current = value ?? {}

  return (
    <div className="tms-dg-filter" role="group" aria-label={`${column.header} filter`}>
      {kind === 'text' && (
        <input
          type="text"
          className="tms-input tms-dg-filter-input"
          autoFocus
          placeholder={`Filter ${column.header}…`}
          aria-label={`Filter ${column.header}`}
          value={current.text ?? ''}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      )}

      {kind === 'multi' && facets.length <= CHECKLIST_MAX && (
        <div className="tms-dg-filter-list">
          {facets.map((f) => (
            <BoardCheckbox
              key={f.value}
              label={
                <>
                  {f.label}
                  <span className="tms-dg-filter-count">{f.count}</span>
                </>
              }
              aria-label={`${column.header}: ${f.label}`}
              checked={(current.values ?? []).includes(f.value)}
              onChange={(checked) => {
                const set = new Set(current.values ?? [])
                if (checked) set.add(f.value)
                else set.delete(f.value)
                onChange({ values: [...set], exclude: current.exclude })
              }}
            />
          ))}
          <BoardCheckbox
            label="Exclude"
            className={(current.values ?? []).length === 0 ? 'opacity-50' : ''}
            checked={current.exclude ?? false}
            onChange={(exclude) => onChange({ values: current.values ?? [], exclude })}
          />
        </div>
      )}

      {kind === 'multi' && facets.length > CHECKLIST_MAX && (
        <BoardTagPicker
          facet={`dg-${column.key}`}
          label={column.header}
          options={facets}
          values={current.values ?? []}
          exclude={current.exclude ?? false}
          onChange={(values) => onChange({ values, exclude: current.exclude })}
          onExcludeChange={(exclude) => onChange({ values: current.values ?? [], exclude })}
          recentStorageKey={recentKey}
        />
      )}

      {kind === 'date' && (
        <div className="tms-dg-filter-range">
          <label>
            From
            <input
              type="date"
              className="tms-input"
              aria-label={`${column.header} from`}
              value={current.from ?? ''}
              onChange={(e) => onChange({ from: e.target.value || undefined, to: current.to })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              className="tms-input"
              aria-label={`${column.header} to`}
              value={current.to ?? ''}
              onChange={(e) => onChange({ from: current.from, to: e.target.value || undefined })}
            />
          </label>
        </div>
      )}

      {kind === 'number' && (
        <div className="tms-dg-filter-range">
          <label>
            Min{column.numberUnit ? ` (${column.numberUnit})` : ''}
            <input
              type="number"
              className="tms-input"
              aria-label={`${column.header} min`}
              value={current.min ?? ''}
              onChange={(e) => onChange({ min: e.target.value === '' ? undefined : Number(e.target.value), max: current.max })}
            />
          </label>
          <label>
            Max{column.numberUnit ? ` (${column.numberUnit})` : ''}
            <input
              type="number"
              className="tms-input"
              aria-label={`${column.header} max`}
              value={current.max ?? ''}
              onChange={(e) => onChange({ min: current.min, max: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>
        </div>
      )}

      <button type="button" className="tms-dg-filter-clear" onClick={() => onChange(null)}>
        Clear
      </button>
    </div>
  )
}
