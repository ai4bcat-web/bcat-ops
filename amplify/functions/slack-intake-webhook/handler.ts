import { createHmac, createHash, timingSafeEqual } from 'crypto'
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
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

const s3 = new S3Client({})
const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
// Dispatch: a message in a driver's #drv-… channel is a text to that driver. The channel
// id is looked up on the conversation table and the event handed to dispatch-slack-bridge.
const DISPATCH_CONVERSATION_TABLE_NAME = process.env.DISPATCH_CONVERSATION_TABLE_NAME ?? ''
const DISPATCH_SLACK_BRIDGE_FUNCTION_NAME = process.env.DISPATCH_SLACK_BRIDGE_FUNCTION_NAME ?? ''
const lambda = new LambdaClient({})

async function isDispatchChannel(channelId: string): Promise<boolean> {
  if (!DISPATCH_CONVERSATION_TABLE_NAME || !channelId) return false
  try {
    const r = await dynamo.send(new QueryCommand({
      TableName: DISPATCH_CONVERSATION_TABLE_NAME,
      IndexName: 'dispatchConversationsBySlackChannelId',
      KeyConditionExpression: '#c = :c',
      ExpressionAttributeNames: { '#c': 'slackChannelId' },
      ExpressionAttributeValues: { ':c': { S: channelId } },
      Limit: 1,
    }))
    return (r.Count ?? 0) > 0
  } catch (err) {
    console.warn('[intake] dispatch channel lookup failed', String(err))
    return false
  }
}

/** Documents worth keeping. A tender's rate confirmation is a PDF; screenshots are images. */
const KEEPABLE = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i

/** Nobody forwards a hundred-megabyte rate con, and a Lambda should not try to hold one. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** More than this on one message is a thread of screenshots, not a tender. */
const MAX_ATTACHMENTS = 5

/**
 * Save the documents attached to a Slack message, and return their S3 keys.
 *
 * This is the step that was missing: the webhook already saw these files and wrote their
 * NAMES into the body text, but stored `s3KeyPdfAttachments: []` regardless — so a rate
 * confirmation forwarded into Slack never reached BCAT Ops, and 1 of 1,395 intake items
 * had an attachment. Building a load then had nothing to attach and nothing to read a lane
 * from, which is the whole reason those fields were typed by hand.
 *
 * `url_private` is not public: it is fetched with the bot's own token, which is why this
 * needs SLACK_BOT_TOKEN rather than just the signing secret.
 *
 * Every failure is swallowed. The item is worth creating whether or not its attachment
 * came down — losing the tender because a file download timed out would be a far worse
 * outcome than an attachment somebody re-uploads.
 */
async function saveSlackAttachments(
  files: Array<{ name?: string; mimetype?: string; filetype?: string; url_private?: string }>,
  itemId: string,
): Promise<string[]> {
  if (!BUCKET_NAME || !SLACK_BOT_TOKEN) {
    if (files.length) console.warn('[intake] attachments skipped: bucket or bot token not configured')
    return []
  }

  const keep = files
    .filter((f) => !!f.url_private && KEEPABLE.test(f.mimetype ?? ''))
    .slice(0, MAX_ATTACHMENTS)
  if (keep.length === 0) return []

  const keys: string[] = []
  for (const [i, file] of keep.entries()) {
    try {
      const res = await fetch(file.url_private!, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      })
      if (!res.ok) {
        console.error('[intake] attachment download failed', { status: res.status, name: file.name })
        continue
      }
      const body = new Uint8Array(await res.arrayBuffer())
      if (body.byteLength === 0 || body.byteLength > MAX_ATTACHMENT_BYTES) {
        console.warn('[intake] attachment skipped on size', { name: file.name, bytes: body.byteLength })
        continue
      }
      /*
       * A Slack URL answers 200 with an HTML sign-in page when the token cannot read the
       * file, so a bad token would otherwise store login pages as rate confirmations. A PDF
       * starts with %PDF; anything claiming to be one and starting with '<' is that page.
       */
      const looksHtml = body[0] === 0x3c
      if (looksHtml) {
        console.error('[intake] attachment came back as HTML — check the bot token scope', { name: file.name })
        continue
      }

      const safeName = (file.name ?? `attachment-${i + 1}`).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
      const key = `intake-attachments/${itemId}/${i + 1}-${safeName}`
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: file.mimetype || 'application/octet-stream',
      }))
      keys.push(key)
    } catch (err) {
      console.error('[intake] attachment failed', {
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return keys
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

  // Slack email integration posts via bot with subtype 'email' or 'file_share'.
  // Human file_shares don't have bot_id, so bot_id+file_share == email forward.
  const isEmail = ev.subtype === 'email' || (ev.subtype === 'file_share' && !!ev.bot_id)

  console.log('[intake] event type:', ev.type, 'subtype:', ev.subtype ?? '(none)', 'bot_id:', ev.bot_id ?? '(none)', 'thread_ts:', ev.thread_ts ?? '(none)', 'isEmail:', isEmail)

  // Full payload logging for email events — temporary, for CloudWatch field verification
  if (isEmail) {
    console.log('[intake] EMAIL full event payload:', JSON.stringify(ev))
  }

  // A driver's dispatch channel: hand the whole event to the bridge and stop here. This
  // runs before the thread-reply filter on purpose: a reply typed under a message in a
  // driver channel is still a text to the driver. The bridge drops bots and edits itself.
  if (ev.type === 'message' && !ev.bot_id && DISPATCH_SLACK_BRIDGE_FUNCTION_NAME && await isDispatchChannel(ev.channel as string)) {
    try {
      await lambda.send(new InvokeCommand({ FunctionName: DISPATCH_SLACK_BRIDGE_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ event: ev })) }))
      console.log('[intake] dispatch channel → bridge', ev.channel)
    } catch (err) {
      console.error('[intake] bridge invoke failed', String(err))
    }
    return { statusCode: 200, body: 'ok' }
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

  // Before the write, so the item carries its documents from the moment it exists.
  const attachmentKeys = await saveSlackAttachments(files, id)

  console.log('[intake] creating item', { id, source, externalId, subject, attachments: attachmentKeys.length })

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
        s3KeyPdfAttachments: attachmentKeys,
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
