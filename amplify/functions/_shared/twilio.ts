/**
 * Twilio plumbing shared by the dispatch webhook and dispatch-actions Lambdas.
 *
 * Kept free of AWS clients so the signature maths, the TwiML and the request shapes can
 * be unit-tested with nothing mocked. Credentials arrive as a plain object; the SSM read
 * that produces it lives in dispatchConfig.ts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface TwilioCreds {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  /** The account auth token, when the office has stored one; enables signature checks. */
  authToken?: string | null
  messagingServiceSid?: string | null
}

// ── Request parsing ─────────────────────────────────────────────────────────

export interface FnUrlEvent {
  rawPath?: string
  rawQueryString?: string
  body?: string | null
  isBase64Encoded?: boolean
  headers?: Record<string, string | undefined>
  queryStringParameters?: Record<string, string | undefined> | null
  requestContext?: { http?: { method?: string; path?: string }; domainName?: string }
}

/** Twilio posts application/x-www-form-urlencoded. Base64 when it came through a Function URL. */
export function parseFormBody(event: Pick<FnUrlEvent, 'body' | 'isBase64Encoded'>): Record<string, string> {
  if (!event.body) return {}
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v
  return out
}

/** The URL Twilio signed: scheme + host + path + the query string exactly as sent. */
export function requestUrl(event: FnUrlEvent): string {
  const host = event.headers?.host ?? event.headers?.Host ?? event.requestContext?.domainName ?? ''
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '/'
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : ''
  return `https://${host}${path}${qs}`
}

