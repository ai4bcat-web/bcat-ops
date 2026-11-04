/**
 * Step AL — Carrier Sales inbound offers: the router half.
 *
 * The listener (`tms-spot-quoter/carrierInbox`) reads mail and call summaries, classifies them
 * with the model and hands the result here. This module owns every write: the listener holds no
 * IAM on Quote, Shipment, Load or ShipmentMessage.
 *
 *  - FILE_INBOUND_OFFER   system caller 'carrier-inbox' only. Resolves the load from the data
 *                         (ProClaim, reply thread, postings), never from the model's word, then
 *                         writes the ShipmentMessage and, for an auto-matched OFFER, a BUY Quote
 *                         through `recordCarrierOffer`.
 *  - ASSIGN_INBOUND_OFFER a rep moves an Unmatched row onto a load (and files the offer under
 *                         their own identity).
 *  - DISMISS_INBOUND_OFFER a rep deletes an Unmatched row.
 *
 * Idempotency: the message id is `msg:cs:<sourceKey>` and the put is conditional, so a replayed
 * hand-over is a no-op. A crash between the put and the Quote is repaired by the next replay,
 * which resumes the filing step; `recordCarrierOffer` collapses on `offerMessageRef`.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'

import { normalizeName } from '../../../src/lib/tmsDirectory'
import { threadKeyFor } from '../../../src/lib/shipmentThread'
import { allRefsToResolve, candidateRefs } from '../../../src/lib/carrierInbox/refs'
import { scoreMatches, type MatchContext, type MatchLedger } from '../../../src/lib/carrierInbox/match'
import {
  UNMATCHED_SHIPMENT_ID,
  UNMATCHED_THREAD_KEY,
  type FileInboundOfferInput,
  type FileInboundOfferResult,
  type FileOutcome,
  type InboundExtraction,
  type InboundFlag,
  type InboundMatchState,
  type InboundOfferRecord,
  type MatchCandidate,
  type MatchHow,
} from '../../../src/lib/carrierInbox/types'
import {
  type Row,
  putItem,
  numberOrNull,
  readStops,
  marshallRow,
  IDX_LOADS_BY_SHIPMENT,
} from '../_shared/shipmentStore'
import { assertString, assertEnum, optionalString, type Caller } from '../_shared/actionInputs'
import { findCarrier, recordCarrierOffer, type CarrierOfferDeps } from './carrierOffers'

export interface CarrierInboundDeps extends CarrierOfferDeps {
  tables: CarrierOfferDeps['tables'] & { message: string; proClaim: string }
}

export const IDX_MESSAGES_BY_MESSAGE_ID = 'shipmentMessagesByMessageId'
const IDX_POSTINGS_BY_STATUS = 'shipmentPostingsByStatusAndPostedAt'
export const SYSTEM_CALLER_EMAIL = 'system@bcatcorp.com'

const DEFAULT_AUTO_MIN = 0.85
const DEFAULT_SUGGEST_MIN = 0.5
const DEFAULT_RETENTION_DAYS = 30
const MAX_POSTINGS_CONSIDERED = 200
const MAX_RECORD_ATTEMPTS = 3
const KINDS = ['OFFER', 'INTEREST', 'WITHDRAW'] as const
const SOURCES = ['EMAIL', 'CALL'] as const

// ── Small helpers ────────────────────────────────────────────────────────────

const isCasConflict = (err: unknown): boolean =>
  /changed by someone else|ConditionalCheckFailed|TransactionCanceled/.test(err instanceof Error ? err.message : String(err))

const isCoveredRefusal = (err: unknown): boolean => /already covered/i.test(err instanceof Error ? err.message : String(err))

function clampNumber(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

function stringList(value: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, max)
}

function placeText(city: unknown, state: unknown): string {
  const c = typeof city === 'string' ? city.trim() : ''
  const s = typeof state === 'string' ? state.trim() : ''
  return [c, s].filter(Boolean).join(', ')
}

function stopPlace(stop: Row | undefined): string {
  if (!stop) return ''
  const addr = (stop.address ?? null) as { city?: unknown; state?: unknown } | null
  return placeText(stop.city ?? addr?.city, stop.state ?? addr?.state)
}

/** `origin → destination` from the first pickup and last delivery stops. */
function laneTextOf(loads: Row[]): string {
  const stops = loads.flatMap((l) => readStops(l) as unknown as Row[])
  const pickup = stops.find((s) => s.type === 'pickup')
  const delivery = [...stops].reverse().find((s) => s.type === 'delivery')
  const o = stopPlace(pickup)
  const d = stopPlace(delivery)
  return o || d ? `${o || '?'} → ${d || '?'}` : ''
}

