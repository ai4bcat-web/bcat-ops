/**
 * amazon-dispute-intake Lambda
 *
 * Called by the "BCAT Amazon Disputes" Apps Script bound to the Google Form's linked
 * Sheet. On each new form submission the script POSTs the row here as JSON (with the
 * shared webhook secret). We write an AmazonDispute record (status PENDING, source
 * GOOGLE_FORM) straight to DynamoDB — it then shows up on the /disputes page through the
 * normal AppSync read path.
 *
 * Mirrors gmail-task-intake / slack-intake-webhook: shared-secret auth, conditional-put
 * dedup on a deterministic id derived from the submission's externalId.
 *
 * See ./APPS_SCRIPT.md for the Google Apps Script and setup steps.
 */
import { createHash } from 'crypto'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'

const dynamo     = new DynamoDBClient({})
const TABLE_NAME = process.env.TABLE_NAME!
const SECRET     = process.env.DISPUTE_INTAKE_SECRET!

interface LambdaFunctionUrlEvent { body: string | null; isBase64Encoded?: boolean }

interface Payload {
  secret?:          string
  // A stable per-submission key (the Sheet row's timestamp is a good default). If the
  // script omits it we derive one from the content so re-posts still dedup.
  submissionId?:    string
  timestamp?:       string   // form Timestamp (ISO or sheet-formatted); optional
  driverName?:      string
  tripNumber?:      string
  shipmentDate?:    string
  payPeriod?:       string
  amountPaid?:      number | string
  amountRequested?: number | string
  description?:     string
  photoUrl?:        string
}

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

// Parse a currency-ish string ("$1,282.66", "27$", "175") to a number, or undefined.
function parseAmount(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

export const handler = async (event: LambdaFunctionUrlEvent) => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '')

  let payload: Payload
  try { payload = JSON.parse(rawBody || '{}') as Payload } catch { return respond(400, { error: 'invalid JSON body' }) }

  if (!SECRET || payload.secret !== SECRET) {
    console.warn('[amazon-dispute-intake] 401 — bad secret')
    return respond(401, { error: 'unauthorized' })
  }

  const driverName = (payload.driverName ?? '').trim()
  if (!driverName) return respond(400, { error: 'driverName required' })

  // Dedup key: an explicit submissionId if provided, else a hash of the distinguishing
  // fields so a duplicate POST of the same submission is recognised.
  const dedupSource = (payload.submissionId ?? '').trim() ||
    [payload.timestamp, driverName, payload.tripNumber, payload.shipmentDate].map((v) => v ?? '').join('|')
  const externalId = `dispute:${dedupSource}`
  const id  = `dispute-${createHash('sha256').update(externalId).digest('hex').slice(0, 20)}`

  const now = new Date().toISOString()
  const submittedAt = payload.timestamp && !Number.isNaN(Date.parse(payload.timestamp))
    ? new Date(payload.timestamp).toISOString()
    : now

  try {
    await dynamo.send(new PutItemCommand({
      TableName:           TABLE_NAME,
      ConditionExpression: 'attribute_not_exists(id)',
      Item: marshall({
        id,
        __typename:      'AmazonDispute',
        driverName,
        tripNumber:      (payload.tripNumber ?? '').trim() || undefined,
        shipmentDate:    (payload.shipmentDate ?? '').trim() || undefined,
        payPeriod:       (payload.payPeriod ?? '').trim() || undefined,
        amountPaid:      parseAmount(payload.amountPaid),
        amountRequested: parseAmount(payload.amountRequested),
        description:     (payload.description ?? '').trim() || undefined,
        photoUrl:        (payload.photoUrl ?? '').trim() || undefined,
        status:          'PENDING',
        source:          'GOOGLE_FORM',
        submittedAt,
        externalId,
        createdAt:       now,
        updatedAt:       now,
      }, { removeUndefinedValues: true }),
    }))
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log('[amazon-dispute-intake] duplicate, skipping', externalId)
      return respond(200, { ok: true, duplicate: true })
    }
    throw err
  }

  console.log('[amazon-dispute-intake] dispute created', id, 'for', driverName)
  return respond(200, { ok: true, id })
}
