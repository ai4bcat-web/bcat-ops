/**
 * Step AL — the CS_* actions on the existing `tmsSpotActions` mutation (plan §5.2). Dispatched
 * from `../actions.ts` before AB's PAGE_GROUPS authorize, because that one requires
 * `page-quotes|page-tms` and would lock out a `page-loads`-only carrier rep.
 *
 *   desk (owner / ADMIN / page-loads | page-quotes | page-tms): CS_STATUS, CS_POLL_NOW
 *   admin (owner / ADMIN):  settings, OAuth, disconnect, pause, voice secret rotation
 *   dev only (ADMIN and BCAT_DEV_STACK=true, enforced here in code): CS_CONNECT_SIMULATED, CS_SIM_*
 *
 * Audit rows carry ids and changed key names — never mail content, tokens or secrets.
 */
import { randomBytes } from 'node:crypto'
import {
  CARRIER_INBOX_CALL_FIXTURES,
  CARRIER_INBOX_MAIL_FIXTURES,
} from '../../../../src/lib/carrierInbox/fixtures'
import type { RawInboundModelOutput } from '../../../../src/lib/carrierInbox/normalize'
import {
  CarrierInboxConfigError,
  resolveCarrierInboxConfig,
  validateCarrierInboxConfig,
  withVoiceSecret,
} from '../../../../src/lib/carrierInbox/settings'
import type {
  CarrierInboxMailbox,
  CarrierInboxMailboxState,
  CarrierInboxState,
  CsAction,
  ResolvedCarrierInboxConfig,
} from '../../../../src/lib/carrierInbox/types'
import { CS_ACTIONS } from '../../../../src/lib/carrierInbox/types'
import type { SimInboxMessage } from '../../_shared/gmail/simPort'
import { ConflictError } from '../store'
import { ACTION_BUDGET_MS } from '../poll'
import { csUserId, type CarrierInboxDeps } from './deps'
import { disconnectMailbox, mailboxIdFromState, oauthFinish, oauthStart } from './oauth'
import { budgetOf, emptyCsStats, processCall, type CarrierCallPayload } from './pipeline'
import { parseCallPayload, sha256Hex } from './voice'
import { pollCarrierInbox } from './poll'
import { emptyMailboxState } from './store'

// Mirrors the spot router's own caller rules (a circular import of its constants is avoided).
const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const DESK_GROUPS = ['page-loads', 'page-quotes', 'page-tms']
const MAX_TEXT = 20_000

const DESK_ACTIONS: ReadonlySet<string> = new Set<CsAction>(['CS_STATUS', 'CS_POLL_NOW'])
const DEV_ACTIONS: ReadonlySet<string> = new Set<CsAction>([
  'CS_CONNECT_SIMULATED', 'CS_SIM_INJECT_MAIL', 'CS_SIM_INJECT_CALL', 'CS_SIM_RESET', 'CS_SIM_PURGE_TEST',
])

export interface CsIdentity {
  sub?: string
  username?: string
  claims?: Record<string, unknown>
}

export interface CsCaller { userId: string; email: string; isAdmin: boolean }

type Row = Record<string, unknown>

export function isCsAction(action: string): action is CsAction {
  return (CS_ACTIONS as readonly string[]).includes(action)
}

