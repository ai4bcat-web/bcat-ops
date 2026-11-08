import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

const { send } = vi.hoisted(() => {
  delete process.env.TABLE_NAME
  delete process.env.DISPUTE_INTAKE_SECRET
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  class PutItemCommand { input: unknown; __type = 'Put'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBClient, PutItemCommand }
})

type Handler = (e: { body: string | null; isBase64Encoded?: boolean }) =>
  Promise<{ statusCode: number; body: string }>

async function loadHandler(env: Record<string, string> = {}): Promise<Handler> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  vi.resetModules()
  const mod = await import('./handler')
  return mod.handler as unknown as Handler
}

const ENV = { TABLE_NAME: 'Dispute-test', DISPUTE_INTAKE_SECRET: 'shh' }
const post = (payload: unknown) => ({ body: JSON.stringify(payload) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  send.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.TABLE_NAME
  delete process.env.DISPUTE_INTAKE_SECRET
})

describe('amazon-dispute-intake smoke', () => {
  it('loads with empty env and refuses everything with 401 (no secret configured)', async () => {
    const handler = await loadHandler()
    const res = await handler(post({ driverName: 'Sam' }))
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' })
    expect(send).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler({ body: '<<<' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid JSON body' })
  })

  it('returns 401 for a wrong secret', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler(post({ secret: 'nope', driverName: 'Sam' }))
    expect(res.statusCode).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  it('returns 400 when driverName is blank', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler(post({ secret: 'shh', driverName: '   ' }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'driverName required' })
  })

  it('writes a PENDING AmazonDispute with parsed amounts', async () => {
    const handler = await loadHandler(ENV)
    const res = await handler(post({
      secret: 'shh',
      submissionId: 'row-7',
      timestamp: '2026-01-01T12:00:00Z',
      driverName: ' Sam ',
      tripNumber: 'T-1',
      amountPaid: '$1,282.66',
      amountRequested: 1500,
      description: 'short paid',
    }))
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body) as { ok: boolean; id: string }
    expect(out.ok).toBe(true)
    expect(out.id).toMatch(/^dispute-[0-9a-f]{20}$/)

    expect(send).toHaveBeenCalledTimes(1)
    const cmd = send.mock.calls[0][0] as { input: { TableName: string; ConditionExpression: string; Item: Record<string, AttributeValue> } }
    expect(cmd.input.TableName).toBe('Dispute-test')
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(id)')
    const item = unmarshall(cmd.input.Item)
    expect(item).toMatchObject({
      id: out.id,
      __typename: 'AmazonDispute',
      driverName: 'Sam',
      tripNumber: 'T-1',
      amountPaid: 1282.66,
      amountRequested: 1500,
      description: 'short paid',
      status: 'PENDING',
      source: 'GOOGLE_FORM',
      submittedAt: '2026-01-01T12:00:00.000Z',
      externalId: 'dispute:row-7',
    })
    expect(item).not.toHaveProperty('photoUrl')
  })

  it('gives the same id to a re-post of the same submission', async () => {
    const handler = await loadHandler(ENV)
    const a = JSON.parse((await handler(post({ secret: 'shh', driverName: 'Sam', submissionId: 'r1' }))).body) as { id: string }
    const b = JSON.parse((await handler(post({ secret: 'shh', driverName: 'Sam', submissionId: 'r1' }))).body) as { id: string }
    expect(a.id).toBe(b.id)
  })

  it('reports a conditional-put collision as 200 duplicate', async () => {
    const handler = await loadHandler(ENV)
    send.mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'ConditionalCheckFailedException' }))
    const res = await handler(post({ secret: 'shh', driverName: 'Sam' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, duplicate: true })
  })

  it('rethrows other DynamoDB failures', async () => {
    const handler = await loadHandler(ENV)
    send.mockRejectedValueOnce(new Error('throttled'))
    await expect(handler(post({ secret: 'shh', driverName: 'Sam' }))).rejects.toThrow('throttled')
  })
})
