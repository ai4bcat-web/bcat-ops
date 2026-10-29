/**
 * tms-tracking-actions Lambda handler — Step D.
 *
 * One writer for TrackingLink, and for everything that carries a link or a message
 * to somebody outside the office: the carrier-driver ping link (Twilio, through the
 * dispatch conversation), the per-shipment Customer Link (SES), and the "send these
 * notes to the driver" text the check-call dialog offers.
 *
 * Actions:
 *   SEND_TRACKING_LINK, REVOKE_TRACKING_LINK
 *   SEND_CUSTOMER_LINK, REVOKE_CUSTOMER_LINK
 *   TEXT_DRIVER
 *   SAVE_TRACKING_SETTINGS
 *   SEND_UPLOAD_LINK, REVOKE_UPLOAD_LINK      (step E — the carrier upload portal)
 *   SEND_MILESTONE_NOTICE, EMAIL_DOCUMENTS    (step E — what customers are told)
 *   SAVE_DOCUMENT_SETTINGS
 *
 * Deliberately separate from tms-shipment-actions: logging a check call moves Load
 * status and money and belongs on that router, but Twilio, SES, Cognito and the
 * dispatch tables have no business on its role.
 *
 * Two rules run through the whole file. First, **the token is the row id** — a
 * TrackingLink is 24 random bytes of base64url, so the public Lambda reads it by
 * primary key and no token index exists anywhere. Second, **nothing ever claims to
 * have sent what it did not send**: Twilio is unconfigured and SES is denied on dev,
 * so a send that cannot happen returns `smsStatus: 'NOT_CONFIGURED'` /
 * `emailStatus: 'NOT_SENT'` together with the URL, and the operator copies it.
 */
import { getAmplifyDataClientConfig, type DataClientEnv } from '@aws-amplify/backend-function/runtime'
import { Amplify } from 'aws-amplify'
import { generateClient } from 'aws-amplify/data'
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomBytes, randomUUID } from 'crypto'

import {
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  casCondition,
  getById as storeGetById,
  isConflict,
  conflictError,
  marshallRow,
  nowIso,
  numberOrNull,
  putItem,
  queryIndex as storeQueryIndex,
  readStops,
  transact as storeTransact,
  updateItemTx,
  type Row,
  type StopShape,
} from '../_shared/shipmentStore'
import { isVoided } from '../_shared/voided'
import { DispatchStore, tablesFromEnv } from '../_shared/dispatchStore'
import { loadDispatchConfig, type DispatchConfig } from '../_shared/dispatchConfig'
import { sendDispatchText, type SendDeps } from '../_shared/dispatchSend'
import { sendMessage } from '../_shared/twilio'
import { MAX_SMS_BODY, toE164Strict } from '../../../src/lib/dispatch'
import { linkExpiry, smsBodyFor } from '../../../src/lib/trackingLink'
import {
  DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES,
  DEFAULT_UPLOAD_LINK_EXPIRY_DAYS,
  MAX_UPLOAD_LINK_EXPIRY_DAYS,
  MIN_UPLOAD_LINK_EXPIRY_DAYS,
  canEmailTo,
  normalizeRequiredDocTypes,
} from '../../../src/lib/shipmentDocuments'
import {
  MAX_NOTICE_BODY_CHARS,
  milestoneRecipients,
  noticeId,
  renderDocumentsEmail,
  renderMilestoneEmail,
  renderPodRequestEmail,
  templateHasUrl,
  uploadLinkExpiry,
  type NoticeStop,
} from '../../../src/lib/shipmentNotices'
import { deliverNotice, type EmailAttachment } from '../_shared/shipmentNotices'
import type {
  CheckCallNotifyChannel,
  CustomerNotification,
  CustomerRecord,
  ShipmentDocumentRecord,
  ShipmentDocumentType,
  TrackingContact,
  TrackingLinkChannel,
  TrackingLinkStatus,
} from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})
const ses = new SESv2Client({})
const s3 = new S3Client({})

const TRACKING_LINK_TABLE_NAME = process.env.TRACKING_LINK_TABLE_NAME ?? ''
const LOAD_CHECK_CALL_TABLE_NAME = process.env.LOAD_CHECK_CALL_TABLE_NAME ?? ''
const SHIPMENT_TABLE_NAME = process.env.SHIPMENT_TABLE_NAME ?? ''
const ORDER_TABLE_NAME = process.env.ORDER_TABLE_NAME ?? ''
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''
const LOAD_CARRIER_TABLE_NAME = process.env.LOAD_CARRIER_TABLE_NAME ?? ''
const TMS_SETTINGS_TABLE_NAME = process.env.TMS_SETTINGS_TABLE_NAME ?? ''
const DIVISION_TABLE_NAME = process.env.DIVISION_TABLE_NAME ?? ''
const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
const SHIPMENT_DOCUMENT_TABLE_NAME = process.env.SHIPMENT_DOCUMENT_TABLE_NAME ?? ''
const SHIPMENT_NOTICE_TABLE_NAME = process.env.SHIPMENT_NOTICE_TABLE_NAME ?? ''
const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? ''
const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN ?? ''
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? ''
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'ai4bcat@gmail.com'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const LOAD_PAGE_GROUP = 'page-loads'
/** Step R: /loads became the one Shipments page, so `page-tms` opens the same door. */
const TMS_PAGE_GROUP = 'page-tms'
const SETTINGS_ID = 'default'

// Amplify derives GSI names from the plural model name and the key fields.
const IDX_TRACKING_LINKS_BY_SHIPMENT = 'trackingLinksByShipmentId'
const IDX_TRACKING_LINKS_BY_LOAD = 'trackingLinksByLoadId'

/** 24 bytes of entropy: 32 base64url characters, the length `isLinkToken` accepts. */
const TOKEN_BYTES = 24
/** Nobody emails a tracking link to a mailing list; twenty is already generous. */
const MAX_RECIPIENTS = 20
/** A covering note on a link, not an essay. */
const MAX_MESSAGE = 1000
/** A gateway's reason for refusing a text, on the check call: a line, not a stack. */
const MAX_NOTE_REASON = 200
/** The name on the text when the load has no division. */
const BROKER_FALLBACK = 'BCAT Logistics'

/** A link is pointless once the freight is off the truck and the file is closing. */
const CLOSED_LOAD_STATUSES: readonly string[] = ['DELIVERED', 'INVOICING', 'CANCELED']
/** A shipment nobody has submitted, or one that is dead, has nothing to track. */
const UNTRACKABLE_SHIPMENT_STATUSES: readonly string[] = ['DRAFT', 'CANCELED']

const NOTIFY_CHANNELS: readonly CheckCallNotifyChannel[] = ['IN_APP', 'SLACK', 'BOTH']
const CONTACT_MODES: readonly TrackingContact['mode'][] = ['CUSTOMER_REP', 'FIXED']

/** Settings bounds. A check call every twenty minutes is a pager, not a process. */
const MIN_INTERVAL_HOURS = 1
const MAX_INTERVAL_HOURS = 48
const MIN_GRACE_MINUTES = 0
const MAX_GRACE_MINUTES = 240
const MIN_LINK_EXPIRY_HOURS = 1
const MAX_LINK_EXPIRY_HOURS = 720
const MIN_CUSTOMER_LINK_DAYS = 1
const MAX_CUSTOMER_LINK_DAYS = 90
/**
 * Step J's shared tracking toggles. Stored and shown only: nothing reads them until a
 * tracking provider is live, so the bounds are the ones a provider would accept — a
 * five-minute floor on the ping and two weeks of tracking as the ceiling.
 */
const MIN_TRACKING_INTERVAL_MIN = 5
const MAX_TRACKING_INTERVAL_MIN = 240
const MIN_TRACKING_DURATION_HOURS = 1
const MAX_TRACKING_DURATION_HOURS = 336

/** A carrier is only chased for paperwork once their load is off the truck. */
const DELIVERED_LOAD_STATUSES: readonly string[] = ['DELIVERED', 'INVOICING']
/** The e-mail vocabulary for a manual milestone send. */
const MILESTONES: readonly CustomerNotification[] = [
  'APPT_SCHEDULED',
  'LOADING',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'UNLOADING',
  'DELIVERED',
  'INVOICE_SENT',
]
const RECIPIENT_KINDS: readonly ('CUSTOMER' | 'CARRIER')[] = ['CUSTOMER', 'CARRIER']

/** Document e-mail bounds. SES refuses a message over 10 MB, so we refuse it first. */
const MAX_EMAIL_DOCUMENTS = 20
const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_SUBJECT = 200
/** Long enough for the operator who has to forward the files by hand. */
const DOWNLOAD_URL_TTL_SECONDS = 3600
/**
 * Where a shipment document's bytes may live: step E's own prefix, plus the two a
 * pointer row points at (a driver-app POD, a customer's own rate confirmation).
 * Anything else is not ours to read, and this Lambda is not granted it either.
 */
const EMAILABLE_KEY_PREFIXES: readonly string[] = [
  'shipment-docs/',
  'driver-docs/',
  'rate-confirms/',
]

// ── Types ────────────────────────────────────────────────────────────────────

