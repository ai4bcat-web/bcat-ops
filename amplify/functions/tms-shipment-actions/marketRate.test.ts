/**
 * Step P4 tests — market rate, stub/live fallback, margin rules, and save guards.
 */
import { describe, expect, it, vi } from 'vitest'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import { priceFromMarket, type MarketRateDeps, type MarketRateResult } from './marketRate'
import type { Caller } from '../_shared/actionInputs'
import type { RateViewAnswer } from '../../../src/lib/integrations/rateView'

type Row = Record<string, unknown>

const caller: Caller = { email: 'admin@test.com', sub: 'admin', groups: ['ADMIN'], isAdmin: true }

function deps(overrides: Partial<MarketRateDeps> = {}): MarketRateDeps {
  const store: Record<string, Row> = {}
  return {
    tables: { quote: 'Quote', customer: 'Customer', settings: 'TmsSettings', integration: 'Integration' },
    getById: async (table, id) => store[`${table}:${id}`] ?? null,
    getSettings: async () => ({ id: 'default', marginTargetBps: 2000 } as Row),
    transact: async (items) => {
      for (const item of items) applyUpdate(store, item)
    },
    writeAudit: vi.fn(),
    credentialsFor: async () => ({}),
    fetchImpl: vi.fn() as unknown as typeof fetch,
    now: () => '2026-10-29T12:00:00.000Z',
    ...overrides,
  }
}

function seedQuote(store: Record<string, Row>, row: Row) {
  store[`Quote:${row.id}`] = row
}

function valueOf(attr: unknown): unknown {
  if (attr == null || typeof attr !== 'object') return attr
  const v = attr as Record<string, unknown>
  if ('S' in v) return v.S
  if ('N' in v) return Number(v.N)
  if ('B' in v) return v.B
  if ('BOOL' in v) return v.BOOL
  if ('NULL' in v) return null
  if ('L' in v && Array.isArray(v.L)) return v.L.map(valueOf)
  if ('M' in v && v.M && typeof v.M === 'object') {
    return Object.fromEntries(
      Object.entries(v.M as Record<string, unknown>).map(([k, a]) => [k, valueOf(a)]),
    )
  }
  return attr
}

function applyUpdate(store: Record<string, Row>, item: TransactWriteItem): void {
  const upd = item.Update
  if (!upd) throw new Error('Only Update transactions are implemented in the test engine')
  const keyRecord = upd.Key as Record<string, { S?: string }>
  const id = keyRecord.id?.S
  if (!id) throw new Error('Missing id in update key')
  const existing = store[`Quote:${id}`]
  const expected = (upd.ExpressionAttributeValues?.[':casExpectedUpdatedAt'] as { S?: string } | undefined)?.S
  if (existing && expected !== undefined && existing.updatedAt !== expected) {
    throw Object.assign(new Error('ConditionalCheckFailed TransactionCanceled'), { name: 'TransactionCanceled' })
  }
  const values = upd.ExpressionAttributeValues ?? {}
  const patch: Row = {}
  for (const [token, attr] of Object.entries(values)) {
    if (token.startsWith(':cas')) continue
    const key = token.slice(1)
    patch[key] = valueOf(attr)
  }
  store[`Quote:${id}`] = { ...(existing ?? {}), ...patch }
}

const baseInput: Row = {
  originCity: 'Chicago',
  originState: 'IL',
  destinationCity: 'Dallas',
  destinationState: 'TX',
  equipmentType: 'VAN',
  pickupDate: '2026-10-30T08:00:00.000Z',
  miles: 920,
}

function assertStub(answer: RateViewAnswer) {
  expect(answer.stub).toBe(true)
  expect(answer.source).toBe('DAT_RATEVIEW')
  expect(answer.message).toContain('STUB')
}

