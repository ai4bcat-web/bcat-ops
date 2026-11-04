import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'

import { clearLaneIntelCache, getLaneIntelligence, IDX_QUOTES_BY_MONTH, IDX_SAMPLES_BY_LANE, IDX_SAMPLES_BY_LANE3 } from './laneIntel'

const NOW = '2026-11-04T12:00:00.000Z'

const SAMPLES = [
  { id: 'lrs:1', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-10-01', customerName: 'ZZ Acme', equipmentType: 'VAN', customerRateCents: 300000, carrierRateCents: 250000, assignmentKind: 'CARRIER', source: 'BACKFILL' },
  { id: 'lrs:2', laneKey: 'EVANSTON|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-09-01', customerName: 'ZZ Acme', equipmentType: 'VAN', customerRateCents: 360000, carrierRateCents: 270000, assignmentKind: 'CARRIER', source: 'LOAD' },
]
const QUOTES = [
  { id: 'Q1', side: 'SELL', status: 'WON', quoteDate: '2026-10-02', customerName: 'ZZ Acme', amountCents: 310000, equipmentType: 'VAN', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752' },
  { id: 'Q2', side: 'SELL', status: 'LOST', lostReason: 'TOO_HIGH', quoteDate: '2026-10-05', customerName: 'ZZ Beta', amountCents: 390000, equipmentType: 'VAN', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752' },
]

function fakeDb() {
  const send = vi.fn(async (cmd: { input: Record<string, unknown> }) => {
    const input = cmd.input
    const values = input.ExpressionAttributeValues as Record<string, { S: string }>
    let items: Record<string, unknown>[] = []
    if (input.IndexName === IDX_SAMPLES_BY_LANE) items = SAMPLES.filter((s) => s.laneKey === values[':v'].S && s.date >= values[':from'].S)
    if (input.IndexName === IDX_SAMPLES_BY_LANE3) items = SAMPLES.filter((s) => s.laneKey3 === values[':v'].S && s.date >= values[':from'].S)
    if (input.IndexName === IDX_QUOTES_BY_MONTH) items = QUOTES.filter((q) => q.quoteDate.slice(0, 7) === values[':m'].S)
    return { Items: items.map((i) => marshall(i)) }
  })
  return { db: { send } as never, send }
}

const input = { originCity: 'Chicago', originState: 'IL', originZip: '60601', destinationCity: 'Dallas', destinationState: 'TX', destinationZip: '75201', equipmentType: 'VAN' }

describe('LANE_INTELLIGENCE', () => {
  beforeEach(() => clearLaneIntelCache())

  it('answers both sections from bounded index reads — never a scan', async () => {
    const { db, send } = fakeDb()
    const out = await getLaneIntelligence({ db, tables: { quote: 'Q', laneSample: 'S' }, now: () => NOW }, input)

    expect(out.runs.stats.count).toBe(2)
    expect(out.runs.stats.customer).toMatchObject({ avgCents: 330000, lowCents: 300000, highCents: 360000 })
    expect(out.runs.rows.find((r) => r.id === 'lrs:2')?.match).toBe('ZIP3')
    expect(out.quotes.stats).toMatchObject({ count: 2, won: 1, lost: 1 })
    expect(out.quotes.stats.winRate).toBeCloseTo(0.5)

    const calls = send.mock.calls.map((c) => c[0].input as Record<string, unknown>)
    expect(calls.every((c) => typeof c.IndexName === 'string')).toBe(true)
    // lane samples carry the 24-month floor in the key condition; quotes are one read per month
    const sampleCalls = calls.filter((c) => c.TableName === 'S')
    expect(sampleCalls).toHaveLength(2)
    expect(sampleCalls.every((c) => String(c.KeyConditionExpression).includes('>= :from'))).toBe(true)
    expect(calls.filter((c) => c.TableName === 'Q')).toHaveLength(25)
  })

  it('serves a repeat of the same lane from cache', async () => {
    const { db, send } = fakeDb()
    const deps = { db, tables: { quote: 'Q', laneSample: 'S' }, now: () => NOW }
    await getLaneIntelligence(deps, input)
    const first = send.mock.calls.length
    await getLaneIntelligence(deps, input)
    expect(send.mock.calls.length).toBe(first)
  })

  it('refuses a lane it cannot index instead of scanning', async () => {
    const { db } = fakeDb()
    await expect(getLaneIntelligence({ db, tables: { quote: 'Q', laneSample: 'S' }, now: () => NOW }, { originCity: 'Chicago', destinationCity: 'Dallas' })).rejects.toThrow(/originCity and originState/)
  })
})
