import { describe, expect, it } from 'vitest'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { rollupSource, rollupStore } from './store'

/** DynamoDB rejects an expression that names an undefined #alias; the real table is the only other judge. */
describe('rollupSource queries', () => {
  it('define every #alias their expressions use', async () => {
    const inputs: Array<Record<string, unknown>> = []
    const db = {
      send: async (cmd: { input: Record<string, unknown> }) => {
        inputs.push(cmd.input)
        return { Items: [], Responses: {}, UnprocessedKeys: {} }
      },
    } as unknown as DynamoDBDocumentClient
    const src = rollupSource(db, { shipment: 'S', order: 'O', load: 'L', sample: 'M', invoice: 'I', carrierBill: 'B' })
    await src.shipments('2026-11')
    await src.loadsOf(['s1'])
    await src.deliveredOrders(['s1'])
    await src.samples('2026-11')
    await src.openInvoices()
    await src.openBills()
    await src.loadsByIds(['l1'])
    expect(inputs.length).toBe(7)
    for (const input of inputs) {
      const bag = input.RequestItems ? Object.values(input.RequestItems as Record<string, Record<string, unknown>>)[0]! : input
      const text = ['KeyConditionExpression', 'FilterExpression', 'ProjectionExpression'].map((k) => String(bag[k] ?? '')).join(' ')
      const defined = Object.keys((bag.ExpressionAttributeNames ?? {}) as object)
      for (const alias of text.match(/#\w+/g) ?? []) expect(defined, `${alias} in ${text}`).toContain(alias)
    }
  })
})

describe('rollupStore.scanAll', () => {
  it('never returns conversational-dashboard spec rows (the sweep must not treat them as rollup rows)', async () => {
    const db = {
      send: async () => ({
        Items: [
          { id: 'M:2026-11', kind: 'M', periodKey: '2026-11', version: 1 },
          { id: 'DASH:3f2a', kind: 'DASH', periodKey: '3f2a', version: 2 },
          { id: 'DASH:INDEX', kind: 'DASH', periodKey: 'INDEX', version: 5 },
          { id: 'D:M:2026-11', kind: 'D', periodKey: 'M:2026-11', version: 1 },
        ],
      }),
    } as unknown as DynamoDBDocumentClient
    const rows = await rollupStore(db, 'T').scanAll()
    expect(rows.map((r) => r.id)).toEqual(['M:2026-11', 'D:M:2026-11'])
  })
})

describe('rollupSource.loadsDeliveredIn', () => {
  const loads = [
    { id: 'a', deliveryAppt: '2026-11-03T17:00:00Z', rate: 1 },
    { id: 'b', deliveryAppt: '2026-10-31T23:30:00Z', rate: 2 },
    { id: 'c', deliveryAppt: '2026-11-20', rate: 3 },
  ]

  it('scans the Load table once (all segments, every page), keeps only non-voided loads with a delivery date server-side, and serves each month from that one pass', async () => {
    const inputs: Array<Record<string, unknown>> = []
    const db = {
      send: async (cmd: { input: Record<string, unknown> }) => {
        inputs.push(cmd.input)
        const segment = cmd.input.Segment as number
        // Segment 0 answers in two pages; the rest answer nothing.
        if (segment === 0 && !cmd.input.ExclusiveStartKey) return { Items: [loads[0], loads[1]], LastEvaluatedKey: { id: 'b' } }
        if (segment === 0) return { Items: [loads[2]] }
        return { Items: [] }
      },
    } as unknown as DynamoDBDocumentClient
    const src = rollupSource(db, { shipment: 'S', order: 'O', load: 'L', sample: 'M', invoice: 'I', carrierBill: 'B' })
    expect((await src.loadsDeliveredIn('2026-11')).map((l) => l.id)).toEqual(['a', 'c'])
    expect((await src.loadsDeliveredIn('2026-10')).map((l) => l.id)).toEqual(['b'])
    expect((await src.loadsDeliveredIn('2026-09')).map((l) => l.id)).toEqual([])
    // One pass: 8 segments plus the second page of segment 0, however many months were asked for.
    expect(inputs.length).toBe(9)
    expect(new Set(inputs.map((i) => i.TotalSegments))).toEqual(new Set([8]))
    expect(new Set(inputs.map((i) => i.Segment)).size).toBe(8)
    for (const input of inputs) {
      const text = [input.FilterExpression, input.ProjectionExpression].map(String).join(' ')
      const defined = Object.keys((input.ExpressionAttributeNames ?? {}) as object)
      for (const alias of text.match(/#\w+/g) ?? []) expect(defined, `${alias} in ${text}`).toContain(alias)
      expect(String(input.FilterExpression)).toContain('attribute_exists(#deliveryAppt)')
      expect(String(input.FilterExpression)).toContain('#voidedAt')
    }
  })
})
