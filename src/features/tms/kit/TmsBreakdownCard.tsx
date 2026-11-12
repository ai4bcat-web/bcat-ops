/**
 * A titled card of label · amount · share rows (e.g. open AR by revenue division), sub-rows indented
 * under their group. Each row is a filter toggle when `onSelect` is given.
 */
export interface TmsBreakdownRow {
  /** The filter value this row selects. */
  key: string
  label: string
  /** Preformatted amount. */
  value: string
  /** 0–1 share of the card's total; omitted rows show no share. */
  share?: number | null
  /** A group header (bold) or a sub-row (indented). */
  kind?: 'group' | 'sub' | 'row'
  /** Hover text. */
  title?: string
  /** A row that is shown but not selectable (e.g. a group with no division-level slice). */
  readOnly?: boolean
}

export interface TmsBreakdownCardProps {
  title: string
  /** Preformatted total shown beside the title. */
  total?: string
  rows: TmsBreakdownRow[]
  /** The active row key, or null. */
  selected?: string | null
  /** Toggling the active row passes null. */
  onSelect?: (key: string | null) => void
  'aria-label'?: string
  testId?: string
}

const pct = (share: number) => `${Math.round(share * 100)}%`

export function TmsBreakdownCard({ title, total, rows, selected = null, onSelect, 'aria-label': ariaLabel, testId }: TmsBreakdownCardProps) {
  return (
    <section className="tms-breakdown" aria-label={ariaLabel ?? title} data-testid={testId}>
      <div className="tms-breakdown-head">
        <span className="tms-breakdown-title">{title}</span>
        {total ? <strong className="text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>{total}</strong> : null}
      </div>
      <div className="tms-breakdown-rows" role="group" aria-label={ariaLabel ?? title}>
        {rows.map((row) => {
          const cls = `tms-breakdown-row${row.kind === 'group' ? ' tms-breakdown-row-group' : row.kind === 'sub' ? ' tms-breakdown-row-sub' : ''}`
          const inner = (
            <>
              <span className="tms-breakdown-label">{row.label}</span>
              <span>{row.value}</span>
              <span className="tms-breakdown-share">{row.share == null ? '' : pct(row.share)}</span>
            </>
          )
          return onSelect && !row.readOnly ? (
            <button
              key={row.key}
              type="button"
              className={cls}
              title={row.title}
              aria-pressed={selected === row.key}
              onClick={() => onSelect(selected === row.key ? null : row.key)}
            >
              {inner}
            </button>
          ) : <div key={row.key} className={cls} title={row.title}>{inner}</div>
        })}
      </div>
    </section>
  )
}

export default TmsBreakdownCard
