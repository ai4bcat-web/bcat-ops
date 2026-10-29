/**
 * Step J — BCAT's own public API, and the inbound webhook receipt, kept out of the
 * handler so the handler stays a router.
 *
 * Three routes, one door each:
 *   POST /api/token                      — client credentials in, a one-hour bearer out
 *   GET  /api/v1/shipments/<number>      — one shipment, as a customer's system reads it
 *   POST /api/webhooks/<provider>        — a signed delivery from a provider, receipted
 *
 * What this file may not do is as important as what it does.
 *
 * • It writes nothing but the `Integration` table. No Shipment, Load, Order,
 *   Carrier, Invoice or FactoringItem is created, updated or voided here, and the
 *   Lambda has no grant that would let it — a webhook in step J is a *receipt*, not
 *   a consumer. Acting on what a provider says is step K's Workflows, behind the
 *   release gate where it belongs.
 * • It answers a voided shipment with `status: 'VOIDED'`, never 404: a PRO is
 *   permanent and an outside system must not be told the freight never existed.
 * • Every refusal that could tell an attacker something — a wrong secret, an
 *   unknown client, a revoked one; an unknown provider, a disconnected one, one
 *   with no webhook secret — answers with one wording, the `LINK_GONE` convention
 *   this Lambda already follows.
 *
 * Imports are relative: the public tracking Lambda bundles `src/lib` by path.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { SSMClient } from '@aws-sdk/client-ssm'
import { GetParameterCommand } from '@aws-sdk/client-ssm'
import {
  TOKEN_TTL_SECONDS,
  clientSecretMatches,
  shipmentApiView,
  tokenFor,
  verifyToken,
  type ApiLoadInput,
  type ApiReferenceInput,
  type ApiStopInput,
} from '../_shared/openApi'
import { WEBHOOK_TOLERANCE_SECONDS, verifyWebhookSignature, webhookEventId } from '../_shared/webhook'

type Row = Record<string, unknown>

/** What a route hands back; the handler is still the only place a response is built. */
export interface ApiReply {
  status: number
  body: unknown
}

export interface ApiDeps {
  ddb: DynamoDBDocumentClient
  ssm: SSMClient
  integrationTable: string
  shipmentTable: string
  loadTable: string
  orderTable: string
  /** Full SSM name of the OPENAPI parameter: the signing key and the client hashes. */
  openApiParamName: string
  /** `/bcat/integrations/<userPoolId>` — a provider's own parameter hangs off it. */
  integrationParamPath: string
}

const IDX_LOADS_BY_SHIPMENT = 'loadsByShipmentId'
const IDX_ORDERS_BY_SHIPMENT = 'ordersByShipmentId'
const IDX_SHIPMENTS_BY_NUMBER = 'shipmentsByNumber'

/** One wording for a wrong secret, an unknown client and a revoked one. */
const BAD_CLIENT = 'Invalid client credentials'
/** One wording for a missing, malformed, forged or expired bearer token. */
const BAD_TOKEN = 'Invalid or expired access token'
const NO_SCOPE = 'This token does not carry the READ scope'
const NO_SHIPMENT = 'No shipment with that number'
const NOT_CONFIGURED = 'The public API is not configured'
const TOO_MANY = 'This API client has made too many requests today'
/** One wording for an unknown provider, a disconnected one, and one with no secret. */
const NO_WEBHOOK = 'No webhook endpoint for that provider'
/** One wording for a bad signature, a malformed header and a replayed timestamp. */
const BAD_DELIVERY = 'That delivery could not be verified'

/**
 * A day's worth of calls for one client. A customer's TMS polling every shipment it
 * has open all day does not come close; a script in a loop does, within a minute.
 */
const MAX_REQUESTS_PER_DAY = 10_000

/** SSM is read at most once a minute per parameter — a miss is cached too, so a probe cannot hammer it. */
const PARAM_CACHE_MS = 60_000

interface CachedParam {
  value: string | null
  readAt: number
}

const paramCache = new Map<string, CachedParam>()

/** Tests load the module once and then need a cold parameter store. */
export function resetParamCache(): void {
  paramCache.clear()
}