function groupsOf(identity: CsIdentity): string[] {
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export function csAuthorize(action: string, identity: CsIdentity | null | undefined, devStack: boolean): CsCaller {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const claimEmail = identity.claims?.email
  const candidates = [typeof claimEmail === 'string' ? claimEmail : undefined, identity.username]
  const email = (candidates.find((v): v is string => typeof v === 'string' && v.includes('@')) ?? '').toLowerCase().trim()
  const cognitoUser = identity.claims?.['cognito:username']
  const userId = identity.username ?? (typeof cognitoUser === 'string' ? cognitoUser : undefined) ?? identity.sub ?? ''
  if (!email || !userId) throw new Error('Unauthorized: could not resolve caller')
  const groups = groupsOf(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  if (DEV_ACTIONS.has(action)) {
    if (!isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
    if (!devStack) throw new Error(`${action} is only available on the dev stack`)
  } else if (!DESK_ACTIONS.has(action) && !isAdmin) {
    throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  } else if (DESK_ACTIONS.has(action) && !isAdmin && !groups.some((g) => DESK_GROUPS.includes(g))) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or one of ${DESK_GROUPS.join(', ')}`)
  }
  return { userId, email, isAdmin }
}

function inputOf(raw: unknown): Row {
  if (raw == null) return {}
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be an object')
  return parsed as Row
}

function requireString(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  if (value.length > max) throw new Error(`${name} is too long (max ${max})`)
  return value.trim()
}

// ── Views (nothing secret leaves) ────────────────────────────────────────────

export type CarrierInboxConfigView = Omit<ResolvedCarrierInboxConfig, 'voice'> & {
  voice: Omit<ResolvedCarrierInboxConfig['voice'], 'secretHash'> & { hasSecret: boolean }
}
export type CarrierInboxStateView = Omit<CarrierInboxState, 'mailboxes'> & {
  mailboxes: Record<string, Omit<CarrierInboxMailboxState, 'pendingStateHash' | 'pendingStateExp'>>
}
export interface CarrierInboxStatusView {
  config: CarrierInboxConfigView
  state: CarrierInboxStateView
  devStack: boolean
  gmailProvider: { mode: 'LIVE' | 'STUB' }
}

export function configView(cfg: ResolvedCarrierInboxConfig): CarrierInboxConfigView {
  const { secretHash, ...voice } = cfg.voice
  return { ...cfg, voice: { ...voice, hasSecret: Boolean(secretHash) } }
}

export function stateView(state: CarrierInboxState): CarrierInboxStateView {
  const mailboxes: CarrierInboxStateView['mailboxes'] = {}
  for (const [id, m] of Object.entries(state.mailboxes)) {
    const { pendingStateHash: _h, pendingStateExp: _e, ...rest } = m
    void _h; void _e
    mailboxes[id] = rest
  }
  return { ...state, mailboxes }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadConfig(deps: CarrierInboxDeps): Promise<{ cfg: ResolvedCarrierInboxConfig; stored: boolean }> {
  const raw = await deps.store.getConfigRaw()
  return { cfg: resolveCarrierInboxConfig(raw), stored: raw != null }
}

/** CAS write of an edited config (the version is the stored one, or 0 for a row that does not exist yet). */
async function saveConfig(deps: CarrierInboxDeps, current: { cfg: ResolvedCarrierInboxConfig; stored: boolean }, next: ResolvedCarrierInboxConfig): Promise<ResolvedCarrierInboxConfig> {
  return deps.store.putConfig(next, current.stored ? current.cfg.version : 0)
}

function mailboxOf(cfg: ResolvedCarrierInboxConfig, id: unknown): CarrierInboxMailbox {
  const mailboxId = requireString(id, 'mailboxId', 20)
  const mailbox = cfg.mailboxes.find((m) => m.id === mailboxId)
  if (!mailbox) throw new Error('Unknown mailbox. Save it in Settings first.')
  return mailbox
}

function changedKeys(prev: object, next: object): string[] {
  const a = prev as Row
  const b = next as Row
  return Object.keys({ ...a, ...b }).filter((k) => k !== 'version' && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

type Handler = (deps: CarrierInboxDeps, caller: CsCaller, input: Row) => Promise<unknown>

const status: Handler = async (deps) => {
  const { cfg } = await loadConfig(deps)
  const [state, modes] = await Promise.all([deps.store.getState(), deps.providerModes()])
  return { config: configView(cfg), state: stateView(state), devStack: deps.devStack, gmailProvider: { mode: modes.gmail } } satisfies CarrierInboxStatusView
}

const pollNow: Handler = async (deps, _caller, input) => {
  const mailboxId = typeof input.mailboxId === 'string' && input.mailboxId ? input.mailboxId : undefined
  const r = await pollCarrierInbox(deps, { trigger: 'MANUAL', budgetMs: ACTION_BUDGET_MS, mailboxId })
  return { done: r.done, remaining: r.remaining, polled: r.polled, skipped: r.skipped, reason: r.reason, stats: r.stats }
}

const saveSettings: Handler = async (deps, caller, input) => {
  if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) throw new Error('config must be an object')
  if (typeof input.expectedVersion !== 'number') throw new Error('expectedVersion is required')
  const current = await loadConfig(deps)
  let next: ResolvedCarrierInboxConfig
  try {
    next = validateCarrierInboxConfig({ ...(input.config as Row), version: input.expectedVersion }, current.cfg)
  } catch (err) {
    if (err instanceof CarrierInboxConfigError && err.code === 'CONFLICT') {
      throw new ConflictError('Carrier Sales settings changed since you opened them; reload and try again')
    }
    throw err
  }
  const state = await deps.store.getState()
  const listening = next.mailboxes.some((m) => {
    const st = state.mailboxes[m.id]?.status
    return m.mode === 'SIMULATED' ? st === 'SIMULATED' : st === 'CONNECTED'
  })
  if (next.enabled && !listening && !next.voice.enabled) {
    throw new Error('Connect a mailbox (or enable the voice agent) before switching Carrier Sales on.')
  }
  const saved = await saveConfig(deps, current, next)

  // A removed mailbox, or one pointed at another Google account, loses its grant and its state.
  for (const old of current.cfg.mailboxes) {
    const kept = saved.mailboxes.find((m) => m.id === old.id)
    if (!kept) await disconnectMailbox(deps, old.id, caller.email)
    else if (kept.account !== old.account && old.mode === 'GOOGLE') await disconnectMailbox(deps, old.id, caller.email)
  }
  await deps.writeAudit('CARRIER_INBOX', 'config', 'CS_SAVE_SETTINGS', caller.email, { keys: changedKeys(current.cfg, saved) })
  return { config: configView(saved) }
}

const oauthStartAction: Handler = async (deps, _caller, input) => {
  const { cfg } = await loadConfig(deps)
  return oauthStart(deps, mailboxOf(cfg, input.mailboxId), requireString(input.redirectUri, 'redirectUri', 500))
}

const oauthFinishAction: Handler = async (deps, caller, input) => {
  const state = requireString(input.state, 'state', 200)
  const mailboxId = mailboxIdFromState(state)
  if (!mailboxId) throw new Error('This sign-in link is not valid or has expired. Start again.')
  const { cfg } = await loadConfig(deps)
  return oauthFinish(deps, mailboxOf(cfg, mailboxId), {
    code: requireString(input.code, 'code', 2000),
    state,
    redirectUri: requireString(input.redirectUri, 'redirectUri', 500),
  }, caller.email)
}

const disconnect: Handler = async (deps, caller, input) => {
  const { cfg } = await loadConfig(deps)
  await disconnectMailbox(deps, mailboxOf(cfg, input.mailboxId).id, caller.email)
  return { ok: true }
}

const setPaused: Handler = async (deps, caller, input) => {
  if (typeof input.paused !== 'boolean') throw new Error('paused must be true or false')
  const current = await loadConfig(deps)
  const mailbox = mailboxOf(current.cfg, input.mailboxId)
  const mailboxes = current.cfg.mailboxes.map((m) => (m.id === mailbox.id ? { ...m, paused: input.paused as boolean } : m))
  await saveConfig(deps, current, { ...current.cfg, mailboxes })
  await deps.writeAudit('CARRIER_INBOX', mailbox.id, 'CS_SET_PAUSED', caller.email, { paused: input.paused })
  return { ok: true }
}

const rotateSecret: Handler = async (deps, caller) => {
  const secret = randomBytes(32).toString('base64url')
  const current = await loadConfig(deps)
  await saveConfig(deps, current, withVoiceSecret(current.cfg, sha256Hex(secret), deps.now().toISOString()))
  await deps.writeAudit('CARRIER_INBOX', 'voice', 'CS_VOICE_ROTATE_SECRET', caller.email, {})
  // The plaintext is returned exactly once; only its sha256 is stored.
  return { secret }
}

// ── Dev-only simulated mailbox and calls ─────────────────────────────────────

const connectSimulated: Handler = async (deps, caller, input) => {
  const mailboxId = requireString(input.mailboxId, 'mailboxId', 20)
  if (!/^[A-Za-z0-9_-]+$/.test(mailboxId)) throw new Error('mailboxId may only contain letters, digits, - and _')
  const current = await loadConfig(deps)
  const existing = current.cfg.mailboxes.find((m) => m.id === mailboxId)
  let mailbox: CarrierInboxMailbox
  if (existing) {
    mailbox = { ...existing, mode: 'SIMULATED' }
  } else {
    if (current.cfg.mailboxes.length >= 5) throw new Error('At most 5 mailboxes.')
    mailbox = {
      id: mailboxId, label: 'Simulated inbox', account: `${mailboxId}@example.invalid`,
      addresses: ['loads@example.invalid'], gmailLabel: null, mode: 'SIMULATED', paused: false,
    }
  }
  const mailboxes = existing
    ? current.cfg.mailboxes.map((m) => (m.id === mailboxId ? mailbox : m))
    : [...current.cfg.mailboxes, mailbox]
  await saveConfig(deps, current, { ...current.cfg, mailboxes })
  await deps.store.patchMailboxState(mailboxId, {
    ...emptyMailboxState(),
    status: 'SIMULATED',
    googleEmail: `${mailbox.account} (simulated)`,
    connectedAt: deps.now().toISOString(),
  })
  await deps.writeAudit('CARRIER_INBOX', mailboxId, 'CS_CONNECT_SIMULATED', caller.email, { mailboxId })
  return { ok: true, mailboxId }
}

function simMailbox(cfg: ResolvedCarrierInboxConfig, id: unknown): CarrierInboxMailbox {
  const mailbox = mailboxOf(cfg, id)
  if (mailbox.mode !== 'SIMULATED') throw new Error('That mailbox is not simulated.')
  return mailbox
}

const simInjectMail: Handler = async (deps, _caller, input) => {
  const { cfg } = await loadConfig(deps)
  const mailbox = simMailbox(cfg, input.mailboxId)
  let message: SimInboxMessage
  if (typeof input.fixtureId === 'string') {
    const fixture = CARRIER_INBOX_MAIL_FIXTURES.find((f) => f.id === input.fixtureId)
    if (!fixture) throw new Error('Unknown fixture')
    message = { ...fixture.message, ...(fixture.devExtraction ? { devExtraction: fixture.devExtraction } : {}) }
  } else if (input.message && typeof input.message === 'object' && !Array.isArray(input.message)) {
    const m = input.message as Row
    message = {
      ...(m as unknown as SimInboxMessage),
      from: requireString(m.from, 'message.from', 300),
      subject: requireString(m.subject, 'message.subject', 300),
      body: requireString(m.body, 'message.body', MAX_TEXT),
      ...(input.devExtraction && typeof input.devExtraction === 'object' ? { devExtraction: input.devExtraction } : {}),
    }
  } else {
    throw new Error('fixtureId or message is required')
  }
  // Stamp "now": the poller's look-back window and cursor are relative to the clock.
  return deps.sim.inject(csUserId(mailbox.id), { ...message, internalDate: String(deps.now().getTime()) })
}

const simInjectCall: Handler = async (deps, _caller, input) => {
  const { cfg } = await loadConfig(deps)
  let payload: CarrierCallPayload | string
  let dev: RawInboundModelOutput | null
  if (typeof input.fixtureId === 'string') {
    const fixture = CARRIER_INBOX_CALL_FIXTURES.find((f) => f.id === input.fixtureId)
    if (!fixture) throw new Error('Unknown fixture')
    payload = parseCallPayload(fixture.call, cfg.voice.maxTranscriptChars)
    dev = fixture.devExtraction ?? null
  } else if (input.call && typeof input.call === 'object' && !Array.isArray(input.call)) {
    payload = parseCallPayload(input.call, cfg.voice.maxTranscriptChars)
    dev = input.devExtraction && typeof input.devExtraction === 'object' ? (input.devExtraction as RawInboundModelOutput) : null
  } else {
    throw new Error('fixtureId or call is required')
  }
  if (typeof payload === 'string') throw new Error(payload)
  const state = await deps.store.getState()
  const budget = budgetOf(state, deps.now())
  const before = budget.count
  const stats = emptyCsStats()
  const result = await processCall(deps, cfg, payload, { devExtraction: dev, budget, stats })
  await deps.store.bumpModelCalls(budget.day, budget.count - before)
  await deps.store.patchVoice({ lastCallAt: deps.now().toISOString(), lastError: null })
  return { outcome: result.outcome }
}

function simTargets(cfg: ResolvedCarrierInboxConfig, id: unknown): CarrierInboxMailbox[] {
  if (typeof id === 'string' && id) return [simMailbox(cfg, id)]
  return cfg.mailboxes.filter((m) => m.mode === 'SIMULATED')
}

const simReset: Handler = async (deps) => {
  const { cfg } = await loadConfig(deps)
  let deleted = 0
  for (const m of simTargets(cfg, undefined)) {
    deleted += (await deps.sim.reset(csUserId(m.id))).deleted
    await deps.store.patchMailboxState(m.id, { historyId: null, lastPollAt: null, lastStats: null, held: 0 })
  }
  return { deleted }
}

const simPurgeTest: Handler = async (deps, _caller, input) => {
  const { cfg } = await loadConfig(deps)
  let deleted = 0
  for (const m of simTargets(cfg, input.mailboxId)) deleted += (await deps.sim.purgeTest(csUserId(m.id))).deleted
  return { deleted }
}

const HANDLERS: Record<CsAction, Handler> = {
  CS_STATUS: status,
  CS_SAVE_SETTINGS: saveSettings,
  CS_POLL_NOW: pollNow,
  CS_OAUTH_START: oauthStartAction,
  CS_OAUTH_FINISH: oauthFinishAction,
  CS_DISCONNECT: disconnect,
  CS_SET_PAUSED: setPaused,
  CS_VOICE_ROTATE_SECRET: rotateSecret,
  CS_CONNECT_SIMULATED: connectSimulated,
  CS_SIM_INJECT_MAIL: simInjectMail,
  CS_SIM_INJECT_CALL: simInjectCall,
  CS_SIM_RESET: simReset,
  CS_SIM_PURGE_TEST: simPurgeTest,
}

export async function csDispatch(
  action: string,
  rawInput: unknown,
  identity: CsIdentity | null | undefined,
  deps: CarrierInboxDeps,
): Promise<unknown> {
  if (!isCsAction(action)) throw new Error(`Unknown action: ${action}`)
  const caller = csAuthorize(action, identity, deps.devStack)
  return HANDLERS[action](deps, caller, inputOf(rawInput))
}
