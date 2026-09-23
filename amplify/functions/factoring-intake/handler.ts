/**
 * factoring-intake Lambda
 *
 * Called by the Gmail bridge Apps Script when a message arrives for
 * factor@bcatcorp.com. It extracts the numeric PRO number from the subject
 * ("Invoice for PRO #<number>"), idempotently writes a FactoringItem row with
 * status NEED_TO_FACTOR, and reports the Function URL POST endpoint.
 *
 * Auth: shared webhook secret (INTAKE_WEBHOOK_SECRET), surfaced here as
 * FACTORING_INTAKE_SECRET. The bridge is trusted to only forward factor@
 * messages, but we still validate payload shape and never log the secret.
 */
import { createHash, timingSafeEqual } from 'crypto'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'

const dynamo = new DynamoDBClient({})
const TABLE_NAME = process.env.TABLE_NAME!
const SECRET = process.env.FACTORING_INTAKE_SECRET!

interface LambdaFunctionUrlEvent {
  body: string | null
  isBase64Encoded?: boolean
  requestContext?: {
    http?: { method?: string }
  }
}

type ValidatedPayload =
  | { ok: true; secret: string; messageId: string; subject: string; from: string; receivedAt?: string }
  | { ok: false; status: number; error: string }

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

  return {
    ok: true,
    secret: p.secret,
    messageId: p.messageId.trim(),
    subject: p.subject.trim(),
    from: typeof p.from === 'string' ? p.from.trim() : '',
    receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt.trim() : undefined,
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
 * Extract the numeric PRO number from a subject like "Invoice for PRO #01234".
 *
 * Supports free whitespace, mixed case, and forward prefixes (e.g. "Fwd:").
 * Rejects subjects with no matching phrase, multiple different PRO numbers, or
 * alphanumeric/partial IDs (e.g. "PRO #A01234" / "PRO #01234A").
 */
export function extractProNumber(subject: string): string | null {
  const normalized = subject.replace(/\s+/g, ' ').trim().toUpperCase()

  // Bind the PRO number to an explicit "Invoice for PRO #<token>" phrase.
  // The token immediately after # must be a pure numeric string (leading zeros
  // are preserved). Reject malformed tokens (alphanumeric, dashed, punctuated)
  // and multiple invoice phrases that name different PROs.
  const matches = [
    ...normalized.matchAll(/(?<!\w)INVOICE\s+FOR\s+PRO\s*#\s*(\S*)/gi),
  ]
  if (matches.length === 0) return null

  let first: string | undefined
  for (const m of matches) {
    const token = m[1]
    if (!/^\d+$/.test(token)) return null

    if (first === undefined) {
      first = token
    } else if (token !== first) {
      return null
    }
  }
  return first ?? null
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

  const { messageId, subject, from, receivedAt: rawReceivedAt } = validated

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
  return respond(200, { ok: true, id: proNumber, proNumber, duplicate: false })
}
