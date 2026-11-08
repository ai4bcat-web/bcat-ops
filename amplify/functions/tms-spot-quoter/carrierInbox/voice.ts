/**
 * Step AL §5.5 — the voice door: a Function URL on the spot Lambda that the Cowtown voice agent
 * POSTs a call summary to when a call ends. The shared secret (sha256 in the carrier-inbox
 * config, shown to the admin exactly once at rotation) is the only authentication.
 *
 *   POST <url>carrier-call   application/json, <= 256 KB
 *   200 {ok:true, outcome}            filed / dropped (ABANDONED or too short) / not an offer
 *   200 {ok:true, duplicate:true}     the same callSid again
 *   400 invalid · 401 bad secret · 404 other path · 413 too large
 *   503 voice disabled, model unavailable or classification failed — the agent retries with
 *       the same callSid (the router files idempotently on sha1(callSid))
 *
 * Nothing about the live call itself lives here; this only ingests its result.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { resolveCarrierInboxConfig } from '../../../../src/lib/carrierInbox/settings'
import type { CarrierInboxDeps } from './deps'
import { budgetOf, emptyCsStats, processCall, type CarrierCallPayload } from './pipeline'

export const MAX_CALL_BODY_BYTES = 256 * 1024
export const CALL_PATH = '/carrier-call'

export interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string; path?: string }; domainName?: string }
  rawPath?: string
  body?: string | null
  isBase64Encoded?: boolean
}

export interface HttpResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function reply(statusCode: number, body: Record<string, unknown>): HttpResult {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Digest comparison in constant time (the same compare as the AP inbox). */
export function secretMatches(secret: string, secretHash: string): boolean {
  const a = Buffer.from(sha256Hex(secret), 'utf8')
  const b = Buffer.from(secretHash, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null)
const SID = /^[A-Za-z0-9_.:-]{3,80}$/

/** Validates the §5.5 body; returns an error string or the typed payload. */
export function parseCallPayload(raw: unknown, maxTranscriptChars: number): CarrierCallPayload | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'body must be an object'
  const b = raw as Record<string, unknown>
  if (typeof b.callSid !== 'string' || !SID.test(b.callSid)) return 'callSid is required'
  if (typeof b.transcript !== 'string') return 'transcript is required'
  const recording = str(b.recordingUrl, 500)
  return {
    callSid: b.callSid,
    callerNumber: str(b.callerNumber, 40),
    startedAt: str(b.startedAt, 40),
    endedAt: str(b.endedAt, 40),
    durationSec: typeof b.durationSec === 'number' && Number.isFinite(b.durationSec) && b.durationSec >= 0 ? Math.round(b.durationSec) : null,
    outcome: str(b.outcome, 80),
    transcript: b.transcript.slice(0, maxTranscriptChars),
    summary: str(b.summary, 2000),
    // A link only: never fetched, and only https is kept.
    recordingUrl: recording && /^https:\/\//i.test(recording) ? recording : null,
    structured: b.structured && typeof b.structured === 'object' && !Array.isArray(b.structured) ? (b.structured as Record<string, unknown>) : null,
  }
}

export async function handleCarrierCall(event: FunctionUrlEvent, deps: CarrierInboxDeps): Promise<HttpResult> {
  const http = event.requestContext?.http
  const path = (event.rawPath ?? http?.path ?? '').replace(/\/+$/, '')
  if ((http?.method ?? '').toUpperCase() !== 'POST' || !path.endsWith(CALL_PATH)) return reply(404, { ok: false, error: 'not found' })

  const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '')
  if (Buffer.byteLength(text, 'utf8') > MAX_CALL_BODY_BYTES) return reply(413, { ok: false, error: 'too large' })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return reply(400, { ok: false, error: 'invalid JSON' })
  }

  const cfg = resolveCarrierInboxConfig(await deps.store.getConfigRaw())
  const secret = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>).secret : undefined
  const hash = cfg.voice.secretHash
  if (hash) {
    if (typeof secret !== 'string' || !secretMatches(secret, hash)) return reply(401, { ok: false, error: 'unauthorized' })
  }
  if (!hash || !cfg.voice.enabled || !cfg.enabled) return reply(503, { ok: false, error: 'voice intake is not enabled' })

  const payload = parseCallPayload(json, cfg.voice.maxTranscriptChars)
  if (typeof payload === 'string') return reply(400, { ok: false, error: payload })

  const now = deps.now()
  try {
    const state = await deps.store.getState()
    const budget = budgetOf(state, now)
    const before = budget.count
    const stats = emptyCsStats()
    const result = await processCall(deps, cfg, payload, { budget, stats })
    await deps.store.bumpModelCalls(budget.day, budget.count - before)
    const recent = state.voice.lastCallAt && now.getTime() - new Date(state.voice.lastCallAt).getTime() < 86_400_000
    const domain = event.requestContext?.domainName
    await deps.store.patchVoice({
      lastCallAt: now.toISOString(),
      calls24h: recent ? state.voice.calls24h + 1 : 1,
      lastError: null,
      ...(state.voice.urlSeenAt || !domain ? {} : { urlSeenAt: now.toISOString(), url: `https://${domain}/` }),
    })
    if (result.outcome === 'DUPLICATE') return reply(200, { ok: true, duplicate: true })
    return reply(200, { ok: true, outcome: result.outcome })
  } catch (err) {
    // Detail stays in the log; the agent only needs to know to retry with the same callSid.
    console.warn('[carrier-inbox] call intake failed:', err instanceof Error ? err.message.slice(0, 200) : 'error')
    await deps.store.patchVoice({ lastError: `${now.toISOString()}: the last call could not be classified or filed; the agent should retry` }).catch(() => undefined)
    return reply(503, { ok: false, error: 'try again' })
  }
}
