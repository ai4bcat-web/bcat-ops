/**
 * Step AI — the dashboard actions of the `tmsCrmActions` router (no new Lambda, no new mutation).
 *
 *   PREVIEW_DASHBOARD_CHAT  { messages, scope|null, draft|null }        -> DashChatResult   (creators; the only model call)
 *   PREVIEW_DASHBOARD       { spec } | { id } | { builtin:'OVERVIEW' }  -> DashRunResult    (+ optional window override)
 *   LIST_DASHBOARDS         {}                                          -> { company, mine }
 *   GET_DASHBOARD           { id }                                      -> { dashboard, canEdit }
 *   GET_DASHBOARD_OPTIONS   {}                                          -> DashOptions
 *   SAVE_DASHBOARD          { id?, spec, sharedWith?, expectedVersion? } -> DashboardRecord (creators; COMPANY needs publish)
 *   ARCHIVE_DASHBOARD       { id, expectedVersion }                     -> { id, archivedAt } (owner or ADMIN)
 *
 * Read verbs first (apiClient classifies READ_ROUTER_ACTION by prefix). Every action needs the
 * door (owner || ADMIN || page-tms). Data visibility is the CALLER's, enforced in one
 * VisibleReader per request; `scope` and `sharedWith` decide only who may OPEN a dashboard.
 */
import { randomUUID } from 'node:crypto'
import { QUERY_CATALOG, QUERY_IDS } from '../../../src/lib/dashboards/catalog'
import { OVERVIEW_SPEC } from '../../../src/lib/dashboards/builtin'
import { CHAT_LIMITS, chatAccessError, parseChatInput } from '../../../src/lib/dashboards/chatProtocol'
import { dashboardAccess } from '../../../src/lib/dashboards/access'
import { runSpec } from '../../../src/lib/dashboards/execute'
import { SPEC_LIMITS, parseSpec } from '../../../src/lib/dashboards/spec'
import type {
  DashOptions,
  DashRunResult,
  DashboardAccess,
  DashboardRecord,
  DashboardScope,
  DashboardSpec,
  DashboardSummary,
} from '../../../src/lib/dashboards/types'
import { makeVisibleReader } from '../../../src/lib/dashboards/visibleReader'
import { canSeeCustomer, dataViewer, type DataViewer } from '../../../src/lib/dataVisibility'
import type { Db, Row } from '../_shared/crmStore'
import { chatTurn, resolveNames } from './dashChat'
import { assistantTurn, parseAssistantInput, type AssistantTools } from './assistant'
import { anthropicAssistantModel, type AssistantModel } from './assistantModel'
import { buildSpecFromModel, type ModelOut } from '../../../src/lib/dashboards/modelSchema'
import { canSeeRow } from '../../../src/lib/dataVisibility'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { anthropicModel, type ModelPort } from './dashModel'
import { dbSource, type DashSource } from './dashSources'
import { CONFLICT_ERROR, MAX_ACTIVE_DASHBOARDS, MAX_PER_OWNER, dashStore, summaryOf, type DashStore, type StoredDashboard } from './dashStore'

export const DASHBOARD_ACTION_NAMES = [
  'PREVIEW_DASHBOARD_CHAT',
  'PREVIEW_ASSISTANT_CHAT',
  'PREVIEW_DASHBOARD',
  'LIST_DASHBOARDS',
  'GET_DASHBOARD',
  'GET_DASHBOARD_OPTIONS',
  'SAVE_DASHBOARD',
  'ARCHIVE_DASHBOARD',
] as const
export type DashboardActionName = (typeof DASHBOARD_ACTION_NAMES)[number]

/**
 * The authorization table. Every action needs the door (owner || ADMIN || page-tms); `create`
 * adds the Create-dashboards permission up front. Per-record rules (audience, ownership,
 * publishCompany for COMPANY, create for an unsaved spec) are enforced in the handlers.
 */
