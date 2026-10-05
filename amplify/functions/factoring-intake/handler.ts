/**
 * factoring-intake Lambda
 *
 * Called by the Gmail bridge Apps Script when a message arrives for
 * ivanfactoring@bcatcorp.com. It extracts the PRO number from the subject
 * ("Invoice for PRO #<number>"), idempotently writes a FactoringItem row with
 * status NEED_TO_FACTOR, and reports the Function URL POST endpoint.
 *
 * Auth: shared webhook secret (INTAKE_WEBHOOK_SECRET), surfaced here as
 * FACTORING_INTAKE_SECRET. Payload shape is validated here and the secret is never logged.
 *
 * The queue is for mail delivered to the ivanfactoring@bcatcorp.com group and nothing else.
 * That used to be the bridge's business alone — this Lambda took whatever it was handed and
 * never saw, let alone recorded, who the message was addressed to. So a row that should not
 * have been there could not even be explained after the fact: there was nothing on it to
 * say where it came from. The recipients now travel with the payload, are checked here, and
 * are stored on the row.
 */
import { createHash, timingSafeEqual } from 'crypto'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { marshall } from '@aws-sdk/util-dynamodb'

const dynamo = new DynamoDBClient({})
const lambda = new LambdaClient({})
const TABLE_NAME = process.env.TABLE_NAME!
const SECRET = process.env.FACTORING_INTAKE_SECRET!
/** Absent in environments where OTR factoring isn't wired; enrichment is skipped. */
const OTR_ACTIONS_FUNCTION_NAME = process.env.OTR_ACTIONS_FUNCTION_NAME

interface LambdaFunctionUrlEvent {
  body: string | null
  isBase64Encoded?: boolean
  requestContext?: {
    http?: { method?: string }
  }
}

/** The one address that may create a factoring row. */
export const FACTORING_RECIPIENT = 'ivanfactoring@bcatcorp.com'

type ValidatedPayload =
  | {
      ok: true
      secret: string
      messageId: string
      subject: string
      from: string
      receivedAt?: string
      /** Every address the message was delivered to, as the bridge saw them. */
      recipients: string[]
    }
  | { ok: false; status: number; error: string }

/** Addresses out of a To/Cc/Delivered-To header, which may carry display names. */
export function extractAddresses(headerValue: string): string[] {
  return (headerValue.match(/<([^>]+)>|[^\s,<>]+@[^\s,<>]+/g) ?? []).map((a) =>
    a.replace(/^</, '').replace(/>$/, '').trim().toLowerCase(),
  )
}

/**
 * Was this message actually addressed to the factoring group?
 *
 * Matches the ADDRESS, not the text. A quoted mention of the group in a forwarded body or
 * a signature is not delivery to it, and the bridge's Gmail query deliberately casts a wide
 * net that includes full-text hits — so this is the check that has to be exact.
 */
export function isForFactoringQueue(recipients: string[]): boolean {
  return recipients.some((r) => r.trim().toLowerCase() === FACTORING_RECIPIENT)
}

/** Runtime boundary check: every field must be a string before .trim() or secrets use. */
function validatePayload(raw: unknown): ValidatedPayload {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
  const p = raw as Record<string, unknown>

  if (typeof p.secret !== 'string') {
    return { ok: false, status: 401, error: 'unauthorized' }
  }
  if (typeof p.messageId !== 'string' || !p.messageId.trim()) {
    return { ok: false, status: 400, error: 'messageId required' }
  }
  if (typeof p.subject !== 'string') {
    return { ok: false, status: 400, error: 'subject required' }
  }
  if (p.from !== undefined && typeof p.from !== 'string') {
    return { ok: false, status: 400, error: 'from must be a string' }
  }
  if (p.receivedAt !== undefined && typeof p.receivedAt !== 'string') {
    return { ok: false, status: 400, error: 'receivedAt must be a string' }
  }

  /*
   * `recipients` may be a string (a raw header) or an array of them, because the bridge
   * sends several headers — To, Cc, Delivered-To, X-Original-To — and any one of them can
   * carry the group.
   */
  const rawRecipients = p.recipients
  const recipientText = Array.isArray(rawRecipients)
    ? rawRecipients.filter((v): v is string => typeof v === 'string')
    : typeof rawRecipients === 'string'
      ? [rawRecipients]
      : []

  return {
    ok: true,
    secret: p.secret,
    messageId: p.messageId.trim(),
    subject: p.subject.trim(),
    from: typeof p.from === 'string' ? p.from.trim() : '',
    receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt.trim() : undefined,
    recipients: recipientText.flatMap(extractAddresses),
  }
}

