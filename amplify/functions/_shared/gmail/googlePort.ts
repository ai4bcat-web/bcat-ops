/**
 * Step AB §9.2 — GmailPort over the Gmail REST API (`fetch`, no SDK dependency).
 *
 * Bearer token per rep from tokens.ts. 429/5xx are retried twice with jitter; a 401
 * refreshes the token once; `invalid_grant` surfaces as NeedsReconnect (from tokens.ts).
 * Message bodies and tokens are never logged or put into an error message.
 */
import type { GmailMessageMeta, GmailPort, OutgoingReply } from '../../../../src/lib/spot/port'
import { GMAIL_HEADER_ALLOWLIST } from '../../../../src/lib/spot/port'
import { GmailApiError } from './errors'
import { base64Url, buildMime } from './mime'
import { forgetAccessToken, getAccessToken } from './tokens'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface GooglePortDeps {
  fetchImpl?: typeof fetch
  getToken?: (userId: string) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

type Json = Record<string, unknown>

interface GmailHeader { name?: string; value?: string }
interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}
interface GmailMessage {
  id?: string
  threadId?: string
  internalDate?: string
  snippet?: string
  labelIds?: string[]
  payload?: GmailPart
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : ''
}

function headerMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of headers ?? []) {
    if (h.name && typeof h.value === 'string') out[h.name.toLowerCase()] = h.value
  }
  return out
}

