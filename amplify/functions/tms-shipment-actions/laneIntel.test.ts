import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'

import { clearLaneIntelCache, getLaneIntelligence, laneClassOfSample, IDX_QUOTES_BY_MONTH, IDX_SAMPLES_BY_LANE, IDX_SAMPLES_BY_LANE3 } from './laneIntel'

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

  it('memoises closed months but always re-reads the current one, so a quote just written shows up', async () => {
    const { db, send } = fakeDb()
    const deps = { db, tables: { quote: 'Q', laneSample: 'S' }, now: () => NOW }
    await getLaneIntelligence(deps, input)
    QUOTES.push({ id: 'Q3', side: 'SELL', status: 'WON', quoteDate: '2026-11-03', customerName: 'ZZ New', amountCents: 320000, equipmentType: 'VAN', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752' })
    try {
      send.mockClear()
      const again = await getLaneIntelligence(deps, input)
      expect(again.quotes.stats.count).toBe(3)
      const monthReads = send.mock.calls.map((c) => c[0].input as Record<string, unknown>).filter((c) => c.TableName === 'Q')
      expect(monthReads).toHaveLength(1) // only 2026-11; the 24 closed months came from memory
    } finally { QUOTES.pop() }
  })

  it('refuses a lane it cannot index instead of scanning', async () => {
    const { db } = fakeDb()
    await expect(getLaneIntelligence({ db, tables: { quote: 'Q', laneSample: 'S' }, now: () => NOW }, { originCity: 'Chicago', destinationCity: 'Dallas' })).rejects.toThrow(/originCity and originState/)
  })

  describe('this load own side of the business, and exact ZIPs', () => {
    const SIDE_SAMPLES = [
      { id: 'b1', loadId: 'LB1', divisionKey: 'BCAT_LOGISTICS', assignmentKind: 'CARRIER', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-10-01', equipmentType: 'VAN', customerRateCents: 300000, source: 'LOAD' },
      { id: 'i1', loadId: 'LI1', divisionKey: 'IVAN_CARTAGE', assignmentKind: 'OWN_ASSET', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-10-02', equipmentType: 'VAN', customerRateCents: 400000, source: 'LOAD' },
      { id: 'o1', loadId: 'LO1', divisionKey: null, assignmentKind: 'OWN_ASSET', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-10-03', equipmentType: 'VAN', customerRateCents: 410000, source: 'BACKFILL' },
      { id: 'b2', loadId: 'LB2', divisionKey: 'BCAT_LOGISTICS', assignmentKind: 'CARRIER', laneKey: 'CHICAGO|IL>DALLAS|TX', laneKey3: '606>752', date: '2026-10-04', equipmentType: 'VAN', customerRateCents: 320000, source: 'LOAD' },
    ]
    // Where each sample's load really went, by 5-digit ZIP.
    const ZIPS: Record<string, [string, string]> = { LB1: ['60601', '75201'], LI1: ['60601', '75201'], LO1: ['60601', '75202'], LB2: ['60609', '75201'] }
    const stopsOf = (origin: string, destination: string) => JSON.stringify([
      { id: 'a', type: 'pickup', sequence: 0, address: { zip: origin } }, { id: 'b', type: 'delivery', sequence: 1, address: { zip: destination } },
    ])
    function sideDb() {
      const send = vi.fn(async (cmd: { input: Record<string, unknown>; constructor: { name: string } }) => {
        const input = cmd.input
        if (cmd.constructor.name === 'GetItemCommand') {
          const id = (input.Key as { id: { S: string } }).id.S
          const z = ZIPS[id]
          return z ? { Item: marshall({ id, stops: stopsOf(z[0], z[1]) }) } : {}
        }
        const values = input.ExpressionAttributeValues as Record<string, { S: string }>
        let items: Record<string, unknown>[] = []
        if (input.IndexName === IDX_SAMPLES_BY_LANE) items = SIDE_SAMPLES.filter((x) => x.laneKey === values[':v'].S && x.date >= values[':from'].S)
        if (input.IndexName === IDX_SAMPLES_BY_LANE3) items = SIDE_SAMPLES.filter((x) => x.laneKey3 === values[':v'].S && x.date >= values[':from'].S)
        return { Items: items.map((i) => marshall(i, { removeUndefinedValues: true })) }
      })
      return { db: { send } as never, send }
    }
    const idsOf = (out: Awaited<ReturnType<typeof getLaneIntelligence>>) => out.runs.rows.map((r) => r.id).sort()
    const deps = (db: never, load = true) => ({ db, tables: { quote: 'Q', laneSample: 'S', ...(load ? { load: 'L' } : {}) }, now: () => NOW })

    it('a brokerage load is compared with brokerage runs only, an Ivan load with Ivan runs only (an old sample with no division goes by who hauled it)', async () => {
      const { db } = sideDb()
      const noZip = { ...input, originZip: null, destinationZip: null }
      expect(idsOf(await getLaneIntelligence(deps(db, false), { ...noZip, laneClass: 'BROKERAGE' }))).toEqual(['b1', 'b2'])
      expect(idsOf(await getLaneIntelligence(deps(db, false), { ...noZip, laneClass: 'IVAN' }))).toEqual(['i1', 'o1'])
      expect(idsOf(await getLaneIntelligence(deps(db, false), noZip))).toEqual(['b1', 'b2', 'i1', 'o1'])
    })

    it('with a ZIP on both ends only runs over exactly those ZIPs count, on top of the side', async () => {
      const { db } = sideDb()
      expect(idsOf(await getLaneIntelligence(deps(db), { ...input, laneClass: 'BROKERAGE' }))).toEqual(['b1'])
      expect(idsOf(await getLaneIntelligence(deps(db), { ...input, laneClass: 'IVAN' }))).toEqual(['i1'])
      expect(idsOf(await getLaneIntelligence(deps(db), input))).toEqual(['b1', 'i1'])
    })

    it('a sample whose load cannot be read is not an exact match', async () => {
      const { db } = sideDb()
      delete ZIPS.LB1
      try { expect(idsOf(await getLaneIntelligence(deps(db), { ...input, laneClass: 'BROKERAGE' }))).toEqual([]) } finally { ZIPS.LB1 = ['60601', '75201'] }
    })

    it('classifies a sample by its division, then by who hauled it', () => {
      expect(laneClassOfSample({ divisionKey: 'BCAT_LOGISTICS', assignmentKind: 'OWN_ASSET' })).toBe('BROKERAGE')
      expect(laneClassOfSample({ divisionKey: null, assignmentKind: 'CARRIER' })).toBe('BROKERAGE')
      expect(laneClassOfSample({ divisionKey: null, assignmentKind: null })).toBeNull()
    })
  })
})
