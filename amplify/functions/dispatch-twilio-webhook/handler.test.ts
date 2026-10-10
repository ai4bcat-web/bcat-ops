import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FakeDispatchStore } from '../_shared/dispatchFakeStore'
import { twilioSignature } from '../_shared/twilio'
import type { DispatchConfig } from '../_shared/dispatchConfig'
import { handleEvent, routeOf, errorHint, resetCaches } from './handler'

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class { send = vi.fn() } }))
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class { send = vi.fn() }, PutObjectCommand: class { constructor(public input: unknown) {} } }))

const SECRET = 'shh'
const CONFIG: DispatchConfig = { accountSid: 'ACtest', apiKeySid: 'SK', apiKeySecret: 's', authToken: null, messagingServiceSid: 'MG1', dispatchNumber: '+12242221305', webhookSecret: SECRET }
const HOST = 'abc.lambda-url.us-east-1.on.aws'

function post(path: string, form: Record<string, string>, opts: { secret?: string; headers?: Record<string, string>; query?: Record<string, string> } = {}) {
  const q = new URLSearchParams({ t: opts.secret ?? SECRET, ...(opts.query ?? {}) })
  return {
    rawPath: path,
    rawQueryString: q.toString(),
    queryStringParameters: Object.fromEntries(q),
    headers: { host: HOST, ...(opts.headers ?? {}) },
    requestContext: { http: { method: 'POST', path } },
    body: Buffer.from(new URLSearchParams(form).toString()).toString('base64'),
    isBase64Encoded: true,
  }
}

let store: FakeDispatchStore
let uploads: Array<{ key: string; contentType: string; bytes: number }>
let slackPosts: Array<{ channel: string; text: string }>
let autoReplies: Array<{ to: string; body: string }>
function deps(config: DispatchConfig = CONFIG) {
  return {
    store: store.asStore(),
    config,
    putObject: async (key: string, bytes: Uint8Array, contentType: string) => { uploads.push({ key, contentType, bytes: bytes.length }) },
    fetchBinary: async (url: string) => ({ bytes: new Uint8Array([1, 2, 3]), contentType: url.endsWith('.mp3') ? 'audio/mpeg' : 'image/jpeg' }),
    slack: async (channel: string, text: string) => { slackPosts.push({ channel, text }) },
    sendSms: async (to: string, body: string) => { autoReplies.push({ to, body }) },
    now: () => new Date('2026-10-10T15:00:00.000Z'),
  }
}

beforeEach(() => {
  store = new FakeDispatchStore()
  store.drivers = [{ id: 'd-jason', name: 'Jason Smith', phone: '(847) 555-0100', active: true }]
  uploads = []; slackPosts = []; autoReplies = []
  resetCaches()
})

describe('gate', () => {
  it('routes only the known paths', () => {
    expect(routeOf('/sms')).toBe('sms')
    expect(routeOf('/voice/after/')).toBe('voice/after')
    expect(routeOf('/admin')).toBeNull()
  })
  it('refuses a wrong or missing secret, a foreign account, and non-POST', async () => {
    expect((await handleEvent(post('/sms', { From: '+18475550100', MessageSid: 'SM1' }, { secret: 'nope' }), deps())).statusCode).toBe(403)
    expect((await handleEvent(post('/sms', { From: '+18475550100', MessageSid: 'SM1', AccountSid: 'ACother' }), deps())).statusCode).toBe(403)
    expect((await handleEvent({ ...post('/sms', {}), requestContext: { http: { method: 'GET', path: '/sms' } } }, deps())).statusCode).toBe(405)
    expect((await handleEvent(post('/nothing', {}), deps())).statusCode).toBe(404)
    expect(store.messages.size).toBe(0)
  })
  it('checks the Twilio signature when the auth token is stored', async () => {
    const cfg = { ...CONFIG, authToken: 'tok' }
    const form = { From: '+18475550100', MessageSid: 'SM1', Body: 'hi', AccountSid: 'ACtest' }
    const ev = post('/sms', form)
    expect((await handleEvent(ev, deps(cfg))).statusCode).toBe(403)
    const sig = twilioSignature('tok', `https://${HOST}/sms?t=${SECRET}`, form)
    expect((await handleEvent(post('/sms', form, { headers: { 'x-twilio-signature': sig } }), deps(cfg))).statusCode).toBe(200)
    expect(store.messages.size).toBe(1)
  })
})

