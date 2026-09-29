import { createHash, randomUUID } from 'crypto'
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm'
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import WebSocket from 'ws'
import type {
  PodDocument,
  PodConnectionStatus,
  PodPage,
  PodSyncResult,
  PodAssets,
} from '../../../src/types/pods'
import { enhancePodImage } from './scan'
import { POD_SCAN_VERSION } from './scan-version.js'

// ── AWS clients ────────────────────────────────────────────────────────────

const dynamo = new DynamoDBClient({})
const s3 = new S3Client({})
const lambda = new LambdaClient({})
const ssm = new SSMClient({})
const cognito = new CognitoIdentityProviderClient({})

const POD_DOCUMENT_TABLE_NAME = process.env.POD_DOCUMENT_TABLE_NAME!
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME!
const BUCKET_NAME = process.env.BUCKET_NAME!
const POD_CONNECTION_PARAM_NAME = process.env.POD_CONNECTION_PARAM_NAME!
const POD_FUNCTION_NAME = process.env.POD_FUNCTION_NAME!
const USER_POOL_ID = process.env.USER_POOL_ID || 'us-east-1_IbPKPNJC9'

// ── Tunables ─────────────────────────────────────────────────────────────────

const JOBSDONE_REST_BASE = 'https://api.jobsdone.io/dev'
const JOBSDONE_WS_BASE = 'wss://websocket.jobsdone.io/dev-ws/'
const MEDIA_HOST = 'media.jobsdone.io'

const MAX_CONFIG_API_KEY_LEN = 512
const MAX_CONFIG_CLIENT_ID_LEN = 128
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 20_000
const WS_OPEN_TIMEOUT_MS = 10_000
const WS_MESSAGE_TIMEOUT_MS = 25_000
const WS_MAX_BYTES = 40 * 1024 * 1024
// JobsDone answers each page in ONE API Gateway WebSocket frame, which is capped at
// 128 KB; rows measure ~600 B, so 250 rows produced a 413 on their side and an
// unaddressed error frame on ours. 50 rows is ~30 KB; the backfill still walks every
// page, so page size only affects the number of round trips, never coverage.
const SYNC_LIMIT = 50
const PAGE_LIMIT = 50
const BACKFILL_WINDOW_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000
const PRESIGN_EXPIRY_SECONDS = 15 * 60
const LEASE_MS = 5 * 60 * 1000

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const PAGE_PODS_GROUP = 'page-pods'

// ── Event shapes ─────────────────────────────────────────────────────────────

export interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

interface AppSyncEvent {
  arguments: {
    action: string
    input?: string | Record<string, unknown> | null
  }
  identity?: AppSyncIdentity | null
}

interface ProcessPodInvokeEvent {
  action: 'processPodId'
  processPodId: string
}

interface BackfillScheduleEvent {
  action: 'backfillSchedule'
}

interface BackfillPageEvent {
  action: 'backfillPage'
  cutoffIso: string
  startKey?: Record<string, unknown> | null
}

type SelfInvokeEvent = ProcessPodInvokeEvent | BackfillScheduleEvent | BackfillPageEvent

type LambdaEvent = AppSyncEvent | SelfInvokeEvent

type ManageAction =
  | 'status'
  | 'configure'
  | 'list'
  | 'sync'
  | 'assets'
  | 'assign'
  | 'retry'
  | 'process'
  | 'backfill'

interface Caller {
  email: string
  isOwner: boolean
  isAdmin: boolean
  isPagePods: boolean
}

interface PodConnectionConfig {
  apiKey: string
  clientId: string
  companyName?: string | null
}

interface LoadedConfig extends PodConnectionConfig {
  configured: true
}

interface JobsDoneMessage {
  id: string
  clientId: string
  mediaUrl: string[]
  companyName?: string | null
  senderName?: string | null
  cusNumber?: string | null
  createdAt: string
  referenceNumber?: string | null
  notes?: string | null
  isAllowed?: boolean | null
}

// Internal full row includes fields not exposed to clients
interface StoredPodDocument extends PodDocument {
  sourceUrl: string
  processingLeaseUntil?: string | null
}

// ── Helper: input parsing ──────────────────────────────────────────────────

export function parseInput(
  input: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      throw new Error('Invalid input: not valid JSON')
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }
  if (Array.isArray(input) || typeof input !== 'object') {
    throw new Error('Invalid input: must be an object')
  }
  return input as Record<string, unknown>
}

// ── Authorization ────────────────────────────────────────────────────────────

function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export async function getCallerEmail(identity: AppSyncIdentity): Promise<string> {
  const claims = identity.claims ?? {}
  const candidates = [claims.email, identity.username, claims['cognito:username']]
  const found = candidates.find((v): v is string => typeof v === 'string' && v.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup) return ''
  try {
    const me = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }),
    )
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[pod-actions] could not resolve caller email:', String(err))
    return ''
  }
}

