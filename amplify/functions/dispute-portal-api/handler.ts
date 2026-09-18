/**
 * dispute-portal-api Lambda (Function URL)
 *
 * Public, unauthenticated endpoint for the Amazon driver dispute board and submission
 * form.  No Cognito, no AppSync, no guest storage reads — the API itself is the only
 * public surface.  All writes are validated server-side and evidence lands in S3 with
 * presigned PUT URLs scoped to the submission.
 *
 * Actions:
 *   list   – paginated public board projection
 *   upload – presigned PUT for one proof file
 *   submit – create an AmazonDispute row (idempotent on submissionId)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const TABLE_NAME = process.env.TABLE_NAME!
const BUCKET_NAME = process.env.BUCKET_NAME!

const PAGE_SIZE = 100
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_BODY_BYTES = 1 * 1024 * 1024
const MAX_DESCRIPTION_LENGTH = 4000
const MAX_NAME_TRIP_LENGTH = 200

// Any raster image (PNG/JPEG/HEIC/WEBP/...) is fine; the confirmation may also be a PDF.
// SVG is excluded: staff open evidence from a signed S3 URL, where a scripted SVG would run.
const IMAGE_TYPE = /^image\/(?!svg)[a-z0-9.+-]+$/
const PDF_TYPE = 'application/pdf'
const KEY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'pdf']
const VALID_STATUSES: Record<string, true> = {
  PENDING: true,
  POSTED: true,
  PAID: true,
  REJECTED: true,
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface FnUrlEvent {
  body?: string | null
  isBase64Encoded?: boolean
  requestContext?: { http?: { method?: string; sourceIp?: string } }
}

type DisputeStatus = 'PENDING' | 'POSTED' | 'PAID' | 'REJECTED'

interface EvidenceItem {
  s3Key: string
  fileName: string
  contentType: string
  size: number
  kind: 'CONFIRMATION' | 'PHOTO'
}

interface BoardItem {
  id: string
  driverName: string
  tripNumber: string | null
  payPeriod: string | null
  shipmentDate: string | null
  status: DisputeStatus
}

class PortalError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function reply(status: number, body: unknown) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function getErrorName(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined
  if (!('name' in err)) return undefined
  const value = err.name
  return typeof value === 'string' ? value : undefined
}

function parseJsonBody(event: FnUrlEvent): unknown {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '{}')
  if (Buffer.byteLength(raw, 'utf-8') > MAX_BODY_BYTES) {
    throw new PortalError(413, 'Request body too large')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new PortalError(400, 'Invalid JSON body')
  }
}

function isActionRequest(value: unknown): value is { action?: string; payload?: Record<string, unknown> } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return (typeof obj.action === 'string' || obj.action === undefined) &&
    (typeof obj.payload === 'object' || obj.payload === undefined)
}

function requireString(value: unknown, name: string, maxLength?: number): string {
  if (typeof value !== 'string') throw new PortalError(400, `${name} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new PortalError(400, `${name} is required`)
  if (maxLength && trimmed.length > maxLength) throw new PortalError(400, `${name} too long`)
  return trimmed
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))
}

function requireDate(value: unknown, name: string): string {
  if (!isValidIsoDate(value)) throw new PortalError(400, `${name} must be YYYY-MM-DD`)
  return value
}

function getDayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / (1000 * 60 * 60 * 24)
}

function requireFiniteMoney(value: unknown, name: string, allowZero: boolean): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new PortalError(400, `${name} must be a number`)
  if (n < 0) throw new PortalError(400, `${name} cannot be negative`)
  if (!allowZero && n <= 0) throw new PortalError(400, `${name} must be greater than zero`)
  return n
}

function requireUuid(value: unknown, name: string): string {
  const s = requireString(value, name)
  if (!UUID_RE.test(s)) throw new PortalError(400, `${name} must be a UUID`)
  return s
}

function safeExtension(fileName: string, contentType: string): string {
  const fromName = fileName.match(/\.([a-zA-Z0-9]{1,5})$/)?.[1].toLowerCase()
  if (fromName && KEY_EXTENSIONS.includes(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName
  if (contentType === PDF_TYPE) return 'pdf'
  const subtype = contentType.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? ''
  return KEY_EXTENSIONS.includes(subtype) ? subtype : 'bin'
}

/** Reject bogus pagination tokens (must be a base64 JSON object like {"id":"..."}). */
export function validateListToken(nextToken: unknown): Record<string, string> | null {
  if (nextToken === undefined || nextToken === null) return null
  if (typeof nextToken !== 'string' || !nextToken) throw new PortalError(400, 'Invalid nextToken')
  let decoded: string
  try {
    decoded = Buffer.from(nextToken, 'base64').toString('utf-8')
  } catch {
    throw new PortalError(400, 'Invalid nextToken')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    throw new PortalError(400, 'Invalid nextToken')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PortalError(400, 'Invalid nextToken')
  }
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'id') throw new PortalError(400, 'Invalid nextToken')
  const id = (parsed as Record<string, unknown>).id
  if (typeof id !== 'string' || !id) throw new PortalError(400, 'Invalid nextToken')
  return parsed as Record<string, string>
}

