/**
 * Step AL — one mail (or one call) through the funnel.
 *
 *   STAGE 1  headers + snippet only (the body is never fetched for a reject)   → count and forget
 *   STAGE 2  body, quoted history stripped, freight/price signal score          → count and forget
 *   STAGE 3  one model call; NOT_RELEVANT is counted and dropped
 *   HAND-OVER FILE_INBOUND_OFFER on the router (the only writer of Quote / ShipmentMessage)
 *
 * What is written for a mail that is not offer-bearing: nothing. The counters in the run
 * digest are numbers only. An error (Gmail, model timeout, router) propagates to the poll
 * loop, which holds the cursor; nothing is stored for a message that could not be classified.
 */
import { createHash } from 'node:crypto'
import { agentEnabled } from '../../../../src/lib/workflows/memory'
import { redactForPrompt } from '../../../../src/lib/workflows/memory'
import type { AiAgentsSettings } from '../../../../src/types/tms'
import type { GmailPort } from '../../../../src/lib/spot/port'
import { chicagoDay } from '../../../../src/lib/spot/chicagoDay'
import {
  type CarrierInboxMailbox,
  type CarrierInboxRunStats,
  type FileInboundOfferInput,
  type FileInboundOfferResult,
  type InboundExtraction,
  type ResolvedCarrierInboxConfig,
} from '../../../../src/lib/carrierInbox/types'
import { normalizeInboundExtraction, type RawInboundModelOutput } from '../../../../src/lib/carrierInbox/normalize'
import { authOkFromHeaders, prefilterStage1, prefilterStage2, prepareInboundBody } from '../../../../src/lib/carrierInbox/prefilter'
import { addressOf, isoOfInternalDate, withModelTimeout } from '../pipeline'
import type { CarrierInboxDeps } from './deps'

/** The router honours these (clamped to its floors); they are the admin's Settings > Carrier Sales rules. */
export interface FilingRules {
  autoFileMinScore: number
  suggestMinScore: number
  unmatchedRetentionDays: number
}

export function filingRules(cfg: ResolvedCarrierInboxConfig): FilingRules {
  return {
    autoFileMinScore: cfg.autoFileMinScore,
    suggestMinScore: cfg.suggestMinScore,
    unmatchedRetentionDays: cfg.unmatchedRetentionDays,
  }
}

export const MAX_EMAIL_BODY_CHARS = 8000
export const MAX_ADDRESS_CHARS = 320
export const MAX_ADDRESSES = 20
export const MIN_TRANSCRIPT_CHARS = 40

export function emptyCsStats(): CarrierInboxRunStats {
  return {
    listed: 0, wrongMailbox: 0, stage1Rejected: 0, stage2Rejected: 0, modelCalls: 0, notOffer: 0,
    filed: 0, threadOnly: 0, coveredLate: 0, suggested: 0, unmatched: 0, duplicate: 0,
    errors: 0, abandoned: 0, held: 0, deferred: 0,
  }
}

export function sha1of(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 20)
}

export type CsMailOutcome =
  | 'SKIPPED' | 'WRONG_MAILBOX' | 'REJECT1' | 'REJECT2' | 'NOT_OFFER'
  | 'FILED' | 'THREAD_ONLY' | 'COVERED_LATE' | 'SUGGESTED' | 'UNMATCHED' | 'DUPLICATE'
  /** The model is off or its daily cap is used: nothing classified, the cursor holds. */
  | 'MODEL_OFF' | 'MODEL_CAP'

/** Model budget of the run (Chicago day), persisted by the poll loop. */
export interface CsBudget { day: string; count: number }

export interface CsMailContext {
  deps: CarrierInboxDeps
  cfg: ResolvedCarrierInboxConfig
  mailbox: CarrierInboxMailbox
  port: GmailPort
  stats: CarrierInboxRunStats
  budget: CsBudget
  aiAgents: AiAgentsSettings | null
  blacklist: { addresses: string[]; keywords: string[] }
}

export function budgetOf(
  state: { modelCallsDay: string | null; modelCallsToday: number },
  now: Date,
): CsBudget {
  const day = chicagoDay(now.toISOString())
  return { day, count: state.modelCallsDay === day ? state.modelCallsToday : 0 }
}

export function modelGate(ctx: Pick<CsMailContext, 'aiAgents' | 'cfg' | 'budget'>): 'OK' | 'OFF' | 'CAP' {
  if (!agentEnabled(ctx.aiAgents, 'CAPACITY')) return 'OFF'
  if (ctx.budget.count >= ctx.cfg.modelCallsPerDay) return 'CAP'
  return 'OK'
}

const OUTCOME_COUNTER: Record<FileInboundOfferResult['outcome'], keyof CarrierInboxRunStats> = {
  FILED: 'filed',
  THREAD_ONLY: 'threadOnly',
  COVERED_LATE: 'coveredLate',
  SUGGESTED: 'suggested',
  UNMATCHED: 'unmatched',
  DUPLICATE: 'duplicate',
}