function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** Constant-time comparison so timing does not leak secret validity. */
function secretEquals(provided: unknown): boolean {
  if (typeof provided !== 'string' || !SECRET) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(SECRET).digest()
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Extract the PRO number from a subject like "Invoice for PRO #01234".
 *
 * Supports free whitespace, mixed case, forward prefixes (e.g. "Fwd:"), an
 * optional "#", trailing punctuation, and alphanumeric PROs (e.g. "945143JJ").
 * Leading zeros are preserved and letters are upper-cased so the same PRO
 * always maps to the same row. Rejects subjects with no matching phrase or
 * with invoice phrases that name different PROs.
 */
export function extractProNumber(subject: string): string | null {
  const normalized = subject.replace(/\s+/g, ' ').trim().toUpperCase()

  // Bind the PRO to an explicit "Invoice for PRO #<id>" phrase; the id is the
  // run of letters/digits/dashes right after it, so ",", "." or " — attached"
  // end it. A dashed id is kept whole rather than truncated to a different row.
  const matches = [
    ...normalized.matchAll(/(?<!\w)INVOICE\s+FOR\s+PRO\s*#?\s*([A-Z0-9-]*[A-Z0-9])/g),
  ]
  if (matches.length === 0) return null

  // A real PRO always carries a digit; without this, "Invoice for PRO number
  // 12345" or "Invoice for PRO from OTR" would file under NUMBER / FROM.
  const first = matches[0][1]
  if (!/\d/.test(first)) return null
  for (const m of matches) {
    if (m[1] !== first) return null
  }
  return first
}

function parseISOOrNow(raw?: string): string {
  if (!raw) return new Date().toISOString()
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString()
}

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
    if (validated.status === 401) {
      console.warn('[factoring-intake] 401 — bad secret')
    }
    return respond(validated.status, { error: validated.error })
  }

  if (!secretEquals(validated.secret)) {
    console.warn('[factoring-intake] 401 — bad secret')
    return respond(401, { error: 'unauthorized' })
  }

  const { messageId, subject, from, receivedAt: rawReceivedAt, recipients } = validated

  /*
   * Only mail delivered to the factoring group creates a row.
   *
   * 422 rather than 400: to the bridge this is the same class of answer as an unusable
   * subject — stop offering me this message — so it gets labelled for review and acked
   * instead of being retried forever.
   *
   * A payload carrying no recipients at all is accepted and loudly logged rather than
   * refused. An older bridge does not send them yet, and silently dropping every invoice
   * the moment this deploys would be a worse failure than the one being fixed. The warning
   * is the signal that scripts/factoringEmailBridge.gs still needs pasting in; once no
   * warnings appear, this branch can become a refusal.
   */
  if (recipients.length === 0) {
    console.warn(
      '[factoring-intake] payload carried no recipients — the Gmail bridge predates the ' +
        'recipient check and cannot be verified; accepting on the bridge\'s own filter',
      { messageId },
    )
  } else if (!isForFactoringQueue(recipients)) {
    console.warn('[factoring-intake] 422 — not addressed to the factoring group', {
      messageId,
      recipients,
    })
    return respond(422, { error: `not addressed to ${FACTORING_RECIPIENT}` })
  }

  if (!subject) {
    return respond(422, { error: 'no invoice PRO number' })
  }

  const proNumber = extractProNumber(subject)
  if (!proNumber) {
    console.warn('[factoring-intake] no usable PRO number', { messageId })
    return respond(422, { error: 'no invoice PRO number' })
  }

  const now = new Date().toISOString()
  const receivedAt = parseISOOrNow(rawReceivedAt)

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        ConditionExpression: 'attribute_not_exists(id)',
        Item: marshall(
          {
            id: proNumber,
            __typename: 'FactoringItem',
            proNumber,
            status: 'NEED_TO_FACTOR',
            subject,
            fromEmail: from,
            // Stored so a row can always explain why it is here. Without it, a row that
            // should not have been in the queue could not be accounted for after the fact.
            toEmails: recipients.length ? recipients : undefined,
            receivedAt,
            messageId,
            createdAt: now,
            updatedAt: now,
          },
          { removeUndefinedValues: true },
        ),
      }),
    )
  } catch (err: unknown) {
    const errName = typeof err === 'object' && err !== null ? Reflect.get(err, 'name') : undefined
    if (errName === 'ConditionalCheckFailedException') {
      console.log('[factoring-intake] duplicate PRO, skipping', { proNumber, messageId })
      return respond(200, { ok: true, id: proNumber, proNumber, duplicate: true })
    }
    console.error('[factoring-intake] DynamoDB put failed', { proNumber, messageId })
    throw err
  }

  console.log('[factoring-intake] row created', { proNumber, messageId })

  // Enrich for OTR: resolve the PRO to its Load, pull everything derivable, and
  // attach the POD and rate confirmation already on that load. Fire-and-forget
  // (InvocationType 'Event') and deliberately non-fatal — the email must never be
  // lost because enrichment failed. An unenriched row shows as such in the queue
  // and can be refreshed from there.
  if (OTR_ACTIONS_FUNCTION_NAME) {
    try {
      await lambda.send(
        new InvokeCommand({
          FunctionName: OTR_ACTIONS_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: Buffer.from(
            JSON.stringify({
              arguments: { action: 'assemble', input: JSON.stringify({ id: proNumber }) },
            }),
          ),
        }),
      )
    } catch (err) {
      console.error('[factoring-intake] enrichment invoke failed (row still created)', {
        proNumber,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return respond(200, { ok: true, id: proNumber, proNumber, duplicate: false })
}