async function readParameter(deps: ApiDeps, name: string): Promise<string | null> {
  const cached = paramCache.get(name)
  if (cached && Date.now() - cached.readAt < PARAM_CACHE_MS) return cached.value
  let value: string | null
  try {
    const out = await deps.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    value = out.Parameter?.Value ?? null
  } catch (err) {
    // ParameterNotFound is "nobody has configured this yet" and is cached; anything
    // else (throttling, a denied read) is a fault, and must not be remembered as
    // "unconfigured" for the next minute.
    if ((err as { name?: string } | null)?.name !== 'ParameterNotFound') throw err
    value = null
  }
  paramCache.set(name, { value, readAt: Date.now() })
  return value
}

/** What the OPENAPI parameter holds: the token signing key, and one hash per client. */
interface OpenApiConfig {
  signingKey: string
  clients: Record<string, { hash?: string } | undefined>
}

async function openApiConfig(deps: ApiDeps): Promise<OpenApiConfig | null> {
  const raw = await readParameter(deps, deps.openApiParamName)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { signingKey, clients } = parsed as Record<string, unknown>
  if (typeof signingKey !== 'string' || !signingKey) return null
  return {
    signingKey,
    clients: (clients && typeof clients === 'object' ? clients : {}) as OpenApiConfig['clients'],
  }
}

async function getRow(deps: ApiDeps, table: string, key: Row): Promise<Row | null> {
  const out = await deps.ddb.send(new GetCommand({ TableName: table, Key: key }))
  return (out.Item as Row | undefined) ?? null
}

/** The client's row, if it is still allowed to call at all. */
function usableClient(row: Row | null, nowIso: string): Row | null {
  if (!row || row.kind !== 'API_CLIENT') return null
  if (typeof row.revokedAt === 'string' && row.revokedAt) return null
  if (typeof row.expiresAt === 'string' && row.expiresAt && row.expiresAt <= nowIso) return null
  return row
}

/**
 * One more call on this client's budget, or false when today's is spent.
 *
 * The counter is a day bucket held on the client's own row: the common path is a
 * single conditioned ADD, and only the first call after midnight pays for the
 * second write that rolls the bucket over. No new table, and no read-then-write
 * race — the condition is the guard.
 */
async function countApiRequest(deps: ApiDeps, clientId: string, nowIso: string): Promise<boolean> {
  const day = nowIso.slice(0, 10)
  try {
    await deps.ddb.send(new UpdateCommand({
      TableName: deps.integrationTable,
      Key: { id: `api:${clientId}` },
      UpdateExpression: 'SET lastUsedAt = :now, usageDay = :day ADD requestCount :one',
      ConditionExpression: 'usageDay = :day AND requestCount < :max',
      ExpressionAttributeValues: { ':now': nowIso, ':day': day, ':one': 1, ':max': MAX_REQUESTS_PER_DAY },
    }))
    return true
  } catch (err) {
    if ((err as { name?: string } | null)?.name !== 'ConditionalCheckFailedException') throw err
  }
  try {
    await deps.ddb.send(new UpdateCommand({
      TableName: deps.integrationTable,
      Key: { id: `api:${clientId}` },
      UpdateExpression: 'SET lastUsedAt = :now, usageDay = :day, requestCount = :one',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(usageDay) OR usageDay <> :day)',
      ExpressionAttributeValues: { ':now': nowIso, ':day': day, ':one': 1 },
    }))
    return true
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

export interface FnUrlRequest {
  body?: string
  isBase64Encoded?: boolean
  headers?: Record<string, string | undefined>
}

function rawBodyOf(event: FnUrlRequest): string {
  if (!event.body) return ''
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body
}

function headerOf(event: FnUrlRequest, name: string): string | null {
  const headers = event.headers ?? {}
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value
  }
  return null
}

// ── POST /api/token ─────────────────────────────────────────────────────────

interface ClientCredentials {
  clientId: string
  clientSecret: string
  grantType: string
}

/**
 * The credentials, from wherever the client put them: a JSON body, or the Basic
 * header an OAuth library sends by default. The header wins — a client that signs
 * its request should not also have to trust its own body.
 */
function readCredentials(event: FnUrlRequest): ClientCredentials | null {
  let body: Record<string, unknown> = {}
  const raw = rawBodyOf(event)
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  let clientId = typeof body.client_id === 'string' ? body.client_id : ''
  let clientSecret = typeof body.client_secret === 'string' ? body.client_secret : ''

  const auth = headerOf(event, 'authorization') ?? ''
  if (/^basic /i.test(auth)) {
    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf-8')
    const at = decoded.indexOf(':')
    if (at < 0) return null
    clientId = decodeURIComponent(decoded.slice(0, at))
    clientSecret = decodeURIComponent(decoded.slice(at + 1))
  }

  const grantType = typeof body.grant_type === 'string' ? body.grant_type : ''
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, grantType }
}

