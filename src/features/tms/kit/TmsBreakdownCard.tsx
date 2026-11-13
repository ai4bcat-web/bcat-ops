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

/** Rows grouped into blocks: a group or plain row starts a block, sub-rows join the block above. */
function blocksOf(rows: TmsBreakdownRow[]): TmsBreakdownRow[][] {
  const blocks: TmsBreakdownRow[][] = []
  for (const row of rows) {
    const last = blocks[blocks.length - 1]
    if (row.kind === 'sub' && last) last.push(row)
    else blocks.push([row])
  }
  return blocks
}

export function TmsBreakdownCard({ title, total, rows, selected = null, onSelect, 'aria-label': ariaLabel, testId }: TmsBreakdownCardProps) {
  const renderRow = (row: TmsBreakdownRow) => {
    const cls = `tms-breakdown-row${row.kind === 'group' ? ' tms-breakdown-row-group' : row.kind === 'sub' ? ' tms-breakdown-row-sub' : ''}`
    const inner = (
      <>
        <span className="tms-breakdown-label">{row.label}</span>
        <span className="tms-breakdown-value">{row.value}</span>
        <span className="tms-breakdown-share">{row.share == null ? '' : pct(row.share)}</span>
        {row.share == null ? null : (
          <span className="tms-breakdown-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(0, Math.min(1, row.share)) * 100}%` }} />
          </span>
        )}
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
  }
  return (
    <section className="tms-breakdown" aria-label={ariaLabel ?? title} data-testid={testId}>
      <div className="tms-breakdown-head">
        <span className="tms-breakdown-title">{title}</span>
        {total ? <strong className="tms-breakdown-total">{total}</strong> : null}
      </div>
      <div className="tms-breakdown-rows" role="group" aria-label={ariaLabel ?? title}>
        {blocksOf(rows).map((block) => (
          <div key={block[0].key} className="tms-breakdown-block">{block.map(renderRow)}</div>
        ))}
      </div>
    </section>
  )
}

export default TmsBreakdownCard
