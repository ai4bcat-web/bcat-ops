/**
 * Step AM — what the carrier assignment ladder looks like on screen. The ladder itself (values, labels,
 * derivation) is `@/lib/carrierAssignment`, shared with the Lambda; this file is the UI's reading of it:
 * the chip a row shows, the next step a rep can take, and the gates the buttons honour.
 *
 * Pure: the chip, the grids' filter options and the Carrier tab all call the same functions, so a
 * board cell, a header and a button can never disagree about where a load is.
 */
import {
  CARRIER_ASSIGNMENT_LABELS, CARRIER_ASSIGNMENT_STATUSES, driverInfoGaps, isCarrierAssignmentStatus,
  type CarrierAssignmentStatus, type DriverInfoKey,
} from '@/lib/carrierAssignment'
import type { TmsTone } from '@/features/tms/kit/statusTone'
import { statusTone } from '@/features/tms/kit/statusTone'

export const LADDER_TONE: Record<CarrierAssignmentStatus, TmsTone> = {
  ASSIGNED_SETUP_PENDING: 'orange',
  ASSIGNED_SETUP_COMPLETE: 'blue',
  RATE_CON_SENT: 'blue',
  RATE_CON_SIGNED: 'turquoise',
  DRIVER_INFO_ENTERED: 'green',
}

/** Shipment statuses before a truck is moving: while the shipment is in one of these, the ladder owns the chip. */
const LADDER_OWNS: Record<string, true> = {
  DRAFT: true, TENDER_PENDING: true, TENDER_REJECTED: true, OPEN: true, ON_HOLD: true, BOOKED: true, PLANNED: true,
}

export interface AssignmentChip {
  /** The ladder rung the load is on; the chip may show the shipment's status instead of its label. */
  ladder: CarrierAssignmentStatus
  label: string
  tone: TmsTone
  /** True once the shipment's own status has taken over the display. */
  shipmentOwns: boolean
}

/**
 * The chip for one row. `null` when nobody is assigned (no ladder). Once driver info is in and the
 * shipment has moved past booking, the shipment status (`shipmentStatusText`) takes over.
 */
export function assignmentChip(
  ladder: string | null | undefined,
  shipmentStatus: string | null | undefined,
  shipmentStatusText?: string | null,
): AssignmentChip | null {
  if (!isCarrierAssignmentStatus(ladder)) return null
  const status = (shipmentStatus ?? '').toUpperCase()
  if (ladder === 'DRIVER_INFO_ENTERED' && status && !LADDER_OWNS[status]) {
    return { ladder, label: shipmentStatusText || status, tone: statusTone(status), shipmentOwns: true }
  }
  return { ladder, label: CARRIER_ASSIGNMENT_LABELS[ladder], tone: LADDER_TONE[ladder], shipmentOwns: false }
}

export interface LadderRow {
  carrierAssignmentStatus?: string | null
  status?: string | null
}

/** The chip's text for a grid cell, filter and CSV; '' when nobody is assigned. */
export function assignmentChipText(row: LadderRow, shipmentStatusText?: string | null): string {
  return assignmentChip(row.carrierAssignmentStatus, row.status, shipmentStatusText)?.label ?? ''
}

/** The five labels, in ladder order, as filter options (value = wire status). */
export const LADDER_FILTER_OPTIONS: Array<{ value: CarrierAssignmentStatus; label: string }> =
  CARRIER_ASSIGNMENT_STATUSES.map((s) => ({ value: s, label: CARRIER_ASSIGNMENT_LABELS[s] }))

// ── Carrier tab: which buttons the ladder offers ──────────────────────────────

export interface LadderAction {
  key: 'SEND_SETUP_PACKET' | 'SEND_RATE_CON' | 'MARK_SIGNED' | 'ENTER_DRIVER_INFO'
  label: string
  /** Disabled with this reason, or enabled when null. */
  blockedBy: string | null
}

export interface LadderInput {
  ladder: CarrierAssignmentStatus | null | undefined
  /** Carrier.status of the directory row; ACTIVE only when MyCarrierPackets says setup is done. */
  carrierActive: boolean
  rateConStatus?: string | null
  driver: Partial<Record<DriverInfoKey, unknown>> | null | undefined
}

/**
 * The buttons that move this assignment up a rung, in the order a rep reaches for them. Nothing here
 * "completes setup": setup only ever arrives from MyCarrierPackets, so that rung's button is the
 * packet (re)send and it never enables a later rung.
 */
export function ladderActions({ ladder, carrierActive, rateConStatus, driver }: LadderInput): LadderAction[] {
  if (!ladder) return []
  const out: LadderAction[] = []
  const setupBlock = carrierActive ? null : 'Waiting for the carrier to finish its MyCarrierPackets setup'
  if (!carrierActive) out.push({ key: 'SEND_SETUP_PACKET', label: 'Send setup packet', blockedBy: null })
  const sent = rateConStatus === 'SENT' || rateConStatus === 'OPENED'
  const signed = rateConStatus === 'SIGNED' || ladder === 'RATE_CON_SIGNED' || ladder === 'DRIVER_INFO_ENTERED'
  if (!signed) {
    out.push({ key: 'SEND_RATE_CON', label: sent ? 'Resend rate con' : 'Send rate con', blockedBy: setupBlock })
    out.push({ key: 'MARK_SIGNED', label: 'Mark signed', blockedBy: setupBlock ?? (sent ? null : 'Send the rate con first') })
  }
  if (driverInfoGaps(driver).length > 0 || ladder !== 'DRIVER_INFO_ENTERED') {
    out.push({ key: 'ENTER_DRIVER_INFO', label: 'Enter driver info', blockedBy: setupBlock })
  }
  return out
}

/** Why Dispatch is blocked, or null when the four driver fields are on the assignment. */
export function dispatchBlock(driver: Partial<Record<DriverInfoKey, unknown>> | null | undefined): string | null {
  const gaps = driverInfoGaps(driver)
  return gaps.length === 0 ? null : `Driver info is required before dispatch: ${gaps.join(', ')}`
}
