/**
 * Step AB §9.4 — every CRM table access, shared by `tms-crm-actions` and (by relative
 * import) `tms-spot-quoter`. `db` is the lib-dynamodb DocumentClient the calling Lambda
 * already holds; table names are read from the environment at call time so a test can
 * set them and so a missing one fails at the call site.
 *
 * Json attributes (`CrmActivity.refs`) are written as JSON strings (AWSJSON) and read
 * tolerantly, the way every other Lambda in this repo does.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { normalizeAddress, registrableDomain } from '../../../src/lib/crm/domains'
import { lookupKeys, matchSender } from '../../../src/lib/crm/match'
import type {
  AddSystemActivityInput,
  CrmAccountRecord,
  CrmActivityKind,
  CrmActivityRecord,
  CrmContactRecord,
  CrmDomainRecord,
  CrmStoreContract,
  SenderMatch,
  UpsertContactInput,
} from '../../../src/lib/crm/types'

export type Db = Pick<DynamoDBDocumentClient, 'send'>
export type Row = Record<string, unknown>

export const IDX_ACTIVITY_BY_CUSTOMER = 'crmActivitiesByCustomerIdAndAt'
export const IDX_ACTIVITY_BY_OWNER = 'crmActivitiesByOwnerIdAndAt'
export const IDX_ACTIVITY_BY_ASSIGNEE = 'crmActivitiesByAssigneeIdAndDueAt'
export const IDX_CONTACT_BY_CUSTOMER = 'crmContactsByCustomerId'
export const IDX_DOMAIN_BY_CUSTOMER = 'crmDomainsByCustomerId'

const MAX_SUBJECT = 120
const MAX_PAGES = 20

export function crmTables() {
  const t = {
    contact: process.env.CRM_CONTACT_TABLE_NAME ?? '',
    domain: process.env.CRM_DOMAIN_TABLE_NAME ?? '',
    activity: process.env.CRM_ACTIVITY_TABLE_NAME ?? '',
    account: process.env.CRM_ACCOUNT_TABLE_NAME ?? '',
  }
  for (const [key, name] of Object.entries(t)) if (!name) throw new Error(`CRM ${key} table is not configured`)
  return t
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** `YYYY-MM-DDTHH:mm:ss.sssZ` so lexical comparison is chronological. */
export function normalizeInstant(value: unknown, fallback = nowIso()): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback
}

export function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException'
}

export function readJson<T>(value: unknown): T | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? (value as T) : null
}

