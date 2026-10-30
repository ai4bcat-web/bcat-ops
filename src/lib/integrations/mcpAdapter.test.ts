import { describe, it, expect, vi } from 'vitest'
import {
  applyMcpUpdate,
  fetchMcpCarrier,
  mergeInsurancePolicies,
  mcpAdapter,
  sendSetupPacket,
} from './mcpAdapter'
import type { McpCarrier } from './mcpAdapter'

describe('mcpAdapter', () => {
  it('stubs setupPacket when credentials are missing', async () => {
    const adapter = mcpAdapter({ username: '', password: '' })
    const result = await adapter.setupPacket!(
      { provider: 'MYCARRIERPACKETS', credentials: {}, settings: {}, now: new Date().toISOString() },
      { email: 'dispatch@bcatcorp.com' },
    )
    expect(result.mode).toBe('STUB')
    expect(result.ok).toBe(false)
  })

  it('validates credentials via the token endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'tok-123' }),
      text: async () => '',
    } as unknown as Response)
    const adapter = mcpAdapter({ username: 'u', password: 'p' }, fetchImpl)
    const health = await adapter.validate({
      provider: 'MYCARRIERPACKETS',
      credentials: { username: 'u', password: 'p' },
      settings: {},
      now: new Date().toISOString(),
    })
    expect(health.status).toBe('OK')
  })

  it('marks invalid credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
      text: async () => 'unauthorized',
    } as unknown as Response)
    const adapter = mcpAdapter({ username: 'u', password: 'p' }, fetchImpl)
    const health = await adapter.validate({
      provider: 'MYCARRIERPACKETS',
      credentials: { username: 'u', password: 'p' },
      settings: {},
      now: new Date().toISOString(),
    })
    expect(health.status).toBe('INVALID_CREDENTIALS')
  })

  it('fetches a carrier by MC number', async () => {
    const carrier: McpCarrier = {
      mcNumber: 'MC-123',
      status: 'ACCEPTABLE',
      safetyRating: 'SATISFACTORY',
      insurance: {
        cargo: { expiresAt: '2099-12-31T00:00:00.000Z', active: true, limitCents: 100_000_00 },
        liability: { expiresAt: '2099-12-31T00:00:00.000Z', active: true },
      },
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'tok-123' }),
        text: async () => '',
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => carrier,
        text: async () => '',
      } as unknown as Response)
    const result = await fetchMcpCarrier('MC-123', { username: 'u', password: 'p' }, fetchImpl)
    expect(result).toEqual(carrier)
  })

  it('sends a setup packet when live', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'tok-123' }),
        text: async () => '',
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'sp_123' }),
        text: async () => '',
      } as unknown as Response)
    const result = await sendSetupPacket(
      { email: 'dispatch@bcatcorp.com', carrierMc: 'MC-123' },
      { username: 'u', password: 'p' },
      fetchImpl,
    )
    expect(result.mode).toBe('LIVE')
    expect(result.ok).toBe(true)
    expect(result.externalId).toBe('sp_123')
  })

  it('maps carrier fields to a Carrier row patch', () => {
    const mcp: McpCarrier = {
      mcNumber: 'MC-123',
      status: 'MODERATE',
      reviewStatus: 'MODERATE',
      riskAssessmentPoints: 25,
      safetyRating: 'CONDITIONAL',
      packetCompletedAt: '2026-10-30T00:00:00.000Z',
    }
    const patch = applyMcpUpdate(mcp)
    expect(patch).toEqual({
      mcpStatus: 'MODERATE',
      safetyRating: 'CONDITIONAL',
      mcpRiskScore: 25,
      mcpReviewStatus: 'MODERATE',
      mcpPacketCompletedAt: '2026-10-30T00:00:00.000Z',
    })
  })

  it('merges insurance policies preserving existing ones', () => {
    const existing = [
      { id: 'existing-1', type: 'CARGO', expiresAt: '2024-01-01T00:00:00.000Z', active: true },
      { id: 'existing-2', type: 'CONTINGENT_CARGO', expiresAt: '2025-01-01T00:00:00.000Z', active: false },
    ]
    const merged = mergeInsurancePolicies(existing, {
      cargo: { expiresAt: '2099-12-31T00:00:00.000Z', active: true, limitCents: 100_000_00 },
      liability: { expiresAt: '2099-06-30T00:00:00.000Z', active: true },
    })
    expect(merged).toHaveLength(3)
    const cargo = merged.find((p) => p.type === 'CARGO')
    expect(cargo).toMatchObject({ expiresAt: '2099-12-31T00:00:00.000Z', active: true, limitCents: 100_000_00, id: 'existing-1' })
    const contingent = merged.find((p) => p.type === 'CONTINGENT_CARGO')
    expect(contingent).toEqual(existing[1])
    const liability = merged.find((p) => p.type === 'AUTO_LIABILITY')
    expect(liability).toBeDefined()
  })

  it('returns a stub result for missing credentials on sendSetupPacket', async () => {
    const result = await sendSetupPacket({ email: 'dispatch@bcatcorp.com' }, {})
    expect(result.mode).toBe('STUB')
    expect(result.ok).toBe(false)
  })
})
