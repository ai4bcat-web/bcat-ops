/**
 * The shipment thread (Step P8 / N4) and the bridge that carries it.
 *
 * One Gmail thread per shipment, with plus-address routing and real Message-ID /
 * In-Reply-To headers. Every outbound message is claimed first and sent second, so a
 * crash after SES or Twilio still leaves the record of what we tried to say.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  newMessageId,
  shipmentIdFromAddresses,
  shipmentIdFromMessageId,
  threadKeyFor,
  threadReplyAddress,
} from '../../../src/lib/shipmentThread'
import { assertEnum, assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { putItem, type Row, updateItemTx } from '../_shared/shipmentStore'

export type ShipmentMessageChannel = 'EMAIL' | 'SMS' | 'VOICE'
export type ShipmentMessageDirection = 'IN' | 'OUT'
export type ShipmentMessageStatus = 'SENT' | 'NOT_SENT' | 'FAILED' | 'RECEIVED'
export type ShipmentMessageKind =
  | 'RATE_CON'
  | 'CHECK_CALL'
  | 'CHECK_CALL_REPLY'
  | 'POD_REQUEST'
  | 'POD_REPLY'
  | 'ESCALATION'
  | 'CARRIER_OFFER'
  | 'QUOTE'
  | 'TENDER'
  | 'NOTE'
  | 'OTHER'
export type ShipmentMessageParty = 'DRIVER' | 'DISPATCHER' | 'CARRIER' | 'CUSTOMER' | 'INTERNAL'

export interface SendEmailOutcome {
  status: 'SENT' | 'NOT_SENT' | 'FAILED'
  providerRef: string | null
  error: string | null
}

export interface SendSmsOutcome {
  status: 'SENT' | 'NOT_SENT' | 'FAILED'
  providerRef: string | null
  error: string | null
}

export interface EmailAttachment {
  filename: string
  contentType: string
  bytes: Uint8Array
}

export interface ThreadDeps {
  tables: {
    message: string
    shipment: string
    order: string
    load: string
    loadCarrier: string
    customer: string
    settings: string
    document: string
    checkCall: string
    trackingLink: string
  }
  getById(tableName: string, id: string): Promise<Row | null>
  queryIndex(tableName: string, indexName: string, keyName: string, keyValue: string): Promise<Row[]>
  transact(items: TransactWriteItem[]): Promise<void>
  readBundle(shipmentId: string): Promise<Row>
  getSettings(): Promise<Row>
  writeAudit(
    entityType: string,
    entityId: string,
    action: string,
    caller: Caller,
    changes: Row,
  ): Promise<void>
  sendEmail(input: {
    to: string
    cc?: string | null
    subject: string
    body: string
    messageId: string
    inReplyTo?: string | null
    replyTo: string
    attachments?: EmailAttachment[]
  }): Promise<SendEmailOutcome>
  sendSms(input: { to: string; body: string; label: Row }): Promise<SendSmsOutcome>
  /** Geocode a free-text driver reply. Null means the text named no place. */
  geocode(text: string): Promise<{ city: string; state: string; lat: number; lng: number } | null>
  /** Fetch a document's bytes out of storage (caller already validated the s3Key). */
  readDocumentBytes(s3Key: string): Promise<Uint8Array>
  now(): string
  randomId(): string
}

const MESSAGE_CHANNELS: readonly ShipmentMessageChannel[] = ['EMAIL', 'SMS', 'VOICE']
const MESSAGE_KINDS: readonly ShipmentMessageKind[] = [
  'RATE_CON',
  'CHECK_CALL',
  'CHECK_CALL_REPLY',
  'POD_REQUEST',
  'POD_REPLY',
  'ESCALATION',
  'CARRIER_OFFER',
  'QUOTE',
  'TENDER',
  'NOTE',
  'OTHER',
]
const MESSAGE_PARTIES: readonly ShipmentMessageParty[] = ['DRIVER', 'DISPATCHER', 'CARRIER', 'CUSTOMER', 'INTERNAL']
const OUTBOUND_STATUSES: readonly ShipmentMessageStatus[] = ['SENT', 'NOT_SENT', 'FAILED']

function cleanRecipient(value: unknown): string | null {
  const v = optionalString(value, 500)
  return v && v.trim() ? v.trim() : null
}

function cleanKind(value: unknown): ShipmentMessageKind {
  const v = optionalString(value, 40)
  return assertEnum(v ?? 'OTHER', MESSAGE_KINDS, 'kind')
}