function firstPickupAppt(loads: Row[]): string | null {
  for (const load of loads) if (load.pickupAppt) return String(load.pickupAppt)
  const stops = loads.flatMap((l) => readStops(l) as unknown as Row[])
  const pickup = stops.find((s) => s.type === 'pickup' && s.appt)
  return pickup ? String(pickup.appt) : null
}

/**
 * Stops and posting snapshots store `city` as "Joliet, IL" as often as plain "Joliet" with a
 * separate state; the matcher compares city to city, so split a trailing ", ST" off.
 */
function splitPlace(city: string | null, state: string | null): { city: string | null; state: string | null } {
  const m = city ? /^(.*?),\s*([A-Za-z]{2})$/.exec(city.trim()) : null
  return m ? { city: m[1]!.trim(), state: state || m[2]!.toUpperCase() } : { city, state }
}

// ── Match context (all verified against the data) ────────────────────────────

interface ShipmentFacts {
  shipment: Row
  loads: Row[]
}

async function loadShipmentFacts(deps: CarrierInboundDeps, shipmentId: string): Promise<ShipmentFacts | null> {
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) return null
  const loads = await deps.queryIndex(deps.tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  loads.sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0))
  return { shipment, loads }
}

/** Covered, delivered or voided loads take no new offer. */
function isCovered(facts: ShipmentFacts): boolean {
  return facts.loads.some((l) => l.activeLoadCarrierId != null)
}

interface BuiltMatch {
  ctx: MatchContext
  ledger: MatchLedger
  facts: Map<string, ShipmentFacts>
}

async function buildMatch(deps: CarrierInboundDeps, input: FileInboundOfferInput): Promise<BuiltMatch> {
  const refs = candidateRefs(input.subject, input.body, input.to, input.cc)
  const refToShipment: Record<string, string> = {}
  for (const ref of allRefsToResolve(input.extraction, refs)) {
    const claim = await deps.getById(deps.tables.proClaim, ref)
    const loadId = claim?.loadId ? String(claim.loadId) : ''
    if (!loadId) continue
    const load = await deps.getById(deps.tables.load, loadId)
    if (load?.shipmentId) refToShipment[ref] = String(load.shipmentId)
  }

  const replyShipmentIds: string[] = []
  if (input.inReplyTo) {
    const rows = await deps.queryIndex(deps.tables.message, IDX_MESSAGES_BY_MESSAGE_ID, 'messageId', input.inReplyTo)
    for (const row of rows) {
      const sid = row.shipmentId ? String(row.shipmentId) : ''
      if (sid && sid !== UNMATCHED_SHIPMENT_ID && !replyShipmentIds.includes(sid)) replyShipmentIds.push(sid)
    }
  }

  const postingRows = (await deps.queryIndex(deps.tables.posting, IDX_POSTINGS_BY_STATUS, 'status', 'POSTED')).slice(
    0,
    MAX_POSTINGS_CONSIDERED,
  )

  const wanted = new Set<string>([
    ...Object.values(refToShipment),
    ...replyShipmentIds,
    ...postingRows.map((p) => String(p.shipmentId ?? '')).filter(Boolean),
  ])
  const facts = new Map<string, ShipmentFacts>()
  const shipments: MatchLedger['shipments'] = {}
  for (const sid of wanted) {
    const f = await loadShipmentFacts(deps, sid)
    if (!f || f.loads.length === 0) continue
    facts.set(sid, f)
    shipments[sid] = {
      shipmentId: sid,
      shipmentNumber: optionalString(f.shipment.proNumber, 60) ?? optionalString(f.shipment.number, 60) ?? optionalString(f.loads[0]?.loadNumber, 60),
      loadId: String(f.loads[0]!.id),
      laneText: laneTextOf(f.loads),
      pickupAppt: firstPickupAppt(f.loads),
      covered: isCovered(f),
      voided: Boolean(f.shipment.voidedAt),
    }
  }

  const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
  const postings: MatchLedger['postings'] = postingRows
    .filter((p) => shipments[String(p.shipmentId ?? '')])
    .map((p) => ({
      postingId: String(p.id),
      boardPostingId: str(p.boardPostingId),
      shipmentId: String(p.shipmentId),
      loadId: str(p.loadId) ?? shipments[String(p.shipmentId)]!.loadId,
      shipmentNumber: shipments[String(p.shipmentId)]!.shipmentNumber,
      ...(() => {
        const o = splitPlace(str(p.originCity), str(p.originState))
        const d = splitPlace(str(p.destinationCity), str(p.destinationState))
        return { originCity: o.city, originState: o.state, destinationCity: d.city, destinationState: d.state }
      })(),
      pickupAppt: str(p.pickupAppt),
      equipmentType: str(p.equipmentType),
      rateCents: numberOrNull(p.rateCents),
    }))

  return { ctx: { refs, refToShipment, replyShipmentIds }, ledger: { shipments, postings }, facts }
}

