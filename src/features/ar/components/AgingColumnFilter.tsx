/**
 * The funnel in an Aging column header and the small popover it opens: text for Customer, a pick-list
 * for Terms, a min/max for the number columns, a date range for Last paid, and the last-report choices.
 * Every edit applies at once and shares its state with the filter row above the table, so the two never
 * disagree. Looks and behaves like the funnels on the Payable table.
 */
import { useEffect, useRef, useState } from 'react'
import { Filter } from 'lucide-react'
import { BoardCheckbox } from '@/features/shipments/board/parts'
import '@/features/tms/grid/dense-grid.css'
import {
  AGING_STATEMENT_FILTER_LABEL,
  type AgingFilters,
  type AgingRangeKey,
  type AgingStatementFilter,
} from '../agingReport'
import { clearColumnFilter, columnFilterActive, type AgingFilterColumn } from '../agingColumnFilters'

const MONEY: ReadonlySet<AgingFilterColumn> = new Set(['D1_30', 'D31_60', 'D61_90', 'D91_PLUS', 'total', 'pastDue'])
const POP_W = 260

const numOrUndef = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v))
const numOrNull = (v: string): number | null => numOrUndef(v) ?? null

export function AgingColumnFilter({ column, label, filters, onChange, termsOptions }: {
  column: AgingFilterColumn
  label: string
  filters: AgingFilters
  onChange: (next: AgingFilters) => void
  termsOptions: number[]
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const active = columnFilterActive(column, filters)

  useEffect(() => {
    if (!at) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (pop.current?.contains(t) || btn.current?.contains(t)) return
      setAt(null)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAt(null); btn.current?.focus() } }
    const close = () => setAt(null)
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [at])

  const toggle = () => {
    if (at) { setAt(null); return }
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    // Below the header, kept inside the window sideways.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8))
    setAt({ top: r.bottom + 4, left })
  }

  const setRange = (patch: { min?: number | undefined; max?: number | undefined }) => {
    const cur = filters.ranges[column as AgingRangeKey] ?? {}
    const next = { ...cur, ...patch }
    const { [column as AgingRangeKey]: _old, ...rest } = filters.ranges
    void _old
    const empty = next.min == null && next.max == null
    onChange({ ...filters, ranges: empty ? rest : { ...rest, [column]: next } })
  }
  const range = filters.ranges[column as AgingRangeKey] ?? {}
  const unit = MONEY.has(column) ? '$' : column === 'count' ? '' : 'days'

  const body = () => {
    if (column === 'customer') {
      return (
        <input type="text" className="tms-input tms-dg-filter-input" autoFocus placeholder="Customer contains…" aria-label="Filter customer"
          value={filters.customer} onChange={(e) => onChange({ ...filters, customer: e.target.value })} />
      )
    }
    if (column === 'terms') {
      return (
        <select className="tms-input tms-dg-filter-input" autoFocus aria-label="Filter terms" value={filters.terms}
          onChange={(e) => onChange({ ...filters, terms: e.target.value })}>
          <option value="">Any terms</option>
          {termsOptions.map((d) => <option key={d} value={String(d)}>Net {d}</option>)}
        </select>
      )
    }
    if (column === 'lastPaid') {
      return (
        <>
          <div className="tms-dg-filter-range">
            <label>From
              <input type="date" className="tms-input" aria-label="Last paid from" value={filters.lastPaidFrom}
                onChange={(e) => onChange({ ...filters, lastPaidFrom: e.target.value, lastPaidBlank: false })} />
            </label>
            <label>To
              <input type="date" className="tms-input" aria-label="Last paid to" value={filters.lastPaidTo}
                onChange={(e) => onChange({ ...filters, lastPaidTo: e.target.value, lastPaidBlank: false })} />
            </label>
          </div>
          <BoardCheckbox label="No payment yet" aria-label="Last paid: no payment yet" checked={filters.lastPaidBlank}
            onChange={(on) => onChange({ ...filters, lastPaidBlank: on, lastPaidFrom: on ? '' : filters.lastPaidFrom, lastPaidTo: on ? '' : filters.lastPaidTo })} />
        </>
      )
    }
    if (column === 'lastStatement') {
      const choice = filters.statementWithinDays != null ? 'within' : filters.statementOlderDays != null ? 'older' : filters.statement
      const pick = (v: string) => {
        if (v === 'within') onChange({ ...filters, statement: '', statementWithinDays: filters.statementWithinDays ?? 7, statementOlderDays: null })
        else if (v === 'older') onChange({ ...filters, statement: '', statementOlderDays: filters.statementOlderDays ?? 14, statementWithinDays: null })
        else onChange({ ...filters, statement: v as AgingStatementFilter, statementWithinDays: null, statementOlderDays: null })
      }
      return (
        <>
          <select className="tms-input tms-dg-filter-input" autoFocus aria-label="Filter last aging report" value={choice} onChange={(e) => pick(e.target.value)}>
            <option value="">Any last report</option>
            {(Object.keys(AGING_STATEMENT_FILTER_LABEL) as Array<Exclude<AgingStatementFilter, ''>>).map((k) => (
              <option key={k} value={k}>{AGING_STATEMENT_FILTER_LABEL[k]}</option>
            ))}
            <option value="within">Sent within the last N days…</option>
            <option value="older">Not sent in N+ days…</option>
          </select>
          {choice === 'within' && (
            <label className="tms-dg-filter-range"><span>Days</span>
              <input type="number" min={0} className="tms-input" aria-label="Sent within days" value={filters.statementWithinDays ?? ''}
                onChange={(e) => onChange({ ...filters, statementWithinDays: numOrNull(e.target.value) ?? 0 })} />
            </label>
          )}
          {choice === 'older' && (
            <label className="tms-dg-filter-range"><span>Days</span>
              <input type="number" min={0} className="tms-input" aria-label="Not sent in days" value={filters.statementOlderDays ?? ''}
                onChange={(e) => onChange({ ...filters, statementOlderDays: numOrNull(e.target.value) ?? 0 })} />
            </label>
          )}
        </>
      )
    }
    return (
      <div className="tms-dg-filter-range">
        <label>Min{unit ? ` (${unit})` : ''}
          <input type="number" className="tms-input" autoFocus aria-label={`${label} min`} value={range.min ?? ''}
            onChange={(e) => setRange({ min: numOrUndef(e.target.value) })} />
        </label>
        <label>Max{unit ? ` (${unit})` : ''}
          <input type="number" className="tms-input" aria-label={`${label} max`} value={range.max ?? ''}
            onChange={(e) => setRange({ max: numOrUndef(e.target.value) })} />
        </label>
      </div>
    )
  }

  return (
    <>
      <button ref={btn} type="button" className={`tms-dg-filter-btn${active ? ' tms-active' : ''}`} aria-label={`Filter ${label}`}
        aria-haspopup="dialog" aria-expanded={at != null} title={active ? `${label} filter on` : `Filter ${label}`} onClick={toggle}
        data-testid={`aging-col-filter-${column}`}>
        <Filter size={11} aria-hidden="true" fill={active ? 'currentColor' : 'none'} />
      </button>
      {/* Fixed to the window, so the table's sideways scroll box can't clip it; it sits inside the shell like the Payable table's. */}
      {at && (
        <div ref={pop} className="tms-dg-popover" style={{ top: at.top, left: at.left, width: POP_W }} role="dialog" aria-label={`${label} filter`}>
          <div className="tms-dg-filter" role="group" aria-label={`${label} filter`}>
            {body()}
            <button type="button" className="tms-dg-filter-clear" onClick={() => onChange(clearColumnFilter(column, filters))}>Clear</button>
          </div>
        </div>
      )}
    </>
  )
}
