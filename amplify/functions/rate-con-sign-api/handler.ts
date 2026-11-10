/**
 * rate-con-sign-api Lambda (Function URL)
 *
 * The carrier signing a rate confirmation has no Cognito account and never touches
 * AppSync. Every request carries the `rateConToken` the SEND_RATE_CON action minted;
 * this Lambda finds the one LoadCarrier row holding that token, scopes everything it
 * answers to that row, and returns nothing about any other load.
 *
 * Request:  POST JSON  { token, action, payload? }
 * Actions:  get | submit | decline
 *
 * The link belongs to ONE version of one rate confirmation. A re-send mints a new token (and version),
 * which kills the old link: opening the old one answers "replaced; use the newest link". Signing keeps
 * the token on the row, so a second submit returns the existing result instead of signing twice.
 *
 * Submit trusts nothing from the browser but the typed name, the agreement tick and the field values:
 * every rule is re-checked here (src/lib/rateConSignValidation.ts, the same module the page uses), and the
 * signed PDF is stamped HERE from the stored unsigned bytes (src/lib/rateConSigned.ts), never uploaded.
 * The result is filed in the load's Documents (ShipmentDocument, type RATE_CON, audience ALL = the Public
 * folder), superseding the previous signed version. Everything is logged to AuditLog (entity LOAD_CARRIER,
 * user CARRIER_PORTAL), refused attempts included. Rate-limited per token via LoadCarrier.rateConRequestCount.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHash, randomUUID } from 'crypto'
import { advanceTarget, driverInfoGaps, isCarrierAssignmentStatus, ladderPatch } from '../../../src/lib/carrierAssignment'
import { buildSignedRateCon } from '../../../src/lib/rateConSigned'
import { cleanName, normalizeFieldValue, signErrors } from '../../../src/lib/rateConSignValidation'
import { generatedKey } from '../../../src/lib/shipmentDocuments'
import { threadKeyFor } from '../../../src/lib/shipmentThread'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const LOAD_CARRIER_TABLE = process.env.LOAD_CARRIER_TABLE_NAME!
const LOAD_TABLE = process.env.LOAD_TABLE_NAME!
const SHIPMENT_TABLE = process.env.SHIPMENT_TABLE_NAME ?? ''
const CARRIER_DOCUMENT_TABLE = process.env.CARRIER_DOCUMENT_TABLE_NAME!
const SHIPMENT_DOCUMENT_TABLE = process.env.SHIPMENT_DOCUMENT_TABLE_NAME!
const DIVISION_TABLE = process.env.DIVISION_TABLE_NAME!
const SETTINGS_TABLE = process.env.SETTINGS_TABLE_NAME!
const AUDIT_TABLE = process.env.AUDIT_LOG_TABLE_NAME!
const SHIPMENT_MESSAGE_TABLE = process.env.SHIPMENT_MESSAGE_TABLE_NAME ?? ''
const BUCKET = process.env.BUCKET_NAME!
const TRACKING_ACTIONS_FUNCTION = process.env.TMS_TRACKING_ACTIONS_FUNCTION_NAME ?? ''
const lambdaClient = new LambdaClient({})

const IDX_DOCUMENTS_BY_SHIPMENT = 'shipmentDocumentsByShipmentIdAndUploadedAt'
const IDX_AUDIT_BY_ENTITY = 'auditLogsByEntityTypeAndEntityId'

const SETTINGS_ID = 'default'

/** A link that gets opened two hundred times is not a carrier reading a rate con. */
const MAX_REQUESTS_PER_TOKEN = 200
/** The body is a name, a tick and a few short fields; anything bigger is not the page. */
const MAX_BODY_BYTES = 64 * 1024
const MAX_UNSIGNED_BYTES = 10 * 1024 * 1024
const PDF_URL_EXPIRY_SECONDS = 900
const MAX_DECLINE_REASON = 500

/**
 * Every issued link is findable by its token hash under this audit entity, so an old link can say
 * "replaced" after its token left the LoadCarrier row (no schema: AuditLog's own entity index).
 */
export const TOKEN_ENTITY = 'RATE_CON_TOKEN'
export const REPLACED_MESSAGE = 'This rate confirmation was replaced; use the newest link'
const CONSENT_TEXT =
  'The signer typed their name, ticked the agreement box and pressed Sign. By doing so they adopted the typed '
  + 'name as their electronic signature and accepted this rate confirmation and its terms.'

/** Still open for signature. Anything else is history, and history is read-only. */
const OPEN_STATUSES = ['SENT', 'OPENED']

