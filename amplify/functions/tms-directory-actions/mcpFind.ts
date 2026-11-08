/**
 * Step AD — Carriers › Find & Invite. The MyCarrierPackets calls the page needs, run here so the
 * integration credentials never reach the browser:
 *
 *   MCP_PREVIEW_CARRIER  PreviewCarrier  -> the review card (profile, FMCSA status, risk, insurance, approved e-mails)
 *   MCP_GET_CARRIER      GetCarrierData  -> the full record (packet, contacts, equipment, lanes, monitoring)
 *   MCP_SEND_INVITE      EmailPacketInvitation, then the log on the Carrier row, the audit and the shipment thread
 *   MCP_ADD_CARRIER      creates the Carrier row from MCP (the mcp-sync engine: MCP values win, MCP_CREATE audit)
 *
 * Not LIVE (no credentials, neutered, or Validate not green) => STUB: a labelled fixture comes back,
 * nothing is called, nothing is invited, nothing is created. Authz is the carrier-page rule
 * (owner / ADMIN / page-carriers / page-loads / page-tms), applied by the handler.
 *
 * No credential, token or request URL reaches a log, an audit row or a reply: the adapter's own
 * errors are already redacted, and audits carry identifiers and response key names only.
 */
import { PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { randomUUID } from 'crypto'
import { docketOf, dotOf, fetchMcpDataRaw, fetchMcpPreviewRaw, inviteMcpCarrier } from '../../../src/lib/integrations/mcpAdapter'
import { buildReviewCard, stubReviewCard, validateInviteEmail } from '../../../src/lib/integrations/mcpReview'
import type { McpReviewCard } from '../../../src/lib/integrations/mcpReview'
import { threadKeyFor } from '../../../src/lib/shipmentThread'
import { invokeMcpSync, mcpFindGate } from './integrations'
import type { IntegrationCaller, IntegrationDeps } from './integrations'

export const MCP_FIND_ACTIONS = {
  MCP_PREVIEW_CARRIER: true,
  MCP_GET_CARRIER: true,
  MCP_SEND_INVITE: true,
  MCP_ADD_CARRIER: true,
} as const

export type McpFindActionName = keyof typeof MCP_FIND_ACTIONS

export interface McpFindDeps extends IntegrationDeps {
  /** ShipmentMessage table: the invitation is noted on the load's thread when launched from a load. */
  shipmentMessageTableName: string
  now?: () => string
}

const PROVIDER = 'MYCARRIERPACKETS'
const NOT_FOUND = 'MyCarrierPackets has no record of that carrier.'

interface Ref {
  mcNumber?: string
  dotNumber?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function refOf(input: Record<string, unknown>): Ref {
  const mcNumber = docketOf(str(input.mcNumber))
  const dotNumber = dotOf(str(input.dotNumber))
  if (!mcNumber && !dotNumber) throw new Error('Enter an MC or DOT number: MyCarrierPackets looks carriers up by number.')
  return { ...(mcNumber ? { mcNumber } : {}), ...(dotNumber ? { dotNumber } : {}) }
}

const labelOf = (ref: Ref): Record<string, string | null> => ({ mcNumber: ref.mcNumber ?? null, dotNumber: ref.dotNumber ?? null })

type Lookup = { mode: 'LIVE' | 'STUB'; reason: string | null; card: McpReviewCard | null; notFound: boolean }

async function lookup(
  deps: McpFindDeps,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
  action: 'MCP_PREVIEW_CARRIER' | 'MCP_GET_CARRIER',
): Promise<Lookup> {
  const ref = refOf(input)
  const gate = await mcpFindGate(deps)
  let out: Lookup
  if (!gate.live) {
    out = { mode: 'STUB', reason: gate.reason, card: stubReviewCard(ref), notFound: false }
  } else {
    const raw = action === 'MCP_PREVIEW_CARRIER'
      ? await fetchMcpPreviewRaw(ref, gate.credentials, deps.fetchImpl)
      : await fetchMcpDataRaw(ref, gate.credentials, deps.fetchImpl)
    const card = raw ? buildReviewCard(raw, ref, action === 'MCP_PREVIEW_CARRIER' ? 'preview' : 'data') : null
    out = { mode: 'LIVE', reason: null, card, notFound: card === null }
  }
  await deps.writeAudit('INTEGRATION', PROVIDER, action, caller, { ...labelOf(ref), mode: out.mode, found: out.card !== null })
  return out
}

export const mcpPreviewCarrier = (deps: McpFindDeps, input: Record<string, unknown>, caller: IntegrationCaller) =>
  lookup(deps, input, caller, 'MCP_PREVIEW_CARRIER')

export const mcpGetCarrier = (deps: McpFindDeps, input: Record<string, unknown>, caller: IntegrationCaller) =>
  lookup(deps, input, caller, 'MCP_GET_CARRIER')

// ── Invite ───────────────────────────────────────────────────────────────────

/**
 * Stamp the invitation on the Carrier row: when, to whom, by whom. `mcpStatus` becomes INVITED only
 * while the packet has not started; a stage already further along is left alone.
 */
async function logOnCarrier(deps: McpFindDeps, carrierId: string, emails: readonly string[], caller: IntegrationCaller, now: string): Promise<boolean> {
  const stamp = 'SET mcpInvitedAt = :at, mcpInvitedTo = :to, mcpInvitedBy = :by, updatedAt = :at'
  const values = { ':at': now, ':to': emails.join(', '), ':by': caller.email }
  const send = (expression: string, condition: string, extra: Record<string, unknown> = {}) => deps.dynamo.send(new UpdateItemCommand({
    TableName: deps.carrierTableName,
    Key: marshall({ id: carrierId }),
    UpdateExpression: expression,
    ConditionExpression: condition,
    ExpressionAttributeValues: marshall({ ...values, ...extra }),
  }))
  try {
    try {
      await send(`${stamp}, mcpStatus = :invited`, 'attribute_exists(id) AND (attribute_not_exists(mcpStatus) OR mcpStatus = :none OR mcpStatus = :ni)', { ':invited': 'INVITED', ':none': '', ':ni': 'NOT_INVITED' })
    } catch (err) {
      if (!(err instanceof Error && err.name === 'ConditionalCheckFailedException')) throw err
      await send(stamp, 'attribute_exists(id)')
    }
    return true
  } catch (err) {
    console.warn('[mcp-find] carrier invite log failed:', err instanceof Error ? err.name : 'error')
    return false
  }
}

async function logOnThread(
  deps: McpFindDeps,
  input: { shipmentId: string; loadId?: string; carrierName: string; emails: readonly string[]; ref: Ref },
  caller: IntegrationCaller,
  now: string,
): Promise<boolean> {
  if (!deps.shipmentMessageTableName) return false
  const carrier = input.carrierName || 'the carrier'
  try {
    await deps.dynamo.send(new PutItemCommand({
      TableName: deps.shipmentMessageTableName,
      Item: marshall({
        id: `msg:${input.shipmentId}:${randomUUID()}`,
        __typename: 'ShipmentMessage',
        shipmentId: input.shipmentId,
        threadKey: threadKeyFor(input.shipmentId),
        ...(input.loadId ? { loadId: input.loadId } : {}),
        direction: 'OUT',
        channel: 'EMAIL',
        kind: 'NOTE',
        party: 'CARRIER',
        to: input.emails.join(', '),
        subject: `MyCarrierPackets packet invitation: ${carrier}`,
        body: `${caller.email} sent ${carrier} (${[input.ref.mcNumber, input.ref.dotNumber && `DOT ${input.ref.dotNumber}`].filter(Boolean).join(', ')}) a MyCarrierPackets setup packet invitation at ${input.emails.join(', ')}.`,
        status: 'SENT',
        authorKind: 'PERSON',
        authorName: caller.email,
        at: now,
        createdBy: caller.email,
        createdAt: now,
        updatedAt: now,
      }, { removeUndefinedValues: true }),
    }))
    return true
  } catch (err) {
    console.warn('[mcp-find] thread log failed:', err instanceof Error ? err.name : 'error')
    return false
  }
}

/**
 * The recipients the caller named. `emails` (an array, possibly empty: the user unticked everything)
 * and `email` (kept for compatibility) are additive. Null = the caller named nobody, so the default
 * applies: every address MyCarrierPackets returns for the carrier.
 */
function explicitRecipients(input: Record<string, unknown>): string[] | null {
  const listed = Array.isArray(input.emails) ? input.emails : null
  const single = str(input.email)
  if (!listed && !single) return null
  const raw = [...(listed ?? []), ...(single ? [single] : [])]
  const seen = new Set<string>()
  for (const r of raw) {
    const check = validateInviteEmail(typeof r === 'string' ? r : '', [])
    if (!check.ok) throw new Error(check.error ?? 'That is not a valid e-mail address.')
    seen.add(check.email)
  }
  return [...seen]
}

export async function mcpSendInvite(deps: McpFindDeps, input: Record<string, unknown>, caller: IntegrationCaller): Promise<Record<string, unknown>> {
  const ref = refOf(input)
  const explicit = explicitRecipients(input)
  if (explicit && explicit.length === 0) throw new Error('Pick at least one recipient: no invitation was sent.')
  let carrierId = str(input.carrierId)
  const shipmentId = str(input.shipmentId)
  const carrierName = str(input.carrierName) ?? ''
  const now = (deps.now ?? (() => new Date().toISOString()))()

  const gate = await mcpFindGate(deps)
  if (!gate.live) {
    await deps.writeAudit(carrierId ? 'CARRIER' : 'INTEGRATION', carrierId ?? PROVIDER, 'MCP_SEND_INVITE', caller, { ...labelOf(ref), emails: explicit ?? [], mode: 'STUB', sent: false })
    return { mode: 'STUB', sent: false, message: `STUB: nothing was sent. ${gate.reason}`, emails: [], carrierLogged: false, threadLogged: false }
  }

  // Default: the addresses MyCarrierPackets populates for this carrier.
  let recipients = explicit
  if (!recipients) {
    const raw = await fetchMcpPreviewRaw(ref, gate.credentials, deps.fetchImpl)
    const card = raw ? buildReviewCard(raw, ref, 'preview') : null
    recipients = (card?.emails ?? []).map((e) => e.address)
    if (recipients.length === 0) throw new Error('MyCarrierPackets returned no e-mail address for that carrier: type one to invite.')
  }

  // EmailPacketInvitation takes one carrierEmail per call (Integration Guide 1.1.1): one call per address.
  const sent: string[] = []
  const failed: Array<{ email: string; error: string }> = []
  let result: Awaited<ReturnType<typeof inviteMcpCarrier>> | null = null
  for (const email of recipients) {
    try {
      result = await inviteMcpCarrier({ email, ...ref }, gate.credentials, deps.fetchImpl)
      sent.push(email)
    } catch (err) {
      if (sent.length === 0 && recipients.length === 1) throw err
      failed.push({ email, error: err instanceof Error ? err.message : 'invitation failed' })
    }
  }
  if (sent.length === 0 || !result) throw new Error(failed[0]?.error ?? 'No invitation was sent.')
  // Step AM. A carrier that is not in our directory can only enter it through MyCarrierPackets: the
  // invitation went first, and only then does mcp-sync make the PENDING row from MCP's own record.
  let created = false
  let carrierError: string | null = null
  if (!carrierId && input.ensureCarrier === true) {
    // The invitation is already out: a failure here is reported, never thrown, so a retry cannot invite twice.
    const reply = await invokeMcpSync({ kind: 'ADD_CARRIER', ...ref }, 'sync').catch((err: unknown) => ({ ready: false, reason: err instanceof Error ? err.message : 'mcp-sync failed' }) as Record<string, unknown>)
    if (reply.ready === false) carrierError = String(reply.reason ?? 'MyCarrierPackets is not LIVE.')
    else if (typeof reply.carrierId !== 'string') carrierError = 'No carrier row could be made from MyCarrierPackets yet. Try again in a minute.'
    else {
      carrierId = reply.carrierId
      created = reply.result === 'CREATED'
      await deps.writeAudit('CARRIER', carrierId, 'MCP_ADD_CARRIER', caller, {
        ...labelOf(ref), source: 'MYCARRIERPACKETS', result: String(reply.result ?? ''), matchedBy: reply.matchedBy ?? null, via: 'INVITE',
      })
    }
  }
  const carrierLogged = carrierId ? await logOnCarrier(deps, carrierId, sent, caller, now) : false
  const threadLogged = shipmentId
    ? await logOnThread(deps, { shipmentId, loadId: str(input.loadId), carrierName, emails: sent, ref }, caller, now)
    : false
  await deps.writeAudit(carrierId ? 'CARRIER' : 'INTEGRATION', carrierId ?? PROVIDER, 'MCP_SEND_INVITE', caller, {
    ...labelOf(ref), emails: sent, failed: failed.map((f) => f.email), mode: 'LIVE', sent: true, shipmentId: shipmentId ?? null,
    mcpStatus: result.status, mcpBodyKeys: result.bodyKeys, carrierLogged, threadLogged,
  })
  return {
    mode: 'LIVE',
    sent: true,
    message: `Packet invitation sent to ${sent.join(', ')}.${failed.length ? ` Not sent: ${failed.map((f) => f.email).join(', ')}.` : ''}`,
    emails: sent,
    failed,
    mcpResponse: { status: result.status, bodyKeys: result.bodyKeys, message: result.message },
    invitedAt: now,
    carrierId: carrierId ?? null,
    carrierCreated: created,
    carrierError,
    carrierLogged,
    threadLogged,
  }
}

// ── Add to carriers ──────────────────────────────────────────────────────────

export async function mcpAddCarrier(deps: McpFindDeps, input: Record<string, unknown>, caller: IntegrationCaller): Promise<Record<string, unknown>> {
  const ref = refOf(input)
  const gate = await mcpFindGate(deps)
  if (!gate.live) {
    throw new Error(`STUB data is never added to the directory. ${gate.reason}`)
  }
  const reply = await invokeMcpSync({ kind: 'ADD_CARRIER', ...ref }, 'sync')
  if (reply.ready === false) throw new Error(String(reply.reason ?? 'MyCarrierPackets is not LIVE.'))
  const result = String(reply.result ?? '')
  if (result === 'NO_MCP_RECORD') throw new Error(NOT_FOUND)
  if (result === 'NO_NAME') throw new Error('MyCarrierPackets returned no legal name for that carrier, so no carrier row was made.')
  const carrierId = typeof reply.carrierId === 'string' ? reply.carrierId : null
  if (!carrierId) throw new Error('The carrier could not be added; see the mcp-sync logs.')
  await deps.writeAudit('CARRIER', carrierId, 'MCP_ADD_CARRIER', caller, {
    ...labelOf(ref), source: 'MYCARRIERPACKETS', result, matchedBy: reply.matchedBy ?? null,
  })
  return { carrierId, created: result === 'CREATED', matchedBy: reply.matchedBy ?? null }
}

export async function runMcpFindAction(
  action: McpFindActionName,
  input: Record<string, unknown>,
  caller: IntegrationCaller,
  deps: McpFindDeps,
): Promise<unknown> {
  switch (action) {
    case 'MCP_PREVIEW_CARRIER': return mcpPreviewCarrier(deps, input, caller)
    case 'MCP_GET_CARRIER': return mcpGetCarrier(deps, input, caller)
    case 'MCP_SEND_INVITE': return mcpSendInvite(deps, input, caller)
    case 'MCP_ADD_CARRIER': return mcpAddCarrier(deps, input, caller)
  }
}
