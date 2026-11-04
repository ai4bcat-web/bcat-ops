/**
 * Step AB §3.6 — the SIMULATED inbox. Same GmailPort over S3 objects:
 *   spot-sim/<userId>/{inbox,drafts,sent}/<id>.json   (bucket env BUCKET_NAME)
 * Only the Gmail wire is simulated; the pipeline above it is the real one. Sending is
 * refused here: the harness emulates the rep pressing Send with `simMarkDraftSent`.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import type { GmailMessageMeta, GmailPort, OutgoingReply } from '../../../../src/lib/spot/port'

/** The subset of S3 this adapter uses; tests pass an in-memory implementation. */
export interface SimS3 {
  get(key: string): Promise<string | null>
  put(key: string, body: string): Promise<void>
  del(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

export interface SimInboxMessage {
  id?: string
  threadId?: string
  /** Epoch ms as string; defaults to now. */
  internalDate?: string
  from: string
  to?: string[]
  cc?: string[]
  replyTo?: string | null
  subject: string
  messageId?: string
  inReplyTo?: string | null
  references?: string | null
  snippet?: string
  labelIds?: string[]
  headers?: Record<string, string>
  body: string
  attachments?: { name: string; contentType: string; size: number }[]
}

interface StoredMessage extends GmailMessageMeta {
  body: string
  attachments: { name: string; contentType: string; size: number }[]
  seq: number
}

interface StoredDraft { id: string; messageId: string; threadId: string | null; to: string; subject: string; text: string; inReplyTo: string | null; references: string | null; draftedAt: string }

export function s3SimStore(client: S3Client = new S3Client({}), bucket = process.env.BUCKET_NAME ?? ''): SimS3 {
  return {
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return (await r.Body?.transformToString()) ?? null
      } catch (err) {
        if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null
        throw err
      }
    },
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }))
    },
    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },
    async list(prefix) {
      const keys: string[] = []
      let token: string | undefined
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key)
        token = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (token)
      return keys
    },
  }
}

let defaultStore: SimS3 | null = null
const store = (s?: SimS3): SimS3 => s ?? (defaultStore ??= s3SimStore())

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, '_')
const prefix = (userId: string) => `spot-sim/${safeId(userId)}/`
const key = (userId: string, box: 'inbox' | 'drafts' | 'sent', id: string) => `${prefix(userId)}${box}/${safeId(id)}.json`

let counter = 0
const nextSeq = () => Date.now() * 1000 + (counter++ % 1000)

function meta(m: StoredMessage): GmailMessageMeta {
  const { body: _b, attachments: _a, seq: _s, ...rest } = m
  void _b; void _a; void _s
  return rest
}

async function readAll(userId: string, box: 'inbox' | 'sent', s: SimS3): Promise<StoredMessage[]> {
  const out: StoredMessage[] = []
  for (const k of await s.list(`${prefix(userId)}${box}/`)) {
    const raw = await s.get(k)
    if (raw) out.push(JSON.parse(raw) as StoredMessage)
  }
  return out.sort((a, b) => a.seq - b.seq)
}

export async function simInject(userId: string, msg: SimInboxMessage, s3?: SimS3): Promise<{ id: string }> {
  const seq = nextSeq()
  const id = msg.id ?? `sim-${seq}`
  const stored: StoredMessage = {
    id,
    threadId: msg.threadId ?? `thr-${id}`,
    internalDate: msg.internalDate ?? String(Date.now()),
    from: msg.from,
    to: msg.to ?? [],
    cc: msg.cc ?? [],
    replyTo: msg.replyTo ?? null,
    subject: msg.subject,
    messageId: msg.messageId ?? `<${id}@sim.invalid>`,
    inReplyTo: msg.inReplyTo ?? null,
    references: msg.references ?? null,
    snippet: msg.snippet ?? msg.body.replace(/\s+/g, ' ').slice(0, 160),
    labelIds: msg.labelIds ?? ['INBOX'],
    headers: msg.headers ?? {},
    body: msg.body,
    attachments: msg.attachments ?? [],
    seq,
  }
  await store(s3).put(key(userId, 'inbox', id), JSON.stringify(stored))
  return { id }
}

