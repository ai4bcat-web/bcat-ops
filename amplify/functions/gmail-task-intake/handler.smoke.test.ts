import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

const { send } = vi.hoisted(() => {
  delete process.env.TABLE_NAME
  delete process.env.GMAIL_INTAKE_SECRET
  delete process.env.SLACK_BOT_TOKEN
  delete process.env.INTAKE_IVAN_CHANNEL_ID
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  class PutItemCommand { input: unknown; __type = 'Put'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBClient, PutItemCommand }
})

type Handler = (e: { body: string | null; isBase64Encoded?: boolean }) =>
  Promise<{ statusCode: number; body: string }>

const fetchMock = vi.fn()

async function loadHandler(env: Record<string, string> = {}): Promise<Handler> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  vi.resetModules()
  const mod = await import('./handler')
  return mod.handler as unknown as Handler
}

const ENV = { TABLE_NAME: 'Intake-test', GMAIL_INTAKE_SECRET: 'shh' }
const post = (payload: unknown) => ({ body: JSON.stringify(payload) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  send.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const k of ['TABLE_NAME', 'GMAIL_INTAKE_SECRET', 'SLACK_BOT_TOKEN', 'INTAKE_IVAN_CHANNEL_ID']) delete process.env[k]
})

describe('gmail-task-intake smoke', () => {
  it('loads with empty env and refuses everything with 401 (no secret configured)', async () => {
    const handler = await loadHandler()
    const res = await handler(post({ secret: undefined, messageId: 'm1' }))
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' })
    expect(send).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed JSON body', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler({ body: '{nope' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid JSON body' })
  })

  it('returns 401 for a wrong secret', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler(post({ secret: 'wrong', messageId: 'm1' }))
    expect(res.statusCode).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  it('returns 400 when messageId is missing', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler(post({ secret: 'shh', messageId: '  ' }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'messageId required' })
  })

  it('creates an IntakeItem and posts to Slack on the happy path', async () => {
    const handler = await loadHandler({ ...ENV, SLACK_BOT_TOKEN: 'xoxb-test', INTAKE_IVAN_CHANNEL_ID: 'C42' })
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) })
    const res = await handler(post({
      secret: 'shh', messageId: 'abc', subject: ' Fix door ', from: 'a@b.com', body: 'please', receivedAt: '2026-01-01T00:00:00Z',
    }))
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body) as { ok: boolean; id: string }
    expect(out.ok).toBe(true)
    expect(out.id).toMatch(/^gmailtask-[0-9a-f]{20}$/)

    expect(send).toHaveBeenCalledTimes(1)
    const cmd = send.mock.calls[0][0] as { input: { TableName: string; Item: Record<string, AttributeValue> } }
    expect(cmd.input.TableName).toBe('Intake-test')
    expect(unmarshall(cmd.input.Item)).toMatchObject({
      id: out.id,
      __typename: 'IntakeItem',
      status: 'NEW',
      source: 'IVAN_CARTAGE',
      subject: 'Fix door',
      fromEmail: 'a@b.com',
      bodyText: 'please',
      externalSource: 'gmail',
      externalId: 'gmail-task:abc',
      gmailMessageId: 'abc',
      receivedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(JSON.parse(init.body)).toEqual({
      channel: 'C42',
      text: ':inbox_tray: New task from email — *Fix door*  (from a@b.com)',
    })
  })

  it('still creates the task when Slack is unconfigured (no fetch)', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler(post({ secret: 'shh', messageId: 'abc' }))
    expect(res.statusCode).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    const cmd = send.mock.calls[0][0] as { input: { Item: Record<string, AttributeValue> } }
    expect(unmarshall(cmd.input.Item).subject).toBe('(no subject)')
  })

  it('reports a duplicate message as 200 duplicate without posting to Slack', async () => {
    const handler = await loadHandler({ ...ENV, SLACK_BOT_TOKEN: 'xoxb-test', INTAKE_IVAN_CHANNEL_ID: 'C42' })
    send.mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'ConditionalCheckFailedException' }))
    const res = await handler(post({ secret: 'shh', messageId: 'abc' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, duplicate: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
