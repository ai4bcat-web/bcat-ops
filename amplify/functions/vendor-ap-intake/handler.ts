/**
 * vendor-ap-intake Lambda
 *
 * Secret-authenticated Function URL endpoint for the vendorpayments@bcatcorp.com Gmail
 * bridge. Because the Lambda Function URL has a 6 MiB sync payload ceiling, original
 * attachment bytes never travel through it. The bridge uses a two-phase protocol:
 *
 *   1. prepare – sends email metadata + attachment metadata; Lambda returns
 *      short-lived presigned PUT URLs for each original attachment.
 *   2. commit  – after the bridge uploads bytes directly to S3, it calls commit;
 *      Lambda HEADs every key and conditionally creates the VendorPayable row.
 *
 * Auth: shared webhook secret (INTAKE_WEBHOOK_SECRET), surfaced as
 * VENDOR_AP_INTAKE_SECRET.
 */
import { createHash, timingSafeEqual } from 'crypto'
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const MAX_BODY_BYTES = 1 * 1024 * 1024
const MAX_EMAIL_BODY_LENGTH = 50_000
const EMAIL_BODY_TRUNCATION_INDICATOR = '\n\n[truncated]'
const MAX_SUBJECT_LENGTH = 500
const MAX_ATTACHMENTS = 50
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const UPLOAD_EXPIRY_SECONDS = 300

const PDF_TYPE = 'application/pdf'
const PNG_TYPE = 'image/png'
const JPEG_TYPE = 'image/jpeg'

interface FnUrlEvent {
  body: string | null
  isBase64Encoded?: boolean
  requestContext?: {
    http?: { method?: string }
  }
}

interface AttachmentMeta {
  name: string
  contentType: string
  size: number
}

interface UploadEntry extends AttachmentMeta {
  s3Key: string
  url: string
}

interface CommitAttachment extends AttachmentMeta {
  s3Key: string
}

interface DynamoAttachment {
  key: string
  name: string
  contentType: string
  size: number
}

interface BasePayload {
  secret: string
  action: string
  messageId: string
  subject: string
  fromEmail: string | null
  receivedAt: string
  emailBody: string | null
}

interface PreparePayload extends BasePayload {
  attachments: AttachmentMeta[]
}

interface CommitPayload extends BasePayload {
  attachments: CommitAttachment[]
}

type ValidationResult<T> =
  | { ok: false; status: number; error: string }
  | { ok: true; payload: T }

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getErrorName(err: unknown): string | undefined {
  if (!isPlainObject(err)) return undefined
  const value = err.name
  return typeof value === 'string' ? value : undefined
}

function parseBody(event: FnUrlEvent): unknown {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '{}')
  if (Buffer.byteLength(raw, 'utf-8') > MAX_BODY_BYTES) {
    throw new Error('request body too large')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid JSON body')
  }
}

function secretEquals(provided: unknown): boolean {
  const secret = process.env.VENDOR_AP_INTAKE_SECRET ?? ''
  if (typeof provided !== 'string' || !secret) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(secret).digest()
  return a.length === b.length && timingSafeEqual(a, b)
}

