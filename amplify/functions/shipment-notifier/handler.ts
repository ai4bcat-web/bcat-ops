/**
 * shipment-notifier Lambda — DynamoDB stream consumer on the Load table.
 *
 * `load-tracking-projector` moves a load up the status ladder; this Lambda is what
 * that movement is *for* on the outside of the office. One MODIFY record whose
 * `status` actually changed becomes, at most, two e-mails:
 *
 *   • the customer's milestone notice, when the org switch is on, the customer has
 *     opted in through `visibilityPrefs.milestoneEmails` and somebody subscribed to
 *     that milestone — and, for DELIVERED, only once every leg of the shipment has
 *     landed, because that milestone is a fact about the shipment and not the leg;
 *   • as soon as a leg delivers, a request to that leg's outside carrier for the
 *     paperwork we still need, carrying a CARRIER_UPLOAD link. A carrier is asked
 *     for its own POD the moment its own leg lands; it has no reason to wait on
 *     somebody else's leg further down the shipment.
 *
 * Four rules shape the file:
 *
 *   • **A notice is a row before it is an e-mail.** `deliverNotice` claims a
 *     deterministic id (`ms:<shipmentId>:<milestone>`, `pod:<loadCarrierId>`) with
 *     `attribute_not_exists(id)` and only then calls SES, so a stream retry, or the
 *     second leg of a two-leg shipment reaching DELIVERED, collides in DynamoDB
 *     rather than in somebody's inbox.
 *   • **A send that fails is not a batch that fails.** `deliverNotice` records
 *     NOT_SENT with the reason and returns normally; each record is wrapped so one
 *     bad row cannot drop the nine behind it in the batch.
 *   • **Legacy loads get nothing.** No `shipmentId` means the row predates the TMS
 *     and has no customer, no assignment and nobody to tell.
 *   • **Our own drivers get nothing either.** An OWN_ASSET leg sends its POD
 *     through the driver app; only a `kind CARRIER` assignment with a dispatcher
 *     e-mail is asked for paperwork.
 *
 * Reads and writes go through the raw DynamoDB SDK and the `_shared/shipmentStore`
 * helpers. Nothing here reaches for AppSync: a stream consumer has no caller to
 * authorize as.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { randomBytes } from 'crypto'

import { deliverNotice } from '../_shared/shipmentNotices'
import {
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  getById,
  marshallRow,
  nowIso,
  numberOrNull,
  queryIndex,
  queryShipmentDocuments,
  readStops,
  type Row,
} from '../_shared/shipmentStore'
import { isVoided } from '../_shared/voided'
import {
  DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES,
  DEFAULT_UPLOAD_LINK_EXPIRY_DAYS,
  MAX_UPLOAD_LINK_EXPIRY_DAYS,
  MIN_UPLOAD_LINK_EXPIRY_DAYS,
  normalizeRequiredDocTypes,
} from '../../../src/lib/shipmentDocuments'
import {
  MILESTONE_BY_LOAD_STATUS,
  milestoneRecipients,
  noticeId,
  renderMilestoneEmail,
  renderPodRequestEmail,
  uploadLinkExpiry,
  type NoticeStop,
} from '../../../src/lib/shipmentNotices'
import { outstandingCarrierTypes } from '../../../src/lib/uploadPortal'
import type {
  CustomerContact,
  CustomerRecord,
  LoadWorkflowStatus,
  OrderReference,
  ShipmentDocumentRecord,
  ShipmentDocumentType,
  ShipmentNoticeStatus,
  TrackingLinkStatus,
  VisibilityPrefs,
} from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})
const sesClient = new SESv2Client({})

/** Who the rows this Lambda writes say wrote them. */
export const NOTIFIER_ACTOR = 'shipment-notifier'

// Amplify derives GSI names from the plural model name and the key fields.
const IDX_CARRIERS_BY_LOAD = 'loadCarriersByLoadId'
const IDX_LINKS_BY_SHIPMENT = 'trackingLinksByShipmentId'
const IDX_LINKS_BY_LOAD = 'trackingLinksByLoadId'

/** The settings row is a singleton, as every other TMS Lambda reads it. */
const SETTINGS_ID = 'default'
/** The name an e-mail signs off with when the load carries no division. */
const BROKER_FALLBACK = 'BCAT Logistics'
/** 24 bytes of entropy: 32 base64url characters, the length `isLinkToken` accepts. */
const TOKEN_BYTES = 24
/** A canceled leg will never deliver; waiting for it would mute the shipment forever. */
const DEAD_LOAD_STATUSES: readonly string[] = ['CANCELED']