export async function authorize(
  action: ManageAction,
  identity?: AppSyncIdentity | null,
): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isOwner = email === OWNER_EMAIL
  const isAdmin = groups.includes(ADMIN_GROUP)
  const isPagePods = groups.includes(PAGE_PODS_GROUP)

  if (action === 'configure') {
    if (!isOwner && !isAdmin) {
      throw new Error('Forbidden: configure requires owner or ADMIN')
    }
  } else if (action === 'sync' || action === 'assign' || action === 'retry' || action === 'backfill') {
    if (!isOwner && !isAdmin && !isPagePods) {
      throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${PAGE_PODS_GROUP}`)
    }
  } else if (action === 'list' || action === 'assets' || action === 'status' || action === 'process') {
    // assets checks document-level visibility separately; status/process just needs auth
  }

  return { email, isOwner, isAdmin, isPagePods }
}

function assertGlobalAccess(caller: Caller): void {
  if (!caller.isOwner && !caller.isAdmin && !caller.isPagePods) {
    throw new Error(`Forbidden: requires owner, ADMIN, or ${PAGE_PODS_GROUP}`)
  }
}

// ── Validation helpers ─────────────────────────────────────────────────────

function assertString(value: unknown, label: string, maxLen?: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  if (maxLen != null && trimmed.length > maxLen) throw new Error(`${label} exceeds ${maxLen} characters`)
  return trimmed
}

function assertPositiveInteger(value: unknown, label: string): number {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return num
}

function nowIso(): string {
  return new Date().toISOString()
}

function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name
  }
  return undefined
}

function conflictError(message: string, cause: unknown): Error {
  const err = new Error(message)
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

/** ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly. */
function errorWithCause(message: string, cause: unknown): Error {
  const err = new Error(message)
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

// ── Config / tenant ──────────────────────────────────────────────────────────

// Cached per warm container: a PODs page issues one `assets` call per card, and
// Parameter Store throttles at 40 GetParameter/s account-wide.
const CONFIG_CACHE_MS = 60_000
let cachedConfig: { value: PodConnectionConfig | null; expiresAt: number } | null = null

/** Test hook: forget the cached connection so each case reads its own SSM stub. */
export function resetConnectionConfigCache(): void {
  cachedConfig = null
}

export async function getConnectionConfig(): Promise<PodConnectionConfig | null> {
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig.value
  const value = await readConnectionConfig()
  cachedConfig = { value, expiresAt: Date.now() + CONFIG_CACHE_MS }
  return value
}

async function readConnectionConfig(): Promise<PodConnectionConfig | null> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: POD_CONNECTION_PARAM_NAME, WithDecryption: true }),
    )
    const raw = result.Parameter?.Value ?? ''
    if (!raw || raw === 'not-configured') return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { apiKey, clientId, companyName } = parsed as Record<string, unknown>
    if (typeof apiKey !== 'string' || !apiKey.trim()) return null
    if (typeof clientId !== 'string' || !clientId.trim()) return null
    return {
      apiKey: apiKey.trim(),
      clientId: clientId.trim(),
      companyName: typeof companyName === 'string' ? companyName : null,
    }
  } catch (err) {
    if (errorName(err) === 'ParameterNotFound') return null
    // A throttled or failing SSM read is not "unconfigured": reporting it as such
    // would disable sync in the UI and bypass the tenant-change guard in configure.
    throw errorWithCause('Could not read the JobsDone connection settings; try again', err)
  }
}

async function requireConfig(): Promise<LoadedConfig> {
  const config = await getConnectionConfig()
  if (!config) {
    throw new Error('POD connection is not configured. Contact an admin to set the JobsDone API key and client ID.')
  }
  return { ...config, configured: true }
}

async function putConnectionConfig(config: PodConnectionConfig): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: POD_CONNECTION_PARAM_NAME,
      Value: JSON.stringify(config),
      Type: 'SecureString',
      Overwrite: true,
    }),
  )
  cachedConfig = { value: config, expiresAt: Date.now() + CONFIG_CACHE_MS }
}

export async function fetchClientDetails(
  apiKey: string,
  clientId: string,
): Promise<{ clientId: string; companyName?: string | null }> {
  const url = new URL(`${JOBSDONE_REST_BASE}/getView`)
  url.searchParams.set('view', 'clientDetails')
  url.searchParams.set('clientId', clientId)
  if (url.hostname !== 'api.jobsdone.io' || url.protocol !== 'https:') {
    throw new Error('Invalid JobsDone API host')
  }

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `ApiKey ${apiKey}` },
      redirect: 'error',
      signal: (() => {
        const c = new AbortController()
        setTimeout(() => c.abort(), DOWNLOAD_TIMEOUT_MS)
        return c.signal
      })(),
    })
  } catch (err) {
    throw errorWithCause(`JobsDone REST connection failed: ${String(err)}`, err)
  }

  let body: unknown
  const text = await res.text()
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }

  if (typeof body === 'string' && body === 'No response from lambda') {
    throw new Error('JobsDone client details unavailable: No response from lambda')
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body)
    throw new Error(`JobsDone client details failed (${res.status}): ${detail}`)
  }
  if (body && typeof body === 'object' && 'error' in body && body.error != null) {
    throw new Error(`JobsDone client details error: ${JSON.stringify(body.error)}`)
  }
  if (typeof body !== 'object' || body == null || typeof (body as Record<string, unknown>).clientId !== 'string') {
    throw new Error('JobsDone client details response missing clientId')
  }
  const record = body as Record<string, unknown>
  if (record.clientId !== clientId) {
    throw new Error('JobsDone client details returned a different clientId')
  }
  const companyName =
    typeof record.companyName === 'string' ? record.companyName :
    typeof record.clientName === 'string' ? record.clientName :
    null
  return { clientId, companyName }
}

export function validateConfigInput(input: Record<string, unknown>): {
  apiKey: string
  clientId: string
} {
  const apiKey = assertString(input.apiKey, 'apiKey', MAX_CONFIG_API_KEY_LEN)
  const clientId = assertString(input.clientId, 'clientId', MAX_CONFIG_CLIENT_ID_LEN)
  // Reject obvious URL injection; JobsDone IDs are opaque tokens, not URLs.
  if (/[:/\s]/.test(clientId)) {
    throw new Error('clientId contains invalid characters')
  }
  if (apiKey.length < 8) throw new Error('apiKey is too short')
  return { apiKey, clientId }
}

// ── Actions: status / configure ──────────────────────────────────────────────

export async function statusAction(): Promise<PodConnectionStatus> {
  const config = await getConnectionConfig()
  const backgroundSyncEnabled = process.env.POD_BACKGROUND_SYNC_ENABLED === 'true'
  if (!config) return { configured: false, backgroundSyncEnabled }
  return { configured: true, backgroundSyncEnabled, clientId: config.clientId, companyName: config.companyName ?? undefined }
}

export async function configureAction(
  input: Record<string, unknown>,
): Promise<PodConnectionStatus> {
  const { apiKey, clientId } = validateConfigInput(input)
  const current = await getConnectionConfig()
  if (current && current.clientId && current.clientId !== clientId) {
    throw new Error(
      `Refusing to change clientId from "${current.clientId}" to "${clientId}". Clear the existing connection first or re-enter the same tenant.`,
    )
  }
  const details = await fetchClientDetails(apiKey, clientId)
  await putConnectionConfig({
    apiKey,
    clientId,
    companyName: details.companyName ?? current?.companyName ?? null,
  })
  // A successful configuration starts an async scan of the last-7-days window so the
  // user does not have to press the manual backfill button.
  await queueBackfillSchedule()
  return { configured: true, clientId, companyName: details.companyName ?? undefined }
}

// ── DynamoDB helpers ───────────────────────────────────────────────────────

export async function getPodDocument(id: string): Promise<StoredPodDocument | null> {
  const result = await dynamo.send(
    new GetItemCommand({ TableName: POD_DOCUMENT_TABLE_NAME, Key: marshall({ id }), ConsistentRead: true }),
  )
  if (!result.Item) return null
  return unmarshall(result.Item) as StoredPodDocument
}

export function serializeStoredPodDocument(item: StoredPodDocument): PodDocument {
  // Intentionally drop backend-only sourceUrl from client-facing payloads.
  const { sourceUrl: _, ...rest } = item
  return rest
}

// ── S3 helpers ─────────────────────────────────────────────────────────────

function originalKey(id: string): string {
  return `pods/${id}/original`
}

function enhancedKey(id: string): string {
  return `pods/${id}/enhanced.jpg`
}

export async function uploadBytes(key: string, bytes: Buffer, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: bytes,
      ContentType: contentType,
    }),
  )
}

export async function getObjectBytes(key: string): Promise<{ bytes: Buffer; contentType?: string }> {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }))
  const stream = result.Body as unknown as NodeJS.ReadableStream | undefined
  if (!stream) throw new Error('S3 object has no body')
  const chunks: Buffer[] = []
  return await new Promise<{ bytes: Buffer; contentType?: string }>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve({ bytes: Buffer.concat(chunks), contentType: result.ContentType }))
  })
}

export async function signedGetUrl(key: string | null | undefined): Promise<string | undefined> {
  if (!key) return undefined
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), {
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  })
}

// ── Image download ───────────────────────────────────────────────────────────

export function validateMediaUrl(urlString: string): URL {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    throw new Error('Invalid media URL')
  }
  if (url.protocol !== 'https:') throw new Error('Media URL must use HTTPS')
  if (url.hostname !== MEDIA_HOST) throw new Error(`Media URL must be on ${MEDIA_HOST}`)
  if (url.username || url.password) throw new Error('Media URL must not contain credentials')
  if (url.port) throw new Error('Media URL must use the standard HTTPS port')
  if (url.searchParams.toString()) {
    // Presigned media URLs may need query params; leave validation lenient enough
    // for real URLs but reject custom ports/credentials above.
  }
  return url
}

export async function downloadMedia(urlString: string): Promise<{ bytes: Buffer; contentType?: string }> {
  const url = validateMediaUrl(urlString)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url.toString(), {
      // media endpoint needs no key; omit Authorization to avoid leaking credentials.
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (errorName(err) === 'AbortError') throw errorWithCause('Download timed out', err)
    throw errorWithCause(`Download failed: ${String(err)}`, err)
  }
  clearTimeout(timer)
  if (!res.ok) throw new Error(`Download failed (${res.status})`)

  let contentType = res.headers.get('content-type') ?? undefined
  const arrayBuffer = await res.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
  }
  const bytes = Buffer.from(arrayBuffer)
  if (!contentType && bytes.length > 0) {
    // Basic JPEG/PNG sniff as a last resort
    if (bytes[0] === 0xff && bytes[1] === 0xd8) contentType = 'image/jpeg'
    else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      contentType = 'image/png'
    }
  }
  return { bytes, contentType }
}

// ── Async processing ───────────────────────────────────────────────────────

export function stableDocumentId(
  clientId: string,
  messageId: string,
  mediaUrl: string,
  index: number,
): string {
  return createHash('sha256')
    .update(`${clientId}:${messageId}:${mediaUrl}:${index}`)
    .digest('hex')
}

export async function queueProcessPod(processPodId: string): Promise<void> {
  await lambda.send(
    new InvokeCommand({
      FunctionName: POD_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ action: 'processPodId', processPodId })),
    }),
  )
}

export async function queueBackfillSchedule(): Promise<void> {
  await lambda.send(
    new InvokeCommand({
      FunctionName: POD_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ action: 'backfillSchedule' })),
    }),
  )
}

function windowCutoffIso(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString()
}

function isExpiredLease(item: StoredPodDocument): boolean {
  return item.processingLeaseUntil != null && item.processingLeaseUntil < nowIso()
}

function hasActiveLease(item: StoredPodDocument): boolean {
  return item.processingLeaseUntil != null && item.processingLeaseUntil >= nowIso()
}

function isStalePending(item: StoredPodDocument): boolean {
  if (item.processingStatus !== 'PENDING' || hasActiveLease(item)) return false
  const staleThreshold = new Date(Date.now() - LEASE_MS).toISOString()
  return item.updatedAt < staleThreshold
}

function needsProcessingRefresh(existing: StoredPodDocument | null): boolean {
  if (!existing) return false
  if (existing.processingStatus === 'ORIGINAL_ONLY') return false
  if (existing.processingStatus === 'FAILED') return existing.originalKey != null
  if (isStalePending(existing)) return true
  if (existing.processingStatus === 'READY' && existing.enhancedKey == null) return true
  const isImage = /^image\/(jpeg|png)(;|$)/i.test(existing.contentType ?? '')
  if (!isImage) return false
  return (existing.processingVersion ?? 0) < POD_SCAN_VERSION
}

async function upsertPodDocument(
  message: JobsDoneMessage,
  mediaUrl: string,
  index: number,
): Promise<{ stored: StoredPodDocument; shouldQueue: boolean }> {
  const fresh = messageToDocument(message, mediaUrl, index)
  const existing = await getPodDocument(fresh.id)

  if (!existing) {
    try {
      validateMediaUrl(mediaUrl)
    } catch (err) {
      fresh.processingStatus = 'FAILED'
      fresh.processingError = `Attachment not imported: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: POD_DOCUMENT_TABLE_NAME,
          Item: marshall(fresh, { removeUndefinedValues: true }),
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      )
    } catch (err) {
      if (errorName(err) === 'ConditionalCheckFailedException') {
        return upsertPodDocument(message, mediaUrl, index)
      }
      throw err
    }
    return { stored: fresh, shouldQueue: fresh.processingStatus === 'PENDING' }
  }

  // Preserve manual assignments, archived originals, and any current scan output.
  // Use a metadata-only update when the row is quiescent; never clear an active lease
  // or bump updatedAt when a worker already owns the row.
  const now = nowIso()
  const shouldQueue = needsProcessingRefresh(existing)
  const activePending = existing.processingStatus === 'PENDING' && !isExpiredLease(existing)

  if (!shouldQueue && activePending) {
    return { stored: existing, shouldQueue: false }
  }

  const metadataFields = [
    'clientId',
    'sourceMessageId',
    'mediaIndex',
    'companyName',
    'senderName',
    'senderContact',
    'receivedAt',
    'referenceNumber',
    'notes',
    'isAllowed',
    'fileName',
    'sourceUrl',
  ] as const
  const baseNames: Record<string, string> = { '#updatedAt': 'updatedAt' }
  const baseValues: Record<string, AttributeValue> = { ':updatedAt': { S: now } }
  const baseSet = [`#updatedAt = :updatedAt`]
  for (const field of metadataFields) {
    const value = fresh[field as keyof StoredPodDocument]
    baseNames[`#${field}`] = field
    baseValues[`:${field}`] = marshall({ [field]: value })[field]
    baseSet.push(`#${field} = :${field}`)
  }

  if (shouldQueue) {
    // CAS: only flip to PENDING if the lease is absent or already expired.
    // This prevents a scheduled refresh from stealing an in-flight worker's row.
    const queueCondition =
      'attribute_not_exists(#processingLeaseUntil) OR #processingLeaseUntil < :now'
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: POD_DOCUMENT_TABLE_NAME,
          Key: marshall({ id: existing.id }),
          UpdateExpression:
            `SET ${baseSet.join(', ')}, #processingStatus = :pending, #processingError = :emptyError, #processingVersion = :emptyVersion REMOVE #processingLeaseUntil`,
          ExpressionAttributeNames: {
            ...baseNames,
            '#processingStatus': 'processingStatus',
            '#processingError': 'processingError',
            '#processingVersion': 'processingVersion',
            '#processingLeaseUntil': 'processingLeaseUntil',
          },
          ExpressionAttributeValues: {
            ...baseValues,
            ':now': { S: now },
            ':pending': { S: 'PENDING' },
            ':emptyError': { NULL: true },
            ':emptyVersion': { NULL: true },
          },
          ConditionExpression: queueCondition,
        }),
      )
    } catch (err) {
      if (errorName(err) === 'ConditionalCheckFailedException') {
        console.warn('[pod-actions] upsert race lost for', existing.id)
        return { stored: existing, shouldQueue: false }
      }
      throw err
    }

    const stored: StoredPodDocument = {
      ...existing,
      ...fresh,
      loadId: existing.loadId,
      assignedBy: existing.assignedBy,
      assignedAt: existing.assignedAt,
      version: existing.version,
      originalKey: existing.originalKey,
      enhancedKey: existing.enhancedKey,
      contentType: existing.contentType ?? fresh.contentType,
      processingStatus: 'PENDING',
      processingError: null,
      processingVersion: null,
      processingLeaseUntil: undefined,
      updatedAt: now,
    }
    return { stored, shouldQueue: true }
  }

  // Quiescent metadata refresh: do not touch lease or processing state.
  await dynamo.send(
    new UpdateItemCommand({
      TableName: POD_DOCUMENT_TABLE_NAME,
      Key: marshall({ id: existing.id }),
      UpdateExpression: `SET ${baseSet.join(', ')}`,
      ExpressionAttributeNames: baseNames,
      ExpressionAttributeValues: baseValues,
      ConditionExpression: 'attribute_exists(id)',
    }),
  )

  const stored: StoredPodDocument = {
    ...existing,
    ...fresh,
    loadId: existing.loadId,
    assignedBy: existing.assignedBy,
    assignedAt: existing.assignedAt,
    version: existing.version,
    originalKey: existing.originalKey,
    enhancedKey: existing.enhancedKey,
    contentType: existing.contentType ?? fresh.contentType,
  }
  return { stored, shouldQueue: false }
}