type Action =
  | 'SEND_TRACKING_LINK'
  | 'REVOKE_TRACKING_LINK'
  | 'SEND_CUSTOMER_LINK'
  | 'REVOKE_CUSTOMER_LINK'
  | 'TEXT_DRIVER'
  | 'SAVE_TRACKING_SETTINGS'
  | 'SEND_UPLOAD_LINK'
  | 'REVOKE_UPLOAD_LINK'
  | 'SEND_MILESTONE_NOTICE'
  | 'EMAIL_DOCUMENTS'
  | 'SAVE_DOCUMENT_SETTINGS'

/**
 * What an audit row is about. `AuditLog.entityType` is an open string in the schema,
 * so the union lives with the router that writes it; step D adds TRACKING_LINK.
 */
type AuditEntityType = 'TRACKING_LINK' | 'LOAD_CARRIER' | 'SHIPMENT' | 'TMS_SETTINGS'

interface AppSyncIdentity {
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

interface Caller {
  email: string
  sub: string
  groups: string[]
  isAdmin: boolean
}

/** What actually happened to the text, as opposed to what was asked for. */
type SmsStatus = 'SENT' | 'COPY' | 'NOT_CONFIGURED' | 'FAILED'
/** Same, for the Customer Link e-mail. SES is denied on dev, so NOT_SENT is normal. */
type EmailStatus = 'SENT' | 'COPY' | 'NOT_SENT'

// ── Auth ─────────────────────────────────────────────────────────────────────

async function getCallerEmail(identity: AppSyncIdentity): Promise<string> {
  const claims = identity.claims ?? {}
  const candidates = [claims.email, identity.username, claims['cognito:username']]
  const found = candidates.find((v): v is string => typeof v === 'string' && v.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup) return ''
  try {
    const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[tms-tracking-actions] could not resolve caller email:', String(err))
    return ''
  }
}

function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

async function authorize(action: Action, identity?: AppSyncIdentity | null): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)

  // How long every link lives, who the customer page says to call, and what every
  // carrier is asked to upload is org-wide configuration, not a dispatcher's call on
  // one load.
  if (action === 'SAVE_TRACKING_SETTINGS' || action === 'SAVE_DOCUMENT_SETTINGS') {
    if (!isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  } else if (!isAdmin && !groups.includes(LOAD_PAGE_GROUP) && !groups.includes(TMS_PAGE_GROUP)) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, ${LOAD_PAGE_GROUP}, or ${TMS_PAGE_GROUP}`)
  }

  return { email, sub: identity.sub, groups, isAdmin }
}

// ── Input helpers ────────────────────────────────────────────────────────────

export function parseInput(input: string | Record<string, unknown> | null | undefined): Row {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    const parsed: unknown = JSON.parse(input)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Row
  }
  if (Array.isArray(input) || typeof input !== 'object') throw new Error('Invalid input: must be an object')
  return input
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  return trimmed
}

function optionalString(value: unknown, maxLen?: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (maxLen != null && trimmed.length > maxLen) throw new Error(`Field exceeds maximum length of ${maxLen}`)
  return trimmed
}

function assertInteger(value: unknown, label: string, min: number, max: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error(`${label} must be a whole number`)
  if (num < min || num > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return num
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

function assertEmail(value: unknown, label: string): string {
  const email = assertString(value, label).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${label} is not an email address`)
  return email
}

