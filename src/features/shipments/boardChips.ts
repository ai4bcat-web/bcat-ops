/**
 * Step AP — the board's quick filter chips and their live counts. Each chip counts the
 * shipments in the current list (after search, scope and voided/demo handling, before the
 * chips themselves, so a chip's count does not move when another chip is pressed).
 * Order is the display order: Check call overdue closes the row.
 */
import { checkCallState } from '@/lib/checkCalls'
import { reviewFactsOfRow } from './batchReview'
import type { ShipmentRow } from './shipmentViews'

export type BoardFlag = 'missingReference' | 'missingSalesRep' | 'missingRevDivision' | 'docsMissing' | 'checkCallOverdue'

export const BOARD_FLAGS: readonly BoardFlag[] = [
  'missingReference',
  'missingSalesRep',
  'missingRevDivision',
  'docsMissing',
  'checkCallOverdue',
]

export const BOARD_FLAG_LABELS: Record<BoardFlag, string> = {
  missingReference: 'Missing reference #',
  missingSalesRep: 'Missing sales rep',
  missingRevDivision: 'Missing rev division',
  docsMissing: 'Missing documents',
  checkCallOverdue: 'Check call overdue',
}

export function matchesFlag(row: ShipmentRow, flag: BoardFlag, nowMs: number): boolean {
  switch (flag) {
    case 'missingReference': return !reviewFactsOfRow(row).referenceNumber
    case 'missingSalesRep': return !row.salesRepId
    case 'missingRevDivision': return !row.revDivision
    case 'docsMissing': return (row.docsMissing?.length ?? 0) > 0
    case 'checkCallOverdue': return checkCallState({ nextCheckCallAt: row.nextCheckCallAt }, nowMs) === 'OVERDUE'
  }
}

/** Every pressed chip must match (AND), as the quick toggles always did. */
export function matchesFlags(row: ShipmentRow, flags: ReadonlySet<BoardFlag>, nowMs: number): boolean {
  for (const flag of flags) if (!matchesFlag(row, flag, nowMs)) return false
  return true
}

export function flagCounts(rows: readonly ShipmentRow[], nowMs: number): Record<BoardFlag, number> {
  const counts = Object.fromEntries(BOARD_FLAGS.map((f) => [f, 0])) as Record<BoardFlag, number>
  for (const row of rows) for (const flag of BOARD_FLAGS) if (matchesFlag(row, flag, nowMs)) counts[flag] += 1
  return counts
}