describe('inbound texts', () => {
  it('files a text from a known driver under their name and counts it unread', async () => {
    const r = await handleEvent(post('/sms', { From: '+18475550100', To: '+12242221305', MessageSid: 'SM1', Body: 'At the dock', NumMedia: '0', AccountSid: 'ACtest' }), deps())
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('<Response></Response>')
    const [c] = [...store.conversations.values()]
    expect(c.driverId).toBe('d-jason')
    expect(c.driverName).toBe('Jason Smith')
    expect(c.unreadCount).toBe(1)
    expect(c.lastPreview).toBe('At the dock')
    expect(c.lastDirection).toBe('IN')
    const [m] = [...store.messages.values()]
    expect(m.kind).toBe('SMS')
    expect(m.twilioSid).toBe('SM1')
    expect(m.status).toBe('received')
  })
  it('keeps an unknown number as a conversation of its own, by number', async () => {
    await handleEvent(post('/sms', { From: '+17735550123', MessageSid: 'SM2', Body: 'who dis' }), deps())
    const [c] = [...store.conversations.values()]
    expect(c.driverId).toBeNull()
    expect(c.phone).toBe('+17735550123')
  })
  it('stores pictures in S3 under the conversation and marks the message MMS', async () => {
    await handleEvent(post('/sms', { From: '+18475550100', MessageSid: 'SM3', Body: '', NumMedia: '2', MediaUrl0: 'https://api.twilio.com/m/0', MediaContentType0: 'image/jpeg', MediaUrl1: 'https://api.twilio.com/m/1', MediaContentType1: 'image/png' }), deps())
    const [m] = [...store.messages.values()]
    expect(m.kind).toBe('MMS')
    expect(m.media).toHaveLength(2)
    expect(uploads.map((u) => u.key)).toEqual([`dispatch-media/in/${m.conversationId}/SM3-0.jpg`, `dispatch-media/in/${m.conversationId}/SM3-1.png`])
    const [c] = [...store.conversations.values()]
    expect(c.lastPreview).toBe('2 photos')
  })
  it('ignores Twilio retrying the same MessageSid', async () => {
    const form = { From: '+18475550100', MessageSid: 'SM4', Body: 'once' }
    await handleEvent(post('/sms', form), deps())
    await handleEvent(post('/sms', form), deps())
    expect(store.messages.size).toBe(1)
    expect([...store.conversations.values()][0].unreadCount).toBe(1)
  })
  it('pings Slack and sends the auto-reply only to a brand-new conversation', async () => {
    store.settings = { slackChannelId: 'C0123ABCDEF', autoReply: 'Got it, dispatch will reply shortly.' }
    await handleEvent(post('/sms', { From: '+18475550100', MessageSid: 'SM5', Body: 'first' }), deps())
    await handleEvent(post('/sms', { From: '+18475550100', MessageSid: 'SM6', Body: 'second' }), deps())
    expect(slackPosts).toHaveLength(2)
    expect(slackPosts[0].text).toContain('Jason Smith')
    expect(slackPosts[0].text).toContain('first')
    expect(autoReplies).toEqual([{ to: '+18475550100', body: 'Got it, dispatch will reply shortly.' }])
  })
})

describe('delivery receipts', () => {
  it('updates the outbound message and never regresses delivered to sent', async () => {
    const c = await store.createConversation({ phone: '+18475550100' })
    const m = await store.putMessage({ conversationId: c.id, phone: c.phone, direction: 'OUT', kind: 'SMS', at: '2026-10-10T14:00:00Z', twilioSid: 'SMout', status: 'queued' })
    await handleEvent(post('/status', { MessageSid: 'SMout', MessageStatus: 'delivered' }), deps())
    expect(store.messages.get(m.id)?.status).toBe('delivered')
    await handleEvent(post('/status', { MessageSid: 'SMout', MessageStatus: 'sent' }), deps())
    expect(store.messages.get(m.id)?.status).toBe('delivered')
    await handleEvent(post('/status', { MessageSid: 'SMout', MessageStatus: 'undelivered', ErrorCode: '30003' }), deps())
    expect(store.messages.get(m.id)?.status).toBe('undelivered')
    expect(store.messages.get(m.id)?.errorMessage).toBe(errorHint('30003'))
  })
  it('answers 200 for a receipt it has never heard of so Twilio stops retrying', async () => {
    expect((await handleEvent(post('/status', { MessageSid: 'SMghost', MessageStatus: 'sent' }), deps())).statusCode).toBe(200)
  })
})

