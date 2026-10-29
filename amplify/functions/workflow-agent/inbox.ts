/**
 * workflow-agent — the Function URL inbox.
 *
 * The same two-phase prepare/commit protocol `vendor-ap-intake` uses, with one
 * field added: `role`, which names the inbox the mail arrived in and therefore
 * the agent that reads it. The bridge (an Apps Script on the mailbox) cannot
 * stream a 20 MB attachment through a Lambda, so it asks for presigned PUTs,
 * uploads straight to S3, then commits. The commit HEAD-verifies every object
 * it was promised before any row is written: a size or content type that does
 * not match what was prepared is a 422, not an invoice nobody can open.
 *
 * The URL is authType NONE, so the body's `secret` is the only authentication
 * it has — compared as a SHA-256 digest through `timingSafeEqual`, never as a
 * string, exactly as the other intake Lambdas do.
 */
import { createHash, timingSafeEqual } from 'crypto'
import { isAgent, type WorkflowAgentKey } from '../../../src/lib/workflows/agents'
import { runFor, runIdFor } from './run'
import {
  INBOX_SECRET,
  getRun,
  headObject,
  nowIso,
  putObjectJson,
  signedPutUrl,
  type RunRow,
} from './store'

const MAX_BODY_BYTES = 1 * 1024 * 1024
const MAX_SUBJECT_LENGTH = 500
const MAX_BODY_LENGTH = 50_000
const MAX_ATTACHMENTS = 50
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** A real `Authentication-Results` header with folded continuation lines runs a few
 *  hundred characters; anything past this is not a verdict. */
const MAX_AUTH_RESULT_LENGTH = 1000

const PDF_TYPE = 'application/pdf'
const PNG_TYPE = 'image/png'
const JPEG_TYPE = 'image/jpeg'

/** The inboxes that exist. Anything else is a bridge misconfiguration — 422. */
const INBOX_ROLES: Record<string, true> = { QUOTE: true, CAPACITY: true, AP: true, TENDER: true }

export interface FnUrlEvent {
  body?: string
  isBase64Encoded?: boolean
  requestContext?: { http?: { method?: string } }
}

interface AttachmentMeta {
  name: string
  contentType: string
  size: number
}

interface CommitAttachment extends AttachmentMeta {
  s3Key: string
}

interface BasePayload {
  secret: string
  role: WorkflowAgentKey
  messageId: string
  subject: string
  fromEmail: string
  fromName: string
  receivedAt: string
  bodyText: string
  /** The message's raw `Authentication-Results` header as the bridge read it, or ''
   *  when the message carried none. Stored verbatim and interpreted nowhere here —
   *  `matchParty` is the one place that grades a sender, and a verdict this file had
   *  already "helpfully" parsed would be a second opinion to keep in step. */
  authResult: string
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

function errorNameOf(err: unknown): string | undefined {
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
  if (typeof provided !== 'string' || !INBOX_SECRET) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(INBOX_SECRET).digest()
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

function parseISOOrNow(raw: string): string {
  if (!raw) return nowIso()
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? nowIso() : new Date(ms).toISOString()
}

function sha20(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

/**
 * Where this message lives and what its run will be called.
 *
 * The slot is the message hash rather than the run id, because the run id is
 * itself a hash OF the message key — `runFor` derives it from `sourceKey`, and
 * there is exactly one id formula in step K. Deterministic either way: the same
 * messageId always lands in the same folder under the same run.
 */
export function slotFor(role: WorkflowAgentKey, messageId: string): { prefix: string; sourceKey: string; runId: string } {
  const prefix = `workflow-inbox/${sha20(messageId)}`
  const sourceKey = `${prefix}/message.json`
  return { prefix, sourceKey, runId: runIdFor(role, sourceKey) }
}

function attachmentKey(prefix: string, index: number, name: string, contentType: string): string {
  let ext: string
  if (contentType === PDF_TYPE) ext = 'pdf'
  else if (contentType === PNG_TYPE) ext = 'png'
  else if (contentType === JPEG_TYPE) ext = 'jpg'
  else {
    const fromName = name.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1].toLowerCase()
    ext = fromName && /^[a-z0-9]+$/.test(fromName) ? fromName : 'bin'
  }
  const basePart = name.split(/[\\/]/).pop() ?? name
  let cleaned = basePart.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '')
  if (!cleaned) cleaned = 'attachment'
  const base = cleaned.replace(/\.[^.]+$/, '').slice(0, 120)
  return `${prefix}/${index}-${base}.${ext}`
}

function validateAttachmentMeta(raw: unknown, index: number): AttachmentMeta {
  if (!isPlainObject(raw)) throw new Error(`attachments[${index}] must be an object`)
  const name = requireString(raw.name, `attachments[${index}].name`, 255)
  const contentType = requireString(raw.contentType, `attachments[${index}].contentType`, 255)
  const size = raw.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    throw new Error(`attachments[${index}].size must be a positive number`)
  }
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`attachments[${index}] is too large`)
  return { name, contentType, size }
}