// ── Row construction ─────────────────────────────────────────────────────────

function carrierNameFor(x: InboundExtraction, fromName: string | null, fromEmail: string | null): string {
  const domain = fromEmail && fromEmail.includes('@') ? fromEmail.split('@')[1]! : ''
  return (x.carrier.name || fromName || (x.carrier.mc ? `MC ${x.carrier.mc}` : '') || domain || 'Unknown carrier').slice(0, 200)
}

function fieldMetaFor(x: InboundExtraction, carrierFound: boolean, source: 'EMAIL' | 'CALL'): InboundOfferRecord['fieldMeta'] {
  const meta: InboundOfferRecord['fieldMeta'] = {}
  const low = new Set(x.lowConfidence)
  const put = (key: string, present: boolean, src: InboundOfferRecord['fieldMeta'][string]['source'], lowKeys: string[]) => {
    if (!present) return
    meta[key] = { source: src, confidence: x.confidence === 'low' || lowKeys.some((k) => low.has(k)) ? 'low' : 'high' }
  }
  put('rateCents', x.rateCents != null, 'MODEL', ['rateCents', 'rateDollars', 'rate'])
  put('carrierName', Boolean(x.carrier.name), carrierFound ? 'DIRECTORY' : 'MODEL', ['carrierName', 'name'])
  put('carrierMc', Boolean(x.carrier.mc), 'MODEL', ['mcNumber', 'mc', 'carrierMc'])
  put('contactEmail', Boolean(x.carrier.email), source === 'EMAIL' ? 'HEADER' : 'MODEL', ['contactEmail', 'email'])
  put('contactPhone', Boolean(x.carrier.phone), 'MODEL', ['contactPhone', 'phone'])
  put('equipment', Boolean(x.equipment), 'MODEL', ['equipment'])
  put('loadRefs', x.loadRefs.length > 0, 'MODEL', ['loadRefs'])
  return meta
}

function trimCandidates(cands: MatchCandidate[]): MatchCandidate[] {
  return cands.slice(0, 3)
}

function ttlFor(receivedAt: string, retentionDays: number, now: string): number {
  const t = Date.parse(receivedAt)
  const base = Number.isNaN(t) ? Date.parse(now) : t
  return Math.floor(base / 1000) + retentionDays * 86_400
}

