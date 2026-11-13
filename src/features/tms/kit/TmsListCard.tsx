/**
 * A compact titled card of label · value rows (a page's headline totals, or a breakdown such as open
 * AR by division). Rows may carry muted sub-text, a tone, a share bar, and sub-rows indented under a
 * group. A row with `onClick` is a button; `active` marks it pressed (a filter toggle).
 */
import type { ReactNode } from 'react'

export interface TmsListRow {
  key: string
  label: string
  /** Preformatted; `null` renders an em dash. */
  value: ReactNode
  /** Muted text after the label (a count, a window). */
  sub?: string | null
  tone?: 'default' | 'good' | 'warn' | 'bad'
  /** 0–1 share of the card's total; draws a thin bar and a percent. */
  share?: number | null
  /** A group header (bold) or a sub-row (indented under the group above). */
  kind?: 'group' | 'sub' | 'row'
  /** Hover text; defaults to the label and sub-text. */
  title?: string
  onClick?: () => void
  active?: boolean
}

export interface TmsListCardProps {
  title: string
  /** Preformatted total beside the title. */
  total?: ReactNode
  rows: TmsListRow[]
  'aria-label'?: string
  testId?: string
  className?: string
}

const pct = (share: number) => `${Math.round(share * 100)}%`

export function TmsListCard({ title, total, rows, 'aria-label': ariaLabel, testId, className }: TmsListCardProps) {
  const hasShare = rows.some((r) => r.share != null)
  return (
    <section className={`tms-list-card${hasShare ? ' tms-list-card-shares' : ''}${className ? ` ${className}` : ''}`} aria-label={ariaLabel ?? title} data-testid={testId}>
      <div className="tms-list-card-head">
        <span className="tms-list-card-title">{title}</span>
        {total != null ? <strong className="tms-list-card-total">{total}</strong> : null}
      </div>
      <ul className="tms-list-card-rows">
        {rows.map((row) => {
          const cls = [
            'tms-list-row',
            row.kind === 'group' ? 'tms-list-row-group' : '',
            row.kind === 'sub' ? 'tms-list-row-sub' : '',
            row.tone && row.tone !== 'default' ? `tms-list-row-tone-${row.tone}` : '',
          ].filter(Boolean).join(' ')
          const inner = (
            <>
              <span className="tms-list-row-label">
                {row.label}
                {row.sub ? <span className="tms-list-row-sub-text">{row.sub}</span> : null}
              </span>
              <span className="tms-list-row-value">{row.value ?? '—'}</span>
              {hasShare ? <span className="tms-list-row-share">{row.share == null ? '' : pct(row.share)}</span> : null}
              {row.share == null ? null : (
                <span className="tms-list-row-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, Math.min(1, row.share)) * 100}%` }} />
                </span>
              )}
            </>
          )
          const hover = row.title ?? (row.sub ? `${row.label} · ${row.sub}` : undefined)
          return (
            <li key={row.key}>
              {row.onClick ? (
                <button type="button" className={cls} title={hover} aria-pressed={row.active === undefined ? undefined : row.active} onClick={row.onClick}>
                  {inner}
                </button>
              ) : <div className={cls} title={hover}>{inner}</div>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * The page-head band: `top` (view tabs, refresh) and `bottom` (status tabs, kept right above the
 * table) on the left, list cards right-aligned beside them. When narrow the cards sit between the two.
 */
export function TmsHeadBand({ top, bottom, cards, testId }: { top?: ReactNode; bottom?: ReactNode; cards?: ReactNode; testId?: string }) {
  return (
    <div className={`tms-head-band${cards ? '' : ' tms-head-band-plain'}`} data-testid={testId}>
      <div className="tms-head-band-top">{top}</div>
      {cards ? <div className="tms-head-band-cards">{cards}</div> : null}
      <div className="tms-head-band-bottom">{bottom}</div>
    </div>
  )
}

export default TmsListCard
