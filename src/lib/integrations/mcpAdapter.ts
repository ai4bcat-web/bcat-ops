/**
 * Step N2 — the MyCarrierPackets live adapter, written to MCP's published
 * Integration Guide (https://mycarrierpackets.com/IntegrationGuide) and its swagger
 * (https://api.mycarrierpackets.com/swagger/docs/v1). See Docs/tms-build/MCP_INTEGRATION.md.
 *
 * - Auth: POST /token, grant_type=password, the customer integration username and password.
 *   The bearer token is cached in memory until shortly before it expires and refreshed once
 *   on a 401. Validate never uses the cache: it always proves the password itself.
 * - Lookup: POST /api/v1/Carrier/GetCarrierData (packet data included), falling back to
 *   PreviewCarrier. Both are POSTs with the identifiers in the query string.
 * - Invite: POST /api/v1/Carrier/EmailPacketInvitation. Only ever called by a person's action.
 * - There are no webhooks in the guide: completion is polled (CompletedPackets, CarriersChanges).
 * - 429 / 502 / 503 / 504 are retried with exponential backoff (Retry-After honoured).
 *
 * Nothing here ever puts the username or password in a message, a log line or an error.
 */
import { healthFrom, isNeutered } from './health'
import type { ValidateOutcome } from './health'
import type { Adapter, AdapterContext, AdapterResult, Health } from './types'

export const MCP_BASE = 'https://api.mycarrierpackets.com'
const TIMEOUT_MS = 10_000
const TOKEN_SKEW_MS = 60_000
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000
const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

// ── MCP shapes ───────────────────────────────────────────────────────────────

export type McpCarrierStatus =
  | 'NOT_INVITED'
  | 'INVITED'
  | 'IN_PROGRESS'
  | 'PENDING_REVIEW'
  | 'ACCEPTABLE'
  | 'MODERATE'
  | 'UNACCEPTABLE'
  | 'UNACCEPTABLE_REVIEW'

export type McpReviewStatus = 'ACCEPTABLE' | 'MODERATE' | 'UNACCEPTABLE' | 'UNACCEPTABLE_REVIEW'

export type McpSafetyRating = 'SATISFACTORY' | 'CONDITIONAL' | 'UNSATISFACTORY'

export interface McpInsuranceSide {
  expiresAt: string
  limitCents?: number
  active: boolean
  company?: string
  policyNumber?: string
}

export interface McpInsurance {
  cargo?: McpInsuranceSide
  liability?: McpInsuranceSide
}

export interface McpCarrier {
  mcNumber: string
  dotNumber?: string
  status: McpCarrierStatus
  reviewStatus?: McpReviewStatus
  riskAssessmentPoints?: number
  safetyRating?: McpSafetyRating
  authorityStatus?: 'ACTIVE' | 'INACTIVE'
  insurance?: McpInsurance
  packetCompletedAt?: string
}

export interface McpSetupPacketInput {
  email: string
  carrierName?: string
  carrierMc?: string
  carrierDot?: string
  /** The MCP user the invitation is sent on behalf of (guide: recommended). */
  invitedBy?: string
}

export interface McpCarrierRef {
  mcNumber?: string
  dotNumber?: string
}

export interface McpClientOptions {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  maxAttempts?: number
}

interface McpCredentials {
  username: string
  password: string
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type McpErrorKind = 'AUTH' | 'RATE_LIMIT' | 'SERVER' | 'NETWORK' | 'CLIENT'

export class McpApiError extends Error {
  readonly kind: McpErrorKind
  readonly status?: number
  readonly retryAfterMs?: number

  constructor(message: string, kind: McpErrorKind, status?: number, retryAfterMs?: number) {
    super(message)
    this.name = 'McpApiError'
    this.kind = kind
    this.status = status
    this.retryAfterMs = retryAfterMs
  }

  get retryable(): boolean {
    return this.kind === 'RATE_LIMIT' || (this.kind === 'SERVER' && (this.status === 502 || this.status === 503 || this.status === 504))
  }
}

// ── Credentials, token cache, raw HTTP ───────────────────────────────────────────

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()

/** Test seam, and the right thing to call after a credential rotation. */
export function clearMcpTokenCache(): void {
  tokenCache.clear()
}

const cacheKey = (c: McpCredentials): string => `${c.username}\u0000${c.password}`

function credsOf(credentials: Record<string, string | null | undefined>): McpCredentials | null {
  const username = (credentials.username ?? '').trim()
  const password = credentials.password ?? ''
  return username && password.trim() ? { username, password } : null
}

function requireCreds(credentials: Record<string, string | null | undefined>): McpCredentials {
  const creds = credsOf(credentials)
  if (!creds) throw new Error('MyCarrierPackets username and password are required')
  return creds
}

function redact(text: string, creds: McpCredentials): string {
  let out = text
  for (const secret of [creds.password, creds.username]) {
    if (secret) out = out.split(secret).join('***')
  }
  return out
}

function kindOfStatus(status: number): McpErrorKind {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'CLIENT'
}

function retryAfterOf(res: Response): number | undefined {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS)
}

