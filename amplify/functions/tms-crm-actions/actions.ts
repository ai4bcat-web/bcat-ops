/**
 * tms-crm-actions — the `tmsCrmActions` router (Step AB §5.4, §5.6, §6.2).
 * Step AI adds the seven dashboard actions (dashboardActions.ts) to this same router.
 *
 * Reads Customer / Quote / Shipment / UserProfile, owns the four Crm tables through
 * `_shared/crmStore.ts`, and enforces visibility on every read and write: reps see the
 * accounts they own (and unowned ones); managers, ADMIN and the owner see all.
 * Audit rows carry ids and counts, never message text.
 */
import { randomUUID } from 'node:crypto'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { planCrmBackfill, type BackfillCustomer } from '../../../src/lib/crm/backfill'
import { isClaimableDomain, normalizeAddress, registrableDomain } from '../../../src/lib/crm/domains'
import { ownerIdsOf, ownerOf } from '../../../src/lib/crm/owner'
import { buildTimeline } from '../../../src/lib/crm/timeline'
import type {
  CrmAccountRecord,
  CrmAccountView,
  CrmActionName,
  CrmActivityRecord,
  CrmContactRecord,
  CrmFollowUpRow,
  CrmListAccountRow,
  CrmViewer,
} from '../../../src/lib/crm/types'
import { canSeeAccount, isManager, viewerFromGroups } from '../../../src/lib/crm/visibility'
import {
  IDX_ACTIVITY_BY_ASSIGNEE,
  activitiesForCustomer,
  activityOut,
  adjustOpenTasks,
  claimDomain,
  contactsForCustomer,
  crmTables,
  domainsForCustomer,
  getAccount,
  getActivity,
  getContact,
  getDomain,
  isConditionalFailure,
  nowIso,
  normalizeInstant,
  patchContact,
  putActivity,
  queryAll,
  readJson,
  releaseDomain,
  scanAll,
  setNextStep,
  touch,
  upsertContact,
  type Db,
  type RawActivity,
  type Row,
} from '../_shared/crmStore'
import { defaultDashDeps, runDashboardAction, type DashDeps, type DashboardActionName } from './dashboardActions'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const PAGE_GROUPS = ['page-customers', 'page-quotes', 'page-tms']
const FOLLOWUP_HORIZON_DAYS = 7
const MS_PER_DAY = 86_400_000
const MAX_SUMMARY = 2000
const MAX_NEXT_STEP = 200

const IDX_QUOTES_BY_CUSTOMER = 'quotesByCustomerIdAndQuoteDate'
const IDX_SHIPMENTS_BY_CUSTOMER = 'shipmentsByCustomerIdAndPickupAppt'

export interface AppSyncIdentity {
  sub?: string
  username?: string
  claims?: Record<string, unknown>
}

export interface Caller {
  id: string
  email: string
  groups: string[]
  isAdmin: boolean
  viewer: CrmViewer
}

const defaultDb: Db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

// ── Environment ──────────────────────────────────────────────────────────────

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

// ── Identity ─────────────────────────────────────────────────────────────────

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

let cognito: CognitoIdentityProviderClient | undefined
async function emailFromPool(username: string): Promise<string> {
  const me = await (cognito ??= new CognitoIdentityProviderClient({})).send(
    new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID ?? '', Username: username }),
  )
  return me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? ''
}

export async function authorize(
  identity: AppSyncIdentity | null | undefined,
  db: Db = defaultDb,
  resolveFromPool: (username: string) => Promise<string> = emailFromPool,
): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const id = identity.username ?? identity.sub ?? ''
  if (!id) throw new Error('Unauthorized: could not resolve caller id')
  let email = (claimString(identity.claims, 'email') ?? (identity.username?.includes('@') ? identity.username : '')).toLowerCase().trim()
  if (!email) {
    const profile = await db.send(new GetCommand({ TableName: env('USER_PROFILE_TABLE_NAME'), Key: { id } }))
    email = String(profile.Item?.email ?? '').toLowerCase().trim()
  }
  if (!email) email = (await resolveFromPool(id).catch(() => '')).toLowerCase().trim()
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = groupsOf(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  if (!isAdmin && !PAGE_GROUPS.some((g) => groups.includes(g))) {
    throw new Error(`Forbidden: CRM requires owner, ADMIN, or one of ${PAGE_GROUPS.join(', ')}`)
  }
  return { id, email, groups, isAdmin, viewer: viewerFromGroups({ id, email, groups }) }
}