/** "The rep pressed Send in Gmail": the draft leaves drafts/ and becomes a SENT message. */
export async function simMarkDraftSent(userId: string, draftId: string, s3?: SimS3): Promise<{ messageId: string }> {
  const s = store(s3)
  const raw = await s.get(key(userId, 'drafts', draftId))
  if (!raw) throw new Error('That draft no longer exists.')
  const d = JSON.parse(raw) as StoredDraft
  const seq = nextSeq()
  const sent: StoredMessage = {
    id: d.messageId,
    threadId: d.threadId ?? `thr-${d.messageId}`,
    internalDate: String(Date.now()),
    from: 'me',
    to: [d.to],
    cc: [],
    replyTo: null,
    subject: d.subject,
    messageId: `<${d.messageId}@sim.invalid>`,
    inReplyTo: d.inReplyTo,
    references: d.references,
    snippet: d.text.replace(/\s+/g, ' ').slice(0, 160),
    labelIds: ['SENT'],
    headers: {},
    body: d.text,
    attachments: [],
    seq,
  }
  await s.put(key(userId, 'sent', d.messageId), JSON.stringify(sent))
  await s.del(key(userId, 'drafts', draftId))
  return { messageId: d.messageId }
}

async function purge(userId: string, s3: SimS3 | undefined, only?: (k: string) => boolean): Promise<{ deleted: number }> {
  const s = store(s3)
  let deleted = 0
  for (const k of await s.list(prefix(userId))) {
    if (only && !only(k)) continue
    await s.del(k)
    deleted++
  }
  return { deleted }
}

export const simReset = (userId: string, s3?: SimS3) => purge(userId, s3)

/** Only objects whose id starts with `zz-` (the harness's own fixtures). */
export const simPurgeTest = (userId: string, s3?: SimS3) =>
  purge(userId, s3, (k) => (k.split('/').pop() ?? '').startsWith('zz-'))

export function simPort(userId: string, s3?: SimS3): GmailPort {
  const s = () => store(s3)
  const SEND_REFUSED = 'Sending is disabled in the simulated inbox'

  async function find(id: string): Promise<StoredMessage> {
    for (const box of ['inbox', 'sent'] as const) {
      const raw = await s().get(key(userId, box, id))
      if (raw) return JSON.parse(raw) as StoredMessage
    }
    throw new Error(`Simulated message ${id} not found.`)
  }

  const draftToStored = (d: OutgoingReply, id: string, messageId: string): StoredDraft => ({
    id,
    messageId,
    threadId: d.threadId,
    to: d.to,
    subject: d.subject,
    text: d.text,
    inReplyTo: d.inReplyTo,
    references: d.references,
    draftedAt: new Date().toISOString(),
  })

  return {
    async profile() {
      const all = await readAll(userId, 'inbox', s())
      const last = all.length ? all[all.length - 1].seq : 0
      return { emailAddress: `${userId}@simulated.invalid`, historyId: String(last) }
    },

    async listRecent({ lookbackDays, label, max }) {
      const cutoff = Date.now() - lookbackDays * 86_400_000
      const all = await readAll(userId, 'inbox', s())
      return all
        .filter((m) => Number(m.internalDate) >= cutoff)
        .filter((m) => !label || m.labelIds.includes(label))
        .slice(0, max)
        .map((m) => m.id)
    },

    async listSince(historyId, { label, max }) {
      const since = Number(historyId) || 0
      const all = (await readAll(userId, 'inbox', s())).filter((m) => m.seq > since && (!label || m.labelIds.includes(label)))
      const page = all.slice(0, max)
      const next = all.length > page.length ? page[page.length - 1].seq : (all[all.length - 1]?.seq ?? since)
      return { ids: page.map((m) => m.id), historyId: String(next) }
    },

    async getMetadata(id) {
      return meta(await find(id))
    },

    async getBody(id) {
      const m = await find(id)
      return { text: m.body, attachments: m.attachments }
    },

    async threadMessages(threadId) {
      const all = [...(await readAll(userId, 'inbox', s())), ...(await readAll(userId, 'sent', s()))]
      return all.filter((m) => m.threadId === threadId).sort((a, b) => a.seq - b.seq).map(meta)
    },

    async createDraft(d) {
      const seq = nextSeq()
      const id = `sim-draft-${seq}`
      const messageId = `sim-msg-${seq}`
      await s().put(key(userId, 'drafts', id), JSON.stringify(draftToStored(d, id, messageId)))
      return { draftId: id, messageId }
    },

    async updateDraft(draftId, d) {
      const raw = await s().get(key(userId, 'drafts', draftId))
      if (!raw) throw new Error('That draft no longer exists.')
      const prev = JSON.parse(raw) as StoredDraft
      await s().put(key(userId, 'drafts', draftId), JSON.stringify(draftToStored(d, draftId, prev.messageId)))
    },

    async getDraft(draftId) {
      const raw = await s().get(key(userId, 'drafts', draftId))
      if (!raw) return { exists: false, to: '', subject: '', text: '' }
      const d = JSON.parse(raw) as StoredDraft
      return { exists: true, to: d.to, subject: d.subject, text: d.text }
    },

    async sendDraft() {
      throw new Error(SEND_REFUSED)
    },

    async sendReply() {
      throw new Error(SEND_REFUSED)
    },
  }
}
