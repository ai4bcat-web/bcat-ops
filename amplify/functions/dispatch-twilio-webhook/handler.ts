/**
 * dispatch-twilio-webhook Lambda — see resource.ts for the route table.
 *
 * Every handler is idempotent on Twilio's own ids (MessageSid, CallSid, RecordingSid)
 * because Twilio retries any webhook that does not answer 2xx quickly, and a retried
 * text must not appear twice in the thread.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { DispatchStore, tablesFromEnv, messageRow } from '../_shared/dispatchStore'
import { loadDispatchConfig, type DispatchConfig } from '../_shared/dispatchConfig'
import {
  parseFormBody, requestUrl, signatureMatches, secretMatches, twiml, EMPTY_TWIML, dialTwiml, whisperTwiml,
  voicemailTwiml, hangupTwiml, fetchTwilioBinary, extensionFor, sendMessage, type FnUrlEvent,
} from '../_shared/twilio'
import { slackClient } from '../_shared/slackApi'
import { mirrorInbound, mirrorDeliveryFailure, mirrorTranscript, slackMirrorEnabled, type SlackBridgeDeps, type MediaFetcher } from '../_shared/slackDispatch'
import { matchDriverByPhone, conversationTitle, callPlan, type DispatchMedia, type DispatchDriver, type DispatchConversation, type DispatchMessage } from '../../../src/lib/dispatch'

const dynamo = new DynamoDBClient({})
const s3 = new S3Client({})
const BUCKET = process.env.BUCKET_NAME ?? ''
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const MEDIA_PREFIX = 'dispatch-media'
const MAX_INBOUND_MEDIA = 10

interface Deps {
  store: DispatchStore
  config: DispatchConfig
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>
  fetchBinary: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>
  /** Absent when no Slack bot token is configured. */
  slack?: (channel: string, text: string) => Promise<void>
  /** The per-driver channel bridge; absent without a bot token. */
  slackBridge?: SlackBridgeDeps['slack']
  readMedia?: MediaFetcher
  sendSms: (to: string, body: string) => Promise<void>
  now: () => Date
}

/** Mirror into the driver's Slack channel when the bridge is on and the channel exists. Never fatal. */
async function toSlack(deps: Deps, conversation: DispatchConversation, fn: (bridge: SlackBridgeDeps) => Promise<unknown>): Promise<void> {
  if (!deps.slackBridge || !conversation.slackChannelId) return
  const settings = await deps.store.getSettings().catch(() => null)
  if (!slackMirrorEnabled(settings)) return
  try {
    await fn({ slack: deps.slackBridge, store: deps.store, settings })
  } catch (err) {
    console.warn('[dispatch-webhook] slack mirror failed', String(err))
  }
}

interface Reply { statusCode: number; headers: Record<string, string>; body: string }

const xml = (body: string, statusCode = 200): Reply => ({ statusCode, headers: { 'Content-Type': 'text/xml' }, body })
const text = (body: string, statusCode = 200): Reply => ({ statusCode, headers: { 'Content-Type': 'text/plain' }, body })

// ── Driver cache ────────────────────────────────────────────────────────────

let driverCache: { at: number; rows: DispatchDriver[] } | null = null
const DRIVER_CACHE_MS = 60_000

async function drivers(store: DispatchStore, now: number): Promise<DispatchDriver[]> {
  if (driverCache && now - driverCache.at < DRIVER_CACHE_MS) return driverCache.rows
  const rows = await store.listDrivers()
  driverCache = { at: now, rows }
  return rows
}

export function resetCaches(): void {
  driverCache = null
}

// ── Routing ─────────────────────────────────────────────────────────────────

export type Route = 'sms' | 'status' | 'voice' | 'voice/whisper' | 'voice/accept' | 'voice/after' | 'voice/recording' | 'voice/transcription'

export function routeOf(rawPath: string | undefined): Route | null {
  const p = (rawPath ?? '/').replace(/^\/+|\/+$/g, '')
  const known: Route[] = ['sms', 'status', 'voice', 'voice/whisper', 'voice/accept', 'voice/after', 'voice/recording', 'voice/transcription']
  return (known as string[]).includes(p) ? (p as Route) : null
}

/** The base this Lambda is reachable at, from the request itself: no config to drift. */
function selfUrl(event: FnUrlEvent, route: Route, secret: string, extra?: Record<string, string>): string {
  const host = event.headers?.host ?? event.headers?.Host ?? event.requestContext?.domainName ?? ''
  const q = new URLSearchParams({ t: secret, ...(extra ?? {}) })
  return `https://${host}/${route}?${q.toString()}`
}