function validateBase(raw: unknown): ValidationResult<BasePayload> {
  if (!isPlainObject(raw)) return { ok: false, status: 400, error: 'invalid JSON body' }
  if (typeof raw.secret !== 'string') return { ok: false, status: 401, error: 'unauthorized' }
  const role = typeof raw.role === 'string' ? raw.role.toUpperCase().trim() : ''
  if (!INBOX_ROLES[role] || !isAgent(role)) {
    return { ok: false, status: 422, error: 'role must be one of QUOTE, CAPACITY, AP, TENDER' }
  }
  try {
    return {
      ok: true,
      payload: {
        secret: raw.secret,
        role,
        messageId: requireString(raw.messageId, 'messageId', 500),
        subject: typeof raw.subject === 'string' ? raw.subject.slice(0, MAX_SUBJECT_LENGTH) : '',
        fromEmail: typeof raw.fromEmail === 'string' ? raw.fromEmail.slice(0, 320).trim() : '',
        fromName: typeof raw.fromName === 'string' ? raw.fromName.slice(0, 255).trim() : '',
        receivedAt: typeof raw.receivedAt === 'string' ? raw.receivedAt : '',
        bodyText: typeof raw.bodyText === 'string' ? raw.bodyText.slice(0, MAX_BODY_LENGTH) : '',
        authResult: typeof raw.authResult === 'string' ? raw.authResult.slice(0, MAX_AUTH_RESULT_LENGTH) : '',
      },
    }
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : 'bad request' }
  }
}

function validateAttachments(raw: unknown): AttachmentMeta[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('attachments must be an array')
  if (raw.length > MAX_ATTACHMENTS) throw new Error('too many attachments')
  return raw.map(validateAttachmentMeta)
}

function validateCommitAttachments(raw: unknown): CommitAttachment[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('attachments must be an array')
  if (raw.length > MAX_ATTACHMENTS) throw new Error('too many attachments')
  return raw.map((entry, index) => {
    const meta = validateAttachmentMeta(entry, index)
    const record = isPlainObject(entry) ? entry : {}
    return { ...meta, s3Key: requireString(record.s3Key, `attachments[${index}].s3Key`, 500) }
  })
}

async function handlePrepare(payload: BasePayload, rawAttachments: unknown) {
  const { prefix, runId } = slotFor(payload.role, payload.messageId)
  if (await getRun(runId)) {
    console.log('[workflow-agent] inbox prepare duplicate, skipping', { runId })
    return respond(200, { ok: true, duplicate: true, runId })
  }
  const attachments = validateAttachments(rawAttachments)
  const uploadUrls = []
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    const contentType = normalizeContentType(att.contentType)
    const s3Key = attachmentKey(prefix, i, att.name, contentType)
    const url = await signedPutUrl(s3Key, contentType, att.size)
    uploadUrls.push({ name: att.name, contentType, size: att.size, s3Key, url })
  }
  return respond(200, { ok: true, duplicate: false, runId, uploadUrls })
}