export const DASHBOARD_AUTHZ: Record<DashboardActionName, { create: boolean }> = {
  PREVIEW_DASHBOARD_CHAT: { create: true },
  PREVIEW_ASSISTANT_CHAT: { create: false },
  PREVIEW_DASHBOARD: { create: false },
  LIST_DASHBOARDS: { create: false },
  GET_DASHBOARD: { create: false },
  GET_DASHBOARD_OPTIONS: { create: false },
  SAVE_DASHBOARD: { create: true },
  ARCHIVE_DASHBOARD: { create: false },
}

export const isDashboardAction = (action: string): action is DashboardActionName =>
  (DASHBOARD_ACTION_NAMES as readonly string[]).includes(action)

export interface DashCaller {
  id: string
  email: string
  groups: string[]
  isAdmin: boolean
}

export interface DashDeps {
  source: DashSource
  store: DashStore
  model: ModelPort
  /** The ops assistant's tool-use model (separate port: it takes tools and returns blocks). */
  assistantModel?: AssistantModel
  /** One shipment row by its PRO number (raw, unfiltered: the caller's visibility is applied by the tool). */
  shipmentByNumber?: (number: string) => Promise<Row | null>
  nowMs: () => number
  newId: () => string
}

export type AuditFn = (entityType: string, entityId: string, action: string, changes: Row) => Promise<void>

export function defaultDashDeps(db: Db): DashDeps {
  const table = process.env.DASHBOARD_ROLLUP_TABLE_NAME
  if (!table) throw new Error('DASHBOARD_ROLLUP_TABLE_NAME is not configured')
  return {
    source: dbSource(db),
    store: dashStore(db, table),
    model: anthropicModel(),
    assistantModel: anthropicAssistantModel(),
    shipmentByNumber: async (number) => {
      const shipmentTable = process.env.SHIPMENT_TABLE_NAME
      if (!shipmentTable) throw new Error('SHIPMENT_TABLE_NAME is not configured')
      const out = await db.send(new QueryCommand({
        TableName: shipmentTable,
        IndexName: 'shipmentsByNumber',
        KeyConditionExpression: '#n = :n',
        ExpressionAttributeNames: { '#n': 'number' },
        ExpressionAttributeValues: { ':n': number },
        Limit: 5,
      }))
      return (out.Items?.[0] as Row | undefined) ?? null
    },
    nowMs: Date.now,
    newId: randomUUID,
  }
}

/** Total time a data run may take (AppSync cuts at 30 s). */
const RUN_BUDGET_MS = 24_000
const NOT_FOUND = 'Dashboard not found'
const norm = (s: string | null | undefined): string => (typeof s === 'string' ? s.trim().toLowerCase() : '')

interface Ctx {
  caller: DashCaller
  deps: DashDeps
  audit: AuditFn
  access: DashboardAccess
  viewer: DataViewer
}

// ── Audience (who may OPEN a dashboard) — separate from data visibility ──────

type AudienceRow = Pick<DashboardSummary, 'ownerId' | 'scope' | 'sharedWith'> & { archivedAt?: string | null }

function inAudience(ctx: Ctx, rec: AudienceRow): boolean {
  if (rec.archivedAt) return false
  if (ctx.caller.isAdmin || norm(rec.ownerId) === norm(ctx.caller.id)) return true
  if (rec.scope === 'COMPANY') return true
  const users = rec.sharedWith.userIds.map(norm)
  if (users.includes(norm(ctx.caller.id)) || users.includes(norm(ctx.caller.email))) return true
  return rec.sharedWith.teamKeys.some((k) => ctx.viewer.teamKeys.has(k.trim().toUpperCase()))
}

const isOwner = (ctx: Ctx, rec: { ownerId: string }): boolean => norm(rec.ownerId) === norm(ctx.caller.id)

/** Owner (with Create) or ADMIN; a COMPANY dashboard additionally needs publishCompany. */
function mayEdit(ctx: Ctx, rec: StoredDashboard): boolean {
  if (ctx.caller.isAdmin) return true
  if (!isOwner(ctx, rec) || !ctx.access.create) return false
  return rec.scope !== 'COMPANY' || ctx.access.publishCompany
}