/**
 * What the carrier types on the signature page, and the LoadCarrier column it fills.
 * This is also the whitelist: a field the settings ask for but this map does not know
 * cannot be required, because nothing would receive it.
 */
const FIELD_TO_COLUMN: Record<string, string> = {
  DRIVER_NAME: 'driverName',
  DRIVER_PHONE: 'driverPhone',
  TRUCK_NUMBER: 'truckNumber',
  TRAILER_NUMBER: 'trailerNumber',
  PLATES: 'plates',
  VIN: 'vin',
  PICKUP_ETA: 'pickupEtaAt',
}

const FIELD_LABELS: Record<string, string> = {
  DRIVER_NAME: 'Driver name',
  DRIVER_PHONE: 'Driver phone',
  TRUCK_NUMBER: 'Truck #',
  TRAILER_NUMBER: 'Trailer #',
  PLATES: 'Plates',
  VIN: 'VIN',
  PICKUP_ETA: 'Pickup ETA',
}

/**
 * Step AM. Driver name, phone, truck # and trailer # are always required to sign: tracking keys off
 * them, and the carrier is the one who knows. A field the office already entered is not asked again.
 */
const DRIVER_INFO_FIELD_KEYS = ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER']
const DEFAULT_REQUIRED_FIELDS = DRIVER_INFO_FIELD_KEYS

interface FnUrlEvent {
  body?: string | null
  isBase64Encoded?: boolean
  headers?: Record<string, string>
  requestContext?: { http?: { method?: string; sourceIp?: string; userAgent?: string } }
}

interface LoadCarrierRow {
  id: string
  loadId: string
  shipmentId: string
  carrierId?: string | null
  carrierName?: string | null
  carrierRateCents?: number | null
  costCents?: number | null
  rateConStatus?: string | null
  rateConToken?: string | null
  rateConExpiresAt?: string | null
  rateConVersion?: number | null
  rateConDocumentId?: string | null
  rateConRequestCount?: number | null
  [key: string]: unknown
}

/** What the request itself tells us about who is on the other end. */
interface Client { ip: string; userAgent: string; location: string | null }

// CORS is owned by the Lambda Function URL's own CORS config (see backend.ts) — it
// echoes the matching Origin and handles preflight. We must NOT also set
// Access-Control-* here, or the browser sees a duplicated header and blocks the call.
function reply(status: number, body: unknown) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

class PortalError extends Error {
  constructor(public status: number, message: string, public code?: string, public fieldErrors?: Record<string, string>) { super(message) }
}

async function scan(table: string, filter: string, names: Record<string, string>, values: Record<string, unknown>) {
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table, FilterExpression: filter,
      // DynamoDB rejects an empty ExpressionAttributeNames — only include it when used.
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ExclusiveStartKey: lastKey,
    }))
    if (res.Items) items.push(...(res.Items as Record<string, unknown>[]))
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)
  return items
}

async function query(table: string, indexName: string, keyField: string, keyValue: string, sortField?: string, sortValue?: string) {
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table, IndexName: indexName,
      KeyConditionExpression: sortField ? '#k = :k AND #s = :s' : '#k = :k',
      ExpressionAttributeNames: { '#k': keyField, ...(sortField ? { '#s': sortField } : {}) },
      ExpressionAttributeValues: { ':k': keyValue, ...(sortField ? { ':s': sortValue } : {}) },
      ExclusiveStartKey: lastKey,
    }))
    if (res.Items) items.push(...(res.Items as Record<string, unknown>[]))
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)
  return items
}

async function getRow(table: string, key: Record<string, unknown>) {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key }))
  return (res.Item as Record<string, unknown> | undefined) ?? null
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

async function audit(entityId: string, action: string, changes: Record<string, unknown>, entityType = 'LOAD_CARRIER') {
  const now = new Date().toISOString()
  await ddb.send(new PutCommand({
    TableName: AUDIT_TABLE,
    Item: { id: randomUUID(), __typename: 'AuditLog', entityType, entityId, action, user: 'CARRIER_PORTAL', changes: JSON.stringify(changes), createdAt: now, updatedAt: now },
  }))
}

/** An audit write must never turn a carrier's answer into a 500 after the answer was recorded. */
async function auditQuietly(entityId: string, action: string, changes: Record<string, unknown>) {
  try {
    await audit(entityId, action, changes)
  } catch (err) {
    console.error('[rate-con-sign-api] audit failed', action, err instanceof Error ? err.message : String(err))
  }
}