/** What `recordCarrierOffer` is given for a message: shared by FILE, resume and ASSIGN. */
function offerInputFor(msg: Row, shipmentId: string, overrides: Row = {}): Row {
  const rec = msg.offer as InboundOfferRecord
  const x = rec.extraction
  const out: Row = {
    shipmentId,
    carrierName: carrierNameFor(x, null, typeof msg.from === 'string' ? msg.from : null),
    carrierMc: x.carrier.mc,
    carrierEmail: x.carrier.email,
    contactName: x.carrier.contactName,
    contactPhone: x.carrier.phone,
    amountCents: x.rateCents,
    source: rec.source === 'CALL' ? 'PHONE' : rec.boardProvider ? 'BOARD' : /^\s*\[CALL\]/i.test(String(msg.subject ?? '')) ? 'PHONE' : 'EMAIL',
    postingId: rec.match.top?.shipmentId === shipmentId ? rec.match.top.postingId : null,
    messageRef: String(msg.id),
    notes: [x.notes, x.availableAt ? `Available: ${x.availableAt}` : null].filter(Boolean).join('\n').slice(0, 4000) || null,
  }
  for (const [k, v] of Object.entries(overrides)) if (v != null && v !== '') out[k] = v
  if (typeof out.carrierName === 'string' && out.carrierName.length > 200) out.carrierName = out.carrierName.slice(0, 200)
  return out
}

/** Files the offer, retrying a Shipment CAS collision; a covered load is an outcome, not an error. */
async function fileOffer(
  deps: CarrierInboundDeps,
  input: Row,
  caller: Caller,
): Promise<{ quote: Row } | { covered: true }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await recordCarrierOffer(deps, input, caller)
      return { quote: res.quote as Row }
    } catch (err) {
      if (isCoveredRefusal(err)) return { covered: true }
      if (isCasConflict(err) && attempt < MAX_RECORD_ATTEMPTS) continue
      throw err
    }
  }
}

/** UPDATE one message row, optionally guarded on still being in the Unmatched bucket. */
function messageUpdate(
  deps: CarrierInboundDeps,
  id: string,
  patch: Row,
  opts: { remove?: string[]; requireUnmatched?: boolean } = {},
): TransactWriteItem {
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const sets: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    names[`#${k}`] = k
    values[`:${k}`] = v
    sets.push(`#${k} = :${k}`)
  }
  const removes = (opts.remove ?? []).map((k) => {
    names[`#${k}`] = k
    return `#${k}`
  })
  const expr = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : '']
    .filter(Boolean)
    .join(' ')
  const cond: string[] = ['attribute_exists(id)']
  if (opts.requireUnmatched) {
    names['#cond_shipmentId'] = 'shipmentId'
    values[':condUnmatched'] = UNMATCHED_SHIPMENT_ID
    cond.push('#cond_shipmentId = :condUnmatched')
  }
  return {
    Update: {
      TableName: deps.tables.message,
      Key: marshall({ id }),
      UpdateExpression: expr,
      ConditionExpression: cond.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshallRow(values),
    },
  }
}

// ── FILE_INBOUND_OFFER ───────────────────────────────────────────────────────

