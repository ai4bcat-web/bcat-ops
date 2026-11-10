// "Completed MyCarrierPackets packet" — the one predicate behind the rate-con gate,
// shared by the Lambda (refuses the send) and the UI (explains and disables).
// Completed = the carrier has finished the packet and MCP has received it (review
// pending or risk-assessed). Completion is not approval: UNACCEPTABLE* carriers pass
// this gate; carrierFlags/evaluateCarrierBooking still decide suitability.
// Any unrecognised free text is NOT evidence that a packet exists.
// No imports from '@/' — the Lambda bundles this file.

export const MCP_PACKET_COMPLETED_STATUSES = [
  'PENDING_REVIEW',
  'ACCEPTABLE',
  'MODERATE',
  'UNACCEPTABLE',
  'UNACCEPTABLE_REVIEW',
] as const

/** Stable prefix of the server's refusal message (UI may recognise it). */
export const RATE_CON_MCP_ERROR_PREFIX = 'Rate confirmation needs a completed MyCarrierPackets packet:'

export interface McpPacketStanding {
  completed: boolean
  /** Normalised status, or null when blank. */
  status: string | null
  /** Human sentence for a refusal; '' when completed. */
  reason: string
}

/** trim, upper-case, runs of space/hyphen -> '_'. Blank -> null. */
export function normalizeMcpStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return v === '' ? null : v
}

/**
 * Ryne 2026-11-10: a carrier counts as UNACCEPTABLE only when its MyCarrierPackets risk score is ABOVE 10,000 (MCP's own label is not
 * enough: Ivan Cartage reads "Unacceptable, under review" at 3,000). With no score on file the label stands.
 */
export const MCP_UNACCEPTABLE_ABOVE_POINTS = 10000

/** The packet status to decide on: UNACCEPTABLE* with a score at or under the limit is treated as ACCEPTABLE. */
export function effectiveMcpStatus(raw: unknown, points: number | null | undefined): string | null {
  const status = normalizeMcpStatus(raw)
  if ((status === 'UNACCEPTABLE' || status === 'UNACCEPTABLE_REVIEW') && typeof points === 'number' && points <= MCP_UNACCEPTABLE_ABOVE_POINTS) return 'ACCEPTABLE'
  return status
}

function reasonFor(status: string | null): string {
  switch (status) {
    case null:
      return 'has no MyCarrierPackets status on file, so no completed packet.'
    case 'NOT_INVITED':
      return 'has not been sent a MyCarrierPackets packet.'
    case 'INVITED':
      return 'was invited but has not started the MyCarrierPackets packet.'
    case 'IN_PROGRESS':
      return 'has not finished the MyCarrierPackets packet.'
    default:
      return `is at MyCarrierPackets status "${status}", which is not a completed packet.`
  }
}

export function mcpPacketStanding(carrier: { mcpStatus?: string | null } | null | undefined): McpPacketStanding {
  const status = normalizeMcpStatus(carrier?.mcpStatus)
  const completed = status !== null && (MCP_PACKET_COMPLETED_STATUSES as readonly string[]).includes(status)
  return { completed, status, reason: completed ? '' : reasonFor(status) }
}

export function rateConMcpRefusal(carrierName: string, standing: McpPacketStanding): string {
  return `${RATE_CON_MCP_ERROR_PREFIX} ${carrierName} ${standing.reason} Send a setup packet from the carrier profile and re-send once MyCarrierPackets reports it complete.`
}