function assertEmailList(value: unknown, label: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of email addresses`)
  if (value.length > MAX_RECIPIENTS) throw new Error(`${label} is limited to ${MAX_RECIPIENTS} addresses`)
  return [...new Set(value.map((v, i) => assertEmail(v, `${label}[${i}]`)))]
}

/**
 * An address somebody else stored — a carrier's dispatcher, a customer's contact —
 * which nothing on the way in ever validated. A malformed one is not an error here:
 * it simply is not a recipient, and the caller says so in its own words.
 */
function emailOrNull(value: unknown): string | null {
  const raw = optionalString(value, 254)
  if (!raw) return null
  const email = raw.toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function assertOneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const raw = assertString(value, label)
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  }
  return raw as T
}

// ── Store helpers ────────────────────────────────────────────────────────────

const getById = (tableName: string, id: string) => storeGetById(dynamo, tableName, id)
const queryIndex = (tableName: string, indexName: string, keyName: string, keyValue: string) =>
  storeQueryIndex(dynamo, tableName, indexName, keyName, keyValue)
const transact = (items: TransactWriteItem[], label: string) => storeTransact(dynamo, items, label)

function getSettings(): Promise<Row | null> {
  if (!TMS_SETTINGS_TABLE_NAME) return Promise.resolve(null)
  return getById(TMS_SETTINGS_TABLE_NAME, SETTINGS_ID)
}

/**
 * The shipment behind a send, refused when it is voided.
 *
 * Void is the only way a shipment leaves the working set, and it deliberately
 * leaves `status` alone — so `UNTRACKABLE_SHIPMENT_STATUSES` never catches it and
 * a stale tab could otherwise e-mail a customer a link, a "picked up" notice or a
 * paperwork request for freight that no longer exists. Nothing goes out of this
 * router about a voided shipment.
 */
async function liveShipment(shipmentId: string): Promise<Row> {
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertLiveShipment(shipment, shipmentId)
  return shipment
}

function assertLiveShipment(shipment: Row, shipmentId: string): void {
  if (!isVoided(shipment)) return
  throw new Error(`Shipment ${optionalString(shipment.number, 60) ?? shipmentId} is voided`)
}

/** Division's primary key is `key`, not `id`, so it cannot go through `getById`. */
async function getDivision(key: string | null): Promise<Row | null> {
  if (!key || !DIVISION_TABLE_NAME) return null
  const result = await dynamo.send(new GetItemCommand({ TableName: DIVISION_TABLE_NAME, Key: marshall({ key }) }))
  return result.Item ? unmarshall(result.Item) : null
}

/**
 * A single-row update that hands the written row back, with no CAS guard.
 * Used for the follow-up stamps a successful send leaves behind, which are written
 * after the transaction that minted the link and can never conflict with it.
 */
async function patchRow(tableName: string, id: string, patch: Row): Promise<Row> {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ id }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  )
  return result.Attributes ? unmarshall(result.Attributes) : { id, ...patch }
}

/**
 * The Shipment patch for a Customer Link, guarded on `version` rather than
 * `updatedAt`: that is the handle the shipment page already holds, and the one it
 * passes back as `expectedVersion`.
 */
function shipmentVersionTx(id: string, patch: Row, expectedVersion: number): TransactWriteItem {
  const names: Record<string, string> = { '#casVersion': 'version' }
  const values: Record<string, AttributeValue> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  values[':casExpectedVersion'] = { N: String(expectedVersion) }
  values[':casZero'] = { N: '0' }
  return {
    Update: {
      TableName: SHIPMENT_TABLE_NAME,
      Key: marshall({ id }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression:
        '((attribute_exists(#casVersion) AND #casVersion = :casExpectedVersion) OR ' +
        '(attribute_not_exists(#casVersion) AND :casExpectedVersion = :casZero))',
    },
  }
}

/**
 * One audit row per write action. Best effort: a link that went out must not be
 * reported as failed because the history table rejected a row.
 */
async function writeAudit(
  entityType: AuditEntityType,
  entityId: string,
  action: Action,
  caller: Caller,
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
    console.warn('[tms-tracking-actions] audit log write failed:', String(err))
  }
}

// ── AppSync data client (Load writes only) ───────────────────────────────────

interface LoadMutationResult {
  data: Record<string, unknown> | null
  errors?: unknown
}

/** Narrow wrapper: this Lambda only flips `Load.trackingProvider`. */
interface DataClient {
  models: {
    Load: {
      update: (input: Record<string, unknown>) => Promise<LoadMutationResult>
    }
  }
}

let dataClient: DataClient | null = null

async function getDataClient(): Promise<DataClient> {
  if (dataClient) return dataClient
  const env = process.env as unknown as DataClientEnv
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env)
  Amplify.configure(resourceConfig, libraryOptions)
  // The library's full client type is implementation-internal; this module only
  // uses Load.update.
  dataClient = generateClient() as unknown as DataClient
  return dataClient
}

/**
 * Flip `Load.trackingProvider` through the generated mutation so the board's
 * subscriptions fire.
 *
 * Run after the transaction that minted or revoked the link, and never fatal: the
 * TrackingLink row is what tracking actually runs on, and failing the whole action
 * after it was written would tell the operator nothing happened when something did.
 */
async function setTrackingProvider(loadId: string, provider: 'LINK' | 'MANUAL'): Promise<void> {
  try {
    const client = await getDataClient()
    const result = await client.models.Load.update({ id: loadId, trackingProvider: provider })
    const rawErrors = result.errors
    const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : []
    if (result.data == null || errors.length > 0) {
      console.error('[tms-tracking-actions] trackingProvider update refused', { loadId, provider, errors })
    }
  } catch (err) {
    console.error('[tms-tracking-actions] trackingProvider update failed', { loadId, provider, err: String(err) })
  }
}

// ── Links ────────────────────────────────────────────────────────────────────

/** The expiry knobs `linkExpiry` reads, pulled off the settings row it does not know. */
function linkSettings(settings: Row | null): { trackingLinkExpiryHours: number | null; customerLinkExpiryDays: number | null } {
  return {
    trackingLinkExpiryHours: numberOrNull(settings?.trackingLinkExpiryHours),
    customerLinkExpiryDays: numberOrNull(settings?.customerLinkExpiryDays),
  }
}

function publicUrl(path: 'l' | 's' | 'u', token: string): string {
  const origin = PORTAL_ORIGIN.replace(/\/+$/, '')
  return origin ? `${origin}/track/${path}/${token}` : `/track/${path}/${token}`
}

/** The last delivery appointment on a load — what a ping link's clock hangs off. */
function lastDeliveryAppt(load: Row): string | null {
  const appts = readStops(load)
    .filter((s) => s.type === 'delivery' && typeof s.appt === 'string' && s.appt)
    .map((s) => String(s.appt))
    .sort()
  return appts.length > 0 ? appts[appts.length - 1] : null
}

/**
 * TrackingLink's two indexes are keyed on `shipmentId` and `loadId`. A Customer Link
 * has no load, and DynamoDB refuses a NULL in an index key, so the attribute is left
 * off entirely rather than written as null — which is also what keeps
 * `trackingLinksByLoadId` sparse.
 */
function trackingLinkRow(row: Row): Row {
  const out: Row = { ...row }
  if (out.loadId == null) delete out.loadId
  return out
}

async function activeLinksForLoad(loadId: string, loadCarrierId: string): Promise<Row[]> {
  const rows = await queryIndex(TRACKING_LINK_TABLE_NAME, IDX_TRACKING_LINKS_BY_LOAD, 'loadId', loadId)
  return rows.filter(
    (r) => r.kind === 'CARRIER_PING' && r.status === 'ACTIVE' && r.loadCarrierId === loadCarrierId,
  )
}

async function activeCustomerLink(shipmentId: string): Promise<Row | null> {
  const rows = await queryIndex(TRACKING_LINK_TABLE_NAME, IDX_TRACKING_LINKS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const active = rows
    .filter((r) => r.kind === 'CUSTOMER_VIEW' && r.status === 'ACTIVE')
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  return active[0] ?? null
}

function revokeTx(linkId: string, caller: Caller, now: string): TransactWriteItem {
  return updateItemTx(TRACKING_LINK_TABLE_NAME, linkId, {
    status: 'REVOKED' satisfies TrackingLinkStatus,
    revokedAt: now,
    revokedBy: caller.email,
    updatedAt: now,
  }, null)
}

// ── Texting ──────────────────────────────────────────────────────────────────

/**
 * The dispatch send rig, or null when Twilio was never connected.
 *
 * No attachment ever rides a tracking text, so the media hooks refuse rather than
 * pretending — the same shape `ratecon-assigned-text` uses.
 */
async function dispatchDeps(): Promise<SendDeps | null> {
  const config = await loadDispatchConfig()
  if (!config) return null
  return {
    store: new DispatchStore(dynamo, tablesFromEnv()),
    config,
    send: (cfg: DispatchConfig, i: { to: string; body?: string; mediaUrls?: string[] }) =>
      sendMessage(cfg, {
        to: i.to,
        from: cfg.dispatchNumber,
        body: i.body,
        mediaUrls: i.mediaUrls,
        statusCallback: WEBHOOK_URL
          ? `${WEBHOOK_URL}/status?t=${encodeURIComponent(cfg.webhookSecret)}`
          : undefined,
      }),
    presignGet: () => Promise.reject(new Error('A tracking text carries no attachments')),
    headObject: () => Promise.resolve(null),
    now: () => new Date(),
  }
}

/** The thread for a number, reopened if archived, created and labelled if new. */
async function conversationFor(
  store: DispatchStore,
  phone: string,
  label: { carrierName: string | null; driverName: string | null; driverId: string | null },
) {
  const existing = await store.findConversationByPhone(phone)
  if (existing) {
    return existing.status === 'ARCHIVED'
      ? store.updateConversation(existing.id, { set: { status: 'OPEN' } })
      : existing
  }
  const displayName = [label.carrierName, label.driverName].filter(Boolean).join(' · ') || null
  return store.createConversation({
    phone,
    driverId: label.driverId,
    driverName: label.driverName,
    displayName,
  })
}

interface TextOutcome {
  status: SmsStatus
  messageId: string | null
  error: string | null
}

/**
 * Send one text into the driver's dispatch thread, and say truthfully what happened.
 *
 * Never throws: both callers have already written the row that matters (the link, or
 * the check call the note belongs to), and a refused text must not undo it.
 */
async function textInto(
  phone: string,
  body: string,
  sentBy: string,
  label: { carrierName: string | null; driverName: string | null; driverId: string | null },
  signedAs?: string | null,
): Promise<TextOutcome> {
  const deps = await dispatchDeps()
  if (!deps) {
    console.warn('[tms-tracking-actions] dispatch is not connected to Twilio; nothing texted')
    return { status: 'NOT_CONFIGURED', messageId: null, error: null }
  }
  try {
    const conversation = await conversationFor(deps.store, phone, label)
    const sent = await sendDispatchText(deps, { conversation, body, mediaKeys: [], sentBy, via: 'app', signedAs })
    return { status: 'SENT', messageId: sent.message.id, error: null }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    console.error('[tms-tracking-actions] text failed', { phone, err: why })
    return { status: 'FAILED', messageId: null, error: why }
  }
}

// ── SEND_TRACKING_LINK ───────────────────────────────────────────────────────

async function sendTrackingLink(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const via = assertOneOf<Exclude<TrackingLinkChannel, 'EMAIL'>>(input.via, 'via', ['SMS', 'COPY'])
  const message = optionalString(input.message, MAX_MESSAGE)

  const loadCarrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!loadCarrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (loadCarrier.status !== 'ACTIVE') {
    throw new Error('Only the carrier currently on the load can be sent a tracking link')
  }
  if (loadCarrier.kind === 'OWN_ASSET') {
    throw new Error('Own trucks track through Motive and the driver app — a ping link is for outside carriers')
  }

  const loadId = String(loadCarrier.loadId)
  const shipmentId = String(loadCarrier.shipmentId)
  const [load] = await Promise.all([getById(LOAD_TABLE_NAME, loadId), liveShipment(shipmentId)])
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const loadStatus = String(load.status ?? '')
  if (CLOSED_LOAD_STATUSES.includes(loadStatus)) {
    throw new Error(`This load is ${loadStatus.toLowerCase()}; there is nothing left to track`)
  }

  // COPY exists for the dispatcher who will paste the link into their own thread, so
  // it needs no number. A text does.
  const phone = toE164Strict(optionalString(input.to, 40) ?? optionalString(loadCarrier.driverPhone, 40))
  if (via === 'SMS' && !phone) {
    throw new Error('No phone number to text — add the driver\'s number to the assignment, or copy the link instead')
  }

  const settings = await getSettings()
  const now = nowIso()
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = linkExpiry('CARRIER_PING', lastDeliveryAppt(load), linkSettings(settings), now)
  const url = publicUrl('l', token)

  // One live ping link per assignment: a second one would leave the first working.
  const previous = await activeLinksForLoad(loadId, loadCarrierId)

  const link: Row = trackingLinkRow({
    id: token,
    __typename: 'TrackingLink',
    kind: 'CARRIER_PING',
    shipmentId,
    loadId,
    loadCarrierId,
    status: 'ACTIVE' satisfies TrackingLinkStatus,
    expiresAt,
    sentTo: phone,
    sentVia: via,
    // A copied link is in the dispatcher's hands the moment it exists; a text is not
    // sent until Twilio says so.
    sentAt: via === 'COPY' ? now : null,
    openCount: 0,
    requestCount: 0,
    pingCount: 0,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  })

  const checkCallId = randomUUID()
  await transact(
    [
      ...previous.map((p) => revokeTx(String(p.id), caller, now)),
      putItem(TRACKING_LINK_TABLE_NAME, link),
      updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, {
        trackingLinkId: token,
        trackingStartedAt: now,
        trackingStoppedAt: null,
        updatedBy: caller.email,
        updatedAt: now,
      }, null),
      putItem(LOAD_CHECK_CALL_TABLE_NAME, {
        id: checkCallId,
        __typename: 'LoadCheckCall',
        loadId,
        shipmentId,
        loadCarrierId,
        at: now,
        type: 'TRACKING_LINK_SENT',
        source: 'SYSTEM',
        // Nothing has been texted yet; the note says only that the link exists, and
        // the send below rewrites it with what actually happened.
        note: via === 'COPY'
          ? 'Tracking link created to copy'
          : `Tracking link created for ${phone}`,
        createdBy: caller.email,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    'tracking link',
  )

  await setTrackingProvider(loadId, 'LINK')

  let sms: TextOutcome = { status: 'COPY', messageId: null, error: null }
  if (via === 'SMS' && phone) {
    const division = await getDivision(optionalString(load.divisionKey, 60))
    const body = smsBodyFor(
      smsTemplate(message, settings),
      {
        broker: optionalString(division?.name, 120) ?? BROKER_FALLBACK,
        loadNumber: optionalString(load.loadNumber, 60) ?? loadId,
        url,
      },
    )
    sms = await textInto(phone, body, caller.email, {
      carrierName: optionalString(loadCarrier.carrierName, 200),
      driverName: optionalString(loadCarrier.driverName, 200),
      driverId: optionalString(loadCarrier.driverId, 100),
    }, null)
    if (sms.status === 'SENT') {
      Object.assign(link, await patchRow(TRACKING_LINK_TABLE_NAME, token, {
        sentAt: now,
        smsMessageId: sms.messageId,
        updatedAt: nowIso(),
      }))
    }
    await patchRow(LOAD_CHECK_CALL_TABLE_NAME, checkCallId, {
      note: trackingLinkNote(phone, sms),
      ...(sms.messageId ? { driverMessageId: sms.messageId } : {}),
      updatedAt: nowIso(),
    })
  }

  await writeAudit('TRACKING_LINK', token, 'SEND_TRACKING_LINK', caller, {
    loadId, loadCarrierId, via, to: phone, expiresAt, smsStatus: sms.status,
    revoked: previous.map((p) => String(p.id)),
  })

  return { link, url, smsStatus: sms.status, smsError: sms.error, messageId: sms.messageId }
}

/**
 * The body to fill in: the dispatcher's own words when they typed some, otherwise the
 * org template. A hand-written note that forgot the link still gets one — the URL is
 * the only part of this text that has to be there.
 */
function smsTemplate(message: string | null, settings: Row | null): string {
  if (message) return message.includes('{url}') ? message : `${message} {url}`
  const configured = optionalString(settings?.trackingSmsTemplate, MAX_SMS_BODY)
  return configured && configured.includes('{url}') ? configured : ''
}

/**
 * What the timeline and the audit trail are told about the text, written only once
 * the attempt is over. A link whose text never left says so, and says why — the
 * dispatcher reading the Tracking tab a week later has to know whether to call.
 */
function trackingLinkNote(phone: string, sms: TextOutcome): string {
  if (sms.status === 'SENT') return `Tracking link texted to ${phone}`
  if (sms.status === 'NOT_CONFIGURED') {
    return `Tracking link created for ${phone} — not texted: dispatch texting is not connected`
  }
  const why = (sms.error ?? '').trim().slice(0, MAX_NOTE_REASON) || 'the text was refused'
  return `Tracking link created for ${phone} — not texted: ${why}`
}

// ── REVOKE_TRACKING_LINK ─────────────────────────────────────────────────────

async function revokeTrackingLink(input: Row, caller: Caller): Promise<Row> {
  const trackingLinkId = assertString(input.trackingLinkId, 'trackingLinkId')
  const link = await getById(TRACKING_LINK_TABLE_NAME, trackingLinkId)
  if (!link) throw new Error('That tracking link no longer exists')
  if (link.kind !== 'CARRIER_PING') throw new Error('That is a customer link; revoke it with REVOKE_CUSTOMER_LINK')
  if (link.status !== 'ACTIVE') return { link }

  const now = nowIso()
  const loadCarrierId = optionalString(link.loadCarrierId, 100)
  const loadCarrier = loadCarrierId ? await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId) : null

  await transact(
    [
      revokeTx(trackingLinkId, caller, now),
      ...(loadCarrier
        ? [updateItemTx(LOAD_CARRIER_TABLE_NAME, String(loadCarrier.id), {
            // Only clear the pointer when it still points here; a newer link owns it otherwise.
            trackingLinkId: loadCarrier.trackingLinkId === trackingLinkId ? null : loadCarrier.trackingLinkId,
            trackingStoppedAt: now,
            updatedBy: caller.email,
            updatedAt: now,
          }, null)]
        : []),
    ],
    'tracking link',
  )

  // Tracking falls back to the phone, not to nothing — but only if the link was what
  // was tracking it.
  const loadId = optionalString(link.loadId, 100)
  if (loadId) {
    const load = await getById(LOAD_TABLE_NAME, loadId)
    if (load?.trackingProvider === 'LINK') await setTrackingProvider(loadId, 'MANUAL')
  }

  await writeAudit('TRACKING_LINK', trackingLinkId, 'REVOKE_TRACKING_LINK', caller, { loadId, loadCarrierId })
  return { link: { ...link, status: 'REVOKED', revokedAt: now, revokedBy: caller.email, updatedAt: now } }
}

// ── SEND_CUSTOMER_LINK ───────────────────────────────────────────────────────

/**
 * Who the customer page says to call, frozen onto the link.
 *
 * Snapshotted rather than looked up at view time so that moving a rep, or changing
 * the setting, never silently rewrites what a customer was already told.
 */
async function trackingContactFor(settings: Row | null, orders: Row[]): Promise<TrackingContact> {
  const configured = (settings?.trackingContact ?? null) as TrackingContact | null
  const mode = configured?.mode === 'FIXED' ? 'FIXED' : 'CUSTOMER_REP'
  if (mode === 'FIXED') {
    return {
      mode,
      name: optionalString(configured?.name, 200),
      email: optionalString(configured?.email, 200),
      phone: optionalString(configured?.phone, 40),
    }
  }

  const repId = orders.map((o) => optionalString(o.customerRepId, 100)).find(Boolean) ?? null
  if (!repId) return { mode, name: null, email: null, phone: null }
  try {
    const rep = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: repId }))
    const attr = (name: string) => rep.UserAttributes?.find((a) => a.Name === name)?.Value ?? null
    const given = [attr('given_name'), attr('family_name')].filter(Boolean).join(' ').trim()
    return {
      mode,
      name: optionalString(attr('name') ?? given, 200),
      email: optionalString(attr('email'), 200),
      phone: optionalString(attr('phone_number'), 40),
    }
  } catch (err) {
    // A rep who has left is not a reason to refuse the link; the page just shows no name.
    console.warn('[tms-tracking-actions] could not resolve the customer rep:', String(err))
    return { mode, name: null, email: null, phone: null }
  }
}

/** Split a base64 blob into 76-char MIME lines (RFC 2045). */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

/**
 * The Customer Link e-mail. Raw MIME, the same way the pay statements and rate
 * confirmations go out; base64 so a note with an em dash in it survives the wire.
 */
async function sendCustomerEmail(args: { to: string[]; cc: string[]; subject: string; body: string }): Promise<void> {
  const raw =
    `From: ${FROM_ADDRESS}\r\n` +
    `To: ${args.to.join(', ')}\r\n` +
    (args.cc.length > 0 ? `Cc: ${args.cc.join(', ')}\r\n` : '') +
    `Subject: ${args.subject.replace(/[\r\n]+/g, ' ').trim()}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    `${wrap76(Buffer.from(args.body, 'utf8').toString('base64'))}\r\n`

  await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM_ADDRESS,
    Destination: { ToAddresses: args.to, CcAddresses: args.cc.length > 0 ? args.cc : undefined },
    Content: { Raw: { Data: new TextEncoder().encode(raw) } },
  }))
}