function requireString(value: unknown, name: string, maxLength?: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} is required`)
  if (maxLength && trimmed.length > maxLength) throw new Error(`${name} too long`)
  return trimmed
}

function normalizeContentType(raw: string): string {
  const type = raw.toLowerCase().trim()
  if (type === PDF_TYPE) return PDF_TYPE
  if (type === PNG_TYPE) return PNG_TYPE
  if (type === JPEG_TYPE || type === 'image/jpg') return JPEG_TYPE
  return 'application/octet-stream'
}

function buildS3Key(messageId: string, index: number, name: string, contentType: string): string {
  const hash = createHash('sha256').update(messageId).digest('hex')

  const normalizedType = normalizeContentType(contentType)
  let ext: string
  if (normalizedType === PDF_TYPE) ext = 'pdf'
  else if (normalizedType === PNG_TYPE) ext = 'png'
  else if (normalizedType === JPEG_TYPE) ext = 'jpg'
  else {
    const fromName = name.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1].toLowerCase()
    ext = fromName && /^[a-z0-9]+$/.test(fromName) ? fromName : 'bin'
  }

  const basePart = name.split(/[\\/]/).pop() ?? name
  let cleaned = basePart.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '')
  if (!cleaned) cleaned = 'attachment'
  const base = cleaned.replace(/\.[^.]+$/, '').slice(0, 120)

  return `intake-pdfs/vendor-ap/${hash}/${index}-${base}.${ext}`
}

function parseISOOrNow(raw: string): string {
  if (!raw) return new Date().toISOString()
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString()
}

function validateBasePayload(raw: unknown): ValidationResult<BasePayload> {
  if (!isPlainObject(raw)) {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }

  if (typeof raw.secret !== 'string') {
    return { ok: false, status: 401, error: 'unauthorized' }
  }

  const action = typeof raw.action === 'string' ? raw.action.trim() : ''
  if (action !== 'prepare' && action !== 'commit') {
    return { ok: false, status: 400, error: 'action must be prepare or commit' }
  }

  if (typeof raw.messageId !== 'string' || !raw.messageId.trim()) {
    return { ok: false, status: 400, error: 'messageId required' }
  }

  const rawSubject = typeof raw.subject === 'string' ? raw.subject.trim() : ''
  const subject = (rawSubject || 'no subject').slice(0, MAX_SUBJECT_LENGTH)

  const rawFrom = typeof raw.from === 'string' ? raw.from.trim() : ''
  const fromEmail = rawFrom || null

  const receivedAt = typeof raw.receivedAt === 'string' ? raw.receivedAt.trim() : ''

  const rawBody = typeof raw.emailBody === 'string' ? raw.emailBody : ''
  let emailBody: string | null = null
  if (rawBody) {
    if (rawBody.length <= MAX_EMAIL_BODY_LENGTH) {
      emailBody = rawBody
    } else {
      const limit = MAX_EMAIL_BODY_LENGTH - EMAIL_BODY_TRUNCATION_INDICATOR.length
      emailBody = rawBody.slice(0, Math.max(0, limit)) + EMAIL_BODY_TRUNCATION_INDICATOR
    }
  }

  return {
    ok: true,
    payload: {
      secret: raw.secret,
      action,
      messageId: raw.messageId.trim(),
      subject,
      fromEmail,
      receivedAt,
      emailBody,
    },
  }
}

function validateAttachmentMeta(raw: unknown, index: number): AttachmentMeta {
  if (!isPlainObject(raw)) {
    throw new Error(`attachments[${index}] must be an object`)
  }
  const name = requireString(raw.name, `attachments[${index}].name`, 255)
  const contentType = requireString(raw.contentType, `attachments[${index}].contentType`, 120)
  const size = typeof raw.size === 'number' ? raw.size : Number(raw.size)
  if (!Number.isInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachments[${index}].size must be a positive integer <= ${MAX_ATTACHMENT_BYTES}`)
  }
  return { name, contentType, size }
}

function validateAttachments(raw: unknown): AttachmentMeta[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('attachments must be an array')
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(`attachments cannot exceed ${MAX_ATTACHMENTS}`)
  }
  return raw.map((item, index) => validateAttachmentMeta(item, index))
}

function validatePreparePayload(raw: unknown): ValidationResult<PreparePayload> {
  const base = validateBasePayload(raw)
  if (!base.ok) return base
  if (!isPlainObject(raw)) {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
  try {
    const attachments = validateAttachments(raw.attachments)
    return { ok: true, payload: { ...base.payload, attachments } }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid attachments'
    return { ok: false, status: 422, error: message }
  }
}

function validateCommitAttachment(raw: unknown, index: number): CommitAttachment {
  if (!isPlainObject(raw)) {
    throw new Error(`attachments[${index}] must be an object`)
  }
  const meta = validateAttachmentMeta(raw, index)
  const s3Key = requireString(raw.s3Key, `attachments[${index}].s3Key`, 512)
  return { ...meta, s3Key }
}

function validateCommitPayload(raw: unknown): ValidationResult<CommitPayload> {
  const base = validateBasePayload(raw)
  if (!base.ok) return base
  if (!isPlainObject(raw)) {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
  if (!Array.isArray(raw.attachments)) {
    return { ok: false, status: 400, error: 'attachments required for commit' }
  }
  if (raw.attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 422, error: `attachments cannot exceed ${MAX_ATTACHMENTS}` }
  }
  try {
    const attachments = raw.attachments.map((item, index) => validateCommitAttachment(item, index))
    return { ok: true, payload: { ...base.payload, attachments } }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid attachments'
    return { ok: false, status: 422, error: message }
  }
}

async function rowExists(dynamo: DynamoDBClient, rowId: string): Promise<boolean> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: process.env.TABLE_NAME!,
      Key: marshall({ id: rowId }),
      ConsistentRead: true,
    })
  )
  return !!result.Item
}

async function handlePrepare(payload: PreparePayload, dynamo: DynamoDBClient, s3: S3Client) {
  const rowId = `email:${payload.messageId}`

  if (await rowExists(dynamo, rowId)) {
    console.log('[vendor-ap-intake] prepare duplicate, skipping', { rowId })
    return respond(200, { ok: true, duplicate: true, rowId })
  }

  const uploadUrls: UploadEntry[] = []
  for (let i = 0; i < payload.attachments.length; i++) {
    const att = payload.attachments[i]
    const contentType = normalizeContentType(att.contentType)
    const s3Key = buildS3Key(payload.messageId, i, att.name, contentType)
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME!,
        Key: s3Key,
        ContentType: contentType,
        ContentLength: att.size,
      }),
      { expiresIn: UPLOAD_EXPIRY_SECONDS }
    )
    uploadUrls.push({ name: att.name, contentType, size: att.size, s3Key, url })
  }

  return respond(200, { ok: true, duplicate: false, rowId, uploadUrls })
}