function addresses(v: string | undefined): string[] {
  if (!v) return []
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

function toMeta(m: GmailMessage): GmailMessageMeta {
  const h = headerMap(m.payload?.headers)
  const allowed: Record<string, string> = {}
  for (const k of GMAIL_HEADER_ALLOWLIST) if (h[k] !== undefined) allowed[k] = h[k]
  return {
    id: m.id ?? '',
    threadId: m.threadId ?? '',
    internalDate: m.internalDate ?? '',
    from: h.from ?? '',
    to: addresses(h.to),
    cc: addresses(h.cc),
    replyTo: h['reply-to'] ?? null,
    subject: h.subject ?? '',
    messageId: h['message-id'] ?? '',
    inReplyTo: h['in-reply-to'] ?? null,
    references: h.references ?? null,
    snippet: m.snippet ?? '',
    labelIds: m.labelIds ?? [],
    headers: allowed,
  }
}

function collect(part: GmailPart | undefined, acc: { plain: string[]; html: string[]; files: { name: string; contentType: string; size: number }[] }): void {
  if (!part) return
  if (part.filename) {
    acc.files.push({ name: part.filename, contentType: part.mimeType ?? 'application/octet-stream', size: part.body?.size ?? 0 })
  } else if (part.mimeType === 'text/plain' && part.body?.data) {
    acc.plain.push(decode(part.body.data))
  } else if (part.mimeType === 'text/html' && part.body?.data) {
    acc.html.push(decode(part.body.data))
  }
  for (const p of part.parts ?? []) collect(p, acc)
}

export function googlePort(userId: string, deps: GooglePortDeps = {}): GmailPort {
  const doFetch = deps.fetchImpl ?? fetch
  const getToken = deps.getToken ?? ((u: string) => getAccessToken(u))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let labelIds: Map<string, string> | null = null

  async function api(method: string, path: string, body?: unknown, allow404 = false): Promise<Json | null> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const token = await getToken(userId)
      const res = await doFetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.ok) {
        const text = await res.text()
        return text ? (JSON.parse(text) as Json) : {}
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true
        forgetAccessToken(userId)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 100))
        continue
      }
      if (res.status === 404 && allow404) return null
      // Status only: a Gmail error body can quote request content.
      throw new GmailApiError(res.status, `Gmail answered HTTP ${res.status} for ${method} ${path.split('?')[0]}.`)
    }
  }

  async function resolveLabelId(name: string): Promise<string | null> {
    if (!labelIds) {
      const r = await api('GET', '/labels')
      labelIds = new Map()
      for (const l of ((r?.labels as { id?: string; name?: string }[] | undefined) ?? [])) {
        if (l.id && l.name) labelIds.set(l.name.toLowerCase(), l.id)
      }
    }
    return labelIds.get(name.toLowerCase()) ?? null
  }

  const metaQuery = (): string => {
    const q = new URLSearchParams({ format: 'metadata' })
    const s = q.toString()
    return `${s}${[...GMAIL_HEADER_ALLOWLIST, 'from', 'to', 'cc', 'reply-to', 'subject'].map((h) => `&metadataHeaders=${encodeURIComponent(h)}`).join('')}`
  }

  async function sendRaw(path: string, payload: Json): Promise<string> {
    const r = await api('POST', path, payload)
    return String((r?.id as string | undefined) ?? '')
  }

  const rawOf = (d: OutgoingReply) => base64Url(buildMime(d))

  return {
    async profile() {
      const r = await api('GET', '/profile')
      return { emailAddress: String(r?.emailAddress ?? ''), historyId: String(r?.historyId ?? '') }
    },

    async listRecent({ lookbackDays, label, max }) {
      const days = Math.max(1, Math.min(30, Math.floor(lookbackDays)))
      const safeLabel = label ? label.replace(/["\\]/g, '') : ''
      const q = `in:inbox newer_than:${days}d${safeLabel ? ` label:"${safeLabel}"` : ''}`
      const ids: string[] = []
      let pageToken: string | undefined
      do {
        const p = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) })
        if (pageToken) p.set('pageToken', pageToken)
        const r = await api('GET', `/messages?${p.toString()}`)
        for (const m of ((r?.messages as { id?: string }[] | undefined) ?? [])) if (m.id) ids.push(m.id)
        pageToken = r?.nextPageToken as string | undefined
      } while (pageToken && ids.length < max)
      return ids.slice(0, max)
    },

    async listSince(historyId, { label, max }) {
      const labelId = label ? await resolveLabelId(label) : 'INBOX'
      if (label && !labelId) return { ids: [], historyId }
      const ids: string[] = []
      const seen = new Set<string>()
      let latest = historyId
      let pageToken: string | undefined
      do {
        const p = new URLSearchParams({ startHistoryId: historyId, historyTypes: 'messageAdded', labelId: labelId ?? 'INBOX' })
        if (pageToken) p.set('pageToken', pageToken)
        const r = await api('GET', `/history?${p.toString()}`, undefined, true)
        if (r === null) return { expired: true }
        for (const h of ((r.history as { messagesAdded?: { message?: { id?: string } }[] }[] | undefined) ?? [])) {
          for (const a of h.messagesAdded ?? []) {
            const id = a.message?.id
            if (id && !seen.has(id)) {
              seen.add(id)
              ids.push(id)
            }
          }
        }
        if (typeof r.historyId === 'string') latest = r.historyId
        pageToken = r.nextPageToken as string | undefined
      } while (pageToken && ids.length < max)
      // Only advance the cursor past what was actually returned.
      if (ids.length > max) return { ids: ids.slice(0, max), historyId }
      return { ids, historyId: latest }
    },

    async getMetadata(id) {
      const r = await api('GET', `/messages/${encodeURIComponent(id)}?${metaQuery()}`)
      return toMeta(r as GmailMessage)
    },

    async getBody(id) {
      const r = (await api('GET', `/messages/${encodeURIComponent(id)}?format=full`)) as GmailMessage
      const acc = { plain: [] as string[], html: [] as string[], files: [] as { name: string; contentType: string; size: number }[] }
      collect(r.payload, acc)
      const text = acc.plain.length ? acc.plain.join('\n') : stripHtml(acc.html.join('\n'))
      return { text, attachments: acc.files }
    },

    async threadMessages(threadId) {
      const r = await api('GET', `/threads/${encodeURIComponent(threadId)}?${metaQuery()}`)
      return ((r?.messages as GmailMessage[] | undefined) ?? []).map(toMeta)
    },

    async createDraft(d) {
      const r = await api('POST', '/drafts', { message: { raw: rawOf(d), ...(d.threadId ? { threadId: d.threadId } : {}) } })
      return { draftId: String(r?.id ?? ''), messageId: String((r?.message as { id?: string } | undefined)?.id ?? '') }
    },

    async updateDraft(draftId, d) {
      await api('PUT', `/drafts/${encodeURIComponent(draftId)}`, {
        message: { raw: rawOf(d), ...(d.threadId ? { threadId: d.threadId } : {}) },
      })
    },

    async getDraft(draftId) {
      const r = await api('GET', `/drafts/${encodeURIComponent(draftId)}?format=full`, undefined, true)
      if (!r) return { exists: false, to: '', subject: '', text: '' }
      const msg = r.message as GmailMessage | undefined
      const h = headerMap(msg?.payload?.headers)
      const acc = { plain: [] as string[], html: [] as string[], files: [] as { name: string; contentType: string; size: number }[] }
      collect(msg?.payload, acc)
      return {
        exists: true,
        to: h.to ?? '',
        subject: h.subject ?? '',
        text: acc.plain.length ? acc.plain.join('\n') : stripHtml(acc.html.join('\n')),
      }
    },

    async sendDraft(draftId) {
      return { messageId: await sendRaw('/drafts/send', { id: draftId }) }
    },

    async sendReply(d) {
      return { messageId: await sendRaw('/messages/send', { raw: rawOf(d), ...(d.threadId ? { threadId: d.threadId } : {}) }) }
    },
  }
}
