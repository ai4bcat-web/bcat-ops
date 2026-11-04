/**
 * tms-spot-quoter — auto-send (plan §4.7). Per-rep switch, default OFF.
 *
 * Nothing here runs unless the rep's own switch is ON (the pipeline checks it before
 * calling `maybeAutoSend`). Even then a send needs the pure decision (`autoSendDecision`:
 * org opt-in + rep opt-in + customer opt-in + the hard gates) AND the narrow server door
 * (`SPOT_AUTO_QUOTE` in tms-shipment-actions), which re-verifies the price against live
 * data. `autoSendReply` is one of exactly two call sites of `GmailPort.sendReply`
 * (the other being `sendNow` in actions.ts); a source-shape test guards that.
 *
 * At-most-once: NEW → AUTO_PENDING is a conditional update, so a second poller loses the
 * claim. A failure after the quote exists turns into a DRAFT, never a retry of the send.
 */
import { resolveMargin } from '../../../src/lib/flowDefaults'
import type {
  AiAgentsSettings,
  GmailConnectionRecord,
  SpotAutoDecision,
  SpotRequestRecord,
} from '../../../src/types/tms'
import type { GmailMessageMeta, GmailPort } from '../../../src/lib/spot/port'
import type { SpotSuggestion } from '../../../src/lib/spot/types'
import { autoSendDecision, chicagoDay, senderAuthPasses } from '../../../src/lib/spot/autoSend'
import { resolveRepSettings, type ResolvedSpotSettings } from '../../../src/lib/spot/settings'
import type { SpotDeps } from './deps'
import { buildReply } from './reply'
import { ConflictError, jsonOf, type Row } from './store'

export interface AutoSendCtx {
  deps: SpotDeps
  conn: GmailConnectionRecord
  port: GmailPort
  settings: ResolvedSpotSettings
  aiAgents: AiAgentsSettings | null
}

/**
 * The price is not known to this Lambda: pricing runs inside the door against live DAT
 * and the lane table. The local decision therefore treats the price gates as satisfied;
 * the door re-verifies them (PRICE_STUB / PRICE_THIN / BELOW_FLOOR) and refuses with the
 * same reason codes, creating nothing.
 */
const PRICE_CHECKED_BY_DOOR: SpotSuggestion = {
  basis: 'DAT_LIVE',
  stub: false,
  suggestedCents: 0,
  lowCents: null,
  avgCents: null,
  highCents: null,
  perMileCents: null,
  reports: null,
  days: null,
  targetBps: 0,
  floorBps: 0,
  targetSource: 'DOOR',
  floorSellCents: 0,
  marginAtSuggested: null,
  belowFloor: false,
  miles: null,
  sampleCount: Number.MAX_SAFE_INTEGER,
  confidence: 'GOOD',
  notes: [],
  label: 'Verified by the quote door',
}

async function record(
  ctx: AutoSendCtx,
  row: SpotRequestRecord,
  decision: SpotAutoDecision,
  extra: Row = {},
  guard?: { statusIn: SpotRequestRecord['status'][] },
): Promise<void> {
  await ctx.deps.store.updateRequest(row.id, { autoDecision: decision, ...extra }, guard)
}

async function autoSentToday(deps: SpotDeps, userId: string, customerId: string | null, day: string): Promise<number> {
  if (!customerId) return 0
  const rows = await deps.store.requestsByUser(userId)
  return rows.filter((r) => {
    const d = r.autoDecision
    return r.customerId === customerId && d?.decision === 'SENT' && chicagoDay(d.at) === day
  }).length
}

export async function maybeAutoSend(ctx: AutoSendCtx, row: SpotRequestRecord, meta: GmailMessageMeta): Promise<void> {
  const { deps, conn } = ctx
  const nowIso = deps.now().toISOString()
  const day = chicagoDay(nowIso)
  const repSettings = resolveRepSettings(conn.settings)
  const customer = row.customerId ? await deps.store.getCustomer(row.customerId) : null
  const org = await deps.store.getTmsSettings()
  const margin = resolveMargin(org, customer, 'FTL')
  const thread = jsonOf<{ dir: string }[]>(row.thread) ?? []

  const decision = autoSendDecision({
    settings: ctx.settings,
    repSettings,
    devStack: deps.devStack,
    repId: conn.id,
    customer: customer
      ? {
          status: typeof customer.status === 'string' ? customer.status : null,
          accountOwnerIds: Array.isArray(customer.accountOwnerIds) ? (customer.accountOwnerIds as string[]) : null,
          defaultSalesRepId: typeof customer.defaultSalesRepId === 'string' ? customer.defaultSalesRepId : null,
        }
      : null,
    matchHow: row.matchHow ?? null,
    customerAutoReply: margin.autoReply,
    extraction: row.extraction as NonNullable<SpotRequestRecord['extraction']>,
    fieldMeta: (row.fieldMeta ?? {}) as NonNullable<SpotRequestRecord['fieldMeta']>,
    suggestion: PRICE_CHECKED_BY_DOOR,
    senderAuthOk: senderAuthPasses(meta.headers, row.fromEmail ?? ''),
    threadHasOutbound: thread.some((t) => t.dir === 'OUT'),
    replyTo: row.contactEmail ?? null,
    hasQuoteOrDraft: Boolean(row.quoteId || row.draftId),
    autoSentTodayRep: conn.autoSendDay === day ? conn.autoSendCount ?? 0 : 0,
    autoSentTodayCustomer: await autoSentToday(deps, conn.id, row.customerId ?? null, day),
  })

  if (!decision.allow) {
    const devOnly = decision.reasons.length === 1 && decision.reasons[0] === 'DEV_STACK'
    await record(ctx, row, {
      decision: devOnly ? 'DEV_SUPPRESSED' : 'SKIPPED',
      reasons: decision.reasons,
      at: nowIso,
      ...(devOnly ? { wouldSend: true } : {}),
    })
    await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_AUTO_SKIPPED', conn.userEmail, { reasons: decision.reasons })
    return
  }
  await autoSendReply(ctx, row)
}

