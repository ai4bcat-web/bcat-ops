import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FakeDispatchStore } from '../_shared/dispatchFakeStore'
import { TwilioError } from '../_shared/twilio'
import type { DispatchConfig } from '../_shared/dispatchConfig'
import type { SlackClient } from '../_shared/slackApi'
import { handleSlackEvent, type BridgeDeps } from './handler'

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class { send = vi.fn() } }))
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class { send = vi.fn() }, GetObjectCommand: class { constructor(public input: unknown) {} }, HeadObjectCommand: class { constructor(public input: unknown) {} }, PutObjectCommand: class { constructor(public input: unknown) {} } }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))

const CONFIG: DispatchConfig = { accountSid: 'AC', apiKeySid: 'SK', apiKeySecret: 's', authToken: null, messagingServiceSid: 'MG1', dispatchNumber: '+12242221305', webhookSecret: 'shh' }

let store: FakeDispatchStore
let sent: Array<{ to: string; body?: string; mediaUrls?: string[] }>
let slackCalls: Array<{ method: string; params: Record<string, unknown> }>
let objects: Record<string, { contentType: string; size: number }>
let sendImpl: () => Promise<{ sid: string; status: string }>

function deps(): BridgeDeps {
  const slack: SlackClient = {
    call: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      slackCalls.push({ method, params })
      if (method === 'users.info') return { ok: true, user: { profile: { email: 'Dennis@bcatcorp.com', display_name: 'Dennis' } } } as T
      return { ok: true, ts: '2.2' } as T
    },
    download: async () => ({ bytes: new Uint8Array([9, 9]), contentType: 'image/jpeg' }),
    upload: async () => 'F1',
  }
  return {
    store: store.asStore(),
    config: CONFIG,
    slack,
    send: async (_c, i) => { sent.push(i); return sendImpl() },
    presignGet: async (key) => `https://signed/${key}`,
    headObject: async (key) => objects[key] ?? null,
    putObject: async (key, _b, contentType) => { objects[key] = { contentType, size: 2 } },
    now: () => new Date('2026-10-10T15:00:00.000Z'),
  }
}

beforeEach(() => {
  store = new FakeDispatchStore()
  sent = []; slackCalls = []; objects = {}
  sendImpl = async () => ({ sid: 'SMs', status: 'queued' })
})

async function channelled() {
  const c = await store.createConversation({ phone: '+18475550100', driverName: 'Jason Smith' })
  return store.updateConversation(c.id, { set: { slackChannelId: 'C9' } })
}

describe('Slack → driver', () => {
  it('texts the driver what a teammate typed, signed with their email', async () => {
    const c = await channelled()
    const r = await handleSlackEvent({ type: 'message', channel: 'C9', user: 'U2', ts: '1.1', text: 'Go to door 4' }, deps())
    expect(r.outcome).toBe('sent')
    expect(sent).toEqual([{ to: '+18475550100', body: 'Go to door 4', mediaUrls: undefined }])
    const [m] = [...store.messages.values()]
    expect(m).toMatchObject({ direction: 'OUT', kind: 'SMS', sentBy: 'dennis@bcatcorp.com', via: 'slack', slackTs: '1.1' })
    expect(store.conversations.get(c.id)?.lastSentBy).toBe('dennis@bcatcorp.com')
    // Nothing posted back on success: the channel already shows the message.
    expect(slackCalls.filter((x) => x.method === 'chat.postMessage')).toHaveLength(0)
  })
  it('sends pictures attached in Slack as MMS', async () => {
    await channelled()
    const r = await handleSlackEvent({ type: 'message', subtype: 'file_share', channel: 'C9', user: 'U2', ts: '1.2', text: '', files: [{ id: 'F77', mimetype: 'image/jpeg', url_private: 'https://files.slack.com/x' }] }, deps())
    expect(r.outcome).toBe('sent')
    expect(sent[0].mediaUrls).toEqual(['https://signed/dispatch-media/out/slack-F77.jpg'])
    expect([...store.messages.values()][0].kind).toBe('MMS')
  })
  it('keeps // messages as internal notes and never texts them', async () => {
    await channelled()
    const r = await handleSlackEvent({ type: 'message', channel: 'C9', user: 'U2', ts: '1.3', text: '// broker says 3pm' }, deps())
    expect(r.outcome).toBe('note saved')
    expect(sent).toHaveLength(0)
    expect([...store.messages.values()][0]).toMatchObject({ kind: 'NOTE', body: 'broker says 3pm', via: 'slack' })
  })
  it('ignores channels that are not a driver, bots, and Slack retries', async () => {
    await channelled()
    expect((await handleSlackEvent({ type: 'message', channel: 'C_other', user: 'U2', ts: '1.4', text: 'hi' }, deps())).outcome).toContain('not a dispatch channel')
    expect((await handleSlackEvent({ type: 'message', channel: 'C9', user: 'U2', bot_id: 'B1', ts: '1.5', text: 'hi' }, deps())).outcome).toContain('bot')
    await handleSlackEvent({ type: 'message', channel: 'C9', user: 'U2', ts: '1.6', text: 'once' }, deps())
    expect((await handleSlackEvent({ type: 'message', channel: 'C9', user: 'U2', ts: '1.6', text: 'once' }, deps())).outcome).toContain('already handled')
    expect(sent).toHaveLength(1)
  })
  it('replies in the thread when Twilio refuses, leaving the failed row in the conversation', async () => {
    await channelled()
    sendImpl = async () => { throw new TwilioError('Unreachable', 30003, 400) }
    const r = await handleSlackEvent({ type: 'message', channel: 'C9', user: 'U2', ts: '1.7', text: 'hello?' }, deps())
    expect(r.outcome).toContain('failed')
    const reply = slackCalls.find((x) => x.method === 'chat.postMessage')
    expect(reply?.params).toMatchObject({ channel: 'C9', thread_ts: '1.7' })
    expect(String(reply?.params.text)).toContain('Unreachable')
    expect([...store.messages.values()][0].status).toBe('failed')
  })
})