function requirementFileContentType(kind: 'CONFIRMATION' | 'PHOTO', contentType: string): boolean {
  if (IMAGE_TYPE.test(contentType.toLowerCase())) return true
  return kind === 'CONFIRMATION' && contentType === PDF_TYPE
}

function validateEvidenceItem(raw: unknown, submissionId: string, index: number): EvidenceItem {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PortalError(400, `evidence[${index}] must be an object`)
  }
  const obj = raw as Record<string, unknown>
  const s3Key = requireString(obj.s3Key, `evidence[${index}].s3Key`)
  const fileName = requireString(obj.fileName, `evidence[${index}].fileName`, 255)
  const contentType = requireString(obj.contentType, `evidence[${index}].contentType`)
  const kindStr = requireString(obj.kind, `evidence[${index}].kind`)
  if (kindStr !== 'CONFIRMATION' && kindStr !== 'PHOTO') {
    throw new PortalError(400, `evidence[${index}].kind must be CONFIRMATION or PHOTO`)
  }
  const size = typeof obj.size === 'number' ? obj.size : Number(obj.size)
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
    throw new PortalError(400, `evidence[${index}].size must be a positive integer <= ${MAX_FILE_BYTES}`)
  }
  if (!requirementFileContentType(kindStr, contentType)) {
    throw new PortalError(400, `Invalid contentType for ${kindStr}`)
  }
  const expectedPrefix = `dispute-proofs/${submissionId}/`
  if (!s3Key.startsWith(expectedPrefix)) throw new PortalError(400, 'Invalid evidence key')
  return { s3Key, fileName, contentType, size: size as number, kind: kindStr }
}

/** Validate payPeriod is a Sunday and shipmentDate falls inside Sunday–Saturday. */
export function validateDateRange(payPeriod: unknown, shipmentDate: unknown): { payPeriod: string; shipmentDate: string } {
  const payPeriodDate = requireDate(payPeriod, 'payPeriod')
  const shipmentDateValue = requireDate(shipmentDate, 'shipmentDate')
  if (getDayOfWeek(payPeriodDate) !== 0) throw new PortalError(400, 'payPeriod must be a Sunday')
  const diff = daysBetween(payPeriodDate, shipmentDateValue)
  if (diff < 0 || diff > 6) throw new PortalError(400, 'shipmentDate must be within the selected pay period (Sunday–Saturday)')
  return { payPeriod: payPeriodDate, shipmentDate: shipmentDateValue }
}

