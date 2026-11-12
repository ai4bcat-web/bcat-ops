/**
 * workflow-agent — every DynamoDB and S3 call the agent is allowed to make.
 *
 * Kept in one file on purpose. The hard invariant of step K is that the agent
 * proposes and a person applies, and the cheapest way to keep that true is for
 * the write surface to be small enough to read in one sitting: WorkflowRun,
 * one UpdateItem on VendorPayable, one PutItem on ShipmentDocument, one PutItem
 * on AuditLog. Everything else here is a read.
 *
 * There is deliberately no delete of any kind. A run is DISMISSED or RESOLVED.
 */
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import { DUP_WINDOW_MS, isDeletedIntake, isSameEmail, isSameTender, type TenderProbe } from '../../../src/lib/intakeDup'
import type {
  WorkflowAgentKey,
  WorkflowOutcome,
  WorkflowRunStatus,
  WorkflowStep,
} from '../../../src/types/tms'

export type Row = Record<string, unknown>

/**
 * The WorkflowRun row as this Lambda writes it — `src/types/tms.ts`'s
 * `WorkflowRunRecord` minus the client-only niceties. The few fields
 * `src/lib/workflows/runState` is generic over are imported from there as
 * types (erased at build time) so a run row stays assignable to `RunStateRow`.
 */
export interface RunRow {
  id: string
  agent: WorkflowAgentKey
  inboxRole?: string | null
  status: WorkflowRunStatus
  outcome?: WorkflowOutcome | null
  currentStep?: string | null
  errorCode?: string | null
  error?: string | null
  exceptionOpen?: string | null
  sourceKind: string
  sourceId: string
  sourceKey?: string | null
  provider?: string | null
  subject?: string | null
  fromEmail?: string | null
  fromName?: string | null
  fromDomain?: string | null
  receivedAt?: string | null
  bodyPreview?: string | null
  partyKind?: string | null
  partyId?: string | null
  partyName?: string | null
  partyMatchHow?: string | null
  partyCandidates?: unknown
  shipmentId?: string | null
  shipmentNumber?: string | null
  quoteId?: string | null
  documentIds?: string[] | null
  proposalKind?: string | null
  proposal?: unknown
  steps?: WorkflowStep[] | null
  documents?: unknown
  attempts?: number | null
  lastAttemptAt?: string | null
  startedAt?: string | null
  endedAt?: string | null
  durationMs?: number | null
  model?: string | null
  modelCalls?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  memoryRevisions?: unknown
  feedback?: unknown
  appliedAt?: string | null
  appliedBy?: string | null
  dismissedAt?: string | null
  dismissedBy?: string | null
  dismissReason?: string | null
  resolvedAt?: string | null
  resolvedBy?: string | null
  createdBy: string
  updatedBy: string
  createdAt?: string
  updatedAt?: string
  /** Mirror of `updatedAt`; the sort key of all three indexes. Written by `withSortKey`. */
  runUpdatedAt?: string
  version?: number
}

const dynamo = new DynamoDBClient({})
const s3 = new S3Client({})

