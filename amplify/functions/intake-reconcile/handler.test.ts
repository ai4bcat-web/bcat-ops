import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/lib-dynamodb', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  DynamoDBDocumentClient: { from: () => ({ send }) },
}))

let mod: typeof import('./handler')
beforeAll(async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  process.env.INTAKE_TABLE_NAME = 'IntakeItem-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  mod = await import('./handler')
})

const NOW = new Date('2026-10-05T12:00:00Z')

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'i1', status: 'NEW',
    subject: 'Tender TMS ID 212666394: CHICAGO, IL(10/08)',
    bodyText: '',
    receivedAt: '2026-10-04T10:00:00Z',
    slackChannelId: 'C123', slackMessageTs: '1791216531.983459',
    slackRepliedAt: null,
    ...over,
  }
}
const LOAD = { id: 'l1', aljexId: '14556  ', tmsId: '212666394', pickupNumber: '1749123' }

beforeEach(() => {
  vi.clearAllMocks()
  sent.length = 0
  send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (cmd.constructor.name === 'ScanCommand') {
      return { Items: String(cmd.input.TableName).includes('Load') ? [LOAD] : [item()] }
    }
    return {}
  })
})

/** Bodies the mocked transport was asked to send, so assertions do not index tuples. */
const sent: string[] = []

