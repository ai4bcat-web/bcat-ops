/**
 * Sending a text to a driver, shared by the page's send action and the Slack bridge.
 *
 * Attachments are keys under dispatch-media/ that already exist in S3; they are checked,
 * size-limited and signed for Twilio here. A refused send still leaves a failed row in
 * the thread so the office sees what happened.
 */
import type { DispatchConfig } from './dispatchConfig'
import { DispatchStore, messageRow } from './dispatchStore'
import { TwilioError } from './twilio'
import { MAX_SMS_BODY, MAX_MEDIA_PER_MESSAGE, MAX_MMS_BYTES, type DispatchConversation, type DispatchMedia, type DispatchMessage } from '../../../src/lib/dispatch'

export const MEDIA_PREFIX = 'dispatch-media/'

export interface SendDeps {
  store: DispatchStore
  config: DispatchConfig | null
  send: (config: DispatchConfig, input: { to: string; body?: string; mediaUrls?: string[] }) => Promise<{ sid: string; status: string; errorCode?: string | null; errorMessage?: string | null }>
  presignGet: (key: string, seconds: number) => Promise<string>
  headObject: (key: string) => Promise<{ contentType: string; size: number } | null>
  now: () => Date
}

export interface SendInput {
  conversation: DispatchConversation
  body: string
  mediaKeys: string[]
  sentBy: string
  via: 'app' | 'slack'
  slackTs?: string | null
}

export async function sendDispatchText(deps: SendDeps, input: SendInput): Promise<{ message: DispatchMessage; conversation: DispatchConversation }> {
  const { store, config } = deps
  if (!config) throw new Error('Dispatch is not connected to Twilio yet. Run the setup script first.')
  const body = input.body.trim()
  if (body.length > MAX_SMS_BODY) throw new Error(`Texts are limited to ${MAX_SMS_BODY} characters`)
  const keys = input.mediaKeys
  if (!body && keys.length === 0) throw new Error('Write something or attach a picture')
  if (keys.length > MAX_MEDIA_PER_MESSAGE) throw new Error(`At most ${MAX_MEDIA_PER_MESSAGE} pictures per text`)
  const conversation = input.conversation
  if (conversation.phone === config.dispatchNumber) throw new Error('That is the dispatch number itself')

  const media: DispatchMedia[] = []
  const mediaUrls: string[] = []
  for (const key of keys) {
    if (!key.startsWith(`${MEDIA_PREFIX}out/`) || key.includes('..')) throw new Error('Attachment is not a dispatch upload')
    const head = await deps.headObject(key)
    if (!head) throw new Error('An attachment did not finish uploading. Try again.')
    if (head.size > MAX_MMS_BYTES) throw new Error('Pictures must be under 5 MB to send as MMS')
    media.push({ key, contentType: head.contentType })
    mediaUrls.push(await deps.presignGet(key, 15 * 60))
  }
  const kind = media.length ? 'MMS' : 'SMS'
  const base = { conversationId: conversation.id, phone: conversation.phone, direction: 'OUT' as const, kind: kind as 'SMS' | 'MMS', body: body || null, media: media.length ? media : null, sentBy: input.sentBy }

  let sent: Awaited<ReturnType<SendDeps['send']>>
  try {
    sent = await deps.send(config, { to: conversation.phone, body: body || undefined, mediaUrls: mediaUrls.length ? mediaUrls : undefined })
  } catch (err) {
    const te = err instanceof TwilioError ? err : null
    const failed = await store.putMessage({ ...messageRow({ ...base, at: deps.now().toISOString(), status: 'failed', errorCode: te?.code != null ? String(te.code) : null, errorMessage: te?.message ?? String(err) }), via: input.via, slackTs: input.slackTs ?? null })
    await store.touchConversation(conversation.id, failed, { unread: 'clear' })
    const refused = new Error(`Twilio refused the text: ${te?.message ?? String(err)}`)
    ;(refused as Error & { cause?: unknown }).cause = err
    throw refused
  }
  const message = await store.putMessage({ ...messageRow({ ...base, at: deps.now().toISOString(), twilioSid: sent.sid, status: sent.status || 'queued', errorCode: sent.errorCode ?? null, errorMessage: sent.errorMessage ?? null }), via: input.via, slackTs: input.slackTs ?? null })
  const updated = await store.touchConversation(conversation.id, message, { unread: 'clear' })
  return { message, conversation: updated }
}
