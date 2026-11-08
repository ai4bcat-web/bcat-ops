/**
 * Step AG §4 — the AppSync action router (`tmsApInboxActions`). Authz is decided per action by
 * `authorize.ts` (matrix in `src/lib/apInbox/actions.ts`); every write below goes through
 * `apply.ts` / `vendorBill.ts` / `oauth.ts` / `settings.ts` and ends in an AuditLog row.
 *
 * The queue itself is read by the browser straight from the ApInboxItem GSI; there is no LIST action.
 */
import { AP_INBOX_ACTIONS, type ApInboxAction } from '../../../src/lib/apInbox/actions'
import { AP_INBOX_USER_ID } from '../../../src/lib/apInbox/constants'
import type { ApInboxItemRecord, ApInboxTarget } from '../../../src/lib/apInbox/types'
import type { SimInboxMessage } from '../_shared/gmail/simPort'
import { applyHuman, DISMISS_REASONS, dismiss, markCreated, previewLink, revert, type DismissReason } from './apply'
import { authorize, isApInboxAction, type ApCaller, type AppSyncIdentity } from './authorize'
import type { ApInboxDeps } from './contract'
import { connectSimulated, oauthDisconnect, oauthFinish, oauthStart, str } from './oauth'
import { validateConfigPatch } from './settings'
import { runSync } from './sync'
import { createVendorBill, parseVendorBillInput } from './vendorBill'

export type { AppSyncIdentity } from './authorize'

type Row = Record<string, unknown>
type Handler = (deps: ApInboxDeps, caller: ApCaller, input: Row) => Promise<unknown>

const MANUAL_REPEAT_MS = 2 * 60_000
const MANUAL_BUDGET_MS = 20_000
const PICKABLE_FIELDS = ['billNumber', 'billDate', 'dueAt', 'billedCents', 'vendor', 'invoiceNumber', 'invoiceDate', 'dueDate', 'amount']
const TARGET_KINDS: ApInboxTarget['kind'][] = ['CARRIER_BILL', 'LOAD_CARRIER', 'VENDOR_PAYABLE']

function inputOf(raw: unknown): Row {
  if (raw == null) return {}
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be an object')
  return parsed as Row
}

async function itemOf(deps: ApInboxDeps, input: Row): Promise<ApInboxItemRecord> {
  const item = await deps.store.getItem(str(input.itemId, 'itemId', 200))
  if (!item) throw new Error('Queue item not found')
  return item
}

function targetOf(raw: unknown): { kind: ApInboxTarget['kind']; id: string } {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Row
  const kind = t.kind
  if (typeof kind !== 'string' || !TARGET_KINDS.includes(kind as ApInboxTarget['kind'])) throw new Error('target.kind must be CARRIER_BILL, LOAD_CARRIER or VENDOR_PAYABLE')
  return { kind: kind as ApInboxTarget['kind'], id: str(t.id, 'target.id', 200) }
}

/** `{field: boolean}` or `[field, ...]` (every listed field ticked). Anything else is ignored, never trusted. */
function picksOf(raw: unknown): Record<string, boolean> | undefined {
  if (Array.isArray(raw)) {
    // A list means "only these": every other known field is explicitly unticked.
    const ticked = raw.filter((f): f is string => typeof f === 'string')
    return Object.fromEntries([...PICKABLE_FIELDS.map((f) => [f, false] as const), ...ticked.map((f) => [f, true] as const)])
  }
  if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
  return undefined
}

// ── reads ───────────────────────────────────────────────────────────────────

const status: Handler = async (deps) => {
  const [config, state, open, client] = await Promise.all([
    deps.store.getConfig(),
    deps.store.getState(),
    deps.store.listByStatus('NEEDS_REVIEW', { limit: 500 }),
    deps.oauth.readClient().catch(() => null),
  ])
  const { connection } = state
  return {
    config,
    connection: { status: connection.status, googleEmail: connection.googleEmail, connectedAt: connection.connectedAt, lastError: connection.lastError },
    runs: state.runs,
    lastRun: state.runs[0] ?? null,
    openCount: open.length,
    devStack: deps.devStack,
    providerReady: client != null,
    ...(state.gapNote ? { gapNote: state.gapNote } : {}),
  }
}

const previewLinkAction: Handler = async (deps, _caller, input) => previewLink(deps, await itemOf(deps, input), targetOf(input.target))

// ── sync ────────────────────────────────────────────────────────────────────

const syncNow: Handler = async (deps) => {
  if (!deps.devStack) {
    const last = (await deps.store.getState()).runs[0]
    const endedMs = last ? new Date(last.endedAt || last.startedAt).getTime() : 0
    if (last && last.trigger === 'MANUAL' && !last.partial && deps.now().getTime() - endedMs < MANUAL_REPEAT_MS) {
      return { done: true, reviewed: last.reviewed, remaining: 0, cached: true, digest: last }
    }
  }
  const r = await runSync(deps, { trigger: 'MANUAL', budgetMs: MANUAL_BUDGET_MS })
  return { done: r.done, reviewed: r.reviewed, remaining: r.remaining, ...(r.skipped ? { skipped: r.skipped } : {}), digest: r.digest }
}

// ── queue writes ────────────────────────────────────────────────────────────

const link: Handler = async (deps, caller, input) => {
  const expected = input.expectedVersion
  return applyHuman(
    deps,
    await itemOf(deps, input),
    { target: targetOf(input.target), picks: picksOf(input.picks), expectedVersion: typeof expected === 'number' ? expected : undefined },
    caller.email,
  )
}

