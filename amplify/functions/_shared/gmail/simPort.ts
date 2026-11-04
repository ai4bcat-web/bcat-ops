/**
 * Step AB §3.6 — the SIMULATED inbox. Same GmailPort over S3 objects:
 *   spot-sim/<userId>/inbox/<id>.json   (bucket env BUCKET_NAME)
 * Only the Gmail wire is simulated; the pipeline above it is the real one. Read-only,
 * like the real port: there is no draft or send.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import type { GmailMessageMeta, GmailPort } from '../../../../src/lib/spot/port'

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
const key = (userId: string, box: 'inbox', id: string) => `${prefix(userId)}${box}/${safeId(id)}.json`

let counter = 0
const nextSeq = () => Date.now() * 1000 + (counter++ % 1000)

function meta(m: StoredMessage): GmailMessageMeta {
  const { body: _b, attachments: _a, seq: _s, ...rest } = m
  void _b; void _a; void _s
  return rest
}

async function readAll(userId: string, box: 'inbox', s: SimS3): Promise<StoredMessage[]> {
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

  async function find(id: string): Promise<StoredMessage> {
    const raw = await s().get(key(userId, 'inbox', id))
    if (raw) return JSON.parse(raw) as StoredMessage
    throw new Error(`Simulated message ${id} not found.`)
  }

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
      const all = await readAll(userId, 'inbox', s())
      return all.filter((m) => m.threadId === threadId).sort((a, b) => a.seq - b.seq).map(meta)
    },
  }
}
