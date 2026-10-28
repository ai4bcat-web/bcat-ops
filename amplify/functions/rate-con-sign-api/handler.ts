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
 * The token is single-use: signing or declining clears it, and so does a re-send,
 * which mints a new one. Rate-limited per token via LoadCarrier.rateConRequestCount.
 * Everything is logged to AuditLog as CARRIER_PORTAL.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const LOAD_CARRIER_TABLE = process.env.LOAD_CARRIER_TABLE_NAME!
const LOAD_TABLE = process.env.LOAD_TABLE_NAME!
const CARRIER_DOCUMENT_TABLE = process.env.CARRIER_DOCUMENT_TABLE_NAME!
const DIVISION_TABLE = process.env.DIVISION_TABLE_NAME!
const SETTINGS_TABLE = process.env.SETTINGS_TABLE_NAME!
const AUDIT_TABLE = process.env.AUDIT_LOG_TABLE_NAME!
const BUCKET = process.env.BUCKET_NAME!

const SETTINGS_ID = 'default'

/** A link that gets opened two hundred times is not a carrier reading a rate con. */
const MAX_REQUESTS_PER_TOKEN = 200
const MAX_BODY_BYTES = 1 * 1024 * 1024
/** The body cap is the real ceiling on the signed PDF; this names the same limit. */
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024
const PDF_URL_EXPIRY_SECONDS = 900
const MAX_SIGNER_NAME = 120
const MAX_FIELD_VALUE = 120
const MAX_DECLINE_REASON = 500

/** Still open for signature. Anything else is history, and history is read-only. */
const OPEN_STATUSES = ['SENT', 'OPENED']
/** Answered once already; a second answer is a conflict, not an expiry. */
const ANSWERED_STATUSES = ['SIGNED', 'DECLINED', 'VOIDED']

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

const DEFAULT_REQUIRED_FIELDS = ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER']

interface FnUrlEvent {
  body?: string | null
  isBase64Encoded?: boolean
  headers?: Record<string, string>
  requestContext?: { http?: { method?: string; sourceIp?: string } }
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

// CORS is owned by the Lambda Function URL's own CORS config (see backend.ts) — it
// echoes the matching Origin and handles preflight. We must NOT also set
// Access-Control-* here, or the browser sees a duplicated header and blocks the call.
function reply(status: number, body: unknown) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

class PortalError extends Error {
  constructor(public status: number, message: string) { super(message) }
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

async function getRow(table: string, key: Record<string, unknown>) {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key }))
  return (res.Item as Record<string, unknown> | undefined) ?? null
}

async function audit(loadCarrierId: string, action: string, changes: Record<string, unknown>) {
  const now = new Date().toISOString()
  await ddb.send(new PutCommand({
    TableName: AUDIT_TABLE,
    Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'LOAD_CARRIER', entityId: loadCarrierId, action, user: 'CARRIER_PORTAL', changes: JSON.stringify(changes), createdAt: now, updatedAt: now },
  }))
}

/**
 * Find the assignment this link belongs to.
 *
 * A Scan, not an index: LoadCarrier already spends its one new secondary index on
 * `carrierId`, and a token lookup happens a handful of times per rate con.
 */
async function validateToken(token: string, onceOnly = false): Promise<LoadCarrierRow> {
  if (!token) throw new PortalError(400, 'Missing token')
  const rows = await scan(LOAD_CARRIER_TABLE, '#t = :t', { '#t': 'rateConToken' }, { ':t': token })
  // One token, one assignment. Two rows answering to the same token is a mint bug,
  // and guessing which one the carrier meant is how the wrong load gets signed.
  if (rows.length > 1) throw new PortalError(409, 'This rate confirmation link is ambiguous. Please ask your broker to re-send it.')
  const row = rows[0] as unknown as LoadCarrierRow | undefined
  if (!row) throw new PortalError(404, 'This rate confirmation link is invalid or has expired.')
  const status = String(row.rateConStatus ?? '')
  if (!OPEN_STATUSES.includes(status)) {
    if (onceOnly && ANSWERED_STATUSES.includes(status)) {
      throw new PortalError(409, 'This rate confirmation has already been answered.')
    }
    throw new PortalError(410, 'This rate confirmation is no longer open.')
  }
  if (row.rateConExpiresAt && new Date(String(row.rateConExpiresAt)).getTime() < Date.now()) {
    // The link dies where it is found: the next reader sees EXPIRED, not a live token.
    await ddb.send(UpdateCommandFromObject(LOAD_CARRIER_TABLE, { id: row.id }, {
      rateConStatus: 'EXPIRED', rateConToken: null, updatedAt: new Date().toISOString(),
    }))
    throw new PortalError(410, 'This rate confirmation has expired.')
  }
  if ((row.rateConRequestCount ?? 0) > MAX_REQUESTS_PER_TOKEN) throw new PortalError(429, 'Too many requests')
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
 * answer once-only, so the loser is told 409 instead of overwriting a signature.
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

/** What the carrier has to fill in before they may sign, settings first. */
function requiredFieldsOf(settings: Record<string, unknown> | null): string[] {
  const raw = settings?.rateConRequiredFields
  if (!Array.isArray(raw)) return DEFAULT_REQUIRED_FIELDS
  const known = raw.filter((f): f is string => typeof f === 'string' && f in FIELD_TO_COLUMN)
  return known.length > 0 ? known : DEFAULT_REQUIRED_FIELDS
}

function readFields(value: unknown): Record<string, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.length > MAX_FIELD_VALUE) throw new PortalError(400, `${key} is too long`)
    out[key] = trimmed
  }
  return out
}