function cleanParty(value: unknown): ShipmentMessageParty | null {
  const v = optionalString(value, 40)
  return v && (MESSAGE_PARTIES as readonly string[]).includes(v) ? (v as ShipmentMessageParty) : null
}

function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  const name = local.split(/[._-]/)[0] ?? ''
  if (!name) return 'BCAT'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function signatureFor(authorKind: 'AGENT' | 'PERSON', authorName: string | null): string {
  if (authorKind === 'PERSON' && authorName) return `— ${authorName}, BCAT Tracking`
  return '— BCAT Tracking Assistant'
}

/** Open the thread idempotently; a second call returns the existing threadKey. */
export async function openShipmentThread(deps: ThreadDeps, shipmentId: string, caller: Caller): Promise<Row> {
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (shipment.threadKey) {
    return { shipment, threadKey: shipment.threadKey, threadOpenedAt: shipment.threadOpenedAt }
  }

  const threadKey = threadKeyFor(shipmentId)
  const now = deps.now()
  const patch = {
    threadKey,
    threadOpenedAt: now,
    updatedAt: now,
    updatedBy: caller.email,
  }
  await deps.transact([
    updateItemTx(deps.tables.shipment, shipmentId, patch, String(shipment.updatedAt ?? '')),
  ])
  return { ...shipment, ...patch }
}

/**
 * Claim, send, record.
 *
 * The row is written with status NOT_SENT before the provider is asked, so a crash
 * after SES or Twilio never loses the message body. VOICE is refused outright because
 * voice is deferred in this build.
 */
