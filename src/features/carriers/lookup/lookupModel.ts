/**
 * Step AS — the decisions behind CarrierLookupCard, pure so the card only renders them.
 *
 * Three questions, always in this order: is the carrier in our directory (and what is its status), where
 * does its MyCarrierPackets packet stand, and what does MCP's vetting say. Then the actions every surface
 * offers: send the setup packet to the addresses MCP returns, cover with the carrier, open it or add it.
 */
import type { McpReviewCard, McpReviewEmail } from '@/lib/integrations/mcpReview'
import { mcpPacketStanding } from '@/lib/mcpPacket'
import { CARRIER_STATUS_LABELS } from '@/lib/carrierStatus'
import type { CarrierStatus } from '@/types/tms'

export interface LookupDirectoryRow {
  id: string
  name: string
  status: CarrierStatus
  mcpStatus?: string | null
  mcpInvitedAt?: string | null
  mcpInvitedTo?: string | null
  lastLoadAt?: string | null
  loadCount?: number | null
  email?: string | null
  dispatcherName?: string | null
  dispatcherEmail?: string | null
}

export type PacketKind = 'COMPLETE' | 'INVITED' | 'NONE' | 'STUB'

export interface LookupInput {
  card: McpReviewCard | null
  mode: 'LIVE' | 'STUB'
  carrier: LookupDirectoryRow | null
  /** ISO instant: "now" for the re-send rule. Passed in so callers and tests pin it. */
  nowIso: string
}

export interface ActionState {
  enabled: boolean
  /** Why it is disabled: the hover title. */
  reason?: string
}

export interface LookupState {
  directory: { inDirectory: boolean; statusLabel: string | null; status: CarrierStatus | null }
  packet: { kind: PacketKind; label: string; invitedAt: string | null }
  /** Carrier.status ACTIVE and packet complete: the one-line "Active with us". */
  activeReady: boolean
  emails: McpReviewEmail[]
  vetting: { failing: string[] }
  send: ActionState & { label: 'Send setup packet' | 'Re-send packet'; primary: boolean }
  cover: ActionState & { primary: boolean }
  /** `open` for a directory hit, `add` for none. */
  directoryAction: { kind: 'open' | 'add'; enabled: boolean; reason?: string }
}

export const RESEND_AFTER_DAYS = 3
const DAY_MS = 86_400_000

const dateOnly = (iso: string): string => iso.slice(0, 10)

/** The packet stage: the directory row wins when there is one (our record), else MCP's card. */
function packetOf({ card, mode, carrier }: LookupInput): LookupState['packet'] {
  // A stub made no MCP call, but a directory row's own packet status is our record, not MCP's: keep using it.
  if (mode === 'STUB' && !carrier?.mcpStatus) return { kind: 'STUB', label: 'Stub, no MCP call', invitedAt: null }
  const raw = carrier?.mcpStatus ?? card?.packet.status ?? null
  const standing = mcpPacketStanding({ mcpStatus: raw })
  const invitedAt = carrier?.mcpInvitedAt ?? card?.packet.invitedAt ?? null
  if (standing.completed) return { kind: 'COMPLETE', label: 'Packet complete', invitedAt }
  if (standing.status === 'INVITED' || standing.status === 'IN_PROGRESS') {
    return { kind: 'INVITED', label: invitedAt ? `Packet invited ${dateOnly(invitedAt)}` : 'Packet invited', invitedAt }
  }
  return { kind: 'NONE', label: 'No packet', invitedAt }
}

/** Things MCP's own data says are failing: expired / cancelled cover, inactive authority, unacceptable or high risk. */
function failing(card: McpReviewCard | null): string[] {
  if (!card) return []
  const out: string[] = []
  if (card.operating.authorityStatus === 'INACTIVE') out.push('Authority inactive')
  for (const r of card.insurance) if (r.state === 'EXPIRED' || r.state === 'CANCELLED') out.push(`${r.type} ${r.state === 'EXPIRED' ? 'expired' : 'cancelled'}`)
  if (card.risk.tone === 'red') out.push(`Risk ${card.risk.overallRating ?? 'high'}`)
  if (card.operating.nonCooperative === true) out.push('Insurance non-coop')
  if (card.operating.possibleFraud && /^y/i.test(card.operating.possibleFraud)) out.push('Possible fraud')
  return out
}

export function lookupState(input: LookupInput): LookupState {
  const { card, mode, carrier, nowIso } = input
  const packet = packetOf(input)
  const status = carrier?.status ?? null
  const activeReady = status === 'ACTIVE' && packet.kind === 'COMPLETE'
  const emails = mode === 'STUB' ? [] : card?.emails ?? []

  const stale = packet.kind === 'INVITED' && packet.invitedAt != null
    && Date.parse(nowIso) - Date.parse(packet.invitedAt) > RESEND_AFTER_DAYS * DAY_MS

  let sendReason: string | undefined
  if (mode === 'STUB') sendReason = 'Stub, no MCP call: MyCarrierPackets is not connected here, so a packet cannot be sent.'
  else if (!card) sendReason = 'MyCarrierPackets has no record of this carrier.'
  else if (status === 'DO_NOT_USE') sendReason = 'This carrier is marked Do not use.'
  else if (emails.length === 0) sendReason = 'MyCarrierPackets returned no e-mail address for this carrier.'

  let coverReason: string | undefined
  if (status === 'DO_NOT_USE') coverReason = 'This carrier is marked Do not use.'
  else if (!carrier) coverReason = 'Not in our directory: send the setup packet first.'
  else if (status !== 'ACTIVE') coverReason = `Directory status is ${CARRIER_STATUS_LABELS[status!]}: only an Active carrier can be covered directly.`
  else if (packet.kind !== 'COMPLETE') coverReason = 'The MyCarrierPackets packet is not complete yet.'

  const sendPrimary = !activeReady && (packet.kind === 'NONE' || stale)
  const directoryAction: LookupState['directoryAction'] = carrier
    ? { kind: 'open', enabled: true }
    : mode === 'STUB'
      ? { kind: 'add', enabled: false, reason: 'Stub, no MCP call: nothing can be added from fixture data.' }
      : !card
        ? { kind: 'add', enabled: false, reason: 'MyCarrierPackets has no record of this carrier.' }
        : { kind: 'add', enabled: true }

  return {
    directory: { inDirectory: carrier != null, status, statusLabel: status ? CARRIER_STATUS_LABELS[status] : null },
    packet,
    activeReady,
    emails,
    vetting: { failing: failing(card) },
    send: { enabled: sendReason === undefined, ...(sendReason ? { reason: sendReason } : {}), label: stale ? 'Re-send packet' : 'Send setup packet', primary: sendPrimary },
    cover: { enabled: coverReason === undefined, ...(coverReason ? { reason: coverReason } : {}), primary: activeReady },
    directoryAction,
  }
}

/** The recipients the popover starts with: every MCP address ticked. */
export const defaultRecipients = (emails: ReadonlyArray<{ address: string }>): string[] => emails.map((e) => e.address)

/**
 * What goes to `mcpSendInvite`: the ticked MCP addresses plus any hand-typed ones (additive, never the
 * only path), lower-cased and deduped. An empty result means no invitation is sent.
 */
export function chosenRecipients(ticked: ReadonlyArray<string>, typed: ReadonlyArray<string>): string[] {
  return [...new Set([...ticked, ...typed].map((e) => e.trim().toLowerCase()).filter(Boolean))]
}