function validateInput(raw: Row): FileInboundOfferInput {
  const source = assertEnum(raw.source, SOURCES, 'source')
  const sourceKey = assertString(raw.sourceKey, 'sourceKey')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sourceKey)) throw new Error('sourceKey is not a valid key')
  const x = raw.extraction as InboundExtraction | undefined
  if (!x || typeof x !== 'object') throw new Error('extraction is required')
  assertEnum(x.kind, KINDS, 'extraction.kind')
  if (!x.carrier || typeof x.carrier !== 'object') throw new Error('extraction.carrier is required')
  const receivedAt = assertString(raw.receivedAt, 'receivedAt')
  if (Number.isNaN(Date.parse(receivedAt))) throw new Error('receivedAt must be an ISO timestamp')
  const bodyMax = source === 'CALL' ? 20_000 : 8_000
  const bodyRaw = typeof raw.body === 'string' ? raw.body : ''
  const call = raw.call as FileInboundOfferInput['call']
  return {
    source,
    sourceKey,
    mailboxId: optionalString(raw.mailboxId, 40),
    boardProvider: optionalString(raw.boardProvider, 40),
    receivedAt,
    fromEmail: optionalString(raw.fromEmail, 320),
    fromName: optionalString(raw.fromName, 200),
    to: stringList(raw.to, 20, 320),
    cc: stringList(raw.cc, 20, 320),
    subject: raw.subject == null ? null : String(raw.subject).trim().slice(0, 200) || null,
    body: bodyRaw.slice(0, bodyMax),
    messageId: optionalString(raw.messageId, 998),
    inReplyTo: optionalString(raw.inReplyTo, 998),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : [])
      .slice(0, 20)
      .map((a) => {
        const row = (a ?? {}) as Row
        return {
          name: String(row.name ?? '').slice(0, 200),
          contentType: String(row.contentType ?? '').slice(0, 100),
          sizeBytes: Math.max(0, Math.floor(numberOrNull(row.sizeBytes) ?? 0)),
        }
      }),
    authOk: raw.authOk === true,
    extraction: x,
    ...(source === 'CALL' && call && typeof call === 'object'
      ? {
          call: {
            callSid: String(call.callSid ?? '').slice(0, 80),
            durationSec: numberOrNull(call.durationSec),
            outcome: call.outcome == null ? null : String(call.outcome).slice(0, 200),
            recordingUrl: call.recordingUrl == null ? null : String(call.recordingUrl).slice(0, 1000),
          },
        }
      : {}),
  }
}

function resultFromRow(msg: Row, outcome: FileOutcome): FileInboundOfferResult {
  const rec = (msg.offer ?? null) as InboundOfferRecord | null
  const sid = String(msg.shipmentId ?? '')
  return {
    outcome,
    messageId: String(msg.id),
    shipmentId: sid && sid !== UNMATCHED_SHIPMENT_ID ? sid : null,
    quoteId: rec?.quoteId ?? null,
    score: rec?.match.score ?? 0,
    how: rec?.match.how ?? 'NONE',
  }
}

/** Replays resume an interrupted filing: matched OFFER, no Quote yet. Never creates a second Quote. */
async function resumeFiling(deps: CarrierInboundDeps, msg: Row, caller: Caller): Promise<FileInboundOfferResult> {
  const rec = (msg.offer ?? null) as InboundOfferRecord | null
  const sid = String(msg.shipmentId ?? '')
  const resumable =
    rec != null &&
    rec.match.state === 'MATCHED' &&
    rec.quoteId == null &&
    rec.extraction.kind === 'OFFER' &&
    (rec.extraction.rateCents ?? 0) > 0 &&
    sid !== UNMATCHED_SHIPMENT_ID
  if (!resumable) return resultFromRow(msg, 'DUPLICATE')
  return finishFiling(deps, msg, sid, caller)
}

/** Files the Quote for a message already on the load's thread and stamps the outcome on the row. */
async function finishFiling(deps: CarrierInboundDeps, msg: Row, shipmentId: string, caller: Caller): Promise<FileInboundOfferResult> {
  const rec = msg.offer as InboundOfferRecord
  const filed = await fileOffer(deps, offerInputFor(msg, shipmentId), caller)
  const covered = 'covered' in filed
  const next: InboundOfferRecord = covered
    ? { ...rec, match: { ...rec.match, state: 'COVERED_LATE' } }
    : { ...rec, quoteId: String(filed.quote.id), quoteNumber: String(filed.quote.id) }
  await deps.transact([messageUpdate(deps, String(msg.id), { offer: next })])
  return resultFromRow({ ...msg, offer: next }, covered ? 'COVERED_LATE' : 'FILED')
}

