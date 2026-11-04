/**
 * Step N2 — MyCarrierPackets sync Lambda. MyCarrierPackets is the source of truth for a
 * carrier's compliance profile; this is the one function that writes it.
 *
 * Invocations:
 *  - EventBridge (every 30 min; disabled on dev by the stack guard): continues a partial
 *    backfill, or — once a backfill has finished — polls CarriersChanges (MCP asks for no less
 *    than 4 minutes between calls; there are no webhooks) and pulls the full profile of every
 *    carrier whose packet just completed. It never *starts* the first backfill: that is the
 *    "Pull all monitored carriers now" button.
 *  - { kind: 'PULL_ALL', startedBy, restart? }   (async, from the Integrations page): a slice of
 *    the backfill over MCP's monitored list; resumes a partial run unless `restart`.
 *  - { kind: 'PULL_ONE', carrierId }             (sync): one carrier, full profile.
 *  - { kind: 'ADD_CARRIER', mcNumber?, dotNumber? } (sync, Find & Invite): create the row from MCP unless one matches.
 *  - { kind: 'IMPORT_BATCH', carrierIds, ... }   (sync, from the Aljex import router).
 *
 * Every path refuses unless the MYCARRIERPACKETS row reports LIVE and healthy, and every path
 * is lookup-and-write only: it never invites a carrier.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import { heartbeatUpdate, MCP_INTEGRATION_ID } from './heartbeat'
import { fetchMcpCarrierRaw, listCarrierChanges, listCompletedPackets, listMonitoredCarriers } from '../../../src/lib/integrations/mcpAdapter'
import { mcpSyncRefusal, mcpUpdateItem } from '../../../src/lib/integrations/mcpBatchSync'
import { normalizeMcpProfile } from '../../../src/lib/integrations/mcpProfile'
import { advanceAfterCarrierActive, type LadderDeps } from '../../../src/lib/integrations/mcpLadder'
import {
  addCarrierFromMcp, newPullState, pullOneCarrier, runBackfillSlice, runChangesPoll, MCP_PULL_ACTOR,
  type McpPullDeps, type McpPullState,
} from '../../../src/lib/integrations/mcpPull'

const ssm = new SSMClient({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

const CARRIER_TABLE_NAME = process.env.CARRIER_TABLE_NAME ?? ''
const CONTACT_TABLE_NAME = process.env.CARRIER_CONTACT_TABLE_NAME ?? ''
const PAYMENT_TABLE_NAME = process.env.CARRIER_PAYMENT_METHOD_TABLE_NAME ?? ''
const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
const INTEGRATION_TABLE_NAME = process.env.INTEGRATION_TABLE_NAME ?? ''
const INTEGRATION_PARAM_PATH = process.env.INTEGRATION_PARAM_PATH ?? ''
// Step AM: an assignment waiting on carrier setup advances when MCP activates the carrier.
const LOAD_CARRIER_TABLE_NAME = process.env.LOAD_CARRIER_TABLE_NAME ?? ''
const SHIPMENT_TABLE_NAME = process.env.SHIPMENT_TABLE_NAME ?? ''
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''

/** The one key a webhook parameter carries; never part of the API credentials. */
const WEBHOOK_SECRET_KEY = 'webhookSigningSecret'
/** Pull progress, kept beside the provider row. The Integrations page reads it. */
export const PULL_STATE_ID = `pull:${MCP_INTEGRATION_ID}`
const NOT_LIVE = 'MyCarrierPackets is not LIVE (Integrations > MyCarrierPackets > Validate)'
const RUN_BUDGET_MS = 230_000
const LOCK_MS = 290_000
const MAX_CARRIERS_PER_SLICE = 400

type Row = Record<string, unknown>

async function readMcpCredentials(): Promise<Record<string, string> | null> {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: `${INTEGRATION_PARAM_PATH}/MYCARRIERPACKETS`, WithDecryption: true }))
    const raw = result.Parameter?.Value
    if (!raw) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (key !== WEBHOOK_SECRET_KEY && typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return null
  }
}