// One invocation walks as many pages as its time budget allows (a page is ~0.5 s,
// so a week of feed normally completes in one call); a continuation hop is only
// used when the budget runs out. The earlier design - one async self-invoke per
// page - lost the rest of the walk whenever Lambda dropped a single queued event.
const BACKFILL_TIME_BUDGET_MS = 120_000

export async function backfillPageAction(
  input: BackfillPageEvent,
  deadlineMs: number = Date.now() + BACKFILL_TIME_BUDGET_MS,
): Promise<void> {
  const config = await requireConfig()
  const cutoffIso = input.cutoffIso
  let startKey: Record<string, unknown> | null | undefined = input.startKey
  let pages = 0
  let queued = 0
  let inWindow = 0
  let skippedRows = 0

  do {
    const { messages, lastEvaluatedKey, skipped } = await fetchJobsDoneMessages(config, startKey)
    pages++
    skippedRows += skipped
    for (const message of messages) {
      // Order across pages is arbitrary; never stop on an old row. Skip it and keep walking.
      if (message.createdAt < cutoffIso) continue
      inWindow++
      for (let i = 0; i < message.mediaUrl.length; i++) {
        const { stored, shouldQueue } = await upsertPodDocument(message, message.mediaUrl[i], i)
        if (shouldQueue || stored.processingStatus === 'PENDING') {
          await queueProcessPod(stored.id)
          queued++
        }
      }
    }
    startKey = lastEvaluatedKey ?? null
  } while (startKey && Date.now() < deadlineMs)

  console.log('[pod-actions] backfill walked:', {
    pages,
    inWindow,
    queued,
    skippedRows,
    cutoff: cutoffIso,
    continued: !!startKey,
  })

  if (startKey) {
    await lambda.send(
      new InvokeCommand({
        FunctionName: POD_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ action: 'backfillPage', cutoffIso, startKey })),
      }),
    )
  }
}