describe('calls', () => {
  it('rings the office phones with the whisper when forwards are set', async () => {
    store.settings = { forwardTo: [{ name: 'Ryne', phone: '+18475550199' }, { name: 'Dennis', phone: '+18475550198' }], ringSeconds: 20 }
    const r = await handleEvent(post('/voice', { From: '+18475550100', CallSid: 'CA1', CallStatus: 'ringing' }), deps())
    expect(r.headers['Content-Type']).toBe('text/xml')
    expect(r.body).toContain('<Dial callerId="+12242221305" timeout="20"')
    expect(r.body).toContain(`action="https://${HOST}/voice/after?t=${SECRET}"`)
    expect(r.body).toContain('+18475550199</Number>')
    expect(r.body).toContain('+18475550198</Number>')
    expect(r.body).toContain('who=Jason+Smith')
    const [m] = [...store.messages.values()]
    expect(m.kind).toBe('CALL')
    expect(m.status).toBe('ringing')
    expect([...store.conversations.values()][0].unreadCount).toBe(0)
  })
  it('goes straight to voicemail when nobody is set to ring', async () => {
    const r = await handleEvent(post('/voice', { From: '+18475550100', CallSid: 'CA2' }), deps())
    expect(r.body).toContain('<Record')
    expect(r.body).toContain('You have reached BCAT dispatch')
    expect(r.body).toContain(`recordingStatusCallback="https://${HOST}/voice/recording?t=${SECRET}"`)
  })
  it('whispers the caller name and bridges on a key press', async () => {
    const w = await handleEvent(post('/voice/whisper', { CallSid: 'CA3' }, { query: { who: 'Jason Smith' } }), deps())
    expect(w.body).toContain('BCAT dispatch call from Jason Smith')
    expect(w.body).toContain(`action="https://${HOST}/voice/accept?t=${SECRET}"`)
    const a = await handleEvent(post('/voice/accept', { Digits: '1' }), deps())
    expect(a.body).toContain('<Response></Response>')
  })
  it('records an answered call with its duration', async () => {
    await handleEvent(post('/voice', { From: '+18475550100', CallSid: 'CA4' }), deps())
    const r = await handleEvent(post('/voice/after', { CallSid: 'CA4', DialCallStatus: 'completed', DialCallDuration: '83' }), deps())
    expect(r.body).toContain('<Hangup/>')
    const m = await store.findMessageByTwilioSid('CA4')
    expect(m?.status).toBe('answered')
    expect(m?.callDurationSec).toBe(83)
    expect([...store.conversations.values()][0].lastPreview).toBe('Call answered (1:23)')
    expect([...store.conversations.values()][0].unreadCount).toBe(0)
  })
  it('marks a missed call unread and rolls to voicemail', async () => {
    store.settings = { forwardTo: [{ name: 'Ryne', phone: '+18475550199' }] }
    await handleEvent(post('/voice', { From: '+18475550100', CallSid: 'CA5' }), deps())
    const r = await handleEvent(post('/voice/after', { CallSid: 'CA5', DialCallStatus: 'no-answer' }), deps())
    expect(r.body).toContain('<Record')
    const c = [...store.conversations.values()][0]
    expect(c.unreadCount).toBe(1)
    expect(c.lastPreview).toBe('Missed call')
  })
  it('stores the voicemail audio, counts it unread, then attaches the transcript', async () => {
    await handleEvent(post('/voice', { From: '+18475550100', CallSid: 'CA6' }), deps())
    await handleEvent(post('/voice/after', { CallSid: 'CA6', DialCallStatus: 'no-answer' }), deps())
    await handleEvent(post('/voice/recording', { CallSid: 'CA6', RecordingSid: 'RE6', RecordingUrl: 'https://api.twilio.com/rec/RE6', RecordingDuration: '34', RecordingStatus: 'completed' }), deps())
    const c = [...store.conversations.values()][0]
    expect(uploads[0].key).toBe(`dispatch-media/vm/${c.id}/RE6.mp3`)
    const vm = await store.findMessageByTwilioSid('RE6')
    expect(vm?.kind).toBe('VOICEMAIL')
    expect(vm?.recordingKey).toBe(`dispatch-media/vm/${c.id}/RE6.mp3`)
    expect(c.unreadCount).toBe(2)   // missed call + voicemail
    expect(c.lastPreview).toBe('Voicemail (0:34)')
    // Twilio retries the recording callback: no second voicemail.
    await handleEvent(post('/voice/recording', { CallSid: 'CA6', RecordingSid: 'RE6', RecordingUrl: 'https://api.twilio.com/rec/RE6', RecordingDuration: '34' }), deps())
    expect([...store.messages.values()].filter((m) => m.kind === 'VOICEMAIL')).toHaveLength(1)
    await handleEvent(post('/voice/transcription', { RecordingSid: 'RE6', TranscriptionStatus: 'completed', TranscriptionText: 'Call me about the trailer' }), deps())
    expect((await store.findMessageByTwilioSid('RE6'))?.transcript).toBe('Call me about the trailer')
    expect([...store.conversations.values()][0].lastPreview).toBe('Voicemail: Call me about the trailer')
  })
})