export function validateSubmission(payload: Record<string, unknown>): {
  submissionId: string
  driverName: string
  tripNumber: string
  payPeriod: string
  shipmentDate: string
  amountPaid: number
  amountRequested: number
  description: string
  evidence: EvidenceItem[]
} {
  const submissionId = requireUuid(payload.submissionId, 'submissionId')
  const driverName = requireString(payload.driverName, 'driverName', MAX_NAME_TRIP_LENGTH)
  const tripNumber = requireString(payload.tripNumber, 'tripNumber', MAX_NAME_TRIP_LENGTH)
  const dates = validateDateRange(payload.payPeriod, payload.shipmentDate)
  const amountPaid = requireFiniteMoney(payload.amountPaid, 'amountPaid', true)
  const amountRequested = requireFiniteMoney(payload.amountRequested, 'amountRequested', false)
  const description = requireString(payload.description, 'description', MAX_DESCRIPTION_LENGTH)
  if (!Array.isArray(payload.evidence)) throw new PortalError(400, 'evidence array required')
  if (payload.evidence.length === 0) throw new PortalError(400, 'evidence array required')

  const evidence = payload.evidence.map((e, i) => validateEvidenceItem(e, submissionId, i))
  const confirmations = evidence.filter((e) => e.kind === 'CONFIRMATION')
  const photos = evidence.filter((e) => e.kind === 'PHOTO')
  if (confirmations.length !== 1) throw new PortalError(400, 'Exactly one confirmation file is required')
  if (photos.length > 5) throw new PortalError(400, 'At most 5 photos are allowed')

  return { submissionId, driverName, tripNumber, ...dates, amountPaid, amountRequested, description, evidence }
}

export function projectBoardItem(raw: Record<string, unknown>): BoardItem {
  // Legacy Google-Form / hand-entered rows can have a null status; the staff page treats
  // those as Pending, and one such row must not take the whole public board down.
  const raw_status = String(raw.status ?? '')
  const status = VALID_STATUSES[raw_status] ? raw_status : 'PENDING'
  return {
    id: String(raw.id),
    driverName: String(raw.driverName ?? ''),
    tripNumber: raw.tripNumber ? String(raw.tripNumber) : null,
    payPeriod: raw.payPeriod ? String(raw.payPeriod) : null,
    shipmentDate: raw.shipmentDate ? String(raw.shipmentDate) : null,
    status: status as DisputeStatus,
  }
}

async function checkEvidenceInS3(evidence: EvidenceItem[]) {
  for (const item of evidence) {
    let head: { ContentLength?: number; ContentType?: string }
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: item.s3Key }))
    } catch (err: unknown) {
      const name = getErrorName(err)
      if (name === 'NotFound' || name === 'NoSuchKey') {
        throw new PortalError(400, `Missing proof: ${item.fileName}`)
      }
      throw err
    }
    if (head.ContentLength !== item.size) {
      throw new PortalError(400, `Size mismatch for ${item.fileName}`)
    }
    if (head.ContentType !== item.contentType) {
      throw new PortalError(400, `Content type mismatch for ${item.fileName}`)
    }
  }
}

function canonicalForDedup(fields: {
  driverName: string
  tripNumber: string
  payPeriod: string
  shipmentDate: string
  amountPaid: number
  amountRequested: number
  description: string
}): string {
  return JSON.stringify({
    driverName: fields.driverName,
    tripNumber: fields.tripNumber,
    payPeriod: fields.payPeriod,
    shipmentDate: fields.shipmentDate,
    amountPaid: fields.amountPaid,
    amountRequested: fields.amountRequested,
    description: fields.description,
  })
}

async function putDispute(
  id: string,
  fields: {
    submissionId: string
    driverName: string
    tripNumber: string
    payPeriod: string
    shipmentDate: string
    amountPaid: number
    amountRequested: number
    description: string
    evidence: EvidenceItem[]
  },
  now: string,
): Promise<{ id: string; created: boolean }> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          id,
          __typename: 'AmazonDispute',
          driverName: fields.driverName,
          tripNumber: fields.tripNumber,
          shipmentDate: fields.shipmentDate,
          payPeriod: fields.payPeriod,
          amountPaid: fields.amountPaid,
          amountRequested: fields.amountRequested,
          description: fields.description,
          status: 'PENDING',
          source: 'DRIVER_PORTAL',
          externalId: `portal:${fields.submissionId}`,
          submittedAt: now,
          evidence: JSON.stringify(fields.evidence),
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(id)',
      })
    )
    return { id, created: true }
  } catch (err: unknown) {
    if (getErrorName(err) === 'ConditionalCheckFailedException') {
      const existing = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { id } }))
      const item = existing.Item
      if (!item) return { id, created: false }
      const existingCanonical = canonicalForDedup({
        driverName: String(item.driverName),
        tripNumber: String(item.tripNumber ?? ''),
        payPeriod: String(item.payPeriod ?? ''),
        shipmentDate: String(item.shipmentDate ?? ''),
        amountPaid: Number(item.amountPaid ?? 0),
        amountRequested: Number(item.amountRequested ?? 0),
        description: String(item.description ?? ''),
      })
      const newCanonical = canonicalForDedup({
        driverName: fields.driverName,
        tripNumber: fields.tripNumber,
        payPeriod: fields.payPeriod,
        shipmentDate: fields.shipmentDate,
        amountPaid: fields.amountPaid,
        amountRequested: fields.amountRequested,
        description: fields.description,
      })
      if (existingCanonical !== newCanonical) {
        throw new PortalError(409, 'Submission ID already exists with different details')
      }
      return { id, created: false }
    }
    throw err
  }
}

