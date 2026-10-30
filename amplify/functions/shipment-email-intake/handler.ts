import { createHash, timingSafeEqual } from 'crypto'
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const dynamo = new DynamoDBClient({})
const lambda = new LambdaClient({})

interface LambdaFunctionUrlEvent {
  body: string | null
  isBase64Encoded?: boolean
  requestContext?: {
    http?: { method?: string }
  }
}

interface Attachment {
  name: string
  contentType: string
  base64: string
}

interface ParsedPayload {
  secret: string
  messageId: string
  to: string | string[]
  cc?: string | string[]
  from: string
  subject: string
  body: string
  attachments?: Attachment[]
  receivedAt?: string
}

type ValidatedPayload =
  | { ok: true; payload: ParsedPayload }
  | { ok: false; status: number; error: string }

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function secretEquals(provided: unknown): boolean {
  const secret = process.env.SHIPMENT_EMAIL_INTAKE_SECRET
  if (typeof provided !== 'string' || !secret) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(secret).digest()
  return a.length === b.length && timingSafeEqual(a, b)
}

function extractAddresses(value: unknown): string[] {
  if (value == null) return []
  const text = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join(', ') : String(value)
  return (text.match(/<([^>]+)>|[^\s,<>]+@[^\s,<>]+/g) ?? [])
    .map((a) => a.replace(/^</, '').replace(/>$/, '').trim().toLowerCase())
}

/** `local+tracking.<shipmentId>@domain` as produced by `threadReplyAddress`. */
function shipmentIdFromPlusAddress(addresses: string[]): string | null {
  const threadMailbox = process.env.THREAD_MAILBOX ?? 'ai4bcat@gmail.com'
  const [mailboxLocal, domain] = threadMailbox.split('@')
  const escapedLocal = mailboxLocal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedDomain = domain.replace(/\./g, '\\.')
  // Matches both plus and dot separators after the mailbox local part.
  const pattern = new RegExp(`^${escapedLocal}[+.](?:tracking[+.])([^@]+)@${escapedDomain}$`)
  for (const addr of addresses) {
    const match = addr.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

/** If the inbound Message-ID matches one of our outbound messages, use its shipment. */
async function shipmentIdFromMessageId(messageId: string): Promise<string | null> {
  const tableName = process.env.SHIPMENT_MESSAGE_TABLE_NAME ?? ''
  if (!tableName || !messageId) return null
  try {
    const out = await dynamo.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'shipmentMessagesByMessageId',
      KeyConditionExpression: '#k = :k',
      ExpressionAttributeNames: { '#k': 'messageId' },
      ExpressionAttributeValues: { ':k': { S: messageId } },
      Limit: 1,
    }))
    const item = out.Items?.[0]
    if (!item) return null
    const row = unmarshall(item)
    return typeof row.shipmentId === 'string' ? row.shipmentId : null
  } catch (err) {
    console.warn('[shipment-email-intake] Message-ID lookup failed', err)
    return null
  }
}

function validatePayload(raw: unknown): ValidatedPayload {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
  const p = raw as Record<string, unknown>

  if (typeof p.secret !== 'string') return { ok: false, status: 401, error: 'unauthorized' }
  if (typeof p.messageId !== 'string' || !p.messageId.trim()) {
    return { ok: false, status: 400, error: 'messageId required' }
  }
  if (!p.to && !p.cc) return { ok: false, status: 400, error: 'to or cc required' }
  if (typeof p.from !== 'string') return { ok: false, status: 400, error: 'from required' }
  if (typeof p.subject !== 'string') return { ok: false, status: 400, error: 'subject required' }
  if (typeof p.body !== 'string') return { ok: false, status: 400, error: 'body required' }

  const attachments: Attachment[] = []
  if (p.attachments != null) {
    if (!Array.isArray(p.attachments)) return { ok: false, status: 400, error: 'attachments must be an array' }
    for (const rawAtt of p.attachments) {
      if (!rawAtt || typeof rawAtt !== 'object') {
        return { ok: false, status: 400, error: 'attachment must be an object' }
      }
      const att = rawAtt as Record<string, unknown>
      if (typeof att.name !== 'string' || !att.name.trim()) {
        return { ok: false, status: 400, error: 'attachment name required' }
      }
      if (typeof att.contentType !== 'string') {
        return { ok: false, status: 400, error: 'attachment contentType required' }
      }
      if (typeof att.base64 !== 'string') {
        return { ok: false, status: 400, error: 'attachment base64 required' }
      }
      attachments.push({ name: att.name.trim(), contentType: att.contentType.trim(), base64: att.base64.trim() })
    }
  }

  return {
    ok: true,
    payload: {
      secret: p.secret,
      messageId: p.messageId.trim(),
      to: (p.to as string | string[]) ?? [],
      cc: p.cc as string | string[] | undefined,
      from: p.from.trim(),
      subject: p.subject.trim(),
      body: p.body,
      attachments,
      receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt : undefined,
    },
  }
}