// Table names are wired in amplify/backend.ts. Read at module load, as every
// other TMS Lambda does: a missing one is a deploy bug, not a runtime branch.
export const WORKFLOW_RUN_TABLE_NAME = process.env.WORKFLOW_RUN_TABLE_NAME ?? ''
export const VENDOR_PAYABLE_TABLE_NAME = process.env.TABLE_NAME ?? ''
export const SHIPMENT_TABLE_NAME = process.env.SHIPMENT_TABLE_NAME ?? ''
export const ORDER_TABLE_NAME = process.env.ORDER_TABLE_NAME ?? ''
export const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''
export const LOAD_CARRIER_TABLE_NAME = process.env.LOAD_CARRIER_TABLE_NAME ?? ''
export const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? ''
export const CARRIER_TABLE_NAME = process.env.CARRIER_TABLE_NAME ?? ''
export const CARRIER_CONTACT_TABLE_NAME = process.env.CARRIER_CONTACT_TABLE_NAME ?? ''
export const LOCATION_TABLE_NAME = process.env.LOCATION_TABLE_NAME ?? ''
export const QUOTE_TABLE_NAME = process.env.QUOTE_TABLE_NAME ?? ''
export const SHIPMENT_DOCUMENT_TABLE_NAME = process.env.SHIPMENT_DOCUMENT_TABLE_NAME ?? ''
export const TMS_SETTINGS_TABLE_NAME = process.env.TMS_SETTINGS_TABLE_NAME ?? ''
export const INTAKE_ITEM_TABLE_NAME = process.env.INTAKE_ITEM_TABLE_NAME ?? ''
export const DRIVER_SUBMISSION_TABLE_NAME = process.env.DRIVER_SUBMISSION_TABLE_NAME ?? ''
export const PRO_CLAIM_TABLE_NAME = process.env.PRO_CLAIM_TABLE_NAME ?? ''
export const INTEGRATION_TABLE_NAME = process.env.INTEGRATION_TABLE_NAME ?? ''
export const INTAKE_LOAD_TABLE_NAME = process.env.INTAKE_LOAD_TABLE_NAME ?? ''
export const OWNERSHIP_DIVISION_TABLE_NAME = process.env.OWNERSHIP_DIVISION_TABLE_NAME ?? ''
export const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
export const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
export const USER_POOL_ID = process.env.USER_POOL_ID ?? ''
export const INBOX_SECRET = process.env.INBOX_SECRET ?? ''

/** The single TmsSettings row, as every TMS Lambda addresses it. */
const SETTINGS_ID = 'default'

/*
 * Amplify derives a GSI name from the plural model name and the key fields —
 * the same convention `quotesByCustomerIdAndQuoteDate` and
 * `loadsByCheckCallOpenAndNextCheckCallAt` already follow in this repo.
 */
export const IDX_RUNS_BY_AGENT = 'workflowRunsByAgentAndRunUpdatedAt'
export const IDX_RUNS_BY_SHIPMENT = 'workflowRunsByShipmentIdAndRunUpdatedAt'
export const IDX_RUNS_BY_EXCEPTION = 'workflowRunsByExceptionOpenAndRunUpdatedAt'
const IDX_SHIPMENTS_BY_NUMBER = 'shipmentsByNumber'

export function nowIso(): string {
  return new Date().toISOString()
}

function marshallRow(item: Row): Record<string, AttributeValue> {
  return marshall(item, { removeUndefinedValues: true })
}

export function isConditionalFailure(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'ConditionalCheckFailedException'
}

/** ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly. */
export function conflictError(itemLabel: string, cause: unknown): Error {
  const err = new Error(`This ${itemLabel} was changed by someone else. Reload and try again.`)
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

// ── WorkflowRun ──────────────────────────────────────────────────────────────

/*
 * Amplify reserves `updatedAt` and refuses it as an index sort key, so the three
 * GSIs sort on `runUpdatedAt`. Mirroring it here rather than at every call site is
 * what keeps the two from ever disagreeing: a row whose `runUpdatedAt` lagged would
 * silently sort into the wrong place in the Errors queue.
 */
function withSortKey(row: Row): Row {
  const stamp = row.updatedAt
  return typeof stamp === 'string' && stamp ? { ...row, runUpdatedAt: stamp } : row
}

/**
 * The dedupe. `id` is a hash of the source, so two bridges handing the same
 * message over collide on the primary key and the loser does no work at all.
 * Returns false when the row was already there.
 */
export async function putRunIfAbsent(row: Row): Promise<boolean> {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: WORKFLOW_RUN_TABLE_NAME,
      Item: marshallRow({ ...withSortKey(row), __typename: 'WorkflowRun' }),
      ConditionExpression: 'attribute_not_exists(id)',
    }))
    return true
  } catch (err) {
    if (isConditionalFailure(err)) return false
    throw err
  }
}

