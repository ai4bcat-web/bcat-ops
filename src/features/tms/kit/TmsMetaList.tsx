import type { ReactNode } from 'react'

export interface TmsMetaItem {
  label: ReactNode
  value: ReactNode
  hidden?: boolean
  /** Spans every column. */
  wide?: boolean
  testId?: string
}

export interface TmsMetaListProps {
  items: TmsMetaItem[]
  columns?: 1 | 2 | 3 | 4
  /** Hairline between rows; defaults to on for a single column. */
  dividers?: boolean
  dense?: boolean
  className?: string
}

function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === '' || value === false
}

/** Label/value rows. An empty value renders a muted dash, never a blank. */
export function TmsMetaList({ items, columns = 1, dividers, dense, className }: TmsMetaListProps) {
  const lines = dividers ?? columns === 1
  const classes = [
    'tms-meta',
    `tms-meta-cols-${columns}`,
    lines ? 'tms-meta-dividers' : '',
    dense ? 'tms-meta-dense' : '',
    className ?? '',
  ].filter(Boolean).join(' ')
  return (
    <dl className={classes}>
      {items
        .filter((item) => !item.hidden)
        .map((item, index) => (
          <div
            key={index}
            className={`tms-meta-row${item.wide ? ' tms-meta-wide' : ''}`}
            data-testid={item.testId}
          >
            <dt className="tms-meta-label">{item.label}</dt>
            <dd className={`tms-meta-value${isEmpty(item.value) ? ' tms-meta-empty' : ''}`}>
              {isEmpty(item.value) ? '—' : item.value}
            </dd>
          </div>
        ))}
    </dl>
  )
}

export default TmsMetaList