/**
 * Public intake for per-shipment e-mail replies.
 *
 * Auth: shared webhook secret (INTAKE_WEBHOOK_SECRET). Payload mirrors what the
 * existing Gmail bridge sends to factoring-intake, with attachments as base64.
 *
 * Routing: the To/Cc addresses are scanned for `tracking+<shipmentId>@domain`;
 * if none match, the Message-ID is looked up against outbound ShipmentMessage
 * rows. Failing both means the message cannot be routed and is logged.
 */
export const handler = async (event: LambdaFunctionUrlEvent) => {
  if (event.requestContext?.http?.method && event.requestContext.http.method !== 'POST') {
    return respond(405, { error: 'method not allowed' })
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '')

  let raw: unknown
  try {
    raw = JSON.parse(rawBody || '{}')
  } catch {
    return respond(400, { error: 'invalid JSON body' })
  }

  const validated = validatePayload(raw)
  if (!validated.ok) {
    if (validated.status === 401) console.warn('[shipment-email-intake] bad secret')
    return respond(validated.status, { error: validated.error })
  }

  if (!secretEquals(validated.payload.secret)) {
    console.warn('[shipment-email-intake] bad secret')
    return respond(401, { error: 'unauthorized' })
  }

  const { payload } = validated
  const addresses = [...extractAddresses(payload.to), ...extractAddresses(payload.cc)]
  const fromPlus = shipmentIdFromPlusAddress(addresses)
  const fromHeader = await shipmentIdFromMessageId(payload.messageId)
  const shipmentId = fromPlus || fromHeader

  if (!shipmentId) {
    console.warn('[shipment-email-intake] could not route message', {
      messageId: payload.messageId,
      addresses,
    })
    return respond(422, { error: 'Could not route to a shipment' })
  }

  const invokeInput = {
    action: 'INGEST_SHIPMENT_MESSAGE',
    input: {
      shipmentId,
      messageId: payload.messageId,
      to: addresses.join(', '),
      cc: extractAddresses(payload.cc).join(', '),
      from: payload.from,
      subject: payload.subject,
      body: payload.body,
      attachments: payload.attachments,
      kind: 'CHECK_CALL_REPLY',
      party: 'DRIVER',
    },
  }

  // Dev stacks may not have the invoke grant wired, and SES inbound may not be
  // configured at all. Logging the parsed message here gives a visible proof of
  // what would have been ingested.
  const trackingActionsFunctionName = process.env.TMS_TRACKING_ACTIONS_FUNCTION_NAME ?? ''
  if (!trackingActionsFunctionName) {
    console.log('[shipment-email-intake] TMS_TRACKING_ACTIONS_FUNCTION_NAME unset; parsed inbound message:', {
      ...invokeInput.input,
      attachments: payload.attachments?.map((a) => ({ name: a.name, contentType: a.contentType, sizeBytes: Buffer.from(a.base64, 'base64').length })),
    })
    return respond(200, { ok: true, logged: true, shipmentId })
  }

  try {
    const invoked = await lambda.send(new InvokeCommand({
      FunctionName: trackingActionsFunctionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ arguments: invokeInput, identity: { sub: 'shipment-email-intake', email: 'system@bcatcorp.com' } })),
    }))
    const payloadText = invoked.Payload ? Buffer.from(invoked.Payload).toString('utf-8') : '{}'
    const parsed = JSON.parse(payloadText)
    if (invoked.FunctionError) {
      console.error('[shipment-email-intake] tracking actions returned error', parsed)
      return respond(502, { error: 'tracking actions failed', detail: parsed.errorMessage ?? parsed })
    }
    return respond(200, { ok: true, shipmentId, result: parsed })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[shipment-email-intake] invoke failed', error)
    console.log('[shipment-email-intake] parsed inbound message (fallback log):', {
      ...invokeInput.input,
      attachments: payload.attachments?.map((a) => ({ name: a.name, contentType: a.contentType, sizeBytes: Buffer.from(a.base64, 'base64').length })),
    })
    return respond(502, { error: 'invoke failed', detail: error, logged: true })
  }
}