export function countOutcome(stats: CarrierInboxRunStats, outcome: FileInboundOfferResult['outcome']): void {
  stats[OUTCOME_COUNTER[outcome]] += 1
}

const clip = (s: string, n: number): string => s.slice(0, n)
const addresses = (list: string[]): string[] => list.slice(0, MAX_ADDRESSES).map((a) => clip(a, MAX_ADDRESS_CHARS))

/** Model answer, or the dev stack's stored classification for a simulated message. */
async function classify(
  ctx: CsMailContext,
  id: string,
  input: { subject: string | null; fromEmail: string | null; receivedAt: string; body: string },
): Promise<RawInboundModelOutput | 'MODEL_OFF' | 'MODEL_CAP'> {
  const { deps, mailbox } = ctx
  if (deps.devStack && mailbox.mode === 'SIMULATED') {
    const dev = await deps.simDevExtraction(mailbox.id, id)
    if (dev && typeof dev === 'object') return dev as RawInboundModelOutput
  }
  const gate = modelGate(ctx)
  if (gate !== 'OK') return gate === 'OFF' ? 'MODEL_OFF' : 'MODEL_CAP'
  ctx.budget.count += 1
  ctx.stats.modelCalls += 1
  const answer = await withModelTimeout(deps, deps.model.classify({
    source: 'EMAIL',
    subject: input.subject,
    fromEmail: input.fromEmail,
    receivedAt: input.receivedAt,
    body: input.body,
    aiAgents: ctx.aiAgents,
  }))
  return answer.output
}

const CALL_MARKER = /^\s*\[call\]/i

/** What stages 1-3 decided: a terminal outcome (nothing to file) or the hand-over to send. */
export type PreparedMail = { outcome: Exclude<CsMailOutcome, FileInboundOfferResult['outcome']> } | { input: FileInboundOfferInput & FilingRules }

/** Stages 1-3. Safe to run for several messages at once; filing is serial and in order. */
export async function prepareMailboxMessage(ctx: CsMailContext, id: string): Promise<PreparedMail> {
  const { mailbox, port, stats } = ctx
  const meta = await port.getMetadata(id)
  if (meta.labelIds.includes('DRAFT')) return { outcome: 'SKIPPED' }

  // STAGE 1 — metadata + snippet; the body is not fetched for a reject.
  const stage1 = prefilterStage1(meta, ctx.cfg, mailbox, ctx.blacklist)
  if (!stage1.pass) {
    if (stage1.reason === 'WRONG_MAILBOX') stats.wrongMailbox += 1
    else stats.stage1Rejected += 1
    return { outcome: stage1.reason === 'WRONG_MAILBOX' ? 'WRONG_MAILBOX' : 'REJECT1' }
  }

  // STAGE 2 — body, quoted history stripped, price / reference / carrier-cue score.
  const body = await port.getBody(meta.id)
  const prepared = prepareInboundBody(meta.subject, body.text)
  const stage2 = prefilterStage2(prepared, { boardRelay: stage1.boardProvider !== null })
  if (!stage2.pass) {
    stats.stage2Rejected += 1
    return { outcome: 'REJECT2' }
  }

  // STAGE 3 — one model call (or the dev stack's stored classification).
  const sender = addressOf(meta.from)
  const receivedAt = isoOfInternalDate(meta.internalDate)
  const text = redactForPrompt(prepared).slice(0, MAX_EMAIL_BODY_CHARS)
  const raw = await classify(ctx, meta.id, { subject: meta.subject, fromEmail: sender.email, receivedAt, body: text })
  if (raw === 'MODEL_OFF' || raw === 'MODEL_CAP') return { outcome: raw }

  const extraction: InboundExtraction = normalizeInboundExtraction(raw, {
    receivedAt,
    senderEmail: sender.email || null,
    authOk: authOkFromHeaders(meta.headers, meta.from),
    boardProvider: stage1.boardProvider,
  })
  if (extraction.kind === 'NOT_RELEVANT') {
    stats.notOffer += 1
    return { outcome: 'NOT_OFFER' }
  }

  const sourceKey = sha1of(meta.messageId || `gmail:${mailbox.id}:${meta.id}`)
  const phone = CALL_MARKER.test(meta.subject)
  const input: FileInboundOfferInput & FilingRules = {
    ...filingRules(ctx.cfg),
    source: phone ? 'CALL' : 'EMAIL',
    sourceKey,
    mailboxId: mailbox.id,
    boardProvider: stage1.boardProvider,
    receivedAt,
    fromEmail: sender.email ? clip(sender.email, MAX_ADDRESS_CHARS) : null,
    fromName: sender.name ? clip(sender.name, 120) : null,
    to: addresses(meta.to),
    cc: addresses(meta.cc),
    subject: clip(meta.subject, 200) || null,
    body: text,
    messageId: meta.messageId ? clip(meta.messageId, 300) : null,
    inReplyTo: meta.inReplyTo ? clip(meta.inReplyTo, 300) : null,
    // Metadata only: attachment bytes are never fetched or stored.
    attachments: body.attachments.slice(0, 10).map((a) => ({ name: clip(a.name, 120), contentType: clip(a.contentType, 100), sizeBytes: a.size })),
    authOk: authOkFromHeaders(meta.headers, meta.from),
    extraction,
    ...(phone ? { call: { callSid: `mail:${sourceKey}`, durationSec: null, outcome: null, recordingUrl: null } } : {}),
  }
  return { input }
}