export async function fileInboundOffer(deps: CarrierInboundDeps, raw: Row, caller: Caller): Promise<FileInboundOfferResult> {
  const input = validateInput(raw)
  const msgId = `msg:cs:${input.sourceKey}`

  const existing = await deps.getById(deps.tables.message, msgId)
  if (existing) return resumeFiling(deps, existing, caller)

  const autoMin = clampNumber(raw.autoFileMinScore, 0.8, 0.99, DEFAULT_AUTO_MIN)
  const suggestMin = clampNumber(raw.suggestMinScore, 0.3, autoMin - 0.1, Math.min(DEFAULT_SUGGEST_MIN, autoMin - 0.1))
  const retentionDays = Math.round(clampNumber(raw.unmatchedRetentionDays, 7, 90, DEFAULT_RETENTION_DAYS))
  const now = deps.now()

  const x0 = input.extraction
  const built = await buildMatch(deps, input)
  const scored = scoreMatches(x0, built.ctx, built.ledger, { autoFileMinScore: autoMin, suggestMinScore: suggestMin })

  // The carrier identity is read from the directory, never trusted from the model.
  const carrier = await findCarrier(deps, { carrierMc: x0.carrier.mc, carrierName: x0.carrier.name })
  const flags: InboundFlag[] = [...x0.flags]
  if (carrier && x0.carrier.mc && x0.carrier.name) {
    const a = normalizeName(String(carrier.name ?? ''))
    const b = normalizeName(x0.carrier.name)
    if (a && b && a !== b && !a.includes(b) && !b.includes(a) && !flags.includes('MC_NAME_MISMATCH')) flags.push('MC_NAME_MISMATCH')
  }
  const extraction: InboundExtraction = { ...x0, flags }

  const topFacts = scored.top ? built.facts.get(scored.top.shipmentId) : undefined
  const auto = scored.decision === 'AUTO' && scored.top != null && topFacts != null && !topFacts.shipment.voidedAt
  // A reference match names no posting; the one still POSTED for that shipment is the one this offer answers.
  const top = scored.top && !scored.top.postingId
    ? { ...scored.top, postingId: built.ledger.postings.find((p) => p.shipmentId === scored.top!.shipmentId)?.postingId ?? null }
    : scored.top

  let state: InboundMatchState
  let how: MatchHow = top?.how ?? 'NONE'
  let outcome: FileOutcome
  let shipmentId = UNMATCHED_SHIPMENT_ID
  let loadId: string | null = null
  if (auto && top && topFacts) {
    shipmentId = top.shipmentId
    loadId = String(topFacts.loads[0]!.id)
    if (extraction.kind === 'OFFER' && (extraction.rateCents ?? 0) > 0) {
      state = isCovered(topFacts) ? 'COVERED_LATE' : 'MATCHED'
      outcome = state === 'COVERED_LATE' ? 'COVERED_LATE' : 'FILED'
    } else {
      state = 'MATCHED'
      outcome = 'THREAD_ONLY'
    }
  } else {
    state = scored.decision === 'NONE' || !top ? 'UNMATCHED' : 'SUGGESTED'
    outcome = state === 'SUGGESTED' ? 'SUGGESTED' : 'UNMATCHED'
    if (state === 'UNMATCHED') how = 'NONE'
  }

  const record: InboundOfferRecord = {
    source: input.source,
    mailboxId: input.mailboxId,
    boardProvider: input.boardProvider,
    extraction,
    match: {
      state,
      how,
      score: top?.score ?? 0,
      top: state === 'UNMATCHED' ? null : top,
      candidates: state === 'UNMATCHED' ? [] : trimCandidates(scored.candidates),
    },
    quoteId: null,
    quoteNumber: null,
    call: input.call ?? null,
    fieldMeta: fieldMetaFor(extraction, carrier != null, input.source),
    assignedBy: null,
    assignedAt: null,
  }

  const matched = shipmentId !== UNMATCHED_SHIPMENT_ID
  const isCall = input.source === 'CALL'
  const callLabel = extraction.carrier.name || input.fromEmail || input.fromName || 'caller'
  const row: Row = {
    id: msgId,
    __typename: 'ShipmentMessage',
    shipmentId,
    threadKey: matched ? threadKeyFor(shipmentId) : UNMATCHED_THREAD_KEY,
    loadId,
    direction: 'IN',
    channel: isCall ? 'VOICE' : 'EMAIL',
    kind: 'CARRIER_OFFER',
    party: 'CARRIER',
    from: input.fromEmail ?? input.fromName,
    to: input.to.join(', '),
    cc: input.cc.join(', '),
    subject: isCall ? (input.subject ?? `Call · ${callLabel}`).slice(0, 200) : input.subject,
    body: input.body,
    status: 'RECEIVED',
    // `messageId` is a GSI hash key: DynamoDB refuses NULL there, so an absent id is omitted, not nulled.
    messageId: isCall ? undefined : (input.messageId ?? undefined),
    inReplyTo: isCall ? undefined : (input.inReplyTo ?? undefined),
    providerRef: isCall ? `call:${input.call?.callSid ?? input.sourceKey}` : `gmail:${input.mailboxId ?? 'none'}:${input.sourceKey}`,
    attachments: input.attachments.length ? input.attachments : null,
    authorKind: 'AGENT',
    authorName: 'Carrier inbox',
    at: new Date(Date.parse(input.receivedAt)).toISOString(),
    createdBy: caller.email,
    offer: record,
    ...(matched ? {} : { ttlEpoch: ttlFor(input.receivedAt, retentionDays, now) }),
  }

  try {
    await deps.transact([putItem(deps.tables.message, row)])
  } catch (err) {
    // Lost the race to a parallel delivery of the same message: that row wins.
    const again = await deps.getById(deps.tables.message, msgId)
    if (again) return resumeFiling(deps, again, caller)
    throw err
  }

  let result: FileInboundOfferResult = resultFromRow(row, outcome)
  if (outcome === 'FILED') {
    result = await finishFiling(deps, row, shipmentId, caller)
  } else if (outcome === 'COVERED_LATE') {
    result = resultFromRow(row, 'COVERED_LATE')
  }

  await deps.writeAudit('SHIPMENT', matched ? shipmentId : msgId, 'FILE_INBOUND_OFFER', caller, {
    messageId: msgId,
    source: input.source,
    mailboxId: input.mailboxId,
    outcome: result.outcome,
    score: result.score,
    how: result.how,
    quoteId: result.quoteId,
  })
  return result
}

