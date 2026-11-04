/**
 * tms-spot-quoter — the AppSync action router (`tmsSpotActions`, plan §9.1).
 *
 * Authz mirrors QUOTE_ACTIONS: owner / ADMIN, or a caller in `page-quotes` / `page-tms`.
 * Ownership of a request is checked on every read and write (`canSeeSpotRequest` for
 * reads, strict owner for writes); a manager or ADMIN can read another rep's request but
 * cannot edit or mark it for them.
 *
 * READ-ONLY MAILBOX (Ryne, 2026-11-04): nothing here sends, drafts or modifies mail — the
 * GmailPort has no such method. The rep gets a suggested response to copy (SPOT_SUGGEST_RESPONSE),
 * logs the copy, and marks Sent / Won / Lost by hand.
 *
 * Audit rows carry ids, reason codes and counts — never message text or tokens.
 */
import { canSeeAccount, canSeeSpotRequest, isManager, viewerFromGroups } from '../../../src/lib/crm/visibility'
import type { CrmViewer } from '../../../src/lib/crm/types'
import type {
  GmailConnectionRecord,
  GmailRepSettings,
  SpotRequestRecord,
  SpotSettingsRecord,
} from '../../../src/types/tms'
import type {
  SpotActionName,
  SpotConnectionView,
  SpotCountView,
  SpotGetRequestResult,
  SpotRequestRow,
  SpotStatusView,
  SpotSuggestedResponse,
} from '../../../src/lib/spot/types'
import { applyRepPatch } from '../../../src/lib/spot/fields'
import { fixtureById } from '../../../src/lib/spot/fixtures'
import {
  DEFAULT_REP_SETTINGS,
  resolveRepSettings,
  resolveSpotSettings,
  validateRepSettings,
  validateSpotSettings,
} from '../../../src/lib/spot/settings'
import type { SimInboxMessage } from '../_shared/gmail/simPort'
import type { SpotDeps } from './deps'
import { loadAiAgents, processManual, ttlFor } from './pipeline'
import { computeSuggestion } from './suggestion'
import { ACTION_BUDGET_MS, ACTION_MIN_REMAINING_MS, pollAll } from './poll'
import { buildSuggestedResponse } from './reply'
import { jsonOf, type Row } from './store'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const PAGE_GROUPS = ['page-quotes', 'page-tms']
const PAGE_SIZE = 100
const MAX_TEXT = 8000
const MAX_DRAFT_TEXT = 600

const ADMIN_ONLY: Record<string, true> = { SPOT_SAVE_SETTINGS: true, SPOT_ADMIN_DISCONNECT: true }
const DEV_ONLY: Record<string, true> = {
  SPOT_CONNECT_SIMULATED: true,
  SPOT_SIM_INJECT: true,
  SPOT_SIM_RESET: true,
  SPOT_SIM_PURGE_TEST: true,
}

export interface AppSyncIdentity {
  sub?: string
  username?: string
  claims?: Record<string, unknown>
}

export interface SpotCaller {
  userId: string
  email: string
  groups: string[]
  isAdmin: boolean
  viewer: CrmViewer
}

function claimString(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = claims?.[key]
  return typeof value === 'string' ? value : undefined
}