async function readRow(id: string): Promise<Row | null> {
  const got = await ddb.send(new GetCommand({ TableName: INTEGRATION_TABLE_NAME, Key: { id }, ConsistentRead: true }))
  return (got.Item as Row | undefined) ?? null
}

async function readState(): Promise<McpPullState | null> {
  const row = await readRow(PULL_STATE_ID)
  return row && typeof row.state === 'string' ? (JSON.parse(row.state) as McpPullState) : null
}

async function saveState(state: McpPullState, now: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: INTEGRATION_TABLE_NAME,
    Key: { id: PULL_STATE_ID },
    UpdateExpression: 'SET #state = :s, kind = :k, provider = :p, updatedAt = :u REMOVE lockUntil',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: { ':s': JSON.stringify(state), ':k': 'SYNC_STATE', ':p': MCP_INTEGRATION_ID, ':u': now },
  }))
}

/** One slice at a time: a second invocation while one runs is refused, a crashed one expires. */
async function takeLock(nowMs: number): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: INTEGRATION_TABLE_NAME,
      Key: { id: PULL_STATE_ID },
      UpdateExpression: 'SET lockUntil = :l, kind = :k, provider = :p',
      ConditionExpression: 'attribute_not_exists(lockUntil) OR lockUntil < :now',
      ExpressionAttributeValues: { ':l': nowMs + LOCK_MS, ':now': nowMs, ':k': 'SYNC_STATE', ':p': MCP_INTEGRATION_ID },
    }))
    return true
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false
    throw err
  }
}

async function releaseLock(): Promise<void> {
  await ddb.send(new UpdateCommand({ TableName: INTEGRATION_TABLE_NAME, Key: { id: PULL_STATE_ID }, UpdateExpression: 'REMOVE lockUntil' })).catch(() => undefined)
}

/**
 * Stamp the Integration row so the app can show "last sync". Best-effort: a failed stamp
 * must never fail an otherwise good sync run.
 */
async function writeHeartbeat(ok: number, failed: number, now: string): Promise<void> {
  const update = heartbeatUpdate([...Array(ok).fill({ ok: true }), ...Array(failed).fill({ ok: false })], now)
  if (!update || !INTEGRATION_TABLE_NAME) return
  try {
    await ddb.send(new UpdateCommand({
      TableName: INTEGRATION_TABLE_NAME,
      Key: { id: MCP_INTEGRATION_ID },
      // Never create a partial row (it would break the Integration list): stamp only an existing one.
      ConditionExpression: 'attribute_exists(id)',
      UpdateExpression: 'SET lastCheckAt = :c, lastOkAt = :o, healthDetail = :d, updatedAt = :u',
      ExpressionAttributeValues: { ':c': update.lastCheckAt, ':o': update.lastOkAt, ':d': update.healthDetail, ':u': now },
    }))
  } catch (err) {
    console.error('[mcp-sync] heartbeat write failed', err instanceof Error ? err.message : String(err))
  }
}

async function queryByCarrier(table: string, index: string, carrierId: string): Promise<Row[]> {
  const out: Row[] = []
  let key: Record<string, unknown> | undefined
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: table, IndexName: index, KeyConditionExpression: 'carrierId = :c',
      ExpressionAttributeValues: { ':c': carrierId }, ExclusiveStartKey: key,
    }))
    out.push(...((page.Items ?? []) as Row[]))
    key = page.LastEvaluatedKey
  } while (key)
  return out
}

function patchUpdate(patch: Row) {
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const sets = Object.entries(patch).map(([k, v], i) => {
    names[`#f${i}`] = k
    values[`:v${i}`] = v
    return `#f${i} = :v${i}`
  })
  return { UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }
}