/** Owner or ADMIN; a COMPANY dashboard additionally needs publishCompany. */
function mayArchive(ctx: Ctx, rec: StoredDashboard): boolean {
  if (ctx.caller.isAdmin) return true
  if (!isOwner(ctx, rec)) return false
  return rec.scope !== 'COMPANY' || ctx.access.publishCompany
}

function toRecord(rec: StoredDashboard): DashboardRecord {
  return { ...summaryOf(rec), spec: rec.spec, specVersion: 1, createdBy: rec.createdBy, updatedBy: rec.updatedBy, archivedAt: rec.archivedAt }
}

// ── Input helpers ────────────────────────────────────────────────────────────

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error('id is required')
  return value.trim()
}

function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('expectedVersion is required')
  return value
}

function parseShared(raw: unknown): { userIds: string[]; teamKeys: string[] } {
  if (raw == null) return { userIds: [], teamKeys: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('sharedWith must be an object')
  const o = raw as Record<string, unknown>
  const list = (v: unknown, name: string, max: number): string[] => {
    if (v == null) return []
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) {
      throw new Error(`sharedWith.${name} must be a list of at most ${max} names`)
    }
    return v.map((x: string) => x.trim())
  }
  return { userIds: list(o.userIds, 'userIds', SPEC_LIMITS.maxUsers), teamKeys: list(o.teamKeys, 'teamKeys', SPEC_LIMITS.maxTeams) }
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)]

/** USERS must be ACTIVE staff, TEAM keys must be ACTIVE teams (checked against the authoritative sources). */
async function checkAudience(ctx: Ctx, userIds: readonly string[], teamKeys: readonly string[]): Promise<void> {
  if (userIds.length) {
    const staff = new Set((await ctx.deps.source.staff()).map((s) => norm(s.id)))
    if (userIds.some((u) => !staff.has(norm(u)))) throw new Error('One of the selected people is not an active user')
  }
  if (teamKeys.length) {
    const teams = new Set((await ctx.deps.source.teams()).filter((t) => t.active !== false).map((t) => t.key.trim().toUpperCase()))
    if (teamKeys.some((k) => !teams.has(k.trim().toUpperCase()))) throw new Error('One of the selected teams is not an active team')
  }
}

function specScopeLists(scope: DashboardScope): { userIds: string[]; teamKeys: string[] } {
  return { userIds: scope.kind === 'USERS' ? scope.userIds : [], teamKeys: scope.kind === 'TEAM' ? scope.teamKeys : [] }
}

// ── Running a spec under the CALLER's visibility ─────────────────────────────

