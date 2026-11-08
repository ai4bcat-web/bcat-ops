/**
 * Pure layout rules of the shipment form's 12-column field grid (feedback 10). A grid's fields are
 * laid out left to right; a row is complete when its spans sum to exactly 12. `rowsOf` groups spans
 * into rows and reports whether EVERY row is flush (no ragged right edge). It runs twice: on the
 * wide layout (the declared spans) and on the narrow layout (`narrowSpanOf`), so a card that is
 * symmetrical at 1440 is symmetrical at 1280 too.
 */
export const GRID_COLUMNS = 12

export interface RowsResult {
  rows: number[][]
  /** Every row sums to exactly 12 (a field wider than 12 or a short last row makes it false). */
  ok: boolean
}

export function rowsOf(spans: readonly number[]): RowsResult {
  const rows: number[][] = []
  let row: number[] = []
  let sum = 0
  let ok = true
  for (const span of spans) {
    if (!Number.isInteger(span) || span < 1 || span > GRID_COLUMNS) { ok = false; continue }
    if (sum + span > GRID_COLUMNS) { ok = false; rows.push(row); row = []; sum = 0 }
    row.push(span)
    sum += span
    if (sum === GRID_COLUMNS) { rows.push(row); row = []; sum = 0 }
  }
  if (row.length > 0) { ok = false; rows.push(row) }
  return { rows, ok }
}

/**
 * The span a field takes when its card is narrow (a 1280 px screen with the 360 px rail): a
 * quarter-width field becomes a half, anything wider fills the row. A field may declare its own
 * `narrow` span when its row would otherwise leave a lone half (an odd count of fields).
 */
export function narrowSpanOf(span: number, narrow?: number): number {
  if (narrow !== undefined) return narrow
  return span >= 6 ? GRID_COLUMNS : 6
}

/**
 * Spans for `n` fields that must fill whole 12-column rows with no ragged edge, wide and narrow.
 * For rows whose field count varies with a rate type (hours / pay %): 4 -> 3x4, 5 -> 4,4,4,6,6, ...
 * Narrow (half-width) layout: pairs, with the first field taking a full row when the count is odd.
 */
export function spread(n: number): { wide: number[]; narrow: number[] } {
  const WIDE: Record<number, number[]> = {
    1: [12], 2: [6, 6], 3: [4, 4, 4], 4: [3, 3, 3, 3], 5: [4, 4, 4, 6, 6], 6: [4, 4, 4, 4, 4, 4],
    7: [3, 3, 3, 3, 4, 4, 4], 8: [3, 3, 3, 3, 3, 3, 3, 3],
  }
  const wide = WIDE[n] ?? Array.from({ length: n }, () => 3)
  const narrow = n === 1 ? [12] : n % 2 === 0 ? Array.from({ length: n }, () => 6) : [12, ...Array.from({ length: n - 1 }, () => 6)]
  return { wide, narrow }
}
