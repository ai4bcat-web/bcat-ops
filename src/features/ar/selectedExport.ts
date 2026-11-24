/**
 * "Export selected" for the Invoicing tables: the ticked rows, in the order the grid shows them, with the columns the grid shows.
 * Internal (it carries carrier rate and profit when those columns are on screen), so it is only ever offered on the Invoicing page.
 */
import { csvCell } from '@/lib/aljexReconcile'
import type { DenseColumn } from '@/features/tms/grid/denseGridModel'

/** A column's CSV value: dollar columns as plain numbers (1250.00), anything else as its on-screen text; "—" becomes blank. */
export function exportCellOf<T>(col: DenseColumn<T>, row: T): string {
  const text = col.text(row)
  if (text === '—' || text === '…') return ''
  if (col.filter === 'number' && col.numberUnit === '$' && col.numberOf) {
    const n = col.numberOf(row)
    if (n != null) return n.toFixed(2)
  }
  return text
}

/** Header row plus one row per selected record. Fixed columns (tick box, row actions) are left out. */
export function selectedRowsCsv<T>(columns: ReadonlyArray<DenseColumn<T>>, rows: readonly T[]): string {
  const cols = columns.filter((c) => !c.fixed && c.header.trim() !== '')
  const lines = [cols.map((c) => csvCell(c.header)).join(',')]
  for (const row of rows) lines.push(cols.map((c) => csvCell(exportCellOf(c, row))).join(','))
  return lines.join('\r\n')
}
