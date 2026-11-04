import { describe, expect, it } from 'vitest'
import type { Db } from '../_shared/crmStore'
import { dbSource } from './dashSources'

/** Records every command the source sends; the real table is the only other judge of expression validity. */
function recorder(): { db: Db; inputs: { name: string; input: Record<string, unknown> }[] } {
  const inputs: { name: string; input: Record<string, unknown> }[] = []
  const db = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      inputs.push({ name: cmd.constructor.name, input: cmd.input })
      return { Items: [], Responses: {}, UnprocessedKeys: {} }
    },
  } as unknown as Db
  return { db, inputs }
}

describe('dashboard raw source', () => {
  it('queries indexes only for the big tables and defines every #alias it uses', async () => {
    for (const [k, v] of Object.entries({
      CUSTOMER_TABLE_NAME: 'Customer', SHIPMENT_TABLE_NAME: 'Shipment', INVOICE_TABLE_NAME: 'Invoice', QUOTE_TABLE_NAME: 'Quote',
      LANE_RATE_SAMPLE_TABLE_NAME: 'Sample', TMS_SETTINGS_TABLE_NAME: 'Settings', USER_PROFILE_TABLE_NAME: 'User',
      OWNERSHIP_DIVISION_TABLE_NAME: 'Division',
    })) process.env[k] = v
    const { db, inputs } = recorder()
    const src = dbSource(db)
    await src.samples('2026-11')
    await src.shipments('2026-11')
    await src.quotes('2026-11')
    await src.openInvoices()
    await src.customers()
    await src.staff()
    await src.divisions()
    await src.teams()

    const big = ['Sample', 'Shipment', 'Invoice', 'Quote']
    for (const { name, input } of inputs) {
      if (big.includes(String(input.TableName))) expect(name, `${input.TableName}`).not.toBe('ScanCommand')
      const bag = input.RequestItems ? Object.values(input.RequestItems as Record<string, Record<string, unknown>>)[0]! : input
      const text = ['KeyConditionExpression', 'FilterExpression', 'ProjectionExpression'].map((k) => String(bag[k] ?? '')).join(' ')
      const defined = Object.keys((bag.ExpressionAttributeNames ?? {}) as object)
      for (const alias of text.match(/#\w+/g) ?? []) expect(defined, `${alias} in ${text}`).toContain(alias)
    }
    const indexes = inputs.map((i) => i.input.IndexName).filter(Boolean)
    expect(indexes).toEqual([
      'laneRateSamplesBySampleMonthAndDate', 'shipmentsByPickupMonthAndPickupAppt', 'quotesByQuoteMonthAndQuoteDate', 'invoicesByArOpenAndDueAt',
    ])
  })
})
