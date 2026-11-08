/**
 * One behavioural contract, two adapters: whatever the spot pipeline relies on from a
 * GmailPort must hold for the Google adapter (against a fake Gmail wire) and for the
 * simulated inbox (against in-memory S3).
 */
import { describe, it, expect } from 'vitest'
import type { GmailPort } from '../../../../src/lib/spot/port'
import { googlePort } from './googlePort'
import { simInject, simPort, type SimS3 } from './simPort'

interface Harness {
  port: GmailPort
  /** Put a message into the inbox; returns its id. */
  inject(m: { id: string; threadId: string; from: string; subject: string; body: string; ageMs?: number }): Promise<string>
}

function memoryS3(): SimS3 {
  const m = new Map<string, string>()
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, b) => void m.set(k, b),
    del: async (k) => void m.delete(k),
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)).sort(),
  }
}

function simHarness(): Harness {
  const s3 = memoryS3()
  return {
    port: simPort('u1', s3),
    inject: async (m) =>
      (
        await simInject('u1', {
          id: m.id,
          threadId: m.threadId,
          from: m.from,
          subject: m.subject,
          body: m.body,
          internalDate: String(Date.now() - (m.ageMs ?? 0)),
        }, s3)
      ).id,
  }
}

/** A tiny in-memory Gmail: messages, history. Speaks only the routes the port uses. */
function googleHarness(): Harness {
  interface Msg { id: string; threadId: string; internalDate: string; labelIds: string[]; from: string; subject: string; body: string }
  const messages: Msg[] = []
  let history = 100

  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
  const payload = (m: Msg) => ({
    headers: [
      { name: 'From', value: m.from },
      { name: 'Subject', value: m.subject },
      { name: 'Message-ID', value: `<${m.id}@x>` },
    ],
    mimeType: 'text/plain',
    body: { data: b64(m.body) },
  })
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    const method = init?.method ?? 'GET'
    if (path === '/profile') return json({ emailAddress: 'rep@example.test', historyId: String(history) })
    if (path === '/messages' && method === 'GET') return json({ messages: messages.map((m) => ({ id: m.id })) })
    if (path === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'))
      if (start < 50) return json({}, 404)
      const added = messages.filter((m) => Number(m.internalDate) > start)
      return json({ history: added.map((m) => ({ messagesAdded: [{ message: { id: m.id } }] })), historyId: String(history) })
    }
    const mm = path.match(/^\/messages\/([^/]+)$/)
    if (mm) {
      const m = messages.find((x) => x.id === decodeURIComponent(mm[1]))
      if (!m) return json({}, 404)
      return json({ id: m.id, threadId: m.threadId, internalDate: m.internalDate, labelIds: m.labelIds, snippet: m.body.slice(0, 40), payload: payload(m) })
    }
    const tm = path.match(/^\/threads\/([^/]+)$/)
    if (tm) {
      const ms = messages.filter((x) => x.threadId === decodeURIComponent(tm[1]))
      return json({ messages: ms.map((m) => ({ id: m.id, threadId: m.threadId, internalDate: m.internalDate, labelIds: m.labelIds, payload: payload(m) })) })
    }
    return json({}, 404)
  }) as unknown as typeof fetch

  return {
    port: googlePort('u1', { fetchImpl, getToken: async () => 'tok', sleep: async () => undefined }),
    inject: async (m) => {
      history += 10
      messages.push({ id: m.id, threadId: m.threadId, internalDate: String(history), labelIds: ['INBOX'], from: m.from, subject: m.subject, body: m.body })
      return m.id
    },
  }
}

describe.each([
  ['googlePort', googleHarness],
  ['simPort', simHarness],
])('GmailPort contract: %s', (_name, make) => {
  it('lists and reads an injected message: headers, thread, body', async () => {
    const h = make()
    const id = await h.inject({ id: 'm1', threadId: 't1', from: 'Pat <pat@acme.test>', subject: 'Rate Dallas to Atlanta', body: 'Need a 53 van, 42k lbs.' })
    const ids = await h.port.listRecent({ lookbackDays: 2, label: null, max: 10 })
    expect(ids).toContain(id)
    const meta = await h.port.getMetadata(id)
    expect(meta).toMatchObject({ id, threadId: 't1', subject: 'Rate Dallas to Atlanta' })
    expect(meta.from).toContain('pat@acme.test')
    expect(meta.labelIds).toContain('INBOX')
    expect((await h.port.getBody(id)).text).toContain('53 van')
    expect((await h.port.threadMessages('t1')).map((m) => m.id)).toEqual([id])
  })

  it('caps listRecent at max', async () => {
    const h = make()
    for (const i of [1, 2, 3]) await h.inject({ id: `c${i}`, threadId: `t${i}`, from: 'a@b.test', subject: 's', body: 'b' })
    expect(await h.port.listRecent({ lookbackDays: 2, label: null, max: 2 })).toHaveLength(2)
  })

  it('returns only newer mail after a cursor, and a cursor that has moved forward', async () => {
    const h = make()
    await h.inject({ id: 'o1', threadId: 'to1', from: 'a@b.test', subject: 's', body: 'old' })
    const { historyId } = await h.port.profile()
    await h.inject({ id: 'n1', threadId: 'tn1', from: 'a@b.test', subject: 's', body: 'new' })
    const r = await h.port.listSince(historyId, { label: null, max: 10 })
    if ('expired' in r) throw new Error('unexpected expiry')
    expect(r.ids).toEqual(['n1'])
    const again = await h.port.listSince(r.historyId, { label: null, max: 10 })
    if ('expired' in again) throw new Error('unexpected expiry')
    expect(again.ids).toEqual([])
  })
})

describe('read-only mailbox', () => {
  it.each([
    ['googlePort', () => googleHarness().port],
    ['simPort', () => simPort('u1', memoryS3())],
  ])('%s exposes no way to draft, send or modify mail', (_name, make) => {
    const port = make() as unknown as Record<string, unknown>
    for (const method of ['createDraft', 'updateDraft', 'getDraft', 'sendDraft', 'sendReply', 'modify']) {
      expect(port[method]).toBeUndefined()
    }
  })
})
