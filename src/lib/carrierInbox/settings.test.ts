import { describe, expect, it } from 'vitest'
import {
  CarrierInboxConfigError, DEFAULT_CARRIER_INBOX_CONFIG, resolveCarrierInboxConfig, validateCarrierInboxConfig, withVoiceSecret,
} from './settings'

const box = { id: 'm1', label: 'Loads', account: 'ai4bcat@gmail.com', addresses: ['Loads@Example.invalid'], gmailLabel: null, paused: false }
const { version: _v, ...defaults } = DEFAULT_CARRIER_INBOX_CONFIG
const valid = { ...defaults, mailboxes: [box] }

function code(fn: () => unknown): string | null {
  try { fn() } catch (e) { return e instanceof CarrierInboxConfigError ? e.code : 'OTHER' }
  return null
}

describe('resolveCarrierInboxConfig', () => {
  it('fills every default for nothing, junk or a JSON string', () => {
    expect(resolveCarrierInboxConfig(null)).toEqual(DEFAULT_CARRIER_INBOX_CONFIG)
    expect(resolveCarrierInboxConfig('not json')).toEqual(DEFAULT_CARRIER_INBOX_CONFIG)
    expect(resolveCarrierInboxConfig(JSON.stringify({ enabled: true, lookbackHours: 48 })).lookbackHours).toBe(48)
  })
  it('clamps rather than throws, and keeps the suggestion floor under the auto threshold', () => {
    const c = resolveCarrierInboxConfig({ autoFileMinScore: 0.1, suggestMinScore: 0.9, lookbackHours: 9999 })
    expect(c.autoFileMinScore).toBe(0.8)
    expect(c.suggestMinScore).toBe(0.7)
    expect(c.lookbackHours).toBe(168)
  })
})

describe('validateCarrierInboxConfig', () => {
  it('normalizes a valid config and bumps the version', () => {
    const c = validateCarrierInboxConfig(valid, { ...DEFAULT_CARRIER_INBOX_CONFIG, version: 4 })
    expect(c.version).toBe(5)
    expect(c.mailboxes[0].addresses).toEqual(['loads@example.invalid'])
  })
  it('refuses thresholds below the floors', () => {
    expect(code(() => validateCarrierInboxConfig({ ...valid, autoFileMinScore: 0.7 }, null))).toBe('INVALID')
    expect(code(() => validateCarrierInboxConfig({ ...valid, autoFileMinScore: 0.9, suggestMinScore: 0.85 }, null))).toBe('INVALID')
    expect(code(() => validateCarrierInboxConfig({ ...valid, unmatchedRetentionDays: 3 }, null))).toBe('INVALID')
    expect(code(() => validateCarrierInboxConfig({ ...valid, modelCallsPerDay: 5000 }, null))).toBe('INVALID')
  })
  it('accepts the boundary values', () => {
    expect(code(() => validateCarrierInboxConfig({ ...valid, autoFileMinScore: 0.8, suggestMinScore: 0.7 }, null))).toBeNull()
    expect(code(() => validateCarrierInboxConfig({ ...valid, autoFileMinScore: 0.99, suggestMinScore: 0.3 }, null))).toBeNull()
  })
  it('refuses a stale version (CAS)', () => {
    const prev = { ...DEFAULT_CARRIER_INBOX_CONFIG, version: 3 }
    expect(code(() => validateCarrierInboxConfig({ ...valid, version: 2 }, prev))).toBe('CONFLICT')
    expect(code(() => validateCarrierInboxConfig({ ...valid, version: 3 }, prev))).toBeNull()
  })
  it('cannot be enabled without a mailbox', () => {
    expect(code(() => validateCarrierInboxConfig({ ...valid, enabled: true, mailboxes: [] }, null))).toBe('INVALID')
    expect(code(() => validateCarrierInboxConfig({ ...valid, enabled: true }, null))).toBeNull()
  })
  it('validates mailboxes: count, ids, addresses', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...box, id: `m${i}` }))
    expect(code(() => validateCarrierInboxConfig({ ...valid, mailboxes: many }, null))).toBe('INVALID')
    expect(code(() => validateCarrierInboxConfig({ ...valid, mailboxes: [box, box] }, null))).toBe('INVALID')
    expect(code(() => validateCarrierInboxConfig({ ...valid, mailboxes: [{ ...box, addresses: ['not-an-address'] }] }, null))).toBe('INVALID')
    expect(code(() => validateCarrierInboxConfig({ ...valid, mailboxes: [{ ...box, id: '../x' }] }, null))).toBe('INVALID')
  })
  it('voice.secretHash and rotatedAt only change through withVoiceSecret', () => {
    const prev = withVoiceSecret(DEFAULT_CARRIER_INBOX_CONFIG, 'abc123', '2026-11-04T00:00:00Z')
    expect(prev.voice.secretHash).toBe('abc123')
    const next = validateCarrierInboxConfig(
      { ...valid, voice: { enabled: true, secretHash: 'attacker', rotatedAt: 'x', maxTranscriptChars: 5000 } }, prev)
    expect(next.voice).toEqual({ enabled: true, secretHash: 'abc123', rotatedAt: '2026-11-04T00:00:00Z', maxTranscriptChars: 5000 })
  })
  it('a save can neither create nor flip a simulated mailbox', () => {
    const prev = { ...DEFAULT_CARRIER_INBOX_CONFIG, mailboxes: [{ ...box, mode: 'SIMULATED' as const }] }
    const next = validateCarrierInboxConfig({ ...valid, mailboxes: [{ ...box, mode: 'GOOGLE' }, { ...box, id: 'm2', mode: 'SIMULATED' }] }, prev)
    expect(next.mailboxes.map((m) => m.mode)).toEqual(['SIMULATED', 'GOOGLE'])
  })
})
