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
  const T = { shipment: 'S', order: 'O', load: 'L', sample: 'M', invoice: 'I', carrierBill: 'B' }
  const loadsOf: Record<string, Array<Record<string, unknown>>> = {
    s1: [{ id: 'a', shipmentId: 's1', deliveryAppt: '2026-11-03T17:00:00Z', rate: 1 }],
    s2: [{ id: 'b', shipmentId: 's2', deliveryAppt: '2026-10-31T23:30:00Z', rate: 2 }, { id: 'c', shipmentId: 's2', deliveryAppt: '2026-11-20', rate: 3 }],
    s3: [{ id: 'd', shipmentId: 's3', rate: 4 }], // no delivery date
  }
  const shipmentsOf: Record<string, Array<{ id: string }>> = { '2026-09': [{ id: 's1' }], '2026-10': [{ id: 's2' }, { id: 's3' }] }

  function fakeDb() {
    const inputs: Array<Record<string, unknown>> = []
    const db = {
      send: async (cmd: { input: Record<string, unknown> }) => {
        inputs.push(cmd.input)
        const values = (cmd.input.ExpressionAttributeValues ?? {}) as Record<string, string>
        if (cmd.input.IndexName === 'shipmentsByPickupMonthAndPickupAppt') return { Items: shipmentsOf[values[':m']!] ?? [] }
        if (cmd.input.IndexName === 'loadsByShipmentId') return { Items: loadsOf[values[':s']!] ?? [] }
        throw new Error(`unexpected read ${String(cmd.input.IndexName)}`)
      },
    } as unknown as DynamoDBDocumentClient
    return { db, inputs }
  }

  it('reads every shipment month once and each shipment\'s loads once, only through indexes, and serves every month from that one pass', async () => {
    const { db, inputs } = fakeDb()
    const src = rollupSource(db, T, () => new Date('2026-11-28T12:00:00Z'))
    expect((await src.loadsDeliveredIn('2026-11')).map((l) => l.id)).toEqual(['a', 'c'])
    expect((await src.loadsDeliveredIn('2026-10')).map((l) => l.id)).toEqual(['b'])
    expect((await src.loadsDeliveredIn('2026-09')).map((l) => l.id)).toEqual([])
    const shipmentReads = inputs.filter((i) => i.IndexName === 'shipmentsByPickupMonthAndPickupAppt')
    const loadReads = inputs.filter((i) => i.IndexName === 'loadsByShipmentId')
    // 2024-01 through January 2027 (two months past the current one), once each; three shipments, once each.
    expect(shipmentReads.length).toBe(37)
    expect(new Set(shipmentReads.map((i) => (i.ExpressionAttributeValues as Record<string, string>)[':m'])).size).toBe(37)
    expect(loadReads.length).toBe(3)
    // Nothing but Query: the Lambda's role cannot Scan the source tables.
    expect(inputs.every((i) => i.IndexName)).toBe(true)
  })

  it('each query defines every #alias it uses and projects the delivery date', async () => {
    const { db, inputs } = fakeDb()
    const src = rollupSource(db, T, () => new Date('2026-11-28T12:00:00Z'))
    await src.loadsDeliveredIn('2026-11')
    for (const input of inputs) {
      const text = ['KeyConditionExpression', 'FilterExpression', 'ProjectionExpression'].map((k) => String(input[k] ?? '')).join(' ')
      const defined = Object.keys((input.ExpressionAttributeNames ?? {}) as object)
      for (const alias of text.match(/#\w+/g) ?? []) expect(defined, `${alias} in ${text}`).toContain(alias)
    }
    expect(inputs.filter((i) => i.IndexName === 'loadsByShipmentId').every((i) => String(i.ProjectionExpression).includes('#deliveryAppt'))).toBe(true)
  })
})