/** The second (and last) place a reply may be sent without the rep pressing Send. */
export async function autoSendReply(ctx: AutoSendCtx, row: SpotRequestRecord): Promise<void> {
  const { deps, conn, port } = ctx
  const at = deps.now().toISOString()
  const day = chicagoDay(at)

  // At-most-once claim: a second poller (or a re-run) sees AUTO_PENDING and skips.
  try {
    await deps.store.updateRequest(row.id, { status: 'AUTO_PENDING' }, { statusIn: ['NEW'] })
  } catch (err) {
    if (err instanceof ConflictError) return
    throw err
  }
  const fail = async (reason: string, status: 'NEW' | 'DRAFTED' = 'NEW', extra: Row = {}): Promise<void> => {
    await record(ctx, row, { decision: 'FAILED', reasons: [], at, error: reason }, { status, ...extra })
  }

  const door = await deps.door({
    spotAutoQuote: {
      requestId: row.id,
      repId: conn.id,
      customerId: row.customerId as string,
      contactEmail: row.contactEmail as string,
      extraction: row.extraction as NonNullable<SpotRequestRecord['extraction']>,
      fieldMeta: (row.fieldMeta ?? {}) as NonNullable<SpotRequestRecord['fieldMeta']>,
      autoReplyAllowed: true,
    },
  }).catch(() => null)
  if (!door) return fail('The quote door could not be reached; nothing was sent.')
  if (!door.ok) {
    await record(ctx, row, { decision: 'SKIPPED', reasons: door.reasons, at }, { status: 'NEW' })
    await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_AUTO_SKIPPED', conn.userEmail, { reasons: door.reasons })
    return
  }

  const quoteRefs = { quoteId: door.quoteId, quoteNumber: door.quoteNumber, quoteStatus: 'QUOTED' }
  const quote = await deps.store.getQuote(door.quoteId)
  const repSettings = resolveRepSettings(conn.settings)
  let reply
  try {
    if (!quote || quote.spotRequestId !== row.id) throw new Error('The quote the door returned does not belong to this request.')
    reply = await buildReply(deps, port, row, quote, repSettings)
  } catch (err) {
    return fail(`Quote ${door.quoteNumber} was created but the reply could not be built: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`, 'NEW', quoteRefs)
  }

  try {
    await port.sendReply(reply)
  } catch {
    // The quote exists and nothing went out: leave a draft for the rep instead.
    try {
      const draft = await port.createDraft(reply)
      await record(ctx, row, { decision: 'FAILED', reasons: [], at, error: 'Auto-send failed — draft ready' }, {
        status: 'DRAFTED', ...quoteRefs, draftId: draft.draftId, draftMessageId: draft.messageId, draftedAt: at,
      })
    } catch {
      await fail('Auto-send failed and the draft could not be created.', 'NEW', quoteRefs)
    }
    return
  }

  await record(ctx, row, { decision: 'SENT', reasons: [], at }, {
    status: 'SENT', sentVia: 'AUTO', sentAt: at, ...quoteRefs,
  })
  const prior = conn.autoSendDay === day ? conn.autoSendCount ?? 0 : 0
  await deps.store.updateConnection(conn.id, { autoSendDay: day, autoSendCount: prior + 1 })
  conn.autoSendDay = day
  conn.autoSendCount = prior + 1
  await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_AUTO_SENT', conn.userEmail, { quoteId: door.quoteId })
  try {
    await deps.crm.addSystemActivity({
      customerId: row.customerId ?? undefined,
      contactEmail: row.contactEmail ?? undefined,
      ownerId: conn.id,
      kind: 'QUOTE_SENT',
      at,
      subject: (row.subject ?? '').slice(0, 120) || undefined,
      refs: { spotRequestId: row.id, quoteId: door.quoteId, gmailThreadId: row.gmailThreadId || undefined },
    })
  } catch (err) {
    console.warn('[tms-spot-quoter] crm activity write failed:', String(err))
  }
}