async function run(ctx: Ctx, spec: DashboardSpec): Promise<DashRunResult> {
  const startedAt = ctx.deps.nowMs()
  const { source } = ctx.deps
  const [customers, divisions, staff] = await Promise.all([source.customers(), source.divisions(), source.staff()])
  const customerById = new Map(customers.map((c) => [c.id, c]))
  const reader = makeVisibleReader(source, ctx.viewer, customerById)
  const repNames = new Map<string, string>()
  for (const s of staff) {
    repNames.set(norm(s.id), s.name)
    if (s.email) repNames.set(norm(s.email), s.name)
  }
  const nowIso = new Date(startedAt).toISOString()
  const { results, resolved } = await runSpec(spec, reader, { now: nowIso, deadlineMs: startedAt + RUN_BUDGET_MS, divisions, repNames })
  return {
    results,
    resolved,
    visibility: {
      viewAll: ctx.viewer.viewAll,
      ownedCustomers: customers.filter((c) => canSeeCustomer(ctx.viewer, c)).length,
      teamKeys: [...ctx.viewer.teamKeys].sort(),
    },
    asOf: nowIso,
    ms: ctx.deps.nowMs() - startedAt,
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function previewChat(ctx: Ctx, input: Row): Promise<unknown> {
  const parsed = parseChatInput(input)
  if (!parsed.ok) throw new Error(`Invalid request: ${parsed.issues.slice(0, 3).join('; ')}`)
  const denied = chatAccessError(ctx.access, parsed.input.scope)
  if (denied) throw new Error(denied)
  const scope = parsed.input.scope
  if (scope) {
    const lists = specScopeLists(scope)
    await checkAudience(ctx, lists.userIds, lists.teamKeys)
  }
  const { source } = ctx.deps
  const [customers, divisions, staff] = await Promise.all([source.customers(), source.divisions(), source.staff()])
  const result = await chatTurn(parsed.input, {
    model: ctx.deps.model,
    viewer: ctx.viewer,
    customers,
    divisions,
    staff,
    today: new Date(ctx.deps.nowMs()).toISOString().slice(0, 10),
    nowMs: ctx.deps.nowMs,
  })
  await ctx.audit('Dashboard', 'chat', 'DASHBOARD_CHAT', {
    scope: scope?.kind ?? null,
    messages: parsed.input.messages.length,
    specBuilt: result.spec !== null,
    modelError: result.modelError !== null,
    modelMs: result.modelMs,
  })
  return result
}


// ── Ops assistant (read-only tools under the caller's visibility) ────────────

const SHIPMENT_FACTS = [
  'number', 'status', 'statusChangedAt', 'customerName', 'mode', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
  'deliveredAt', 'loadReviewPushedAt', 'carrierAssignmentStatus', 'holdReason', 'cancelReason', 'tenderRejectReason',
  'voidedAt', 'voidReason', 'source', 'revDivision', 'datPostedAt', 'lastNoticeStatus',
] as const

function assistantTools(ctx: Ctx): AssistantTools {
  return {
    async runQuery(input) {
      const { source } = ctx.deps
      const [customers, divisions, staff] = await Promise.all([source.customers(), source.divisions(), source.staff()])
      const text = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
      const list = (k: string): string[] => (Array.isArray(input[k]) ? (input[k] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 5) : [])
      const queryId = text('queryId')
      if (!(QUERY_IDS as readonly string[]).includes(queryId)) return `Unknown query ${queryId || '(none)'}. Use one of: ${QUERY_IDS.join(', ')}`
      const meta = QUERY_CATALOG[queryId as (typeof QUERY_IDS)[number]]
      const out: ModelOut = {
        reply: '', ready: true, questions: [], title: 'Assistant query', description: '',
        window: text('window'), from: text('from'), to: text('to'),
        divisionNames: list('divisionNames'), customerNames: list('customerNames'), repNames: list('repNames'), modes: list('modes'),
        widgets: [{
          type: meta.types[0]!, title: meta.label, queryId, metric: text('metric'), metrics: list('metrics'),
          groupBy: text('groupBy'), grain: text('grain'), sort: text('sort'),
          limit: typeof input.limit === 'number' ? input.limit : 0, size: 'M',
        }],
      }
      const res = resolveNames(out, {
        model: { complete: async () => '' }, viewer: ctx.viewer, customers, divisions, staff,
        today: new Date(ctx.deps.nowMs()).toISOString().slice(0, 10), nowMs: ctx.deps.nowMs,
      })
      if (res.clarify.length > 0) return `Ambiguous name. Ask the user: ${res.clarify.map((q) => `${q.text} Options: ${q.choices.join(' | ')}`).join(' ')}`
      if (res.resolved.unresolved.length > 0) return res.issues.join('. ')
      const built = buildSpecFromModel(out, { scope: { kind: 'ME' }, divisionCodes: res.divisionCodes, customerIds: res.customerIds, repIds: res.repIds })
      const parsed = parseSpec(built.raw)
      if (!parsed.ok) return `That query is not valid: ${parsed.issues.slice(0, 4).join('; ')}`
      const ran = await run(ctx, parsed.spec)
      return JSON.stringify({ window: ran.resolved, asOf: ran.asOf, results: ran.results.map((r) => (r.ok ? { kind: r.kind, ...r.series } : { error: r.error })) })
    },

    async findShipment(input) {
      const number = typeof input.number === 'string' ? input.number.trim().slice(0, 40) : ''
      if (!number) return 'A shipment number is required.'
      if (!ctx.deps.shipmentByNumber) return 'Shipment lookup is not available.'
      const row = await ctx.deps.shipmentByNumber(number)
      const { source } = ctx.deps
      const customers = row ? await source.customers() : []
      const byId = new Map(customers.map((c) => [c.id, c]))
      // Not found and not visible read the same: neither reveals that the number exists.
      const seen = row && canSeeRow(ctx.viewer, { customerId: (row.customerId as string | null) ?? null, salesRepId: (row.salesRepId as string | null) ?? null }, byId)
      if (!row || !seen) return `No shipment ${number} that you can see.`
      const staff = await source.staff()
      const nameOf = (id: unknown): string | null => (typeof id === 'string' && id ? (staff.find((s) => norm(s.id) === norm(id))?.name ?? null) : null)
      const facts: Record<string, unknown> = {}
      for (const k of SHIPMENT_FACTS) if (row[k] != null && row[k] !== '') facts[k] = row[k]
      facts.salesRep = nameOf(row.salesRepId)
      facts.tracker = nameOf(row.trackerId)
      return JSON.stringify(facts)
    },
  }
}

async function assistantChat(ctx: Ctx, input: Row): Promise<unknown> {
  const parsed = parseAssistantInput(input)
  if (!parsed.ok) throw new Error(`Invalid request: ${parsed.issues.slice(0, 3).join('; ')}`)
  const model = ctx.deps.assistantModel
  if (!model) throw new Error('The assistant is not configured')
  const result = await assistantTurn(parsed.input, {
    model,
    tools: assistantTools(ctx),
    today: new Date(ctx.deps.nowMs()).toISOString().slice(0, 10),
    nowMs: ctx.deps.nowMs,
  })
  await ctx.audit('Assistant', 'chat', 'ASSISTANT_CHAT', {
    messages: parsed.input.messages.length,
    tools: result.toolsUsed,
    modelError: result.modelError !== null,
    ms: result.ms,
  })
  return result
}

async function withWindow(spec: DashboardSpec, window: unknown): Promise<DashboardSpec> {
  if (window == null) return spec
  const parsed = parseSpec({ ...spec, filters: { ...spec.filters, window } })
  if (!parsed.ok) throw new Error(`Invalid window: ${parsed.issues.slice(0, 2).join('; ')}`)
  return parsed.spec
}

async function previewDashboard(ctx: Ctx, input: Row): Promise<DashRunResult> {
  const given = ['spec', 'id', 'builtin'].filter((k) => input[k] != null)
  if (given.length !== 1) throw new Error('Send exactly one of spec, id or builtin')
  let spec: DashboardSpec
  if (input.builtin != null) {
    if (input.builtin !== 'OVERVIEW') throw new Error('Unknown built-in dashboard')
    spec = OVERVIEW_SPEC
  } else if (input.id != null) {
    const rec = await ctx.deps.store.get(requireId(input.id))
    if (!rec || !inAudience(ctx, rec)) throw new Error(NOT_FOUND)
    spec = rec.spec
  } else {
    if (!ctx.access.create) throw new Error('Forbidden: running an unsaved dashboard needs the Create dashboards permission')
    const parsed = parseSpec(input.spec)
    if (!parsed.ok) throw new Error(`Invalid dashboard: ${parsed.issues.slice(0, 3).join('; ')}`)
    spec = parsed.spec
  }
  return run(ctx, await withWindow(spec, input.window))
}

async function listDashboards(ctx: Ctx): Promise<{ company: DashboardSummary[]; mine: DashboardSummary[] }> {
  const index = await ctx.deps.store.index()
  const newestFirst = (a: DashboardSummary, b: DashboardSummary) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  const visible = index.filter((s) => inAudience(ctx, s))
  return {
    company: visible.filter((s) => s.scope === 'COMPANY').sort(newestFirst),
    // Mine = owned, or shared with me by user/team (a COMPANY card lives on its own tab).
    mine: visible.filter((s) => isOwner(ctx, s) || (s.scope !== 'COMPANY' && sharedWithMe(ctx, s))).sort(newestFirst),
  }
}

function sharedWithMe(ctx: Ctx, s: Pick<DashboardSummary, 'sharedWith'>): boolean {
  const users = s.sharedWith.userIds.map(norm)
  return users.includes(norm(ctx.caller.id)) || users.includes(norm(ctx.caller.email)) || s.sharedWith.teamKeys.some((k) => ctx.viewer.teamKeys.has(k.trim().toUpperCase()))
}

async function getDashboard(ctx: Ctx, input: Row): Promise<{ dashboard: DashboardRecord; canEdit: boolean }> {
  const rec = await ctx.deps.store.get(requireId(input.id))
  if (!rec || !inAudience(ctx, rec)) throw new Error(NOT_FOUND)
  return { dashboard: toRecord(rec), canEdit: mayEdit(ctx, rec) }
}

async function dashboardOptions(ctx: Ctx): Promise<DashOptions> {
  const { source } = ctx.deps
  const [divisions, staff, teams, customers] = await Promise.all([source.divisions(), source.staff(), source.teams(), source.customers()])
  const activeTeams = teams.filter((t) => t.active !== false)
  return {
    access: ctx.access,
    divisions: divisions.map((d) => ({ code: d.code, name: d.name, brand: d.brand, parentId: d.parentId })),
    staff: staff.map((s) => ({
      id: s.id,
      name: s.name,
      teamKeys: activeTeams.filter((t) => (t.memberIds ?? []).some((m) => norm(m) === norm(s.id) || norm(m) === norm(s.email))).map((t) => t.key),
    })),
    teams: activeTeams.map((t) => ({ key: t.key, name: t.name })),
    catalog: QUERY_IDS.map((id) => ({ id, label: QUERY_CATALOG[id].label, types: [...QUERY_CATALOG[id].types] })),
    limits: { maxWidgets: SPEC_LIMITS.maxWidgets, maxSpecBytes: SPEC_LIMITS.maxSpecBytes, maxMessages: CHAT_LIMITS.maxMessages },
    visibility: {
      viewAll: ctx.viewer.viewAll,
      ownedCustomers: customers.filter((c) => canSeeCustomer(ctx.viewer, c)).length,
      teamKeys: [...ctx.viewer.teamKeys].sort(),
    },
  }
}

async function saveDashboard(ctx: Ctx, input: Row): Promise<DashboardRecord> {
  if (!ctx.access.create) throw new Error('Forbidden: saving a dashboard needs the Create dashboards permission')
  const parsed = parseSpec(input.spec)
  if (!parsed.ok) throw new Error(`Invalid dashboard: ${parsed.issues.slice(0, 3).join('; ')}`)
  const spec: DashboardSpec = parsed.spec
  if (spec.scope.kind === 'TEAM') spec.scope = { kind: 'TEAM', teamKeys: uniq(spec.scope.teamKeys.map((k) => k.trim().toUpperCase())) }
  if (spec.scope.kind === 'COMPANY' && !ctx.access.publishCompany) {
    throw new Error('Forbidden: company dashboards need the Publish company dashboards permission')
  }

  const extra = parseShared(input.sharedWith)
  const fromScope = specScopeLists(spec.scope)
  const sharedWith =
    spec.scope.kind === 'COMPANY'
      ? { userIds: [], teamKeys: [] }
      : { userIds: uniq([...fromScope.userIds, ...extra.userIds]), teamKeys: uniq([...fromScope.teamKeys, ...extra.teamKeys].map((k) => k.toUpperCase())) }
  await checkAudience(ctx, sharedWith.userIds, sharedWith.teamKeys)

  const now = new Date(ctx.deps.nowMs()).toISOString()
  const staff = await ctx.deps.source.staff()
  if (input.id == null) {
    const index = await ctx.deps.store.index()
    if (index.length >= MAX_ACTIVE_DASHBOARDS) throw new Error(`There are already ${MAX_ACTIVE_DASHBOARDS} dashboards; archive one first`)
    if (index.filter((s) => isOwner(ctx, s)).length >= MAX_PER_OWNER) throw new Error(`You already have ${MAX_PER_OWNER} dashboards; archive one first`)
    const rec: StoredDashboard = {
      id: ctx.deps.newId(),
      title: spec.title,
      scope: spec.scope.kind,
      ownerId: ctx.caller.id,
      ownerName: staff.find((s) => norm(s.id) === norm(ctx.caller.id))?.name ?? ctx.caller.email,
      sharedWith,
      spec,
      specVersion: 1,
      widgetCount: spec.widgets.length,
      createdBy: ctx.caller.id,
      updatedBy: ctx.caller.id,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    await ctx.deps.store.commit(rec, null)
    await ctx.audit('Dashboard', rec.id, 'DASHBOARD_SAVED', { scope: rec.scope, widgets: rec.widgetCount, created: true })
    return toRecord(rec)
  }

  const existing = await ctx.deps.store.get(requireId(input.id))
  if (!existing || !inAudience(ctx, existing)) throw new Error(NOT_FOUND)
  if (!ctx.caller.isAdmin && !isOwner(ctx, existing)) throw new Error('Forbidden: only the owner or an administrator can change this dashboard')
  if ((existing.scope === 'COMPANY' || spec.scope.kind === 'COMPANY') && !ctx.access.publishCompany) {
    throw new Error('Forbidden: company dashboards need the Publish company dashboards permission')
  }
  const expected = expectedVersion(input.expectedVersion)
  if (expected !== existing.version) throw new Error(CONFLICT_ERROR)
  const rec: StoredDashboard = {
    ...existing,
    title: spec.title,
    scope: spec.scope.kind,
    sharedWith,
    spec,
    widgetCount: spec.widgets.length,
    updatedBy: ctx.caller.id,
    version: existing.version + 1,
    updatedAt: now,
  }
  await ctx.deps.store.commit(rec, expected)
  await ctx.audit('Dashboard', rec.id, 'DASHBOARD_SAVED', { scope: rec.scope, widgets: rec.widgetCount, created: false })
  return toRecord(rec)
}

async function archiveDashboard(ctx: Ctx, input: Row): Promise<{ id: string; archivedAt: string }> {
  const rec = await ctx.deps.store.get(requireId(input.id))
  if (!rec || !inAudience(ctx, rec)) throw new Error(NOT_FOUND)
  if (!mayArchive(ctx, rec)) throw new Error('Forbidden: only the owner or an administrator can archive this dashboard')
  const expected = expectedVersion(input.expectedVersion)
  if (expected !== rec.version) throw new Error(CONFLICT_ERROR)
  const archivedAt = new Date(ctx.deps.nowMs()).toISOString()
  const next: StoredDashboard = { ...rec, archivedAt, updatedBy: ctx.caller.id, version: rec.version + 1, updatedAt: archivedAt }
  await ctx.deps.store.commit(next, expected)
  await ctx.audit('Dashboard', rec.id, 'DASHBOARD_ARCHIVED', { scope: rec.scope })
  return { id: rec.id, archivedAt }
}

/** Door check + the authz table, then the handler. */
export async function runDashboardAction(
  action: DashboardActionName,
  caller: DashCaller,
  input: Row,
  deps: DashDeps,
  audit: AuditFn,
): Promise<unknown> {
  if (!caller.isAdmin && !caller.groups.includes('page-tms')) throw new Error('Forbidden: dashboards need owner, ADMIN, or page-tms')
  const access = dashboardAccess({ email: caller.email, groups: caller.groups })
  if (DASHBOARD_AUTHZ[action].create && !access.create) {
    throw new Error('Forbidden: creating dashboards needs the Create dashboards permission')
  }
  const teams = await deps.source.teams()
  const viewer = dataViewer({ id: caller.id, email: caller.email, groups: caller.groups, teams })
  const ctx: Ctx = { caller, deps, audit, access, viewer }
  switch (action) {
    case 'PREVIEW_DASHBOARD_CHAT': return previewChat(ctx, input)
    case 'PREVIEW_ASSISTANT_CHAT': return assistantChat(ctx, input)
    case 'PREVIEW_DASHBOARD': return previewDashboard(ctx, input)
    case 'LIST_DASHBOARDS': return listDashboards(ctx)
    case 'GET_DASHBOARD': return getDashboard(ctx, input)
    case 'GET_DASHBOARD_OPTIONS': return dashboardOptions(ctx)
    case 'SAVE_DASHBOARD': return saveDashboard(ctx, input)
    case 'ARCHIVE_DASHBOARD': return archiveDashboard(ctx, input)
  }
}
