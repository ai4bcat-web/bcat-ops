/**
 * appt-need-notifier handler tests.
 *
 * Drives the real exported `handler` with fake AppSync events and a mocked Slack fetch.
 * Verifies the message actually contains the standing instruction and enough reference
 * for a dispatcher to find the load, and that a missing channel/token degrades quietly
 * rather than throwing into the save path.
 *
 * Mirrors broker-load-alert/handler.test.ts. Env is set inside vi.hoisted so it lands
 * before the import; the handler itself reads process.env at CALL time, which is what
 * makes the not-configured guard reachable here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  process.env.APPTS_IVAN_CHANNEL_ID = 'C0BPX858363'
})

// The response shape is widened deliberately: tests override it with error payloads, and
// the Amplify backend type check runs real tsc over amplify/** (unlike vitest's esbuild),
// so an inferred narrow type here fails the build even though the tests pass.
interface SlackResponse { ok: boolean; ts?: string; error?: string }
type FetchLike = (url: unknown, init?: { body?: string }) => Promise<{ json: () => Promise<SlackResponse> }>
const fetchMock = vi.fn<FetchLike>(async () => ({
  json: async () => ({ ok: true, ts: '1699999999.000100' }),
}))
vi.stubGlobal('fetch', fetchMock)

import { handler } from './handler'

/** The JSON body of the nth chat.postMessage call. */
const postBody = (n = 0) =>
  JSON.parse(fetchMock.mock.calls[n][1]?.body ?? '{}') as { channel: string; text: string }

const event = (args: Record<string, unknown> = {}) => ({
  arguments: {
    stopKind: 'pickup',
    aljexId: '12345',
    pickupNumber: 'PU-987',
    customer: 'Acme Freight',
    location: 'Elwood, IL',
    apptDate: 'Aug 20, 2026',
    actorName: 'ryne@bcatcorp.com',
    ...args,
  },
})

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1.1' }) })
})

describe('appt-need-notifier', () => {
  it('posts to the #appts-ivan channel', async () => {
    await handler(event())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage')
    expect(postBody().channel).toBe('C0BPX858363')
  })

  it('carries the standing instruction verbatim', async () => {
    await handler(event())
    expect(postBody().text).toContain(
      'This shipment needs a pickup or delivery appt set. Please reach out to the appropriate ' +
      'contact to schedule an appt and update the thread and bcat-ops and e2open once complete.',
    )
  })

  it('names the load so it can be actioned without opening the app', async () => {
    await handler(event())
    const { text } = postBody()
    expect(text).toContain('Pro# 12345')
    expect(text).toContain('PU# PU-987')
    expect(text).toContain('Acme Freight')
    expect(text).toContain('Elwood, IL')
    expect(text).toContain('Aug 20, 2026')
  })

  it('distinguishes pickup from delivery', async () => {
    await handler(event({ stopKind: 'pickup' }))
    expect(postBody().text).toContain('Pickup appt needed')

    fetchMock.mockClear()
    await handler(event({ stopKind: 'delivery' }))
    expect(postBody().text).toContain('Delivery appt needed')
  })

  it('still posts something useful when the load details are unknown', async () => {
    await handler(event({
      aljexId: null, pickupNumber: null, customer: null, location: null, apptDate: null,
    }))
    const { text } = postBody()
    // The instruction must survive even with no reference — a bare message beats none.
    expect(text).toContain('Load reference unavailable')
    expect(text).toContain('needs a pickup or delivery appt set')
  })

  it('falls back to the caller identity when no actor name is passed', async () => {
    await handler({
      arguments: { ...event().arguments, actorName: null },
      identity: { claims: { email: 'jenny@bcatcorp.com' } },
    })
    expect(postBody().text).toContain('jenny@bcatcorp.com')
  })

  it('reports a Slack failure instead of pretending it posted', async () => {
    // not_in_channel is the realistic one: the bot has a valid token but was never
    // invited to #appts-ivan.
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'not_in_channel' }) })
    const res = await handler(event())
    expect(res).toEqual({ ok: false, error: 'not_in_channel' })
  })

  it('skips quietly when the channel is not configured', async () => {
    // Before the bot is invited / the env var is set, flagging a load must not throw
    // into the save path — it should no-op and say so.
    const saved = process.env.APPTS_IVAN_CHANNEL_ID
    process.env.APPTS_IVAN_CHANNEL_ID = ''
    try {
      const res = await handler(event())
      expect(res).toEqual({ ok: false, error: 'not configured' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env.APPTS_IVAN_CHANNEL_ID = saved
    }
  })

  it('skips quietly when the bot token is missing', async () => {
    const saved = process.env.SLACK_BOT_TOKEN
    process.env.SLACK_BOT_TOKEN = ''
    try {
      const res = await handler(event())
      expect(res).toEqual({ ok: false, error: 'not configured' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env.SLACK_BOT_TOKEN = saved
    }
  })
})

describe('appointment updates reply in the asking thread', () => {
  const body = (n = 0) =>
    JSON.parse(fetchMock.mock.calls[n][1]?.body ?? '{}') as
      { channel: string; text: string; thread_ts?: string }

  it('posts as a threaded reply when given a ts', async () => {
    await handler(event({ kind: 'updated', threadTs: '1699999999.000100',
                          apptLabel: 'Aug 20, 2026 · 09:30' }))
    expect(body().thread_ts).toBe('1699999999.000100')
  })

  it('says what the appointment is now', async () => {
    await handler(event({ kind: 'updated', threadTs: 'TS', apptLabel: 'Aug 20, 2026 · 09:30' }))
    expect(body().text).toContain('Pickup appt updated')
    expect(body().text).toContain('Aug 20, 2026 · 09:30')
  })

  it('still carries the load reference so the reply stands alone', async () => {
    await handler(event({ kind: 'updated', threadTs: 'TS', apptLabel: 'x' }))
    expect(body().text).toContain('Pro# 12345')
  })

  it('does NOT repeat the standing instruction on an update', async () => {
    // The instruction belongs on the ask; repeating it on every answer is noise.
    await handler(event({ kind: 'updated', threadTs: 'TS', apptLabel: 'x' }))
    expect(body().text).not.toContain('reach out to the appropriate')
  })

  it('posts at top level rather than dropping the update when no ts is known', async () => {
    // Legacy loads have nowhere to keep a thread ts; the message still has to arrive.
    await handler(event({ kind: 'updated', apptLabel: 'Aug 20, 2026 · 09:30' }))
    expect(body().thread_ts).toBeUndefined()
    expect(body().text).toContain('Pickup appt updated')
  })

  it('names the delivery end when the delivery moved', async () => {
    await handler(event({ kind: 'updated', stopKind: 'delivery', threadTs: 'TS', apptLabel: 'x' }))
    expect(body().text).toContain('Delivery appt updated')
  })

  it('treats a missing kind as the original NEED post', async () => {
    // A client shipped before this change sends no kind and must keep working.
    await handler(event())
    expect(body().text).toContain('appt needed')
    expect(body().thread_ts).toBeUndefined()
  })

  it('returns the ts so the caller can remember the thread', async () => {
    // The caller persists this on the stop; without it there is no thread to reply into
    // when the appointment is later booked.
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1712345678.000900' }) })
    const res = await handler(event()) as { ok: boolean; ts?: string }
    expect(res.ok).toBe(true)
    expect(res.ts).toBe('1712345678.000900')
  })
})