function parseChanges(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Viewer location from the headers CloudFront (or an API Gateway front) adds. No external geo lookups. */
function locationOf(headers: Record<string, string> | undefined): string | null {
  const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const parts = [h['cloudfront-viewer-city'], h['cloudfront-viewer-country-region-name'] ?? h['cloudfront-viewer-country-region'], h['cloudfront-viewer-country-name'] ?? h['cloudfront-viewer-country']]
    .map((p) => (p ?? '').trim()).filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/** What goes on every refused-attempt audit row. Never the typed values. */
const clientInfo = (c: Client) => ({ ip: c.ip, userAgent: c.userAgent, location: c.location })

/**
 * Find the assignment this link belongs to.
 *
 * A Scan, not an index: LoadCarrier already spends its one new secondary index on
 * `carrierId`, and a token lookup happens a handful of times per rate con.
 */
async function findByToken(token: string): Promise<LoadCarrierRow | null> {
  const rows = await scan(LOAD_CARRIER_TABLE, '#t = :t', { '#t': 'rateConToken' }, { ':t': token })
  // One token, one assignment. Two rows answering to the same token is a mint bug,
  // and guessing which one the carrier meant is how the wrong load gets signed.
  if (rows.length > 1) throw new PortalError(409, 'This rate confirmation link is ambiguous. Please ask your broker to re-send it.')
  return (rows[0] as unknown as LoadCarrierRow | undefined) ?? null
}

/**
 * A token no row holds: an unknown guess (404, nothing recorded: unknown tokens have no entity to
 * log under), or an issued link that a newer send replaced (410 REPLACED, logged against the assignment).
 */
async function explainMissingToken(token: string, client: Client): Promise<never> {
  const issued = (await query(AUDIT_TABLE, IDX_AUDIT_BY_ENTITY, 'entityType', TOKEN_ENTITY, 'entityId', tokenHash(token)))
    .find((r) => r.action === 'rate_con_link_issued')
  if (issued) {
    const info = parseChanges(issued.changes)
    const loadCarrierId = String(info.loadCarrierId ?? '')
    const issuedVersion = Number(info.version ?? 0)
    const row = loadCarrierId ? await getRow(LOAD_CARRIER_TABLE, { id: loadCarrierId }) : null
    if (row && Number(row.rateConVersion ?? 0) > issuedVersion) {
      await auditQuietly(loadCarrierId, 'rate_con_link_rejected', { reason: 'SUPERSEDED', linkVersion: issuedVersion, currentVersion: Number(row.rateConVersion), ...clientInfo(client) })
      throw new PortalError(410, REPLACED_MESSAGE, 'REPLACED')
    }
    if (row) {
      await auditQuietly(loadCarrierId, 'rate_con_link_rejected', { reason: 'NO_LONGER_OPEN', linkVersion: issuedVersion, status: row.rateConStatus ?? null, ...clientInfo(client) })
      throw new PortalError(410, 'This rate confirmation is no longer open.')
    }
  }
  throw new PortalError(404, 'This rate confirmation link is invalid or has expired.')
}

/**
 * Resolve and check a link. `allowSigned` lets a SIGNED row through (the page shows the result, a second
 * submit replays it); every other non-open state is a refusal, logged against the assignment.
 */
async function validateToken(token: string, client: Client, allowSigned = false): Promise<LoadCarrierRow> {
  if (!token) throw new PortalError(400, 'Missing token')
  const row = await findByToken(token)
  if (!row) return explainMissingToken(token, client)
  const status = String(row.rateConStatus ?? '')
  const version = Number(row.rateConVersion ?? 1)
  if (status === 'SIGNED' && allowSigned) return row
  if (!OPEN_STATUSES.includes(status)) {
    await auditQuietly(row.id, 'rate_con_link_rejected', { reason: status === 'SIGNED' ? 'ALREADY_SIGNED' : 'NO_LONGER_OPEN', status, version, ...clientInfo(client) })
    if (status === 'SIGNED' || status === 'DECLINED') throw new PortalError(409, 'This rate confirmation has already been answered.')
    throw new PortalError(410, 'This rate confirmation is no longer open.')
  }
  if (row.rateConExpiresAt && new Date(String(row.rateConExpiresAt)).getTime() < Date.now()) {
    // The link dies where it is found: the next reader sees EXPIRED, not a live token.
    await ddb.send(UpdateCommandFromObject(LOAD_CARRIER_TABLE, { id: row.id }, {
      rateConStatus: 'EXPIRED', rateConToken: null, updatedAt: new Date().toISOString(),
    }))
    await auditQuietly(row.id, 'rate_con_link_rejected', { reason: 'EXPIRED', version, expiresAt: row.rateConExpiresAt, ...clientInfo(client) })
    throw new PortalError(410, 'This rate confirmation has expired.')
  }
  if ((row.rateConRequestCount ?? 0) > MAX_REQUESTS_PER_TOKEN) {
    await auditQuietly(row.id, 'rate_con_link_rejected', { reason: 'RATE_LIMITED', version, ...clientInfo(client) })
    throw new PortalError(429, 'Too many requests')
  }
  return row
}

/** Count the request against the token, and apply whatever else the action changed. */
async function touchToken(row: LoadCarrierRow, patch: Record<string, unknown>) {
  const now = new Date().toISOString()
  const sets = ['rateConRequestCount = if_not_exists(rateConRequestCount, :zero) + :one', 'updatedAt = :now']
  const values: Record<string, unknown> = { ':now': now, ':zero': 0, ':one': 1 }
  let i = 0
  for (const [, v] of Object.entries(patch)) { sets.push(`#k${i} = :v${i}`); values[`:v${i}`] = v; i++ }
  const names: Record<string, string> = {}
  Object.keys(patch).forEach((k, idx) => { names[`#k${idx}`] = k })
  await ddb.send(new UpdateCommand({
    TableName: LOAD_CARRIER_TABLE, Key: { id: row.id },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }))
}

/**
 * The guard every answer writes under: still this token, still unanswered.
 *
 * The read in `validateToken` is only a courtesy check — between it and the write
 * another submit, a decline, or a re-send can land. Only the condition makes the
 * answer once-only, so the loser is told instead of overwriting a signature.
 */
function openTokenGuard(token: string) {
  return {
    expression: 'rateConToken = :tok AND rateConStatus IN (:sent, :opened)',
    values: { ':tok': token, ':sent': OPEN_STATUSES[0], ':opened': OPEN_STATUSES[1] },
  }
}

/** DynamoDB's way of saying somebody else answered first. */
function isAlreadyAnswered(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('name' in err)) return false
  return err.name === 'ConditionalCheckFailedException'
}

/** What the carrier still has to fill in before they may sign: the settings' fields plus the driver four. */
function requiredFieldsOf(settings: Record<string, unknown> | null, row: LoadCarrierRow): string[] {
  const raw = settings?.rateConRequiredFields
  const known = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string' && f in FIELD_TO_COLUMN) : []
  const wanted = [...new Set([...(known.length > 0 ? known : DEFAULT_REQUIRED_FIELDS), ...DRIVER_INFO_FIELD_KEYS])]
  return wanted.filter((f) => {
    const have = row[FIELD_TO_COLUMN[f]]
    return !(typeof have === 'string' && have.trim())
  })
}

function readFields(value: unknown): Record<string, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in FIELD_TO_COLUMN)) continue
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    out[key] = trimmed
  }
  return out
}

