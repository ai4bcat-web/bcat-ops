/**
 * Step AM — the decisions behind the Cover dialog, pure so the dialog only renders them.
 *
 * A carrier can only be assigned through MyCarrierPackets: one that is already ACTIVE in our directory
 * (MCP finished its packet and is monitoring it) is assigned straight away; one that is not is assigned
 * only AFTER its setup packet invitation has gone out, and then waits on the ladder's first rung until
 * MCP says the packet is done. A packet MCP rates UNACCEPTABLE blocks assignment; MODERATE allows it
 * with an acknowledged warning.
 */
import { effectiveMcpStatus } from '@/lib/mcpPacket'
import { CARRIER_STATUS_LABELS, CARRIER_STATUS_REASON_LABELS } from '@/lib/carrierStatus'
import { matchDirectoryCarrier, type DirectoryCarrierLike, type ParsedSearch } from '@/lib/integrations/mcpReview'

/** The acknowledgement key COVER_CARRIER expects for a MODERATE packet. */
export const MODERATE_ACK_KEY = 'MCP_MODERATE'
export const UNACCEPTABLE_ACK_KEY = 'MCP_UNACCEPTABLE'

export interface CoverGate {
  /** Assignment is refused: the sentence to show. */
  blocked: string | null
  /** Assignment is allowed once acknowledged: the sentence to show beside the checkbox. */
  warning: string | null
  /** The acknowledgement key the server expects for this warning. */
  ackKey?: string
}

export function coverGate(mcpStatus: string | null | undefined, carrierStatus?: string | null, isAdmin = false, riskPoints?: number | null): CoverGate {
  // UNACCEPTABLE only counts above 10,000 risk points (Ryne 2026-11-10).
  const status = effectiveMcpStatus(mcpStatus, riskPoints)
  if (carrierStatus === 'DO_NOT_USE') {
    return { blocked: 'This carrier is marked Do not use in our directory and cannot be assigned.', warning: null }
  }
  if ((status === 'UNACCEPTABLE' || status === 'UNACCEPTABLE_REVIEW') && isAdmin) {
    return { blocked: null, warning: 'MyCarrierPackets rates this carrier’s packet unacceptable. As an admin you can assign it anyway; the override is recorded.', ackKey: UNACCEPTABLE_ACK_KEY }
  }
  if (status === 'UNACCEPTABLE' || status === 'UNACCEPTABLE_REVIEW') {
    return { blocked: 'MyCarrierPackets rates this carrier’s packet unacceptable. It cannot be assigned to a load.', warning: null }
  }
  if (status === 'MODERATE') {
    return { blocked: null, warning: 'MyCarrierPackets rates this carrier’s packet moderate risk. Assigning it needs your acknowledgement.', ackKey: MODERATE_ACK_KEY }
  }
  return { blocked: null, warning: null }
}

/** What clicking the main button does for a directory carrier (or for none). */
export type CoverRoute =
  /** ACTIVE: MCP finished the packet and monitors the carrier. Assign; the ladder starts at "setup complete". */
  | 'ASSIGN_NOW'
  /** Not ACTIVE but its packet invitation was already sent: assign and wait on setup. */
  | 'ASSIGN_WAITING'
  /** Not ACTIVE and never invited (or not in the directory): the setup packet goes out first. */
  | 'INVITE_FIRST'

export function coverRoute(carrier: { status?: string | null; mcpInvitedAt?: string | null } | null | undefined): CoverRoute {
  if (!carrier) return 'INVITE_FIRST'
  if (carrier.status === 'ACTIVE') return 'ASSIGN_NOW'
  return carrier.mcpInvitedAt ? 'ASSIGN_WAITING' : 'INVITE_FIRST'
}

/** The directory row for an MC / DOT the rep typed; null for a name (the dialog lists name matches) or no hit. */
export function findByNumber<T extends DirectoryCarrierLike>(carriers: readonly T[], parsed: ParsedSearch): T | null {
  if (parsed.kind !== 'MC' && parsed.kind !== 'DOT') return null
  const hit = matchDirectoryCarrier(carriers, { identity: { mcNumber: parsed.mcNumber, dotNumber: parsed.dotNumber } })
  return hit && hit.by !== 'NAME' ? hit.carrier : null
}

/** The directory standing of a carrier in one line, for a suggestion list: Active, or what it is instead and why. */
export function directoryStanding(c: { status: string; statusReason?: string | null; statusNote?: string | null; mcpStatus?: string | null; mcpInvitedAt?: string | null }): { active: boolean; label: string; why: string } {
  if (c.status === 'ACTIVE') return { active: true, label: 'Active', why: '' }
  const reason = c.statusReason ? (CARRIER_STATUS_REASON_LABELS as Record<string, string>)[c.statusReason] ?? c.statusReason : null
  const why = [reason, c.statusNote].filter(Boolean).join(': ') || (c.mcpInvitedAt ? 'waiting on setup packet' : c.status === 'DO_NOT_USE' ? 'marked Do not use' : 'setup packet not sent')
  const label = (CARRIER_STATUS_LABELS as Record<string, string>)[c.status] ?? c.status
  return { active: false, label, why }
}