export async function getRun(id: string): Promise<Row | null> {
  const got = await dynamo.send(new GetItemCommand({
    TableName: WORKFLOW_RUN_TABLE_NAME,
    Key: marshall({ id }),
  }))
  return got.Item ? unmarshall(got.Item) : null
}

/**
 * A patch, not a whole-row put: the trace view polls this row while a run is in
 * flight, and a put would race the step that is still writing.
 *
 * `null` REMOVEs rather than SETs. `exceptionOpen` is a sparse GSI hash key and
 * DynamoDB refuses a stored NULL on one of those — the same reason
 * `Load.checkCallOpen` is REMOVEd in tms-shipment-actions.
 */
export async function updateRun(id: string, patch: Row, expectedVersion?: number): Promise<Row> {
  const names: Record<string, string> = {}
  const values: Row = {}
  const sets: string[] = []
  const removes: string[] = []
  let i = 0
  for (const [key, value] of Object.entries(withSortKey(patch))) {
    if (key === 'id' || key === 'version') continue
    names[`#f${i}`] = key
    if (value === null || value === undefined) {
      removes.push(`#f${i}`)
    } else {
      values[`:v${i}`] = value
      sets.push(`#f${i} = :v${i}`)
    }
    i += 1
  }
  names['#version'] = 'version'
  values[':one'] = 1
  values[':zero'] = 0
  const clauses = [`SET ${[...sets, '#version = if_not_exists(#version, :zero) + :one'].join(', ')}`]
  if (removes.length) clauses.push(`REMOVE ${removes.join(', ')}`)

  let condition = 'attribute_exists(id)'
  if (expectedVersion !== undefined) {
    values[':expectedVersion'] = expectedVersion
    condition = '#version = :expectedVersion'
  }

  try {
    const result = await dynamo.send(new UpdateItemCommand({
      TableName: WORKFLOW_RUN_TABLE_NAME,
      Key: marshall({ id }),
      UpdateExpression: clauses.join(' '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshallRow(values),
      ConditionExpression: condition,
      ReturnValues: 'ALL_NEW',
    }))
    return result.Attributes ? unmarshall(result.Attributes) : { id, ...patch }
  } catch (err) {
    if (isConditionalFailure(err)) throw conflictError('run', err)
    throw err
  }
}

async function queryRuns(
  indexName: string,
  field: string,
  value: string,
  opts: { limit?: number; ascending?: boolean; filterStatuses?: string[]; sortBefore?: string } = {},
): Promise<Row[]> {
  const names: Record<string, string> = { '#k': field }
  const values: Row = { ':v': value }
  let condition = '#k = :v'
  if (opts.sortBefore) {
    names['#sk'] = 'runUpdatedAt'
    values[':before'] = opts.sortBefore
    condition = '#k = :v AND #sk < :before'
  }
  if (opts.filterStatuses?.length) {
    names['#st'] = 'status'
    opts.filterStatuses.forEach((status, index) => { values[`:st${index}`] = status })
  }
  const statusFilter = opts.filterStatuses?.length
    ? `#st IN (${opts.filterStatuses.map((_, index) => `:st${index}`).join(', ')})`
    : null
  const out: Row[] = []
  let startKey: Record<string, AttributeValue> | undefined
  do {
    const page: { Items?: Record<string, AttributeValue>[]; LastEvaluatedKey?: Record<string, AttributeValue> } =
      await dynamo.send(new QueryCommand({
        TableName: WORKFLOW_RUN_TABLE_NAME,
        IndexName: indexName,
        KeyConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshallRow(values),
        ...(statusFilter ? { FilterExpression: statusFilter } : {}),
        ScanIndexForward: opts.ascending ?? false,
        ...(opts.limit ? { Limit: opts.limit } : {}),
      }))
    for (const item of page.Items ?? []) out.push(unmarshall(item))
    startKey = page.LastEvaluatedKey
    if (opts.limit && out.length >= opts.limit) return out.slice(0, opts.limit)
  } while (startKey)
  return out
}

export async function queryByAgent(agent: string, limit = 200): Promise<Row[]> {
  return queryRuns(IDX_RUNS_BY_AGENT, 'agent', agent, { limit })
}

export async function queryByShipment(shipmentId: string, limit = 200): Promise<Row[]> {
  return queryRuns(IDX_RUNS_BY_SHIPMENT, 'shipmentId', shipmentId, { limit })
}

export async function queryExceptions(limit = 200): Promise<Row[]> {
  return queryRuns(IDX_RUNS_BY_EXCEPTION, 'exceptionOpen', 'OPEN', { limit })
}

/**
 * Runs an agent has already done today. The cap exists so a mail loop cannot
 * spend the Anthropic budget overnight, so it is counted before any model call
 * and from the index rather than a scan.
 *
 * Counted by when the run last *ran*, not when the row last changed: feedback, a
 * dismissal or a resolve touches `updatedAt` on a run from last week, and that
 * is not an agent spending money today.
 */
/** The error codes of a run that ended at the spending gate without calling the model. */
export const GATED_CODES: ReadonlySet<string> = new Set(['DAILY_CAP', 'AGENT_DISABLED'])

export async function countRunsToday(agent: string, nowIsoValue = nowIso()): Promise<number> {
  const dayStart = `${nowIsoValue.slice(0, 10)}T00:00:00.000Z`
  const rows = await queryRuns(IDX_RUNS_BY_AGENT, 'agent', agent, { limit: 1000 })
  // A run the gate itself stopped spent nothing, so it must not count toward the cap that stopped it.
  return rows.filter((row) => String(row.lastAttemptAt ?? row.createdAt ?? '') >= dayStart && !GATED_CODES.has(String(row.errorCode ?? ''))).length
}

/**
 * Candidates for the stalled sweep, oldest first.
 *
 * PENDING counts: a run that died between the conditional put and its first
 * `persist` never reaches IN_PROGRESS, and without this it would sit there for
 * ever — not swept, not failed, not retryable and invisible to the Errors queue.
 */
export async function queryStalled(agent: string, cutoffIso: string): Promise<Row[]> {
  return queryRuns(IDX_RUNS_BY_AGENT, 'agent', agent, {
    ascending: true,
    sortBefore: cutoffIso,
    filterStatuses: ['PENDING', 'IN_PROGRESS'],
    limit: 200,
  })
}

// ── Source rows ──────────────────────────────────────────────────────────────

const SOURCE_TABLES: Record<string, string> = {
  INTAKE_ITEM: INTAKE_ITEM_TABLE_NAME,
  VENDOR_PAYABLE: VENDOR_PAYABLE_TABLE_NAME,
  DRIVER_SUBMISSION: DRIVER_SUBMISSION_TABLE_NAME,
}

export async function getSourceRow(kind: string, id: string): Promise<Row | null> {
  const table = SOURCE_TABLES[kind]
  if (!table) return null
  const got = await dynamo.send(new GetItemCommand({ TableName: table, Key: marshall({ id }) }))
  return got.Item ? unmarshall(got.Item) : null
}

export async function getSettings(): Promise<Row | null> {
  if (!TMS_SETTINGS_TABLE_NAME) return null
  const got = await dynamo.send(new GetItemCommand({
    TableName: TMS_SETTINGS_TABLE_NAME,
    Key: marshall({ id: SETTINGS_ID }),
  }))
  return got.Item ? unmarshall(got.Item) : null
}

/** The GMAIL / OUTLOOK behaviour cards, which carry the blacklists. */
export async function getIntegration(provider: string): Promise<Row | null> {
  if (!INTEGRATION_TABLE_NAME) return null
  const got = await dynamo.send(new GetItemCommand({
    TableName: INTEGRATION_TABLE_NAME,
    Key: marshall({ id: provider }),
  }))
  return got.Item ? unmarshall(got.Item) : null
}

async function scanProjected(table: string, projection: string, names: Record<string, string>): Promise<Row[]> {
  if (!table) return []
  const out: Row[] = []
  let startKey: Record<string, AttributeValue> | undefined
  do {
    const page: { Items?: Record<string, AttributeValue>[]; LastEvaluatedKey?: Record<string, AttributeValue> } =
      await dynamo.send(new ScanCommand({
        TableName: table,
        ProjectionExpression: projection,
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExclusiveStartKey: startKey,
        Limit: 1000,
      }))
    for (const item of page.Items ?? []) out.push(unmarshall(item))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return out
}

export interface DirectorySnapshot {
  customers: Row[]
  carriers: Row[]
  carrierContacts: Row[]
  locations: Row[]
}

/**
 * Only the columns `matchParty` reads, plus `aiMemory` for the prompt. The
 * directory is a few thousand rows and this runs on every e-mail; projecting it
 * keeps the read off the notes, charge tables and billing addresses.
 */
export async function loadDirectory(): Promise<DirectorySnapshot> {
  const [customers, carriers, carrierContacts, locations] = await Promise.all([
    scanProjected(CUSTOMER_TABLE_NAME, 'id, #n, contacts, aliases, aiMemory', { '#n': 'name' }),
    scanProjected(CARRIER_TABLE_NAME, 'id, #n, email, dbaName, aiMemory', { '#n': 'name' }),
    scanProjected(CARRIER_CONTACT_TABLE_NAME, 'id, carrierId, #n, email', { '#n': 'name' }),
    scanProjected(LOCATION_TABLE_NAME, 'id, #n, city, #s, zip', { '#n': 'name', '#s': 'state' }),
  ])
  return { customers, carriers, carrierContacts, locations }
}

/** Every division row, projected to what intake routing reads (the table is a handful of rows). */
export async function listDivisions(): Promise<Row[]> {
  return scanProjected(OWNERSHIP_DIVISION_TABLE_NAME, 'id, code, #n, active, intakeEmail', { '#n': 'name' })
}

/**
 * Creates the IntakeLoad row for one e-mail. `attribute_not_exists(id)`: a re-run
 * (RETRY_RUN, SET_RUN_PARTY) must never overwrite a row a reviewer has started editing.
 * Returns false when the row was already there.
 */
export async function putIntakeLoadIfAbsent(row: Row): Promise<boolean> {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: INTAKE_LOAD_TABLE_NAME,
      Item: marshallRow({ ...row, __typename: 'IntakeLoad' }),
      ConditionExpression: 'attribute_not_exists(id)',
    }))
    return true
  } catch (err) {
    if (isConditionalFailure(err)) return false
    throw err
  }
}

