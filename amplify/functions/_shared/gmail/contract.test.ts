/**
 * One behavioural contract, two adapters: whatever the spot pipeline relies on from a
 * GmailPort must hold for the Google adapter (against a fake Gmail wire) and for the
 * simulated inbox (against in-memory S3).
 */
import { describe, it, expect } from 'vitest'
import type { GmailPort } from '../../../../src/lib/spot/port'
import { googlePort } from './googlePort'
import { simInject, simMarkDraftSent, simPort, type SimS3 } from './simPort'

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

/** A tiny in-memory Gmail: messages, drafts, history. Speaks only the routes the port uses. */
function googleHarness(): Harness {
  interface Msg { id: string; threadId: string; internalDate: string; labelIds: string[]; from: string; subject: string; body: string }
  const messages: Msg[] = []
  const drafts = new Map<string, { id: string; message: { id: string; threadId?: string; raw: string } }>()
  let history = 100
  let n = 0

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
    const body = init?.body ? (JSON.parse(String(init.body)) as { message?: { raw?: string; threadId?: string } }) : null
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
    if (path === '/drafts' && method === 'POST') {
      const id = `d${++n}`
      drafts.set(id, { id, message: { id: `dm${n}`, threadId: body?.message?.threadId, raw: body?.message?.raw ?? '' } })
      return json({ id, message: { id: `dm${n}` } })
    }
    const dm = path.match(/^\/drafts\/([^/]+)$/)
    if (dm) {
      const d = drafts.get(dm[1])
      if (method === 'PUT') {
        if (!d) return json({}, 404)
        d.message.raw = body?.message?.raw ?? ''
        return json({ id: d.id })
      }
      if (!d) return json({}, 404)
      const raw = Buffer.from(d.message.raw, 'base64url').toString('utf8')
      const [head, ...rest] = raw.split('\r\n\r\n')
      const hv = (name: string) => head.split('\r\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? ''
      return json({ id: d.id, message: { payload: { headers: [{ name: 'To', value: hv('To') }, { name: 'Subject', value: hv('Subject') }], mimeType: 'text/plain', body: { data: b64(rest.join('\r\n\r\n').replace(/=\r\n/g, '')) } } } })
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

  it('creates, reads, updates a draft; a missing draft says it does not exist', async () => {
    const h = make()
    const out = { threadId: 't1', to: 'pat@acme.test', subject: 'Re: Rate', inReplyTo: '<m1@x>', references: '<m1@x>', text: 'Rate is $2,450.' }
    const { draftId } = await h.port.createDraft(out)
    expect(draftId).toBeTruthy()
    expect(await h.port.getDraft(draftId)).toMatchObject({ exists: true, to: 'pat@acme.test', subject: 'Re: Rate' })
    expect((await h.port.getDraft(draftId)).text).toContain('$2,450')
    await h.port.updateDraft(draftId, { ...out, text: 'Rate is $2,500.' })
    expect((await h.port.getDraft(draftId)).text).toContain('$2,500')
    expect((await h.port.getDraft('nope')).exists).toBe(false)
  })
})

describe('simPort send safety', () => {
  it('refuses to send and moves a draft to SENT only through the harness hook', async () => {
    const s3 = memoryS3()
    const port = simPort('u1', s3)
    const { draftId } = await port.createDraft({ threadId: 't9', to: 'x@y.test', subject: 'Re: x', inReplyTo: null, references: null, text: 'hi' })
    await expect(port.sendDraft(draftId)).rejects.toThrow(/disabled/)
    await expect(port.sendReply({ threadId: null, to: 'x@y.test', subject: 's', inReplyTo: null, references: null, text: 't' })).rejects.toThrow(/disabled/)
    expect((await port.getDraft(draftId)).exists).toBe(true)

    await simMarkDraftSent('u1', draftId, s3)
    expect((await port.getDraft(draftId)).exists).toBe(false)
    const thread = await port.threadMessages('t9')
    expect(thread.map((m) => m.labelIds)).toEqual([['SENT']])
  })
})
