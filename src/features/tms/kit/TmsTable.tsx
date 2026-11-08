import type { ReactNode } from 'react'

export interface ColumnDef<T> {
  key: string
  header: string
  width?: number
  render: (row: T) => ReactNode
  sortable?: boolean
}

export interface TmsSort {
  key: string
  dir: 'asc' | 'desc'
}

export interface TmsTableProps<T> {
  columns: Array<ColumnDef<T>>
  rows: T[]
  rowKey: (row: T) => string
  sort?: TmsSort | null
  /** Called with the clicked column key; the page decides the next direction. */
  onSort?: (key: string) => void
  onRowClick?: (row: T) => void
  onRowDoubleClick?: (row: T) => void
  /** Rendered across the full width when there are no rows. */
  empty?: ReactNode
  className?: string
}

/**
 * The MVMNT list table: sticky 12px uppercase header, 14px rows with a hairline
 * bottom border, horizontal scroll for wide column sets.
 */
export function TmsTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  onRowDoubleClick,
  empty,
  className,
}: TmsTableProps<T>) {
  return (
    <div className={`tms-table-wrap${className ? ` ${className}` : ''}`}>
      <table className="tms-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={col.width ? { width: col.width, minWidth: col.width } : undefined}
                className={col.sortable && onSort ? 'tms-sortable' : undefined}
                aria-sort={
                  sort?.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                }
                onClick={col.sortable && onSort ? () => onSort(col.key) : undefined}
              >
                {col.header}
                {sort?.key === col.key ? (
                  <span className="tms-sort-dir" aria-hidden="true">
                    {sort.dir === 'asc' ? '\u2191' : '\u2193'}
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={Math.max(columns.length, 1)}>{empty}</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? 'tms-clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key}>{col.render(row)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export default TmsTable
