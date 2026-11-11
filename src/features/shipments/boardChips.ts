/**
 * Step AP — the board's quick filter chips and their live counts. Each chip counts the
 * shipments in the current list (after search, scope and voided/demo handling, before the
 * chips themselves, so a chip's count does not move when another chip is pressed).
 * Order is the display order: Check call overdue closes the row.
 */
import { checkCallState } from '@/lib/checkCalls'
import { needsBillingReview, REVIEW_BILLING_LABEL } from '@/lib/reviewBilling'
import { reviewFactsOfRow } from './batchReview'
import { docsMissingOf, type ShipmentRow } from './shipmentViews'

export type BoardFlag = 'missingReference' | 'missingSalesRep' | 'missingRevDivision' | 'docsMissing' | 'reviewBilling' | 'checkCallOverdue'

export const BOARD_FLAGS: readonly BoardFlag[] = [
  'missingReference',
  'missingSalesRep',
  'missingRevDivision',
  'docsMissing',
  'reviewBilling',
  'checkCallOverdue',
]

export const BOARD_FLAG_LABELS: Record<BoardFlag, string> = {
  missingReference: 'Missing reference #',
  missingSalesRep: 'Needs sales rep',
  missingRevDivision: 'Missing rev division',
  docsMissing: 'Missing documents',
  reviewBilling: REVIEW_BILLING_LABEL,
  checkCallOverdue: 'Check call overdue',
}

const hasText = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim() !== ''

/**
 * No rep at all: neither a profile id (`salesRepId`) nor the Aljex rep name kept as text (`salesRepCode`, which is how
 * people without a login, and the BCAT division, stay on migrated shipments). Reads both because the profile ids only
 * exist once the profile backfill has been applied.
 */
export function needsSalesRep(row: Pick<ShipmentRow, 'salesRepId' | 'salesRepCode'>): boolean {
  return !hasText(row.salesRepId) && !hasText(row.salesRepCode)
}

export function matchesFlag(row: ShipmentRow, flag: BoardFlag, nowMs: number): boolean {
  switch (flag) {
    case 'missingReference': return !reviewFactsOfRow(row).referenceNumber
    case 'missingSalesRep': return needsSalesRep(row)
    case 'missingRevDivision': return !row.revDivision
    case 'docsMissing': return docsMissingOf(row).length > 0
    case 'reviewBilling': return needsBillingReview(row)
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
