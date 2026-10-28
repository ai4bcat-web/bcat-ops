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
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomBytes, randomUUID } from 'crypto'

import {
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
} from '../_shared/shipmentStore'
import { DispatchStore, tablesFromEnv } from '../_shared/dispatchStore'
import { loadDispatchConfig, type DispatchConfig } from '../_shared/dispatchConfig'
import { sendDispatchText, type SendDeps } from '../_shared/dispatchSend'
import { sendMessage } from '../_shared/twilio'
import { MAX_SMS_BODY, toE164Strict } from '../../../src/lib/dispatch'
import { linkExpiry, smsBodyFor } from '../../../src/lib/trackingLink'
import type {
  CheckCallNotifyChannel,
  TrackingContact,
  TrackingLinkChannel,
  TrackingLinkStatus,
} from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})
const ses = new SESv2Client({})

const TRACKING_LINK_TABLE_NAME = process.env.TRACKING_LINK_TABLE_NAME ?? ''
const LOAD_CHECK_CALL_TABLE_NAME = process.env.LOAD_CHECK_CALL_TABLE_NAME ?? ''
const SHIPMENT_TABLE_NAME = process.env.SHIPMENT_TABLE_NAME ?? ''
const ORDER_TABLE_NAME = process.env.ORDER_TABLE_NAME ?? ''
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''
const LOAD_CARRIER_TABLE_NAME = process.env.LOAD_CARRIER_TABLE_NAME ?? ''
const TMS_SETTINGS_TABLE_NAME = process.env.TMS_SETTINGS_TABLE_NAME ?? ''
const DIVISION_TABLE_NAME = process.env.DIVISION_TABLE_NAME ?? ''
const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN ?? ''
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? ''
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'ai4bcat@gmail.com'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const LOAD_PAGE_GROUP = 'page-loads'
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

// ── Types ────────────────────────────────────────────────────────────────────

type Action =
  | 'SEND_TRACKING_LINK'
  | 'REVOKE_TRACKING_LINK'
  | 'SEND_CUSTOMER_LINK'
  | 'REVOKE_CUSTOMER_LINK'
  | 'TEXT_DRIVER'
  | 'SAVE_TRACKING_SETTINGS'

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

  // How long every link lives and who the customer page says to call is org-wide
  // configuration, not a dispatcher's call on one load.
  if (action === 'SAVE_TRACKING_SETTINGS') {
    if (!isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  } else if (!isAdmin && !groups.includes(LOAD_PAGE_GROUP)) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${LOAD_PAGE_GROUP}`)
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

function publicUrl(path: 'l' | 's', token: string): string {
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
  const load = await getById(LOAD_TABLE_NAME, loadId)
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

  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (shipment.deletedAt) throw new Error('That shipment is in the trash; restore it before sending a tracking link')
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

async function saveTrackingSettings(input: Row, caller: Caller): Promise<Row> {
  const id = optionalString(input.id, 40) ?? SETTINGS_ID
  if (id !== SETTINGS_ID) throw new Error(`Settings id must be '${SETTINGS_ID}'`)
  const patch = trackingSettingsPatch(input)
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
  await writeAudit('TMS_SETTINGS', SETTINGS_ID, 'SAVE_TRACKING_SETTINGS', caller, {
    created: !existing, keys: Object.keys(patch),
  })
  return saved
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
      return saveTrackingSettings(input, caller)
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