function ladderDeps(): LadderDeps {
  const put = (TableName: string, Key: Record<string, unknown>, patch: Row, condition?: { expression: string; values: Record<string, unknown> }) =>
    ddb.send(new UpdateCommand({
      TableName, Key, ...patchUpdate(patch),
      ...(condition ? { ConditionExpression: condition.expression, ExpressionAttributeValues: { ...patchUpdate(patch).ExpressionAttributeValues, ...condition.values } } : {}),
    }))
  return {
    assignmentsOf: (carrierId) => queryByCarrier(LOAD_CARRIER_TABLE_NAME, 'loadCarriersByCarrierId', carrierId),
    advance: async (row, patch) => {
      try {
        await put(LOAD_CARRIER_TABLE_NAME, { id: String(row.id) }, patch, { expression: 'assignmentStatus = :was', values: { ':was': row.assignmentStatus } })
        return 'WRITTEN'
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'CONFLICT'
        throw err
      }
    },
    mirror: async (row, status) => {
      const at = new Date().toISOString()
      if (row.shipmentId) await put(SHIPMENT_TABLE_NAME, { id: String(row.shipmentId) }, { carrierAssignmentStatus: status, updatedAt: at })
      if (row.loadId) await put(LOAD_TABLE_NAME, { id: String(row.loadId) }, { carrierAssignmentStatus: status, updatedAt: at })
    },
    audit: async (entityId, action, changes) => {
      if (!AUDIT_LOG_TABLE_NAME) return
      const now = new Date().toISOString()
      await ddb.send(new PutCommand({
        TableName: AUDIT_LOG_TABLE_NAME,
        Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'LOAD_CARRIER', entityId, action, user: MCP_PULL_ACTOR, changes: JSON.stringify(changes), createdAt: now, updatedAt: now },
      }))
    },
  }
}

function pullDeps(credentials: Record<string, string>): McpPullDeps {
  const profileOf = (raw: unknown) => normalizeMcpProfile(raw)
  return {
    loadCarriers: async () => {
      const out: Row[] = []
      let key: Record<string, unknown> | undefined
      do {
        const page = await ddb.send(new ScanCommand({ TableName: CARRIER_TABLE_NAME, ExclusiveStartKey: key }))
        out.push(...((page.Items ?? []) as Row[]))
        key = page.LastEvaluatedKey
      } while (key)
      return out
    },
    writeCarrier: async (carrier, patch) => {
      try {
        await ddb.send(new UpdateCommand({ TableName: CARRIER_TABLE_NAME, Key: { id: carrier.id as string }, ...mcpUpdateItem(carrier, patch, new Date().toISOString()) }))
        return 'WRITTEN'
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'CONFLICT'
        throw err
      }
    },
    reloadCarrier: async (id) => {
      const got = await ddb.send(new GetCommand({ TableName: CARRIER_TABLE_NAME, Key: { id }, ConsistentRead: true }))
      return (got.Item as Row | undefined) ?? null
    },
    createCarrier: async (row) => {
      await ddb.send(new PutCommand({ TableName: CARRIER_TABLE_NAME, Item: row, ConditionExpression: 'attribute_not_exists(id)' }))
    },
    loadContacts: (carrierId) => queryByCarrier(CONTACT_TABLE_NAME, 'carrierContactsByCarrierId', carrierId),
    putContact: async (row) => { await ddb.send(new PutCommand({ TableName: CONTACT_TABLE_NAME, Item: row })) },
    updateContact: async (id, patch) => { await ddb.send(new UpdateCommand({ TableName: CONTACT_TABLE_NAME, Key: { id }, ...patchUpdate(patch) })) },
    loadPayments: (carrierId) => queryByCarrier(PAYMENT_TABLE_NAME, 'carrierPaymentMethodsByCarrierId', carrierId),
    putPayment: async (row) => { await ddb.send(new PutCommand({ TableName: PAYMENT_TABLE_NAME, Item: row })) },
    updatePayment: async (id, patch) => { await ddb.send(new UpdateCommand({ TableName: PAYMENT_TABLE_NAME, Key: { id }, ...patchUpdate(patch) })) },
    audit: async ({ entityId, action, changes }) => {
      if (!AUDIT_LOG_TABLE_NAME) return
      const now = new Date().toISOString()
      await ddb.send(new PutCommand({
        TableName: AUDIT_LOG_TABLE_NAME,
        Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'CARRIER', entityId, action, user: MCP_PULL_ACTOR, changes: JSON.stringify(changes), createdAt: now, updatedAt: now },
      }))
    },
    listMonitored: (page, size) => listMonitoredCarriers(page, size, credentials),
    fetchProfile: async (ref) => {
      const raw = await fetchMcpCarrierRaw(ref, credentials)
      return raw ? normalizeMcpProfile(raw, ref) : null
    },
    listChanges: async (range, page, size) => {
      const { items, totalPages } = await listCarrierChanges(range, page, size, credentials)
      const profiles = items.flatMap((item) => {
        const p = profileOf(item && typeof item === 'object' && 'CarrierDetails' in item ? (item as Row).CarrierDetails : item)
        return p ? [p] : []
      })
      return { profiles, totalPages }
    },
    listCompleted: async (range) => (await listCompletedPackets(range, credentials)).map((p) => ({ dotNumber: p.dotNumber, docketNumber: p.docketNumber })),
    carrierStatusChanged: async (carrierId, status) => {
      if (status !== 'ACTIVE' || !LOAD_CARRIER_TABLE_NAME) return
      // Best-effort: the carrier write is already committed, and the next sync retries nothing here,
      // so a failure is logged for the operator rather than failing the pull.
      try {
        await advanceAfterCarrierActive(ladderDeps(), { id: carrierId }, new Date().toISOString())
      } catch (err) {
        console.error('[mcp-sync] ladder advance failed', carrierId, err instanceof Error ? err.message : String(err))
      }
    },
    newId: () => randomUUID(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowMs: Date.now,
  }
}

