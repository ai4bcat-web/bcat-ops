/**
 * tms-spot-quoter — one mail through the three stages (plan §3.1–3.5).
 *
 *   STAGE 1  headers + snippet only (body never fetched)       → count and forget
 *   STAGE 2  body, quoted history stripped, freight signal score → count and forget
 *   STAGE 3  one model call; only QUOTE_REQUEST is ever stored
 *
 * What is written for a mail that is not a quote request: nothing. Counters on the
 * connection row are numbers. A mail on a thread we already track is attached (a thread
 * snippet ≤ 200 chars, never the body).
 */
import { createHash } from 'node:crypto'
import { agentEnabled } from '../../../src/lib/workflows/memory'
import type {
  AiAgentsSettings,
  GmailConnectionRecord,
  SpotPollStats,
  SpotReplyIntent,
  SpotRequestRecord,
  SpotThreadEntry,
} from '../../../src/types/tms'
import type { GmailMessageMeta, GmailPort } from '../../../src/lib/spot/port'
import { normalizeExtraction } from '../../../src/lib/spot/normalize'
import {
  blacklistFromSettings,
  prefilterStage1,
  prefilterStage2,
  stripQuotedHistory,
} from '../../../src/lib/spot/prefilter'
import { chicagoDay } from '../../../src/lib/spot/autoSend'
import { resolveRepSettings, type ResolvedSpotSettings } from '../../../src/lib/spot/settings'
import type { SpotDeps } from './deps'
import { jsonOf } from './store'
import { maybeAutoSend } from './autoSend'

export const MAX_BODY_CHARS = 8000
export const MAX_THREAD_ENTRIES = 20

export type MailOutcome =
  | 'REJECT1'
  | 'REJECT2'
  | 'NOT_REQUEST'
  | 'STORED'
  | 'ATTACHED'
  | 'EXISTS'
  | 'MODEL_OFF'
  | 'MODEL_CAP'

/** `SpotPollStats` plus the consecutive-held-runs counter (a number, never content). */
export type PollStats = SpotPollStats & { held?: number }

export interface PollContext {
  deps: SpotDeps
  conn: GmailConnectionRecord
  port: GmailPort
  settings: ResolvedSpotSettings
  aiAgents: AiAgentsSettings | null
  blacklist: { addresses: string[]; keywords: string[] }
  stats: PollStats
  /** Model calls made today for this rep (Chicago day); persisted by the poll loop. */
  budget: { day: string; count: number }
  senderCache: Map<string, boolean>
}

export function emptyStats(): PollStats {
  return { listed: 0, stage1Rejected: 0, stage2Rejected: 0, modelCalls: 0, stored: 0, attached: 0, errors: 0 }
}

export function budgetOf(conn: Pick<GmailConnectionRecord, 'modelCallsDay' | 'modelCallsToday'>, now: Date): { day: string; count: number } {
  const day = chicagoDay(now.toISOString())
  return { day, count: conn.modelCallsDay === day ? conn.modelCallsToday ?? 0 : 0 }
}