export async function backfillScheduleAction(): Promise<void> {
  const cutoffIso = windowCutoffIso(BACKFILL_WINDOW_DAYS)
  await backfillPageAction({ action: 'backfillPage', cutoffIso })
}

export async function backfillAction(): Promise<{ queued: true }> {
  await queueBackfillSchedule()
  return { queued: true }
}

export async function acquireProcessingLease(id: string): Promise<boolean> {
  const now = Date.now()
  const leaseUntil = new Date(now + LEASE_MS).toISOString()
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: POD_DOCUMENT_TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression:
          'attribute_not_exists(processingLeaseUntil) OR processingLeaseUntil < :now',
        UpdateExpression: 'SET processingLeaseUntil = :leaseUntil, updatedAt = :updatedAt',
        ExpressionAttributeValues: marshall({
          ':now': nowIso(),
          ':leaseUntil': leaseUntil,
          ':updatedAt': nowIso(),
        }),
      }),
    )
    return true
  } catch (err) {
    if (errorName(err) === 'ConditionalCheckFailedException') {
      console.log('[pod-actions] processing lease active for', id)
      return false
    }
    throw err
  }
}

export async function releaseProcessingLease(
  id: string,
  updates: Partial<StoredPodDocument>,
): Promise<void> {
  const item = await getPodDocument(id)
  if (!item) return
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' }
  const values: Record<string, AttributeValue> = { ':updatedAt': { S: nowIso() } }
  const setParts: string[] = ['#updatedAt = :updatedAt']
  const removeParts: string[] = []

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    if (value === null) {
      removeParts.push(`#${key}`)
    } else {
      values[`:${key}`] = marshall({ [key]: value })[key]
      setParts.push(`#${key} = :${key}`)
    }
  }
  names['#processingLeaseUntil'] = 'processingLeaseUntil'
  removeParts.push('#processingLeaseUntil')

  await dynamo.send(
    new UpdateItemCommand({
      TableName: POD_DOCUMENT_TABLE_NAME,
      Key: marshall({ id }),
      UpdateExpression: `SET ${setParts.join(', ')} REMOVE ${removeParts.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(id)',
    }),
  )
}

export async function processPodDocument(processPodId: string): Promise<void> {
  const item = await getPodDocument(processPodId)
  if (!item) {
    console.warn('[pod-actions] processPodId item not found:', processPodId)
    return
  }

  const acquired = await acquireProcessingLease(processPodId)
  if (!acquired) return

  let sourceBytes: Buffer | undefined
  let sourceContentType: string | undefined

  try {
    if (item.originalKey) {
      const archived = await getObjectBytes(item.originalKey)
      sourceBytes = archived.bytes
      sourceContentType = archived.contentType ?? item.contentType ?? undefined
    } else {
      const fetched = await downloadMedia(item.sourceUrl)
      sourceBytes = fetched.bytes
      sourceContentType = fetched.contentType
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await releaseProcessingLease(processPodId, {
      processingStatus: 'FAILED',
      processingError: msg,
    })
    return
  }

  if (!sourceBytes || sourceBytes.length === 0) {
    await releaseProcessingLease(processPodId, {
      processingStatus: 'FAILED',
      processingError: 'Empty download',
    })
    return
  }

  // Store the original intact before any enhancement. A failure here must release
  // the lease as FAILED, or the document would sit in PENDING with no retry path.
  if (!item.originalKey) {
    const contentType = sourceContentType ?? 'application/octet-stream'
    try {
      await uploadBytes(originalKey(processPodId), sourceBytes, contentType)
    } catch (err) {
      await releaseProcessingLease(processPodId, {
        processingStatus: 'FAILED',
        processingError: `Could not archive original: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    item.originalKey = originalKey(processPodId)
    item.contentType = contentType
  }

  // Determine whether we can enhance.
  const isImage = /^image\/(jpeg|png)(;|$)/i.test(sourceContentType ?? item.contentType ?? '')
  if (!isImage) {
    await releaseProcessingLease(processPodId, {
      processingStatus: 'ORIGINAL_ONLY',
      processingError: null,
      originalKey: item.originalKey,
      contentType: item.contentType,
      processingVersion: POD_SCAN_VERSION,
      scanReviewReason: null,
    })
    return
  }

  // If we already have a current-generation enhanced image, keep it and release.
  const alreadyCurrentImage =
    /^image\/(jpeg|png)(;|$)/i.test(item.contentType ?? '') &&
    (item.processingVersion ?? 0) >= POD_SCAN_VERSION &&
    item.enhancedKey != null &&
    item.processingStatus === 'READY'
  if (alreadyCurrentImage) {
    await releaseProcessingLease(processPodId, {
      processingStatus: 'READY',
      processingError: null,
      originalKey: item.originalKey,
      enhancedKey: item.enhancedKey,
      contentType: item.contentType,
      processingVersion: POD_SCAN_VERSION,
      scanReviewReason: item.scanReviewReason ?? null,
    })
    return
  }

  try {
    const enhanced = await enhancePodImage(
      sourceBytes,
      sourceContentType ?? item.contentType ?? 'image/jpeg',
    )
    if (!enhanced) {
      await releaseProcessingLease(processPodId, {
        processingStatus: 'ORIGINAL_ONLY',
        processingError: null,
        originalKey: item.originalKey,
        contentType: item.contentType,
        processingVersion: POD_SCAN_VERSION,
        scanReviewReason: null,
      })
      return
    }
    await uploadBytes(enhancedKey(processPodId), enhanced.bytes, enhanced.contentType)
    await releaseProcessingLease(processPodId, {
      processingStatus: 'READY',
      processingError: null,
      originalKey: item.originalKey,
      enhancedKey: enhancedKey(processPodId),
      contentType: item.contentType,
      processingVersion: enhanced.scanVersion ?? POD_SCAN_VERSION,
      scanReviewReason: enhanced.scanReviewReason ?? null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await releaseProcessingLease(processPodId, {
      processingStatus: 'FAILED',
      processingError: msg,
      originalKey: item.originalKey,
      contentType: item.contentType,
    })
  }
}

// ── JobsDone WebSocket sync ────────────────────────────────────────────────

export async function fetchJobsDoneMessages(
  config: LoadedConfig,
  startKey?: unknown,
): Promise<{ messages: JobsDoneMessage[]; lastEvaluatedKey?: Record<string, unknown> | null; skipped: number }> {
  const requestId = randomUUID()
  const url = `${JOBSDONE_WS_BASE}?clientId=${encodeURIComponent(config.clientId)}`

  const ws = new WebSocket(url, { headers: { Authorization: `ApiKey ${config.apiKey}` } })
  let cleanup: (() => void) | null = null
  let openTimer: ReturnType<typeof setTimeout> | undefined

  return new Promise((resolve, reject) => {
    let settled = false
    let bytesRead = 0
    let frames = 0
    const ignored: string[] = []
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        cleanup?.()
        // Never log payloads: rows carry phone numbers. Counts and reasons only.
        reject(new Error(`JobsDone WebSocket timed out waiting for messages (frames=${frames}, ignored=${JSON.stringify(ignored.slice(0, 5))})`))
      }
    }, WS_MESSAGE_TIMEOUT_MS)

    const messages: JobsDoneMessage[] = []
    let lastEvaluatedKey: Record<string, unknown> | null | undefined

    cleanup = () => {
      clearTimeout(timer)
      if (openTimer) clearTimeout(openTimer)
      try { ws.close() } catch { /* ignore */ }
    }

    ws.on('open', () => {
      if (openTimer) clearTimeout(openTimer)
      const payload: Record<string, unknown> = {
        action: 'getMessages',
        clientId: config.clientId,
        limit: SYNC_LIMIT,
        meta: { requestId },
      }
      if (startKey) payload.startKey = startKey
      ws.send(JSON.stringify(payload))
    })

    ws.on('message', (data: Buffer | string) => {
      bytesRead += typeof data === 'string' ? Buffer.byteLength(data) : data.length
      if (bytesRead > WS_MAX_BYTES) {
        if (!settled) {
          settled = true
          cleanup?.()
          reject(new Error('JobsDone WebSocket response exceeded byte limit'))
        }
        return
      }
      frames++
      let parsed: unknown
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'))
      } catch {
        ignored.push('unparseable')
        return
      }
      if (!parsed || typeof parsed !== 'object') { ignored.push('non-object'); return }
      const envelope = parsed as Record<string, unknown>
      const meta = envelope.meta && typeof envelope.meta === 'object' ? (envelope.meta as Record<string, unknown>) : null
      // JobsDone's catch-all reply is `{action:'error', message}` with no meta; it is
      // the answer to our request, so fail now rather than waiting for a timeout.
      if (envelope.action === 'error' && meta == null) {
        if (!settled) {
          settled = true
          cleanup?.()
          reject(new Error(`JobsDone rejected the feed request: ${String(envelope.message ?? 'unknown error').slice(0, 200)}`))
        }
        return
      }
      if (meta?.requestId !== requestId) { ignored.push(`requestId:${String(envelope.action)}`); return }
      if (envelope.action !== 'getMessages') { ignored.push(`action:${String(envelope.action)}`); return }

      if (envelope.error != null) {
        if (!settled) {
          settled = true
          cleanup?.()
          reject(new Error(`JobsDone WebSocket error: ${JSON.stringify(envelope.error)}`))
        }
        return
      }

      const dataField = Array.isArray(envelope.data) ? envelope.data : []
      let skipped = 0
      lastEvaluatedKey =
        envelope.lastEvaluatedKey && typeof envelope.lastEvaluatedKey === 'object'
          ? (envelope.lastEvaluatedKey as Record<string, unknown>)
          : null

      // The feed is newest-first, so aborting the page on one bad row would block
      // every later sync behind it. Skip and count instead; the count is returned.
      for (const raw of dataField) {
        if (!raw || typeof raw !== 'object') { skipped++; continue }
        const msg = raw as Record<string, unknown>
        const createdAt = typeof msg.createdAt === 'string' ? msg.createdAt : null
        if (typeof msg.id !== 'string' || msg.clientId !== config.clientId || !createdAt) {
          skipped++
          console.warn('[pod-actions] skipping malformed or foreign JobsDone row', JSON.stringify({ id: msg.id, clientId: msg.clientId }))
          continue
        }
        // A text-only SMS has no mediaUrl at all: a message with no attachments, not a bad row.
        const mediaUrl = Array.isArray(msg.mediaUrl) ? msg.mediaUrl : []
        const toString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
        messages.push({
          id: msg.id,
          clientId: msg.clientId,
          mediaUrl: mediaUrl.filter((u: unknown): u is string => typeof u === 'string' && u.length > 0),
          companyName: toString(msg.companyName),
          senderName: toString(msg.senderName),
          cusNumber: toString(msg.cusNumber),
          createdAt,
          referenceNumber: toString(msg.referenceNumber),
          notes: toString(msg.notes),
          isAllowed: typeof msg.isAllowed === 'boolean' ? msg.isAllowed : null,
        })
      }

      if (!settled) {
        settled = true
        cleanup?.()
        resolve({ messages, lastEvaluatedKey, skipped })
      }
    })

    ws.on('error', (err: Error) => {
      if (!settled) {
        settled = true
        cleanup?.()
        reject(new Error(`JobsDone WebSocket error: ${err.message}`))
      }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      if (!settled) {
        settled = true
        cleanup?.()
        reject(new Error(`JobsDone WebSocket closed before replying (code=${code}, reason=${reason.toString().slice(0, 80)}, frames=${frames})`))
      }
    })

    ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      if (!settled) {
        settled = true
        cleanup?.()
        reject(new Error(`JobsDone WebSocket handshake rejected (HTTP ${res.statusCode})`))
      }
    })

    openTimer = setTimeout(() => {
      if (!settled) {
        settled = true
        cleanup?.()
        reject(new Error('JobsDone WebSocket connection timed out'))
      }
    }, WS_OPEN_TIMEOUT_MS)
  })
}