export async function handleEvent(event: FnUrlEvent, deps: Deps): Promise<Reply> {
  const route = routeOf(event.rawPath ?? event.requestContext?.http?.path)
  if (!route) return text('not found', 404)
  if ((event.requestContext?.http?.method ?? 'POST') !== 'POST') return text('method not allowed', 405)

  const { config } = deps
  if (!secretMatches(config.webhookSecret, event.queryStringParameters?.t)) {
    console.warn('[dispatch-webhook] bad secret', { route })
    return text('forbidden', 403)
  }
  const params = parseFormBody(event)
  if (config.authToken) {
    const sig = event.headers?.['x-twilio-signature'] ?? event.headers?.['X-Twilio-Signature']
    if (!signatureMatches(config.authToken, requestUrl(event), params, sig)) {
      console.warn('[dispatch-webhook] bad signature', { route })
      return text('forbidden', 403)
    }
  }
  if (params.AccountSid && params.AccountSid !== config.accountSid) {
    console.warn('[dispatch-webhook] foreign account', { route })
    return text('forbidden', 403)
  }

  switch (route) {
    case 'sms': return inboundSms(params, deps)
    case 'status': return messageStatus(params, deps)
    case 'voice': return inboundCall(event, params, deps)
    case 'voice/whisper': return whisper(event, params, deps)
    case 'voice/accept': return xml(EMPTY_TWIML)
    case 'voice/after': return afterDial(event, params, deps)
    case 'voice/recording': return recordingReady(params, deps)
    case 'voice/transcription': return transcriptionReady(params, deps)
  }
}

// ── Texts ───────────────────────────────────────────────────────────────────

async function inboundSms(p: Record<string, string>, deps: Deps): Promise<Reply> {
  const { store } = deps
  const from = p.From
  const sid = p.MessageSid ?? p.SmsSid
  if (!from || !sid) return text('missing From/MessageSid', 400)
  if (await store.findMessageByTwilioSid(sid)) return xml(EMPTY_TWIML)   // Twilio retry

  const nowMs = deps.now().getTime()
  const roster = await drivers(store, nowMs)
  const { conversation, created } = await store.ensureConversation(from, roster, matchDriverByPhone)

  const media: DispatchMedia[] = []
  const n = Math.min(Number(p.NumMedia ?? 0) || 0, MAX_INBOUND_MEDIA)
  for (let i = 0; i < n; i += 1) {
    const url = p[`MediaUrl${i}`]
    if (!url) continue
    try {
      const got = await deps.fetchBinary(url)
      const contentType = p[`MediaContentType${i}`] || got.contentType
      const key = `${MEDIA_PREFIX}/in/${conversation.id}/${sid}-${i}.${extensionFor(contentType)}`
      await deps.putObject(key, got.bytes, contentType)
      media.push({ key, contentType })
    } catch (err) {
      console.error('[dispatch-webhook] media download failed', { sid, i, err: String(err) })
    }
  }

  const body = (p.Body ?? '').trim()
  const message = await store.putMessage(messageRow({
    conversationId: conversation.id, phone: from, direction: 'IN', kind: media.length ? 'MMS' : 'SMS',
    at: deps.now().toISOString(), body: body || null, media: media.length ? media : null, twilioSid: sid, status: 'received',
  }))
  const updated = await store.touchConversation(conversation.id, message, { unread: 'increment' })
  await toSlack(deps, updated, (b) => mirrorInbound(b, updated, message, deps.readMedia ?? (() => Promise.reject(new Error('no media reader')))))

  const settings = await store.getSettings().catch(() => null)
  if (settings?.slackChannelId && deps.slack) {
    const who = conversationTitle(updated)
    const what = body || (media.length ? `${media.length} photo${media.length > 1 ? 's' : ''}` : '(empty)')
    await deps.slack(settings.slackChannelId, `📱 *${who}* texted dispatch: ${what}`).catch((err) => console.warn('[dispatch-webhook] slack failed', String(err)))
  }
  if (created && settings?.autoReply) {
    await deps.sendSms(from, settings.autoReply).catch((err) => console.warn('[dispatch-webhook] auto-reply failed', String(err)))
  }
  return xml(EMPTY_TWIML)
}

async function messageStatus(p: Record<string, string>, deps: Deps): Promise<Reply> {
  const sid = p.MessageSid ?? p.SmsSid
  const status = p.MessageStatus ?? p.SmsStatus
  if (!sid || !status) return text('missing MessageSid/MessageStatus', 400)
  const msg = await deps.store.findMessageByTwilioSid(sid)
  if (!msg) return text('unknown message', 200)   // 200: nothing to retry
  // Receipts can arrive out of order; never let "sent" overwrite "delivered".
  const rank: Record<string, number> = { queued: 1, accepted: 1, sending: 2, sent: 3, delivered: 4, read: 5, undelivered: 4, failed: 4, canceled: 4 }
  if ((rank[status] ?? 0) < (rank[msg.status ?? ''] ?? 0)) return text('ok')
  const updated = await deps.store.updateMessage(msg.id, {
    status,
    errorCode: p.ErrorCode || null,
    errorMessage: p.ErrorMessage || (p.ErrorCode ? errorHint(p.ErrorCode) : null),
  })
  if (status === 'failed' || status === 'undelivered') {
    const c = await deps.store.getConversation(updated.conversationId)
    if (c) await toSlack(deps, c, (b) => mirrorDeliveryFailure(b, c, updated))
  }
  return text('ok')
}