export async function getById(table: string, id: string): Promise<Row | null> {
  if (!table || !id) return null
  const got = await dynamo.send(new GetItemCommand({ TableName: table, Key: marshall({ id }) }))
  return got.Item ? unmarshall(got.Item) : null
}

export async function findShipmentByNumber(number: string): Promise<Row | null> {
  if (!SHIPMENT_TABLE_NAME || !number) return null
  const page = await dynamo.send(new QueryCommand({
    TableName: SHIPMENT_TABLE_NAME,
    IndexName: IDX_SHIPMENTS_BY_NUMBER,
    KeyConditionExpression: '#k = :v',
    ExpressionAttributeNames: { '#k': 'number' },
    ExpressionAttributeValues: marshall({ ':v': number }),
    Limit: 1,
  }))
  const item = (page.Items ?? [])[0]
  return item ? unmarshall(item) : null
}

/**
 * Shipments whose search key holds any of `values` (lower case), as the narrow rows `src/lib/intakeBuilt.ts` matches on. The search key
 * is not indexed, so this is a filtered table scan: one per staged e-mail that has references to check (at most 25 values, one filter).
 * Throws on a failed read; the caller treats that as "nothing found" (the check is advice, never a gate on ingesting the e-mail).
 */
export async function findShipmentsBySearchKeys(values: readonly string[]): Promise<Row[]> {
  const unique = [...new Set(values.map((v) => v.trim().toLowerCase()).filter((v) => v.length >= 5))].slice(0, 25)
  if (!SHIPMENT_TABLE_NAME || unique.length === 0) return []
  const out = new Map<string, Row>()
  const names: Record<string, string> = { '#k': 'searchKey', '#n': 'number' }
  const vals: Record<string, AttributeValue> = {}
  const clauses = unique.map((v, i) => { vals[`:v${i}`] = { S: v }; return `contains(#k, :v${i})` })
  let key: Record<string, AttributeValue> | undefined
  do {
    const page = await dynamo.send(new ScanCommand({
      TableName: SHIPMENT_TABLE_NAME,
      FilterExpression: clauses.join(' OR '),
      ProjectionExpression: 'id, #n, customerId, customerName, #k, voidedAt, deletedAt',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
      ExclusiveStartKey: key,
    }))
    for (const item of page.Items ?? []) { const r = unmarshall(item); out.set(String(r.id), r) }
    key = page.LastEvaluatedKey
  } while (key)
  return [...out.values()]
}

