/**
 * dispatch-slack-bridge Lambda — see resource.ts.
 *
 * Payload: `{ event: <Slack message event> }`, exactly what slack-intake-webhook received.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { DispatchStore, tablesFromEnv, messageRow } from '../_shared/dispatchStore'
import { loadDispatchConfig } from '../_shared/dispatchConfig'
import { sendMessage, extensionFor } from '../_shared/twilio'
import { sendDispatchText, MEDIA_PREFIX, type SendDeps } from '../_shared/dispatchSend'
import { slackClient, type SlackClient } from '../_shared/slackApi'
import { classifySlackEvent, type SlackMessageEvent, type SlackFile } from '../_shared/slackDispatch'
import { MAX_MEDIA_PER_MESSAGE } from '../../../src/lib/dispatch'

const dynamo = new DynamoDBClient({})
const s3 = new S3Client({})
const BUCKET = process.env.BUCKET_NAME ?? ''
const WEBHOOK_URL = (process.env.WEBHOOK_URL ?? '').replace(/\/+$/, '')
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''

export interface BridgeDeps extends SendDeps {
  slack: SlackClient
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>
}

/** Who typed it, for the thread's "sent by". Falls back to the Slack user id. */
async function slackUserEmail(slack: SlackClient, userId: string): Promise<{ email: string; name: string }> {
  try {
    const r = await slack.call<{ user: { profile?: { email?: string; real_name?: string; display_name?: string }; real_name?: string; name?: string } }>('users.info', { user: userId })
    const email = (r.user.profile?.email ?? '').toLowerCase().trim()
    const name = r.user.profile?.display_name || r.user.profile?.real_name || r.user.real_name || r.user.name || userId
    return { email: email || `slack:${userId}`, name }
  } catch {
    return { email: `slack:${userId}`, name: userId }
  }
}

export async function handleSlackEvent(ev: SlackMessageEvent, deps: BridgeDeps): Promise<{ outcome: string }> {
  const intent = classifySlackEvent(ev)
  if (intent.kind === 'skip') return { outcome: `skipped: ${intent.reason}` }
  const conversation = await deps.store.findConversationBySlackChannel(intent.channel)
  if (!conversation) return { outcome: 'skipped: not a dispatch channel' }
  if (await deps.store.findMessageBySlackTs(intent.ts)) return { outcome: 'skipped: already handled' }   // Slack retried the event

  const who = await slackUserEmail(deps.slack, intent.user)

  if (intent.kind === 'note') {
    const message = await deps.store.putMessage({ ...messageRow({ conversationId: conversation.id, phone: conversation.phone, direction: 'OUT', kind: 'NOTE', at: deps.now().toISOString(), body: intent.body, sentBy: who.email, status: 'saved' }), via: 'slack', slackTs: intent.ts })
    await deps.store.touchConversation(conversation.id, message, { unread: 'keep' })
    return { outcome: 'note saved' }
  }

  // Pictures typed into Slack: pull them with the bot token, stage them like a page upload.
  const mediaKeys: string[] = []
  const skipped: string[] = []
  for (const f of intent.files.slice(0, MAX_MEDIA_PER_MESSAGE)) {
    try {
      mediaKeys.push(await stageSlackFile(deps, f))
    } catch (err) {
      skipped.push(f.name ?? 'file')
      console.warn('[slack-bridge] file skipped', f.name, String(err))
    }
  }
  if (intent.files.length > MAX_MEDIA_PER_MESSAGE) skipped.push(`${intent.files.length - MAX_MEDIA_PER_MESSAGE} more (limit ${MAX_MEDIA_PER_MESSAGE} per text)`)

  try {
    if (!intent.body && mediaKeys.length === 0) throw new Error('Nothing to send: the attachment could not be read')
    await sendDispatchText(deps, { conversation, body: intent.body, mediaKeys, sentBy: who.email, via: 'slack', slackTs: intent.ts })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await deps.slack.call('chat.postMessage', { channel: intent.channel, thread_ts: intent.ts, text: `⚠️ Not sent to the driver: ${why}` }).catch(() => undefined)
    return { outcome: `failed: ${why}` }
  }
  if (skipped.length) {
    await deps.slack.call('chat.postMessage', { channel: intent.channel, thread_ts: intent.ts, text: `⚠️ Sent without: ${skipped.join(', ')}` }).catch(() => undefined)
  }
  return { outcome: 'sent' }
}

async function stageSlackFile(deps: BridgeDeps, f: SlackFile): Promise<string> {
  const got = await deps.slack.download(f.url_private!)
  const contentType = f.mimetype || got.contentType
  const key = `${MEDIA_PREFIX}out/slack-${f.id ?? Date.now()}.${extensionFor(contentType)}`
  await deps.putObject(key, got.bytes, contentType)
  return key
}

export const handler = async (payload: { event?: SlackMessageEvent }) => {
  if (!payload?.event) return { outcome: 'no event' }
  if (!SLACK_BOT_TOKEN) return { outcome: 'no slack token' }
  const config = await loadDispatchConfig()
  const deps: BridgeDeps = {
    store: new DispatchStore(dynamo, tablesFromEnv()),
    config,
    slack: slackClient(SLACK_BOT_TOKEN),
    send: (cfg, i) => sendMessage(cfg, { to: i.to, from: cfg.dispatchNumber, body: i.body, mediaUrls: i.mediaUrls, statusCallback: WEBHOOK_URL ? `${WEBHOOK_URL}/status?t=${encodeURIComponent(cfg.webhookSecret)}` : undefined }),
    presignGet: (key, seconds) => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: seconds }),
    headObject: async (key) => {
      try {
        const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
        return { contentType: h.ContentType ?? 'application/octet-stream', size: h.ContentLength ?? 0 }
      } catch {
        return null
      }
    },
    putObject: async (key, bytes, contentType) => { await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: contentType })) },
    now: () => new Date(),
  }
  const result = await handleSlackEvent(payload.event, deps)
  console.log('[slack-bridge]', result.outcome)
  return result
}