/** The handful of Twilio error codes dispatchers will actually see, in plain words. */
export function errorHint(code: string): string {
  const hints: Record<string, string> = {
    '30003': 'The phone is off or unreachable.',
    '30004': 'This number has blocked messages from us.',
    '30005': 'This number does not exist or is no longer in service.',
    '30006': 'This is a landline; it cannot receive texts.',
    '30007': 'The carrier filtered the message as spam.',
    '30008': 'Delivery failed for an unknown reason. Try again.',
    '30034': 'The number is not registered for A2P 10DLC yet.',
    '21610': 'This number replied STOP earlier. Ask the driver to text START to the dispatch number.',
  }
  return hints[code] ?? `Twilio error ${code}.`
}

// ── Calls ───────────────────────────────────────────────────────────────────

async function inboundCall(event: FnUrlEvent, p: Record<string, string>, deps: Deps): Promise<Reply> {
  const { store, config } = deps
  const from = p.From
  const callSid = p.CallSid
  if (!from || !callSid) return text('missing From/CallSid', 400)

  const nowMs = deps.now().getTime()
  const roster = await drivers(store, nowMs)
  const { conversation } = await store.ensureConversation(from, roster, matchDriverByPhone)

  if (!(await store.findMessageByTwilioSid(callSid))) {
    const message = await store.putMessage(messageRow({
      conversationId: conversation.id, phone: from, direction: 'IN', kind: 'CALL',
      at: deps.now().toISOString(), twilioSid: callSid, status: 'ringing',
    }))
    await store.touchConversation(conversation.id, message, { unread: 'keep' })
  }

  const plan = callPlan(await store.getSettings().catch(() => null))
  const secret = config.webhookSecret
  if (plan.ring.length === 0) {
    return xml(plan.voicemail ? voicemailTwiml(voicemailPlan(event, plan.greeting, secret)) : hangupTwiml('Nobody is available at dispatch right now. Please text this number instead.'))
  }
  const label = conversationTitle(conversation)
  return xml(twiml(dialTwiml({
    numbers: plan.ring.map((f) => f.phone),
    callerId: config.dispatchNumber,
    timeoutSec: plan.ringSeconds,
    actionUrl: selfUrl(event, 'voice/after', secret),
    whisperUrl: selfUrl(event, 'voice/whisper', secret, { who: label }),
  })))
}

function voicemailPlan(event: FnUrlEvent, greeting: string, secret: string) {
  return {
    greeting,
    recordingCallbackUrl: selfUrl(event, 'voice/recording', secret),
    transcriptionCallbackUrl: selfUrl(event, 'voice/transcription', secret),
  }
}

async function whisper(event: FnUrlEvent, _p: Record<string, string>, deps: Deps): Promise<Reply> {
  const who = event.queryStringParameters?.who || 'a driver'
  return xml(whisperTwiml(who, selfUrl(event, 'voice/accept', deps.config.webhookSecret)))
}

async function afterDial(event: FnUrlEvent, p: Record<string, string>, deps: Deps): Promise<Reply> {
  const { store, config } = deps
  const callSid = p.CallSid
  const outcome = p.DialCallStatus ?? ''
  const msg = callSid ? await store.findMessageByTwilioSid(callSid) : null
  if (outcome === 'completed') {
    if (msg) {
      const updated = await store.updateMessage(msg.id, { status: 'answered', callDurationSec: Number(p.DialCallDuration ?? 0) || 0 })
      const c = await store.touchConversation(msg.conversationId, updated, { unread: 'keep' })
      await toSlack(deps, c, (b) => mirrorInbound(b, c, updated, deps.readMedia ?? (() => Promise.reject(new Error('no media reader')))))
    }
    return xml(hangupTwiml())
  }
  const plan = callPlan(await store.getSettings().catch(() => null))
  if (msg) {
    const updated = await store.updateMessage(msg.id, { status: plan.voicemail ? 'voicemail' : 'missed' })
    // A missed call is work for someone; a call that rolls to voicemail counts when the
    // voicemail lands, so a hang-up before the beep still shows as missed.
    const c = await store.touchConversation(msg.conversationId, { ...updated, status: 'missed' }, { unread: 'increment' })
    await toSlack(deps, c, (b) => mirrorInbound(b, c, { ...updated, status: 'missed' }, deps.readMedia ?? (() => Promise.reject(new Error('no media reader')))))
  }
  if (!plan.voicemail) return xml(hangupTwiml('Nobody could pick up. Please text this number and dispatch will get back to you.'))
  return xml(voicemailTwiml(voicemailPlan(event, plan.greeting, config.webhookSecret)))
}