/** The old `{ all: true }` backfill: every e-mail payable nothing has read yet. */
export async function scanVendorPayablesNeedingExtract(): Promise<string[]> {
  const ids: string[] = []
  let startKey: Record<string, AttributeValue> | undefined
  do {
    const page: { Items?: Record<string, AttributeValue>[]; LastEvaluatedKey?: Record<string, AttributeValue> } =
      await dynamo.send(new ScanCommand({
        TableName: VENDOR_PAYABLE_TABLE_NAME,
        FilterExpression: 'attribute_not_exists(extractedAt) AND #s = :email',
        ExpressionAttributeNames: { '#s': 'source' },
        ExpressionAttributeValues: marshall({ ':email': 'EMAIL' }),
        ProjectionExpression: 'id',
        ExclusiveStartKey: startKey,
      }))
    for (const item of page.Items ?? []) ids.push(String(unmarshall(item).id))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return ids
}

// ── The two business writes ──────────────────────────────────────────────────

/**
 * A carrier invoice the agent found, filed against the shipment for a person to
 * accept. PENDING review is the whole point: nothing the agent files satisfies a
 * requirement until somebody looks at it.
 */
export async function putShipmentDocument(row: Row): Promise<void> {
  await dynamo.send(new PutItemCommand({
    TableName: SHIPMENT_DOCUMENT_TABLE_NAME,
    Item: marshallRow({ ...row, __typename: 'ShipmentDocument' }),
    ConditionExpression: 'attribute_not_exists(id)',
  }))
}

/** Blanks only — see ap/merge.ts. The one UpdateItem the agent is granted. */
export async function updateVendorPayable(id: string, patch: Row): Promise<void> {
  const names: Record<string, string> = {}
  const values: Row = {}
  const sets: string[] = []
  let i = 0
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#f${i}`] = key
    values[`:v${i}`] = value
    sets.push(`#f${i} = :v${i}`)
    i += 1
  }
  if (!sets.length) return
  await dynamo.send(new UpdateItemCommand({
    TableName: VENDOR_PAYABLE_TABLE_NAME,
    Key: marshall({ id }),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshallRow(values),
  }))
}