function messageToDocument(
  message: JobsDoneMessage,
  mediaUrl: string,
  index: number,
): StoredPodDocument {
  const now = nowIso()
  const id = stableDocumentId(message.clientId, message.id, mediaUrl, index)
  const fileName = (() => {
    try {
      return new URL(mediaUrl).pathname.split('/').pop() ?? `attachment-${index}`
    } catch {
      return `attachment-${index}`
    }
  })()

  return {
    id,
    clientId: message.clientId,
    sourceMessageId: message.id,
    mediaIndex: index,
    companyName: message.companyName ?? '',
    senderName: message.senderName ?? '',
    senderContact: message.cusNumber ?? '',
    receivedAt: message.createdAt,
    referenceNumber: message.referenceNumber ?? '',
    notes: message.notes ?? '',
    isAllowed: message.isAllowed ?? true,
    fileName,
    contentType: null,
    originalKey: null,
    enhancedKey: null,
    processingStatus: 'PENDING',
    processingError: null,
    // Absent (not NULL) so the loadId GSI, whose partition key this is, accepts the row.
    loadId: undefined,
    assignedBy: undefined,
    assignedAt: undefined,
    version: 1,
    createdAt: now,
    updatedAt: now,
    sourceUrl: mediaUrl,
  }
}

export async function syncAction(
  input: Record<string, unknown>,
): Promise<PodSyncResult> {
  const config = await requireConfig()
  await fetchClientDetails(config.apiKey, config.clientId)

  let startKey: unknown
  if (input.nextToken) {
    const raw = String(input.nextToken)
    try {
      startKey = JSON.parse(raw)
    } catch {
      startKey = raw
    }
  }
  const { messages, lastEvaluatedKey, skipped } = await fetchJobsDoneMessages(
    config,
    startKey,
  )

  let imported = 0
  for (const message of messages) {
    for (let i = 0; i < message.mediaUrl.length; i++) {
      const mediaUrl = message.mediaUrl[i]
      const doc = messageToDocument(message, mediaUrl, i)
      // An attachment off media.jobsdone.io is never fetched (SSRF bound), but it is
      // still recorded as a FAILED row so staff can see it exists, and it must not
      // abort the rest of the page.
      try {
        validateMediaUrl(mediaUrl)
      } catch (err) {
        doc.processingStatus = 'FAILED'
        doc.processingError = `Attachment not imported: ${err instanceof Error ? err.message : String(err)}`
      }
      try {
        await dynamo.send(
          new PutItemCommand({
            TableName: POD_DOCUMENT_TABLE_NAME,
            Item: marshall(doc, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(id)',
          }),
        )
        imported++
        // Async processing is fire-and-forget; failures are logged and retriable.
        if (doc.processingStatus === 'PENDING') await queueProcessPod(doc.id)
      } catch (err) {
        if (errorName(err) === 'ConditionalCheckFailedException') {
          // Already imported; preserve existing assignment/processing state.
          continue
        }
        throw err
      }
    }
  }

  return {
    imported,
    skipped,
    nextToken: lastEvaluatedKey ? JSON.stringify(lastEvaluatedKey) : null,
  }
}

// ── list / assets / assign / retry ───────────────────────────────────────────

export async function listAction(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<PodPage> {
  const config = await requireConfig()
  const loadId = input.loadId != null ? String(input.loadId) : null

  if (!loadId) {
    assertGlobalAccess(caller)
  }

  const exclusiveStartKey = input.nextToken && String(input.nextToken).trim()
    ? JSON.parse(String(input.nextToken))
    : undefined

  const baseExpressionValues: Record<string, AttributeValue> = {
    ':clientId': { S: config.clientId },
  }
  const filterExpressions: string[] = []
  let keyCondition: string
  let indexName: string
  const scanIndexForward = false

  if (loadId) {
    indexName = 'podDocumentsByLoadIdAndReceivedAt'
    keyCondition = 'loadId = :loadId'
    baseExpressionValues[':loadId'] = { S: loadId }
    baseExpressionValues[':clientId'] = { S: config.clientId }
    filterExpressions.push('clientId = :clientId')
  } else {
    indexName = 'podDocumentsByClientIdAndReceivedAt'
    keyCondition = 'clientId = :clientId'
  }

  const result = await dynamo.send(
    new QueryCommand({
      TableName: POD_DOCUMENT_TABLE_NAME,
      IndexName: indexName,
      KeyConditionExpression: keyCondition,
      FilterExpression: filterExpressions.length ? filterExpressions.join(' AND ') : undefined,
      ExpressionAttributeValues: baseExpressionValues,
      ScanIndexForward: scanIndexForward,
      Limit: PAGE_LIMIT,
      ExclusiveStartKey: exclusiveStartKey ? marshall(exclusiveStartKey) : undefined,
    }),
  )

  const items = (result.Items ?? []).map((item) => serializeStoredPodDocument(unmarshall(item) as StoredPodDocument))
  const nextToken = result.LastEvaluatedKey ? JSON.stringify(unmarshall(result.LastEvaluatedKey)) : null
  return { items, nextToken }
}

export async function assetsAction(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<PodAssets> {
  const id = assertString(input.id, 'id')
  const config = await requireConfig()
  const item = await getPodDocument(id)
  if (!item) throw new Error(`POD not found: ${id}`)
  if (item.clientId !== config.clientId) throw new Error('POD belongs to a different tenant')

  if (!item.loadId) {
    assertGlobalAccess(caller)
  }

  const originalUrl = await signedGetUrl(item.originalKey)
  const enhancedUrl = await signedGetUrl(item.enhancedKey)
  return {
    item: serializeStoredPodDocument(item),
    originalUrl,
    enhancedUrl,
  }
}

export async function assignAction(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<{ item: PodDocument }> {
  assertGlobalAccess(caller)
  const config = await requireConfig()
  const id = assertString(input.id, 'id')
  const loadId = input.loadId != null ? String(input.loadId) : null
  const expectedVersion = assertPositiveInteger(input.expectedVersion, 'expectedVersion')

  const item = await getPodDocument(id)
  if (!item) throw new Error(`POD not found: ${id}`)
  if (item.clientId !== config.clientId) {
    throw new Error('POD belongs to a different tenant')
  }

  const now = nowIso()
  const nextVersion = expectedVersion + 1

  const transactItems: TransactWriteItem[] = []

  // `loadId` is the partition key of the loadId GSI: it must be absent, never NULL,
  // on an unassigned document, so unassign REMOVEs the attributes.
  transactItems.push({
    Update: {
      TableName: POD_DOCUMENT_TABLE_NAME,
      Key: marshall({ id }),
      ConditionExpression: '#version = :expectedVersion',
      UpdateExpression: loadId
        ? 'SET #loadId = :loadId, #assignedBy = :assignedBy, #assignedAt = :assignedAt, #version = :nextVersion, #updatedAt = :updatedAt'
        : 'SET #version = :nextVersion, #updatedAt = :updatedAt REMOVE #loadId, #assignedBy, #assignedAt',
      ExpressionAttributeNames: {
        '#version': 'version',
        '#loadId': 'loadId',
        '#assignedBy': 'assignedBy',
        '#assignedAt': 'assignedAt',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: marshall({
        ':expectedVersion': expectedVersion,
        ':nextVersion': nextVersion,
        ':updatedAt': now,
        ...(loadId ? { ':loadId': loadId, ':assignedBy': caller.email, ':assignedAt': now } : {}),
      }),
    },
  })

  if (loadId) {
    transactItems.push({
      ConditionCheck: {
        TableName: LOAD_TABLE_NAME,
        Key: marshall({ id: loadId }),
        ConditionExpression: 'attribute_exists(id)',
      },
    })
  }

  try {
    await dynamo.send(new TransactWriteItemsCommand({ TransactItems: transactItems }))
  } catch (err) {
    if (errorName(err) === 'TransactionCanceledException') {
      throw conflictError(
        `Could not assign POD: it changed (${expectedVersion}) or the Load no longer exists. Refresh and try again.`,
        err,
      )
    }
    throw err
  }

  const updated = await getPodDocument(id)
  if (!updated) throw new Error('POD disappeared after assignment')
  return { item: serializeStoredPodDocument(updated) }
}

export async function retryAction(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<{ item: PodDocument }> {
  assertGlobalAccess(caller)
  const config = await requireConfig()
  const id = assertString(input.id, 'id')

  const item = await getPodDocument(id)
  if (!item) throw new Error(`POD not found: ${id}`)
  if (item.clientId !== config.clientId) {
    throw new Error('POD belongs to a different tenant')
  }

  const now = nowIso()
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: POD_DOCUMENT_TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression:
          'attribute_not_exists(processingLeaseUntil) OR processingLeaseUntil < :now OR #status = :failed',
        UpdateExpression:
          'SET #status = :pending, processingError = :emptyError, #updatedAt = :updatedAt REMOVE processingLeaseUntil',
        ExpressionAttributeNames: {
          '#status': 'processingStatus',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: marshall({
          ':now': now,
          ':pending': 'PENDING',
          ':failed': 'FAILED',
          ':emptyError': null,
          ':updatedAt': now,
        }),
      }),
    )
  } catch (err) {
    if (errorName(err) === 'ConditionalCheckFailedException') {
      throw conflictError('This POD is already being processed. Wait for it to finish or try again later.', err)
    }
    throw err
  }

  await queueProcessPod(id)
  const updated = await getPodDocument(id)
  if (!updated) throw new Error('POD disappeared after retry')
  return { item: serializeStoredPodDocument(updated) }
}

// ── Entry point ────────────────────────────────────────────────────────────

function isSelfInvoke(event: LambdaEvent): event is SelfInvokeEvent {
  return (
    'action' in event &&
    (event.action === 'processPodId' || event.action === 'backfillSchedule' || event.action === 'backfillPage')
  )
}

export const handler = async (event: LambdaEvent): Promise<unknown> => {
  const eventAction = isSelfInvoke(event)
    ? event.action
    : (event as AppSyncEvent).arguments?.action
  console.log('[pod-actions] event:', JSON.stringify({ action: eventAction }))

  if (isSelfInvoke(event)) {
    if (event.action === 'processPodId') {
      await processPodDocument(event.processPodId)
      return { ok: true }
    }
    if (event.action === 'backfillSchedule') {
      await backfillScheduleAction()
      return { ok: true }
    }
    if (event.action === 'backfillPage') {
      await backfillPageAction(event)
      return { ok: true }
    }
    return { ok: false }
  }

  const appSyncEvent = event as AppSyncEvent
  const action = appSyncEvent.arguments.action as ManageAction
  const input = parseInput(appSyncEvent.arguments.input)

  switch (action) {
    case 'status':
      await authorize(action, appSyncEvent.identity)
      return statusAction()
    case 'configure':
      await authorize(action, appSyncEvent.identity)
      return configureAction(input)
    case 'list':
      return listAction(input, await authorize(action, appSyncEvent.identity))
    case 'sync':
      await authorize(action, appSyncEvent.identity)
      return syncAction(input)
    case 'backfill':
      await authorize(action, appSyncEvent.identity)
      return backfillAction()
    case 'assets':
      return assetsAction(input, await authorize(action, appSyncEvent.identity))
    case 'assign':
      return assignAction(input, await authorize(action, appSyncEvent.identity))
    case 'retry':
      return retryAction(input, await authorize(action, appSyncEvent.identity))
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
