/**
 * Platform health, as pure functions. The page and its hook only fetch and lay out;
 * every count, grade and age is decided here, with `now` as a parameter.
 *
 * Two rules this file exists to hold:
 *  - the state badge is `badgeOf` and nothing else — no second opinion about what
 *    "connected" means;
 *  - a secret the dev stack deliberately neutered is not a failure, so it never counts
 *    as "needs attention" (it gets its own tally).
 */
import { badgeOf } from '@/lib/integrations/health'
import type {
  IntegrationBadge, IntegrationRecord, ProviderDescriptor,
} from '@/lib/integrations/types'

/** A provider nobody has connected yet still has a state: the badge says which. */
const UNSEEN: Pick<IntegrationRecord, 'status' | 'health' | 'mode'> = {
  status: 'NOT_CONNECTED',
  health: 'UNKNOWN',
  mode: 'STUB',
}

export interface HealthEntry {
  /** Null for a provider row the registry does not (yet) describe. */
  descriptor: ProviderDescriptor | null
  provider: string
  row: IntegrationRecord | undefined
  badge: IntegrationBadge
  applicable: boolean
  neutered: boolean
  /** A real failure: bad credentials, or unable to verify for any reason but the dev neuter. */
  needsAttention: boolean
}

export interface IntegrationSummary {
  entries: HealthEntry[]
  /** Applicable providers only. */
  total: number
  connected: number
  needsAttention: number
  neuteredOnDev: number
}

/** Registry providers first (registry order), then any provider row the registry lacks. */
export function summarizeIntegrations(
  rows: IntegrationRecord[],
  descriptors: ProviderDescriptor[],
): IntegrationSummary {
  const byProvider = new Map<string, IntegrationRecord>()
  for (const row of rows) if (row.kind === 'PROVIDER') byProvider.set(row.provider, row)

  const known = new Set(descriptors.map((d) => d.key as string))
  const slots: Array<{ descriptor: ProviderDescriptor | null; provider: string }> = [
    ...descriptors.map((descriptor) => ({ descriptor, provider: descriptor.key as string })),
    ...[...byProvider.keys()].filter((p) => !known.has(p)).map((provider) => ({ descriptor: null, provider })),
  ]

  const entries = slots.map(({ descriptor, provider }): HealthEntry => {
    const row = byProvider.get(provider)
    const badge = badgeOf({ ...UNSEEN, ...row, applicability: descriptor?.applicability })
    const applicable = badge.label !== 'Not applicable'
    const neutered = applicable && row?.status !== 'DISCONNECTED' && row?.healthReason === 'NEUTERED_ON_DEV'
      && row.health === 'UNABLE_TO_VERIFY'
    const needsAttention = applicable && !neutered
      && (badge.label === 'Invalid credentials' || badge.label === 'Unable to verify')
    return { descriptor, provider, row, badge, applicable, neutered, needsAttention }
  })

  const applicable = entries.filter((e) => e.applicable)
  return {
    entries,
    total: applicable.length,
    connected: applicable.filter((e) => e.badge.label === 'Connected').length,
    needsAttention: applicable.filter((e) => e.needsAttention).length,
    neuteredOnDev: applicable.filter((e) => e.neutered).length,
  }
}

export type Freshness = 'FRESH' | 'LATE' | 'NO_DATA' | 'PAUSED'

/**
 * Late once the newest timestamp is older than twice the job's cadence. On a stack whose
 * schedules are disabled that is expected, so it reads PAUSED instead of LATE.
 */
export function freshness(
  latestIso: string | null | undefined,
  cadenceMin: number,
  nowMs: number,
  opts?: { devPaused?: boolean },
): Freshness {
  const at = Date.parse(latestIso ?? '')
  if (!Number.isFinite(at)) return 'NO_DATA'
  if (nowMs - at <= 2 * cadenceMin * 60_000) return 'FRESH'
  return opts?.devPaused ? 'PAUSED' : 'LATE'
}

