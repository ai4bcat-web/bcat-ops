/**
 * Writing and sending shipment notices, shared by `tms-tracking-actions` (the
 * operator pressing Send) and `shipment-notifier` (the Load stream noticing a
 * milestone).
 *
 * The order is deliberate and is the whole point of the module: the row is written
 * **before** the send, with a conditional Put on a deterministic id where one
 * exists. A stream retry, a second leg delivering, or two operators pressing Send
 * at the same moment therefore collide on DynamoDB rather than in somebody's inbox.
 * Only after the row exists does SES get a chance, and whatever it says — sent,
 * refused, exploded — is patched back onto the row. On a stack where SES is denied
 * the row and its rendered body are the deliverable: an operator copies the text
 * out, and nothing anywhere claims a message was delivered.
 */
import {
  ConditionalCheckFailedException,
  PutItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { marshall } from '@aws-sdk/util-dynamodb'

import type { Row } from './shipmentStore'
import { marshallRow, nowIso } from './shipmentStore'
import type {
  ShipmentNoticeChannel,
  ShipmentNoticeKind,
  ShipmentNoticeRecord,
  ShipmentNoticeStatus,
} from '../../../src/types/tms'

/** Split a base64 blob into 76-char MIME lines (RFC 2045). */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

export interface EmailAttachment {
  filename: string
  contentType: string
  bytes: Uint8Array
}

export interface SendEmailArgs {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  attachments?: EmailAttachment[]
}

/**
 * Raw MIME, the same way pay statements and rate confirmations go out: base64 so a
 * note with an em dash in it survives the wire, multipart only when something is
 * actually attached.
 */
export async function sendNoticeEmail(ses: SESv2Client, args: SendEmailArgs): Promise<string | null> {
  const cc = args.cc ?? []
  const attachments = args.attachments ?? []
  const subject = args.subject.replace(/[\r\n]+/g, ' ').trim()
  const bodyB64 = wrap76(Buffer.from(args.body, 'utf8').toString('base64'))

  let raw =
    `From: ${args.from}\r\n` +
    `To: ${args.to.join(', ')}\r\n` +
    (cc.length > 0 ? `Cc: ${cc.join(', ')}\r\n` : '') +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n`

  if (attachments.length === 0) {
    raw +=
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      `${bodyB64}\r\n`
  } else {
    const boundary = `bcat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    raw +=
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      `${bodyB64}\r\n`
    for (const file of attachments) {
      const safe = file.filename.replace(/["\\\r\n]/g, '_')
      raw +=
        `--${boundary}\r\n` +
        `Content-Type: ${file.contentType}; name="${safe}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `Content-Disposition: attachment; filename="${safe}"\r\n` +
        `\r\n` +
        `${wrap76(Buffer.from(file.bytes).toString('base64'))}\r\n`
    }
    raw += `--${boundary}--\r\n`
  }

  const out = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: args.from,
      Destination: { ToAddresses: args.to, CcAddresses: cc.length > 0 ? cc : undefined },
      Content: { Raw: { Data: new TextEncoder().encode(raw) } },
    }),
  )
  return out.MessageId ?? null
}

export interface NoticeDraft {
  id: string
  shipmentId: string
  loadId?: string | null
  loadCarrierId?: string | null
  kind: ShipmentNoticeKind
  milestone?: string | null
  channel: ShipmentNoticeChannel
  to: string[]
  cc?: string[]
  subject: string
  body: string
  attachments?: { documentId: string; name: string; sizeBytes: number }[]
  trackingLinkId?: string | null
  createdBy: string
}

export interface ClaimedNotice {
  row: Row
  /** False when a row with this id already existed — somebody else already sent it. */
  claimed: boolean
}

/**
 * Reserve the notice. A deterministic id (`ms:…`, `pod:…`) plus
 * `attribute_not_exists(id)` is what makes "send this milestone once" true across
 * stream retries and across the second leg of a two-leg shipment.
 */
export async function claimNotice(
  db: DynamoDBClient,
  tableName: string,
  draft: NoticeDraft,
): Promise<ClaimedNotice> {
  const now = nowIso()
  const row: Row = {
    id: draft.id,
    __typename: 'ShipmentNotice',
    shipmentId: draft.shipmentId,
    loadId: draft.loadId ?? null,
    loadCarrierId: draft.loadCarrierId ?? null,
    kind: draft.kind,
    milestone: draft.milestone ?? null,
    channel: draft.channel,
    to: draft.to.join(', '),
    cc: draft.cc && draft.cc.length > 0 ? draft.cc.join(', ') : null,
    subject: draft.subject,
    body: draft.body,
    attachments: draft.attachments ?? null,
    // Nothing has been attempted yet. COPY rows never go further than this.
    status: draft.channel === 'COPY' ? 'COPY' : ('NOT_SENT' satisfies ShipmentNoticeStatus),
    error: null,
    messageId: null,
    sentAt: null,
    trackingLinkId: draft.trackingLinkId ?? null,
    at: now,
    createdBy: draft.createdBy,
    createdAt: now,
    updatedAt: now,
  }

  try {
    await db.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshallRow(row),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    return { row, claimed: true }
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return { row, claimed: false }
    throw err
  }
}

/** Record what SES actually did. Called immediately after the attempt, always. */
export async function recordNoticeOutcome(
  db: DynamoDBClient,
  tableName: string,
  noticeId: string,
  outcome: { status: ShipmentNoticeStatus; error?: string | null; messageId?: string | null },
): Promise<Row> {
  const now = nowIso()
  const sentAt = outcome.status === 'SENT' ? now : null
  await db.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ id: noticeId }),
      UpdateExpression:
        'SET #status = :status, #error = :error, messageId = :messageId, sentAt = :sentAt, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: marshall(
        {
          ':status': outcome.status,
          ':error': outcome.error ?? null,
          ':messageId': outcome.messageId ?? null,
          ':sentAt': sentAt,
          ':updatedAt': now,
        },
        { removeUndefinedValues: true },
      ),
    }),
  )
  return { id: noticeId, status: outcome.status, error: outcome.error ?? null, sentAt, updatedAt: now }
}

export interface DeliverNoticeArgs {
  db: DynamoDBClient
  ses: SESv2Client
  tableName: string
  draft: NoticeDraft
  from: string
  attachments?: EmailAttachment[]
}

export interface DeliveredNotice {
  notice: ShipmentNoticeRecord
  claimed: boolean
  status: ShipmentNoticeStatus
  error: string | null
}

/**
 * Claim, send, record. A COPY notice stops after the claim — there is a body to
 * copy and nothing to send. An EMAIL notice that SES refuses stays NOT_SENT with
 * the reason on the row; this never throws, because a milestone that could not be
 * e-mailed is not a reason to fail the thing that caused it.
 */
export async function deliverNotice(args: DeliverNoticeArgs): Promise<DeliveredNotice> {
  const { row, claimed } = await claimNotice(args.db, args.tableName, args.draft)
  const notice = row as unknown as ShipmentNoticeRecord

  if (!claimed) {
    return { notice, claimed: false, status: 'NOT_SENT', error: null }
  }
  if (args.draft.channel === 'COPY') {
    return { notice, claimed: true, status: 'COPY', error: null }
  }
  if (args.draft.to.length === 0) {
    const error = 'No recipient'
    await recordNoticeOutcome(args.db, args.tableName, args.draft.id, { status: 'NOT_SENT', error })
    return { notice: { ...notice, status: 'NOT_SENT', error }, claimed: true, status: 'NOT_SENT', error }
  }

  try {
    const messageId = await sendNoticeEmail(args.ses, {
      from: args.from,
      to: args.draft.to,
      cc: args.draft.cc,
      subject: args.draft.subject,
      body: args.draft.body,
      attachments: args.attachments,
    })
    await recordNoticeOutcome(args.db, args.tableName, args.draft.id, { status: 'SENT', messageId })
    return {
      notice: { ...notice, status: 'SENT', messageId, sentAt: nowIso() },
      claimed: true,
      status: 'SENT',
      error: null,
    }
  } catch (err) {
    // SES is denied on the dev stack. The notice is real and its body is on the
    // row, so this is reported, not thrown.
    const error = err instanceof Error ? err.message : String(err)
    console.error('[shipmentNotices] send failed', args.draft.id, error)
    await recordNoticeOutcome(args.db, args.tableName, args.draft.id, { status: 'NOT_SENT', error })
    return { notice: { ...notice, status: 'NOT_SENT', error }, claimed: true, status: 'NOT_SENT', error }
  }
}

export { SESv2Client }