async function gate(): Promise<{ credentials: Record<string, string>; createUnmatched: boolean } | { refusal: string }> {
  const credentials = await readMcpCredentials()
  const row = await readRow(MCP_INTEGRATION_ID)
  const refusal = mcpSyncRefusal(row, credentials)
  if (refusal || !credentials) return { refusal: refusal ?? NOT_LIVE }
  const settings = (row?.settings ?? {}) as Row
  return { credentials, createUnmatched: settings.createUnmatchedCarriers !== false }
}

// ── Invocations ──────────────────────────────────────────────────────────────

interface PullAllEvent { kind: 'PULL_ALL'; startedBy?: string; restart?: boolean }
interface PullOneEvent { kind: 'PULL_ONE'; carrierId: string }
interface AddCarrierEvent { kind: 'ADD_CARRIER'; mcNumber?: string; dotNumber?: string }
interface ImportBatchEvent { kind: 'IMPORT_BATCH'; carrierIds?: string[]; maxLookups?: number; cursor?: { lastCarrierId?: string } | null }
type Event = PullAllEvent | PullOneEvent | AddCarrierEvent | ImportBatchEvent | { kind?: undefined }

/** A slice of the backfill (or a changes poll once it is done). Returns the state it saved. */
async function pullSlice(started: { startedBy: string; restart: boolean } | null): Promise<McpPullState | { refused: string } | { busy: true }> {
  const g = await gate()
  if ('refusal' in g) return { refused: g.refusal }
  if (!(await takeLock(Date.now()))) return { busy: true }
  try {
    const deps = pullDeps(g.credentials)
    const now = new Date().toISOString()
    let state = await readState()
    if (started && (started.restart || !state || state.status === 'DONE' || state.status === 'ERROR')) {
      state = newPullState(randomUUID(), started.startedBy, now, state ?? undefined)
    }
    if (!state) {
      await releaseLock()
      return { refused: 'No backfill has been started. Press "Pull all monitored carriers now".' }
    }
    const options = { createUnmatched: g.createUnmatched, maxCarriers: MAX_CARRIERS_PER_SLICE, deadlineMs: Date.now() + RUN_BUDGET_MS }
    state = state.status === 'DONE' ? await runChangesPoll(deps, state, options) : await runBackfillSlice(deps, state, options)
    await saveState(state, new Date().toISOString())
    const counts = state.status === 'DONE' && state.changesCounts ? state.changesCounts : state.counts
    await writeHeartbeat(counts.created + counts.updated + counts.unchanged, counts.errors, new Date().toISOString())
    return state
  } catch (err) {
    await releaseLock()
    throw err
  }
}