export async function sendShipmentMessage(deps: ThreadDeps, input: Row, caller: Caller): Promise<Row> {
  const channel = assertEnum<ShipmentMessageChannel>(input.channel as string, MESSAGE_CHANNELS, 'channel')
  if (channel === 'VOICE') throw new Error('voice is not switched on yet')

  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  const threadKey = String(shipment.threadKey ?? '')
  if (!threadKey) throw new Error('Shipment thread has not been opened')

  const kind = cleanKind(input.kind)
  const now = deps.now()
  const isEmail = channel === 'EMAIL'
  const to = cleanRecipient(input.to)
  const cc = cleanRecipient(input.cc)
  const subject = optionalString(input.subject, 1000)
  const body = optionalString(input.body, 50000)
  const inReplyTo = optionalString(input.inReplyTo, 500)
  const replyParty = cleanParty(input.party) ?? (isEmail ? 'DISPATCHER' : 'DRIVER')
  const authorKind = input.authorKind === 'AGENT' ? 'AGENT' : 'PERSON'
  const authorName =
    typeof input.authorName === 'string' && input.authorName.trim()
      ? input.authorName.trim()
      : authorKind === 'PERSON'
        ? firstNameFromEmail(caller.email)
        : 'BCAT Tracking Assistant'
  const rfcMessageId = isEmail ? newMessageId(shipmentId, Number(input.seq ?? 0)) : null

  // Resolve validated document ids into attachment metadata + bytes.
  const sendAttachmentMeta: { name: string; contentType: string; sizeBytes?: number | null; s3Key?: string | null }[] = []
  const sendAttachmentBytes: EmailAttachment[] = []
  const documentIds = Array.isArray(input.documentIds)
    ? [...new Set(input.documentIds.map((v) => optionalString(v, 100)).filter(Boolean))]
    : []
  if (documentIds.length > 0 && !isEmail) {
    throw new Error('Attachments are e-mail only — switch the channel to E-mail')
  }
  if (documentIds.length > 0) {
    for (const rawId of documentIds) {
      const documentId = String(rawId)
      const doc = await deps.getById(deps.tables.document, documentId)
      if (!doc) throw new Error(`Attachment document not found: ${documentId}`)
      if (String(doc.shipmentId) !== shipmentId) {
        throw new Error(`${String(doc.name)} belongs to another shipment`)
      }
      const audience = String(doc.audience ?? 'ALL')
      if (audience === 'INTERNAL') {
        throw new Error(`${String(doc.name)} is internal only`)
      }
      if (audience === 'CUSTOMER') {
        throw new Error(`${String(doc.name)} is for the customer only`)
      }
      const s3Key = String(doc.s3Key ?? '')
      const attachablePrefixes = ['shipment-docs/', 'driver-docs/', 'rate-confirms/']
      if (!attachablePrefixes.some((p) => s3Key.startsWith(p))) {
        throw new Error(`${String(doc.name)} is not stored where the thread can read it`)
      }
      const name = String(doc.name ?? 'attachment')
      const contentType = String(doc.contentType ?? 'application/octet-stream')
      const sizeBytes = typeof doc.sizeBytes === 'number' ? doc.sizeBytes : null
      sendAttachmentMeta.push({ name, contentType, sizeBytes, s3Key })
      const bytes = await deps.readDocumentBytes(s3Key)
      sendAttachmentBytes.push({ filename: name, contentType, bytes })
    }
  }

  const signedBody = body ? `${body}\n\n${signatureFor(authorKind, authorName)}` : signatureFor(authorKind, authorName)

  const message: Row = {
    id: (input.id as string | undefined) || `msg:${shipmentId}:${deps.randomId()}`,
    __typename: 'ShipmentMessage',
    shipmentId,
    threadKey,
    loadId: optionalString(input.loadId, 100),
    loadCarrierId: optionalString(input.loadCarrierId, 100),
    direction: 'OUT',
    channel,
    kind,
    party: replyParty,
    to,
    from: 'ai4bcat@gmail.com',
    cc,
    subject,
    body: signedBody,
    status: 'NOT_SENT',
    error: null,
    authorKind,
    authorName,
    ...(rfcMessageId ? { messageId: rfcMessageId } : {}),
    inReplyTo: inReplyTo ?? null,
    providerRef: null,
    attachments: sendAttachmentMeta.length > 0 ? sendAttachmentMeta : null,
    documentIds: documentIds.length > 0 ? documentIds : null,
    trackingLinkId: optionalString(input.trackingLinkId, 100),
    workflowRunId: optionalString(input.workflowRunId, 100),
    at: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  await deps.transact([putItem(deps.tables.message, message)])

  let outcome: SendEmailOutcome | SendSmsOutcome
  if (isEmail) {
    if (!to) throw new Error('E-mail requires a recipient')
    if (!subject) throw new Error('E-mail requires a subject')
    if (!body) throw new Error('E-mail requires a body')
    outcome = await deps.sendEmail({
      to,
      cc,
      subject,
      body: signedBody,
      messageId: rfcMessageId as string,
      inReplyTo: inReplyTo ?? null,
      replyTo: threadReplyAddress(shipmentId),
      ...(sendAttachmentBytes.length > 0 ? { attachments: sendAttachmentBytes } : {}),
    })
  } else {
    if (!to) throw new Error('SMS requires a recipient number')
    if (!body) throw new Error('SMS requires a body')
    outcome = await deps.sendSms({ to, body: signedBody, label: (input.label as Row | undefined) ?? {} })
  }

  const status = (OUTBOUND_STATUSES as readonly string[]).includes(outcome.status) ? outcome.status : 'FAILED'
  const patch = {
    status,
    providerRef: outcome.providerRef ?? null,
    error: outcome.error ?? null,
    updatedAt: deps.now(),
  }
  await deps.transact([updateItemTx(deps.tables.message, String(message.id), patch, now)])

  deps.writeAudit('ShipmentMessage', String(message.id), 'SEND_SHIPMENT_MESSAGE', caller, {
    channel,
    kind,
    to,
    status,
  }).catch(() => undefined)

  return { ...message, ...patch }
}

/**
 * Ingest an inbound message from e-mail or SMS.
 *
 * Routes from the plus address first, then from the Message-ID, then from an explicit
 * shipmentId. Deduplicates on messageId and clears the reply clock on every load in
 * the shipment that is waiting for one.
 */
export async function ingestShipmentMessage(deps: ThreadDeps, input: Row, caller: Caller): Promise<Row> {
  const messageId = assertString(input.messageId, 'messageId')
  const to = optionalString(input.to, 500)
  const cc = optionalString(input.cc, 500)

  const fromPlus = shipmentIdFromAddresses([to, cc])
  const fromHeader = shipmentIdFromMessageId(messageId)
  const shipmentId = String(input.shipmentId ?? '') || fromPlus || fromHeader
  if (!shipmentId) {
    return { routed: false, reason: 'Could not route to a shipment from To/Cc or Message-ID' }
  }

  const existing = (
    await deps.queryIndex(deps.tables.message, 'shipmentMessagesByMessageId', 'messageId', messageId)
  )[0]
  if (existing) {
    return { routed: true, message: existing, duplicate: true }
  }

  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) {
    return { routed: false, reason: `Shipment not found: ${shipmentId}` }
  }

  const threadKey = String(shipment.threadKey ?? threadKeyFor(shipmentId))
  const now = deps.now()
  const channel: ShipmentMessageChannel =
    cleanRecipient(input.channel) &&
    (MESSAGE_CHANNELS as readonly string[]).includes(cleanRecipient(input.channel) as string)
      ? (cleanRecipient(input.channel) as ShipmentMessageChannel)
      : 'EMAIL'

  const inbound: Row = {
    id: `msg:${shipmentId}:${deps.randomId()}`,
    __typename: 'ShipmentMessage',
    shipmentId,
    threadKey,
    loadId: optionalString(input.loadId, 100),
    loadCarrierId: optionalString(input.loadCarrierId, 100),
    direction: 'IN',
    channel,
    kind: cleanKind(input.kind ?? 'CHECK_CALL_REPLY'),
    party: cleanParty(input.party) ?? 'DRIVER',
    to: optionalString(input.to, 500),
    from: optionalString(input.from, 500),
    cc: cleanRecipient(input.cc),
    subject: optionalString(input.subject, 1000),
    body: optionalString(input.body, 50000),
    status: 'RECEIVED',
    error: null,
    messageId,
    inReplyTo: optionalString(input.inReplyTo, 500) ?? null,
    providerRef: null,
    attachments: input.attachments ?? null,
    documentIds: null,
    trackingLinkId: null,
    at: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  const loads = await deps.queryIndex(deps.tables.load, 'loadsByShipmentId', 'shipmentId', shipmentId)
  const clearAwaiting: TransactWriteItem[] = []
  for (const load of loads) {
    if (load.checkCallAwaitingSince) {
      clearAwaiting.push(
        updateItemTx(
          deps.tables.load,
          String(load.id),
          {
            updatedAt: now,
            updatedBy: caller.email,
          },
          String(load.updatedAt ?? ''),
          { remove: ['checkCallAwaitingSince'] },
        ),
      )
    }
  }

  const checkCalls: TransactWriteItem[] = []
  const loadPatches: TransactWriteItem[] = []
  const firstLoad = loads[0]
  const body = String(input.body ?? '')
  const geo = body ? await deps.geocode(body) : null

  if (firstLoad) {
    if (geo) {
      checkCalls.push(
        putItem(deps.tables.checkCall, {
          id: `lc:${firstLoad.id}:${deps.randomId()}`,
          __typename: 'LoadCheckCall',
          loadId: firstLoad.id,
          shipmentId,
          at: now,
          type: 'LOCATION_UPDATE',
          source: 'MANUAL',
          city: geo.city,
          state: geo.state,
          lat: geo.lat,
          lng: geo.lng,
          note: body,
          createdBy: 'thread',
          createdAt: now,
          updatedAt: now,
        }),
      )
      loadPatches.push(
        updateItemTx(
          deps.tables.load,
          String(firstLoad.id),
          {
            lastKnownAt: now,
            lastKnownCity: geo.city,
            lastKnownState: geo.state,
            lastKnownLat: geo.lat,
            lastKnownLng: geo.lng,
            // Step P8 — shift the existing fix to the previous slot before overwriting.
            ...(firstLoad.lastKnownAt
              ? {
                  lastKnownPreviousAt: firstLoad.lastKnownAt,
                  lastKnownPreviousCity: firstLoad.lastKnownCity ?? null,
                  lastKnownPreviousState: firstLoad.lastKnownState ?? null,
                  ...(firstLoad.lastKnownLat != null && firstLoad.lastKnownLng != null
                    ? { lastKnownPreviousLat: firstLoad.lastKnownLat, lastKnownPreviousLng: firstLoad.lastKnownLng }
                    : {}),
                }
              : {}),
            lastKnownSource: 'MANUAL',
            updatedAt: now,
            updatedBy: caller.email,
          },
          String(firstLoad.updatedAt ?? ''),
        ),
      )
    } else {
      checkCalls.push(
        putItem(deps.tables.checkCall, {
          id: `lc:${firstLoad.id}:${deps.randomId()}`,
          __typename: 'LoadCheckCall',
          loadId: firstLoad.id,
          shipmentId,
          at: now,
          type: 'NOTE',
          source: 'MANUAL',
          note: body,
          createdBy: 'thread',
          createdAt: now,
          updatedAt: now,
        }),
      )
    }
  }

  await deps.transact([putItem(deps.tables.message, inbound), ...clearAwaiting, ...checkCalls, ...loadPatches])

  return { routed: true, message: inbound }
}

/** List every message on a shipment's thread, oldest first. */
export async function listThread(deps: ThreadDeps, input: Row): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const rows = await deps.queryIndex(
    deps.tables.message,
    'shipmentMessagesByShipmentIdAndAt',
    'shipmentId',
    shipmentId,
  )
  return { messages: rows.sort((a, b) => String(a.at).localeCompare(String(b.at))) }
}