export function addressOf(headerValue: string | null | undefined): { email: string; name: string | null } {
  const raw = (headerValue ?? '').trim()
  const angle = /^(.*?)<([^>]+)>/.exec(raw)
  const email = (angle ? angle[2] : raw).trim().toLowerCase()
  const name = angle ? angle[1].replace(/^["'\s]+|["'\s]+$/g, '') : ''
  return { email, name: name || null }
}

export function isoOfInternalDate(internalDate: string): string {
  const n = Number(internalDate)
  return new Date(Number.isFinite(n) && n > 0 ? n : Date.now()).toISOString()
}

export function ttlFor(receivedAtIso: string, days: number): number {
  return Math.floor(new Date(receivedAtIso).getTime() / 1000) + days * 86_400
}

function repEmailOf(conn: GmailConnectionRecord): string {
  const g = conn.googleEmail ?? ''
  return (g && !g.includes(' ') ? g : conn.userEmail).toLowerCase()
}

export function modelGate(ctx: Pick<PollContext, 'aiAgents' | 'settings' | 'budget'>): 'OK' | 'OFF' | 'CAP' {
  if (!agentEnabled(ctx.aiAgents, 'QUOTE')) return 'OFF'
  if (ctx.budget.count >= ctx.settings.modelCallsPerRepPerDay) return 'CAP'
  return 'OK'
}

async function knownSender(ctx: PollContext, email: string): Promise<boolean> {
  if (!email) return false
  const hit = ctx.senderCache.get(email)
  if (hit !== undefined) return hit
  const match = await ctx.deps.crm.lookupSender(email)
  const known = match.how !== 'NONE'
  ctx.senderCache.set(email, known)
  return known
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function trimThread(thread: SpotThreadEntry[]): SpotThreadEntry[] {
  return thread.length > MAX_THREAD_ENTRIES ? thread.slice(thread.length - MAX_THREAD_ENTRIES) : thread
}

/** The row for a classified quote request. Shared by the poller and SPOT_ADD_MANUAL. */
export async function buildRequestRow(
  ctx: Pick<PollContext, 'deps' | 'settings'>,
  input: {
    id: string
    userId: string
    mode: 'GOOGLE' | 'SIMULATED' | null
    gmailMessageId: string
    gmailThreadId: string
    receivedAt: string
    fromEmail: string
    fromName: string | null
    replyTo: string | null
    subject: string
    body: string
    attachments: { name: string; contentType?: string; size?: number }[]
    raw: Parameters<typeof normalizeExtraction>[0]
    authVerdict: string | null
    threadSnippet: string | null
    messageId: string
  },
): Promise<SpotRequestRecord> {
  const normalized = normalizeExtraction(input.raw, { mailDate: input.receivedAt })
  const match = input.fromEmail ? await ctx.deps.crm.lookupSender(input.fromEmail, input.authVerdict) : null
  const downgraded = Boolean(match?.authDowngrade)
  const matched = match && match.how !== 'NONE' && match.how !== 'AMBIGUOUS' && !downgraded
  const candidates = (match?.candidates ?? []).slice(0, 3).map((c) => ({ customerId: c.customerId, how: c.how }))
  if (downgraded && match?.customerId && !candidates.some((c) => c.customerId === match.customerId)) {
    candidates.unshift({ customerId: match.customerId, how: match.how === 'EMAIL' ? 'EMAIL' : 'DOMAIN' })
  }
  return {
    id: input.id,
    userId: input.userId,
    mode: input.mode,
    gmailMessageId: input.gmailMessageId,
    gmailThreadId: input.gmailThreadId,
    receivedAt: input.receivedAt,
    fromEmail: input.fromEmail || null,
    fromName: input.fromName,
    replyTo: input.replyTo,
    subject: input.subject.slice(0, 200),
    bodyText: input.body.slice(0, MAX_BODY_CHARS),
    attachments: input.attachments.map((a) => ({ name: a.name.slice(0, 120), contentType: a.contentType, size: a.size })),
    status: normalized.status,
    classification: normalized.classification,
    extraction: normalized.extraction,
    fieldMeta: normalized.fieldMeta,
    missingFields: normalized.missingFields,
    customerId: matched ? match.customerId ?? null : null,
    contactEmail: input.replyTo ?? (input.fromEmail || null),
    matchHow: downgraded ? 'NONE' : (match?.how ?? 'NONE'),
    matchCandidates: candidates,
    thread: input.threadSnippet == null
      ? []
      : [{ id: input.messageId, at: input.receivedAt, dir: 'IN', snippet: input.threadSnippet }],
    ttlEpoch: ttlFor(input.receivedAt, ctx.settings.retentionDays),
    version: 1,
  }
}

async function recordEmailActivity(
  ctx: Pick<PollContext, 'deps'>,
  row: SpotRequestRecord,
  kind: 'EMAIL_IN' | 'EMAIL_OUT',
  at: string,
): Promise<void> {
  try {
    await ctx.deps.crm.addSystemActivity({
      customerId: row.customerId ?? undefined,
      contactEmail: row.fromEmail ?? undefined,
      ownerId: row.userId,
      kind,
      at,
      subject: (row.subject ?? '').slice(0, 120) || undefined,
      refs: { spotRequestId: row.id, gmailThreadId: row.gmailThreadId || undefined },
    })
  } catch (err) {
    console.warn('[tms-spot-quoter] crm activity write failed:', String(err))
  }
}

async function attach(ctx: PollContext, meta: GmailMessageMeta, tracked: SpotRequestRecord): Promise<MailOutcome> {
  const thread = jsonOf<SpotThreadEntry[]>(tracked.thread) ?? []
  if (thread.some((e) => e.id === meta.id)) return 'EXISTS'
  const at = isoOfInternalDate(meta.internalDate)
  const rep = repEmailOf(ctx.conn)
  const outbound = meta.labelIds.includes('SENT') || addressOf(meta.from).email === rep || meta.from.toLowerCase() === 'me'
  const entry: SpotThreadEntry = { id: meta.id, at, dir: outbound ? 'OUT' : 'IN', snippet: snippetOf(meta.snippet) }
  const patch: Record<string, unknown> = { thread: trimThread([...thread, entry]) }

  if (!outbound) {
    patch.customerReplyAt = at
    if (tracked.status !== 'DISMISSED') patch.needsAttention = true
    const gate = modelGate(ctx)
    if (gate === 'OK') {
      try {
        const body = await ctx.port.getBody(meta.id)
        ctx.budget.count += 1
        ctx.stats.modelCalls += 1
        const intent: SpotReplyIntent = await ctx.deps.model.replyIntent({
          subject: meta.subject,
          fromEmail: addressOf(meta.from).email,
          body: stripQuotedHistory(body.text),
        })
        patch.replyIntent = intent
      } catch (err) {
        // The intent chip is a hint; the reply itself is still attached.
        console.warn('[tms-spot-quoter] reply intent failed:', String(err))
      }
    }
  }
  await ctx.deps.store.updateRequest(tracked.id, patch)
  await recordEmailActivity(ctx, tracked, outbound ? 'EMAIL_OUT' : 'EMAIL_IN', at)
  ctx.stats.attached += 1
  return 'ATTACHED'
}

export async function processMessage(ctx: PollContext, id: string): Promise<MailOutcome> {
  const { deps, conn, port } = ctx
  const meta = await port.getMetadata(id)
  if (meta.labelIds.includes('DRAFT')) return 'EXISTS'

  // Thread already tracked → attach, no re-classification.
  const tracked = (await deps.store.requestsByThread(meta.threadId)).find((r) => r.userId === conn.id)
  if (tracked) return attach(ctx, meta, tracked)

  const sender = addressOf(meta.from)
  const repSettings = resolveRepSettings(conn.settings)
  // STAGE 1 — metadata + snippet; the body is not fetched for a reject.
  const stage1 = prefilterStage1(meta, {
    repEmail: repEmailOf(conn),
    ownDomains: deps.ownDomains,
    blacklist: ctx.blacklist,
    watchLabel: repSettings.watchLabel,
    knownSender: await knownSender(ctx, sender.email),
  })
  if (!stage1.pass) {
    ctx.stats.stage1Rejected += 1
    return 'REJECT1'
  }

  const requestId = `sr:${conn.id}:${meta.id}`
  if (await deps.store.getRequest(requestId)) return 'EXISTS'

  // STAGE 2 — body, quoted history stripped, freight-signal score.
  const body = await port.getBody(meta.id)
  const stripped = stripQuotedHistory(body.text)
  const stage2 = prefilterStage2(stripped)
  if (!stage2.pass) {
    ctx.stats.stage2Rejected += 1
    return 'REJECT2'
  }

  // STAGE 3 — one model call. Kill switches come first, in order.
  const gate = modelGate(ctx)
  if (gate !== 'OK') return gate === 'OFF' ? 'MODEL_OFF' : 'MODEL_CAP'
  const receivedAt = isoOfInternalDate(meta.internalDate)
  ctx.budget.count += 1
  ctx.stats.modelCalls += 1
  const answer = await deps.model.classify({
    subject: meta.subject,
    fromEmail: sender.email,
    mailDate: receivedAt,
    body: stripped,
    aiAgents: ctx.aiAgents,
  })
  if (answer.output.kind !== 'QUOTE_REQUEST') return 'NOT_REQUEST'

  const replyTo = meta.replyTo ? addressOf(meta.replyTo).email : null
  const row = await buildRequestRow(ctx, {
    id: requestId,
    userId: conn.id,
    mode: conn.mode,
    gmailMessageId: meta.id,
    gmailThreadId: meta.threadId,
    receivedAt,
    fromEmail: sender.email,
    fromName: sender.name,
    replyTo,
    subject: meta.subject,
    body: stripped,
    attachments: body.attachments,
    raw: answer.output,
    authVerdict: meta.headers['authentication-results'] ?? null,
    threadSnippet: snippetOf(meta.snippet),
    messageId: meta.id,
  })
  const created = await deps.store.putRequestIfAbsent(row)
  if (!created) return 'EXISTS'
  ctx.stats.stored += 1
  await recordEmailActivity(ctx, row, 'EMAIL_IN', receivedAt)
  if (repSettings.autoSend) {
    await maybeAutoSend({ deps, conn, port, settings: ctx.settings, aiAgents: ctx.aiAgents }, row, meta)
  }
  return 'STORED'
}

/** The paste-a-request box: stage 3 only, same storage and TTL rules (DR-8). */
export async function processManual(
  deps: SpotDeps,
  ctx: { conn: GmailConnectionRecord | null; userId: string; settings: ResolvedSpotSettings; aiAgents: AiAgentsSettings | null },
  input: { text: string; subject?: string; fromEmail?: string; fromName?: string; devExtraction?: Parameters<typeof normalizeExtraction>[0] },
): Promise<SpotRequestRecord> {
  const text = input.text.slice(0, MAX_BODY_CHARS)
  const fromEmail = (input.fromEmail ?? '').trim().toLowerCase()
  const sha = createHash('sha256').update(`${fromEmail}\n${input.subject ?? ''}\n${text}`).digest('hex').slice(0, 16)
  const id = `sr:${ctx.userId}:manual-${sha}`
  const existing = await deps.store.getRequest(id)
  if (existing) return existing

  const receivedAt = deps.now().toISOString()
  let output: Parameters<typeof normalizeExtraction>[0]
  if (input.devExtraction && deps.devStack) {
    // Dev stack only: the verification harness supplies the classification itself when the
    // model is unavailable. Everything after this point (normalising, storing) is unchanged.
    output = input.devExtraction
  } else {
    const budget = ctx.conn ? budgetOf(ctx.conn, deps.now()) : { day: chicagoDay(deps.now().toISOString()), count: 0 }
    const gate = modelGate({ aiAgents: ctx.aiAgents, settings: ctx.settings, budget })
    if (gate === 'OFF') throw new Error('The QUOTE agent is switched off by an admin.')
    if (gate === 'CAP') throw new Error('The daily model-call limit for this mailbox has been reached.')
    const answer = await deps.model.classify({
      subject: input.subject ?? null,
      fromEmail: fromEmail || null,
      mailDate: receivedAt,
      body: stripQuotedHistory(text),
      aiAgents: ctx.aiAgents,
    })
    if (ctx.conn) {
      await deps.store.updateConnection(ctx.userId, { modelCallsDay: budget.day, modelCallsToday: budget.count + 1 })
    }
    output = answer.output
  }
  if (output.kind !== 'QUOTE_REQUEST') {
    throw new Error('That does not look like a request to quote freight, so it was not saved.')
  }
  const row = await buildRequestRow({ deps, settings: ctx.settings }, {
    id,
    userId: ctx.userId,
    mode: ctx.conn?.mode ?? null,
    gmailMessageId: `manual-${sha}`,
    gmailThreadId: '',
    receivedAt,
    fromEmail,
    fromName: input.fromName?.trim() || null,
    replyTo: null,
    subject: input.subject ?? '',
    body: text,
    attachments: [],
    raw: output,
    authVerdict: null,
    threadSnippet: null,
    messageId: `manual-${sha}`,
  })
  await deps.store.putRequestIfAbsent(row)
  await recordEmailActivity({ deps }, row, 'EMAIL_IN', receivedAt)
  return (await deps.store.getRequest(id)) ?? row
}

export async function loadBlacklist(deps: SpotDeps): Promise<{ addresses: string[]; keywords: string[] }> {
  const settings: unknown[] = []
  for (const provider of ['GMAIL', 'OUTLOOK']) {
    const row = await deps.store.getIntegration(provider)
    if (row) settings.push(jsonOf<unknown>(row.settings))
  }
  return blacklistFromSettings(settings)
}

export async function loadAiAgents(deps: SpotDeps): Promise<AiAgentsSettings | null> {
  const org = await deps.store.getTmsSettings()
  return org ? jsonOf<AiAgentsSettings>(org.aiAgents) : null
}