async function sendCustomerLink(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedVersion = assertInteger(input.expectedVersion, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER)
  const via = assertOneOf<Exclude<TrackingLinkChannel, 'SMS'>>(input.via, 'via', ['EMAIL', 'COPY'])
  const to = assertEmailList(input.to, 'to')
  const cc = assertEmailList(input.cc, 'cc')
  const message = optionalString(input.message, MAX_MESSAGE)
  const regenerate = input.regenerate === true
  if (via === 'EMAIL' && to.length === 0) throw new Error('A customer link needs at least one recipient')

  const shipment = await liveShipment(shipmentId)
  const status = String(shipment.status ?? '')
  if (UNTRACKABLE_SHIPMENT_STATUSES.includes(status)) {
    throw new Error(
      status === 'DRAFT'
        ? 'Submit the order before sending the customer a tracking link'
        : 'That shipment is canceled; there is nothing to track',
    )
  }
  const version = numberOrNull(shipment.version) ?? 0
  if (version !== expectedVersion) {
    throw conflictError('shipment', new Error(`version ${expectedVersion} is stale; the shipment is at ${version}`))
  }

  const [settings, orders] = await Promise.all([
    getSettings(),
    queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId),
  ])
  const contact = await trackingContactFor(settings, orders)
  const showCarrier = settings?.customerLinkShowsCarrier === true
  const showPosition = settings?.customerLinkShowsPosition !== false

  const now = nowIso()
  const existing = await activeCustomerLink(shipmentId)
  const reuse = existing != null && !regenerate
  const token = reuse ? String(existing!.id) : randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = linkExpiry('CUSTOMER_VIEW', null, linkSettings(settings), now)
  const url = publicUrl('s', token)

  // Re-sending refreshes the clock and the snapshot on the token the customer already
  // has; `regenerate` is the only thing that invalidates a link already in their inbox.
  const patch: Row = {
    expiresAt,
    sentTo: to.join(', ') || null,
    sentVia: via,
    contactName: contact.name ?? null,
    contactEmail: contact.email ?? null,
    contactPhone: contact.phone ?? null,
    showCarrier,
    showPosition,
    updatedAt: now,
  }

  await transact(
    [
      ...(existing && !reuse ? [revokeTx(String(existing.id), caller, now)] : []),
      reuse
        ? updateItemTx(TRACKING_LINK_TABLE_NAME, token, patch, null)
        : putItem(TRACKING_LINK_TABLE_NAME, trackingLinkRow({
            id: token,
            __typename: 'TrackingLink',
            kind: 'CUSTOMER_VIEW',
            shipmentId,
            status: 'ACTIVE' satisfies TrackingLinkStatus,
            openCount: 0,
            requestCount: 0,
            pingCount: 0,
            // Stamped only once something actually left, below.
            sentAt: null,
            createdBy: caller.email,
            createdAt: now,
            ...patch,
          })),
      shipmentVersionTx(shipmentId, {
        customerLinkId: token,
        version: version + 1,
        updatedBy: caller.email,
        updatedAt: now,
      }, expectedVersion),
    ],
    'customer link',
  )

  let emailStatus: EmailStatus = 'COPY'
  let emailError: string | null = null
  if (via === 'EMAIL') {
    const number = optionalString(shipment.number, 60) ?? shipmentId
    const body =
      (message ? `${message}\n\n` : '') +
      `Track shipment ${number} here:\n${url}\n\n` +
      `This link works until ${expiresAt}.\n\n— ${contact.name?.trim() || BROKER_FALLBACK}`
    try {
      await sendCustomerEmail({ to, cc, subject: `Tracking for shipment ${number}`, body })
      emailStatus = 'SENT'
    } catch (err) {
      // SES is denied on dev. The link is real and the URL is in the response, so this
      // is reported, not thrown.
      emailError = err instanceof Error ? err.message : String(err)
      console.error('[tms-tracking-actions] customer link email failed', emailError)
      emailStatus = 'NOT_SENT'
    }
  }

  // Only a link that actually reached somebody is stamped as sent.
  const sentAt = emailStatus === 'NOT_SENT' ? null : now
  if (sentAt) {
    await patchRow(TRACKING_LINK_TABLE_NAME, token, { sentAt, updatedAt: nowIso() })
    await patchRow(SHIPMENT_TABLE_NAME, shipmentId, { customerLinkSentAt: sentAt, updatedAt: nowIso() })
  }

  const link = await getById(TRACKING_LINK_TABLE_NAME, token)
  const saved = await getById(SHIPMENT_TABLE_NAME, shipmentId)

  await writeAudit('TRACKING_LINK', token, 'SEND_CUSTOMER_LINK', caller, {
    shipmentId, via, to, cc, regenerate, reused: reuse, expiresAt, emailStatus,
  })

  return { link, url, emailStatus, emailError, shipment: saved }
}