async function pullOne(event: PullOneEvent) {
  const g = await gate()
  if ('refusal' in g) return { ready: false, reason: NOT_LIVE, result: null }
  const result = await pullOneCarrier(pullDeps(g.credentials), event.carrierId, randomUUID())
  return { ready: true, result }
}

/** Find & Invite "Add to carriers" (sync): create the Carrier row from MCP unless one already matches. */
async function addCarrier(event: AddCarrierEvent) {
  const g = await gate()
  if ('refusal' in g) return { ready: false, reason: g.refusal }
  const out = await addCarrierFromMcp(pullDeps(g.credentials), { mcNumber: event.mcNumber, dotNumber: event.dotNumber }, randomUUID())
  return { ready: true, ...out }
}

/**
 * Invoked by the Aljex import router (RequestResponse):
 *   { kind: 'IMPORT_BATCH', carrierIds, maxLookups?, cursor? }
 * → { ready, reason?, results: [{ carrierId, result: 'SYNCED' | 'NO_PACKET' | 'ERROR' }], cursor, done }
 * Ids are processed in the order given; a call stops at its budget or maxLookups.
 */
async function importBatch(event: ImportBatchEvent) {
  const g = await gate()
  if ('refusal' in g) return { ready: false, reason: NOT_LIVE, results: [], cursor: null, done: false }
  const deps = pullDeps(g.credentials)
  const ids = (event.carrierIds ?? []).filter((id): id is string => typeof id === 'string' && id !== '')
  const start = event.cursor?.lastCarrierId ? ids.indexOf(event.cursor.lastCarrierId) + 1 : 0
  const max = Math.min(Math.max(event.maxLookups ?? 40, 1), 200)
  const deadline = Date.now() + RUN_BUDGET_MS
  const runId = randomUUID()
  const results: Array<{ carrierId: string; result: 'SYNCED' | 'NO_PACKET' | 'ERROR' }> = []
  let rateLimited = false
  let i = start
  for (; i < ids.length && results.length < max && Date.now() < deadline; i++) {
    try {
      results.push({ carrierId: ids[i]!, result: await pullOneCarrier(deps, ids[i]!, runId) })
    } catch (err) {
      const kind = (err as { kind?: string }).kind
      if (kind === 'RATE_LIMIT' || kind === 'AUTH') { rateLimited = true; break }
      results.push({ carrierId: ids[i]!, result: 'ERROR' })
    }
    await deps.sleep(250)
  }
  const done = i >= ids.length
  return {
    ready: true, results,
    cursor: done || i === start ? null : { lastCarrierId: ids[i - 1]! },
    done,
    ...(rateLimited ? { reason: 'MyCarrierPackets is rate limiting or refused the credentials; resume later.' } : {}),
  }
}

export const handler = async (event?: Event) => {
  switch (event?.kind) {
    case 'IMPORT_BATCH': return importBatch(event)
    case 'PULL_ONE': return pullOne(event)
    case 'ADD_CARRIER': return addCarrier(event)
    case 'PULL_ALL': {
      const out = await pullSlice({ startedBy: event.startedBy ?? 'admin', restart: event.restart === true })
      return 'status' in out ? { ran: true, status: out.status } : { ran: false, ...out }
    }
    default: {
      // EventBridge: continue a partial backfill, or poll for changes after a finished one.
      const out = await pullSlice(null)
      if ('status' in out) console.log(`[mcp-sync] ${out.status} created ${out.counts.created} updated ${out.counts.updated} unchanged ${out.counts.unchanged} errors ${out.counts.errors}`)
      else console.log(`[mcp-sync] Not running: ${'refused' in out ? out.refused : 'another slice holds the lock'}`)
      return 'status' in out ? { ran: true, status: out.status } : { ran: false, ...out }
    }
  }
}