describe('priceFromMarket', () => {
  it('returns a stub answer labelled STUB when no DAT credentials exist', async () => {
    const result = (await priceFromMarket(deps(), baseInput, caller)) as { answer: RateViewAnswer; autoReply: boolean }
    assertStub(result.answer)
    expect(result.autoReply).toBe(false)
  })

  it('returns the same stub number for the same lane (determinism)', async () => {
    const d = deps()
    const first = await priceFromMarket(d, baseInput, caller)
    const second = await priceFromMarket(d, baseInput, caller)
    expect((first as { answer: RateViewAnswer }).answer.averageCents).toBe((second as { answer: RateViewAnswer }).answer.averageCents)
    expect((first as { answer: RateViewAnswer }).answer.lowCents).toBe((second as { answer: RateViewAnswer }).answer.lowCents)
  })

  it('uses the live DAT path when credentials are complete', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ accessToken: 'live-token' }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          rateResponses: [
            {
              response: {
                rate: {
                  averageFuelSurchargePerTripUsd: 150,
                  perTrip: { lowUsd: 1800, highUsd: 2400, rateUsd: 2100 },
                  mileage: 900,
                  reports: 95,
                  standardDeviation: 200,
                },
              },
            },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const d = deps({
      credentialsFor: async () => ({
        serviceAccountEmail: 'dat@example.com',
        serviceAccountPassword: 'secret',
        rateViewTier: 'premium',
      }),
      fetchImpl,
    })
    const result = (await priceFromMarket(d, baseInput, caller)) as { answer: RateViewAnswer }
    expect(result.answer.stub).toBe(false)
    expect(result.answer.averageCents).toBe(2100 * 100 + 150 * 100)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('falls back to stub and states the fallback when DAT refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'bad creds' }), { status: 401 })) as unknown as typeof fetch
    const d = deps({
      credentialsFor: async () => ({
        serviceAccountEmail: 'dat@example.com',
        serviceAccountPassword: 'secret',
      }),
      fetchImpl,
    })
    const result = (await priceFromMarket(d, baseInput, caller)) as { answer: RateViewAnswer }
    assertStub(result.answer)
    expect(result.answer.message).toMatch(/falling back/i)
  })

  it('applies the customer margin override over the org default', async () => {
    const store: Record<string, Row> = {}
    const d = deps({
      getById: async (table, id) => (table === 'Customer' ? { id, marginTargetBps: 2500 } : store[`${table}:${id}`] ?? null),
      getSettings: async () => ({ id: 'default', marginTargetBps: 2000 } as Row),
    })
    const result = (await priceFromMarket(d, { ...baseInput, customerId: 'cust-1' }, caller)) as {
      targetBps: number
      suggestedSellCents: number
    }
    expect(result.targetBps).toBe(2500)
    expect(result.suggestedSellCents).toBeGreaterThan(0)
  })

  it('applies the per-mode org margin over the plain org default', async () => {
    const d = deps({
      getSettings: async () =>
        ({
          id: 'default',
          marginTargetBps: 2200,
          marginTargetBpsByMode: { FTL: 1800 },
        } as Row),
    })
    const result = (await priceFromMarket(d, { ...baseInput, mode: 'FTL' }, caller)) as { targetBps: number }
    expect(result.targetBps).toBe(1800)
  })

  it('forces autoReply false when the suggested rate is below the floor', async () => {
    // A 2.5% target rounds to a dollar sell rate whose actual margin can drop
    // below the floor when floor is set to the same 250 bps, proving the agent
    // refuses to auto-send money-losing prices.
    const d = deps({
      getSettings: async () =>
        ({
          id: 'default',
          marginTargetBps: 250,
          marginFloorBps: 250,
          quoteAutoReplyDefault: true,
        } as Row),
    })
    const result: MarketRateResult = await priceFromMarket(d, baseInput, caller) as unknown as MarketRateResult
    expect(result.belowFloor).toBe(true)
    expect(result.marginAtSuggested).toBeLessThan(result.floorBps)
    expect(result.autoReply).toBe(false)
    expect(result.floorSellCents).toBeGreaterThan(0)
  })

  it('saves market fields and amountCents on a DRAFT quote', async () => {
    const store: Record<string, Row> = {}
    seedQuote(store, {
      id: 'quote-draft',
      status: 'DRAFT',
      customerId: 'cust-1',
      updatedAt: '2026-10-29T10:00:00.000Z',
      version: 3,
    })
    const d = deps({ getById: async (table, id) => store[`${table}:${id}`] ?? null })
    const result = (await priceFromMarket(
      d,
      { ...baseInput, quoteId: 'quote-draft', save: true, expectedUpdatedAt: '2026-10-29T10:00:00.000Z' },
      caller,
    )) as { quote: Row; answer: RateViewAnswer; suggestedSellCents: number }
    expect(result.quote).toBeDefined()
    expect(result.quote.marketRateCents).toBe(result.answer.averageCents)
    expect(result.quote.marketStub).toBe(true)
    expect(result.quote.amountCents).toBe(result.suggestedSellCents)
    expect(result.quote.version).toBe(4)
    expect(d.writeAudit).toHaveBeenCalledWith('Quote', 'quote-draft', 'RATE_FROM_MARKET', caller, expect.any(Object))
  })

  it('saves on a REQUESTED quote but refuses on a SENT quote', async () => {
    const store: Record<string, Row> = {}
    seedQuote(store, { id: 'quote-req', status: 'REQUESTED', updatedAt: '2026-10-29T10:00:00.000Z' })
    seedQuote(store, { id: 'quote-sent', status: 'QUOTED', updatedAt: '2026-10-29T10:00:00.000Z' })
    const d = deps({ getById: async (table, id) => store[`${table}:${id}`] ?? null })
    await expect(
      priceFromMarket(d, { ...baseInput, quoteId: 'quote-req', save: true, expectedUpdatedAt: '2026-10-29T10:00:00.000Z' }, caller),
    ).resolves.toBeDefined()
    await expect(
      priceFromMarket(d, { ...baseInput, quoteId: 'quote-sent', save: true, expectedUpdatedAt: '2026-10-29T10:00:00.000Z' }, caller),
    ).rejects.toThrow(/already quoted/i)
  })

  it('refuses a save when the CAS on updatedAt fails', async () => {
    const store: Record<string, Row> = {}
    seedQuote(store, { id: 'quote-cas', status: 'DRAFT', updatedAt: '2026-10-29T10:00:00.000Z' })
    const d = deps({
      getById: async (table, id) => store[`${table}:${id}`] ?? null,
      transact: async () => {
        throw Object.assign(new Error('TransactionCanceled: conditional check failed'), { name: 'TransactionCanceled' })
      },
    })
    await expect(
      priceFromMarket(d, { ...baseInput, quoteId: 'quote-cas', save: true, expectedUpdatedAt: 'wrong' }, caller),
    ).rejects.toThrow(/changed by someone else/i)
  })

  it('uses the customer from the quote when the input omits customerId', async () => {
    const store: Record<string, Row> = {}
    seedQuote(store, { id: 'quote-owned', status: 'DRAFT', customerId: 'cust-5', updatedAt: '2026-10-29T10:00:00.000Z' })
    const d = deps({
      getById: async (table, id) => {
        if (table === 'Customer') return { id, marginTargetBps: 3000 }
        return store[`${table}:${id}`] ?? null
      },
      getSettings: async () => ({ id: 'default', marginTargetBps: 2000 } as Row),
    })
    const result = (await priceFromMarket(d, { ...baseInput, quoteId: 'quote-owned' }, caller)) as { targetBps: number }
    expect(result.targetBps).toBe(3000)
  })

  it('returns no quote when save is false', async () => {
    const store: Record<string, Row> = {}
    seedQuote(store, { id: 'quote-no-save', status: 'DRAFT', updatedAt: '2026-10-29T10:00:00.000Z' })
    const d = deps({ getById: async (table, id) => store[`${table}:${id}`] ?? null })
    const result = (await priceFromMarket(d, { ...baseInput, quoteId: 'quote-no-save' }, caller)) as { quote?: Row }
    expect(result.quote).toBeUndefined()
  })

  it('does not save when no quoteId is given', async () => {
    const d = deps()
    const result = (await priceFromMarket(d, { ...baseInput, save: true }, caller)) as { quote?: Row }
    expect(result.quote).toBeUndefined()
    expect(d.writeAudit).not.toHaveBeenCalled()
  })

  it('propagates stub fallback when credentials are present but DAT returns empty rate data', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/token')) return new Response(JSON.stringify({ accessToken: 'x' }), { status: 200 })
      return new Response(JSON.stringify({ rateResponses: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const d = deps({
      credentialsFor: async () => ({ serviceAccountEmail: 'a@b.com', serviceAccountPassword: 'x' }),
      fetchImpl,
    })
    const result = (await priceFromMarket(d, baseInput, caller)) as { answer: RateViewAnswer }
    assertStub(result.answer)
  })
})
