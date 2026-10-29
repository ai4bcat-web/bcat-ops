/**
 * The rules an inbound provider webhook has to pass before anything is written
 * down: is it signed with the secret we gave that provider, is it recent, and have
 * we already seen this exact delivery.
 *
 * All three are pure, because all three are the kind of thing that must be decided
 * once and tested directly. The handler does the SSM read and the conditional Put;
 * it never grows a second opinion about what a valid signature is.
 *
 * The signed bytes are `${timestamp}.${rawBody}` — the timestamp is inside the MAC,
 * so a replayer cannot move the clock forward on a captured body. The header is
 * `x-bcat-signature: t=<unix seconds>,v1=<hex or base64 digest>`.
 *
 * Imports are relative and `node:crypto` only: the public tracking Lambda bundles
 * this file by path.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * How far from now a delivery's own timestamp may sit. Five minutes each way: long
 * enough for a provider's retry queue and a clock a minute out, short enough that a
 * captured request is worthless by the time it is replayed.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300

export interface WebhookSignature {
  /** Unix seconds, as the provider stamped them. */
  timestamp: number
  /** The digest, still encoded as it arrived. */
  v1: string
}

/** `t=1761700000,v1=ab12…`, in either order, spaces tolerated. Anything else is nothing. */
export function parseSignatureHeader(header: string | null | undefined): WebhookSignature | null {
  if (typeof header !== 'string' || !header.trim()) return null
  let timestamp = Number.NaN
  let v1 = ''
  for (const part of header.split(',')) {
    const at = part.indexOf('=')
    if (at < 0) return null
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (key === 't') timestamp = Number(value)
    else if (key === 'v1') v1 = value
  }
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp) || timestamp <= 0) return null
  if (!v1) return null
  return { timestamp, v1 }
}

/** The digest a provider sends is hex from some, base64 from others; both decode here. */
function decodeDigest(value: string): Buffer | null {
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) return Buffer.from(value, 'hex')
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  }
  return null
}

export type WebhookRefusal = 'NO_SECRET' | 'MALFORMED' | 'STALE' | 'BAD_SIGNATURE'

export type WebhookCheck = { ok: true; timestamp: number } | { ok: false; reason: WebhookRefusal }

export interface WebhookCheckInput {
  header: string | null | undefined
  rawBody: string
  secret: string | null | undefined
  nowIso: string
  toleranceSeconds?: number
}

/**
 * Is this delivery ours, and is it now?
 *
 * The clock is checked before the MAC only in cost, never in trust: both must pass,
 * and the caller answers every refusal with the same wording, so a prober learns
 * neither which secret we hold nor whether the body was ever right.
 */
export function verifyWebhookSignature(input: WebhookCheckInput): WebhookCheck {
  const secret = typeof input.secret === 'string' ? input.secret : ''
  if (!secret) return { ok: false, reason: 'NO_SECRET' }

  const parsed = parseSignatureHeader(input.header)
  if (!parsed) return { ok: false, reason: 'MALFORMED' }

  const now = Date.parse(input.nowIso)
  if (!Number.isFinite(now)) return { ok: false, reason: 'MALFORMED' }
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS
  if (Math.abs(Math.floor(now / 1000) - parsed.timestamp) > tolerance) return { ok: false, reason: 'STALE' }

  const provided = decodeDigest(parsed.v1)
  if (!provided) return { ok: false, reason: 'MALFORMED' }
  const computed = createHmac('sha256', secret).update(`${parsed.timestamp}.${input.rawBody}`, 'utf8').digest()
  if (computed.length !== provided.length || !timingSafeEqual(computed, provided)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }
  return { ok: true, timestamp: parsed.timestamp }
}

/** The signature a sender computes. Used by the tests and by anything that replays a delivery locally. */
export function signWebhookBody(rawBody: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  return `t=${timestamp},v1=${digest}`
}

/**
 * What makes this delivery the same delivery.
 *
 * The provider's own event id when the body carries one — that is the id its retry
 * sends again — and otherwise the hash of the body, which makes a byte-identical
 * re-post a duplicate and a changed one a new event. Trimmed to something that is
 * safe in a partition key.
 */
export function webhookEventId(rawBody: string): string {
  let body: unknown
  try {
    body = JSON.parse(rawBody) as unknown
  } catch {
    body = null
  }
  if (body && typeof body === 'object') {
    const fields = body as Record<string, unknown>
    for (const key of ['id', 'eventId']) {
      const value = fields[key]
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128).replace(/[^\w.:-]/g, '_')
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
  }
  return createHash('sha256').update(rawBody, 'utf8').digest('hex')
}
