/**
 * The body of one column's header filter. The kind comes from the column: a type-ahead for
 * text, a multi-select checklist for facets (searchable once long, with Select all), a from/to
 * date range, a min/max number range. Every edit applies at once; Clear drops just this column.
 */
import { useMemo, useState } from 'react'
import { BoardCheckbox } from '@/features/shipments/board/parts'
import { pushRecent, readRecent } from '@/features/shipments/board/detailSearch'
import { facetOptions, filterKindOf, type DenseColumn, type DenseColumnFilter, type DenseFacet } from './denseGridModel'

/** Above this many options the checklist gets a search box. */
const SEARCH_MIN = 8
/** The checklist draws at most this many rows; the search box narrows the rest. */
const LIST_MAX = 200

export interface DenseFilterPopoverProps<T> {
  column: DenseColumn<T>
  /** The rows the facet options are counted from (before this grid's filters). */
  rows: readonly T[]
  value: DenseColumnFilter | undefined
  onChange: (next: DenseColumnFilter | null) => void
  /** Namespaces the multi-select's recently-used values. */
  recentKey: string
}

function MultiSelect<T>({
  column,
  facets,
  current,
  onChange,
  recentKey,
}: {
  column: DenseColumn<T>
  facets: DenseFacet[]
  current: DenseColumnFilter
  onChange: (next: DenseColumnFilter | null) => void
  recentKey: string
}) {
  const [query, setQuery] = useState('')
  const facet = `dg-${column.key}`
  const selected = current.values ?? []
  const recents = useMemo(() => readRecent(recentKey, facet), [recentKey, facet])
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle) return facets.filter((f) => f.label.toLowerCase().includes(needle))
    // Recently picked values float to the top; the rest keep the facet order.
    const rank = (value: string) => {
      const i = recents.indexOf(value)
      return i < 0 ? recents.length : i
    }
    return [...facets].sort((a, b) => rank(a.value) - rank(b.value))
  }, [facets, query, recents])
  const visible = matches.slice(0, LIST_MAX)
  const setValues = (values: string[]) => onChange({ values, exclude: current.exclude })

  return (
    <>
      {facets.length > SEARCH_MIN && (
        <input
          type="text"
          className="tms-input tms-dg-filter-input"
          autoFocus
          placeholder={`Search ${column.header}…`}
          aria-label={`Search ${column.header} options`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="tms-dg-filter-actions">
        <button
          type="button"
          className="tms-dg-filter-clear"
          aria-label={`Select all ${column.header}`}
          disabled={matches.length === 0}
          onClick={() => setValues([...new Set([...selected, ...matches.map((f) => f.value)])])}
        >
          {query.trim() ? `Select all ${matches.length} shown` : 'Select all'}
        </button>
        <BoardCheckbox
          label="Exclude"
          className={selected.length === 0 ? 'opacity-50' : ''}
          checked={current.exclude ?? false}
          onChange={(exclude) => onChange({ values: selected, exclude })}
        />
      </div>
      <div className="tms-dg-filter-list">
        {visible.map((f) => (
          <BoardCheckbox
            key={f.value}
            label={
              <>
                {f.label}
                <span className="tms-dg-filter-count">{f.count}</span>
              </>
            }
            aria-label={`${column.header}: ${f.label}`}
            checked={selected.includes(f.value)}
            onChange={(checked) => {
              const set = new Set(selected)
              if (checked) {
                set.add(f.value)
                pushRecent(recentKey, facet, f.value)
              } else set.delete(f.value)
              setValues([...set])
            }}
          />
        ))}
        {matches.length === 0 && <span className="tms-dg-filter-count">No match</span>}
        {matches.length > visible.length && (
          <span className="tms-dg-filter-count">{matches.length - visible.length} more: type to narrow</span>
        )}
      </div>
    </>
  )
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

      {kind === 'multi' && (
        <MultiSelect column={column} facets={facets} current={current} onChange={onChange} recentKey={recentKey} />
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