// ── REVOKE_CUSTOMER_LINK ─────────────────────────────────────────────────────

async function revokeCustomerLink(input: Row, caller: Caller): Promise<Row> {
  const trackingLinkId = assertString(input.trackingLinkId, 'trackingLinkId')
  const link = await getById(TRACKING_LINK_TABLE_NAME, trackingLinkId)
  if (!link) throw new Error('That tracking link no longer exists')
  if (link.kind !== 'CUSTOMER_VIEW') throw new Error('That is a carrier link; revoke it with REVOKE_TRACKING_LINK')
  if (link.status !== 'ACTIVE') return { link }

  const now = nowIso()
  const shipmentId = String(link.shipmentId)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)

  await transact(
    [
      revokeTx(trackingLinkId, caller, now),
      ...(shipment?.customerLinkId === trackingLinkId
        ? [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
            customerLinkId: null,
            customerLinkSentAt: null,
            updatedBy: caller.email,
            updatedAt: now,
          }, null)]
        : []),
    ],
    'customer link',
  )

  await writeAudit('TRACKING_LINK', trackingLinkId, 'REVOKE_CUSTOMER_LINK', caller, { shipmentId })
  return { link: { ...link, status: 'REVOKED', revokedAt: now, revokedBy: caller.email, updatedAt: now } }
}

// ── TEXT_DRIVER ──────────────────────────────────────────────────────────────

/**
 * "Send these notes to the driver", from the check-call dialog.
 *
 * The check call is already written by the time this runs, so nothing here throws for
 * a send that did not work: the outcome is reported and the dialog says so.
 */
async function textDriver(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const body = assertString(input.body, 'body')
  if (body.length > MAX_SMS_BODY) throw new Error(`Texts are limited to ${MAX_SMS_BODY} characters`)

  const loadCarrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!loadCarrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  await liveShipment(String(loadCarrier.shipmentId))

  const phone = toE164Strict(optionalString(loadCarrier.driverPhone, 40))
  if (!phone) {
    return {
      messageId: null,
      smsStatus: 'FAILED' satisfies SmsStatus,
      smsError: 'No driver phone number on this assignment',
    }
  }

  const sms = await textInto(phone, body, caller.email, {
    carrierName: optionalString(loadCarrier.carrierName, 200),
    driverName: optionalString(loadCarrier.driverName, 200),
    driverId: optionalString(loadCarrier.driverId, 100),
  })

  if (sms.status === 'SENT') {
    await writeAudit('LOAD_CARRIER', loadCarrierId, 'TEXT_DRIVER', caller, {
      loadId: String(loadCarrier.loadId), to: phone, messageId: sms.messageId,
    })
  }
  return { messageId: sms.messageId, smsStatus: sms.status, smsError: sms.error }
}

// ── SAVE_TRACKING_SETTINGS ───────────────────────────────────────────────────

/** Only the keys step D owns; everything else on the row is another router's. */
function trackingSettingsPatch(input: Row): Row {
  const patch: Row = {}
  if ('checkCallDefaultIntervalHours' in input) {
    patch.checkCallDefaultIntervalHours = input.checkCallDefaultIntervalHours == null
      ? null
      : assertInteger(input.checkCallDefaultIntervalHours, 'checkCallDefaultIntervalHours', MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS)
  }
  if ('checkCallGraceMinutes' in input) {
    patch.checkCallGraceMinutes = input.checkCallGraceMinutes == null
      ? null
      : assertInteger(input.checkCallGraceMinutes, 'checkCallGraceMinutes', MIN_GRACE_MINUTES, MAX_GRACE_MINUTES)
  }
  if ('checkCallNotifyChannel' in input) {
    patch.checkCallNotifyChannel = input.checkCallNotifyChannel == null
      ? null
      : assertOneOf(input.checkCallNotifyChannel, 'checkCallNotifyChannel', NOTIFY_CHANNELS)
  }
  if ('checkCallSlackChannelId' in input) {
    patch.checkCallSlackChannelId = optionalString(input.checkCallSlackChannelId, 60)
  }
  if ('trackingLinkExpiryHours' in input) {
    patch.trackingLinkExpiryHours = input.trackingLinkExpiryHours == null
      ? null
      : assertInteger(input.trackingLinkExpiryHours, 'trackingLinkExpiryHours', MIN_LINK_EXPIRY_HOURS, MAX_LINK_EXPIRY_HOURS)
  }
  if ('customerLinkExpiryDays' in input) {
    patch.customerLinkExpiryDays = input.customerLinkExpiryDays == null
      ? null
      : assertInteger(input.customerLinkExpiryDays, 'customerLinkExpiryDays', MIN_CUSTOMER_LINK_DAYS, MAX_CUSTOMER_LINK_DAYS)
  }
  if ('customerLinkShowsCarrier' in input) {
    patch.customerLinkShowsCarrier = assertBoolean(input.customerLinkShowsCarrier, 'customerLinkShowsCarrier')
  }
  if ('customerLinkShowsPosition' in input) {
    patch.customerLinkShowsPosition = assertBoolean(input.customerLinkShowsPosition, 'customerLinkShowsPosition')
  }
  // Step J's org-level tracking defaults: stored here, read by a tracking provider once
  // one is live. Nothing in the app consumes them yet, and the settings card says so.
  if ('trackByDefault' in input) {
    patch.trackByDefault = assertBoolean(input.trackByDefault, 'trackByDefault')
  }
  if ('autoStatusFromGeofence' in input) {
    patch.autoStatusFromGeofence = assertBoolean(input.autoStatusFromGeofence, 'autoStatusFromGeofence')
  }
  if ('trackingIntervalMin' in input) {
    patch.trackingIntervalMin = input.trackingIntervalMin == null
      ? null
      : assertInteger(input.trackingIntervalMin, 'trackingIntervalMin', MIN_TRACKING_INTERVAL_MIN, MAX_TRACKING_INTERVAL_MIN)
  }
  if ('trackingDurationHours' in input) {
    patch.trackingDurationHours = input.trackingDurationHours == null
      ? null
      : assertInteger(input.trackingDurationHours, 'trackingDurationHours', MIN_TRACKING_DURATION_HOURS, MAX_TRACKING_DURATION_HOURS)
  }
  if ('trackingSmsTemplate' in input) {
    const template = optionalString(input.trackingSmsTemplate, MAX_SMS_BODY)
    // A template without the link is a text that wastes the driver's time.
    if (template && !template.includes('{url}')) {
      throw new Error('trackingSmsTemplate must contain {url}')
    }
    patch.trackingSmsTemplate = template
  }
  if ('trackingContact' in input) {
    const raw = input.trackingContact
    if (raw == null) {
      patch.trackingContact = null
    } else {
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('trackingContact must be an object')
      const contact = raw as Row
      patch.trackingContact = {
        mode: assertOneOf(contact.mode, 'trackingContact.mode', CONTACT_MODES),
        name: optionalString(contact.name, 200),
        email: contact.email == null ? null : assertEmail(contact.email, 'trackingContact.email'),
        phone: optionalString(contact.phone, 40),
      } satisfies TrackingContact
    }
  }
  return patch
}