/**
 * One audit row per write action. Best effort: a run that moved must not be
 * reported as failed because the history table rejected a row.
 */
export async function writeAudit(
  entityType: string,
  entityId: string,
  action: string,
  caller: { email: string },
  changes: Row,
): Promise<void> {
  if (!AUDIT_LOG_TABLE_NAME) return
  const now = nowIso()
  try {
    await dynamo.send(new PutItemCommand({
      TableName: AUDIT_LOG_TABLE_NAME,
      Item: marshallRow({
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType,
        entityId,
        action,
        user: caller.email,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      }),
    }))
  } catch (err) {
    console.warn('[workflow-agent] audit log write failed:', String(err))
  }
}

// ── S3 ───────────────────────────────────────────────────────────────────────

export async function getObjectText(key: string): Promise<string | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }))
    return await obj.Body!.transformToString()
  } catch (err) {
    console.warn('[workflow-agent] could not read', key, String(err))
    return null
  }
}

export async function getObjectBytes(key: string): Promise<Buffer | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }))
    return Buffer.from(await obj.Body!.transformToByteArray())
  } catch (err) {
    console.warn('[workflow-agent] could not read', key, String(err))
    return null
  }
}

export async function putObjectJson(key: string, value: unknown): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: 'application/json',
    Body: JSON.stringify(value),
  }))
}