async function handleCommit(payload: CommitPayload, dynamo: DynamoDBClient, s3: S3Client) {
  const rowId = `email:${payload.messageId}`

  if (await rowExists(dynamo, rowId)) {
    console.log('[vendor-ap-intake] commit duplicate, skipping', { rowId })
    return respond(200, { ok: true, duplicate: true, rowId })
  }

  const verified: DynamoAttachment[] = []
  for (const att of payload.attachments) {
    const contentType = normalizeContentType(att.contentType)
    let head
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: process.env.BUCKET_NAME!, Key: att.s3Key }))
    } catch (err) {
      const name = getErrorName(err)
      if (name === 'NotFound' || name === 'NoSuchKey') {
        console.warn('[vendor-ap-intake] attachment not yet in S3, will retry', {
          rowId,
          s3Key: att.s3Key,
        })
        return respond(503, { error: 'attachment verification failed' })
      }
      throw err
    }

    if (head.ContentLength !== att.size) {
      console.warn('[vendor-ap-intake] attachment size mismatch', {
        s3Key: att.s3Key,
        expected: att.size,
        actual: head.ContentLength,
      })
      return respond(422, { error: `attachment size mismatch: ${att.name}` })
    }
    if (head.ContentType !== contentType) {
      console.warn('[vendor-ap-intake] attachment content type mismatch', {
        s3Key: att.s3Key,
        expected: contentType,
        actual: head.ContentType,
      })
      return respond(422, { error: `attachment content type mismatch: ${att.name}` })
    }

    verified.push({ key: att.s3Key, name: att.name, contentType, size: att.size })
  }

  const now = new Date().toISOString()
  const item = {
    id: rowId,
    __typename: 'VendorPayable',
    status: 'NEED_TO_PAY',
    source: 'EMAIL',
    sourceMessageId: payload.messageId,
    subject: payload.subject,
    fromEmail: payload.fromEmail,
    emailBody: payload.emailBody,
    attachments: verified,
    receivedAt: parseISOOrNow(payload.receivedAt),
    createdAt: now,
    updatedAt: now,
  }

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: process.env.TABLE_NAME!,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(id)',
      })
    )
  } catch (err) {
    if (getErrorName(err) === 'ConditionalCheckFailedException') {
      console.log('[vendor-ap-intake] commit race lost, treating as duplicate', { rowId })
      return respond(200, { ok: true, duplicate: true, rowId })
    }
    throw err
  }

  console.log('[vendor-ap-intake] row created', { rowId, attachments: verified.length })
  return respond(200, { ok: true, duplicate: false, rowId })
}

export const handler = async (event: FnUrlEvent) => {
  if (event.requestContext?.http?.method && event.requestContext.http.method !== 'POST') {
    return respond(405, { error: 'method not allowed' })
  }

  let raw: unknown
  try {
    raw = parseBody(event)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'bad request'
    return respond(400, { error: message })
  }

  const action = isPlainObject(raw) && typeof raw.action === 'string' ? raw.action : undefined
  const isPrepare = action === 'prepare'
  const isCommit = action === 'commit'

  if (!isPrepare && !isCommit) {
    return respond(400, { error: 'action must be prepare or commit' })
  }

  try {
    if (isPrepare) {
      const validated = validatePreparePayload(raw)
      if (!validated.ok) {
        if (validated.status === 401) console.warn('[vendor-ap-intake] unauthorized request')
        return respond(validated.status, { error: validated.error })
      }
      if (!secretEquals(validated.payload.secret)) {
        console.warn('[vendor-ap-intake] unauthorized request')
        return respond(401, { error: 'unauthorized' })
      }
      const dynamo = new DynamoDBClient({})
      const s3 = new S3Client({})
      return await handlePrepare(validated.payload, dynamo, s3)
    }

    const validated = validateCommitPayload(raw)
    if (!validated.ok) {
      if (validated.status === 401) console.warn('[vendor-ap-intake] unauthorized request')
      return respond(validated.status, { error: validated.error })
    }
    if (!secretEquals(validated.payload.secret)) {
      console.warn('[vendor-ap-intake] unauthorized request')
      return respond(401, { error: 'unauthorized' })
    }
    const dynamo = new DynamoDBClient({})
    const s3 = new S3Client({})
    return await handleCommit(validated.payload, dynamo, s3)
  } catch (err) {
    console.error('[vendor-ap-intake] unexpected error', err)
    throw err
  }
}
