import type { ReactNode } from 'react'

/**
 * A cell's content: what `renderCell` draws, or the column's own text when `renderCell` has nothing
 * to say for that column (returns undefined). Null still means "draw nothing". Views only override
 * the cells they decorate; every other column falls back to its text instead of rendering blank.
 */
export function cellContent<T>(renderCell: ((row: T, key: string) => ReactNode) | undefined, row: T, col: { key: string; text: (row: T) => string }): ReactNode {
  const drawn = renderCell?.(row, col.key)
  return drawn === undefined ? col.text(row) : drawn
}