export async function tokenRoute(deps: ApiDeps, event: FnUrlRequest, nowIso: string): Promise<ApiReply> {
  const config = await openApiConfig(deps)
  if (!config) return { status: 503, body: { error: NOT_CONFIGURED } }

  const credentials = readCredentials(event)
  if (!credentials) return { status: 401, body: { error: BAD_CLIENT } }
  if (credentials.grantType && credentials.grantType !== 'client_credentials') {
    return { status: 400, body: { error: 'Only grant_type=client_credentials is supported' } }
  }

  // The row says whether this client may still call; the parameter holds the hash.
  // A client that is unknown to either answers exactly like a wrong secret.
  const row = usableClient(await getRow(deps, deps.integrationTable, { id: `api:${credentials.clientId}` }), nowIso)
  const hash = config.clients[credentials.clientId]?.hash ?? ''
  if (!row || !clientSecretMatches(credentials.clientSecret, hash)) {
    return { status: 401, body: { error: BAD_CLIENT } }
  }

  const scopes = Array.isArray(row.scopes) ? (row.scopes as unknown[]).filter((s): s is string => typeof s === 'string') : []
  if (!(await countApiRequest(deps, credentials.clientId, nowIso))) {
    return { status: 429, body: { error: TOO_MANY } }
  }

  return {
    status: 200,
    body: {
      access_token: tokenFor(credentials.clientId, scopes, config.signingKey, nowIso),
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: scopes.join(' '),
    },
  }
}

// ── GET /api/v1/shipments/<number> ──────────────────────────────────────────

async function queryIndex(deps: ApiDeps, table: string, index: string, key: string, value: string): Promise<Row[]> {
  const out: Row[] = []
  let token: Row | undefined
  do {
    const page = await deps.ddb.send(new QueryCommand({
      TableName: table,
      IndexName: index,
      KeyConditionExpression: '#k = :k',
      ExpressionAttributeNames: { '#k': key },
      ExpressionAttributeValues: { ':k': value },
      ExclusiveStartKey: token as Record<string, never> | undefined,
    }))
    out.push(...((page.Items ?? []) as Row[]))
    token = page.LastEvaluatedKey as Row | undefined
  } while (token)
  return out
}

/** AWSJSON comes back as a list, or as a string when something double-encoded it. */
function parseJson<T>(value: unknown): T | null {
  let v: unknown = value
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { return null }
  }
  return v == null ? null : (v as T)
}