/**
 * The one writer for the settings singleton. Both save actions build their own patch
 * of the keys they own and share the create-or-CAS-update below, so a key added in a
 * later step never gets a second, subtly different write path.
 */
async function saveSettings(input: Row, caller: Caller, action: Action, patch: Row): Promise<Row> {
  const id = optionalString(input.id, 40) ?? SETTINGS_ID
  if (id !== SETTINGS_ID) throw new Error(`Settings id must be '${SETTINGS_ID}'`)
  if (Object.keys(patch).length === 0) throw new Error('Nothing to save')

  const expectedUpdatedAt = optionalString(input.expectedUpdatedAt, 40)
  const existing = await getById(TMS_SETTINGS_TABLE_NAME, SETTINGS_ID)
  const now = nowIso()

  if (!existing) {
    await transact(
      [putItem(TMS_SETTINGS_TABLE_NAME, {
        id: SETTINGS_ID,
        __typename: 'TmsSettings',
        ...patch,
        createdAt: now,
        updatedAt: now,
      })],
      'settings',
    )
  } else {
    const names: Record<string, string> = {}
    const values: Record<string, AttributeValue> = {}
    const sets: string[] = []
    for (const [key, value] of Object.entries({ ...patch, updatedAt: now })) {
      names[`#${key}`] = key
      values[`:${key}`] = marshallRow({ [key]: value })[key]
      sets.push(`#${key} = :${key}`)
    }
    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: TMS_SETTINGS_TABLE_NAME,
        Key: marshall({ id: SETTINGS_ID }),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(expectedUpdatedAt == null ? {} : { ConditionExpression: casCondition(values, expectedUpdatedAt) }),
      }))
    } catch (err) {
      if (isConflict(err)) throw conflictError('settings', err)
      throw err
    }
  }

  const saved = (await getById(TMS_SETTINGS_TABLE_NAME, SETTINGS_ID)) ?? { id: SETTINGS_ID, ...patch }
  await writeAudit('TMS_SETTINGS', SETTINGS_ID, action, caller, {
    created: !existing, keys: Object.keys(patch),
  })
  return saved
}

// ── SAVE_DOCUMENT_SETTINGS ───────────────────────────────────────────────────

/** Only the keys step E owns; everything else on the row is another router's. */
function documentSettingsPatch(input: Row): Row {
  const patch: Row = {}
  if ('milestoneNoticesEnabled' in input) {
    patch.milestoneNoticesEnabled = assertBoolean(input.milestoneNoticesEnabled, 'milestoneNoticesEnabled')
  }
  if ('podRequestEnabled' in input) {
    patch.podRequestEnabled = assertBoolean(input.podRequestEnabled, 'podRequestEnabled')
  }
  if ('requiredCarrierUploadTypes' in input) {
    const raw = input.requiredCarrierUploadTypes
    if (raw == null) {
      patch.requiredCarrierUploadTypes = null
    } else {
      if (!Array.isArray(raw)) throw new Error('requiredCarrierUploadTypes must be a list of document types')
      const { types, unrecognised } = normalizeRequiredDocTypes(raw as string[])
      // A string nobody can map to a type cannot gate anything and cannot be asked
      // for on the portal, so it is refused here rather than stored as a requirement
      // no upload will ever satisfy.
      if (unrecognised.length > 0) {
        throw new Error(`requiredCarrierUploadTypes does not recognise: ${unrecognised.join(', ')}`)
      }
      patch.requiredCarrierUploadTypes = types
    }
  }
  if ('uploadLinkExpiryDays' in input) {
    patch.uploadLinkExpiryDays = input.uploadLinkExpiryDays == null
      ? null
      : assertInteger(
          input.uploadLinkExpiryDays,
          'uploadLinkExpiryDays',
          MIN_UPLOAD_LINK_EXPIRY_DAYS,
          MAX_UPLOAD_LINK_EXPIRY_DAYS,
        )
  }
  for (const key of ['milestoneEmailTemplate', 'podRequestEmailTemplate'] as const) {
    if (!(key in input)) continue
    const template = optionalString(input[key], MAX_NOTICE_BODY_CHARS)
    // A template that cannot carry the link is an e-mail nobody can act on.
    if (template && !templateHasUrl(template)) throw new Error(`${key} must contain {url}`)
    patch[key] = template
  }
  if ('bolTerms' in input) patch.bolTerms = optionalString(input.bolTerms, MAX_NOTICE_BODY_CHARS)
  if ('documentDeleteAdminOnly' in input) {
    patch.documentDeleteAdminOnly = assertBoolean(input.documentDeleteAdminOnly, 'documentDeleteAdminOnly')
  }
  return patch
}

// ── Shipment reading (step E) ────────────────────────────────────────────────

/** A stop as the notice templates want it; `address` carries the state, `stops` not. */
function noticeStop(stop: StopShape): NoticeStop {
  const address = (stop.address ?? null) as Row | null
  return {
    type: String(stop.type ?? ''),
    name: optionalString(stop.name, 200),
    city: optionalString(stop.city ?? address?.city, 120),
    state: optionalString(address?.state, 40),
    appt: optionalString(stop.appt, 60),
    arrivedAt: optionalString(stop.arrivedAt, 60),
    departedAt: optionalString(stop.departedAt, 60),
  }
}

/** Every stop of the shipment, in load order — what the customer's e-mail describes. */
async function shipmentLoads(shipmentId: string): Promise<Row[]> {
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  return loads.sort((a, b) => String(a.loadNumber ?? a.id).localeCompare(String(b.loadNumber ?? b.id)))
}

/** Whose name signs the e-mail: the division running the freight, or the house name. */
async function brokerNameFor(loads: Row[]): Promise<string> {
  const key = loads.map((load) => optionalString(load.divisionKey, 60)).find(Boolean) ?? null
  const division = await getDivision(key)
  return optionalString(division?.name, 120) ?? BROKER_FALLBACK
}

/** The carrier on the road, asked for only when the customer link already names one. */
async function activeCarrierName(shipmentId: string): Promise<string | null> {
  const rows = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const active = rows.find((row) => row.status === 'ACTIVE' && row.kind !== 'OWN_ASSET')
  return optionalString(active?.carrierName, 200)
}

/** Customer-visible references only; a milestone e-mail never carries an internal one. */
function customerReferences(orders: Row[]): { code: string; label: string | null; value: string }[] {
  const out: { code: string; label: string | null; value: string }[] = []
  for (const order of orders) {
    const refs = Array.isArray(order.references) ? (order.references as Row[]) : []
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue
      if (ref.visibility !== 'CUSTOMER' && ref.visibility !== 'ALL') continue
      const code = optionalString(ref.code, 60)
      const value = optionalString(ref.value, 200)
      if (!code || !value) continue
      out.push({ code, label: optionalString(ref.label, 120), value })
    }
  }
  return out
}

// ── SEND_UPLOAD_LINK ─────────────────────────────────────────────────────────

/** The live upload link for one assignment, or null when the carrier has none. */
async function activeUploadLink(loadId: string, loadCarrierId: string): Promise<Row | null> {
  const rows = await queryIndex(TRACKING_LINK_TABLE_NAME, IDX_TRACKING_LINKS_BY_LOAD, 'loadId', loadId)
  const active = rows
    .filter((r) => r.kind === 'CARRIER_UPLOAD' && r.status === 'ACTIVE' && r.loadCarrierId === loadCarrierId)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  return active[0] ?? null
}

/**
 * What every carrier is asked to upload, snapshotted onto the link so that changing
 * the setting next month does not rewrite what this carrier was already asked for.
 */
function requiredUploadTypes(settings: Row | null): ShipmentDocumentType[] {
  const raw = settings?.requiredCarrierUploadTypes
  if (!Array.isArray(raw)) return [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES]
  return normalizeRequiredDocTypes(raw as string[]).types
}

