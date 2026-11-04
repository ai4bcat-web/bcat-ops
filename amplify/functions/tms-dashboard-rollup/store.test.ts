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