function groupsOf(identity: AppSyncIdentity): string[] {
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export function authorize(action: string, identity: AppSyncIdentity | null | undefined): SpotCaller {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const candidates = [claimString(identity.claims, 'email'), identity.username]
  const email = (candidates.find((v): v is string => typeof v === 'string' && v.includes('@')) ?? '').toLowerCase().trim()
  const userId = identity.username ?? claimString(identity.claims, 'cognito:username') ?? identity.sub ?? ''
  if (!email || !userId) throw new Error('Unauthorized: could not resolve caller')
  const groups = groupsOf(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  if (ADMIN_ONLY[action] && !isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  if (!isAdmin && !groups.some((g) => PAGE_GROUPS.includes(g))) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or one of ${PAGE_GROUPS.join(', ')}`)
  }
  return { userId, email, groups, isAdmin, viewer: viewerFromGroups({ id: userId, email, groups }) }
}

// ── Input helpers ────────────────────────────────────────────────────────────

function inputOf(raw: unknown): Row {
  if (raw == null) return {}
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be an object')
  return parsed as Row
}

function requireString(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} is required`)
  if (trimmed.length > max) throw new Error(`${name} is too long`)
  return trimmed
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  if (value.length > max) throw new Error(`${name} is too long (max ${max})`)
  return value
}

// ── Shared pieces ────────────────────────────────────────────────────────────

export function connectionView(conn: GmailConnectionRecord): SpotConnectionView {
  const view: GmailConnectionRecord = { ...conn, settings: resolveRepSettings(conn.settings) }
  delete view.pendingState
  delete view.pendingStateExp
  return view
}

async function settingsRecord(deps: SpotDeps): Promise<SpotSettingsRecord> {
  const row = await deps.store.getSpotSettings()
  return { id: 'default', ...resolveSpotSettings(row), version: row?.version ?? 0, updatedBy: row?.updatedBy ?? null }
}

async function requireConnection(deps: SpotDeps, userId: string): Promise<GmailConnectionRecord> {
  const conn = await deps.store.getConnection(userId)
  if (!conn || conn.status === 'DISCONNECTED') throw new Error('Connect Gmail first.')
  return conn
}

async function ownedRequest(deps: SpotDeps, caller: SpotCaller, id: string): Promise<SpotRequestRecord> {
  const row = await deps.store.getRequest(id)
  if (!row || row.ttlEpoch * 1000 < deps.now().getTime()) throw new Error('Request not found')
  if (row.userId !== caller.userId) {
    if (canSeeSpotRequest(caller.viewer, row)) throw new Error('Forbidden: only the owning rep can change this request')
    throw new Error('Request not found')
  }
  return row
}

function withoutBody(row: SpotRequestRecord): SpotRequestRow {
  const rest: SpotRequestRecord = { ...row }
  delete rest.bodyText
  return rest
}

/** Money state always comes from the Quote: overlay its current status on the row. */
async function withQuoteStatus(deps: SpotDeps, row: SpotRequestRecord): Promise<SpotRequestRecord> {
  if (!row.quoteId) return row
  const quote = await deps.store.getQuote(row.quoteId)
  return quote && typeof quote.status === 'string' ? { ...row, quoteStatus: quote.status } : row
}

async function logCrm(deps: SpotDeps, input: Parameters<SpotDeps['crm']['addSystemActivity']>[0]): Promise<void> {
  try {
    await deps.crm.addSystemActivity(input)
  } catch (err) {
    console.warn('[tms-spot-quoter] crm activity write failed:', String(err))
  }
}

/** Revoke (best effort), delete the token, mark the row; optionally purge stored mail. */
export async function disconnect(
  deps: SpotDeps,
  userId: string,
  actorEmail: string,
  purge: boolean,
  action: 'SPOT_DISCONNECT' | 'SPOT_ADMIN_DISCONNECT',
): Promise<GmailConnectionRecord> {
  const conn = await deps.store.getConnection(userId)
  if (!conn) throw new Error('No connection for that user')
  if (conn.mode === 'GOOGLE') {
    const token = await deps.oauth.getToken(userId).catch(() => null)
    if (token) await deps.oauth.revoke(token.refreshToken)
    await deps.oauth.deleteToken(userId)
  }
  if (purge) await purgeRequests(deps, userId)
  if (purge && conn.mode === 'SIMULATED') await deps.sim.reset(userId)
  const next = await deps.store.updateConnection(userId, {
    status: 'DISCONNECTED',
    disconnectedAt: deps.now().toISOString(),
    historyId: null,
    pendingState: null,
    pendingStateExp: null,
  })
  await deps.store.writeAudit('GMAIL_CONNECTION', userId, action, actorEmail, { purge })
  return next
}

async function purgeRequests(deps: SpotDeps, userId: string): Promise<number> {
  const rows = await deps.store.requestsByUser(userId)
  for (const row of rows) await deps.store.deleteRequest(row.id)
  await deps.crm.purgeEmailSubjects(userId)
  return rows.length
}

// ── Handlers ─────────────────────────────────────────────────────────────────

type Handler = (deps: SpotDeps, caller: SpotCaller, input: Row) => Promise<unknown>

async function status(deps: SpotDeps, caller: SpotCaller): Promise<SpotStatusView> {
  const modes = await deps.providerModes()
  const conn = await deps.store.getConnection(caller.userId)
  return {
    devStack: deps.devStack,
    gmailProvider: { mode: modes.gmail, health: null },
    datProvider: { mode: modes.dat },
    connection: conn ? connectionView(conn) : null,
    settings: await settingsRecord(deps),
  }
}

async function allowedDomainOf(deps: SpotDeps): Promise<string> {
  const row = await deps.store.getIntegration('GMAIL_REP_OAUTH')
  const settings = row ? jsonOf<Row>(row.settings) : null
  const value = settings?.allowedDomain
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

const oauthStart: Handler = async (deps, caller, input) => {
  const redirectUri = requireString(input.redirectUri, 'redirectUri', 500)
  const client = await deps.oauth.readClient().catch(() => null)
  if (!client) throw new Error('NOT_CONFIGURED: Gmail sign-in is not set up yet. An admin adds the Google OAuth client under Settings → Integrations.')
  if (!deps.oauth.redirectUriAllowed(redirectUri, deps.portalOrigins)) throw new Error('That redirect address is not allowed.')
  const state = deps.oauth.newState()
  const exp = new Date(deps.now().getTime() + 10 * 60_000).toISOString()
  const existing = await deps.store.getConnection(caller.userId)
  if (existing) {
    const reopen = existing.status === 'DISCONNECTED'
    await deps.store.updateConnection(caller.userId, {
      pendingState: state,
      pendingStateExp: exp,
      ...(reopen ? { status: 'PENDING', mode: 'GOOGLE' } : {}),
    })
  } else {
    await deps.store.putConnection({
      id: caller.userId,
      userEmail: caller.email,
      mode: 'GOOGLE',
      status: 'PENDING',
      pendingState: state,
      pendingStateExp: exp,
      settings: { ...DEFAULT_REP_SETTINGS },
      version: 1,
    })
  }
  const hd = await allowedDomainOf(deps)
  return {
    url: deps.oauth.buildAuthUrl({ clientId: client.clientId, redirectUri, state, loginHint: caller.email, ...(hd ? { hd } : {}) }),
  }
}

const oauthFinish: Handler = async (deps, caller, input) => {
  const code = requireString(input.code, 'code', 2000)
  const state = requireString(input.state, 'state', 200)
  const redirectUri = requireString(input.redirectUri, 'redirectUri', 500)
  if (!deps.oauth.redirectUriAllowed(redirectUri, deps.portalOrigins)) throw new Error('That redirect address is not allowed.')
  const conn = await deps.store.getConnection(caller.userId)
  const expired = !conn?.pendingStateExp || new Date(conn.pendingStateExp).getTime() < deps.now().getTime()
  if (!conn || !conn.pendingState || conn.pendingState !== state || expired) {
    throw new Error('This sign-in link is not valid or has expired. Start again.')
  }
  // Single use: the state is spent whether or not the rest succeeds.
  await deps.store.updateConnection(caller.userId, { pendingState: null, pendingStateExp: null })

  const client = await deps.oauth.readClient()
  if (!client) throw new Error('NOT_CONFIGURED: Gmail sign-in is not set up yet.')
  const exchange = await deps.oauth.exchangeCode({ clientId: client.clientId, clientSecret: client.clientSecret, code, redirectUri })
  if (!exchange.refreshToken || !deps.oauth.hasRequiredScopes(exchange.scope)) {
    throw new Error('Google did not grant read and compose access; connect again and tick every box.')
  }
  if (!exchange.idToken) throw new Error('Google returned no identity for this sign-in.')
  const identity = deps.oauth.parseIdToken(exchange.idToken)
  const profile = await deps.store.getUserProfile(caller.userId)
  const expectedEmail = String(profile?.email ?? caller.email).toLowerCase()
  if (!identity.emailVerified || identity.email !== expectedEmail) {
    throw new Error('You can only connect your own mailbox. Sign in with the Google account that matches your BCAT e-mail.')
  }
  const allowed = await allowedDomainOf(deps)
  if (allowed && identity.hd !== allowed) throw new Error(`Only ${allowed} accounts can be connected.`)

  const at = deps.now().toISOString()
  await deps.oauth.putToken(caller.userId, {
    refreshToken: exchange.refreshToken,
    scope: exchange.scope,
    googleEmail: identity.email,
    obtainedAt: at,
  })
  const historyId = await deps.portFor({ id: caller.userId, mode: 'GOOGLE' }).profile().then((p) => p.historyId).catch(() => null)
  const next = await deps.store.updateConnection(caller.userId, {
    mode: 'GOOGLE',
    status: 'CONNECTED',
    googleEmail: identity.email,
    scopes: exchange.scope.split(/\s+/).filter(Boolean),
    connectedAt: at,
    disconnectedAt: null,
    historyId,
    lastError: null,
    settings: resolveRepSettings(conn.settings),
  })
  await deps.store.writeAudit('GMAIL_CONNECTION', caller.userId, 'SPOT_CONNECTED', caller.email, { mode: 'GOOGLE' })
  return { connection: connectionView(next) }
}

const connectSimulated: Handler = async (deps, caller) => {
  const at = deps.now().toISOString()
  const existing = await deps.store.getConnection(caller.userId)
  const base = {
    mode: 'SIMULATED' as const,
    status: 'CONNECTED' as const,
    googleEmail: `${caller.email} (simulated)`,
    scopes: [] as string[],
    connectedAt: at,
    disconnectedAt: null,
    historyId: null,
    lastError: null,
    pendingState: null,
    pendingStateExp: null,
  }
  if (existing) {
    const next = await deps.store.updateConnection(caller.userId, { ...base, settings: resolveRepSettings(existing.settings) })
    await deps.store.writeAudit('GMAIL_CONNECTION', caller.userId, 'SPOT_CONNECTED', caller.email, { mode: 'SIMULATED' })
    return { connection: connectionView(next) }
  }
  const row: GmailConnectionRecord = { id: caller.userId, userEmail: caller.email, ...base, settings: { ...DEFAULT_REP_SETTINGS }, version: 1 }
  await deps.store.putConnection(row)
  await deps.store.writeAudit('GMAIL_CONNECTION', caller.userId, 'SPOT_CONNECTED', caller.email, { mode: 'SIMULATED' })
  return { connection: connectionView(row) }
}

const setPaused: Handler = async (deps, caller, input) => {
  if (typeof input.paused !== 'boolean') throw new Error('paused must be true or false')
  const conn = await requireConnection(deps, caller.userId)
  if (conn.status !== 'CONNECTED' && conn.status !== 'PAUSED') throw new Error('This connection cannot be paused right now.')
  const next = await deps.store.updateConnection(caller.userId, { status: input.paused ? 'PAUSED' : 'CONNECTED' })
  await deps.store.writeAudit('GMAIL_CONNECTION', caller.userId, input.paused ? 'SPOT_PAUSED' : 'SPOT_RESUMED', caller.email, {})
  return { connection: connectionView(next) }
}

const saveMySettings: Handler = async (deps, caller, input) => {
  const conn = await requireConnection(deps, caller.userId)
  const checked = validateRepSettings(input.settings)
  if (!checked.ok) throw new Error(checked.error)
  const current = resolveRepSettings(conn.settings)
  const merged: GmailRepSettings = { ...current, ...checked.value }
  const expected = typeof input.expectedVersion === 'number' ? input.expectedVersion : undefined
  const next = await deps.store.updateConnection(caller.userId, { settings: merged }, expected)
  return { connection: connectionView(next) }
}

const pollNow: Handler = async (deps, caller, input) => {
  let scope: { userId?: string }
  if (input.all === true || typeof input.userId === 'string') {
    if (!caller.isAdmin) throw new Error('Forbidden: only an admin can poll another rep or everyone')
    scope = input.all === true ? {} : { userId: requireString(input.userId, 'userId', 200) }
  } else {
    const conn = await requireConnection(deps, caller.userId)
    if (conn.status !== 'CONNECTED') throw new Error('This connection is not active; resume or reconnect it first.')
    scope = { userId: caller.userId }
  }
  const result = await pollAll(deps, scope, ACTION_BUDGET_MS, ACTION_MIN_REMAINING_MS)
  // `partial`: time ran out first; polling again continues (the cursor was held).
  return { stats: result.stats, partial: result.skipped > 0 || Boolean(result.stats.deferred) }
}

function targetUserOf(caller: SpotCaller, input: Row): string {
  const asked = typeof input.userId === 'string' && input.userId ? input.userId : caller.userId
  if (asked !== caller.userId && !isManager(caller.viewer)) throw new Error('Forbidden: managers only')
  return asked
}

const listRequests: Handler = async (deps, caller, input) => {
  const userId = targetUserOf(caller, input)
  const wanted = typeof input.status === 'string' ? input.status : null
  const nowMs = deps.now().getTime()
  const all = (await deps.store.requestsByUser(userId)).filter((r) => r.ttlEpoch * 1000 >= nowMs && (!wanted || r.status === wanted))
  const offset = typeof input.cursor === 'string' && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0
  const page = all.slice(offset, offset + PAGE_SIZE)
  const rows = await Promise.all(page.map(async (r) => withoutBody(await withQuoteStatus(deps, r))))
  return { rows, cursor: offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : null }
}

const getRequest: Handler = async (deps, caller, input): Promise<SpotGetRequestResult | null> => {
  const id = requireString(input.id, 'id', 300)
  const found = await deps.store.getRequest(id)
  if (!found || found.ttlEpoch * 1000 < deps.now().getTime()) return null
  if (!canSeeSpotRequest(caller.viewer, found)) throw new Error('Request not found')

  return { request: await withQuoteStatus(deps, found) }
}

const count: Handler = async (deps, caller, input): Promise<SpotCountView> => {
  const userId = targetUserOf(caller, input)
  const nowMs = deps.now().getTime()
  const rows = (await deps.store.requestsByUser(userId)).filter((r) => r.ttlEpoch * 1000 >= nowMs)
  const closed = ['DISMISSED', 'WON', 'LOST']
  return {
    new: rows.filter((r) => r.status === 'NEW').length,
    needsInfo: rows.filter((r) => r.status === 'NEEDS_INFO').length,
    needsAttention: rows.filter((r) => r.needsAttention === true && !closed.includes(r.status)).length,
  }
}

const addManual: Handler = async (deps, caller, input) => {
  const text = requireString(input.text, 'text', MAX_TEXT)
  const conn = await deps.store.getConnection(caller.userId)
  const request = await processManual(
    deps,
    {
      conn: conn && conn.status !== 'DISCONNECTED' ? conn : null,
      userId: caller.userId,
      settings: resolveSpotSettings(await deps.store.getSpotSettings()),
      aiAgents: await loadAiAgents(deps),
    },
    {
      text,
      subject: optionalString(input.subject, 'subject', 200),
      fromEmail: optionalString(input.fromEmail, 'fromEmail', 200),
      fromName: optionalString(input.fromName, 'fromName', 200),
      devExtraction: deps.devStack && input.devExtraction && typeof input.devExtraction === 'object'
        ? (input.devExtraction as Parameters<typeof processManual>[2]['devExtraction'])
        : undefined,
    },
  )
  return { request }
}

const updateFields: Handler = async (deps, caller, input) => {
  const requestId = requireString(input.requestId, 'requestId', 300)
  if (typeof input.expectedVersion !== 'number') throw new Error('expectedVersion is required')
  if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) throw new Error('patch must be an object')
  const row = await ownedRequest(deps, caller, requestId)
  if (!row.extraction) throw new Error('This request has nothing to edit.')
  const applied = applyRepPatch(row.extraction, row.fieldMeta ?? {}, input.patch as Row)
  const flips = row.status === 'NEW' || row.status === 'NEEDS_INFO'
  const request = await deps.store.updateRequest(
    row.id,
    {
      extraction: applied.extraction,
      fieldMeta: applied.fieldMeta,
      missingFields: applied.missingFields,
      suggestion: await computeSuggestion(deps, { extraction: applied.extraction, customerId: row.customerId }),
      ...(flips ? { status: applied.status } : {}),
    },
    { expectedVersion: input.expectedVersion },
  )
  return { request }
}

const setCustomer: Handler = async (deps, caller, input) => {
  const requestId = requireString(input.requestId, 'requestId', 300)
  const customerId = requireString(input.customerId, 'customerId', 200)
  const row = await ownedRequest(deps, caller, requestId)
  const customer = await deps.store.getCustomer(customerId)
  if (!customer) throw new Error('Customer not found')
  if (!canSeeAccount(caller.viewer, customer)) throw new Error('That customer is assigned to another rep.')
  const email = (row.contactEmail ?? row.replyTo ?? row.fromEmail ?? '').trim().toLowerCase()
  if (email) {
    await deps.crm.upsertContact({
      email,
      customerId,
      name: optionalString(input.contactName, 'contactName', 200) ?? row.fromName ?? undefined,
      ownerId: caller.userId,
      source: 'SPOT_REQUEST',
    })
  }
  const request = await deps.store.updateRequest(row.id, {
    customerId,
    matchHow: 'EMAIL',
    suggestion: await computeSuggestion(deps, { extraction: row.extraction, customerId }),
  })
  await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_SET_CUSTOMER', caller.email, { customerId })
  return { request }
}

/** The quote a rep names must be this request's own SELL quote; returns it, or null when none was named. */
async function ownQuote(deps: SpotDeps, row: SpotRequestRecord, quoteId: string | undefined): Promise<Row | null> {
  if (!quoteId) return null
  const quote = await deps.store.getQuote(quoteId)
  if (!quote || quote.spotRequestId !== row.id) throw new Error('That quote does not belong to this request.')
  if (quote.side !== 'SELL') throw new Error('Only a customer (sell) quote can be answered.')
  return quote
}

/** Remembers the request's quote pointer (money state itself always comes from the Quote). */
function quotePointer(quote: Row | null): Row {
  if (!quote) return {}
  return {
    quoteId: String(quote.id),
    quoteNumber: typeof quote.quoteNumber === 'string' ? quote.quoteNumber : null,
    quoteStatus: typeof quote.status === 'string' ? quote.status : null,
  }
}

const suggestResponse: Handler = async (deps, caller, input): Promise<SpotSuggestedResponse> => {
  const requestId = requireString(input.requestId, 'requestId', 300)
  const quoteId = optionalString(input.quoteId, 'quoteId', 200)
  const intro = optionalString(input.intro, 'intro', MAX_DRAFT_TEXT)
  const outro = optionalString(input.outro, 'outro', MAX_DRAFT_TEXT)
  const row = await ownedRequest(deps, caller, requestId)
  if (row.status === 'DISMISSED') throw new Error('This request was dismissed.')
  const quote = await ownQuote(deps, row, quoteId)
  const conn = await deps.store.getConnection(caller.userId)
  const response = buildSuggestedResponse(deps, row, quote, resolveRepSettings(conn?.settings), {
    intro,
    outro,
    googleEmail: conn?.googleEmail,
  })
  if (quote && row.quoteId !== String(quote.id)) await deps.store.updateRequest(row.id, quotePointer(quote))
  return response
}

const logCopied: Handler = async (deps, caller, input) => {
  const requestId = requireString(input.requestId, 'requestId', 300)
  const quoteId = optionalString(input.quoteId, 'quoteId', 200)
  const row = await ownedRequest(deps, caller, requestId)
  const quote = await ownQuote(deps, row, quoteId)
  // No status change: copying a suggestion is not sending it.
  const request = Object.keys(quotePointer(quote)).length ? await deps.store.updateRequest(row.id, quotePointer(quote)) : row
  const at = deps.now().toISOString()
  await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_SUGGESTION_COPIED', caller.email, { quoteId: quote ? String(quote.id) : null })
  await logCrm(deps, {
    customerId: row.customerId ?? undefined,
    contactEmail: row.contactEmail ?? undefined,
    ownerId: caller.userId,
    kind: 'QUOTE_DRAFTED',
    at,
    refs: { spotRequestId: row.id, quoteId: quote ? String(quote.id) : row.quoteId ?? undefined, gmailThreadId: row.gmailThreadId || undefined },
  })
  return { request }
}

const markSent: Handler = async (deps, caller, input) => {
  const requestId = requireString(input.requestId, 'requestId', 300)
  const row = await ownedRequest(deps, caller, requestId)
  if (row.status !== 'NEW' && row.status !== 'NEEDS_INFO') throw new Error('Only a request that has not been answered yet can be marked sent.')
  const at = deps.now().toISOString()
  const request = await deps.store.updateRequest(
    row.id,
    { status: 'SENT', sentAt: at, sentVia: 'APP', needsAttention: false },
    { statusIn: ['NEW', 'NEEDS_INFO'] },
  )
  await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_MARK_SENT', caller.email, { quoteId: row.quoteId ?? null })
  await logCrm(deps, {
    customerId: row.customerId ?? undefined,
    contactEmail: row.contactEmail ?? undefined,
    ownerId: caller.userId,
    kind: 'QUOTE_SENT',
    at,
    refs: { spotRequestId: row.id, quoteId: row.quoteId ?? undefined, gmailThreadId: row.gmailThreadId || undefined },
  })
  return { request }
}

const dismiss: Handler = async (deps, caller, input) => {
  const requestId = requireString(input.requestId, 'requestId', 300)
  const reason = optionalString(input.reason, 'reason', 200)
  const row = await ownedRequest(deps, caller, requestId)
  if (row.status === 'DISMISSED') return { request: row }
  const at = deps.now()
  const settings = resolveSpotSettings(await deps.store.getSpotSettings())
  const request = await deps.store.updateRequest(row.id, {
    status: 'DISMISSED',
    dismissedAt: at.toISOString(),
    dismissedBy: caller.email,
    dismissedReason: reason ?? null,
    needsAttention: false,
    ttlEpoch: ttlFor(at.toISOString(), settings.dismissedRetentionDays),
  })
  await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_DISMISS', caller.email, { hasReason: Boolean(reason) })
  return { request }
}

const markOutcome: Handler = async (deps, caller, input) => {
  const requestId = requireString(input.requestId, 'requestId', 300)
  const row = await ownedRequest(deps, caller, requestId)
  const outcome = input.outcome
  if (outcome !== undefined && outcome !== 'WON' && outcome !== 'LOST') throw new Error('outcome must be WON or LOST')
  const lostReason = optionalString(input.lostReason, 'lostReason', 200)
  if (outcome === 'LOST') {
    // The rep's own call: a request can be lost without any quote at all.
    const request = await deps.store.updateRequest(row.id, { status: 'LOST', needsAttention: false })
    await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_MARK_OUTCOME', caller.email, { outcome: 'LOST', reason: lostReason ?? null, by: 'REP' })
    return { request }
  }
  const quote = row.quoteId ? await deps.store.getQuote(row.quoteId) : null
  if (!quote || quote.spotRequestId !== row.id) throw new Error('This request has no quote of its own to read an outcome from.')
  const qStatus = String(quote.status)
  let patch: Row
  if (qStatus === 'WON') {
    patch = {
      status: 'WON',
      quoteStatus: qStatus,
      shipmentId: typeof quote.shipmentId === 'string' ? quote.shipmentId : null,
      shipmentNumber: typeof quote.shipmentNumber === 'string' ? quote.shipmentNumber : null,
      needsAttention: false,
    }
  } else if (['LOST', 'PASS', 'CANCELED'].includes(qStatus)) {
    patch = { status: 'LOST', quoteStatus: qStatus, needsAttention: false }
  } else {
    throw new Error('The quote is still open.')
  }
  const request = await deps.store.updateRequest(row.id, patch)
  await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_MARK_OUTCOME', caller.email, { outcome: patch.status })
  return { request }
}

const saveSettings: Handler = async (deps, caller, input) => {
  const checked = validateSpotSettings(input.settings)
  if (!checked.ok) throw new Error(checked.error)
  const current = await deps.store.getSpotSettings()
  const merged = { ...resolveSpotSettings(current), ...checked.value }
  const expected = typeof input.expectedVersion === 'number' ? input.expectedVersion : undefined
  const saved = await deps.store.putSpotSettings(
    { id: 'default', ...merged, version: current?.version ?? 0, updatedBy: caller.email },
    expected,
  )
  await deps.store.writeAudit('SPOT_SETTINGS', 'default', 'SPOT_SAVE_SETTINGS', caller.email, { keys: Object.keys(checked.value) })
  return { settings: saved }
}

const adminDisconnect: Handler = async (deps, caller, input) => {
  const userId = requireString(input.userId, 'userId', 200)
  const conn = await disconnect(deps, userId, caller.email, input.purge === true, 'SPOT_ADMIN_DISCONNECT')
  return { connection: connectionView(conn) }
}

// ── Dev-only simulated inbox ─────────────────────────────────────────────────

const simInject: Handler = async (deps, caller, input) => {
  let message: SimInboxMessage
  if (typeof input.fixtureId === 'string') {
    const fixture = fixtureById(input.fixtureId)
    if (!fixture) throw new Error('Unknown fixture')
    const m = fixture.meta
    message = {
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      to: m.to,
      cc: m.cc,
      replyTo: m.replyTo,
      subject: m.subject,
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
      snippet: m.snippet,
      labelIds: m.labelIds,
      headers: m.headers,
      body: fixture.body,
    }
  } else if (input.message && typeof input.message === 'object') {
    const m = input.message as Row
    message = {
      ...(m as unknown as SimInboxMessage),
      from: requireString(m.from, 'message.from', 300),
      subject: requireString(m.subject, 'message.subject', 300),
      body: requireString(m.body, 'message.body', MAX_TEXT),
    }
  } else {
    throw new Error('fixtureId or message is required')
  }
  // Stamp "now": the poller's look-back window is relative to the clock.
  return deps.sim.inject(caller.userId, { ...message, internalDate: String(deps.now().getTime()) })
}

const simReset: Handler = async (deps, caller) => deps.sim.reset(caller.userId)

const simPurgeTest: Handler = async (deps, caller) => {
  const { deleted } = await deps.sim.purgeTest(caller.userId)
  const rows = (await deps.store.requestsByUser(caller.userId)).filter((r) => r.gmailMessageId.startsWith('zz-'))
  for (const row of rows) await deps.store.deleteRequest(row.id)
  return { deleted: deleted + rows.length }
}

const HANDLERS: Record<SpotActionName, Handler> = {
  SPOT_STATUS: (deps, caller) => status(deps, caller),
  SPOT_OAUTH_START: oauthStart,
  SPOT_OAUTH_FINISH: oauthFinish,
  SPOT_CONNECT_SIMULATED: connectSimulated,
  SPOT_DISCONNECT: async (deps, caller, input) => ({
    connection: connectionView(await disconnect(deps, caller.userId, caller.email, input.purge === true, 'SPOT_DISCONNECT')),
  }),
  SPOT_SET_PAUSED: setPaused,
  SPOT_PURGE_MINE: async (deps, caller) => {
    const deleted = await purgeRequests(deps, caller.userId)
    await deps.store.writeAudit('SPOT_REQUEST', caller.userId, 'SPOT_PURGE_MINE', caller.email, { deleted })
    return { deleted }
  },
  SPOT_SAVE_MY_SETTINGS: saveMySettings,
  SPOT_POLL_NOW: pollNow,
  SPOT_LIST_REQUESTS: listRequests,
  SPOT_GET_REQUEST: getRequest,
  SPOT_COUNT: count,
  SPOT_ADD_MANUAL: addManual,
  SPOT_UPDATE_FIELDS: updateFields,
  SPOT_SET_CUSTOMER: setCustomer,
  SPOT_SUGGEST_RESPONSE: suggestResponse,
  SPOT_LOG_COPIED: logCopied,
  SPOT_MARK_SENT: markSent,
  SPOT_DISMISS: dismiss,
  SPOT_MARK_OUTCOME: markOutcome,
  SPOT_SAVE_SETTINGS: saveSettings,
  SPOT_ADMIN_DISCONNECT: adminDisconnect,
  SPOT_SIM_INJECT: simInject,
  SPOT_SIM_RESET: simReset,
  SPOT_SIM_PURGE_TEST: simPurgeTest,
}

export async function dispatch(
  action: string,
  rawInput: unknown,
  identity: AppSyncIdentity | null | undefined,
  deps: SpotDeps,
): Promise<unknown> {
  const handler = (HANDLERS as Record<string, Handler | undefined>)[action]
  if (!handler) throw new Error(`Unknown action: ${action}`)
  const caller = authorize(action, identity)
  if (DEV_ONLY[action] && !deps.devStack) throw new Error(`${action} is only available on the dev stack`)
  return handler(deps, caller, inputOf(rawInput))
}