async function sendUploadLink(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const via = assertOneOf<Exclude<TrackingLinkChannel, 'SMS'>>(input.via, 'via', ['EMAIL', 'COPY'])
  const explicitTo = assertEmailList(input.to, 'to')
  const message = optionalString(input.message, MAX_MESSAGE)
  const early = input.early === true
  const regenerate = input.regenerate === true

  const loadCarrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!loadCarrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (loadCarrier.kind === 'OWN_ASSET') {
    throw new Error('Own drivers send PODs through the driver app')
  }
  if (loadCarrier.status !== 'ACTIVE') {
    throw new Error('Only the carrier currently on the load can be asked for paperwork')
  }

  const loadId = String(loadCarrier.loadId)
  const shipmentId = String(loadCarrier.shipmentId)
  const [load, shipment, settings] = await Promise.all([
    getById(LOAD_TABLE_NAME, loadId),
    getById(SHIPMENT_TABLE_NAME, shipmentId),
    getSettings(),
  ])
  if (!load) throw new Error(`Load not found: ${loadId}`)
  if (shipment) assertLiveShipment(shipment, shipmentId)
  // Asking for a POD before the freight is off the truck wastes everybody's time —
  // but a carrier who already has the signed paperwork can be asked early on purpose.
  if (!DELIVERED_LOAD_STATUSES.includes(String(load.status ?? '')) && !early) {
    throw new Error('This load has not delivered yet — send the link early only if the carrier already has the paperwork')
  }

  // The dispatcher on the assignment is who we chase for paperwork; `to` overrides.
  const fallback = emailOrNull(loadCarrier.dispatcherEmail)
  const to = explicitTo.length > 0 ? explicitTo : fallback ? [fallback] : []
  if (via === 'EMAIL' && to.length === 0) {
    throw new Error('No dispatcher email on this assignment — add one, or copy the link instead')
  }

  const now = nowIso()
  const neededTypes = requiredUploadTypes(settings)
  const expiryDays = numberOrNull(settings?.uploadLinkExpiryDays) ?? DEFAULT_UPLOAD_LINK_EXPIRY_DAYS
  const deliveredAt = optionalString(load.deliveredAt, 40) ?? optionalString(shipment?.deliveredAt, 40)
  const expiresAt = uploadLinkExpiry(deliveredAt, expiryDays, now)

  // One live upload link per assignment: a second would leave the first working, and
  // the carrier would upload into whichever e-mail they happened to open.
  const existing = await activeUploadLink(loadId, loadCarrierId)
  const reuse = existing != null && !regenerate
  const token = reuse ? String(existing!.id) : randomBytes(TOKEN_BYTES).toString('base64url')
  const url = publicUrl('u', token)

  const patch: Row = {
    expiresAt,
    neededTypes,
    sentTo: to.join(', ') || null,
    sentVia: via,
    updatedAt: now,
  }

  await transact(
    [
      ...(existing && !reuse ? [revokeTx(String(existing.id), caller, now)] : []),
      reuse
        ? updateItemTx(TRACKING_LINK_TABLE_NAME, token, patch, null)
        : putItem(TRACKING_LINK_TABLE_NAME, trackingLinkRow({
            id: token,
            __typename: 'TrackingLink',
            kind: 'CARRIER_UPLOAD',
            shipmentId,
            loadId,
            loadCarrierId,
            status: 'ACTIVE' satisfies TrackingLinkStatus,
            openCount: 0,
            requestCount: 0,
            pingCount: 0,
            uploadCount: 0,
            // Stamped only once something actually left, below.
            sentAt: null,
            createdBy: caller.email,
            createdAt: now,
            ...patch,
          })),
      updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, {
        uploadLinkId: token,
        podRequestedAt: now,
        updatedBy: caller.email,
        updatedAt: now,
      }, null),
    ],
    'upload link',
  )

  const rendered = renderPodRequestEmail({
    loadNumber: optionalString(load.loadNumber, 60) ?? loadId,
    carrierName: optionalString(loadCarrier.carrierName, 200),
    contactName: optionalString(loadCarrier.dispatcherName, 200),
    stops: readStops(load).map(noticeStop),
    needed: neededTypes,
    uploadUrl: url,
    expiresAt,
    template: optionalString(settings?.podRequestEmailTemplate, MAX_NOTICE_BODY_CHARS),
    brokerName: await brokerNameFor([load]),
    message,
  })

  // The first request for an assignment takes the deterministic id, so the notifier's
  // automatic send and this one collide on DynamoDB rather than in the carrier's
  // inbox. A deliberate resend is a new row, because it really is a second e-mail.
  const first = optionalString(loadCarrier.podRequestedAt, 40) == null
  const delivered = await deliverNotice({
    db: dynamo,
    ses,
    tableName: SHIPMENT_NOTICE_TABLE_NAME,
    from: FROM_ADDRESS,
    draft: {
      id: first ? noticeId('POD_REQUEST', loadCarrierId) : `ntc-${randomUUID()}`,
      shipmentId,
      loadId,
      loadCarrierId,
      kind: 'POD_REQUEST',
      channel: via,
      to,
      subject: rendered.subject,
      body: rendered.body,
      trackingLinkId: token,
      createdBy: caller.email,
    },
  })

  const emailStatus: EmailStatus = via === 'COPY' ? 'COPY' : delivered.status === 'SENT' ? 'SENT' : 'NOT_SENT'
  const emailError = delivered.claimed
    ? delivered.error
    : 'This carrier has already been asked for the paperwork once'
  if (emailStatus !== 'NOT_SENT') {
    await patchRow(TRACKING_LINK_TABLE_NAME, token, { sentAt: now, updatedAt: nowIso() })
  }
  const link = await getById(TRACKING_LINK_TABLE_NAME, token)

  await writeAudit('TRACKING_LINK', token, 'SEND_UPLOAD_LINK', caller, {
    loadId, loadCarrierId, via, to, regenerate, reused: reuse, early, expiresAt, emailStatus,
  })

  return { link, url, notice: delivered.notice, emailStatus, emailError }
}

// ── REVOKE_UPLOAD_LINK ───────────────────────────────────────────────────────

async function revokeUploadLink(input: Row, caller: Caller): Promise<Row> {
  const trackingLinkId = assertString(input.trackingLinkId, 'trackingLinkId')
  const link = await getById(TRACKING_LINK_TABLE_NAME, trackingLinkId)
  if (!link) throw new Error('That upload link no longer exists')
  if (link.kind !== 'CARRIER_UPLOAD') throw new Error('That is not a carrier upload link')
  if (link.status !== 'ACTIVE') return { link }

  const now = nowIso()
  const loadCarrierId = optionalString(link.loadCarrierId, 100)
  const loadCarrier = loadCarrierId ? await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId) : null

  await transact(
    [
      revokeTx(trackingLinkId, caller, now),
      // Only clear the pointer when it still points here; a newer link owns it otherwise.
      ...(loadCarrier && loadCarrier.uploadLinkId === trackingLinkId
        ? [updateItemTx(LOAD_CARRIER_TABLE_NAME, String(loadCarrier.id), {
            uploadLinkId: null,
            updatedBy: caller.email,
            updatedAt: now,
          }, null)]
        : []),
    ],
    'upload link',
  )

  await writeAudit('TRACKING_LINK', trackingLinkId, 'REVOKE_UPLOAD_LINK', caller, { loadCarrierId })
  return { link: { ...link, status: 'REVOKED', revokedAt: now, revokedBy: caller.email, updatedAt: now } }
}

// ── SEND_MILESTONE_NOTICE ────────────────────────────────────────────────────

/**
 * The milestone e-mail an operator sends by hand, and the only way to resend one the
 * notifier already tried. Every send writes its own row: two rows that say the same
 * thing are the truth when somebody pressed Send twice.
 */
