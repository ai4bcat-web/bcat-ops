/**
 * A compact titled card of label · value rows (a page's headline totals, or a breakdown such as open
 * AR by division). Rows may carry muted sub-text, a tone, a share bar, and sub-rows indented under a
 * group. A row with `onClick` is a button; `active` marks it pressed (a filter toggle).
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

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

/** A stable key for a rendered amount: its text when it is a plain string or number. */
function valueKey(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : 'node'
}

export function TmsListCard({ title, total, rows, 'aria-label': ariaLabel, testId, className }: TmsListCardProps) {
  const hasShare = rows.some((r) => r.share != null)
  return (
    <section className={`tms-list-card${hasShare ? ' tms-list-card-shares' : ''}${className ? ` ${className}` : ''}`} aria-label={ariaLabel ?? title} data-testid={testId}>
      <div className="tms-list-card-head">
        <span className="tms-list-card-title">{title}</span>
        {total != null ? <strong key={valueKey(total)} className="tms-list-card-total">{total}</strong> : null}
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
              {/* Keyed on the amount so a new value mounts a fresh node: iOS Safari otherwise keeps the grid column sized for the
                  first value it saw ("$0.00" while loading) and longer amounts spill past the card. */}
              <span key={valueKey(row.value)} className="tms-list-row-value">{row.value ?? '—'}</span>
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

/** One headline number in a collapsed summary: the same label and value as a card row. */
export interface TmsSummaryChip {
  key: string
  label: string
  value: ReactNode
  sub?: string | null
  tone?: 'default' | 'good' | 'warn' | 'bad'
  title?: string
}

/** A single wrapping row of headline numbers: what a page shows while its cards are collapsed. */
export function TmsSummaryChips({ items, 'aria-label': ariaLabel, testId }: { items: TmsSummaryChip[]; 'aria-label'?: string; testId?: string }) {
  return (
    <ul className="tms-summary-chips" aria-label={ariaLabel} data-testid={testId}>
      {items.map((it) => (
        <li key={it.key} className={`tms-summary-chip${it.tone && it.tone !== 'default' ? ` tms-summary-chip-${it.tone}` : ''}`} title={it.title ?? (it.sub ? `${it.label} · ${it.sub}` : it.label)}>
          <span className="tms-summary-chip-label">{it.label}</span>
          <strong key={valueKey(it.value)} className="tms-summary-chip-value">{it.value ?? '—'}</strong>
          {it.sub ? <span className="tms-summary-chip-sub">{it.sub}</span> : null}
        </li>
      ))}
    </ul>
  )
}

const readOpen = (key: string): boolean => {
  try { return localStorage.getItem(key) === 'open' } catch { return false }
}

/**
 * The page-head band: `top` (view tabs, refresh) and `bottom` (status tabs, kept right above the
 * table) on the left, list cards right-aligned beside them. When narrow the cards sit between the two.
 *
 * With `collapseKey` the cards fold away (Ryne 2026-11-15: room for the list): closed by default,
 * `compact` shows the headline numbers instead, and the choice is remembered per viewer.
 */
export function TmsHeadBand({ top, bottom, cards, compact, collapseKey, testId }: {
  top?: ReactNode
  bottom?: ReactNode
  cards?: ReactNode
  compact?: ReactNode
  collapseKey?: string
  testId?: string
}) {
  const [open, setOpen] = useState(() => (collapseKey ? readOpen(collapseKey) : true))
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (collapseKey) try { localStorage.setItem(collapseKey, next ? 'open' : 'closed') } catch { /* per-viewer convenience only */ }
  }
  const toggleBtn = collapseKey && cards ? (
    <button type="button" className="tms-btn tms-btn-secondary tms-btn-sm tms-head-band-toggle" aria-expanded={open} data-testid={testId ? `${testId}-toggle` : 'head-band-toggle'} onClick={toggle}>
      {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      {open ? 'Hide details' : 'Show details'}
    </button>
  ) : null
  const showCards = Boolean(cards) && open
  return (
    <div className={`tms-head-band${showCards ? '' : ' tms-head-band-plain'}`} data-testid={testId}>
      <div className="tms-head-band-top">
        {top}
        {toggleBtn ? (
          <div className="tms-head-band-compact">
            {open ? null : compact}
            {toggleBtn}
          </div>
        ) : null}
      </div>
      {showCards ? <div className="tms-head-band-cards">{cards}</div> : null}
      <div className="tms-head-band-bottom">{bottom}</div>
    </div>
  )
}

export default TmsListCard