// ── Input helpers ────────────────────────────────────────────────────────────

function inputOf(raw: unknown): Row {
  if (raw == null) return {}
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be an object')
  return parsed as Row
}

function requireString(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new Error(`${name} too long`)
  return trimmed
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim().slice(0, maxLength)
}

function requireInstant(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a date`)
  return new Date(Date.parse(value)).toISOString()
}

function requireManager(caller: Caller, action: string): void {
  if (!isManager(caller.viewer)) throw new Error(`Forbidden: ${action} requires a manager, owner, or ADMIN`)
}

// ── Source rows ──────────────────────────────────────────────────────────────

interface CustomerRow extends Row {
  id: string
  name?: string
  status?: string | null
  accountOwnerIds?: string[] | null
  defaultSalesRepId?: string | null
  statusReason?: string | null
  statusChangedAt?: string | null
  statusChangedBy?: string | null
  contacts?: unknown
}

async function getCustomer(db: Db, id: string): Promise<CustomerRow | null> {
  const out = await db.send(new GetCommand({ TableName: env('CUSTOMER_TABLE_NAME'), Key: { id } }))
  return (out.Item as CustomerRow | undefined) ?? null
}

/** Not-found and not-visible read the same to a rep: neither leaks that the id exists. */
async function visibleCustomer(db: Db, caller: Caller, customerId: string): Promise<CustomerRow> {
  const customer = await getCustomer(db, customerId)
  if (!customer || !canSeeAccount(caller.viewer, customer)) throw new Error(`Customer not found: ${customerId}`)
  return customer
}

async function audit(db: Db, caller: Caller, entityType: string, entityId: string, action: string, changes: Row): Promise<void> {
  const table = process.env.AUDIT_LOG_TABLE_NAME
  if (!table) return
  const now = nowIso()
  try {
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          id: randomUUID(),
          __typename: 'AuditLog',
          entityType,
          entityId,
          action,
          user: caller.email,
          changes: JSON.stringify(changes),
          createdAt: now,
          updatedAt: now,
        },
      }),
    )
  } catch (err) {
    console.warn('[tms-crm-actions] audit log write failed:', String(err))
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function listAccounts(db: Db, caller: Caller, input: Row): Promise<{ rows: CrmListAccountRow[] }> {
  const manager = isManager(caller.viewer)
  const onlyMine = manager && input.scope === 'mine'
  const [customers, accounts] = await Promise.all([
    scanAll<CustomerRow>(db, {
      TableName: env('CUSTOMER_TABLE_NAME'),
      ProjectionExpression: 'id, #s, accountOwnerIds, defaultSalesRepId',
      ExpressionAttributeNames: { '#s': 'status' },
    }),
    scanAll<CrmAccountRecord>(db, { TableName: crmTables().account }),
  ])
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const rows: CrmListAccountRow[] = []
  for (const customer of customers) {
    if (!canSeeAccount(caller.viewer, customer)) continue
    if (onlyMine && !ownerIdsOf(customer).includes(caller.id)) continue
    const account = byId.get(customer.id)
    rows.push({
      customerId: customer.id,
      ownerId: ownerOf(customer),
      stage: customer.status ?? null,
      lastTouchAt: account?.lastTouchAt ?? null,
      lastTouchKind: account?.lastTouchKind ?? null,
      nextStep: account?.nextStep ?? null,
      nextStepDueAt: account?.nextStepDueAt ?? null,
      openTaskCount: account?.openTaskCount ?? 0,
    })
  }
  if (input.withActivity === true) {
    const { ar, last } = await activityFor(db, rows.map((r) => r.customerId))
    for (const row of rows) {
      row.openArCents = ar.get(row.customerId) ?? 0
      row.lastShipmentAt = last.get(row.customerId) ?? null
    }
  }
  return { rows }
}

// ── Customers grid: open AR + last shipment (opt-in `withActivity`) ───────────

const IDX_INVOICES_OPEN = 'invoicesByArOpenAndDueAt'
/** In-container cache lifetime for the activity columns. */
export const ACTIVITY_TTL_MS = 60_000
/** Parallel last-shipment Queries in flight at once. */
export const ACTIVITY_CONCURRENCY = 48

interface ActivityCache {
  ar?: { at: number; byCustomer: Map<string, number> }
  lastShipment: Map<string, { at: number; value: string | null }>
}
// Keyed by the client so a test's fake db never sees another test's answers.
const activityCaches = new WeakMap<Db, ActivityCache>()

/** Open balance per customer: ONE paged Query of the sparse `arOpen` index (the whole open book), summed here. */
async function openArByCustomer(db: Db): Promise<Map<string, number>> {
  const invoices = await queryAll<{ customerId?: string; balanceCents?: number }>(db, {
    TableName: env('INVOICE_TABLE_NAME'),
    IndexName: IDX_INVOICES_OPEN,
    KeyConditionExpression: '#o = :open',
    ExpressionAttributeNames: { '#o': 'arOpen' },
    ExpressionAttributeValues: { ':open': 'OPEN' },
    ProjectionExpression: 'customerId, balanceCents',
  }, Number.MAX_SAFE_INTEGER)
  const sums = new Map<string, number>()
  for (const inv of invoices) {
    if (!inv.customerId) continue
    sums.set(inv.customerId, (sums.get(inv.customerId) ?? 0) + (Number(inv.balanceCents) || 0))
  }
  return sums
}

async function lastShipmentOf(db: Db, customerId: string): Promise<string | null> {
  const [row] = await queryAll<{ pickupAppt?: string }>(db, {
    TableName: env('SHIPMENT_TABLE_NAME'),
    IndexName: IDX_SHIPMENTS_BY_CUSTOMER,
    KeyConditionExpression: 'customerId = :c',
    ExpressionAttributeValues: { ':c': customerId },
    ScanIndexForward: false,
    Limit: 1,
    ProjectionExpression: 'pickupAppt',
  }, 1)
  return row?.pickupAppt ? normalizeInstant(row.pickupAppt) : null
}

/**
 * openArCents + lastShipmentAt for exactly the customers the caller may see (the list's
 * visibility filter has already run, so a rep never causes — or sees — another rep's data).
 * Cost: 1 paged open-invoice Query + 1 Limit-1 Shipment Query per visible customer not
 * cached in the last 60 s, run `ACTIVITY_CONCURRENCY` at a time.
 */
async function activityFor(db: Db, customerIds: string[], now = Date.now()): Promise<{ ar: Map<string, number>; last: Map<string, string | null> }> {
  let cache = activityCaches.get(db)
  if (!cache) activityCaches.set(db, (cache = { lastShipment: new Map() }))
  const state = cache
  const arPromise = state.ar && now - state.ar.at < ACTIVITY_TTL_MS
    ? Promise.resolve(state.ar.byCustomer)
    : openArByCustomer(db).then((byCustomer) => { state.ar = { at: now, byCustomer }; return byCustomer })

  const last = new Map<string, string | null>()
  const stale: string[] = []
  for (const id of customerIds) {
    const hit = state.lastShipment.get(id)
    if (hit && now - hit.at < ACTIVITY_TTL_MS) last.set(id, hit.value)
    else stale.push(id)
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < stale.length) {
      const id = stale[next++]
      const value = await lastShipmentOf(db, id)
      state.lastShipment.set(id, { at: now, value })
      last.set(id, value)
    }
  }
  await Promise.all([arPromise, ...Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, stale.length) }, worker)])
  return { ar: await arPromise, last }
}

const EMPTY_VIEW: CrmAccountView = {
  account: null,
  owner: null,
  stage: null,
  contacts: [],
  timeline: [],
  openTasks: [],
  domains: [],
  derived: { lastTouchAt: null, lastQuoteAt: null, lastShipmentAt: null },
  visible: false,
}

async function getAccountView(db: Db, caller: Caller, input: Row): Promise<CrmAccountView> {
  const customerId = requireString(input.customerId, 'customerId')
  const customer = await getCustomer(db, customerId)
  if (!customer) throw new Error(`Customer not found: ${customerId}`)
  if (!canSeeAccount(caller.viewer, customer)) return EMPTY_VIEW

  const [account, activities, contacts, domains, quotes, shipments] = await Promise.all([
    getAccount(db, customerId),
    activitiesForCustomer(db, customerId, 100),
    contactsForCustomer(db, customerId),
    domainsForCustomer(db, customerId),
    queryAll<Row>(db, {
      TableName: env('QUOTE_TABLE_NAME'),
      IndexName: IDX_QUOTES_BY_CUSTOMER,
      KeyConditionExpression: 'customerId = :c',
      ExpressionAttributeValues: { ':c': customerId },
      ScanIndexForward: false,
      Limit: 25,
    }, 25),
    queryAll<Row>(db, {
      TableName: env('SHIPMENT_TABLE_NAME'),
      IndexName: IDX_SHIPMENTS_BY_CUSTOMER,
      KeyConditionExpression: 'customerId = :c',
      ExpressionAttributeValues: { ':c': customerId },
      ScanIndexForward: false,
      Limit: 10,
    }, 10),
  ])

  const activityRecords = activities.map(activityOut)
  const ownerId = ownerOf(customer)
  const ownerRow = ownerId
    ? (await db.send(new GetCommand({ TableName: env('USER_PROFILE_TABLE_NAME'), Key: { id: ownerId } }))).Item
    : null

  const timeline = buildTimeline({
    activities: activityRecords,
    quotes: quotes.map((q) => ({
      id: String(q.id),
      number: (q.number as string | undefined) ?? null,
      side: (q.side as string | undefined) ?? null,
      status: (q.status as string | undefined) ?? null,
      amountCents: (q.amountCents as number | undefined) ?? null,
      createdAt: (q.createdAt as string | undefined) ?? null,
      quoteDate: (q.quoteDate as string | undefined) ?? null,
      sentAt: (q.sentAt as string | undefined) ?? null,
      respondedAt: (q.respondedAt as string | undefined) ?? null,
      wonAt: (q.wonAt as string | undefined) ?? null,
      closedAt: (q.closedAt as string | undefined) ?? null,
    })),
    shipments: shipments.map((s) => ({
      id: String(s.id),
      number: (s.number as string | undefined) ?? null,
      createdAt: (s.createdAt as string | undefined) ?? null,
    })),
    customer,
    viewer: caller.viewer,
  })

  // Contact union: stored CrmContact rows plus Customer.contacts JSON, de-duplicated by e-mail.
  const union = new Map<string, CrmContactRecord & { origin: 'CRM' | 'CUSTOMER_JSON' | 'BOTH' }>()
  for (const contact of contacts) union.set(contact.id, { ...contact, origin: 'CRM' })
  const json = readJson<Record<string, unknown>[]>(customer.contacts) ?? []
  for (const raw of Array.isArray(json) ? json : []) {
    const email = normalizeAddress(typeof raw?.email === 'string' ? raw.email : '')
    if (!email) continue
    const existing = union.get(email)
    if (existing) {
      existing.origin = 'BOTH'
      continue
    }
    union.set(email, {
      id: email,
      customerId,
      name: typeof raw.name === 'string' ? raw.name : null,
      title: typeof raw.title === 'string' ? raw.title : null,
      phone: typeof raw.phone === 'string' ? raw.phone : null,
      source: 'CUSTOMER_JSON',
      status: raw.active === false ? 'ARCHIVED' : 'ACTIVE',
      origin: 'CUSTOMER_JSON',
    })
  }

  const quoteTouches = quotes.flatMap((q) => [q.sentAt, q.respondedAt]).filter((v): v is string => typeof v === 'string')
  const lastTouchAt = [account?.lastTouchAt, ...quoteTouches].filter((v): v is string => !!v).sort().pop() ?? null
  const latest = (values: unknown[]): string | null =>
    (values.filter((v): v is string => typeof v === 'string' && !!v).map((v) => normalizeInstant(v)).sort().pop()) ?? null

  return {
    account,
    owner: ownerRow
      ? { id: String(ownerRow.id), name: (ownerRow.name as string | undefined) ?? null, email: (ownerRow.email as string | undefined) ?? null }
      : ownerId
        ? { id: ownerId, name: null, email: null }
        : null,
    stage: customer.status ?? null,
    contacts: [...union.values()],
    timeline,
    openTasks: activityRecords.filter((a) => a.kind === 'TASK' && !a.doneAt),
    domains,
    derived: {
      lastTouchAt,
      lastQuoteAt: latest(quotes.map((q) => q.sentAt ?? q.createdAt)),
      lastShipmentAt: latest(shipments.map((s) => s.createdAt)),
    },
    visible: true,
  }
}

const MANUAL_KINDS = ['NOTE', 'CALL', 'TEXT']

async function addActivity(db: Db, caller: Caller, input: Row): Promise<{ activity: CrmActivityRecord }> {
  const customerId = requireString(input.customerId, 'customerId')
  await visibleCustomer(db, caller, customerId)
  const kind = input.kind
  if (typeof kind !== 'string' || !MANUAL_KINDS.includes(kind)) throw new Error('kind must be NOTE, CALL, or TEXT')
  const summary = requireString(input.summary, 'summary', MAX_SUMMARY)
  const at = input.at == null ? nowIso() : requireInstant(input.at, 'at')
  const contactEmail = typeof input.contactEmail === 'string' ? normalizeAddress(input.contactEmail) : ''
  const row = await putActivity(db, {
    customerId,
    contactEmail: contactEmail || undefined,
    ownerId: caller.id,
    kind: kind as CrmActivityRecord['kind'],
    at,
    summary,
    createdBy: caller.id,
  })
  await touch(db, { customerId, kind: row.kind, at, by: caller.id })
  return { activity: activityOut(row) }
}

async function addTask(db: Db, caller: Caller, input: Row): Promise<{ activity: CrmActivityRecord }> {
  const customerId = requireString(input.customerId, 'customerId')
  await visibleCustomer(db, caller, customerId)
  const summary = requireString(input.summary, 'summary', MAX_SUMMARY)
  const dueAt = requireInstant(input.dueAt, 'dueAt')
  const assigneeId = optionalString(input.assigneeId, 100) ?? caller.id
  const now = nowIso()
  const row = await putActivity(db, {
    customerId,
    ownerId: caller.id,
    kind: 'TASK',
    at: now,
    summary,
    assigneeId,
    dueAt,
    createdBy: caller.id,
  })
  await adjustOpenTasks(db, customerId, 1, caller.id)
  await touch(db, { customerId, kind: 'TASK', at: now, by: caller.id })
  return { activity: activityOut(row) }
}

async function completeTask(db: Db, caller: Caller, input: Row): Promise<{ activity: CrmActivityRecord }> {
  const id = requireString(input.id, 'id')
  const task = await getActivity(db, id)
  if (!task || task.kind !== 'TASK') throw new Error(`Task not found: ${id}`)
  if (task.customerId) await visibleCustomer(db, caller, task.customerId)
  const mine = task.assigneeId === caller.id || task.ownerId === caller.id
  if (!mine && !isManager(caller.viewer)) throw new Error('Forbidden: only the assignee, the creator, or a manager can complete a task')
  if (task.doneAt) return { activity: activityOut(task) }
  const now = nowIso()
  let updated: RawActivity
  try {
    const out = await db.send(
      new UpdateCommand({
        TableName: crmTables().activity,
        Key: { id },
        UpdateExpression: 'SET doneAt = :now, doneBy = :by, updatedAt = :now, #v = if_not_exists(#v, :zero) + :one',
        ConditionExpression: 'attribute_not_exists(doneAt)',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':now': now, ':by': caller.id, ':zero': 0, ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }),
    )
    updated = out.Attributes as RawActivity
  } catch (err) {
    if (isConditionalFailure(err)) return { activity: activityOut((await getActivity(db, id)) ?? task) }
    throw err
  }
  if (task.customerId) await adjustOpenTasks(db, task.customerId, -1, caller.id)
  return { activity: activityOut(updated) }
}

async function setNextStepAction(db: Db, caller: Caller, input: Row): Promise<{ account: CrmAccountRecord }> {
  const customerId = requireString(input.customerId, 'customerId')
  await visibleCustomer(db, caller, customerId)
  const nextStep = optionalString(input.nextStep, MAX_NEXT_STEP)
  const due = input.nextStepDueAt == null || input.nextStepDueAt === '' ? null : requireInstant(input.nextStepDueAt, 'nextStepDueAt')
  const account = await setNextStep(db, { customerId, nextStep, nextStepDueAt: due, by: caller.id })
  return { account }
}

async function listFollowups(db: Db, caller: Caller, input: Row): Promise<{ rows: CrmFollowUpRow[] }> {
  const manager = isManager(caller.viewer)
  const all = manager && input.scope === 'all'
  const now = Date.now()
  const cutoff = new Date(now + FOLLOWUP_HORIZON_DAYS * MS_PER_DAY).toISOString()
  const nowStamp = new Date(now).toISOString()

  const [accounts, rawTasks] = await Promise.all([
    scanAll<CrmAccountRecord>(db, {
      TableName: crmTables().account,
      FilterExpression: 'attribute_exists(nextStepDueAt) AND nextStepDueAt <= :cutoff',
      ExpressionAttributeValues: { ':cutoff': cutoff },
    }),
    all
      ? scanAll<RawActivity>(db, {
          TableName: crmTables().activity,
          FilterExpression: 'kind = :t AND attribute_not_exists(doneAt) AND dueAt <= :cutoff',
          ExpressionAttributeValues: { ':t': 'TASK', ':cutoff': cutoff },
        })
      : queryAll<RawActivity>(db, {
          TableName: crmTables().activity,
          IndexName: IDX_ACTIVITY_BY_ASSIGNEE,
          KeyConditionExpression: 'assigneeId = :a AND dueAt <= :cutoff',
          FilterExpression: 'kind = :t AND attribute_not_exists(doneAt)',
          ExpressionAttributeValues: { ':a': caller.id, ':t': 'TASK', ':cutoff': cutoff },
        }),
  ])

  const tasksByCustomer = new Map<string, CrmActivityRecord[]>()
  for (const raw of rawTasks) {
    if (!raw.customerId) continue
    const list = tasksByCustomer.get(raw.customerId) ?? []
    list.push(activityOut(raw))
    tasksByCustomer.set(raw.customerId, list)
  }
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const customerIds = new Set<string>([...accountById.keys(), ...tasksByCustomer.keys()])

  const rows: CrmFollowUpRow[] = []
  for (const customerId of customerIds) {
    const customer = await getCustomer(db, customerId)
    if (!customer || !canSeeAccount(caller.viewer, customer)) continue
    const account = accountById.get(customerId)
    const tasks = (tasksByCustomer.get(customerId) ?? []).sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))
    const ownerId = ownerOf(customer)
    const ownsIt = ownerIdsOf(customer).includes(caller.id) || account?.nextStepBy === caller.id
    const showStep = !!account && (all || ownsIt)
    if (!showStep && tasks.length === 0) continue
    const nextStepDueAt = showStep ? account?.nextStepDueAt ?? null : null
    rows.push({
      customerId,
      customerName: (customer.name as string | undefined) ?? null,
      ownerId,
      nextStep: showStep ? account?.nextStep ?? null : null,
      nextStepDueAt,
      openTasks: tasks,
      overdue: (!!nextStepDueAt && nextStepDueAt < nowStamp) || tasks.some((t) => !!t.dueAt && t.dueAt < nowStamp),
    })
  }
  const earliest = (r: CrmFollowUpRow) =>
    [r.nextStepDueAt, ...r.openTasks.map((t) => t.dueAt)].filter((v): v is string => !!v).sort()[0] ?? '9999'
  rows.sort((a, b) => (a.overdue === b.overdue ? earliest(a).localeCompare(earliest(b)) : a.overdue ? -1 : 1))
  return { rows }
}

async function upsertContactAction(db: Db, caller: Caller, input: Row): Promise<{ contact: CrmContactRecord }> {
  const customerId = requireString(input.customerId, 'customerId')
  await visibleCustomer(db, caller, customerId)
  const email = normalizeAddress(requireString(input.email, 'email'))
  if (!email) throw new Error('email is not a valid address')
  const existing = await getContact(db, email)
  if (existing?.customerId && existing.customerId !== customerId) {
    const other = await getCustomer(db, existing.customerId)
    if (other && !canSeeAccount(caller.viewer, other)) throw new Error('That contact belongs to an account you cannot see')
  }
  let contact = await upsertContact(db, {
    email,
    customerId,
    name: optionalString(input.name, 120) ?? undefined,
    ownerId: caller.id,
    source: 'MANUAL',
  })
  const title = optionalString(input.title, 60)
  const phone = optionalString(input.phone, 60)
  if (title || phone) contact = await patchContact(db, email, { title, phone }, caller.id)
  return { contact }
}

async function claimDomainAction(db: Db, caller: Caller, input: Row): Promise<{ domain?: unknown; removed?: boolean }> {
  const customerId = requireString(input.customerId, 'customerId')
  await visibleCustomer(db, caller, customerId)
  const domain = registrableDomain(requireString(input.domain, 'domain'))
  if (!domain) throw new Error('domain is not valid')
  if (input.release === true) {
    requireManager(caller, 'CRM_CLAIM_DOMAIN release')
    const held = await getDomain(db, domain)
    if (!held) return { removed: false }
    await releaseDomain(db, domain)
    await audit(db, caller, 'CRM_DOMAIN', domain, 'RELEASE_DOMAIN', { customerId, heldBy: held.customerId ?? null })
    return { removed: true }
  }
  if (!isClaimableDomain(domain)) {
    throw new Error(`${domain} cannot be claimed: it is a free-mail, shared-service, or our own domain`)
  }
  const force = input.force === true
  if (force) requireManager(caller, 'CRM_CLAIM_DOMAIN force')
  const result = await claimDomain(db, { domain, customerId, by: caller.id, source: 'MANUAL', force })
  if (!result.ok) throw new Error(`Conflict: ${domain} is already claimed by another customer`)
  await audit(db, caller, 'CRM_DOMAIN', domain, result.forced ? 'FORCE_CLAIM_DOMAIN' : 'CLAIM_DOMAIN', { customerId })
  return { domain: result.domain }
}

async function assignOwner(db: Db, caller: Caller, input: Row): Promise<{ customerId: string; ownerId: string }> {
  requireManager(caller, 'CRM_ASSIGN_OWNER')
  const customerId = requireString(input.customerId, 'customerId')
  const ownerId = requireString(input.ownerId, 'ownerId', 100)
  const customer = await getCustomer(db, customerId)
  if (!customer) throw new Error(`Customer not found: ${customerId}`)
  const profile = await db.send(new GetCommand({ TableName: env('USER_PROFILE_TABLE_NAME'), Key: { id: ownerId } }))
  if (!profile.Item) throw new Error(`User not found: ${ownerId}`)
  const owners = [ownerId, ...(customer.accountOwnerIds ?? []).filter((id) => id !== ownerId)]
  await db.send(
    new UpdateCommand({
      TableName: env('CUSTOMER_TABLE_NAME'),
      Key: { id: customerId },
      UpdateExpression: 'SET accountOwnerIds = :o, updatedAt = :now',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: { ':o': owners, ':now': nowIso() },
    }),
  )
  await audit(db, caller, 'CRM_ACCOUNT', customerId, 'ASSIGN_OWNER', { from: ownerOf(customer), to: ownerId })
  return { customerId, ownerId }
}

async function backfill(db: Db, caller: Caller, input: Row): Promise<Row> {
  if (!caller.isAdmin) throw new Error('Forbidden: CRM_BACKFILL requires owner or ADMIN')
  const apply = input.apply === true
  const t = crmTables()
  const [customers, accounts, contacts, domains] = await Promise.all([
    scanAll<BackfillCustomer>(db, {
      TableName: env('CUSTOMER_TABLE_NAME'),
      ProjectionExpression: 'id, contacts, billingEmail, contactEmail, website, accountOwnerIds, defaultSalesRepId',
    }),
    scanAll<{ id: string }>(db, { TableName: t.account, ProjectionExpression: 'id' }),
    scanAll<{ id: string }>(db, { TableName: t.contact, ProjectionExpression: 'id' }),
    scanAll<{ id: string }>(db, { TableName: t.domain, ProjectionExpression: 'id' }),
  ])
  const parsed = customers.map((c) => ({ ...c, contacts: readJson(c.contacts) }))
  const plan = planCrmBackfill(parsed, {
    accountIds: accounts.map((a) => a.id),
    contactIds: contacts.map((c) => c.id),
    domainIds: domains.map((d) => d.id),
  })
  if (!apply) return { dryRun: true, stats: plan.stats }

  const now = nowIso()
  const put = async (table: string, typename: string, item: Row): Promise<boolean> => {
    try {
      await db.send(
        new PutCommand({
          TableName: table,
          Item: { ...item, __typename: typename, version: 0, createdAt: now, updatedAt: now },
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      )
      return true
    } catch (err) {
      if (isConditionalFailure(err)) return false
      throw err
    }
  }
  const created = { accounts: 0, contacts: 0, domains: 0 }
  for (const id of plan.accounts) {
    if (await put(t.account, 'CrmAccount', { id, openTaskCount: 0, updatedBy: caller.id })) created.accounts += 1
  }
  for (const c of plan.contacts) {
    const item: Row = { id: c.id, customerId: c.customerId, source: c.source, status: 'ACTIVE', createdBy: caller.id, updatedBy: caller.id }
    if (c.name) item.name = c.name
    if (c.ownerId) item.ownerId = c.ownerId
    if (await put(t.contact, 'CrmContact', item)) created.contacts += 1
  }
  for (const d of plan.domains) {
    const item: Row = {
      id: d.id,
      source: d.source,
      conflict: d.conflict,
      conflictCustomerIds: d.conflictCustomerIds,
      claimedBy: caller.id,
      claimedAt: now,
    }
    if (d.customerId) item.customerId = d.customerId
    if (await put(t.domain, 'CrmDomain', item)) created.domains += 1
  }
  await audit(db, caller, 'CRM_BACKFILL', 'crm', 'BACKFILL', { created, stats: plan.stats })
  return { dryRun: false, created, stats: plan.stats }
}

// ── Router ───────────────────────────────────────────────────────────────────

type Handler = (db: Db, caller: Caller, input: Row, dashDeps?: DashDeps) => Promise<unknown>

/** Step AI: the dashboard actions live in dashboardActions.ts; this binds them to the router's Db and audit(). */
const dashboardHandler = (action: DashboardActionName): Handler => (db, caller, input, dashDeps) =>
  runDashboardAction(action, caller, input, dashDeps ?? defaultDashDeps(db), (entityType, entityId, act, changes) =>
    audit(db, caller, entityType, entityId, act, changes),
  )

const HANDLERS: Record<CrmActionName, Handler> = {
  CRM_GET_ACCOUNT: getAccountView,
  CRM_LIST_ACCOUNTS: listAccounts,
  CRM_ADD_ACTIVITY: addActivity,
  CRM_ADD_TASK: addTask,
  CRM_COMPLETE_TASK: completeTask,
  CRM_SET_NEXT_STEP: setNextStepAction,
  CRM_LIST_FOLLOWUPS: listFollowups,
  CRM_UPSERT_CONTACT: upsertContactAction,
  CRM_CLAIM_DOMAIN: claimDomainAction,
  CRM_ASSIGN_OWNER: assignOwner,
  CRM_BACKFILL: backfill,
  // Step AI (conversational dashboards)
  PREVIEW_DASHBOARD_CHAT: dashboardHandler('PREVIEW_DASHBOARD_CHAT'),
  PREVIEW_DASHBOARD: dashboardHandler('PREVIEW_DASHBOARD'),
  LIST_DASHBOARDS: dashboardHandler('LIST_DASHBOARDS'),
  GET_DASHBOARD: dashboardHandler('GET_DASHBOARD'),
  GET_DASHBOARD_OPTIONS: dashboardHandler('GET_DASHBOARD_OPTIONS'),
  SAVE_DASHBOARD: dashboardHandler('SAVE_DASHBOARD'),
  ARCHIVE_DASHBOARD: dashboardHandler('ARCHIVE_DASHBOARD'),
}

export async function dispatch(
  action: string,
  rawInput: unknown,
  identity: AppSyncIdentity | null | undefined,
  db: Db = defaultDb,
  dashDeps?: DashDeps,
): Promise<unknown> {
  const handler = (HANDLERS as Record<string, Handler | undefined>)[action]
  if (!handler) throw new Error(`Unknown action: ${action}`)
  const caller = await authorize(identity, db)
  return handler(db, caller, inputOf(rawInput), dashDeps)
}