async function handleCommit(payload: BasePayload, rawAttachments: unknown) {
  const { prefix, sourceKey, runId } = slotFor(payload.role, payload.messageId)
  if (await getRun(runId)) {
    console.log('[workflow-agent] inbox commit duplicate, skipping', { runId })
    return respond(200, { ok: true, duplicate: true, runId })
  }

  const attachments = validateCommitAttachments(rawAttachments)
  const verified = []
  for (const att of attachments) {
    // The caller names the keys it uploaded to, and a key is only ever handed out by
    // `handlePrepare` under this message's own folder. Anything else is somebody with
    // the shared secret pointing the run at an object the agent role happens to be able
    // to read — another message's invoice, a driver's upload, a vendor-AP PDF — which
    // would then be HEAD-verified against their own claimed size and type, read to the
    // model as this message's invoice, and filed as a ShipmentDocument on the match.
    if (!att.s3Key.startsWith(`${prefix}/`)) {
      console.warn('[workflow-agent] commit named a key outside its own slot', { runId, s3Key: att.s3Key })
      return respond(422, { error: `attachment is outside this message's folder: ${att.name}` })
    }
    const contentType = normalizeContentType(att.contentType)
    let head
    try {
      head = await headObject(att.s3Key)
    } catch (err) {
      const name = errorNameOf(err)
      if (name === 'NotFound' || name === 'NoSuchKey') {
        // S3 is eventually consistent for a PUT the bridge only just finished.
        // 503 asks the bridge to send the same commit again rather than
        // recording a message whose attachment nobody can open.
        console.warn('[workflow-agent] attachment not yet in S3, will retry', { runId, s3Key: att.s3Key })
        return respond(503, { error: 'attachment verification failed' })
      }
      throw err
    }
    if (head.ContentLength !== att.size) {
      return respond(422, { error: `attachment size mismatch: ${att.name}` })
    }
    if (head.ContentType !== contentType) {
      return respond(422, { error: `attachment content type mismatch: ${att.name}` })
    }
    verified.push({ key: att.s3Key, name: att.name, contentType, size: att.size })
  }

  await putObjectJson(sourceKey, {
    messageId: payload.messageId,
    role: payload.role,
    subject: payload.subject,
    fromEmail: payload.fromEmail,
    fromName: payload.fromName,
    receivedAt: parseISOOrNow(payload.receivedAt),
    bodyText: payload.bodyText,
    // Verbatim, uninterpreted: `matchParty` grades it when the run reads the message.
    authResult: payload.authResult,
    attachments: verified,
  })

  const run = await runFor({
    sourceKind: 'INBOX',
    sourceId: payload.messageId,
    inboxRole: payload.role,
    provider: 'INBOX',
    sourceKey,
  })
  return respond(200, { ok: true, duplicate: false, runId: run.id, outcome: run.outcome ?? null })
}

export async function handleInbox(event: FnUrlEvent) {
  if (event.requestContext?.http?.method && event.requestContext.http.method !== 'POST') {
    return respond(405, { error: 'method not allowed' })
  }

  let raw: unknown
  try {
    raw = parseBody(event)
  } catch (err) {
    return respond(400, { error: err instanceof Error ? err.message : 'bad request' })
  }

  const action = isPlainObject(raw) && typeof raw.action === 'string' ? raw.action : undefined
  if (action !== 'prepare' && action !== 'commit') {
    return respond(400, { error: 'action must be prepare or commit' })
  }

  const validated = validateBase(raw)
  if (!validated.ok) {
    if (validated.status === 401) console.warn('[workflow-agent] unauthorized inbox request')
    return respond(validated.status, { error: validated.error })
  }
  if (!secretEquals(validated.payload.secret)) {
    console.warn('[workflow-agent] unauthorized inbox request')
    return respond(401, { error: 'unauthorized' })
  }

  const attachments = isPlainObject(raw) ? raw.attachments : null
  try {
    return action === 'prepare'
      ? await handlePrepare(validated.payload, attachments)
      : await handleCommit(validated.payload, attachments)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'bad request'
    if (/attachments\[|must be|too large|too many|is required/.test(message)) {
      return respond(422, { error: message })
    }
    console.error('[workflow-agent] inbox error', err)
    throw err
  }
}

/**
 * `RUN_SAMPLE` — the Try it button on the AI Agents settings page.
 *
 * A real run over a message a person typed, through the same message.json the
 * bridge writes, so what Try it exercises is the pipeline and not a second
 * code path that can drift from it.
 */
export async function sampleRun(input: {
  agent: WorkflowAgentKey
  subject: string
  body: string
  fromEmail: string
  messageId: string
}): Promise<RunRow> {
  const { sourceKey } = slotFor(input.agent, input.messageId)
  await putObjectJson(sourceKey, {
    messageId: input.messageId,
    role: input.agent,
    subject: input.subject,
    fromEmail: input.fromEmail,
    fromName: '',
    receivedAt: nowIso(),
    bodyText: input.body,
    attachments: [],
  })
  return runFor({
    sourceKind: 'INBOX',
    sourceId: input.messageId,
    inboxRole: input.agent,
    provider: 'SAMPLE',
    sourceKey,
  })
}