export async function signedPutUrl(key: string, contentType: string, size: number): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: 300 },
  )
}

export async function headObject(key: string): Promise<{ ContentLength?: number; ContentType?: string }> {
  return s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }))
}


function parseFields(raw: unknown): Row {
  if (typeof raw !== 'string') return (raw as Row | null | undefined) ?? {}
  try { return JSON.parse(raw) as Row } catch { return {} }
}

/**
 * The intake row (any status) an e-mail's reference and sender already belong to, or null. A second e-mail about the same tender
 * (Batory's "about to expire" reminder) rolls into this row instead of creating a new one.
 */
export async function findIntakeByReference(reference: string, fromEmail: string, more: Omit<TenderProbe, 'reference' | 'fromEmail'> = {}): Promise<Row | null> {
  const mine: TenderProbe = { reference, fromEmail, ...more }
  if (!INTAKE_LOAD_TABLE_NAME || (!reference.trim() && !(more.attachments ?? []).length)) return null
  for (const status of ['OPEN', 'MOVED', 'DISMISSED']) {
    let key: Record<string, AttributeValue> | undefined
    do {
      const page = await dynamo.send(new QueryCommand({
        TableName: INTAKE_LOAD_TABLE_NAME,
        IndexName: 'intakeLoadsByStatusAndReceivedAt',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': { S: status } },
        ExclusiveStartKey: key,
      }))
      for (const item of page.Items ?? []) {
        const row = unmarshall(item)
        const fields = parseFields(row.fields)
        // A row typed from a Slack forward has Slackbot as its sender: the original e-mail about the same reference is its source.
        const theirs: TenderProbe = {
          reference: String(fields.reference ?? ''), fromEmail: String(row.fromEmail ?? ''), customerId: String(fields.customerId ?? ''), customerName: String(fields.customerName ?? ''),
          attachments: Array.isArray(row.attachments) ? (row.attachments as { name?: string; size?: number }[]) : [],
        }
        if (isSameTender(mine, theirs)) return row
      }
      key = page.LastEvaluatedKey
    } while (key)
  }
  return null
}

/**
 * A later e-mail about the same tender brings what the row lacks: its attachments (the rate confirmation PDF) when the row has none,
 * and field values the row has no value for (`merged` is `mergeIntakeFields`' answer). Conditioned on the row not having changed since it
 * was read, so a reviewer's edit in between is never overwritten; the caller falls back to just logging the e-mail.
 */
