import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient, PutCommand, ScanCommand,
} from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3     = new S3Client({})

const TABLE_NAME  = process.env.TABLE_NAME!
const BUCKET_NAME = process.env.BUCKET_NAME!
const SECRET      = process.env.INTAKE_WEBHOOK_SECRET!

const LABEL_MAP: Record<string, { source: string; assignedTo: string }> = {
  'ivan-intake': { source: 'IVAN_CARTAGE',   assignedTo: 'dennis@bcatcorp.com' },
  'bcat-intake': { source: 'BCAT_LOGISTICS', assignedTo: 'arcie@bcatcorp.com'  },
}

interface Attachment {
  filename: string
  contentType: string
  base64: string
}

interface WebhookPayload {
  secret: string
  gmailMessageId: string
  label: string
  from: string
  subject: string
  bodyText: string
  bodyHtml: string
  receivedAt: string
  attachments: Attachment[]
}

interface LambdaFunctionUrlEvent {
  requestContext?: { http?: { method?: string } }
  body?: string | null
  headers?: Record<string, string>
}

function respond(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const handler = async (event: LambdaFunctionUrlEvent) => {
  console.log('[intake-webhook] invoked', {
    method: event.requestContext?.http?.method,
    hasBody: !!event.body,
  })

  // ── Parse body ────────────────────────────────────────────────────────────
  let payload: WebhookPayload
  try {
    payload = JSON.parse(event.body ?? '{}') as WebhookPayload
  } catch {
    return respond(400, { error: 'invalid JSON body' })
  }

  // ── Verify secret ─────────────────────────────────────────────────────────
  if (!SECRET || payload.secret !== SECRET) {
    console.warn('[intake-webhook] 401 — bad secret')
    return respond(401, { error: 'unauthorized' })
  }

  const { gmailMessageId, label, from, subject, bodyText, bodyHtml, receivedAt, attachments } = payload

  if (!gmailMessageId || !label) {
    return respond(400, { error: 'gmailMessageId and label are required' })
  }

  const mapping = LABEL_MAP[label]
  if (!mapping) {
    return respond(400, { error: `unknown label: ${label}` })
  }

  console.log('[intake-webhook] processing', { gmailMessageId, label, from, subject })

  // ── Dedup check (scan on gmailMessageId) ──────────────────────────────────
  const existing = await dynamo.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'gmailMessageId = :gid',
    ExpressionAttributeValues: { ':gid': gmailMessageId },
    Limit: 1,
    ProjectionExpression: 'id',
  }))
  if ((existing.Count ?? 0) > 0) {
    console.log('[intake-webhook] duplicate, skipping', gmailMessageId)
    return respond(200, { status: 'duplicate' })
  }

  // ── Upload PDF attachments to S3 ──────────────────────────────────────────
  const s3Keys: string[] = []
  for (const att of (attachments ?? [])) {
    if (att.contentType !== 'application/pdf') continue
    const key = `intake-pdfs/${gmailMessageId}/${att.filename}`
    try {
      const bytes = Buffer.from(att.base64, 'base64')
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: bytes,
        ContentType: 'application/pdf',
      }))
      s3Keys.push(key)
      console.log('[intake-webhook] uploaded PDF', key)
    } catch (err) {
      console.error('[intake-webhook] S3 upload failed for', att.filename, err)
    }
  }

  // ── Create IntakeItem in DynamoDB ─────────────────────────────────────────
  const id  = randomUUID()
  const now = new Date().toISOString()

  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      __typename:          'IntakeItem',
      id,
      source:              mapping.source,
      status:              'NEW',
      assignedTo:          mapping.assignedTo,
      receivedAt:          receivedAt ?? now,
      fromEmail:           from ?? '',
      subject:             subject ?? '',
      bodyText:            bodyText ?? '',
      bodyHtml:            bodyHtml ?? '',
      s3KeyPdfAttachments: s3Keys,
      gmailMessageId,
      extractedMetadata:   null,
      builtLoadId:         null,
      notes:               '',
      createdAt:           now,
      updatedAt:           now,
      _version:            1,
      _deleted:            null,
      _lastChangedAt:      Date.now(),
    },
  }))

  console.log('[intake-webhook] created IntakeItem', id, 'for', mapping.assignedTo)
  return respond(200, { status: 'created', id })
}
