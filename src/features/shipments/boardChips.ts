/**
 * Step AP — the board's quick filter chips and their live counts. Each chip counts the
 * shipments in the current list (after search, scope and voided/demo handling, before the
 * chips themselves, so a chip's count does not move when another chip is pressed).
 * Order is the display order: Check call overdue closes the row.
 */
import { checkCallState } from '@/lib/checkCalls'
import { chicagoDateStr, formatBoardDate } from '@/lib/date'
import { boardStatusOf } from '@/lib/shipmentViewDefs'
import { needsBillingReview, REVIEW_BILLING_LABEL } from '@/lib/reviewBilling'
import { reviewFactsOfRow } from './batchReview'
import { docsMissingOf, type ShipmentRow } from './shipmentViews'

export type BoardFlag = 'missingReference' | 'missingSalesRep' | 'missingRevDivision' | 'docsMissing' | 'reviewBilling' | 'checkCallOverdue' | 'pastDeliveryDate'

export const BOARD_FLAGS: readonly BoardFlag[] = [
  'missingReference',
  'missingSalesRep',
  'missingRevDivision',
  'docsMissing',
  'reviewBilling',
  'checkCallOverdue',
]
// pastDeliveryDate is a BoardFlag too, but it is toggled from the stats strip, not the chip row.

export const BOARD_FLAG_LABELS: Record<BoardFlag, string> = {
  missingReference: 'Missing reference #',
  missingSalesRep: 'Needs sales rep',
  missingRevDivision: 'Missing rev division',
  docsMissing: 'Missing documents',
  reviewBilling: REVIEW_BILLING_LABEL,
  checkCallOverdue: 'Check call overdue',
  pastDeliveryDate: 'Past delivery date',
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
    case 'pastDeliveryDate': return pastDeliveryOf(row, nowMs) != null
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

export interface PastDelivery {
  /** The scheduled delivery day, YYYY-MM-DD in Chicago time. */
  day: string
  /** Whole days since that day (at least 1). */
  daysLate: number
  /** "Scheduled delivery Nov 10, 2026 — not marked delivered (2 days)" */
  tooltip: string
}

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/**
 * How many whole days ago the scheduled delivery day was (the last delivery stop's appointment, or the end of
 * its window, as a Chicago calendar day), whatever the status; null when there is no appointment or the day
 * has not passed. `label` reads "Nov 10, 2026".
 */
export function scheduledDeliveryLateOf(
  row: Pick<ShipmentRow, 'deliveryAppt' | 'deliveryApptEnd'>,
  nowMs: number,
): { day: string; daysLate: number; label: string } | null {
  const days = [row.deliveryAppt, row.deliveryApptEnd].map((v) => (v ? chicagoDateStr(v) : '')).filter(Boolean)
  if (days.length === 0) return null
  const day = days.sort()[days.length - 1]
  const today = chicagoDateStr(new Date(nowMs))
  const daysLate = dayNumber(today) - dayNumber(day)
  if (daysLate < 1) return null
  const [y, m, d] = day.split('-').map(Number)
  return { day, daysLate, label: `${formatBoardDate(new Date(Date.UTC(y, m - 1, d, 18)).toISOString())}, ${y}` }
}

/**
 * A live shipment whose scheduled delivery day (the last delivery stop's appointment, or the end of its
 * window) is before today in Chicago time and that is not delivered yet. Day-level on purpose: a load due
 * at 8:00 today is not flagged until tomorrow, and a date-only appointment (stored as Chicago midnight)
 * counts its whole day. Delivered, voided, canceled and draft shipments are never flagged.
 */
export function pastDeliveryOf(
  row: Pick<ShipmentRow, 'status' | 'voidedAt' | 'deletedAt' | 'deliveryAppt' | 'deliveryApptEnd'>,
  nowMs: number,
): PastDelivery | null {
  if (row.status === 'DRAFT') return null
  const board = boardStatusOf(row)
  if (board === 'DELIVERED' || board === 'VOIDED' || board === 'CANCELED') return null
  const late = scheduledDeliveryLateOf(row, nowMs)
  if (!late) return null
  const { day, daysLate, label } = late
  return { day, daysLate, tooltip: `Scheduled delivery ${label} — not marked delivered (${daysLate} ${daysLate === 1 ? 'day' : 'days'})` }
}