async function sendMilestoneNotice(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const milestone = assertOneOf<CustomerNotification>(input.milestone, 'milestone', MILESTONES)
  const via = assertOneOf<Exclude<TrackingLinkChannel, 'SMS'>>(input.via, 'via', ['EMAIL', 'COPY'])
  const explicitTo = assertEmailList(input.to, 'to')
  const message = optionalString(input.message, MAX_MESSAGE)

  const shipment = await liveShipment(shipmentId)
  const status = String(shipment.status ?? '')
  if (UNTRACKABLE_SHIPMENT_STATUSES.includes(status)) {
    throw new Error(
      status === 'DRAFT'
        ? 'Submit the order before telling the customer anything about it'
        : 'That shipment is canceled; there is no milestone to send',
    )
  }

  const customerId = optionalString(shipment.customerId, 100)
  const [customer, orders, settings, link] = await Promise.all([
    customerId && CUSTOMER_TABLE_NAME ? getById(CUSTOMER_TABLE_NAME, customerId) : Promise.resolve(null),
    queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    getSettings(),
    activeCustomerLink(shipmentId),
  ])

  // Whoever the operator typed in, otherwise everybody the customer subscribed to this
  // milestone. An empty list is a refusal, not a send that quietly reaches nobody.
  const subscribed = milestoneRecipients(customer as unknown as CustomerRecord | null, milestone)
  const to = explicitTo.length > 0
    ? explicitTo
    : subscribed.map((contact) => emailOrNull(contact.email)).filter((email): email is string => email != null)
  if (via === 'EMAIL' && to.length === 0) {
    throw new Error('Nobody is subscribed to this milestone — add a recipient, or switch the customer on in the directory')
  }

  const loads = await shipmentLoads(shipmentId)
  // The customer only hears the carrier's name when their own link already shows it.
  const carrierName = link?.showCarrier === true ? await activeCarrierName(shipmentId) : null
  const rendered = renderMilestoneEmail({
    milestone,
    shipmentNumber: optionalString(shipment.number, 60) ?? shipmentId,
    customerName: optionalString(customer?.name, 200),
    contactName: subscribed.length === 1 ? optionalString(subscribed[0].name, 200) : null,
    stops: loads.flatMap((load) => readStops(load).map(noticeStop)),
    references: customerReferences(orders),
    customerLinkUrl: link ? publicUrl('s', String(link.id)) : null,
    carrierName,
    deliveredAt: optionalString(shipment.deliveredAt, 40),
    template: optionalString(settings?.milestoneEmailTemplate, MAX_NOTICE_BODY_CHARS),
    brokerName: await brokerNameFor(loads),
  })
  // The lib owns the milestone text; the operator's covering note rides under it.
  const body = (message ? `${rendered.body}\n\n${message}` : rendered.body).slice(0, MAX_NOTICE_BODY_CHARS)

  const delivered = await deliverNotice({
    db: dynamo,
    ses,
    tableName: SHIPMENT_NOTICE_TABLE_NAME,
    from: FROM_ADDRESS,
    draft: {
      id: `ntc-${randomUUID()}`,
      shipmentId,
      kind: 'MILESTONE',
      milestone,
      channel: via,
      to,
      subject: rendered.subject,
      body,
      trackingLinkId: link ? String(link.id) : null,
      createdBy: caller.email,
    },
  })

  const emailStatus: EmailStatus = via === 'COPY' ? 'COPY' : delivered.status === 'SENT' ? 'SENT' : 'NOT_SENT'
  const saved = await patchRow(SHIPMENT_TABLE_NAME, shipmentId, {
    lastNoticeAt: nowIso(),
    lastNoticeStatus: delivered.status,
    updatedAt: nowIso(),
  })

  await writeAudit('SHIPMENT', shipmentId, 'SEND_MILESTONE_NOTICE', caller, {
    milestone, via, to, emailStatus,
  })

  return { notice: delivered.notice, to, emailStatus, emailError: delivered.error, shipment: saved }
}

// ── EMAIL_DOCUMENTS ──────────────────────────────────────────────────────────

/**
 * Why this row cannot go to this kind of recipient, in the operator's words, or null
 * when it can. `canEmailTo` is the rule; this only explains what it decided.
 */
function whyNotEmailable(doc: Row, recipientKind: 'CUSTOMER' | 'CARRIER'): string | null {
  const view = doc as unknown as Pick<ShipmentDocumentRecord, 'audience' | 'status' | 'reviewStatus'>
  if (canEmailTo(view, recipientKind)) return null
  const name = optionalString(doc.name, 200) ?? String(doc.id)
  if (doc.status === 'VOID') return `${name} is void`
  if (doc.status === 'SUPERSEDED') return `${name} has been replaced by a newer version`
  if (doc.reviewStatus === 'PENDING') return `${name} is still waiting to be reviewed`
  if (doc.reviewStatus === 'REJECTED') return `${name} was rejected`
  if (doc.audience === 'INTERNAL') return `${name} is internal and never leaves the office`
  return recipientKind === 'CUSTOMER'
    ? `${name} is the carrier's paperwork and does not go to the customer`
    : `${name} is the customer's paperwork and does not go to the carrier`
}

/** The bytes themselves, from whichever of the four stores the row points at. */
async function documentBytes(doc: Row): Promise<Uint8Array> {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: String(doc.s3Key) }))
  const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
  if (!body?.transformToByteArray) throw new Error(`Could not read ${String(doc.name)} out of storage`)
  return body.transformToByteArray()
}

async function emailDocuments(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const recipientKind = assertOneOf<'CUSTOMER' | 'CARRIER'>(input.recipientKind, 'recipientKind', RECIPIENT_KINDS)
  const to = assertEmailList(input.to, 'to')
  const cc = assertEmailList(input.cc, 'cc')
  const subject = optionalString(input.subject, MAX_SUBJECT)
  const message = optionalString(input.message, MAX_MESSAGE)
  if (to.length === 0) throw new Error('A document e-mail needs at least one recipient')
  if (!Array.isArray(input.documentIds)) throw new Error('documentIds must be a list of document ids')
  const documentIds = [...new Set(input.documentIds.map((v, i) => assertString(v, `documentIds[${i}]`)))]
  if (documentIds.length === 0) throw new Error('Pick at least one document to send')
  if (documentIds.length > MAX_EMAIL_DOCUMENTS) {
    throw new Error(`One e-mail carries at most ${MAX_EMAIL_DOCUMENTS} documents`)
  }

  const shipment = await liveShipment(shipmentId)

  const docs: Row[] = []
  for (const documentId of documentIds) {
    const doc = await getById(SHIPMENT_DOCUMENT_TABLE_NAME, documentId)
    if (!doc) throw new Error(`Document not found: ${documentId}`)
    if (String(doc.shipmentId) !== shipmentId) {
      throw new Error(`${optionalString(doc.name, 200) ?? documentId} belongs to another shipment`)
    }
    const refusal = whyNotEmailable(doc, recipientKind)
    if (refusal) throw new Error(refusal)
    // A pointer row's bytes live in the driver app's or the rate con's own prefix;
    // anything outside the four we know is not ours to attach.
    const key = String(doc.s3Key ?? '')
    if (!EMAILABLE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`${optionalString(doc.name, 200) ?? documentId} is not stored where this router can read it`)
    }
    docs.push(doc)
  }

  const totalBytes = docs.reduce((sum, doc) => sum + (numberOrNull(doc.sizeBytes) ?? 0), 0)
  if (totalBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
    const totalMb = Math.round((totalBytes / (1024 * 1024)) * 10) / 10
    throw new Error(
      `Those documents come to ${totalMb} MB; one e-mail carries at most ${MAX_EMAIL_ATTACHMENT_BYTES / (1024 * 1024)} MB — send them in two`,
    )
  }

  const attachments: EmailAttachment[] = []
  for (const doc of docs) {
    attachments.push({
      filename: String(doc.name),
      contentType: String(doc.contentType),
      bytes: await documentBytes(doc),
    })
  }

  const number = optionalString(shipment.number, 60) ?? shipmentId
  const rendered = renderDocumentsEmail({
    shipmentNumber: number,
    documents: docs.map((doc) => ({ name: String(doc.name), type: doc.type as ShipmentDocumentType })),
    message,
    subject,
    senderName: caller.email,
    brokerName: await brokerNameFor(await shipmentLoads(shipmentId)),
  })

  const delivered = await deliverNotice({
    db: dynamo,
    ses,
    tableName: SHIPMENT_NOTICE_TABLE_NAME,
    from: FROM_ADDRESS,
    attachments,
    draft: {
      id: `ntc-${randomUUID()}`,
      shipmentId,
      kind: 'DOCUMENTS',
      channel: 'EMAIL',
      to,
      cc,
      subject: rendered.subject,
      body: rendered.body,
      attachments: docs.map((doc) => ({
        documentId: String(doc.id),
        name: String(doc.name),
        sizeBytes: numberOrNull(doc.sizeBytes) ?? 0,
      })),
      createdBy: caller.email,
    },
  })

  const emailStatus: EmailStatus = delivered.status === 'SENT' ? 'SENT' : 'NOT_SENT'
  // SES is denied on dev, and the customer still needs their paperwork. A refused send
  // hands back a download for every file so the operator can forward them by hand.
  const downloads = emailStatus === 'SENT'
    ? []
    : await Promise.all(docs.map(async (doc) => ({
        documentId: String(doc.id),
        name: String(doc.name),
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET_NAME, Key: String(doc.s3Key) }),
          { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
        ),
      })))

  await writeAudit('SHIPMENT', shipmentId, 'EMAIL_DOCUMENTS', caller, {
    documentIds, to, cc, recipientKind, emailStatus,
  })

  return { notice: delivered.notice, emailStatus, emailError: delivered.error, downloads }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<Row> => {
  const action = event.arguments.action as Action
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'SEND_TRACKING_LINK':
      return sendTrackingLink(input, caller)
    case 'REVOKE_TRACKING_LINK':
      return revokeTrackingLink(input, caller)
    case 'SEND_CUSTOMER_LINK':
      return sendCustomerLink(input, caller)
    case 'REVOKE_CUSTOMER_LINK':
      return revokeCustomerLink(input, caller)
    case 'TEXT_DRIVER':
      return textDriver(input, caller)
    case 'SAVE_TRACKING_SETTINGS':
      return saveSettings(input, caller, action, trackingSettingsPatch(input))
    case 'SEND_UPLOAD_LINK':
      return sendUploadLink(input, caller)
    case 'REVOKE_UPLOAD_LINK':
      return revokeUploadLink(input, caller)
    case 'SEND_MILESTONE_NOTICE':
      return sendMilestoneNotice(input, caller)
    case 'EMAIL_DOCUMENTS':
      return emailDocuments(input, caller)
    case 'SAVE_DOCUMENT_SETTINGS':
      return saveSettings(input, caller, action, documentSettingsPatch(input))
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