/** Hands one prepared mail to the router and counts the outcome. */
export async function fileMailboxMessage(ctx: CsMailContext, prepared: PreparedMail): Promise<CsMailOutcome> {
  if (!('input' in prepared)) return prepared.outcome
  const result = await ctx.deps.files.fileInboundOffer(prepared.input)
  countOutcome(ctx.stats, result.outcome)
  return result.outcome
}

export async function processMailboxMessage(ctx: CsMailContext, id: string): Promise<CsMailOutcome> {
  return fileMailboxMessage(ctx, await prepareMailboxMessage(ctx, id))
}

// ── Voice ────────────────────────────────────────────────────────────────────

/** Plan §5.5: what the Cowtown voice agent POSTs at the end of a call. */
export interface CarrierCallPayload {
  secret?: unknown
  callSid: string
  callerNumber: string | null
  startedAt: string | null
  endedAt: string | null
  durationSec: number | null
  outcome: string | null
  transcript: string
  summary: string | null
  recordingUrl: string | null
  structured: Record<string, unknown> | null
}

export type CallOutcome = FileInboundOfferResult['outcome'] | 'DROPPED' | 'NOT_OFFER'

export interface CallResult { outcome: CallOutcome; budget: CsBudget }

/**
 * A call through the same model + hand-over (`voice.ts` and CS_SIM_INJECT_CALL). Throws on a
 * model/router failure: the voice door answers 503 and the agent retries with the same callSid.
 * `devExtraction` is honoured by the caller only on the dev stack.
 */
export async function processCall(
  deps: CarrierInboxDeps,
  cfg: ResolvedCarrierInboxConfig,
  payload: CarrierCallPayload,
  opts: { devExtraction?: RawInboundModelOutput | null; budget: CsBudget; stats?: CarrierInboxRunStats },
): Promise<CallResult> {
  const stats = opts.stats ?? emptyCsStats()
  const outcome = (payload.outcome ?? '').trim().toUpperCase()
  const transcript = payload.transcript.trim()
  const budget = opts.budget
  if (outcome === 'ABANDONED' || transcript.length < MIN_TRANSCRIPT_CHARS) return { outcome: 'DROPPED', budget }

  const receivedAt = payload.endedAt ?? payload.startedAt ?? deps.now().toISOString()
  const text = redactForPrompt(
    payload.summary ? `Agent summary: ${payload.summary}\n\nTranscript:\n${transcript}` : transcript,
  ).slice(0, cfg.voice.maxTranscriptChars)

  let raw: RawInboundModelOutput
  if (opts.devExtraction && deps.devStack) {
    raw = opts.devExtraction
  } else {
    const aiAgents = await deps.loadAiAgents()
    if (modelGate({ aiAgents, cfg, budget }) !== 'OK') throw new Error('MODEL_UNAVAILABLE')
    budget.count += 1
    stats.modelCalls += 1
    const answer = await withModelTimeout(deps, deps.model.classify({
      source: 'CALL', subject: null, fromEmail: null, receivedAt, body: text, hints: payload.structured, aiAgents,
    }))
    raw = answer.output
  }
  const extraction = normalizeInboundExtraction(raw, {
    receivedAt, senderEmail: null, authOk: true, boardProvider: null,
  })
  if (extraction.kind === 'NOT_RELEVANT') {
    stats.notOffer += 1
    return { outcome: 'NOT_OFFER', budget }
  }
  const who = extraction.carrier.name ?? payload.callerNumber ?? 'caller'
  const result = await deps.files.fileInboundOffer({
    ...filingRules(cfg),
    source: 'CALL',
    sourceKey: sha1of(payload.callSid),
    mailboxId: null,
    boardProvider: null,
    receivedAt,
    fromEmail: null,
    fromName: payload.callerNumber,
    to: [],
    cc: [],
    subject: clip(`Call · ${who}`, 200),
    body: text,
    messageId: null,
    inReplyTo: null,
    attachments: [],
    authOk: true,
    extraction,
    call: {
      callSid: clip(payload.callSid, 80),
      durationSec: payload.durationSec,
      outcome: payload.outcome ? clip(payload.outcome, 80) : null,
      recordingUrl: payload.recordingUrl,
    },
  })
  countOutcome(stats, result.outcome)
  return { outcome: result.outcome, budget }
}