// ── ASSIGN_INBOUND_OFFER ─────────────────────────────────────────────────────

export async function assignInboundOffer(deps: CarrierInboundDeps, input: Row, caller: Caller): Promise<Row> {
  const messageId = assertString(input.messageId, 'messageId')
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const msg = await deps.getById(deps.tables.message, messageId)
  if (!msg || !msg.offer) throw new Error(`Inbound offer not found: ${messageId}`)
  if (String(msg.shipmentId ?? '') !== UNMATCHED_SHIPMENT_ID) throw new Error('That offer is already assigned to a load')

  const facts = await loadShipmentFacts(deps, shipmentId)
  if (!facts) throw new Error(`Shipment not found: ${shipmentId}`)
  if (facts.shipment.voidedAt) throw new Error('That shipment is voided')
  if (facts.loads.length === 0) throw new Error('That shipment has no load to offer')
  const loadId = String(facts.loads[0]!.id)

  const rec = msg.offer as InboundOfferRecord
  const meta = { ...rec.fieldMeta }
  const rep = (key: string) => {
    meta[key] = { source: 'REP', confidence: 'high' }
  }
  const overrides: Row = {}
  const extraction: InboundExtraction = { ...rec.extraction, carrier: { ...rec.extraction.carrier } }
  const name = optionalString(input.carrierName, 200)
  if (name) { overrides.carrierName = name; extraction.carrier.name = name; rep('carrierName') }
  const mc = optionalString(input.carrierMc, 40)
  if (mc) { overrides.carrierMc = mc; extraction.carrier.mc = mc.replace(/\D/g, '') || mc; rep('carrierMc') }
  const equipment = optionalString(input.equipmentType, 80)
  if (equipment) { overrides.equipmentType = equipment; rep('equipment') }
  const contactName = optionalString(input.contactName, 120)
  if (contactName) { overrides.contactName = contactName; extraction.carrier.contactName = contactName }
  const contactPhone = optionalString(input.contactPhone, 40)
  if (contactPhone) { overrides.contactPhone = contactPhone; extraction.carrier.phone = contactPhone; rep('contactPhone') }
  const amount = numberOrNull(input.amountCents)
  if (amount != null) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('amountCents must be a positive integer')
    overrides.amountCents = amount
    extraction.rateCents = amount
    rep('rateCents')
  }

  const now = deps.now()
  const postings = await deps.queryIndex(deps.tables.posting, 'shipmentPostingsByShipmentId', 'shipmentId', shipmentId)
  const livePosting = postings.find((p) => String(p.status) === 'POSTED')
  if (livePosting) overrides.postingId = String(livePosting.id)
  const working: Row = {
    ...msg,
    offer: { ...rec, extraction, fieldMeta: meta, match: { ...rec.match, state: 'ASSIGNED' as const } },
  }
  const wrec = working.offer as InboundOfferRecord
  const wantsQuote = extraction.kind === 'OFFER' || amount != null
  const hasRate = (extraction.rateCents ?? 0) > 0

  let quoteId: string | null = wrec.quoteId
  let outcome: FileOutcome = 'THREAD_ONLY'
  const state: InboundMatchState = 'ASSIGNED'
  if (wantsQuote && hasRate && !quoteId) {
    const filed = await fileOffer(deps, offerInputFor(working, shipmentId, overrides), caller)
    if ('covered' in filed) outcome = 'COVERED_LATE'
    else {
      quoteId = String(filed.quote.id)
      outcome = 'FILED'
    }
  } else if (quoteId) outcome = 'FILED'

  const next: InboundOfferRecord = {
    ...wrec,
    match: { ...wrec.match, state },
    quoteId,
    quoteNumber: quoteId,
    assignedBy: caller.email,
    assignedAt: now,
  }
  await deps.transact([
    messageUpdate(
      deps,
      messageId,
      { shipmentId, threadKey: threadKeyFor(shipmentId), loadId, offer: next },
      { remove: ['ttlEpoch'], requireUnmatched: true },
    ),
  ])
  await deps.writeAudit('SHIPMENT', shipmentId, 'ASSIGN_INBOUND_OFFER', caller, { messageId, quoteId, outcome })
  return { messageId, shipmentId, loadId, quoteId, outcome }
}

// ── DISMISS_INBOUND_OFFER ────────────────────────────────────────────────────

export async function dismissInboundOffer(deps: CarrierInboundDeps, input: Row, caller: Caller): Promise<Row> {
  const messageId = assertString(input.messageId, 'messageId')
  const reason = optionalString(input.reason, 300)
  const msg = await deps.getById(deps.tables.message, messageId)
  if (!msg) throw new Error(`Inbound offer not found: ${messageId}`)
  if (String(msg.shipmentId ?? '') !== UNMATCHED_SHIPMENT_ID) throw new Error('Only an unmatched offer can be dismissed')
  await deps.transact([
    {
      Delete: {
        TableName: deps.tables.message,
        Key: marshall({ id: messageId }),
        ConditionExpression: '#s = :u',
        ExpressionAttributeNames: { '#s': 'shipmentId' },
        ExpressionAttributeValues: marshall({ ':u': UNMATCHED_SHIPMENT_ID }),
      },
    },
  ])
  // Ids and the reason only; never message content.
  await deps.writeAudit('SHIPMENT_MESSAGE', messageId, 'DISMISS_INBOUND_OFFER', caller, { reason })
  return { messageId, dismissed: true }
}
