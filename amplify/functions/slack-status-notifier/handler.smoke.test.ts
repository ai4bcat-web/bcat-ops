import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

const { send } = vi.hoisted(() => {
  delete process.env.TABLE_NAME
  delete process.env.SLACK_BOT_TOKEN
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  class GetItemCommand { input: unknown; __type = 'Get'; constructor(input: unknown) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

interface Args {
  intakeItemId: string
  oldStatus?: string | null
  newStatus: string
  actorName?: string | null
  proNumber?: string | null
  reassignedTo?: string | null
}
type Handler = (e: { arguments: Args }) => Promise<Record<string, unknown>>

const fetchMock = vi.fn()

async function loadHandler(env: Record<string, string> = {}): Promise<Handler> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  vi.resetModules()
  const mod = await import('./handler')
  return mod.handler as unknown as Handler
}

const ENV = { TABLE_NAME: 'Intake-test', SLACK_BOT_TOKEN: 'xoxb-test' }
const slackItem: Record<string, AttributeValue> = {
  id: { S: 'i1' },
  externalSource: { S: 'slack' },
  slackChannelId: { S: 'C1' },
  slackMessageTs: { S: '1700000000.000100' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.TABLE_NAME
  delete process.env.SLACK_BOT_TOKEN
})

describe('slack-status-notifier smoke', () => {
  it('loads with empty env', async () => {
    const handler = await loadHandler()
    expect(typeof handler).toBe('function')
  })

  it('returns "Item not found" and posts nothing when the item is missing', async () => {
    const handler = await loadHandler(ENV)
    send.mockResolvedValueOnce({})
    const res = await handler({ arguments: { intakeItemId: 'nope', newStatus: 'DONE' } })
    expect(res).toEqual({ ok: false, error: 'Item not found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips items that did not come from Slack', async () => {
    const handler = await loadHandler(ENV)
    send.mockResolvedValueOnce({ Item: { id: { S: 'i1' }, externalSource: { S: 'gmail' } } })
    const res = await handler({ arguments: { intakeItemId: 'i1', newStatus: 'DONE' } })
    expect(res).toEqual({ ok: true, skipped: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('replies in the Slack thread with the status text', async () => {
    const handler = await loadHandler(ENV)
    send.mockResolvedValueOnce({ Item: slackItem })
    const res = await handler({ arguments: { intakeItemId: 'i1', newStatus: 'DONE', actorName: 'Dennis', proNumber: '12345' } })
    expect(res).toEqual({ ok: true })

    const get = send.mock.calls[0][0] as { input: { TableName: string; Key: unknown } }
    expect(get.input).toEqual({ TableName: 'Intake-test', Key: { id: { S: 'i1' } } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(init.headers.Authorization).toBe('Bearer xoxb-test')
    expect(JSON.parse(init.body)).toEqual({
      channel: 'C1',
      thread_ts: '1700000000.000100',
      text: '✅ Dennis marked this done — built in Aljex  •  Pro# `12345`',
    })
  })

  it('announces a reassignment instead of a status change', async () => {
    const handler = await loadHandler(ENV)
    send.mockResolvedValueOnce({ Item: slackItem })
    await handler({ arguments: { intakeItemId: 'i1', newStatus: 'NEW', actorName: 'Ivan', reassignedTo: 'Dennis' } })
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect((JSON.parse(init.body) as { text: string }).text).toBe('👤 Ivan reassigned this to *Dennis*')
  })

  it('labels an unrecognised transition with old and new status', async () => {
    const handler = await loadHandler(ENV)
    send.mockResolvedValueOnce({ Item: slackItem })
    await handler({ arguments: { intakeItemId: 'i1', oldStatus: 'IN_PROGRESS', newStatus: 'NEW', actorName: 'Ivan' } })
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect((JSON.parse(init.body) as { text: string }).text).toBe('Status updated: *New*  (was: In Progress)  •  by Ivan')
  })

  it('does not throw when Slack answers ok:false', async () => {
    const handler = await loadHandler(ENV)
    send.mockResolvedValueOnce({ Item: slackItem })
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'channel_not_found' }) })
    const res = await handler({ arguments: { intakeItemId: 'i1', newStatus: 'ARCHIVED' } })
    expect(res).toEqual({ ok: true })
  })
})