async function timedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, creds: McpCredentials): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    throw new McpApiError(
      aborted ? `No answer from MyCarrierPackets within ${TIMEOUT_MS / 1000}s.` : redact(`Could not reach MyCarrierPackets: ${err instanceof Error ? err.message : String(err)}`, creds),
      'NETWORK',
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Retry only what is worth retrying; everything else surfaces at once. */
async function withBackoff<T>(work: () => Promise<T>, opts: McpClientOptions | undefined): Promise<T> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const attempts = Math.max(1, opts?.maxAttempts ?? MAX_ATTEMPTS)
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      if (!(err instanceof McpApiError) || !err.retryable || attempt >= attempts) throw err
      await sleep(err.retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS))
    }
  }
}

async function requestToken(creds: McpCredentials, fetchImpl: typeof fetch, now: () => number): Promise<CachedToken> {
  const res = await timedFetch(
    fetchImpl,
    `${MCP_BASE}/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'password', username: creds.username, password: creds.password }).toString(),
    },
    creds,
  )
  if (!res.ok) {
    // The OWIN token endpoint answers a bad password with 400 {"error":"invalid_grant"}.
    const kind = res.status === 400 ? 'AUTH' : kindOfStatus(res.status)
    let code = ''
    try {
      const body = JSON.parse(await res.text()) as { error?: unknown }
      if (typeof body.error === 'string') code = redact(body.error.slice(0, 40), creds)
    } catch {
      // Not JSON: the HTTP code alone is the message.
    }
    throw new McpApiError(`MyCarrierPackets token request failed (HTTP ${res.status}${code ? ` ${code}` : ''})`, kind, res.status, retryAfterOf(res))
  }
  let json: { access_token?: unknown; expires_in?: unknown }
  try {
    json = (await res.json()) as typeof json
  } catch {
    throw new McpApiError('MyCarrierPackets token response was not JSON', 'SERVER', res.status)
  }
  const token = typeof json.access_token === 'string' ? json.access_token : ''
  if (!token) throw new McpApiError('MyCarrierPackets token response carried no access_token', 'SERVER', res.status)
  const seconds = Number(json.expires_in)
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TOKEN_TTL_MS
  return { token, expiresAt: now() + (ttl > TOKEN_SKEW_MS ? ttl - TOKEN_SKEW_MS : ttl / 2) }
}

async function getToken(creds: McpCredentials, fetchImpl: typeof fetch, opts: McpClientOptions | undefined, force: boolean): Promise<string> {
  const now = opts?.now ?? Date.now
  const key = cacheKey(creds)
  if (!force) {
    const hit = tokenCache.get(key)
    if (hit && hit.expiresAt > now()) return hit.token
  }
  const fresh = await withBackoff(() => requestToken(creds, fetchImpl, now), opts)
  tokenCache.set(key, fresh)
  return fresh.token
}

export interface McpPagination {
  pageNumber: number
  pageSize: number
  totalPages: number
  totalCount: number
}

interface McpRawResponse {
  body: unknown
  /** HTTP status of the answer (always 2xx here: anything else throws). */
  status: number
  /** The `X-Pagination` response header the guide describes, when present. */
  pagination: McpPagination | null
}

function paginationOf(res: Response): McpPagination | null {
  const raw = res.headers?.get?.('x-pagination')
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return { pageNumber: n(p.pageNumber), pageSize: n(p.pageSize), totalPages: n(p.totalPages), totalCount: n(p.totalCount) }
  } catch {
    return null
  }
}

/** One authenticated POST. Identifiers travel in the query string, as the guide shows. */
async function mcpPostRaw(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  creds: McpCredentials,
  fetchImpl: typeof fetch,
  opts?: McpClientOptions,
): Promise<McpRawResponse> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v))
  const url = `${MCP_BASE}${path}${params.size ? `?${params.toString()}` : ''}`
  let token = await getToken(creds, fetchImpl, opts, false)
  let refreshed = false

  return withBackoff(async () => {
    let res = await timedFetch(fetchImpl, url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, creds)
    if (res.status === 401 && !refreshed) {
      refreshed = true
      tokenCache.delete(cacheKey(creds))
      token = await getToken(creds, fetchImpl, opts, true)
      res = await timedFetch(fetchImpl, url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, creds)
    }
    if (!res.ok) throw new McpApiError(`MyCarrierPackets ${path} failed (HTTP ${res.status})`, kindOfStatus(res.status), res.status, retryAfterOf(res))
    const raw = await res.text()
    const pagination = paginationOf(res)
    if (!raw.trim()) return { body: null, status: res.status, pagination }
    try {
      return { body: JSON.parse(raw) as unknown, status: res.status, pagination }
    } catch {
      throw new McpApiError(`MyCarrierPackets ${path} answered with something that is not JSON`, 'SERVER', res.status)
    }
  }, opts)
}

async function mcpPost(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  creds: McpCredentials,
  fetchImpl: typeof fetch,
  opts?: McpClientOptions,
): Promise<unknown> {
  return (await mcpPostRaw(path, query, creds, fetchImpl, opts)).body
}

// ── Validate ─────────────────────────────────────────────────────────────────

/**
 * Prove the credential with one token call, outcome shaped for `healthFrom`:
 * token 200 → OK; 400/401/403 → INVALID_CREDENTIALS; anything else → UNABLE_TO_VERIFY with
 * the HTTP code only. No retries and no cache: this is the answer the Validate button gives.
 * A missing or neutered credential makes no call at all.
 */
export async function validateMcpCredentials(
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<ValidateOutcome> {
  const creds = credsOf(credentials)
  if (!creds) {
    return { kind: 'SKIPPED', reason: 'NO_CREDENTIALS', message: 'MyCarrierPackets username and password are required; no call was made.' }
  }
  if (isNeutered(creds.username) || isNeutered(creds.password)) {
    return { kind: 'SKIPPED', reason: 'NEUTERED_ON_DEV', message: 'Credentials are neutered on this stack; no call was made.' }
  }
  try {
    await getToken(creds, fetchImpl, { ...opts, maxAttempts: 1 }, true)
    return { kind: 'HTTP', statusCode: 200 }
  } catch (err) {
    if (err instanceof McpApiError) {
      if (err.kind === 'AUTH') {
        return { kind: 'HTTP', statusCode: 401, message: 'MyCarrierPackets rejected the integration username or password.' }
      }
      if (err.kind === 'NETWORK') return { kind: 'ERROR', errorName: 'NetworkError', message: err.message }
      return { kind: 'HTTP', statusCode: err.status ?? 502 }
    }
    return { kind: 'ERROR', errorName: 'Error', message: redact(err instanceof Error ? err.message : String(err), creds) }
  }
}

// ── Mapping: MCP DTOs → BCAT vocabulary ───────────────────────────────────────

type Rec = Record<string, unknown>

/** Case-insensitive field read: the API mixes PascalCase and camelCase DTOs. */
export function field(o: unknown, name: string): unknown {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
  const rec = o as Rec
  if (name in rec) return rec[name]
  const lower = name.toLowerCase()
  for (const k of Object.keys(rec)) if (k.toLowerCase() === lower) return rec[k]
  return undefined
}

export const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined)
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const flat = (v: string | undefined): string => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function isoOf(v: unknown): string | undefined {
  const s = text(v)
  if (!s) return undefined
  // MCP sends zone-less timestamps ("2026-10-20T09:30:00"); read them as UTC [INFERENCE], not server-local.
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  const at = us ? Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2])) : Date.parse(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? `${s}Z` : s)
  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
}

/** "MC-123" / "123" → "MC123"; FF and MX prefixes are kept. */
export function docketOf(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim().toUpperCase().replace(/[\s-]/g, '')
  if (!s) return undefined
  if (/^\d+$/.test(s)) return `MC${s}`
  return s
}

export function dotOf(raw: string | undefined): string | undefined {
  const digits = (raw ?? '').replace(/\D/g, '')
  return digits || undefined
}

/**
 * The packet stage a CarrierPacketStatus string describes. 'COMPLETED' means "the carrier
 * finished the packet"; the risk assessment then decides which completed status it is.
 * Unrecognised text is null — never evidence of a packet.
 */
export function mapPacketStatus(raw: string | undefined): 'NOT_INVITED' | 'INVITED' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'COMPLETED' | null {
  const s = flat(raw)
  if (!s) return null
  if (/notinvited|nopacket|^none$/.test(s)) return 'NOT_INVITED'
  if (/pendingreview|underreview|inreview/.test(s)) return 'PENDING_REVIEW'
  if (/incomplete|inprogress|started|partial/.test(s)) return 'IN_PROGRESS'
  if (/complete|submitted|received/.test(s)) return 'COMPLETED'
  if (/invit|sent|pending/.test(s)) return 'INVITED'
  return null
}

/**
 * Risk assessment overall rating + review state → one of our completed statuses.
 * A rating we cannot read is PENDING_REVIEW: completed, not approved.
 */
export function mapRiskStanding(overall: string | undefined, reviewState: string | undefined): McpReviewStatus | 'PENDING_REVIEW' {
  const o = flat(overall)
  const r = flat(reviewState)
  let base: 'ACCEPTABLE' | 'MODERATE' | 'UNACCEPTABLE' | null = null
  if (/unaccept|fail|high|red|reject|deny/.test(o)) base = 'UNACCEPTABLE'
  else if (/moderate|medium|caution|yellow|elevated/.test(o)) base = 'MODERATE'
  else if (/accept|pass|low|green|approv|good/.test(o)) base = 'ACCEPTABLE'
  if (!base) return 'PENDING_REVIEW'
  if (/pending|request|inreview|underreview|awaiting|open|submitted/.test(r)) return base === 'UNACCEPTABLE' ? 'UNACCEPTABLE_REVIEW' : 'PENDING_REVIEW'
  return base
}

const STATUS_RANK: Record<string, number> = { NOT_INVITED: 1, INVITED: 2, IN_PROGRESS: 3 }
const rankOf = (status: unknown): number => {
  const s = typeof status === 'string' ? status.trim().toUpperCase().replace(/[\s-]+/g, '_') : ''
  if (!s) return 0
  return STATUS_RANK[s] ?? 4
}

function safetyOf(rating: string | undefined): McpSafetyRating | undefined {
  const s = flat(rating)
  if (s.includes('unsat')) return 'UNSATISFACTORY'
  if (s.includes('cond')) return 'CONDITIONAL'
  if (s.includes('sat')) return 'SATISFACTORY'
  return undefined
}

function authorityOf(authority: unknown): 'ACTIVE' | 'INACTIVE' | undefined {
  const values = ['commonAuthority', 'contractAuthority', 'brokerAuthority'].map((k) => flat(text(field(authority, k)))).filter(Boolean)
  if (values.length === 0) return undefined
  if (values.some((v) => v === 'a' || v === 'active')) return 'ACTIVE'
  if (values.every((v) => v === 'i' || v === 'n' || v === 'inactive' || v === 'none')) return 'INACTIVE'
  return undefined
}

function insuranceOf(certData: unknown, nowMs: number): McpInsurance | undefined {
  const best: { cargo?: McpInsuranceSide; liability?: McpInsuranceSide } = {}
  for (const cert of [...list(field(certData, 'Certificates')), ...list(field(certData, 'Certificate'))]) {
    for (const cov of [...list(field(cert, 'Coverages')), ...list(field(cert, 'Coverage'))]) {
      const type = flat(text(field(cov, 'Type')))
      const side = type.includes('cargo') ? 'cargo' : /auto|liab|bipd/.test(type) ? 'liability' : null
      const expiresAt = isoOf(field(cov, 'ExpirationDate'))
      if (!side || !expiresAt) continue
      const limitDigits = (text(field(cov, 'CoverageLimit')) ?? '').replace(/[^0-9.]/g, '')
      const limit = limitDigits ? Math.round(Number(limitDigits) * 100) : NaN
      const cancelled = !!text(field(cov, 'CancellationDate'))
      const next: McpInsuranceSide = {
        expiresAt,
        ...(Number.isFinite(limit) && limit > 0 ? { limitCents: limit } : {}),
        active: !cancelled && Date.parse(expiresAt) > nowMs,
        ...(text(field(cov, 'InsurerName')) ?? text(field(cov, 'insurerName')) ? { company: (text(field(cov, 'InsurerName')) ?? text(field(cov, 'insurerName')))! } : {}),
        ...(text(field(cov, 'PolicyNumber')) ?? text(field(cov, 'policyNumber')) ? { policyNumber: (text(field(cov, 'PolicyNumber')) ?? text(field(cov, 'policyNumber')))! } : {}),
      }
      const current = best[side]
      if (!current || Date.parse(next.expiresAt) > Date.parse(current.expiresAt)) best[side] = next
    }
  }
  return best.cargo || best.liability ? best : undefined
}

/**
 * GetCarrierData / PreviewCarrier response → our carrier snapshot. Null when MCP has no
 * such carrier (empty array, or only a `Message`).
 */
export function normalizeMcpCarrier(raw: unknown, ref: McpCarrierRef, nowMs: number = Date.now()): McpCarrier | null {
  const root = Array.isArray(raw) ? raw[0] : raw
  if (!root || typeof root !== 'object') return null
  const dot = dotOf(text(field(root, 'DOTNumber')) ?? text(field(root, 'DotNumber')))
  const docket = text(field(root, 'MCNumber')) ?? text(field(root, 'DocketNumber'))
  if (!dot && !docket && !text(field(root, 'LegalName')) && !text(field(root, 'CompanyName')) && !text(field(field(root, 'Identity'), 'legalName'))) return null

  // GetCarrierData nests Assure Advantage under AssureAdvantage[0]; the monitored / changes feeds send CarrierDetails itself.
  const cd = field(list(field(root, 'AssureAdvantage'))[0], 'CarrierDetails') ?? (field(root, 'Authority') || field(root, 'Safety') || field(root, 'CertData') ? root : undefined)
  const risk = field(root, 'RiskAssessmentDetails') ?? field(cd, 'RiskAssessmentDetails')
  const riskSummary = field(root, 'RiskAssessment') ?? field(cd, 'RiskAssessment')
  const certData = field(root, 'CertData') ?? field(cd, 'CertData')
  const overall = text(field(risk, 'OverallRating')) ?? text(field(riskSummary, 'Overall'))
  const reviewState = text(field(risk, 'ReviewState'))
  const points = Number(field(risk, 'TotalPoints'))

  const stages = list(field(root, 'CarrierCustomerPacketStatuses')).map((s) => mapPacketStatus(text(field(s, 'CarrierPacketStatus'))))
  const agreements = list(field(root, 'CarrierCustomerAgreements'))
  const completed =
    stages.includes('COMPLETED') ||
    stages.includes('PENDING_REVIEW') ||
    field(field(root, 'CarrierRating'), 'HasCompletedPacket') === true ||
    field(root, 'OnCurrentCustomerAgreement') === true ||
    agreements.some((a) => field(a, 'OnCurrentCustomerAgreement') === true || field(a, 'IsActive') === true)

  let status: McpCarrierStatus
  if (completed) {
    status = stages.includes('PENDING_REVIEW') && !overall ? 'PENDING_REVIEW' : mapRiskStanding(overall, reviewState)
  } else if (stages.includes('IN_PROGRESS')) status = 'IN_PROGRESS'
  else if (stages.includes('INVITED') || text(field(field(cd, 'LatestInvitation'), 'InvitationSentDate'))) status = 'INVITED'
  else status = 'NOT_INVITED'

  const signed = agreements.map((a) => isoOf(field(a, 'SignatureDate'))).filter((d): d is string => !!d).sort()
  const safety = safetyOf(text(field(field(cd, 'Safety'), 'rating')))
  const authority = authorityOf(field(cd, 'Authority'))
  const insurance = insuranceOf(certData, nowMs)

  return {
    mcNumber: ref.mcNumber?.trim() || docket || '',
    ...(dot ? { dotNumber: dot } : ref.dotNumber ? { dotNumber: ref.dotNumber } : {}),
    status,
    ...(completed && status !== 'PENDING_REVIEW' ? { reviewStatus: status as McpReviewStatus } : {}),
    ...(Number.isFinite(points) && field(risk, 'TotalPoints') != null ? { riskAssessmentPoints: points } : {}),
    ...(safety ? { safetyRating: safety } : {}),
    ...(authority ? { authorityStatus: authority } : {}),
    ...(insurance ? { insurance } : {}),
    ...(completed && signed.length ? { packetCompletedAt: signed[signed.length - 1] } : {}),
  }
}

/**
 * Merge MCP insurance into the carrier's existing policy list, preserving any
 * policy type MCP does not cover. Cargo and liability are upserted by type;
 * everything else is left alone.
 */
export function mergeInsurancePolicies(
  existing: Array<Record<string, unknown>> | null | undefined,
  mcp: McpInsurance | undefined,
): Array<Record<string, unknown>> {
  const current = Array.isArray(existing) ? [...existing] : []
  if (!mcp) return current

  const upsert = (type: string, side: McpInsuranceSide) => {
    const idx = current.findIndex((p) => String(p.type ?? '').toUpperCase() === type)
    const next = {
      ...(idx >= 0 ? current[idx] : { id: `mcp-${type.toLowerCase()}` }),
      type,
      expiresAt: side.expiresAt,
      ...(side.limitCents != null ? { limitCents: side.limitCents } : {}),
      ...(side.company ? { company: side.company } : {}),
      ...(side.policyNumber ? { policyNumber: side.policyNumber } : {}),
      active: side.active,
    }
    if (idx >= 0) current[idx] = next
    else current.push(next)
  }

  if (mcp.cargo) upsert('CARGO', mcp.cargo)
  if (mcp.liability) upsert('AUTO_LIABILITY', mcp.liability)
  return current
}

/**
 * Map an MCP carrier onto the fields this sync writes. With `existing`, a packet stage
 * never moves backwards (a completed carrier is not reset to NOT_INVITED by a thin
 * response); completed → completed changes always apply. Nothing here writes.
 */
export function applyMcpUpdate(mcp: McpCarrier, existing?: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (!existing || rankOf(mcp.status) >= rankOf(existing.mcpStatus)) patch.mcpStatus = mcp.status
  if (mcp.safetyRating) patch.safetyRating = mcp.safetyRating
  if (mcp.authorityStatus) patch.authorityStatus = mcp.authorityStatus
  if (mcp.riskAssessmentPoints != null) patch.mcpRiskScore = mcp.riskAssessmentPoints
  if (mcp.reviewStatus) patch.mcpReviewStatus = mcp.reviewStatus
  if (mcp.packetCompletedAt) patch.mcpPacketCompletedAt = mcp.packetCompletedAt
  return patch
}

/** The minimal set of fields that would actually change on `existing`. Empty = nothing to write. */
export function mcpCarrierPatch(existing: Record<string, unknown>, mcp: McpCarrier): Record<string, unknown> {
  const full = applyMcpUpdate(mcp, existing)
  if (mcp.insurance) {
    full.insurancePolicies = mergeInsurancePolicies(existing.insurancePolicies as Array<Record<string, unknown>> | null | undefined, mcp.insurance)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(full)) if (JSON.stringify(v) !== JSON.stringify(existing[k])) out[k] = v
  return out
}

// ── Live calls ───────────────────────────────────────────────────────────────

/**
 * Look one carrier up by MC and/or DOT. Never invites. Null when MCP does not know it.
 * GetCarrierData carries the packet data; PreviewCarrier (profile + risk, no packet) is the
 * fallback for a carrier that has never touched MyCarrierPackets.
 */
export async function lookupMcpCarrier(
  ref: McpCarrierRef,
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<McpCarrier | null> {
  const creds = requireCreds(credentials)
  const dot = dotOf(ref.dotNumber)
  const docket = docketOf(ref.mcNumber)
  if (!dot && !docket) throw new Error('A DOT or MC number is required for a MyCarrierPackets lookup')
  const nowMs = (opts?.now ?? Date.now)()

  const data = await mcpPost('/api/v1/Carrier/GetCarrierData', { DOTNumber: dot, DocketNumber: docket, Docket: docket }, creds, fetchImpl, opts)
  const found = normalizeMcpCarrier(data, ref, nowMs)
  if (found) return found
  const preview = await mcpPost('/api/v1/Carrier/PreviewCarrier', { DOTNumber: dot, docketNumber: docket }, creds, fetchImpl, opts)
  return normalizeMcpCarrier(preview, ref, nowMs)
}

export interface McpMonitoredEntry {
  dotNumber?: string
  docketNumber?: string
}

/** One page of the monitored list (guide 3.1.1.1; page size default 2500, max 5000). */
export async function listMonitoredCarriers(
  page: number,
  pageSize: number,
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<{ entries: McpMonitoredEntry[]; totalPages: number }> {
  const creds = requireCreds(credentials)
  const { body, pagination } = await mcpPostRaw('/api/v1/Carrier/MonitoredCarriers', { pageNumber: page, pageSize: Math.min(Math.max(pageSize, 1), 5000) }, creds, fetchImpl, opts)
  const entries = list(body).flatMap((row) => {
    const dotNumber = dotOf(text(field(row, 'DOTNumber')))
    const docketNumber = docketOf(text(field(row, 'DocketNumber')))
    return dotNumber || docketNumber ? [{ dotNumber, docketNumber }] : []
  })
  return { entries, totalPages: pagination?.totalPages ?? (entries.length > 0 ? page + 1 : page) }
}

/**
 * The full GetCarrierData body for one carrier, untouched (the profile mapper reads it).
 * Null when MCP has nothing; falls back to PreviewCarrier like `lookupMcpCarrier`.
 */
export async function fetchMcpCarrierRaw(
  ref: McpCarrierRef,
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<unknown | null> {
  const creds = requireCreds(credentials)
  const dot = dotOf(ref.dotNumber)
  const docket = docketOf(ref.mcNumber)
  if (!dot && !docket) throw new Error('A DOT or MC number is required for a MyCarrierPackets lookup')
  const nowMs = (opts?.now ?? Date.now)()
  const data = await mcpPost('/api/v1/Carrier/GetCarrierData', { DOTNumber: dot, DocketNumber: docket, Docket: docket }, creds, fetchImpl, opts)
  if (normalizeMcpCarrier(data, ref, nowMs)) return data
  const preview = await mcpPost('/api/v1/Carrier/PreviewCarrier', { DOTNumber: dot, docketNumber: docket }, creds, fetchImpl, opts)
  return normalizeMcpCarrier(preview, ref, nowMs) ? (Array.isArray(preview) ? preview[0] : preview) : null
}

/**
 * PreviewCarrier, untouched: profile, FMCSA status, risk assessment, certificates and the
 * e-mails MCP has approved for the carrier. Works for a carrier that never touched MCP.
 * Null when MCP knows no such carrier.
 */
export async function fetchMcpPreviewRaw(
  ref: McpCarrierRef,
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<unknown | null> {
  const creds = requireCreds(credentials)
  const dot = dotOf(ref.dotNumber)
  const docket = docketOf(ref.mcNumber)
  if (!dot && !docket) throw new Error('A DOT or MC number is required for a MyCarrierPackets lookup')
  const preview = await mcpPost('/api/v1/Carrier/PreviewCarrier', { DOTNumber: dot, docketNumber: docket }, creds, fetchImpl, opts)
  return normalizeMcpCarrier(preview, ref, (opts?.now ?? Date.now)()) ? (Array.isArray(preview) ? preview[0] : preview) : null
}

/** GetCarrierData, untouched (packet, W-9, contacts, equipment, lanes, Assure Advantage). Null when MCP has nothing. */
export async function fetchMcpDataRaw(
  ref: McpCarrierRef,
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<unknown | null> {
  const creds = requireCreds(credentials)
  const dot = dotOf(ref.dotNumber)
  const docket = docketOf(ref.mcNumber)
  if (!dot && !docket) throw new Error('A DOT or MC number is required for a MyCarrierPackets lookup')
  const data = await mcpPost('/api/v1/Carrier/GetCarrierData', { DOTNumber: dot, DocketNumber: docket, Docket: docket }, creds, fetchImpl, opts)
  return normalizeMcpCarrier(data, ref, (opts?.now ?? Date.now)()) ? (Array.isArray(data) ? data[0] : data) : null
}

export interface McpInvitationResult {
  status: number
  /** Top-level keys of MCP's answer: shape evidence for logs, never values. */
  bodyKeys: string[]
  message: string | null
}

/**
 * EmailPacketInvitation, a person's action. `username` is the MCP integration user sending it
 * (the guide recommends it). Returns the HTTP status and the answer's key names only.
 */
export async function inviteMcpCarrier(
  input: { email: string; dotNumber?: string; mcNumber?: string },
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<McpInvitationResult> {
  const creds = requireCreds(credentials)
  const dot = dotOf(input.dotNumber)
  const docket = docketOf(input.mcNumber)
  if (!dot && !docket) throw new Error('A DOT or MC number is required to invite a carrier on MyCarrierPackets.')
  const { body, status } = await mcpPostRaw(
    '/api/v1/Carrier/EmailPacketInvitation',
    { dotNumber: dot, docketNumber: docket, carrierEmail: input.email, username: creds.username },
    creds,
    fetchImpl,
    opts,
  )
  const message = typeof body === 'string' ? body : text(field(body, 'Message')) ?? null
  return {
    status,
    bodyKeys: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as Rec).sort() : [],
    message,
  }
}

/**
 * Carriers whose insurance / FMCSA / risk data changed in a window (guide 3.2). MCP asks for
 * no less than 4 minutes between these calls; the caller owns that gate. Items are
 * CarrierDetails-shaped (no packet data). Pagination arrives in the response header.
 */
export async function listCarrierChanges(
  range: { from: Date; to: Date },
  page: number,
  pageSize: number,
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<{ items: unknown[]; totalPages: number }> {
  const creds = requireCreds(credentials)
  const fmt = (d: Date) => d.toISOString().slice(0, 19)
  const { body, pagination } = await mcpPostRaw(
    '/api/v1/Carrier/CarriersChanges',
    { fromDate: fmt(range.from), toDate: fmt(range.to), pageNumber: page, pageSize: Math.min(Math.max(pageSize, 1), 500) },
    creds,
    fetchImpl,
    opts,
  )
  const items = list(field(body, 'CarrierList'))
  return { items, totalPages: pagination?.totalPages ?? 1 }
}

export interface McpCompletedPacket {
  dotNumber: string
  docketNumber?: string
  legalName?: string
  completedAt?: string
}

/** Packets completed in a window (guide 2.1.1). Dates are `YYYY-MM-DDTHH:MM:SS`, UTC. */
export async function listCompletedPackets(
  range: { from: Date; to: Date },
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<McpCompletedPacket[]> {
  const creds = requireCreds(credentials)
  const fmt = (d: Date) => d.toISOString().slice(0, 19)
  const data = await mcpPost('/api/v1/Carrier/CompletedPackets', { fromDate: fmt(range.from), toDate: fmt(range.to) }, creds, fetchImpl, opts)
  return list(data).flatMap((row) => {
    const dotNumber = dotOf(text(field(row, 'DOTNumber')))
    if (!dotNumber) return []
    return [{ dotNumber, docketNumber: text(field(row, 'DocketNumber')), legalName: text(field(row, 'LegalName')), completedAt: isoOf(field(row, 'CompletedDate')) }]
  })
}

/** Send a MyCarrierPackets setup packet (EmailPacketInvitation). A person's action only. */
export async function sendSetupPacket(
  input: McpSetupPacketInput,
  credentials: Record<string, string | null | undefined>,
  fetchImpl: typeof fetch = fetch,
  opts?: McpClientOptions,
): Promise<AdapterResult> {
  const creds = credsOf(credentials)
  if (!creds) {
    return {
      mode: 'STUB',
      ok: false,
      message: 'STUB — MyCarrierPackets username and password are required; no call was made.',
      detail: { provider: 'MYCARRIERPACKETS', capability: 'setupPacket', sample: { carrierMc: input.carrierMc, carrierDot: input.carrierDot } },
    }
  }
  const dot = dotOf(input.carrierDot)
  const docket = docketOf(input.carrierMc)
  if (!dot) throw new Error('A DOT number is required to invite a carrier on MyCarrierPackets; this carrier has none on file.')
  await mcpPost(
    '/api/v1/Carrier/EmailPacketInvitation',
    { dotNumber: dot, docketNumber: docket, carrierEmail: input.email, username: input.invitedBy },
    creds,
    fetchImpl,
    opts,
  )
  return {
    mode: 'LIVE',
    ok: true,
    message: 'Setup packet invitation sent.',
    detail: { provider: 'MYCARRIERPACKETS', capability: 'setupPacket', dotNumber: dot, docketNumber: docket ?? null },
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** The live MyCarrierPackets adapter. */
export function mcpAdapter(_credentials: Record<string, string>, fetchImpl: typeof fetch = fetch, opts?: McpClientOptions): Adapter {
  return {
    validate: async (ctx: AdapterContext): Promise<Health> => healthFrom(await validateMcpCredentials(ctx.credentials, fetchImpl, opts), ctx.now),

    connect: async (ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult> => {
      const outcome = await validateMcpCredentials(ctx.credentials, fetchImpl, opts)
      const health = healthFrom(outcome, ctx.now)
      return {
        mode: health.status === 'OK' ? 'LIVE' : 'STUB',
        ok: health.status === 'OK',
        message: health.status === 'OK' ? 'Connected to MyCarrierPackets.' : (health.detail ?? 'Could not connect to MyCarrierPackets.'),
        detail: { provider: 'MYCARRIERPACKETS', capability: 'connect', sample: input },
      }
    },

    sync: async (ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult> => {
      const mcNumber = typeof input.mcNumber === 'string' ? input.mcNumber.trim() : undefined
      const dotNumber = typeof input.dotNumber === 'string' ? input.dotNumber.trim() : undefined
      if (!mcNumber && !dotNumber) throw new Error('mcNumber or dotNumber is required for a MyCarrierPackets sync')
      const carrier = await lookupMcpCarrier({ mcNumber, dotNumber }, ctx.credentials, fetchImpl, opts)
      return {
        mode: 'LIVE',
        ok: carrier !== null,
        message: carrier ? 'Carrier synced from MyCarrierPackets.' : 'MyCarrierPackets has no record of that carrier.',
        detail: { provider: 'MYCARRIERPACKETS', capability: 'sync', input, carrier },
      }
    },

    setupPacket: async (ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult> => {
      const email = typeof input.email === 'string' ? input.email.trim() : ''
      if (!email) throw new Error('email is required for a MyCarrierPackets setup packet')
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
      return sendSetupPacket(
        { email, carrierName: str(input.carrierName), carrierMc: str(input.carrierMc), carrierDot: str(input.carrierDot), invitedBy: str(input.invitedBy) },
        ctx.credentials,
        fetchImpl,
        opts,
      )
    },
  }
}