describe('it never starts a thread', () => {
  it('refuses to post without a thread_ts', async () => {
    /*
     * The one hard rule. chat.postMessage with no thread_ts puts a NEW top-level message
     * in a human channel, which BCAT Ops must never do — so the refusal lives in the
     * sender rather than relying on every caller to remember.
     */
    const fetchMock = vi.fn()
    const r = await mod.postThreadReply('C123', '', 'hi', fetchMock as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/without an existing thread/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses without a channel too', async () => {
    const fetchMock = vi.fn()
    const r = await mod.postThreadReply('', '1791216531.983459', 'hi', fetchMock as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('always sends thread_ts, and never broadcasts back to the channel', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      sent.push(init?.body ?? '')
      return { json: async () => ({ ok: true }) }
    })
    await mod.postThreadReply('C123', '1791216531.983459', 'PRO# 14556 - Added in BCAT Ops', fetchMock as unknown as typeof fetch)
    const body = JSON.parse(sent[0])
    expect(body.thread_ts).toBe('1791216531.983459')
    expect(body.channel).toBe('C123')
    expect(body.reply_broadcast).toBe(false)
  })

  it('skips an item that has no thread at all', () => {
    const picked = mod.selectReconcilable([item({ slackMessageTs: null })], NOW)
    expect(picked).toEqual([])
  })
})

describe('which items it acts on', () => {
  it('takes an open item with a thread, received recently', () => {
    expect(mod.selectReconcilable([item()], NOW)).toHaveLength(1)
  })

  it('never replies twice', () => {
    // slackRepliedAt is the idempotency key: a retried or double-scheduled run must not
    // say the same thing into the same thread again.
    expect(mod.selectReconcilable([item({ slackRepliedAt: '2026-10-05T09:00:00Z' })], NOW)).toEqual([])
  })

  it('leaves archived and already-built items alone', () => {
    expect(mod.selectReconcilable([item({ status: 'ARCHIVED' })], NOW)).toEqual([])
    expect(mod.selectReconcilable([item({ status: 'BUILT' })], NOW)).toEqual([])
  })

  it('ignores anything older than the lookback', () => {
    expect(mod.selectReconcilable([item({ receivedAt: '2026-01-01T00:00:00Z' })], NOW)).toEqual([])
  })
})

describe('reconciling a run', () => {
  it('replies in the thread, then records it and moves the item to BUILT', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      sent.push(init?.body ?? '')
      return { json: async () => ({ ok: true }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await mod.handler()
    expect(out.replied).toBe(1)

    const body = JSON.parse(sent[sent.length - 1])
    expect(body.thread_ts).toBe('1791216531.983459')
    expect(body.text).toBe('PRO# 14556 - Added in BCAT Ops') // padded PRO trimmed

    const update = send.mock.calls.map((c) => c[0]).find((c) => c.constructor.name === 'UpdateCommand')
    expect(update.input.ExpressionAttributeValues[':status']).toBe('BUILT')
    expect(update.input.ExpressionAttributeValues[':pro']).toBe('14556')
    expect(update.input.ExpressionAttributeValues[':load']).toBe('l1')
    expect(update.input.ExpressionAttributeValues[':at']).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('does not mark an item when Slack rejects the post', async () => {
    // A failed send must leave the item exactly as it was, so the next run retries it.
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false, error: 'channel_not_found' }) })))
    const out = await mod.handler()
    expect(out.replied).toBe(0)
    expect(send.mock.calls.map((c) => c[0]).some((c) => c.constructor.name === 'UpdateCommand')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('will not act on an unlabelled number', async () => {
    /*
     * A bare number in a forwarded body can collide with an unrelated load by chance. A
     * confident wrong reply in front of the whole team is worse than staying quiet.
     */
    send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (cmd.constructor.name === 'ScanCommand') {
        return {
          Items: String(cmd.input.TableName).includes('Load')
            ? [LOAD]
            : [item({ subject: 'Fwd: see 212666394 attached' })],
        }
      }
      return {}
    })
    const fetchMock = vi.fn(async (url: unknown) => ({
      json: async () => (String(url).includes('conversations.replies') ? { ok: true, messages: [] } : { ok: true }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await mod.handler()
    expect(out.replied).toBe(0)
    // Reading the thread is fine; what must not happen is posting into it.
    const posted = fetchMock.mock.calls.filter((c) => String(c[0]).includes('chat.postMessage'))
    expect(posted).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})

describe('caching what the thread says', () => {
  it('reports the last REPLY, never the tender itself', () => {
    /*
     * The parent message is the tender, which the queue already shows. A thread nobody has
     * answered must read as "no replies", not echo the subject back as if someone had.
     */
    expect(mod.summarizeThread([{ text: 'Tender TMS ID 212666394', ts: '1.0', user: 'USLACKBOT' }]))
      .toEqual({ lastReplyText: '', lastReplyAt: '', lastReplyUser: '', replyCount: 0 })
  })

  it('takes the newest reply and counts them', () => {
    const s = mod.summarizeThread([
      { text: 'tender', ts: '1.0', user: 'USLACKBOT' },
      { text: 'on it', ts: '2.0', user: 'U1' },
      { text: 'PRO# 14556 - Added in BCAT Ops', ts: '3.0', user: 'U2' },
    ])
    expect(s).toEqual({
      lastReplyText: 'PRO# 14556 - Added in BCAT Ops',
      lastReplyAt: '3.0', lastReplyUser: 'U2', replyCount: 2,
    })
  })

  it('returns null for a thread that could not be read', () => {
    expect(mod.summarizeThread([])).toBeNull()
  })

  it('truncates a very long reply rather than storing an essay', () => {
    const s = mod.summarizeThread([{ text: 'x', ts: '1' }, { text: 'y'.repeat(900), ts: '2' }])
    expect(s!.lastReplyText).toHaveLength(500)
  })

  it('refreshes the oldest summary first, so coverage rotates', () => {
    const picked = mod.selectThreadsToSync([
      { id: 'fresh', receivedAt: '2026-10-04T10:00:00Z', slackChannelId: 'C', slackMessageTs: '1', threadSyncedAt: '2026-10-05T11:00:00Z' },
      { id: 'stale', receivedAt: '2026-10-04T10:00:00Z', slackChannelId: 'C', slackMessageTs: '2', threadSyncedAt: '2026-10-01T09:00:00Z' },
      { id: 'never', receivedAt: '2026-10-04T10:00:00Z', slackChannelId: 'C', slackMessageTs: '3' },
    ], NOW)
    expect(picked.map((p) => p.id)).toEqual(['never', 'stale', 'fresh'])
  })

  it('syncs threads for items of any status, not only open ones', () => {
    // The point is to show the conversation. A BUILT item's thread is still worth reading.
    const picked = mod.selectThreadsToSync(
      [{ id: 'b', status: 'BUILT', receivedAt: '2026-10-04T10:00:00Z', slackChannelId: 'C', slackMessageTs: '1' }],
      NOW,
    )
    expect(picked).toHaveLength(1)
  })

  it('a Slack outage returns null instead of throwing', async () => {
    const boom = vi.fn(async () => { throw new Error('slack down') })
    expect(await mod.readThread('C', '1', boom as unknown as typeof fetch)).toBeNull()
  })
})