const markCreatedAction: Handler = async (deps, caller, input) => ({
  item: await markCreated(deps, await itemOf(deps, input), str(input.billId, 'billId', 200), caller.email),
})

const createVendorBillAction: Handler = async (deps, caller, input) =>
  createVendorBill(deps, await itemOf(deps, input), parseVendorBillInput(input), caller.email)

const dismissAction: Handler = async (deps, caller, input) => {
  const reason = input.reason
  if (typeof reason !== 'string' || !(DISMISS_REASONS as readonly string[]).includes(reason)) throw new Error(`reason must be one of ${DISMISS_REASONS.join(', ')}`)
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : undefined
  return { item: await dismiss(deps, await itemOf(deps, input), reason as DismissReason, note, caller.email) }
}

const revertAction: Handler = async (deps, caller, input) => ({ item: await revert(deps, await itemOf(deps, input), caller.email) })

// ── settings + connection ───────────────────────────────────────────────────

const saveSettings: Handler = async (deps, caller, input) => {
  const patch = input.config
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('config is required')
  const expected = typeof input.expectedVersion === 'number' ? input.expectedVersion : (patch as Row).version
  if (typeof expected !== 'number' || !Number.isInteger(expected)) throw new Error('expectedVersion is required')
  const [current, state] = await Promise.all([deps.store.getConfig(), deps.store.getState()])
  if (current.version !== expected) throw new Error('Settings changed elsewhere — reload and try again.')
  const next = validateConfigPatch(patch as Row, current, { devStack: deps.devStack, connection: state.connection })
  if (!(await deps.store.putConfig(next, expected))) throw new Error('Settings changed elsewhere — reload and try again.')
  await deps.store.writeAudit({
    entityType: 'ApInboxItem',
    entityId: 'config',
    action: 'AP_INBOX_SETTINGS_SAVED',
    actor: caller.email,
    changes: { fields: Object.keys(patch as Row).filter((k) => k !== 'version') },
  })
  return { config: await deps.store.getConfig() }
}

// ── simulated mailbox (dev only; authorize enforces) ────────────────────────

const simInject: Handler = async (deps, _caller, input) => {
  const m = (input.message && typeof input.message === 'object' ? input.message : input) as Row
  const attachments = Array.isArray(m.attachments)
    ? (m.attachments as Row[]).map((a) => ({
        name: str(a.name, 'attachment name', 200),
        contentType: str(a.contentType, 'attachment contentType', 100),
        size: typeof a.size === 'number' ? a.size : 0,
        ...(typeof a.dataBase64 === 'string' ? { dataBase64: a.dataBase64 } : {}),
      }))
    : undefined
  const internalDate = m.internalDate == null || m.internalDate === '' ? String(deps.now().getTime()) : String(m.internalDate)
  if (!/^\d{10,16}$/.test(internalDate)) throw new Error('internalDate must be epoch milliseconds')
  const message: SimInboxMessage = {
    ...(typeof m.id === 'string' && m.id ? { id: m.id } : {}),
    internalDate,
    from: str(m.from, 'from', 300),
    subject: typeof m.subject === 'string' ? m.subject.slice(0, 500) : '',
    body: typeof m.body === 'string' ? m.body : '',
    ...(Array.isArray(m.to) ? { to: m.to.filter((t): t is string => typeof t === 'string') } : {}),
    ...(Array.isArray(m.labelIds) ? { labelIds: m.labelIds.filter((t): t is string => typeof t === 'string') } : {}),
    ...(attachments ? { attachments } : {}),
    ...(m.devExtraction !== undefined ? { devExtraction: m.devExtraction } : {}),
  }
  return deps.sim.inject(AP_INBOX_USER_ID, message)
}

const HANDLERS: Record<ApInboxAction, Handler> = {
  AP_INBOX_STATUS: status,
  AP_INBOX_PREVIEW_LINK: previewLinkAction,
  AP_INBOX_SYNC_NOW: syncNow,
  AP_INBOX_LINK: link,
  AP_INBOX_MARK_CREATED: markCreatedAction,
  AP_INBOX_CREATE_VENDOR_BILL: createVendorBillAction,
  AP_INBOX_DISMISS: dismissAction,
  AP_INBOX_REVERT: revertAction,
  AP_INBOX_SAVE_SETTINGS: saveSettings,
  AP_INBOX_OAUTH_START: oauthStart,
  AP_INBOX_OAUTH_FINISH: oauthFinish,
  AP_INBOX_OAUTH_DISCONNECT: (deps, caller) => oauthDisconnect(deps, caller),
  AP_INBOX_CONNECT_SIMULATED: connectSimulated,
  AP_INBOX_SIM_INJECT: simInject,
  AP_INBOX_SIM_RESET: (deps) => deps.sim.reset(AP_INBOX_USER_ID),
  AP_INBOX_SIM_PURGE_TEST: (deps) => deps.sim.purgeTest(AP_INBOX_USER_ID),
}

export async function dispatch(action: string, rawInput: unknown, identity: AppSyncIdentity | null | undefined, deps: ApInboxDeps): Promise<unknown> {
  if (!isApInboxAction(action) || !AP_INBOX_ACTIONS[action]) throw new Error(`Unknown action: ${action}`)
  const caller = await authorize(action, identity, deps.devStack, deps.resolveEmail)
  return HANDLERS[action](deps, caller, inputOf(rawInput))
}