function rand6(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

export function newActivityId(at: string): string {
  return `act:${at}:${rand6()}`
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function getItem<T>(db: Db, table: string, id: string): Promise<T | null> {
  const out = await db.send(new GetCommand({ TableName: table, Key: { id } }))
  return (out.Item as T | undefined) ?? null
}

export const getContact = (db: Db, id: string) => getItem<CrmContactRecord>(db, crmTables().contact, id)
export const getDomain = (db: Db, id: string) => getItem<CrmDomainRecord>(db, crmTables().domain, id)
export const getAccount = (db: Db, id: string) => getItem<CrmAccountRecord>(db, crmTables().account, id)
export const getActivity = (db: Db, id: string) => getItem<RawActivity>(db, crmTables().activity, id)

/** An activity row as stored: `refs` may still be a JSON string. */
export type RawActivity = Omit<CrmActivityRecord, 'refs'> & { refs?: unknown }

export function activityOut(row: RawActivity): CrmActivityRecord {
  return { ...row, refs: readJson(row.refs) } as CrmActivityRecord
}

export async function queryAll<T = Row>(
  db: Db,
  input: ConstructorParameters<typeof QueryCommand>[0],
  limit = 1000,
): Promise<T[]> {
  const items: T[] = []
  let lastKey: Record<string, unknown> | undefined
  for (let page = 0; page < MAX_PAGES && items.length < limit; page += 1) {
    const out = await db.send(new QueryCommand({ ...input, ExclusiveStartKey: lastKey }))
    items.push(...((out.Items ?? []) as T[]))
    lastKey = out.LastEvaluatedKey
    if (!lastKey) break
  }
  return items.slice(0, limit)
}

export async function scanAll<T = Row>(
  db: Db,
  input: ConstructorParameters<typeof ScanCommand>[0],
): Promise<T[]> {
  const items: T[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const out = await db.send(new ScanCommand({ ...input, ExclusiveStartKey: lastKey }))
    items.push(...((out.Items ?? []) as T[]))
    lastKey = out.LastEvaluatedKey
  } while (lastKey)
  return items
}

/** Activities of one customer, newest first. */
export async function activitiesForCustomer(db: Db, customerId: string, limit = 100): Promise<RawActivity[]> {
  return queryAll<RawActivity>(
    db,
    {
      TableName: crmTables().activity,
      IndexName: IDX_ACTIVITY_BY_CUSTOMER,
      KeyConditionExpression: 'customerId = :c',
      ExpressionAttributeValues: { ':c': customerId },
      ScanIndexForward: false,
      Limit: limit,
    },
    limit,
  )
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export async function upsertContact(db: Db, input: UpsertContactInput): Promise<CrmContactRecord> {
  const email = normalizeAddress(input.email)
  if (!email) throw new Error('A valid e-mail address is required')
  const table = crmTables().contact
  const now = nowIso()
  const name = input.name?.trim().slice(0, 120) || null
  const existing = await getItem<CrmContactRecord>(db, table, email)
  if (!existing) {
    const row: CrmContactRecord & Row = {
      id: email,
      __typename: 'CrmContact',
      customerId: input.customerId ?? null,
      name,
      ownerId: input.ownerId,
      source: input.source,
      status: 'ACTIVE',
      createdBy: input.ownerId,
      updatedBy: input.ownerId,
      version: 0,
      createdAt: now,
      updatedAt: now,
    }
    // A customerId of null would be a NULL index key; leave it off instead.
    if (!row.customerId) delete row.customerId
    try {
      await db.send(new PutCommand({ TableName: table, Item: row, ConditionExpression: 'attribute_not_exists(id)' }))
      return row
    } catch (err) {
      if (!isConditionalFailure(err)) throw err
      // Lost a race with a concurrent upsert: fall through and update.
    }
  }
  const sets = ['updatedAt = :now', 'updatedBy = :by', '#v = if_not_exists(#v, :zero) + :one']
  const values: Row = { ':now': now, ':by': input.ownerId, ':zero': 0, ':one': 1 }
  if (input.customerId) {
    sets.push('customerId = :cust')
    values[':cust'] = input.customerId
  }
  if (name) {
    sets.push('#n = :name')
    values[':name'] = name
  }
  sets.push('#st = :active')
  values[':active'] = 'ACTIVE'
  const out = await db.send(
    new UpdateCommand({
      TableName: table,
      Key: { id: email },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { '#v': 'version', '#n': 'name', '#st': 'status' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  )
  return out.Attributes as CrmContactRecord
}

/** Contact details a manager/rep edits by hand (title, phone) — same row, same id. */
export async function patchContact(
  db: Db,
  email: string,
  patch: { title?: string | null; phone?: string | null },
  by: string,
): Promise<CrmContactRecord> {
  const sets = ['updatedAt = :now', 'updatedBy = :by', '#v = if_not_exists(#v, :zero) + :one']
  const values: Row = { ':now': nowIso(), ':by': by, ':zero': 0, ':one': 1 }
  const names: Record<string, string> = { '#v': 'version' }
  for (const key of ['title', 'phone'] as const) {
    const v = patch[key]
    if (typeof v === 'string' && v.trim()) {
      sets.push(`#${key} = :${key}`)
      names[`#${key}`] = key
      values[`:${key}`] = v.trim().slice(0, 60)
    }
  }
  const out = await db.send(
    new UpdateCommand({
      TableName: crmTables().contact,
      Key: { id: email },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  )
  return out.Attributes as CrmContactRecord
}

export async function contactsForCustomer(db: Db, customerId: string): Promise<CrmContactRecord[]> {
  return queryAll<CrmContactRecord>(db, {
    TableName: crmTables().contact,
    IndexName: IDX_CONTACT_BY_CUSTOMER,
    KeyConditionExpression: 'customerId = :c',
    ExpressionAttributeValues: { ':c': customerId },
  })
}

// ── Sender lookup (§5.3) ─────────────────────────────────────────────────────

export async function lookupSender(db: Db, address: string, authVerdict?: string | null): Promise<SenderMatch> {
  const { contactId, domainId } = lookupKeys(address)
  if (!contactId) return { how: 'NONE', candidates: [] }
  const [contact, domain] = await Promise.all([getContact(db, contactId), domainId ? getDomain(db, domainId) : null])
  return matchSender(address, authVerdict, { contact, domain })
}

// ── Domains ──────────────────────────────────────────────────────────────────

export type ClaimResult =
  | { ok: true; domain: CrmDomainRecord; forced: boolean }
  | { ok: false; heldBy: string }

/**
 * No silent steal: a held domain refuses unless `force` (the caller has already checked
 * the viewer is a manager). A conflicted row (two customers) is also "held".
 */
export async function claimDomain(
  db: Db,
  input: { domain: string; customerId: string; by: string; source: CrmDomainRecord['source']; force?: boolean },
): Promise<ClaimResult> {
  const table = crmTables().domain
  const domain = registrableDomain(input.domain)
  if (!domain) throw new Error('A valid domain is required')
  const now = nowIso()
  const existing = await getItem<CrmDomainRecord>(db, table, domain)
  if (existing && (existing.conflict || (existing.customerId && existing.customerId !== input.customerId))) {
    if (!input.force) return { ok: false, heldBy: existing.customerId ?? (existing.conflictCustomerIds ?? [])[0] ?? '' }
  }
  if (existing && existing.customerId === input.customerId && !existing.conflict) {
    return { ok: true, domain: existing, forced: false }
  }
  const row: CrmDomainRecord & Row = {
    id: domain,
    __typename: 'CrmDomain',
    customerId: input.customerId,
    source: input.source,
    conflict: false,
    conflictCustomerIds: [],
    claimedBy: input.by,
    claimedAt: now,
    version: (existing?.version ?? -1) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  try {
    await db.send(
      new PutCommand({
        TableName: table,
        Item: row,
        ...(existing
          ? { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': existing.version ?? 0 } }
          : { ConditionExpression: 'attribute_not_exists(id)' }),
      }),
    )
  } catch (err) {
    if (isConditionalFailure(err)) return { ok: false, heldBy: existing?.customerId ?? '' }
    throw err
  }
  return { ok: true, domain: row, forced: !!existing }
}

export async function releaseDomain(db: Db, domain: string): Promise<void> {
  await db.send(new DeleteCommand({ TableName: crmTables().domain, Key: { id: registrableDomain(domain) } }))
}

export async function domainsForCustomer(db: Db, customerId: string): Promise<CrmDomainRecord[]> {
  return queryAll<CrmDomainRecord>(db, {
    TableName: crmTables().domain,
    IndexName: IDX_DOMAIN_BY_CUSTOMER,
    KeyConditionExpression: 'customerId = :c',
    ExpressionAttributeValues: { ':c': customerId },
  })
}

// ── Activity + last touch (§5.4) ─────────────────────────────────────────────

/**
 * Upserts `CrmAccount.lastTouch*` under a `max(at)` condition: an older, back-dated entry
 * does not move last touch backwards. Returns false when the condition held it back.
 */
export async function touch(
  db: Db,
  input: { customerId: string; kind: CrmActivityKind; at: string; by: string },
): Promise<boolean> {
  const now = nowIso()
  try {
    await db.send(
      new UpdateCommand({
        TableName: crmTables().account,
        Key: { id: input.customerId },
        UpdateExpression:
          'SET lastTouchAt = :at, lastTouchKind = :k, lastTouchBy = :by, updatedAt = :now, updatedBy = :by, ' +
          '#t = if_not_exists(#t, :tn), createdAt = if_not_exists(createdAt, :now), ' +
          'openTaskCount = if_not_exists(openTaskCount, :zero), #v = if_not_exists(#v, :zero) + :one',
        ConditionExpression: 'attribute_not_exists(lastTouchAt) OR lastTouchAt <= :at',
        ExpressionAttributeNames: { '#t': '__typename', '#v': 'version' },
        ExpressionAttributeValues: {
          ':at': input.at,
          ':k': input.kind,
          ':by': input.by,
          ':now': now,
          ':tn': 'CrmAccount',
          ':zero': 0,
          ':one': 1,
        },
      }),
    )
    return true
  } catch (err) {
    if (isConditionalFailure(err)) return false
    throw err
  }
}

/** Keeps `CrmAccount.openTaskCount` in step with TASK rows; never below zero. */
export async function adjustOpenTasks(db: Db, customerId: string, delta: 1 | -1, by: string): Promise<void> {
  const now = nowIso()
  try {
    await db.send(
      new UpdateCommand({
        TableName: crmTables().account,
        Key: { id: customerId },
        UpdateExpression:
          'SET updatedAt = :now, updatedBy = :by, #t = if_not_exists(#t, :tn), createdAt = if_not_exists(createdAt, :now), ' +
          '#v = if_not_exists(#v, :zero) + :one ADD openTaskCount :d',
        ...(delta < 0 ? { ConditionExpression: 'openTaskCount > :zero' } : {}),
        ExpressionAttributeNames: { '#t': '__typename', '#v': 'version' },
        ExpressionAttributeValues: { ':now': now, ':by': by, ':tn': 'CrmAccount', ':zero': 0, ':one': 1, ':d': delta },
      }),
    )
  } catch (err) {
    if (!isConditionalFailure(err)) throw err
  }
}

/** Sets or clears the account's next step. A blank `nextStep` clears both fields. */
export async function setNextStep(
  db: Db,
  input: { customerId: string; nextStep: string | null; nextStepDueAt: string | null; by: string },
): Promise<CrmAccountRecord> {
  const now = nowIso()
  const names: Record<string, string> = { '#t': '__typename', '#v': 'version' }
  const values: Row = { ':now': now, ':by': input.by, ':tn': 'CrmAccount', ':zero': 0, ':one': 1 }
  const sets = [
    'updatedAt = :now',
    'updatedBy = :by',
    '#t = if_not_exists(#t, :tn)',
    'createdAt = if_not_exists(createdAt, :now)',
    'openTaskCount = if_not_exists(openTaskCount, :zero)',
    '#v = if_not_exists(#v, :zero) + :one',
  ]
  const removes: string[] = []
  if (input.nextStep) {
    sets.push('nextStep = :ns', 'nextStepBy = :by')
    values[':ns'] = input.nextStep
    if (input.nextStepDueAt) {
      sets.push('nextStepDueAt = :due')
      values[':due'] = input.nextStepDueAt
    } else removes.push('nextStepDueAt')
  } else removes.push('nextStep', 'nextStepDueAt', 'nextStepBy')
  const out = await db.send(
    new UpdateCommand({
      TableName: crmTables().account,
      Key: { id: input.customerId },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  )
  return out.Attributes as CrmAccountRecord
}

export async function putActivity(db: Db, row: Omit<RawActivity, 'id'> & { id?: string }): Promise<RawActivity> {
  const at = normalizeInstant(row.at)
  const now = nowIso()
  const item: RawActivity & Row = {
    ...row,
    id: row.id ?? newActivityId(now),
    __typename: 'CrmActivity',
    at,
    version: 0,
    createdAt: now,
    updatedAt: now,
  } as RawActivity & Row
  // Sparse/indexed attributes must be absent, never null.
  for (const key of ['customerId', 'assigneeId', 'dueAt', 'contactEmail'] as const) {
    if (item[key] == null) delete item[key]
  }
  if (item.refs && typeof item.refs !== 'string') item.refs = JSON.stringify(item.refs)
  await db.send(new PutCommand({ TableName: crmTables().activity, Item: item, ConditionExpression: 'attribute_not_exists(id)' }))
  return item
}

const SYSTEM_DIRECTION: Record<string, 'IN' | 'OUT'> = {
  EMAIL_IN: 'IN',
  EMAIL_OUT: 'OUT',
  QUOTE_DRAFTED: 'OUT',
  QUOTE_SENT: 'OUT',
}

export async function addSystemActivity(db: Db, input: AddSystemActivityInput): Promise<void> {
  const at = normalizeInstant(input.at)
  const refs = Object.fromEntries(Object.entries(input.refs ?? {}).filter(([, v]) => typeof v === 'string' && v))
  const isEmail = input.kind === 'EMAIL_IN' || input.kind === 'EMAIL_OUT'
  await putActivity(db, {
    customerId: input.customerId,
    contactEmail: input.contactEmail ? normalizeAddress(input.contactEmail) || undefined : undefined,
    ownerId: input.ownerId,
    kind: input.kind,
    direction: SYSTEM_DIRECTION[input.kind],
    at,
    subject: isEmail && input.subject ? input.subject.slice(0, MAX_SUBJECT) : undefined,
    refs,
    createdBy: input.ownerId,
  })
  if (input.customerId) await touch(db, { customerId: input.customerId, kind: input.kind, at, by: input.ownerId })
}

/** SPOT_PURGE_MINE: blank the subject on every e-mail activity this rep produced. */
export async function purgeEmailSubjects(db: Db, ownerId: string): Promise<number> {
  const rows = await queryAll<RawActivity>(db, {
    TableName: crmTables().activity,
    IndexName: IDX_ACTIVITY_BY_OWNER,
    KeyConditionExpression: 'ownerId = :o',
    FilterExpression: 'attribute_exists(subject)',
    ExpressionAttributeValues: { ':o': ownerId },
  })
  let cleared = 0
  for (const row of rows) {
    if (row.kind !== 'EMAIL_IN' && row.kind !== 'EMAIL_OUT') continue
    await db.send(
      new UpdateCommand({
        TableName: crmTables().activity,
        Key: { id: row.id },
        UpdateExpression: 'REMOVE subject SET updatedAt = :now',
        ExpressionAttributeValues: { ':now': nowIso() },
      }),
    )
    cleared += 1
  }
  return cleared
}

export const crmStore: CrmStoreContract<Db> = { upsertContact, addSystemActivity, lookupSender }