// Minimal shape of the DynamoDB stream event (avoids an @types/aws-lambda dependency).
interface StreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  dynamodb?: {
    NewImage?: Record<string, AttributeValue>
    OldImage?: Record<string, AttributeValue>
  }
}
export interface StreamEvent { Records?: StreamRecord[] }

export interface NotifierTables {
  load: string
  shipment: string
  order: string
  loadCarrier: string
  customer: string
  settings: string
  division: string
  trackingLink: string
  shipmentNotice: string
  shipmentDocument: string
}

export interface NotifierDeps {
  db: DynamoDBClient
  ses: SESv2Client
  tables: NotifierTables
  now: () => string
  /** Where the public pages live; empty on a stack that has no portal origin. */
  portalOrigin: string
  /** The verified SES identity every notice goes out from. */
  from: string
}

export interface NotifierSummary {
  /** Stream records in the batch. */
  records: number
  /** Records that carried a shipment and a changed, notifiable status. */
  considered: number
  /** Milestone notices this batch claimed — never one somebody else had claimed. */
  milestones: number
  /** POD requests claimed, each with its upload link. */
  podRequests: number
  /** Shipments stamped `deliveredAt` because their last leg landed. */
  deliveries: number
  /** Notices SES actually accepted. Zero is the normal dev number. */
  sent: number
  /** Records that threw. The rest of the batch still ran. */
  failures: number
}

function emptySummary(): NotifierSummary {
  return { records: 0, considered: 0, milestones: 0, podRequests: 0, deliveries: 0, sent: 0, failures: 0 }
}

// ── Reading rows ─────────────────────────────────────────────────────────────

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * An `a.json()` column, whichever way it was written. The directory and shipment
 * routers marshall these as native maps and lists; a row written through AppSync
 * carries the same value as an AWSJSON string, so both are read the way `readStops`
 * reads a load's stops.
 */
function readJson<T>(value: unknown): T | null {
  let v = value
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) as unknown } catch { return null }
  }
  return v && typeof v === 'object' ? (v as T) : null
}

