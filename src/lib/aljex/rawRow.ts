/**
 * Lossless capture of one export row for the `LegacyAljexRow` side table (DECIDED-2). Sparse JSON of
 * every non-empty cell, verbatim, keyed by 1-based column position (`c7`) with the header text
 * beside the value (header text repeats, the position never does). This is exactly the stored
 * `LegacyAljexRow.fields` shape; the reader surfaces any column later without re-importing.
 */

export type RawFields = Record<string, { h: string; v: string }>

export interface RawColumn {
  /** 1-based column position. */
  position: number
  header: string
  value: string
}

/** Every cell whose text is not blank, verbatim. Cells past the header width are ignored (the row is an error row anyway). */
export function buildRawRow(cells: readonly string[], headers: readonly string[]): RawFields {
  const out: RawFields = {}
  const limit = Math.min(cells.length, headers.length)
  for (let i = 0; i < limit; i++) {
    const v = cells[i]
    if (v != null && v.trim() !== '') out[`c${i + 1}`] = { h: headers[i], v }
  }
  return out
}

/** Accept the stored JSON text or the parsed object. Malformed/non-object input reads as empty. */
function asRecord(fields: unknown): Record<string, unknown> {
  let v = fields
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** All non-empty columns in position order. */
export function rawRowColumns(fields: unknown): RawColumn[] {
  const out: RawColumn[] = []
  for (const [k, cell] of Object.entries(asRecord(fields))) {
    const m = /^c(\d+)$/.exec(k)
    const c = cell as { h?: unknown; v?: unknown } | null
    if (m && c && typeof c.h === 'string' && typeof c.v === 'string') out.push({ position: Number(m[1]), header: c.h, value: c.v })
  }
  return out.sort((a, b) => a.position - b.position)
}

/**
 * One column by 1-based position (number) or by header text (string, case-insensitive; first
 * occurrence when the header repeats). null when the cell was blank or the column does not exist.
 */
export function readRawColumn(fields: unknown, column: number | string): string | null {
  const cols = rawRowColumns(fields)
  if (typeof column === 'number') return cols.find((c) => c.position === column)?.value ?? null
  const want = column.trim().toLowerCase()
  return cols.find((c) => c.header.trim().toLowerCase() === want)?.value ?? null
}