async function recordingReady(p: Record<string, string>, deps: Deps): Promise<Reply> {
  const { store } = deps
  const recordingSid = p.RecordingSid
  const callSid = p.CallSid
  const url = p.RecordingUrl
  if (!recordingSid || !callSid || !url) return text('missing RecordingSid/CallSid/RecordingUrl', 400)
  if ((p.RecordingStatus ?? 'completed') !== 'completed') return text('ok')
  if (await store.findMessageByTwilioSid(recordingSid)) return text('ok')

  const call = await store.findMessageByTwilioSid(callSid)
  let conversation: DispatchConversation | null = call ? await store.getConversation(call.conversationId) : null
  if (!conversation) {
    const from = p.From ?? p.Caller
    if (!from) return text('no conversation for recording', 200)
    conversation = (await store.ensureConversation(from, await drivers(store, deps.now().getTime()), matchDriverByPhone)).conversation
  }

  let recordingKey: string | null = null
  try {
    const got = await deps.fetchBinary(`${url}.mp3`)
    recordingKey = `${MEDIA_PREFIX}/vm/${conversation.id}/${recordingSid}.mp3`
    await deps.putObject(recordingKey, got.bytes, 'audio/mpeg')
  } catch (err) {
    console.error('[dispatch-webhook] recording download failed', { recordingSid, err: String(err) })
  }
  const message = await store.putMessage(messageRow({
    conversationId: conversation.id, phone: conversation.phone, direction: 'IN', kind: 'VOICEMAIL',
    at: deps.now().toISOString(), twilioSid: recordingSid, status: 'received',
    callDurationSec: Number(p.RecordingDuration ?? 0) || 0, recordingKey,
  }))
  const c = await store.touchConversation(conversation.id, message, { unread: 'increment' })
  await toSlack(deps, c, (b) => mirrorInbound(b, c, message, deps.readMedia ?? (() => Promise.reject(new Error('no media reader')))))
  return text('ok')
}

async function transcriptionReady(p: Record<string, string>, deps: Deps): Promise<Reply> {
  const recordingSid = p.RecordingSid
  if (!recordingSid) return text('missing RecordingSid', 400)
  if (p.TranscriptionStatus && p.TranscriptionStatus !== 'completed') return text('ok')
  const transcript = (p.TranscriptionText ?? '').trim()
  if (!transcript) return text('ok')
  const vm = await deps.store.findMessageByTwilioSid(recordingSid)
  if (!vm) return text('voicemail not stored yet', 200)
  const updated: DispatchMessage = await deps.store.updateMessage(vm.id, { transcript, body: transcript })
  const c = await deps.store.touchConversation(vm.conversationId, updated, { unread: 'keep' })
  await toSlack(deps, c, (b) => mirrorTranscript(b, c, updated))
  return text('ok')
}

// ── Lambda entry ────────────────────────────────────────────────────────────

export const handler = async (event: FnUrlEvent) => {
  const config = await loadDispatchConfig()
  if (!config) {
    console.error('[dispatch-webhook] Twilio is not configured (DISPATCH_PARAM_PATH empty or parameters missing)')
    return text('dispatch not configured', 503)
  }
  const store = new DispatchStore(dynamo, tablesFromEnv())
  const deps: Deps = {
    store,
    config,
    putObject: async (key, bytes, contentType) => {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: contentType }))
    },
    fetchBinary: (url) => fetchTwilioBinary(config, url),
    slack: !SLACK_BOT_TOKEN ? undefined : async (channel, msg) => {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel, text: msg }),
      })
      const json = await res.json() as { ok?: boolean; error?: string }
      if (!json.ok) throw new Error(json.error ?? 'slack error')
    },
    slackBridge: SLACK_BOT_TOKEN ? slackClient(SLACK_BOT_TOKEN) : undefined,
    readMedia: async (key) => {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
      const bytes = await obj.Body!.transformToByteArray()
      return { bytes, contentType: obj.ContentType ?? 'application/octet-stream' }
    },
    sendSms: async (to, body) => {
      await sendMessage(config, { to, from: config.dispatchNumber, body })
    },
    now: () => new Date(),
  }
  try {
    return await handleEvent(event, deps)
  } catch (err) {
    console.error('[dispatch-webhook] failed', { path: event.rawPath, err: String(err) })
    // Voice routes must still answer with TwiML or the caller hears an error tone.
    if ((event.rawPath ?? '').startsWith('/voice')) return xml(hangupTwiml('Dispatch is having trouble right now. Please text this number.'))
    return text('error', 500)
  }
}

