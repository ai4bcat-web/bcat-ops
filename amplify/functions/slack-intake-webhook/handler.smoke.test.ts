import { createHmac } from 'crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

const { send, lambdaSend, s3Send } = vi.hoisted(() => {
  delete process.env.TABLE_NAME
  delete process.env.SLACK_SIGNING_SECRET
  delete process.env.SLACK_CHANNEL_MAPPING
  delete process.env.BUCKET_NAME
  delete process.env.SLACK_BOT_TOKEN
  delete process.env.DISPATCH_CONVERSATION_TABLE_NAME
  delete process.env.DISPATCH_SLACK_BRIDGE_FUNCTION_NAME
  delete process.env.WORKFLOW_AGENT_FUNCTION_NAME
  return { send: vi.fn(), lambdaSend: vi.fn(), s3Send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  class PutItemCommand { input: unknown; __type = 'Put'; constructor(input: unknown) { this.input = input } }
  class QueryCommand { input: unknown; __type = 'Query'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBClient, PutItemCommand, QueryCommand }
})
vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send = lambdaSend }
  class InvokeCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send = s3Send }
  class PutObjectCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

type Handler = (e: { headers: Record<string, string>; body: string | null; isBase64Encoded?: boolean }) =>
  Promise<{ statusCode: number; body?: string }>

const SECRET = 'test-signing-secret'
const NOW_MS = 1_700_000_000_000
const NOW_S = NOW_MS / 1000

async function loadHandler(env: Record<string, string> = {}): Promise<Handler> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  vi.resetModules()
  const mod = await import('./handler')
  return mod.handler as unknown as Handler
}

function sign(body: string, ts: number, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
}

function signedEvent(payload: unknown, ts = NOW_S) {
  const body = JSON.stringify(payload)
  return {
    headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sign(body, ts) },
    body,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  send.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const k of ['TABLE_NAME', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_MAPPING']) delete process.env[k]
})

describe('slack-intake-webhook smoke', () => {
  it('loads with empty env and rejects every request instead of throwing at import', async () => {
    const handler = await loadHandler()
    expect(typeof handler).toBe('function')
    // No secret configured: the unsigned request is stale/unsigned and is refused.
    const res = await handler({ headers: {}, body: '{}' })
    expect(res.statusCode).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a stale timestamp with 403 "Stale request"', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const res = await handler(signedEvent({ type: 'url_verification', challenge: 'x' }, NOW_S - 301))
    expect(res).toEqual({ statusCode: 403, body: 'Stale request' })
  })

  it('rejects a missing signature with 403 "Invalid signature"', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const res = await handler({
      headers: { 'x-slack-request-timestamp': String(NOW_S) },
      body: JSON.stringify({ type: 'url_verification', challenge: 'x' }),
    })
    expect(res).toEqual({ statusCode: 403, body: 'Invalid signature' })
  })

  it('rejects a signature made with the wrong secret with 403', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x' })
    const res = await handler({
      headers: { 'x-slack-request-timestamp': String(NOW_S), 'x-slack-signature': sign(body, NOW_S, 'other-secret') },
      body,
    })
    expect(res).toEqual({ statusCode: 403, body: 'Invalid signature' })
  })

  it('rejects a body altered after signing', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const ev = signedEvent({ type: 'url_verification', challenge: 'x' })
    const res = await handler({ ...ev, body: ev.body.replace('"x"', '"y"') })
    expect(res.statusCode).toBe(403)
  })

  it('answers a validly signed url_verification with the challenge', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const res = await handler(signedEvent({ type: 'url_verification', challenge: 'abc123' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '')).toEqual({ challenge: 'abc123' })
  })

  it('accepts a validly signed base64-encoded body', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const ev = signedEvent({ type: 'url_verification', challenge: 'b64' })
    const res = await handler({ ...ev, body: Buffer.from(ev.body).toString('base64'), isBase64Encoded: true })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '')).toEqual({ challenge: 'b64' })
  })

  it('returns 400 "Bad JSON" for a validly signed non-JSON body', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const body = 'not json'
    const res = await handler({
      headers: { 'x-slack-request-timestamp': String(NOW_S), 'x-slack-signature': sign(body, NOW_S) },
      body,
    })
    expect(res).toEqual({ statusCode: 400, body: 'Bad JSON' })
  })

  it('writes an IntakeItem for a signed message in a mapped channel', async () => {
    const handler = await loadHandler({
      SLACK_SIGNING_SECRET: SECRET,
      TABLE_NAME: 'Intake-test',
      SLACK_CHANNEL_MAPPING: '{"C111":"IVAN_CARTAGE"}',
    })
    const res = await handler(signedEvent({
      type: 'event_callback',
      event: { type: 'message', channel: 'C111', ts: '1700000000.000100', user: 'U9', text: 'Need a truck\nto Newark' },
    }))
    expect(res).toEqual({ statusCode: 200, body: 'ok' })
    expect(send).toHaveBeenCalledTimes(1)
    const cmd = send.mock.calls[0][0] as { __type: string; input: { TableName: string; ConditionExpression: string; Item: Record<string, AttributeValue> } }
    expect(cmd.__type).toBe('Put')
    expect(cmd.input.TableName).toBe('Intake-test')
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(id)')
    const item = unmarshall(cmd.input.Item)
    expect(item).toMatchObject({
      __typename: 'IntakeItem',
      source: 'IVAN_CARTAGE',
      status: 'NEW',
      subject: 'Need a truck',
      bodyText: 'Need a truck\nto Newark',
      externalSource: 'slack',
      externalId: 'C111:1700000000.000100',
      slackChannelId: 'C111',
      slackMessageTs: '1700000000.000100',
      fromEmail: 'U9',
      receivedAt: '2023-11-14T22:13:20.000Z',
    })
    expect(item.id).toMatch(/^slack-[0-9a-f]{20}$/)
  })

  it('writes nothing for a signed message in an unmapped channel', async () => {
    const handler = await loadHandler({ SLACK_SIGNING_SECRET: SECRET, TABLE_NAME: 'Intake-test' })
    const res = await handler(signedEvent({
      type: 'event_callback',
      event: { type: 'message', channel: 'C999', ts: '1700000000.000100', text: 'hi' },
    }))
    expect(res).toEqual({ statusCode: 200, body: 'ok' })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a conditional-put collision as a 200 "Duplicate"', async () => {
    const handler = await loadHandler({
      SLACK_SIGNING_SECRET: SECRET,
      TABLE_NAME: 'Intake-test',
      SLACK_CHANNEL_MAPPING: '{"C111":"IVAN_CARTAGE"}',
    })
    send.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }))
    const res = await handler(signedEvent({
      type: 'event_callback',
      event: { type: 'message', channel: 'C111', ts: '1700000000.000100', text: 'again' },
    }))
    expect(res).toEqual({ statusCode: 200, body: 'Duplicate' })
  })
})
