import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '@/lib/integrations/registry'
import type { IntegrationRecord } from '@/lib/integrations/types'
import { formatAge, freshness, latestOf, summarizeIntegrations, syncRows } from './platformHealth'

function row(provider: string, patch: Partial<IntegrationRecord> = {}): IntegrationRecord {
  return {
    id: provider, provider, kind: 'PROVIDER', mode: 'LIVE', credentialSource: 'STACK',
    status: 'CONNECTED', health: 'OK', ...patch,
  }
}

const NOW = Date.parse('2026-11-03T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

describe('summarizeIntegrations', () => {
  it('never counts a dev-neutered secret as needing attention, and tallies it apart', () => {
    const s = summarizeIntegrations([
      row('MOTIVE', { health: 'UNABLE_TO_VERIFY', healthReason: 'NEUTERED_ON_DEV' }),
      row('SLACK', { health: 'INVALID_CREDENTIALS', healthReason: 'INVALID_CREDENTIALS' }),
      row('TWILIO', { health: 'UNABLE_TO_VERIFY', healthReason: 'PROVIDER_UNREACHABLE' }),
      row('GMAIL'),
    ], PROVIDERS)
    expect(s.neuteredOnDev).toBe(1)
    expect(s.needsAttention).toBe(2)
    expect(s.connected).toBe(1)
  })

  it('keeps not-applicable providers out of the denominator', () => {
    const s = summarizeIntegrations([], PROVIDERS)
    const notApplicable = PROVIDERS.filter((d) => d.applicability === 'NOT_APPLICABLE').length
    expect(notApplicable).toBeGreaterThan(0)
    expect(s.total).toBe(PROVIDERS.length - notApplicable)
    expect(s.connected).toBe(0)
  })

  it('includes a provider row the registry does not describe', () => {
    const s = summarizeIntegrations([row('MYSTERY')], PROVIDERS)
    expect(s.entries.at(-1)?.provider).toBe('MYSTERY')
    expect(s.connected).toBe(1)
  })

  it('does not call a disconnected provider a failure', () => {
    const s = summarizeIntegrations([row('SLACK', { status: 'DISCONNECTED', health: 'INVALID_CREDENTIALS' })], PROVIDERS)
    expect(s.needsAttention).toBe(0)
  })
})

describe('freshness', () => {
  it('is late only past twice the cadence', () => {
    expect(freshness(minutesAgo(19), 10, NOW)).toBe('FRESH')
    expect(freshness(minutesAgo(21), 10, NOW)).toBe('LATE')
  })

  it('reads paused, not late, when schedules are disabled', () => {
    expect(freshness(minutesAgo(500), 10, NOW, { devPaused: true })).toBe('PAUSED')
    expect(freshness(minutesAgo(1), 10, NOW, { devPaused: true })).toBe('FRESH')
  })

  it('has no data for a missing or unparseable stamp', () => {
    expect(freshness(null, 10, NOW)).toBe('NO_DATA')
    expect(freshness('nope', 10, NOW)).toBe('NO_DATA')
  })
})

describe('syncRows', () => {
  const base = { nowMs: NOW, devPaused: false, descriptors: PROVIDERS, truckLocationAt: null, otrSyncedAt: null }

  it('grades MyCarrierPackets from the heartbeat on its Integration row', () => {
    const rows = syncRows({ ...base, integrations: [row('MYCARRIERPACKETS', { lastOkAt: minutesAgo(5) })] })
    expect(rows.find((r) => r.key === 'mcp')?.state).toBe('FRESH')
    expect(syncRows({ ...base, integrations: [] }).find((r) => r.key === 'mcp')?.state).toBe('NO_DATA')
  })

  it('lists jobs that leave no timestamp as no heartbeat instead of guessing', () => {
    const rows = syncRows({ ...base, integrations: [] })
    expect(rows.filter((r) => r.state === 'NO_HEARTBEAT').map((r) => r.key)).toEqual(['compliance-scanner', 'fuel-import'])
  })

  it('adds a recorded line per live integration, webhook only when one arrived', () => {
    const rows = syncRows({
      ...base,
      integrations: [row('MOTIVE', { lastOkAt: minutesAgo(3), lastWebhookAt: minutesAgo(2) }), row('SLACK', { mode: 'STUB' })],
    })
    expect(rows.filter((r) => r.key.startsWith('MOTIVE:')).map((r) => r.state)).toEqual(['RECORDED', 'RECORDED'])
    expect(rows.some((r) => r.key.startsWith('SLACK:'))).toBe(false)
  })
})

describe('helpers', () => {
  it('latestOf ignores junk', () => {
    expect(latestOf([null, 'x', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'])).toBe('2026-02-01T00:00:00Z')
    expect(latestOf([])).toBeNull()
  })

  it('formatAge', () => {
    expect(formatAge(null)).toBeNull()
    expect(formatAge(30_000)).toBe('just now')
    expect(formatAge(5 * 60_000)).toBe('5 min ago')
    expect(formatAge(3 * 3_600_000)).toBe('3 h ago')
    expect(formatAge(72 * 3_600_000)).toBe('3 d ago')
  })
})