function readJsonArray<T>(value: unknown): T[] {
  const parsed = readJson<unknown>(value)
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

/** Only the two fields `milestoneRecipients` judges a customer on. */
function customerPrefs(row: Row | null): Pick<CustomerRecord, 'contacts' | 'visibilityPrefs'> | null {
  if (!row) return null
  return {
    contacts: readJsonArray<CustomerContact>(row.contacts),
    visibilityPrefs: readJson<VisibilityPrefs>(row.visibilityPrefs),
  }
}

/** The stops as the e-mail prints them: where, when, and nothing else. */
function noticeStops(load: Row): NoticeStop[] {
  return readStops(load).map((stop) => ({
    type: String(stop.type ?? ''),
    name: stop.name ?? null,
    city: typeof stop.city === 'string' ? stop.city : null,
    state: null,
    appt: stop.appt ?? null,
    arrivedAt: stop.arrivedAt ?? null,
    departedAt: stop.departedAt ?? null,
  }))
}

/** Division's primary key is `key`, not `id`, so it cannot go through `getById`. */
async function getDivision(deps: NotifierDeps, key: string): Promise<Row | null> {
  if (!key || !deps.tables.division) return null
  const result = await deps.db.send(
    new GetItemCommand({ TableName: deps.tables.division, Key: marshall({ key }) }),
  )
  return result.Item ? unmarshall(result.Item) : null
}

// ── Writing rows ─────────────────────────────────────────────────────────────

const isConditionFailure = (err: unknown): boolean =>
  err instanceof ConditionalCheckFailedException ||
  (err instanceof Error && err.name === 'ConditionalCheckFailedException')

/** `SET` for every own key of `patch`, with every name escaped (`status` is reserved). */
function setExpression(patch: Row): {
  UpdateExpression: string
  ExpressionAttributeNames: Record<string, string>
  ExpressionAttributeValues: Record<string, AttributeValue>
} {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  return {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}

/**
 * A follow-up stamp on a row somebody else owns: the link this Lambda just minted,
 * the delivery time, the outcome of a send. No CAS guard, because none of these
 * fields is edited anywhere a staff write could be racing us for them.
 */
async function patchRow(deps: NotifierDeps, tableName: string, id: string, patch: Row): Promise<void> {
  if (!tableName) return
  await deps.db.send(new UpdateItemCommand({
    TableName: tableName,
    Key: marshall({ id }),
    ...setExpression(patch),
  }))
}

/**
 * Stamp the moment the whole shipment landed. Conditional on the field being
 * absent, so a stream retry — or the third leg of a three-leg shipment arriving
 * out of order — never moves a delivery time that is already recorded.
 */
async function stampDeliveredAt(deps: NotifierDeps, shipmentId: string, at: string): Promise<boolean> {
  const now = deps.now()
  try {
    await deps.db.send(new UpdateItemCommand({
      TableName: deps.tables.shipment,
      Key: marshall({ id: shipmentId }),
      ...setExpression({ deliveredAt: at, updatedAt: now, updatedBy: NOTIFIER_ACTOR }),
      ConditionExpression: 'attribute_not_exists(deliveredAt)',
    }))
    return true
  } catch (err) {
    if (isConditionFailure(err)) return false
    throw err
  }
}

// ── Links ────────────────────────────────────────────────────────────────────

function publicUrl(deps: NotifierDeps, path: 's' | 'u', token: string): string {
  const origin = deps.portalOrigin.replace(/\/+$/, '')
  return origin ? `${origin}/track/${path}/${token}` : `/track/${path}/${token}`
}

/** How long a carrier's upload link lives past delivery, inside the settings bounds. */
function expiryDays(settings: Row | null): number {
  const days = numberOrNull(settings?.uploadLinkExpiryDays)
  if (days == null) return DEFAULT_UPLOAD_LINK_EXPIRY_DAYS
  return Math.min(Math.max(Math.round(days), MIN_UPLOAD_LINK_EXPIRY_DAYS), MAX_UPLOAD_LINK_EXPIRY_DAYS)
}

interface UploadLink {
  token: string
  expiresAt: string
}

/**
 * The assignment's upload link: the one it already has, with a refreshed clock and
 * a fresh snapshot of what is still missing, or a new token.
 *
 * One ACTIVE CARRIER_UPLOAD link per assignment, found the same way
 * `tms-tracking-actions` finds it, so an automatic request and a later manual
 * re-send are the same link in the carrier's inbox rather than two.
 */
async function uploadLinkFor(
  deps: NotifierDeps,
  args: {
    shipmentId: string
    loadId: string
    assignment: Row
    needed: ShipmentDocumentType[]
    deliveredAt: string | null
    settings: Row | null
  },
): Promise<UploadLink> {
  const loadCarrierId = String(args.assignment.id)
  const now = deps.now()
  const expiresAt = uploadLinkExpiry(args.deliveredAt, expiryDays(args.settings), now)

  const links = await queryIndex(deps.db, deps.tables.trackingLink, IDX_LINKS_BY_LOAD, 'loadId', args.loadId)
  const existing = links.find(
    (link) =>
      link.kind === 'CARRIER_UPLOAD' && link.status === 'ACTIVE' && link.loadCarrierId === loadCarrierId,
  )
  if (existing) {
    await patchRow(deps, deps.tables.trackingLink, String(existing.id), {
      expiresAt,
      neededTypes: args.needed,
      updatedAt: now,
    })
    return { token: String(existing.id), expiresAt }
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  await deps.db.send(new PutItemCommand({
    TableName: deps.tables.trackingLink,
    Item: marshallRow({
      id: token,
      __typename: 'TrackingLink',
      kind: 'CARRIER_UPLOAD',
      shipmentId: args.shipmentId,
      loadId: args.loadId,
      loadCarrierId,
      status: 'ACTIVE' satisfies TrackingLinkStatus,
      expiresAt,
      sentTo: text(args.assignment.dispatcherEmail) || null,
      sentVia: 'EMAIL',
      // Stamped by the send below only if SES actually took it.
      sentAt: null,
      contactName: text(args.assignment.dispatcherName) || null,
      contactEmail: text(args.assignment.dispatcherEmail) || null,
      openCount: 0,
      requestCount: 0,
      pingCount: 0,
      uploadCount: 0,
      neededTypes: args.needed,
      createdBy: NOTIFIER_ACTOR,
      createdAt: now,
      updatedAt: now,
    }),
    ConditionExpression: 'attribute_not_exists(id)',
  }))
  return { token, expiresAt }
}

// ── One record ───────────────────────────────────────────────────────────────

/** Did the last leg land? A canceled leg is never coming, so it does not count. */
function allLegsDelivered(legs: Row[], loadId: string, streamStatus: string): boolean {
  // The stream image is newer than anything the index can hand back for this load.
  const statuses = legs
    .filter((leg) => text(leg.id) !== loadId)
    .map((leg) => text(leg.status))
    .concat(streamStatus)
  return statuses
    .filter((status) => !DEAD_LOAD_STATUSES.includes(status))
    .every((status) => status === 'DELIVERED')
}

/** The latest delivery across the shipment's legs, or now when none was stamped. */
function deliveredAtOf(legs: Row[], load: Row, fallback: string): string {
  const stamps = legs
    .filter((leg) => text(leg.id) !== text(load.id))
    .map((leg) => text(leg.deliveredAt))
    .concat(text(load.deliveredAt))
    .filter(Boolean)
    .sort()
  return stamps.length > 0 ? stamps[stamps.length - 1] : fallback
}

async function notifyRecord(record: StreamRecord, deps: NotifierDeps): Promise<NotifierSummary | null> {
  if (record.eventName !== 'MODIFY') return null
  const newImage = record.dynamodb?.NewImage
  if (!newImage) return null
  const load = unmarshall(newImage) as Row
  const shipmentId = text(load.shipmentId)
  const loadId = text(load.id)
  // A legacy own-fleet load has no shipment, no customer and nobody to tell.
  if (!shipmentId || !loadId) return null

  const prev = record.dynamodb?.OldImage ? (unmarshall(record.dynamodb.OldImage) as Row) : {}
  const status = text(load.status)
  // Every other edit a load gets — stop times, money, notes — is not news.
  if (!status || status === text(prev.status)) return null
  const milestone = MILESTONE_BY_LOAD_STATUS[status as LoadWorkflowStatus]
  if (!milestone) return null

  const summary = emptySummary()
  summary.considered = 1

  const shipment = await getById(deps.db, deps.tables.shipment, shipmentId)
  if (!shipment) {
    console.warn('[shipment-notifier] load points at a shipment that is not there', { loadId, shipmentId })
    return summary
  }
  // A voided shipment still has a Load row and still gets stream records; it has no
  // business e-mailing a customer. `deletedAt` is the pre-R soft delete and counts
  // as a void, which is what `isVoided` reads.
  if (isVoided(shipment)) return summary

  const now = deps.now()
  let deliveredAt = text(shipment.deliveredAt) || null
  // Whether the shipment as a whole has landed. Only the customer's DELIVERED
  // milestone and the `Shipment.deliveredAt` stamp wait on this: both are facts
  // about the shipment, so they belong to whichever leg happens to be last. The
  // carrier's paperwork below is a fact about one leg and never waits.
  let shipmentDelivered = true

  if (milestone === 'DELIVERED') {
    const legs = await queryIndex(deps.db, deps.tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
    shipmentDelivered = allLegsDelivered(legs, loadId, status)
    if (shipmentDelivered) {
      deliveredAt = deliveredAtOf(legs, load, now)
      if (!text(shipment.deliveredAt) && (await stampDeliveredAt(deps, shipmentId, deliveredAt))) {
        summary.deliveries = 1
      }
    }
  }

  const settings = deps.tables.settings
    ? await getById(deps.db, deps.tables.settings, SETTINGS_ID)
    : null
  const division = await getDivision(deps, text(load.divisionKey))
  const brokerName = text(division?.name) || BROKER_FALLBACK

  // The assignments behind this leg, read at most once per record.
  let assignmentRows: Row[] | null = null
  const assignments = async (): Promise<Row[]> => {
    if (!assignmentRows) {
      assignmentRows = await queryIndex(deps.db, deps.tables.loadCarrier, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
    }
    return assignmentRows
  }

  let outcome: { at: string; status: ShipmentNoticeStatus } | null = null

  // ── The customer's milestone notice ────────────────────────────────────────
  // One leg of a multi-leg shipment landing is not the shipment landing; the
  // customer hears about DELIVERED once, from whichever leg is last.
  if (shipmentDelivered && settings?.milestoneNoticesEnabled !== false) {
    const customerId = text(shipment.customerId)
    const customer = customerId ? await getById(deps.db, deps.tables.customer, customerId) : null
    const recipients = milestoneRecipients(customerPrefs(customer), milestone)
    if (recipients.length > 0) {
      const links = await queryIndex(
        deps.db, deps.tables.trackingLink, IDX_LINKS_BY_SHIPMENT, 'shipmentId', shipmentId,
      )
      const customerLink = links.find((link) => link.kind === 'CUSTOMER_VIEW' && link.status === 'ACTIVE') ?? null

      // The carrier's name is the customer's business only when the page they are
      // already looking at names it.
      let carrierName: string | null = null
      if (customerLink?.showCarrier === true) {
        const active = (await assignments()).find((row) => row.status === 'ACTIVE')
        carrierName = text(active?.carrierName) || null
      }

      const orders = await queryIndex(deps.db, deps.tables.order, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
      const order = orders.find((row) => text(row.id) === text(load.orderId)) ?? orders[0] ?? null
      const references = readJsonArray<OrderReference>(order?.references).filter(
        (reference) => reference.visibility === 'CUSTOMER' || reference.visibility === 'ALL',
      )

      const { subject, body } = renderMilestoneEmail({
        milestone,
        shipmentNumber: text(shipment.number) || shipmentId,
        customerName: text(shipment.customerName) || null,
        // A note addressed to one person by name; a list gets a plain greeting.
        contactName: recipients.length === 1 ? recipients[0].name : null,
        stops: noticeStops(load),
        references,
        customerLinkUrl: customerLink ? publicUrl(deps, 's', String(customerLink.id)) : null,
        carrierName,
        deliveredAt: milestone === 'DELIVERED' ? deliveredAt : null,
        template: text(settings?.milestoneEmailTemplate) || null,
        brokerName,
      })

      const sent = await deliverNotice({
        db: deps.db,
        ses: deps.ses,
        tableName: deps.tables.shipmentNotice,
        from: deps.from,
        draft: {
          id: noticeId('MILESTONE', shipmentId, milestone),
          shipmentId,
          loadId,
          kind: 'MILESTONE',
          milestone,
          channel: 'EMAIL',
          to: recipients.map((contact) => String(contact.email)),
          subject,
          body,
          trackingLinkId: customerLink ? String(customerLink.id) : null,
          createdBy: NOTIFIER_ACTOR,
        },
      })
      if (sent.claimed) {
        summary.milestones = 1
        if (sent.status === 'SENT') summary.sent += 1
        outcome = { at: now, status: sent.status }
      }
    }
  }

  // ── The carrier's paperwork ────────────────────────────────────────────────
  // Every DELIVERED record, final leg or not: a carrier is asked for its own POD
  // when its own leg lands, against that leg's own ACTIVE CARRIER assignment. The
  // deterministic `pod:<loadCarrierId>` claim is what keeps it to one ask per
  // assignment, so no further guard is needed here.
  if (milestone === 'DELIVERED' && settings?.podRequestEnabled !== false) {
    // Our own drivers send PODs through the driver app, so OWN_ASSET is never asked.
    const assignment = (await assignments()).find(
      (row) => row.status === 'ACTIVE' && row.kind === 'CARRIER' && text(row.dispatcherEmail),
    )
    if (assignment) {
      const loadCarrierId = String(assignment.id)
      const requested = normalizeRequiredDocTypes(
        (settings?.requiredCarrierUploadTypes as string[] | undefined) ??
          [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES],
      ).types
      const needed = requested.length > 0 ? requested : [...DEFAULT_REQUIRED_CARRIER_UPLOAD_TYPES]
      const documents = (await queryShipmentDocuments(
        deps.db, deps.tables.shipmentDocument, shipmentId,
      )) as unknown as ShipmentDocumentRecord[]
      const outstanding = outstandingCarrierTypes(needed, documents, loadCarrierId)

      // A carrier who already sent everything is not chased for it.
      if (outstanding.length > 0) {
        const link = await uploadLinkFor(deps, {
          shipmentId,
          loadId,
          assignment,
          needed: outstanding,
          // A link minted for leg one is measured from leg one's delivery, which is
          // the only delivery its carrier knows about; the shipment's own time is
          // the fallback for a leg that landed without a stamp.
          deliveredAt: text(load.deliveredAt) || deliveredAt,
          settings,
        })
        const { subject, body } = renderPodRequestEmail({
          loadNumber: text(load.loadNumber) || loadId,
          carrierName: text(assignment.carrierName) || null,
          contactName: text(assignment.dispatcherName) || null,
          stops: noticeStops(load),
          needed: outstanding,
          uploadUrl: publicUrl(deps, 'u', link.token),
          expiresAt: link.expiresAt,
          template: text(settings?.podRequestEmailTemplate) || null,
          brokerName,
        })

        const sent = await deliverNotice({
          db: deps.db,
          ses: deps.ses,
          tableName: deps.tables.shipmentNotice,
          from: deps.from,
          draft: {
            id: noticeId('POD_REQUEST', loadCarrierId),
            shipmentId,
            loadId,
            loadCarrierId,
            kind: 'POD_REQUEST',
            channel: 'EMAIL',
            to: [text(assignment.dispatcherEmail)],
            subject,
            body,
            trackingLinkId: link.token,
            createdBy: NOTIFIER_ACTOR,
          },
        })
        if (sent.claimed) {
          summary.podRequests = 1
          if (sent.status === 'SENT') summary.sent += 1
          outcome = { at: now, status: sent.status }
          // `podRequestedAt` is when we actually asked, so it is stamped only on the
          // attempt that claimed the notice — a retry leaves the first time alone.
          await patchRow(deps, deps.tables.loadCarrier, loadCarrierId, {
            uploadLinkId: link.token,
            podRequestedAt: now,
            updatedAt: now,
            updatedBy: NOTIFIER_ACTOR,
          })
          // The link row says when it actually went out, not when it was minted.
          if (sent.status === 'SENT') {
            await patchRow(deps, deps.tables.trackingLink, link.token, { sentAt: now, updatedAt: now })
          }
        }
      }
    }
  }

  if (outcome) {
    await patchRow(deps, deps.tables.shipment, shipmentId, {
      lastNoticeAt: outcome.at,
      lastNoticeStatus: outcome.status,
      updatedAt: now,
      updatedBy: NOTIFIER_ACTOR,
    })
  }

  return summary
}

export async function notifyLoadStream(event: StreamEvent, deps: NotifierDeps): Promise<NotifierSummary> {
  const total = emptySummary()
  for (const record of event.Records ?? []) {
    total.records += 1
    try {
      const one = await notifyRecord(record, deps)
      if (!one) continue
      total.considered += one.considered
      total.milestones += one.milestones
      total.podRequests += one.podRequests
      total.deliveries += one.deliveries
      total.sent += one.sent
    } catch (err) {
      // One unreadable or unwritable load is not a reason to re-deliver — and so
      // re-send — the nine behind it in the batch.
      const loadId = record.dynamodb?.NewImage?.id?.S ?? 'unknown'
      console.error('[shipment-notifier] record failed', { loadId, err: String(err) })
      total.failures += 1
    }
  }
  return total
}

export function notifierDepsFromEnv(env: NodeJS.ProcessEnv = process.env): NotifierDeps {
  return {
    db: dynamo,
    ses: sesClient,
    tables: {
      load: env.LOAD_TABLE_NAME ?? '',
      shipment: env.SHIPMENT_TABLE_NAME ?? '',
      order: env.ORDER_TABLE_NAME ?? '',
      loadCarrier: env.LOAD_CARRIER_TABLE_NAME ?? '',
      customer: env.CUSTOMER_TABLE_NAME ?? '',
      settings: env.TMS_SETTINGS_TABLE_NAME ?? '',
      division: env.DIVISION_TABLE_NAME ?? '',
      trackingLink: env.TRACKING_LINK_TABLE_NAME ?? '',
      shipmentNotice: env.SHIPMENT_NOTICE_TABLE_NAME ?? '',
      shipmentDocument: env.SHIPMENT_DOCUMENT_TABLE_NAME ?? '',
    },
    now: nowIso,
    portalOrigin: env.PORTAL_ORIGIN ?? '',
    from: env.FROM_ADDRESS ?? 'ai4bcat@gmail.com',
  }
}

export const handler = async (event: StreamEvent): Promise<NotifierSummary> => {
  const summary = await notifyLoadStream(event, notifierDepsFromEnv())
  console.log('[shipment-notifier]', summary)
  return summary
}
