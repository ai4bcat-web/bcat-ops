/**
 * Step N2 — the MyCarrierPackets live adapter.
 *
 * The stub stays the default until `username` and `password` are both present and
 * unneutered. When they are, every capability is a real call: connect/validate hit
 * the token endpoint, sync fetches one carrier by MC number, and setupPacket POSTs
 * the carrier's onboarding invitation.
 *
 * The standalone helpers (`fetchMcpCarrier`, `sendSetupPacket`, `applyMcpUpdate`)
 * are exported so backend Lambdas can use them without re-wrapping the Adapter
 * interface, and so frontend tests can exercise the same mapping logic.
 */
import { modeOf } from './health'
import type { Adapter, AdapterContext, AdapterResult, Health, ProviderDescriptor } from './types'

const MCP_BASE = 'https://api.mycarrierpackets.com'
const TIMEOUT_MS = 10_000

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
}

export interface McpInsurance {
  cargo: McpInsuranceSide
  liability: McpInsuranceSide
}

export interface McpCarrier {
  mcNumber: string
  dotNumber?: string
  status: McpCarrierStatus
  reviewStatus?: McpReviewStatus
  riskAssessmentPoints?: number
  safetyRating?: McpSafetyRating
  insurance?: McpInsurance
  packetCompletedAt?: string
}

export interface McpSetupPacketInput {
  email: string
  carrierName?: string
  carrierMc?: string
}

// ── Credentials / raw HTTP ─────────────────────────────────────────────────────

async function tokenFor(creds: { username: string; password: string }, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const body = new URLSearchParams({
      grant_type: 'password',
      username: creds.username,
      password: creds.password,
    })
    const res = await fetchImpl(`${MCP_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`MyCarrierPackets token failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const json = (await res.json()) as { access_token?: string }
    const token = json.access_token ?? ''
    if (!token) throw new Error('MyCarrierPackets token response carried no access_token')
    return token
  } finally {
    clearTimeout(timer)
  }
}

async function mcpGet(path: string, creds: { username: string; password: string }, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const token = await tokenFor(creds, fetchImpl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${MCP_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`MyCarrierPackets ${path} failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return (await res.json()) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

async function mcpPost(path: string, payload: Record<string, unknown>, creds: { username: string; password: string }, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const token = await tokenFor(creds, fetchImpl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${MCP_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`MyCarrierPackets ${path} failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return (await res.json()) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

// ── Mapping helpers ──────────────────────────────────────────────────────────

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
      active: side.active,
    }
    if (idx >= 0) current[idx] = next
    else current.push(next)
  }

  upsert('CARGO', mcp.cargo)
  upsert('AUTO_LIABILITY', mcp.liability)
  return current
}

/**
 * Map an MCP carrier onto the fields this sync writes. The caller merges the
 * result into its own update expression; nothing here writes.
 */
export function applyMcpUpdate(mcp: McpCarrier): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    mcpStatus: mcp.status,
  }
  if (mcp.safetyRating) patch.safetyRating = mcp.safetyRating
  if (mcp.riskAssessmentPoints != null) patch.mcpRiskScore = mcp.riskAssessmentPoints
  if (mcp.reviewStatus) patch.mcpReviewStatus = mcp.reviewStatus
  if (mcp.packetCompletedAt) patch.mcpPacketCompletedAt = mcp.packetCompletedAt
  return patch
}

// ── Live calls ───────────────────────────────────────────────────────────────

