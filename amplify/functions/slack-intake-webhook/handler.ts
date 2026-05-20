import { createHmac, createHash, timingSafeEqual } from 'crypto'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
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

  const isEmail = ev.subtype === 'email'

  console.log('[intake] event type:', ev.type, 'subtype:', ev.subtype ?? '(none)', 'bot_id:', ev.bot_id ?? '(none)', 'thread_ts:', ev.thread_ts ?? '(none)', 'isEmail:', isEmail)

  // Full payload logging for email-subtype events — temporary, for CloudWatch diagnosis
  if (isEmail) {
    console.log('[intake] EMAIL full event payload:', JSON.stringify(ev))
  }

  // Skip edits, deletes, and other noise subtypes.
  // email and file_share are intentionally allowed.
  const SKIP_SUBTYPES = new Set(['message_changed', 'message_deleted', 'channel_join', 'channel_leave', 'bot_message', 'thread_broadcast'])
  const isThreadReply = !!(ev.thread_ts && ev.thread_ts !== ev.ts)

  if (
    ev.type !== 'message'                          ||
    SKIP_SUBTYPES.has(ev.subtype as string)        ||
    (!isEmail && ev.bot_id)                        || // allow email-integration bot; skip other bots
    (!isEmail && isThreadReply)                       // allow email thread-parents; skip typed replies
  ) {
    console.log('[intake] skipped: filtered event')
    return { statusCode: 200, body: 'ok' }
  }

  const channelId = ev.channel as string
  const msgTs     = ev.ts      as string
  const text      = (ev.text   as string) ?? ''
  const userId    = (ev.user   as string) ?? ''

  console.log('[intake] channel:', channelId, 'mapped to:', CHANNEL_MAP[channelId] ?? '(not mapped)')

  const source = CHANNEL_MAP[channelId]
  if (!source) {
    console.log('[intake] skipped: channel not mapped')
    return { statusCode: 200, body: 'ok' }
  }

  // Dedup key: channelId + message timestamp uniquely identifies a Slack message
  const externalId = `${channelId}:${msgTs}`

  // Derive a deterministic item ID from externalId so DynamoDB's own
  // attribute_not_exists(id) condition handles dedup atomically — no GSI query needed.
  const id = `slack-${createHash('sha256').update(externalId).digest('hex').slice(0, 20)}`

  // ── Subject + body extraction (email vs typed message) ──────────────────────
  interface SlackFile {
    name?: string
    title?: string
    mimetype?: string
    filetype?: string
    plain_text?: string
    url_private?: string
    permalink?: string
  }

  const files = (ev.files as SlackFile[] | undefined) ?? []
  let subject: string
  let bodyText: string

  if (isEmail) {
    // Email messages: one file is the email itself (filetype 'email' or mimetype containing 'email'),
    // remaining files are attachments (PDFs, etc.).
    // Field names here are best-guess from Slack docs — verify in CloudWatch after first live event.
    const emailFile = files.find(
      (f) => f.filetype === 'email' || (f.mimetype ?? '').includes('email'),
    )
    const attachments = files.filter((f) => f !== emailFile)

    const emailSubject = emailFile?.title
      ?? text.split('\n').find((l) => l.trim())
      ?? ''
    const emailBody = emailFile?.plain_text ?? text

    const attachmentParts = attachments.map((f) => {
      const link = f.permalink ?? f.url_private ?? ''
      return link ? `${f.name ?? 'attachment'} — ${link}` : (f.name ?? 'attachment')
    }).filter(Boolean)

    subject  = (emailSubject || attachmentParts[0] || '(forwarded email)').slice(0, 80)
    bodyText = [emailBody, attachmentParts.length ? `Attachments:\n${attachmentParts.join('\n')}` : '']
      .filter(Boolean).join('\n\n')
  } else {
    // Typed message or file_share
    const fileNames = files.map((f) => f.name).filter(Boolean).join(', ')
    subject  = ((text.split('\n').find((l) => l.trim()) ?? fileNames) || '(file attachment)').slice(0, 80)
    bodyText = [text, fileNames ? `Files: ${fileNames}` : ''].filter(Boolean).join('\n')
  }

  // Construct Slack permalink (no extra API call needed)
  const externalUrl = `https://slack.com/archives/${channelId}/p${msgTs.replace('.', '')}`

  const now = new Date().toISOString()

  console.log('[intake] creating item', { id, source, externalId, subject })

  try {
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
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log('[intake] skipped: duplicate', externalId)
      return { statusCode: 200, body: 'Duplicate' }
    }
    throw err
  }

  console.log('[intake] done, item created:', id)
  return { statusCode: 200, body: 'ok' }
}
