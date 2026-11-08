import type { LegacyAljexColumn, LegacyAljexFields } from '../types/tms'

/**
 * The source columns of a stored `LegacyAljexRow.fields`, in file order. This is the reader that
 * lets any of the 486 Aljex columns be surfaced later without re-importing: the cell value and its
 * header text are kept together under `c<1-based position>`, so nothing needs the original file.
 * Malformed keys are ignored; DynamoDB hands back whatever was written.
 */
export function legacyAljexColumns(fields: LegacyAljexFields | null | undefined): LegacyAljexColumn[] {
  const columns: LegacyAljexColumn[] = []
  for (const [key, cell] of Object.entries(fields ?? {})) {
    const match = /^c(\d+)$/.exec(key)
    if (!match || cell == null || typeof cell.v !== 'string') continue
    columns.push({ position: Number(match[1]), header: typeof cell.h === 'string' ? cell.h : '', value: cell.v })
  }
  return columns.sort((a, b) => a.position - b.position)
}
