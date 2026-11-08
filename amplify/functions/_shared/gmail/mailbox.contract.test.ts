/**
 * Step AG — the MailboxPort additions (`listAfter`, `getAttachment`) hold on both adapters, and
 * neither exposes a write method.
 */
import { describe, expect, it } from 'vitest'
import { FORBIDDEN_MAILBOX_METHODS, type MailboxPort } from '../../../../src/lib/apInbox/mailbox'
import { googlePort } from './googlePort'
import { simInject, simPort, type SimS3 } from './simPort'

const PDF = Buffer.from('%PDF-1.4 fake invoice bytes')

interface Harness {
  port: MailboxPort
  /** Messages are injected oldest first; `at` is the internalDate in ms. */
  inject(id: string, at: number, o?: { labels?: string[]; attach?: boolean }): Promise<void>
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
    port: simPort('ap-inbox', s3),
    inject: async (id, at, o) => {
      await simInject('ap-inbox', {
        id, from: 'a@b.test', subject: 's', body: 'b', internalDate: String(at), labelIds: o?.labels ?? ['INBOX'],
        attachments: o?.attach ? [{ name: 'inv.pdf', contentType: 'application/pdf', size: PDF.length, dataBase64: PDF.toString('base64') }] : [],
      }, s3)
    },
  }
}

function googleHarness(): Harness & { queries: string[] } {
  interface Msg { id: string; at: number; attach: boolean }
  const msgs: Msg[] = []
  const queries: string[] = []
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
  const fetchImpl = (async (input: string) => {
    const url = new URL(input)
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/messages') {
      queries.push(url.searchParams.get('q') ?? '')
      // Gmail answers newest first and honours `after:` server-side.
      const after = Number(/after:(\d+)/.exec(url.searchParams.get('q') ?? '')?.[1] ?? 0)
      return json({ messages: [...msgs].filter((m) => m.at / 1000 >= after).sort((a, b) => b.at - a.at).map((m) => ({ id: m.id })) })
    }
    const att = path.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/)
    if (att) return decodeURIComponent(att[2]) === 'ATT1' ? json({ data: PDF.toString('base64url') }) : json({}, 404)
    const mm = path.match(/^\/messages\/([^/]+)$/)
    if (mm) {
      const m = msgs.find((x) => x.id === decodeURIComponent(mm[1]))
      if (!m) return json({}, 404)
      return json({
        id: m.id, threadId: m.id, internalDate: String(m.at), labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'a@b.test' }],
          parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('hello').toString('base64url') } },
            ...(m.attach
              ? [
                  { mimeType: 'application/pdf', filename: 'inv.pdf', body: { attachmentId: 'ATT1', size: PDF.length } },
                  { mimeType: 'application/pdf', filename: 'small.pdf', body: { data: PDF.toString('base64url'), size: PDF.length } },
                ]
              : []),
          ],
        },
      })
    }
    return json({}, 404)
  }) as unknown as typeof fetch
  return {
    queries,
    port: googlePort('ap-inbox', { fetchImpl, getToken: async () => 'tok', sleep: async () => undefined }),
    inject: async (id, at, o) => void msgs.push({ id, at, attach: o?.attach === true }),
  }
}

describe.each([
  ['googlePort', googleHarness],
  ['simPort', simHarness],
])('MailboxPort contract: %s', (_name, make) => {
  it('listAfter: inclusive boundary, oldest first, the OLDEST max when capped', async () => {
    const h = make()
    await h.inject('m1', 10_000)
    await h.inject('m2', 20_000)
    await h.inject('m3', 30_000)
    expect(await h.port.listAfter({ afterMs: 20_000, max: 10 })).toEqual(['m2', 'm3'])
    expect(await h.port.listAfter({ afterMs: 0, max: 2 })).toEqual(['m1', 'm2'])
  })

  it('getBody lists attachments with an id; getAttachment returns the exact bytes', async () => {
    const h = make()
    await h.inject('m1', 10_000, { attach: true })
    const body = await h.port.getBody('m1')
    const pdf = body.attachments.find((a) => a.name === 'inv.pdf')
    expect(pdf).toBeDefined()
    expect((await h.port.getAttachment('m1', pdf!))?.equals(PDF)).toBe(true)
  })

  it('getAttachment is null for a file that is not there', async () => {
    const h = make()
    await h.inject('m1', 10_000, { attach: true })
    expect(await h.port.getAttachment('m1', { name: 'ghost.pdf', contentType: 'application/pdf', size: 5, id: 'NOPE' })).toBeNull()
  })

  it('has no write method', () => {
    const h = make()
    for (const k of Object.keys(h.port)) expect(k).not.toMatch(FORBIDDEN_MAILBOX_METHODS)
  })
})

describe('adapter specifics', () => {
  it('simPort.listAfter leaves out SENT / DRAFT mail', async () => {
    const h = simHarness()
    await h.inject('in', 10_000)
    await h.inject('out', 11_000, { labels: ['SENT'] })
    await h.inject('draft', 12_000, { labels: ['DRAFT'] })
    expect(await h.port.listAfter({ afterMs: 0, max: 10 })).toEqual(['in'])
  })

  it('googlePort.listAfter asks Gmail to exclude sent and drafts, one second early so the boundary is kept', async () => {
    const h = googleHarness()
    await h.port.listAfter({ afterMs: 20_500, max: 5 })
    expect(h.queries[0]).toBe('after:19 -in:sent -in:drafts')
  })

  it('googlePort reads an inline attachment (no attachmentId) from the message part', async () => {
    const h = googleHarness()
    await h.inject('m1', 10_000, { attach: true })
    const got = await h.port.getAttachment('m1', { name: 'small.pdf', contentType: 'application/pdf', size: PDF.length })
    expect(got?.equals(PDF)).toBe(true)
  })
})