async function s3Bytes(key: string): Promise<Uint8Array> {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const bytes = object.Body ? await object.Body.transformToByteArray() : new Uint8Array()
  if (bytes.length === 0) throw new Error(`Stored document is empty: ${key}`)
  return bytes
}

/** The unsigned rate con this version was sent as. */
async function unsignedKeyOf(row: LoadCarrierRow): Promise<string> {
  const document = row.rateConDocumentId ? await getRow(CARRIER_DOCUMENT_TABLE, { id: String(row.rateConDocumentId) }) : null
  return String(document?.s3Key ?? `rate-confirms/carrier/${row.loadId}/${row.id}-v${row.rateConVersion ?? 1}.pdf`)
}

/** The result a replayed or racing submit gets back: the signature that already exists. */
function signedResult(row: LoadCarrierRow) {
  return {
    ok: true,
    alreadySigned: true,
    signedAt: row.rateConSignedAt ?? null,
    signerName: row.rateConSignerName ?? null,
    version: Number(row.rateConVersion ?? 1),
  }
}

/**
 * File the signed PDF in the load's Documents: a PUBLIC-folder (audience ALL) RATE_CON row that the
 * invoice packet picks up, replacing the previous signed one (kept, SUPERSEDED, never deleted or attached).
 * Idempotent per (assignment, version): a replay finds the row it wrote and does nothing.
 */
