import type { ReactNode } from 'react'

export interface BoardGridColumn {
  key: string
  header: string
  sortable?: boolean
  width?: number
}

export interface BoardGridSort {
  key: string
  dir: 'asc' | 'desc'
}

export interface BoardGridProps<T> {
  columns: BoardGridColumn[]
  rows: T[]
  rowKey: (row: T) => string
  selectedIds: string[]
  toneOf: (row: T) => string
  onToggle: (id: string) => void
  onToggleAll: () => void
  /** False hides the selection-checkbox column entirely (default true). */
  selectable?: boolean
  /** Extra data-* attributes stamped on each <tr> (verification hooks). */
  rowDataAttrs?: (row: T) => Record<string, string>
  sort?: BoardGridSort | null
  onSort?: (key: string) => void
  onRowClick?: (row: T) => void
  onRowDoubleClick?: (row: T) => void
  renderCell: (row: T, columnKey: string) => ReactNode
}

/** The first three columns stay visible while the rest of the grid scrolls. */
const STICKY_INDEX = [true, true, true]

/**
 * A dense, horizontally-scrollable grid with sticky leading columns, whole-row tone,
 * row selection, and sortable headers.
 */
export function BoardGrid<T>({
  columns,
  rows,
  rowKey,
  selectedIds,
  toneOf,
  onToggle,
  onToggleAll,
  selectable = true,
  rowDataAttrs,
  sort,
  onSort,
  onRowClick,
  onRowDoubleClick,
  renderCell,
}: BoardGridProps<T>) {
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.includes(rowKey(row)))
  const someSelected = rows.some((row) => selectedIds.includes(rowKey(row)))
  // Without the checkbox column the sticky columns shift one slot left.
  const stickyOffset = selectable ? 1 : 0

  return (
    <div className="tms-board-grid-wrap">
      <table className="tms-board-grid">
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className="tms-board-sticky tms-board-sticky-0 tms-board-col-check">
                <input
                  type="checkbox"
                  className="tms-board-check-input"
                  aria-label="Select all rows"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected
                  }}
                  onChange={onToggleAll}
                />
              </th>
            )}
            {columns.map((col, index) => (
              <th
                key={col.key}
                scope="col"
                className={
                  STICKY_INDEX[index + stickyOffset]
                    ? `tms-board-sticky tms-board-sticky-${index + stickyOffset}`
                    : undefined
                }
                style={col.width ? { width: col.width, minWidth: col.width } : undefined}
                aria-sort={sort?.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                onClick={col.sortable && onSort ? () => onSort(col.key) : undefined}
              >
                <span className={col.sortable && onSort ? 'tms-board-sortable' : undefined}>
                  {col.header}
                  {sort?.key === col.key ? (
                    <span className="tms-board-sort-dir" aria-hidden="true">
                      {sort.dir === 'asc' ? '↑' : '↓'}
                    </span>
                  ) : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = rowKey(row)
            const selected = selectedIds.includes(id)
            return (
              <tr
                key={id}
                data-tone={toneOf(row)}
                data-selected={selected}
                {...(rowDataAttrs ? rowDataAttrs(row) : undefined)}
                className={onRowClick ? 'tms-board-clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
              >
                {selectable && (
                  <td className="tms-board-sticky tms-board-sticky-0 tms-board-col-check">
                    <input
                      type="checkbox"
                      className="tms-board-check-input"
                      aria-label={`Select row ${id}`}
                      checked={selected}
                      onChange={() => onToggle(id)}
                    />
                  </td>
                )}
                {columns.map((col, index) => (
                  <td
                    key={col.key}
                    className={
                      STICKY_INDEX[index + stickyOffset]
                        ? `tms-board-sticky tms-board-sticky-${index + stickyOffset}`
                        : undefined
                    }
                  >
                    {renderCell(row, col.key)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default BoardGrid