export const handler = async (event: FnUrlEvent) => {
  const method = event.requestContext?.http?.method ?? 'POST'
  if (method === 'OPTIONS') return reply(200, { ok: true })

  const sourceIp = event.requestContext?.http?.sourceIp ?? 'unknown'
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
        const row = await validateToken(req.token ?? '')
        const status = String(row.rateConStatus ?? '')
        // Opening the link is the carrier's first answer to it.
        await touchToken(row, status === 'SENT' ? { rateConStatus: 'OPENED' } : {})

        const load = await getRow(LOAD_TABLE, { id: row.loadId })
        const division = load?.divisionKey
          ? await getRow(DIVISION_TABLE, { key: String(load.divisionKey) })
          : null
        const settings = await getRow(SETTINGS_TABLE, { id: SETTINGS_ID })
        const document = row.rateConDocumentId
          ? await getRow(CARRIER_DOCUMENT_TABLE, { id: String(row.rateConDocumentId) })
          : null
        const s3Key = String(
          document?.s3Key ?? `rate-confirms/carrier/${row.loadId}/${row.id}-v${row.rateConVersion ?? 1}.pdf`,
        )
        const pdfUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }),
          { expiresIn: PDF_URL_EXPIRY_SECONDS },
        )

        return reply(200, {
          loadNumber: String(load?.loadNumber ?? row.loadId),
          carrierName: String(row.carrierName ?? ''),
          brokerName: String(division?.legalName ?? division?.name ?? ''),
          status: status === 'SENT' ? 'OPENED' : status,
          expiresAt: row.rateConExpiresAt ?? null,
          requiredFields: requiredFieldsOf(settings),
          totalCents: Number(row.costCents ?? row.carrierRateCents ?? 0),
          pdfUrl,
        })
      }

      case 'submit': {
        const token = req.token ?? ''
        const row = await validateToken(token, true)
        // A failing submit costs a full table Scan too, so it counts against the token.
        await touchToken(row, {})
        const signerName = String(payload.signerName ?? '').trim()
        if (!signerName) throw new PortalError(400, 'A typed name is required')
        if (signerName.length > MAX_SIGNER_NAME) throw new PortalError(400, 'That name is too long')
        const pdfBase64 = String(payload.pdfBase64 ?? '')
        if (!pdfBase64) throw new PortalError(400, 'Missing signed document')
        const bytes = Buffer.from(pdfBase64, 'base64')
        if (bytes.length === 0) throw new PortalError(400, 'Missing signed document')
        if (bytes.length > MAX_UPLOAD_BYTES) throw new PortalError(413, 'Document too large')

        const fields = readFields(payload.fields)
        const settings = await getRow(SETTINGS_TABLE, { id: SETTINGS_ID })
        const missing = requiredFieldsOf(settings).filter((f) => !fields[f])
        if (missing.length > 0) throw new PortalError(400, `Still missing: ${missing.join(', ')}`)

        const version = Number(row.rateConVersion ?? 1)
        const s3Key = `rate-confirms/carrier/${row.loadId}/${row.id}-v${version}-signed.pdf`
        const now = new Date().toISOString()

        // The signature page fills in what dispatch did not know yet, and never
        // overwrites what it did: the office's truck number beats the carrier's.
        const filled: Record<string, unknown> = {}
        for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
          const value = fields[field]
          if (!value) continue
          if (typeof row[column] === 'string' && String(row[column]).trim()) continue
          if (column === 'pickupEtaAt') {
            const parsed = Date.parse(value)
            if (Number.isNaN(parsed)) continue
            filled[column] = new Date(parsed).toISOString()
            continue
          }
          filled[column] = value
        }

        // Claim the signature before writing anything else: a racer that loses the
        // claim leaves no PDF in the bucket and no document row to explain later.
        try {
          await ddb.send(UpdateCommandFromObject(LOAD_CARRIER_TABLE, { id: row.id }, {
            ...filled,
            rateConStatus: 'SIGNED',
            rateConSignedAt: now,
            rateConSignerName: signerName,
            rateConSignerIp: sourceIp,
            rateConKey: s3Key,
            rateConToken: null,
            updatedAt: now,
          }, openTokenGuard(token)))
        } catch (err) {
          if (isAlreadyAnswered(err)) throw new PortalError(409, 'This rate confirmation has already been answered.')
          throw err
        }

        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: bytes, ContentType: 'application/pdf' }))

        if (row.carrierId) {
          await ddb.send(new PutCommand({
            TableName: CARRIER_DOCUMENT_TABLE,
            Item: {
              id: randomUUID(), __typename: 'CarrierDocument', carrierId: String(row.carrierId),
              type: 'RATE_CON', name: `rate-con-v${version}-signed.pdf`, s3Key,
              contentType: 'application/pdf', sizeBytes: bytes.length, loadCarrierId: row.id,
              source: 'SIGNED', uploadedBy: 'CARRIER_PORTAL', createdAt: now, updatedAt: now,
            },
          }))
        }

        await audit(row.id, 'rate_con_signed', { loadId: row.loadId, signerName, s3Key, fields, source: 'CARRIER_PORTAL' })
        return reply(200, { ok: true })
      }

      case 'decline': {
        const token = req.token ?? ''
        const row = await validateToken(token, true)
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
        await audit(row.id, 'rate_con_declined', { loadId: row.loadId, reason, signerIp: sourceIp, source: 'CARRIER_PORTAL' })
        return reply(200, { ok: true })
      }

      default:
        return reply(400, { error: `Unknown action: ${action}` })
    }
  } catch (err) {
    if (err instanceof PortalError) return reply(err.status, { error: err.message })
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