export async function shipmentRoute(deps: ApiDeps, number: string, event: FnUrlRequest, nowIso: string): Promise<ApiReply> {
  const config = await openApiConfig(deps)
  if (!config) return { status: 503, body: { error: NOT_CONFIGURED } }

  const auth = headerOf(event, 'authorization') ?? ''
  if (!/^bearer /i.test(auth)) return { status: 401, body: { error: BAD_TOKEN } }
  const check = verifyToken(auth.slice(7).trim(), config.signingKey, nowIso)
  if (!check.ok) return { status: 401, body: { error: BAD_TOKEN } }
  if (!check.scopes.includes('READ')) return { status: 403, body: { error: NO_SCOPE } }

  // A revoked client's unexpired token dies here: the row is the live answer.
  const row = usableClient(await getRow(deps, deps.integrationTable, { id: `api:${check.clientId}` }), nowIso)
  if (!row) return { status: 401, body: { error: BAD_TOKEN } }
  if (!(await countApiRequest(deps, check.clientId, nowIso))) return { status: 429, body: { error: TOO_MANY } }

  const rows = await queryIndex(deps, deps.shipmentTable, IDX_SHIPMENTS_BY_NUMBER, 'number', number)
  // One number, one shipment. Two rows answering to one PRO is a mint bug, and
  // guessing which one the caller meant is how the wrong freight gets reported.
  if (rows.length !== 1) return { status: 404, body: { error: NO_SHIPMENT } }
  const shipment = rows[0]

  const [loadRows, orderRows] = await Promise.all([
    queryIndex(deps, deps.loadTable, IDX_LOADS_BY_SHIPMENT, 'shipmentId', String(shipment.id)),
    queryIndex(deps, deps.orderTable, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', String(shipment.id)),
  ])

  const loads: ApiLoadInput[] = loadRows.map((load) => ({ id: String(load.id), leg: Number(load.leg ?? 0) }))
  const stops: ApiStopInput[] = []
  for (const load of loadRows) {
    for (const stop of parseJson<ApiStopInput[]>(load.stops) ?? []) {
      stops.push({ ...stop, loadId: String(load.id) })
    }
  }
  const references: ApiReferenceInput[] = []
  for (const order of orderRows) {
    for (const ref of parseJson<ApiReferenceInput[]>(order.references) ?? []) references.push(ref)
  }

  return {
    status: 200,
    body: shipmentApiView(
      {
        number: String(shipment.number),
        status: String(shipment.status),
        mode: typeof shipment.mode === 'string' ? shipment.mode : null,
        voidedAt: typeof shipment.voidedAt === 'string' ? shipment.voidedAt : null,
      },
      loads,
      stops,
      { references, nowIso },
    ),
  }
}

// ── POST /api/webhooks/<provider> ───────────────────────────────────────────

/**
 * A signed delivery from a provider, receipted and nothing more.
 *
 * Step J proves the three things Ryne asked for and stops: the signature is ours,
 * the delivery is recent, and a redelivery of the same event writes nothing twice.
 * The dedupe row and the two counters on the provider's own row are the *only*
 * writes — consuming what the provider said (a status, a document, a rate) is step
 * K, through the actions that already own those records.
 */
export async function webhookRoute(deps: ApiDeps, provider: string, event: FnUrlRequest, nowIso: string): Promise<ApiReply> {
  const key = provider.toUpperCase()
  const row = await getRow(deps, deps.integrationTable, { id: key })
  if (!row || row.kind !== 'PROVIDER' || row.status !== 'CONNECTED') {
    return { status: 404, body: { error: NO_WEBHOOK } }
  }

  // The signing secret lives in a parameter of its own — `<PROVIDER>/webhook` —
  // so this public Lambda can decrypt what verifies a delivery and nothing else:
  // the DAT password, the HubSpot token and the QBO refresh token stay in
  // `<PROVIDER>`, which it has no grant to read.
  const raw = await readParameter(deps, `${deps.integrationParamPath}/${key}/webhook`)
  let secret = ''
  if (raw) {
    const parsed = parseJson<Record<string, unknown>>(raw)
    const value = parsed?.webhookSigningSecret
    if (typeof value === 'string') secret = value
  }
  if (!secret) return { status: 404, body: { error: NO_WEBHOOK } }

  const rawBody = rawBodyOf(event)
  const verified = verifyWebhookSignature({
    header: headerOf(event, 'x-bcat-signature'),
    rawBody,
    secret,
    nowIso,
  })
  if (!verified.ok) return { status: 401, body: { error: BAD_DELIVERY } }

  const eventId = webhookEventId(rawBody)
  try {
    await deps.ddb.send(new PutCommand({
      TableName: deps.integrationTable,
      Item: {
        id: `evt:${key}:${eventId}`,
        provider: key,
        kind: 'WEBHOOK_EVENT',
        receivedAt: nowIso,
        signedAt: new Date(verified.timestamp * 1000).toISOString(),
        // A receipt only has to outlive the window a redelivery can still arrive
        // in — the signature is good for ±`WEBHOOK_TOLERANCE_SECONDS`, so a
        // duplicate of a delivery accepted at the far edge of that window can land
        // one whole window later. Twice the tolerance, then DynamoDB sweeps it.
        ttlEpoch: Math.floor(Date.parse(nowIso) / 1000) + WEBHOOK_TOLERANCE_SECONDS * 2,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      ConditionExpression: 'attribute_not_exists(id)',
    }))
  } catch (err) {
    // The same delivery, again. That is what idempotent means: it is not an error,
    // and the provider's row does not move a second time.
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') {
      return { status: 200, body: { ok: true, duplicate: true, eventId } }
    }
    throw err
  }

  await deps.ddb.send(new UpdateCommand({
    TableName: deps.integrationTable,
    Key: { id: key },
    UpdateExpression: 'SET lastWebhookAt = :now, updatedAt = :now ADD webhookCount :one',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':now': nowIso, ':one': 1 },
  }))

  return { status: 200, body: { ok: true, duplicate: false, eventId } }
}