/** Fetch one carrier from MCP by MC number. */
export async function fetchMcpCarrier(
  mcNumber: string,
  credentials: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<McpCarrier> {
  const creds = { username: credentials.username ?? '', password: credentials.password ?? '' }
  if (!creds.username || !creds.password) throw new Error('MyCarrierPackets username and password are required')
  const data = await mcpGet(`/api/v1/carriers/${encodeURIComponent(mcNumber)}`, creds, fetchImpl)
  return data as unknown as McpCarrier
}

/** Send a MyCarrierPackets setup packet. */
export async function sendSetupPacket(
  input: McpSetupPacketInput,
  credentials: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterResult> {
  const creds = { username: credentials.username ?? '', password: credentials.password ?? '' }
  if (!creds.username || !creds.password) {
    return {
      mode: 'STUB',
      ok: false,
      message: 'STUB — MyCarrierPackets username and password are required; no call was made.',
      detail: { provider: 'MYCARRIERPACKETS', capability: 'setupPacket', sample: input },
    }
  }
  const payload: Record<string, unknown> = { email: input.email }
  if (input.carrierName) payload.carrierName = input.carrierName
  if (input.carrierMc) payload.carrierMc = input.carrierMc
  const result = await mcpPost('/api/v1/setuppackets', payload, creds, fetchImpl)
  return {
    mode: 'LIVE',
    ok: true,
    message: 'Setup packet sent.',
    externalId: typeof result.id === 'string' ? result.id : undefined,
    detail: { provider: 'MYCARRIERPACKETS', capability: 'setupPacket', result },
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** The live MyCarrierPackets adapter. */
export function mcpAdapter(_credentials: Record<string, string>, fetchImpl: typeof fetch = fetch): Adapter {
  const requireCreds = (ctx: AdapterContext): { username: string; password: string } => {
    const creds = { username: ctx.credentials.username ?? '', password: ctx.credentials.password ?? '' }
    if (!creds.username || !creds.password) throw new Error('MyCarrierPackets username and password are required')
    return creds
  }

  return {
    validate: async (ctx: AdapterContext): Promise<Health> => {
      const creds = requireCreds(ctx)
      try {
        await tokenFor(creds, fetchImpl)
        return { status: 'OK', reason: 'OK', checkedAt: ctx.now }
      } catch (err) {
        return {
          status: 'INVALID_CREDENTIALS',
          reason: 'INVALID_CREDENTIALS',
          detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
          checkedAt: ctx.now,
        }
      }
    },

    connect: async (ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult> => {
      const creds = requireCreds(ctx)
      await tokenFor(creds, fetchImpl)
      return {
        mode: 'LIVE',
        ok: true,
        message: 'Connected to MyCarrierPackets.',
        detail: { provider: 'MYCARRIERPACKETS', capability: 'connect', sample: input },
      }
    },

    sync: async (ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult> => {
      const mcNumber = typeof input.mcNumber === 'string' ? input.mcNumber.trim() : ''
      if (!mcNumber) throw new Error('mcNumber is required for a MyCarrierPackets sync')
      const carrier = await fetchMcpCarrier(mcNumber, ctx.credentials, fetchImpl)
      return {
        mode: 'LIVE',
        ok: true,
        message: 'Carrier synced from MyCarrierPackets.',
        detail: { provider: 'MYCARRIERPACKETS', capability: 'sync', input, carrier },
      }
    },

    setupPacket: async (ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult> => {
      const email = typeof input.email === 'string' ? input.email.trim() : ''
      if (!email) throw new Error('email is required for a MyCarrierPackets setup packet')
      const carrierName = typeof input.carrierName === 'string' ? input.carrierName.trim() : undefined
      const carrierMc = typeof input.carrierMc === 'string' ? input.carrierMc.trim() : undefined
      return sendSetupPacket({ email, carrierName, carrierMc }, ctx.credentials, fetchImpl)
    },
  }
}

/**
 * The adapter this provider should use: live when the credentials are real,
 * otherwise the caller's stub. Mirrors `adapterFor` but hands back the concrete
 * MCP adapter so `setupPacket` is reachable without a cast.
 */
export function mcpAdapterFor(
  descriptor: ProviderDescriptor,
  credentials: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Adapter {
  if (modeOf(descriptor, credentials) === 'LIVE') return mcpAdapter(credentials, fetchImpl)
  throw new Error('mcpAdapterFor only answers when credentials are live; use adapterFor for the general case')
}
