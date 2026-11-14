/**
 * The phone form of DenseGrid (Ryne 2026-11-14: billing and shipment lists unusable on a phone). Below 640px a row is a card: the
 * key fields on top (PRO, customer or carrier, amount, status pills), the other visible columns as label / value pairs under them, the
 * row's actions at the bottom. The checkbox stays for batch actions and a tap opens the row, exactly as on the table.
 *
 * Same columns, cells and handlers as the table: the page decides nothing new beyond which column keys go on top (`DenseCardLayout`).
 */
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { DenseColumn } from './denseGridModel'
import type { DenseCardLayout } from './denseCardLayout'

type Item<T> = { kind: 'row'; row: T } | { kind: 'group'; key: string; rows: T[] }

export interface DenseCardsProps<T> {
  items: Item<T>[]
  rows: T[]
  columns: DenseColumn<T>[]
  layout?: DenseCardLayout
  rowKey: (row: T) => string
  renderCell?: (row: T, columnKey: string) => ReactNode
  selectable: boolean
  selectedIds?: ReadonlySet<string>
  onToggle?: (id: string) => void
  onToggleAll?: () => void
  onRowClick?: (row: T) => void
  rowAttrs?: (row: T) => Record<string, string>
  toneOf?: (row: T) => string
  renderGroupHeader?: (key: string, shown: T[]) => ReactNode
  empty?: ReactNode
  ariaLabel: string
  testId?: string
}

export function DenseCards<T>({
  items, rows, columns, layout, rowKey, renderCell, selectable, selectedIds, onToggle, onToggleAll, onRowClick, rowAttrs, toneOf,
  renderGroupHeader, empty, ariaLabel, testId,
}: DenseCardsProps<T>) {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const titleKey = layout && byKey.has(layout.title) ? layout.title : columns.find((c) => c.header !== '')?.key
  const partyKey = layout?.party && byKey.has(layout.party) ? layout.party : undefined
  const amountKey = layout?.amount && byKey.has(layout.amount) ? layout.amount : undefined
  const pillKeys = (layout?.pills ?? []).filter((k) => byKey.has(k))
  const onTop = new Set([titleKey, partyKey, amountKey, ...pillKeys].filter(Boolean) as string[])
  // Header-less columns before the first named one are the page's own tick box (AR): they take the checkbox's place on the left.
  // Header-less columns after it are the row's actions.
  const firstNamed = columns.findIndex((c) => c.header !== '')
  const leadCols = columns.filter((c, i) => c.header === '' && i < firstNamed && !onTop.has(c.key))
  const actionCols = columns.filter((c, i) => c.header === '' && i > firstNamed && !onTop.has(c.key))
  const detailCols = columns.filter((c) => c.header !== '' && !onTop.has(c.key)).slice(0, layout?.detailCount ?? 6)
  const cell = (row: T, key: string) => (renderCell ? renderCell(row, key) : byKey.get(key)?.text(row))
  // A tap opens the row: the page's handler, or else the title's own link (Shipments draws the PRO as a link and has no row click).
  const openCard = (e: ReactMouseEvent<HTMLElement>, row: T) => {
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea, label')) return
    if (onRowClick) { onRowClick(row); return }
    e.currentTarget.querySelector<HTMLAnchorElement>('.tms-dg-card-title a[href]')?.click()
  }
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selectedIds?.has(rowKey(r)))

  return (
    <div className="tms-dg tms-dg-cards" data-testid={testId}>
      {selectable && rows.length > 0 && (
        <label className="tms-dg-cards-all">
          <input type="checkbox" checked={allSelected} onChange={() => onToggleAll?.()} aria-label="Select all rows" />
          Select all ({rows.length})
        </label>
      )}
      <div role="list" aria-label={ariaLabel} className="tms-dg-cards-list">
        {items.map((item) => {
          if (item.kind === 'group') {
            return (
              <div key={`g:${item.key}`} role="listitem" className="tms-dg-card-group" data-testid="dense-group" data-group-key={item.key}>
                {renderGroupHeader ? renderGroupHeader(item.key, item.rows) : item.key}
              </div>
            )
          }
          const row = item.row
          const id = rowKey(row)
          const selected = selectedIds?.has(id) ?? false
          return (
            <div
              key={id}
              role="listitem"
              className="tms-dg-card tms-dg-clickable"
              data-tone={toneOf?.(row)}
              data-selected={selected}
              {...rowAttrs?.(row)}
              onClick={(e) => openCard(e, row)}
            >
              {selectable && (
                <input
                  type="checkbox"
                  className="tms-dg-card-check"
                  aria-label={`Select row ${id}`}
                  checked={selected}
                  onChange={() => onToggle?.(id)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              {leadCols.length > 0 && (
                <div className="tms-dg-card-lead" onClick={(e) => e.stopPropagation()}>
                  {leadCols.map((c) => <span key={c.key}>{cell(row, c.key)}</span>)}
                </div>
              )}
              <div className="tms-dg-card-main">
                <div className="tms-dg-card-top">
                  {titleKey && <span className="tms-dg-card-title">{cell(row, titleKey)}</span>}
                  {amountKey && <span className="tms-dg-card-amount">{cell(row, amountKey)}</span>}
                </div>
                {partyKey && <div className="tms-dg-card-party">{cell(row, partyKey)}</div>}
                {pillKeys.length > 0 && <div className="tms-dg-card-pills">{pillKeys.map((k) => <span key={k}>{cell(row, k)}</span>)}</div>}
                {detailCols.length > 0 && (
                  <dl className="tms-dg-card-details">
                    {detailCols.map((c) => (
                      <div key={c.key}>
                        <dt>{c.header}</dt>
                        <dd>{cell(row, c.key)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {actionCols.length > 0 && (
                  // The row's own buttons (Mark paid, open) act on their own, not as a tap on the card.
                  <div className="tms-dg-card-actions" onClick={(e) => e.stopPropagation()}>
                    {actionCols.map((c) => <span key={c.key}>{cell(row, c.key)}</span>)}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {rows.length === 0 && empty != null && <div className="tms-dg-empty">{empty}</div>}
    </div>
  )
}
