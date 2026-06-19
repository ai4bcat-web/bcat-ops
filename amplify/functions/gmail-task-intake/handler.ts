/**
 * gmail-task-intake Lambda
 *
 * Called by the BCAT Intake Bridge Apps Script when Gmail (ai4bcat@gmail.com) receives
 * an email addressed to the tasks@bcatcorp.com distro (label e.g. 'tasks-intake').
 *
 * Flow:
 *  1. Verify the shared webhook secret (same one the fuel/intake bridge uses).
 *  2. Create an IntakeItem (status NEW, externalSource 'manual'/'gmail') — shows up in
 *     the dashboard Open Tasks + the Tasks page. Deduped by Gmail message id.
 *  3. Post a notification to the #intake-ivan Slack channel.
 *
 * Mirrors slack-intake-webhook (IntakeItem write + conditional-put dedup) and
 * slack-status-notifier (chat.postMessage).
 */
import { createHash } from 'crypto'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'

const dynamo                 = new DynamoDBClient({})
const TABLE_NAME             = process.env.TABLE_NAME!
const SECRET                 = process.env.GMAIL_INTAKE_SECRET!
const SLACK_BOT_TOKEN        = process.env.SLACK_BOT_TOKEN
const INTAKE_IVAN_CHANNEL_ID = process.env.INTAKE_IVAN_CHANNEL_ID

interface LambdaFunctionUrlEvent { body: string | null; isBase64Encoded?: boolean }
interface Payload {
  secret?:     string
  messageId?:  string   // Gmail message id (dedup key)
  subject?:    string
  from?:       string
  body?:       string
  receivedAt?: string   // ISO; optional
}

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function postToIntakeIvan(text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN || !INTAKE_IVAN_CHANNEL_ID) {
    console.warn('[gmail-task-intake] Slack not configured (token/channel) — skipping post')
    return
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body:    JSON.stringify({ channel: INTAKE_IVAN_CHANNEL_ID, text }),
  })
  const json = await res.json() as { ok: boolean; error?: string }
  if (!json.ok) console.error('[gmail-task-intake] chat.postMessage failed', json.error)
}

export const handler = async (event: LambdaFunctionUrlEvent) => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '')

  let payload: Payload
  try { payload = JSON.parse(rawBody || '{}') as Payload } catch { return respond(400, { error: 'invalid JSON body' }) }

  if (!SECRET || payload.secret !== SECRET) {
    console.warn('[gmail-task-intake] 401 — bad secret')
    return respond(401, { error: 'unauthorized' })
  }

  const messageId = (payload.messageId ?? '').trim()
  if (!messageId) return respond(400, { error: 'messageId required' })
  const subject = ((payload.subject ?? '').trim() || '(no subject)').slice(0, 80)

  const externalId = `gmail-task:${messageId}`
  const id  = `gmailtask-${createHash('sha256').update(externalId).digest('hex').slice(0, 20)}`
  const now = new Date().toISOString()
  const receivedAt = payload.receivedAt && !Number.isNaN(Date.parse(payload.receivedAt))
    ? new Date(payload.receivedAt).toISOString()
    : now

  try {
    await dynamo.send(new PutItemCommand({
      TableName:           TABLE_NAME,
      ConditionExpression: 'attribute_not_exists(id)',
      Item: marshall({
        id,
        __typename:          'IntakeItem',
        source:              'IVAN_CARTAGE',
        status:              'NEW',
        receivedAt,
        fromEmail:           payload.from ?? '',
        subject,
        bodyText:            payload.body ?? '',
        bodyHtml:            '',
        externalSource:      'gmail',
        externalId,
        gmailMessageId:      messageId,
        s3KeyPdfAttachments: [],
        createdAt:           now,
        updatedAt:           now,
      }, { removeUndefinedValues: true }),
    }))
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log('[gmail-task-intake] duplicate, skipping', externalId)
      return respond(200, { ok: true, duplicate: true })
    }
    throw err
  }

  // Best-effort Slack post — don't fail the task creation if Slack errors.
  try {
    await postToIntakeIvan(`:inbox_tray: New task from email — *${subject}*${payload.from ? `  (from ${payload.from})` : ''}`)
  } catch (err) {
    console.error('[gmail-task-intake] slack post error', err)
  }

  console.log('[gmail-task-intake] task created', id)
  return respond(200, { ok: true, id })
}
