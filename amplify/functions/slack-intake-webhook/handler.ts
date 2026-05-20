import { createHmac, timingSafeEqual } from 'crypto'
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'

const dynamo          = new DynamoDBClient({})
const TABLE_NAME      = process.env.TABLE_NAME!
const SIGNING_SECRET  = process.env.SLACK_SIGNING_SECRET!

// SLACK_CHANNEL_MAPPING: JSON mapping Slack channel IDs → source enum
// e.g. '{"C12345678":"IVAN_CARTAGE","C87654321":"BCAT_LOGISTICS"}'
// Set this env var in the Amplify Console after deploy.
const CHANNEL_MAP: Record<string, string> = JSON.parse(
  process.env.SLACK_CHANNEL_MAPPING ?? '{}'
)

interface LambdaFunctionUrlEvent {
  headers:          Record<string, string>
  body:             string | null
  isBase64Encoded?: boolean
}

export const handler = async (event: LambdaFunctionUrlEvent) => {
  console.log('[intake] invoked, headers:', JSON.stringify(Object.keys(event.headers)))
  console.log('[intake] CHANNEL_MAP keys:', Object.keys(CHANNEL_MAP))

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '')

  // ── Slack signature verification ───────────────────────────────────────────
  // Header names from Lambda Function URL are lowercased
  const slackTs  = event.headers['x-slack-request-timestamp'] ?? ''
  const slackSig = event.headers['x-slack-signature'] ?? ''

  // Reject stale requests (replay protection, >5 min old)
  if (Math.abs(Date.now() / 1000 - Number(slackTs)) > 300) {
    console.log('[intake] rejected: stale timestamp', slackTs)
    return { statusCode: 403, body: 'Stale request' }
  }

  const baseString = `v0:${slackTs}:${rawBody}`
  const hmac       = createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex')
  const expected   = `v0=${hmac}`

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(slackSig.padEnd(expected.length))
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    console.log('[intake] rejected: invalid signature')
    return { statusCode: 403, body: 'Invalid signature' }
  }

  // ── Parse payload ──────────────────────────────────────────────────────────
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { statusCode: 400, body: 'Bad JSON' }
  }

  // URL challenge (one-time verification when registering the endpoint in Slack)
  if (payload.type === 'url_verification') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: payload.challenge }),
    }
  }

  console.log('[intake] payload type:', payload.type)

  // Only handle event callbacks
  if (payload.type !== 'event_callback') {
    return { statusCode: 200, body: 'ok' }
  }

  const ev = payload.event as Record<string, unknown>

  console.log('[intake] event type:', ev.type, 'subtype:', ev.subtype ?? '(none)', 'bot_id:', ev.bot_id ?? '(none)', 'thread_ts:', ev.thread_ts ?? '(none)')

  // Skip edits, deletes, and other non-content subtypes.
  // file_share is intentionally allowed — that's how PDF pastes arrive.
  const SKIP_SUBTYPES = new Set(['message_changed', 'message_deleted', 'channel_join', 'channel_leave', 'bot_message'])
  if (
    ev.type !== 'message' ||
    ev.bot_id            ||
    SKIP_SUBTYPES.has(ev.subtype as string) ||
    ev.thread_ts         // skip thread replies to avoid reply loops
  ) {
    console.log('[intake] skipped: filtered event')
    return { statusCode: 200, body: 'ok' }
  }

  const channelId = ev.channel   as string
  const msgTs     = ev.ts        as string
  const text      = (ev.text     as string) ?? ''
  const userId    = (ev.user     as string) ?? ''

  console.log('[intake] channel:', channelId, 'mapped to:', CHANNEL_MAP[channelId] ?? '(not mapped)')

  const source = CHANNEL_MAP[channelId]
  if (!source) {
    console.log('[intake] skipped: channel not mapped')
    return { statusCode: 200, body: 'ok' }
  }

  // Dedup key: channelId + message timestamp uniquely identifies a Slack message
  const externalId = `${channelId}:${msgTs}`

  // Check for existing record via GSI before inserting
  const dedup = await dynamo.send(new QueryCommand({
    TableName:                 TABLE_NAME,
    IndexName:                 'externalId-index',
    KeyConditionExpression:    'externalId = :eid',
    ExpressionAttributeValues: marshall({ ':eid': externalId }),
    Limit:                     1,
  }))
  if ((dedup.Items?.length ?? 0) > 0) {
    console.log('[intake] skipped: duplicate', externalId)
    return { statusCode: 200, body: 'Duplicate' }
  }

  // Build subject: prefer message text, fall back to uploaded file names
  const files = (ev.files as Array<{ name?: string }> | undefined) ?? []
  const fileNames = files.map((f) => f.name).filter(Boolean).join(', ')
  const subject = ((text.split('\n').find((l) => l.trim()) ?? fileNames) || '(file attachment)').slice(0, 80)

  // Include file names in body so they're visible in the detail panel
  const bodyText = [text, fileNames ? `Files: ${fileNames}` : ''].filter(Boolean).join('\n')

  // Construct Slack permalink (no extra API call needed)
  const externalUrl = `https://slack.com/archives/${channelId}/p${msgTs.replace('.', '')}`

  const now = new Date().toISOString()
  const id  = `slack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  console.log('[intake] creating item', { id, source, externalId, subject })

  await dynamo.send(new PutItemCommand({
    TableName:           TABLE_NAME,
    ConditionExpression: 'attribute_not_exists(id)',
    Item: marshall({
      id,
      __typename:          'IntakeItem',
      source,
      status:              'NEW',
      assignedTo:          'dennis@bcatcorp.com',
      receivedAt:          new Date(Number(msgTs) * 1000).toISOString(),
      fromEmail:           userId,
      subject,
      bodyText:            bodyText,
      bodyHtml:            '',
      externalSource:      'slack',
      externalId,
      externalUrl,
      slackChannelId:      channelId,
      slackMessageTs:      msgTs,
      s3KeyPdfAttachments: [],
      createdAt:           now,
      updatedAt:           now,
    }, { removeUndefinedValues: true }),
  }))

  console.log('[intake] done, item created:', id)
  return { statusCode: 200, body: 'ok' }
}