/**
 * Twilio's request signature: HMAC-SHA1 over the URL followed by every POST parameter,
 * sorted by name, as name+value with no separators. Base64, compared in constant time.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('')
  return createHmac('sha1', authToken).update(data).digest('base64')
}

export function signatureMatches(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false
  const expected = Buffer.from(twilioSignature(authToken, url, params))
  const got = Buffer.from(header)
  return expected.length === got.length && timingSafeEqual(expected, got)
}

/** Constant-time equality for the shared secret carried in the webhook URL. */
export function secretMatches(expected: string, got: string | undefined | null): boolean {
  if (!expected || !got) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── TwiML ───────────────────────────────────────────────────────────────────

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function twiml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`
}

export const EMPTY_TWIML = twiml('')

/** The voice Twilio reads prompts in. Polly's Matthew is clear on a truck cab speaker. */
const VOICE = 'Polly.Matthew'

export function sayTwiml(text: string): string {
  return `<Say voice="${VOICE}">${xmlEscape(text)}</Say>`
}

export interface DialPlan {
  /** Phones to ring at once. */
  numbers: string[]
  /** What the called phones see as the caller: the dispatch number, so the office recognises it. */
  callerId: string
  timeoutSec: number
  /** Where Twilio reports the outcome of the dial. */
  actionUrl: string
  /** Played to whoever answers before the bridge — so a cell's own voicemail cannot "accept". */
  whisperUrl: string
}

/** Ring every office phone at once; the first to accept takes the call. */
export function dialTwiml(plan: DialPlan): string {
  const numbers = plan.numbers.map((n) => `<Number url="${xmlEscape(plan.whisperUrl)}">${xmlEscape(n)}</Number>`).join('')
  return `<Dial callerId="${xmlEscape(plan.callerId)}" timeout="${plan.timeoutSec}" action="${xmlEscape(plan.actionUrl)}" method="POST">${numbers}</Dial>`
}

/**
 * Screen on the answering phone. A human presses a key and the call bridges; a carrier
 * voicemail never does, so the leg hangs up and the dial keeps ringing the others.
 */
export function whisperTwiml(callerLabel: string, acceptUrl: string): string {
  return twiml(
    `<Gather numDigits="1" timeout="6" action="${xmlEscape(acceptUrl)}" method="POST">` +
    sayTwiml(`BCAT dispatch call from ${callerLabel}. Press any key to accept.`) +
    `</Gather><Hangup/>`,
  )
}

export interface VoicemailPlan {
  greeting: string
  recordingCallbackUrl: string
  transcriptionCallbackUrl: string
  maxLengthSec?: number
}

/** Take a message. Twilio posts the recording, then the transcript, to the callbacks. */
export function voicemailTwiml(plan: VoicemailPlan): string {
  return twiml(
    sayTwiml(plan.greeting) +
    `<Record maxLength="${plan.maxLengthSec ?? 120}" playBeep="true" timeout="5" finishOnKey="#" ` +
    `recordingStatusCallback="${xmlEscape(plan.recordingCallbackUrl)}" recordingStatusCallbackMethod="POST" ` +
    `transcribe="true" transcribeCallback="${xmlEscape(plan.transcriptionCallbackUrl)}"/>` +
    sayTwiml('Thanks. Dispatch will get back to you.') + '<Hangup/>',
  )
}

export function hangupTwiml(text?: string): string {
  return twiml((text ? sayTwiml(text) : '') + '<Hangup/>')
}

// ── REST calls ──────────────────────────────────────────────────────────────

export function basicAuth(creds: Pick<TwilioCreds, 'apiKeySid' | 'apiKeySecret'>): string {
  return 'Basic ' + Buffer.from(`${creds.apiKeySid}:${creds.apiKeySecret}`).toString('base64')
}

export interface SendMessageInput {
  to: string
  from: string
  body?: string
  mediaUrls?: string[]
  statusCallback?: string
}

export interface SentMessage {
  sid: string
  status: string
  errorCode?: string | null
  errorMessage?: string | null
}

export class TwilioError extends Error {
  constructor(message: string, readonly code?: number | string, readonly httpStatus?: number) {
    super(message)
    this.name = 'TwilioError'
  }
}

/** Shape of the body for Messages.json; exported so the test can pin it without the network. */
export function sendMessageForm(creds: TwilioCreds, input: SendMessageInput): URLSearchParams {
  const form = new URLSearchParams()
  form.set('To', input.to)
  form.set('From', input.from)
  // Sending through the Messaging Service keeps the message under the 10DLC campaign the
  // number is registered to; From pins which number of the service the driver sees.
  if (creds.messagingServiceSid) form.set('MessagingServiceSid', creds.messagingServiceSid)
  if (input.body) form.set('Body', input.body)
  for (const u of input.mediaUrls ?? []) form.append('MediaUrl', u)
  if (input.statusCallback) form.set('StatusCallback', input.statusCallback)
  return form
}

export async function sendMessage(creds: TwilioCreds, input: SendMessageInput, fetchImpl: typeof fetch = fetch): Promise<SentMessage> {
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: basicAuth(creds), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: sendMessageForm(creds, input).toString(),
  })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    throw new TwilioError(String(json.message ?? `Twilio returned ${res.status}`), json.code as number | undefined, res.status)
  }
  return {
    sid: String(json.sid),
    status: String(json.status ?? 'queued'),
    errorCode: json.error_code == null ? null : String(json.error_code),
    errorMessage: json.error_message == null ? null : String(json.error_message),
  }
}

/**
 * Pull bytes Twilio is holding (an MMS picture, a voicemail recording). The first hop
 * needs our credentials; Twilio then redirects to a signed CDN URL, and fetch drops the
 * Authorization header across origins on its own, which is exactly right.
 */
export async function fetchTwilioBinary(creds: TwilioCreds, url: string, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetchImpl(url, { headers: { Authorization: basicAuth(creds) }, redirect: 'follow' })
  if (!res.ok) throw new TwilioError(`Could not download ${url}: ${res.status}`, undefined, res.status)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
}

/** File extension for the content types Twilio hands us. */
export function extensionFor(contentType: string): string {
  const t = contentType.split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/amr': 'amr',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/vcard': 'vcf', 'text/x-vcard': 'vcf',
  }
  return map[t] ?? 'bin'
}