/** Newest valid ISO timestamp, or null when none parses. */
export function latestOf(values: Array<string | null | undefined>): string | null {
  let best: number | null = null
  let bestIso: string | null = null
  for (const value of values) {
    const t = Date.parse(value ?? '')
    if (Number.isFinite(t) && (best === null || t > best)) { best = t; bestIso = value as string }
  }
  return bestIso
}

/** `RECORDED`: a timestamp exists but the job has no fixed cadence to grade it against. */
export type SyncState = Freshness | 'RECORDED' | 'NO_HEARTBEAT'

export interface SyncRow {
  key: string
  source: string
  at: string | null
  ageMs: number | null
  cadenceLabel: string
  state: SyncState
}

export interface SyncInputs {
  nowMs: number
  devPaused: boolean
  integrations: IntegrationRecord[]
  descriptors: ProviderDescriptor[]
  /** Newest `TruckLocation.updatedAt`; null when none or the read failed. */
  truckLocationAt: string | null
  /** Newest `FactoringItem.otrStatusSyncedAt`; null when none or the read failed. */
  otrSyncedAt: string | null
}

const MCP_KEY = 'MYCARRIERPACKETS'

/** Jobs with an honest timestamp, then jobs that leave none — listed, never guessed. */
export function syncRows(inputs: SyncInputs): SyncRow[] {
  const { nowMs, devPaused } = inputs
  const ageOf = (at: string | null): number | null => {
    const t = Date.parse(at ?? '')
    return Number.isFinite(t) ? Math.max(0, nowMs - t) : null
  }
  const graded = (key: string, source: string, at: string | null, cadenceMin: number, cadenceLabel: string): SyncRow => ({
    key, source, at, ageMs: ageOf(at), cadenceLabel,
    state: freshness(at, cadenceMin, nowMs, { devPaused }),
  })

  const byProvider = new Map<string, IntegrationRecord>()
  for (const row of inputs.integrations) if (row.kind === 'PROVIDER') byProvider.set(row.provider, row)

  const rows: SyncRow[] = [
    graded('mcp', 'MyCarrierPackets sync', byProvider.get(MCP_KEY)?.lastOkAt ?? null, 30, 'Every 30 min'),
    graded('motive-locations', 'Motive truck locations', inputs.truckLocationAt, 10, 'Every 10 min'),
    graded('otr-status', 'OTR factoring status', inputs.otrSyncedAt, 60, 'Hourly, while invoices are pending'),
  ]

  for (const d of inputs.descriptors) {
    if (d.key === MCP_KEY) continue
    const row = byProvider.get(d.key)
    if (!row || row.mode !== 'LIVE' || d.applicability === 'NOT_APPLICABLE') continue
    const recorded = (suffix: string, at: string | null | undefined): SyncRow => {
      const iso = at ?? null
      return {
        key: `${d.key}:${suffix}`,
        source: `${d.label} · ${suffix === 'ok' ? 'last OK' : 'last webhook'}`,
        at: iso,
        ageMs: ageOf(iso),
        cadenceLabel: '—',
        state: ageOf(iso) === null ? 'NO_DATA' : 'RECORDED',
      }
    }
    rows.push(recorded('ok', row.lastOkAt))
    if (row.lastWebhookAt) rows.push(recorded('webhook', row.lastWebhookAt))
  }

  for (const [key, source, cadenceLabel] of [
    ['compliance-scanner', 'Compliance expiry scan', 'Daily, 6:00 AM Chicago'],
    ['fuel-import', 'Fuel import', '—'],
  ] as const) {
    rows.push({ key, source, at: null, ageMs: null, cadenceLabel, state: 'NO_HEARTBEAT' })
  }
  return rows
}

/** "3 min ago", "2 h ago", "4 d ago"; null in, null out. */
export function formatAge(ageMs: number | null): string | null {
  if (ageMs === null) return null
  const min = Math.floor(ageMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hours = Math.floor(min / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
