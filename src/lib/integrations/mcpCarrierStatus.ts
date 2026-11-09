// Step AM — Carrier.status is MyCarrierPackets' to drive. A carrier is ACTIVE in our directory
// because MCP says its packet is complete and it is monitored with its requirements met —
// never because a person pressed "setup complete". When MCP moves it out of compliance
// (insurance lapse, authority, risk) the same rule flips it to INACTIVE on the next sync.
//
// Monitoring: MyCarrierPackets only shows a carrier to us in its monitored list / changes feed /
// completed-packet feed after the packet is completed with BCAT, so a completed packet read from
// MCP is the monitoring signal this module acts on. [INFERENCE: the guide has no per-carrier
// "is monitored" flag on GetCarrierData.]
//
// DO_NOT_USE is a human judgement about the company and is never touched here. An INACTIVE row a
// person wrote (any other statusChangedBy) is not reactivated by MCP; only one MCP itself turned off.
import { mcpPacketStanding } from '../mcpPacket'
import { effectiveCarrierStatus } from '../carrierStatus'
import type { CarrierRecord } from '../../types/tms'

type Row = Record<string, unknown>

export const MCP_STATUS_ACTOR = 'mcp-sync'

export type McpLapseReason = 'EXPIRED_INSURANCE' | 'INACTIVE_AUTHORITY' | 'SAFETY_ISSUES'

/** Why MCP's data says this carrier may not haul for us right now, or null when nothing does. */
export function mcpLapseOf(carrier: Row, now: string): McpLapseReason | null {
  // MyCarrierPackets' UNACCEPTABLE rating is NOT a lapse any more (Ryne 2026-11-09): a carrier that finished its packet is Active
  // (setup is complete); the rating is enforced when it is assigned to a load (admin override with acknowledgement, everyone else
  // blocked). Insurance and authority lapses still deactivate.
  if (carrier.authorityStatus === 'INACTIVE') return 'INACTIVE_AUTHORITY'
  const effective = effectiveCarrierStatus(
    { status: 'ACTIVE', statusReason: null, insurancePolicies: carrier.insurancePolicies as CarrierRecord['insurancePolicies'] },
    now,
  )
  return effective.derived ? 'EXPIRED_INSURANCE' : null
}

const LAPSE_NOTE: Record<McpLapseReason, string> = {
  EXPIRED_INSURANCE: 'MyCarrierPackets: cargo insurance expired.',
  INACTIVE_AUTHORITY: 'MyCarrierPackets: operating authority is inactive.',
  SAFETY_ISSUES: 'MyCarrierPackets: packet review is UNACCEPTABLE.',
}

/**
 * The status fields MCP writes for `carrier` (the row with this sync's patch already applied), or
 * `{}` when nothing changes. Pure: the caller stamps and writes.
 */
export function mcpCarrierStatusPatch(carrier: Row, now: string): Row {
  const current = typeof carrier.status === 'string' && carrier.status ? carrier.status : 'PENDING'
  if (current === 'DO_NOT_USE') return {}
  const lapse = mcpLapseOf(carrier, now)
  const complete = mcpPacketStanding(carrier as { mcpStatus?: string | null }).completed

  if (complete && !lapse) {
    const mayActivate = current === 'PENDING' || current === 'REVIEW' || (current === 'INACTIVE' && carrier.statusChangedBy === MCP_STATUS_ACTOR)
    if (!mayActivate) return {}
    return { status: 'ACTIVE', statusReason: null, statusNote: 'MyCarrierPackets: packet complete and monitored.', statusChangedAt: now, statusChangedBy: MCP_STATUS_ACTOR }
  }
  if (lapse && current === 'ACTIVE') {
    return { status: 'INACTIVE', statusReason: lapse, statusNote: LAPSE_NOTE[lapse], statusChangedAt: now, statusChangedBy: MCP_STATUS_ACTOR }
  }
  return {}
}