export async function enrichIntakeLoad(
  row: Row,
  update: {
    attachments: Row[] | null; fields: Row | null; meta: Row | null; missingFields?: string[] | null; at: string
    /** A row that was saved unread and has now been read by the agent. */
    parse?: { parseState: string; parseNote: string | null; format: string | null; autoFields: Row } | null
    /** The already-built check for the references this update brought in. */
    built?: { matches: Row[]; at: string } | null
  },
): Promise<void> {
  const sets: string[] = ['updatedAt = :now']
  const values: Record<string, unknown> = { ':now': update.at, ':was': String(row.updatedAt ?? '') }
  if (update.attachments) { sets.push('attachments = :att'); values[':att'] = update.attachments }
  if (update.fields) { sets.push('fields = :fields'); values[':fields'] = update.fields }
  if (update.meta) { sets.push('meta = :meta'); values[':meta'] = update.meta }
  if (update.missingFields) { sets.push('missingFields = :missing'); values[':missing'] = update.missingFields }
  const removes: string[] = []
  if (update.built) { sets.push('alreadyBuilt = :built', 'alreadyBuiltCheckedAt = :builtAt'); values[':built'] = update.built.matches; values[':builtAt'] = update.built.at }
  if (update.parse) {
    sets.push('parseState = :ps', 'format = :fmt', 'autoFields = :auto')
    values[':ps'] = update.parse.parseState; values[':fmt'] = update.parse.format; values[':auto'] = update.parse.autoFields
    if (update.parse.parseNote == null) removes.push('parseNote'); else { sets.push('parseNote = :pn'); values[':pn'] = update.parse.parseNote }
  }
  await dynamo.send(new UpdateItemCommand({
    TableName: INTAKE_LOAD_TABLE_NAME,
    Key: marshall({ id: String(row.id) }),
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
    ConditionExpression: 'attribute_exists(id) AND updatedAt = :was',
    ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
  }))
}

/**
 * The OPEN / MOVED / DISMISSED row, if any, that is the same e-mail as `mail` (see src/lib/intakeDup.ts): read through the
 * status + receivedAt index over the few minutes around it, so it never scans the table.
 */
export async function findIntakeDuplicate(mail: { subject: string | null; bodyText: string; receivedAt: string | null }, excludeId: string): Promise<Row | null> {
  const at = Date.parse(String(mail.receivedAt ?? ''))
  if (!INTAKE_LOAD_TABLE_NAME || !Number.isFinite(at)) return null
  const from = new Date(at - DUP_WINDOW_MS).toISOString()
  const to = new Date(at + DUP_WINDOW_MS).toISOString()
  for (const status of ['OPEN', 'MOVED', 'DISMISSED']) {
    const page = await dynamo.send(new QueryCommand({
      TableName: INTAKE_LOAD_TABLE_NAME,
      IndexName: 'intakeLoadsByStatusAndReceivedAt',
      KeyConditionExpression: '#s = :s AND receivedAt BETWEEN :a AND :b',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': { S: status }, ':a': { S: from }, ':b': { S: to } },
    }))
    for (const item of page.Items ?? []) {
      const row = unmarshall(item)
      if (row.id !== excludeId && isSameEmail(mail, { subject: String(row.subject ?? ''), bodyText: String(row.bodyText ?? ''), receivedAt: String(row.receivedAt ?? '') })) return row
    }
  }
  return null
}

/**
 * Record a repeat e-mail on an existing row. A dismissed row comes back to OPEN (a Batory tender always shows in the queue);
 * a row already built (MOVED) just keeps the log. Conditioned on the row not having moved on meanwhile.
 */
export async function logRepeatEmail(row: Row, entry: { at: string; subject: string; runId: string }): Promise<void> {
  const reopen = row.status === 'DISMISSED' && !isDeletedIntake(row)
  await dynamo.send(new UpdateItemCommand({
    TableName: INTAKE_LOAD_TABLE_NAME,
    Key: marshall({ id: String(row.id) }),
    UpdateExpression: `SET emailLog = list_append(if_not_exists(emailLog, :empty), :e), updatedAt = :now${reopen ? ', #s = :open' : ''}${reopen ? ' REMOVE dismissedBy, dismissedAt, dismissReason' : ''}`,
    ConditionExpression: 'attribute_exists(id) AND #s = :was',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({ ':empty': [], ':e': [entry], ':now': entry.at, ':was': String(row.status), ...(reopen ? { ':open': 'OPEN' } : {}) }),
  }))
}