async function fileSignedDocument(row: LoadCarrierRow, args: {
  s3Key: string; bytes: Uint8Array | null; pages: number | null; now: string; token: string
}): Promise<{ documentId: string; supersededIds: string[] }> {
  const version = Number(row.rateConVersion ?? 1)
  const docs = await query(SHIPMENT_DOCUMENT_TABLE, IDX_DOCUMENTS_BY_SHIPMENT, 'shipmentId', row.shipmentId)
  const existing = docs.find((d) => d.s3Key === args.s3Key)
  if (existing) return { documentId: String(existing.id), supersededIds: [] }

  const documentId = randomUUID()
  const previous = docs.filter((d) =>
    d.type === 'RATE_CON' && d.status === 'ACTIVE' && d.loadCarrierId === row.id && d.s3Key !== args.s3Key)
  const bytes = args.bytes ?? await s3Bytes(args.s3Key)
  const uploader = `link:${args.token.slice(0, 8)}`
  await ddb.send(new PutCommand({
    TableName: SHIPMENT_DOCUMENT_TABLE,
    Item: {
      id: documentId, __typename: 'ShipmentDocument',
      shipmentId: row.shipmentId, loadId: row.loadId, loadCarrierId: row.id,
      type: 'RATE_CON',
      name: `Signed Rate Confirmation v${version}.pdf`,
      s3Key: args.s3Key, contentType: 'application/pdf', sizeBytes: bytes.length,
      ...(args.pages != null ? { pages: args.pages } : {}),
      // Generated by us, not an upload awaiting review: it carries no reviewStatus, so it counts at once.
      source: 'GENERATED',
      // ALL = the Public folder, and the audience the invoice packet's canEmailTo(…, 'CUSTOMER') accepts.
      audience: 'ALL',
      status: 'ACTIVE', version,
      ...(previous[0] ? { supersedesId: String(previous[0].id) } : {}),
      uploadedBy: uploader, uploadedAt: args.now, createdBy: uploader,
      createdAt: args.now, updatedAt: args.now,
    },
  }))
  const supersededIds: string[] = []
  for (const old of previous) {
    await ddb.send(UpdateCommandFromObject(SHIPMENT_DOCUMENT_TABLE, { id: old.id }, { status: 'SUPERSEDED', updatedAt: args.now }))
    supersededIds.push(String(old.id))
    await auditQuietly(row.id, 'rate_con_document_superseded', {
      loadId: row.loadId, supersededDocumentId: String(old.id), supersededVersion: old.version ?? null, byDocumentId: documentId, version,
    })
  }
  return { documentId, supersededIds }
}