async function handleList(payload: Record<string, unknown>) {
  const exclusiveStartKey = validateListToken(payload.nextToken)
  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'id, driverName, tripNumber, payPeriod, shipmentDate, #s, submittedAt',
      ExpressionAttributeNames: { '#s': 'status' },
      Limit: PAGE_SIZE,
      ExclusiveStartKey: exclusiveStartKey ?? undefined,
    })
  )

  const items: Record<string, unknown>[] = res.Items ?? []
  const sorted = items.sort(
    (a, b) =>
      new Date(String(b.submittedAt ?? '1970-01-01')).getTime() -
      new Date(String(a.submittedAt ?? '1970-01-01')).getTime()
  )

  const projected = sorted.map((item) => projectBoardItem(item))
  return reply(200, {
    items: projected,
    nextToken: res.LastEvaluatedKey ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString('base64') : null,
  })
}

async function handleUpload(payload: Record<string, unknown>) {
  const submissionId = requireUuid(payload.submissionId, 'submissionId')
  const fileName = requireString(payload.fileName, 'fileName', 255)
  const contentType = requireString(payload.contentType, 'contentType')
  const size = typeof payload.size === 'number' ? payload.size : Number(payload.size)
  const kind = typeof payload.kind === 'string' ? (payload.kind as 'CONFIRMATION' | 'PHOTO') : undefined
  if (kind !== 'CONFIRMATION' && kind !== 'PHOTO') throw new PortalError(400, 'kind must be CONFIRMATION or PHOTO')
  if (!requirementFileContentType(kind, contentType)) throw new PortalError(400, 'Unsupported file type')
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
    throw new PortalError(400, `size must be a positive integer <= ${MAX_FILE_BYTES}`)
  }
  const ext = safeExtension(fileName, contentType)
  const fileId = randomUUID()
  const s3Key = `dispute-proofs/${submissionId}/${fileId}.${ext}`
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: contentType,
      ContentLength: size,
      IfNoneMatch: '*',
    }),
    { expiresIn: 300 }
  )
  return reply(200, { uploadUrl: url, s3Key })
}

async function handleSubmit(payload: Record<string, unknown>) {
  const fields = validateSubmission(payload)
  await checkEvidenceInS3(fields.evidence)
  const now = new Date().toISOString()
  const { id, created } = await putDispute(fields.submissionId, fields, now)
  return reply(200, { ok: true, id, duplicate: !created })
}

export const handler = async (event: FnUrlEvent) => {
  const method = event.requestContext?.http?.method ?? 'POST'
  if (method === 'OPTIONS') return reply(200, { ok: true })

  const body = parseJsonBody(event)
  if (!isActionRequest(body)) return reply(400, { error: 'Bad request' })
  const action = typeof body.action === 'string' ? body.action : ''
  const payload: Record<string, unknown> = body.payload ?? {}

  try {
    switch (action) {
      case 'list':
        return await handleList(payload)
      case 'upload':
        return await handleUpload(payload)
      case 'submit':
        return await handleSubmit(payload)
      default:
        return reply(400, { error: `Unknown action: ${action || '(empty)'}` })
    }
  } catch (err) {
    if (err instanceof PortalError) return reply(err.status, { error: err.message })
    console.error('[dispute-portal-api] error', err)
    return reply(500, { error: 'Internal error' })
  }
}