export const handler = async (event: FnUrlEvent) => {
  const method = event.requestContext?.http?.method ?? 'POST'
  if (method === 'OPTIONS') return reply(200, { ok: true })

  const client: Client = {
    ip: event.requestContext?.http?.sourceIp ?? 'unknown',
    userAgent: (event.requestContext?.http?.userAgent ?? event.headers?.['user-agent'] ?? '').slice(0, 300),
    location: locationOf(event.headers),
  }
  let req: { token?: string; action?: string; payload?: Record<string, unknown> }
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf-8') : (event.body ?? '{}')
    if (Buffer.byteLength(raw, 'utf-8') > MAX_BODY_BYTES) return reply(413, { error: 'Request body too large' })
    req = JSON.parse(raw)
  } catch {
    return reply(400, { error: 'Bad JSON' })
  }

  try {
    const action = req.action
    const payload = req.payload ?? {}

    switch (action) {
      case 'get': {
        const row = await validateToken(req.token ?? '', client, true)
        const status = String(row.rateConStatus ?? '')
        const version = Number(row.rateConVersion ?? 1)
        const load = await getRow(LOAD_TABLE, { id: row.loadId })
        const division = load?.divisionKey
          ? await getRow(DIVISION_TABLE, { key: String(load.divisionKey) })
          : null
        const base = {
          loadNumber: String(load?.loadNumber ?? row.loadId),
          carrierName: String(row.carrierName ?? ''),
          brokerName: String(division?.legalName ?? division?.name ?? ''),
          version,
          expiresAt: row.rateConExpiresAt ?? null,
          totalCents: Number(row.costCents ?? row.carrierRateCents ?? 0),
        }
        if (status === 'SIGNED') {
          // Already answered: show the result, never a form, and nothing about the document.
          await touchToken(row, {})
          return reply(200, {
            ...base, status, requiredFields: [], pdfUrl: '',
            driverInfo: {},
            signedAt: row.rateConSignedAt ?? null, signerName: row.rateConSignerName ?? null,
          })
        }

        // Opening the link is the carrier's first answer to it. Conditional: a racing submit must win.
        await touchToken(row, {})
        if (status === 'SENT') {
          try {
            await ddb.send(UpdateCommandFromObject(LOAD_CARRIER_TABLE, { id: row.id }, { rateConStatus: 'OPENED' }, {
              expression: 'rateConToken = :tok AND rateConStatus = :sent', values: { ':tok': req.token, ':sent': 'SENT' },
            }))
            await auditQuietly(row.id, 'rate_con_opened', { loadId: row.loadId, version, ...clientInfo(client) })
          } catch (err) {
            if (!isAlreadyAnswered(err)) throw err
          }
        }

        const settings = await getRow(SETTINGS_TABLE, { id: SETTINGS_ID })
        const pdfUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: await unsignedKeyOf(row) }),
          { expiresIn: PDF_URL_EXPIRY_SECONDS },
        )
        return reply(200, {
          ...base,
          status: status === 'SENT' ? 'OPENED' : status,
          requiredFields: requiredFieldsOf(settings, row),
          driverInfo: {
            driverName: row.driverName ?? null, driverPhone: row.driverPhone ?? null,
            truckNumber: row.truckNumber ?? null, trailerNumber: row.trailerNumber ?? null,
          },
          pdfUrl,
        })
      }

      case 'submit': {
        const token = req.token ?? ''
        const row = await validateToken(token, client, true)
        // A failing submit costs a full table Scan too, so it counts against the token.
        await touchToken(row, {})
        // Second POST after signing: the same answer as the first, no second signature, nothing rewritten.
        if (row.rateConStatus === 'SIGNED') {
          if (row.rateConKey) {
            // Heal a signature whose Documents row was lost to a failure after the claim.
            await fileSignedDocument(row, {
              s3Key: String(row.rateConKey), bytes: null, pages: null, now: new Date().toISOString(), token,
            })
          }
          return reply(200, signedResult(row))
        }

        const version = Number(row.rateConVersion ?? 1)
        const settings = await getRow(SETTINGS_TABLE, { id: SETTINGS_ID })
        const required = requiredFieldsOf(settings, row)
        const fields = readFields(payload.fields)
        const errors = signErrors({ signerName: payload.signerName, agreed: payload.agreed, fields, required })
        if (Object.keys(errors).length > 0) {
          await auditQuietly(row.id, 'rate_con_sign_rejected', { loadId: row.loadId, version, errors, ...clientInfo(client) })
          throw new PortalError(400, Object.values(errors)[0], 'INVALID', errors)
        }
        const signerName = cleanName(payload.signerName)

        // The signature page fills in what dispatch did not know yet, and never
        // overwrites what it did: the office's truck number beats the carrier's.
        const filled: Record<string, unknown> = {}
        for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
          const value = fields[field]
          if (!value) continue
          if (typeof row[column] === 'string' && String(row[column]).trim()) continue
          if (column === 'pickupEtaAt') {
            filled[column] = new Date(Date.parse(value)).toISOString()
            continue
          }
          filled[column] = normalizeFieldValue(field, value)
        }

        const now = new Date().toISOString()
        const load = await getRow(LOAD_TABLE, { id: row.loadId })
        const pro = String(load?.loadNumber ?? row.loadId)
        const unsignedKey = await unsignedKeyOf(row)
        const unsigned = await s3Bytes(unsignedKey)
        if (unsigned.length > MAX_UNSIGNED_BYTES) throw new PortalError(413, 'Document too large')

        // What the certificate shows about this link's history, read from its own audit trail.
        const trail = await query(AUDIT_TABLE, IDX_AUDIT_BY_ENTITY, 'entityType', 'LOAD_CARRIER', 'entityId', row.id)
        const ofVersion = (action: string) => trail
          .filter((t) => t.action === action && Number(parseChanges(t.changes).version ?? 0) === version)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        const sentRow = ofVersion('SEND_RATE_CON')[0]
        const viewedAt = (ofVersion('rate_con_opened')[0]?.createdAt as string | undefined) ?? null

        const documentId = randomUUID()
        const details: Record<string, string> = {}
        for (const field of Object.keys(FIELD_TO_COLUMN)) {
          const value = (filled[FIELD_TO_COLUMN[field]] ?? row[FIELD_TO_COLUMN[field]]) as string | undefined
          if (typeof value === 'string' && value.trim()) details[FIELD_LABELS[field]] = value
        }
        const signed = await buildSignedRateCon(unsigned, {
          documentTitle: `Rate Confirmation - PRO ${pro}`,
          pro, version, documentId: `${documentId}`,
          signerName,
          signerEmail: String(row.rateConSentTo ?? ''),
          sentAt: (row.rateConSentAt as string | undefined) ?? null,
          sentBy: sentRow ? String(sentRow.user ?? '') : null,
          viewedAt, signedAt: now,
          ip: client.ip, userAgent: client.userAgent, location: client.location,
          details, consentText: CONSENT_TEXT,
        })
        const s3Key = generatedKey(String(row.shipmentId), documentId, 'RATE_CON', `${pro}-signed`, version)
        // Unique key per signing, never an overwrite: a lost race leaves an orphan object, not a replaced file.
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: signed.bytes, ContentType: 'application/pdf' }))

        // Claim the signature: still this token, still unanswered. The loser gets the winner's result.
        const current = isCarrierAssignmentStatus(row.assignmentStatus) ? row.assignmentStatus : null
        const rung = advanceTarget(current, {
          carrierStatus: 'ACTIVE', rateConStatus: 'SIGNED', rateConSignedAt: now,
          driverName: String(filled.driverName ?? row.driverName ?? ''), driverPhone: String(filled.driverPhone ?? row.driverPhone ?? ''),
          truckNumber: String(filled.truckNumber ?? row.truckNumber ?? ''), trailerNumber: String(filled.trailerNumber ?? row.trailerNumber ?? ''),
        })
        try {
          await ddb.send(UpdateCommandFromObject(LOAD_CARRIER_TABLE, { id: row.id }, {
            ...filled,
            ...(rung ? ladderPatch(row, rung, now) : {}),
            rateConStatus: 'SIGNED',
            rateConSignedAt: now,
            rateConSignerName: signerName,
            rateConSignerIp: client.ip,
            rateConKey: s3Key,
            updatedAt: now,
          }, openTokenGuard(token)))
        } catch (err) {
          if (!isAlreadyAnswered(err)) throw err
          const after = await findByToken(token)
          if (after?.rateConStatus === 'SIGNED') return reply(200, signedResult(after))
          throw new PortalError(409, 'This rate confirmation has already been answered.')
        }

        const filedDoc = await fileSignedDocument(row, { s3Key, bytes: signed.bytes, pages: signed.pages, now, token })

        if (rung) {
          // The board's mirror of the rung. The signature is already recorded, so a failure here is logged, not thrown.
          const mirror = { carrierAssignmentStatus: rung, updatedAt: now }
          try {
            if (SHIPMENT_TABLE && row.shipmentId) await ddb.send(UpdateCommandFromObject(SHIPMENT_TABLE, { id: row.shipmentId }, mirror))
            await ddb.send(UpdateCommandFromObject(LOAD_TABLE, { id: row.loadId }, mirror))
          } catch (err) {
            console.error('[rate-con-sign-api] ladder mirror failed', row.id, err instanceof Error ? err.message : String(err))
          }
        }
        // The signature goes on the shipment's e-mail thread (the one the rate con e-mail opened), so the thread shows who signed
        // and when, with the signed copy attached. A row write only: this public Lambda sends no mail. Never fails the signing.
        if (SHIPMENT_MESSAGE_TABLE && row.shipmentId) {
          try {
            await ddb.send(new PutCommand({
              TableName: SHIPMENT_MESSAGE_TABLE,
              Item: {
                id: `msg:${row.shipmentId}:${randomUUID()}`, __typename: 'ShipmentMessage',
                shipmentId: row.shipmentId, threadKey: threadKeyFor(String(row.shipmentId)), loadId: row.loadId, loadCarrierId: row.id,
                direction: 'IN', channel: 'EMAIL', kind: 'RATE_CON', party: 'CARRIER',
                to: null, from: signerName, cc: null,
                subject: `Rate confirmation signed — load ${pro}`,
                body: `${signerName} e-signed the rate confirmation (version ${version}) on ${now}. The signed copy is in the load's documents.`,
                status: 'RECEIVED', error: null, messageId: `<signed-${randomUUID()}@bcat>`, inReplyTo: null, providerRef: null,
                attachments: null, documentIds: [filedDoc.documentId], trackingLinkId: null, workflowRunId: null,
                authorKind: 'PERSON', authorName: signerName,
                at: now, createdBy: 'rate-con-sign-api', createdAt: now, updatedAt: now,
              },
            }))
          } catch (err) {
            console.error('[rate-con-sign-api] thread log failed', row.id, err instanceof Error ? err.message : String(err))
          }
        }
        // The full e-mail reply on that thread: a short confirmation to the carrier's dispatcher (tracking@ on CC) with the signed copy
        // attached. Handed to the tracking-actions Lambda, which owns sending and the thread; fire and forget, so a mail problem can
        // never undo or slow the signature.
        if (TRACKING_ACTIONS_FUNCTION && row.shipmentId && row.dispatcherEmail) {
          try {
            await lambdaClient.send(new InvokeCommand({
              FunctionName: TRACKING_ACTIONS_FUNCTION,
              InvocationType: 'Event',
              Payload: Buffer.from(JSON.stringify({
                systemCaller: 'rate-con-sign-api',
                arguments: {
                  action: 'SEND_SHIPMENT_MESSAGE',
                  input: JSON.stringify({
                    shipmentId: row.shipmentId, loadCarrierId: row.id, loadId: row.loadId, channel: 'EMAIL', kind: 'RATE_CON', party: 'CARRIER',
                    to: row.dispatcherEmail, cc: 'tracking@bcatcorp.com',
                    subject: `Re: Rate confirmation, load ${pro}`,
                    body: [
                      `Thank you, ${signerName}. We received the signed rate confirmation for load ${pro} (version ${version}); a copy is attached.`,
                      '',
                      `THIS IS THE TRACKING THREAD FOR LOAD ${pro}. Please REPLY ALL to this e-mail (keep tracking@bcatcorp.com on every reply) for every update on this load: driver, truck and trailer details, pickup and delivery times, delays, and proof of delivery.`,
                      'All tracking updates must stay in this thread. Please do not start a new e-mail for this load.',
                    ].join('\n'),
                    documentIds: [filedDoc.documentId], authorKind: 'AGENT', authorName: 'BCAT Tracking',
                  }),
                },
              })),
            }))
          } catch (err) {
            console.error('[rate-con-sign-api] signed reply failed', row.id, err instanceof Error ? err.message : String(err))
          }
        }
        await audit(row.id, 'rate_con_signed', {
          loadId: row.loadId, version, signerName, signedAt: now, ...clientInfo(client),
          documentId: filedDoc.documentId, s3Key, unsignedSha256: signed.unsignedSha256,
          supersededDocumentIds: filedDoc.supersededIds, fieldKeys: Object.keys(fields),
          assignmentStatus: rung ?? row.assignmentStatus ?? null,
          driverInfoComplete: driverInfoGaps({ ...row, ...filled }).length === 0, source: 'CARRIER_PORTAL',
        })
        return reply(200, { ok: true, alreadySigned: false, signedAt: now, signerName, version })
      }

      case 'decline': {
        const token = req.token ?? ''
        const row = await validateToken(token, client)
        await touchToken(row, {})
        const reason = String(payload.reason ?? '').trim().slice(0, MAX_DECLINE_REASON)
        if (!reason) throw new PortalError(400, 'A reason is required')
        const now = new Date().toISOString()
        try {
          await ddb.send(UpdateCommandFromObject(LOAD_CARRIER_TABLE, { id: row.id }, {
            rateConStatus: 'DECLINED',
            rateConToken: null,
            updatedAt: now,
          }, openTokenGuard(token)))
        } catch (err) {
          if (isAlreadyAnswered(err)) throw new PortalError(409, 'This rate confirmation has already been answered.')
          throw err
        }
        await audit(row.id, 'rate_con_declined', { loadId: row.loadId, version: Number(row.rateConVersion ?? 1), reason, signerIp: client.ip, ...clientInfo(client), source: 'CARRIER_PORTAL' })
        return reply(200, { ok: true })
      }

      default:
        return reply(400, { error: `Unknown action: ${action}` })
    }
  } catch (err) {
    if (err instanceof PortalError) {
      return reply(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) })
    }
    console.error('[rate-con-sign-api] error', err)
    return reply(500, { error: 'Internal error' })
  }
}

// Small helper: build an UpdateCommand that SETs each key of `attrs`, optionally
// guarded by a condition whose own `:values` ride along with the SET values.
function UpdateCommandFromObject(
  table: string,
  key: Record<string, unknown>,
  attrs: Record<string, unknown>,
  condition?: { expression: string; values: Record<string, unknown> },
) {
  const sets: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = { ...(condition?.values ?? {}) }
  Object.entries(attrs).forEach(([k, v], i) => {
    names[`#a${i}`] = k
    values[`:a${i}`] = v
    sets.push(`#a${i} = :a${i}`)
  })
  return new UpdateCommand({
    TableName: table, Key: key,
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ...(condition ? { ConditionExpression: condition.expression } : {}),
  })
}
