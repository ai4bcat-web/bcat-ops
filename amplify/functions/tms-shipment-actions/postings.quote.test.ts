/**
 * Step AE — Push to DAT from a quote / a spot request: the same adapter and ShipmentPosting rows as
 * POST_LOAD, with no shipment. In-memory fakes, no AWS SDK mocking.
 */
import { describe, expect, it } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import { postQuoteLoad, unpostQuoteLoad, type AdapterAnswer, type PostingDeps } from './postings'
import type { Caller } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'

const caller: Caller = { email: 'rep@bcat.com', sub: 'rep', groups: [], isAdmin: false }
const NOW = '2026-11-04T12:00:00.000Z'

const QUOTE: Row = {
  id: 'Q000007', side: 'SELL', status: 'QUOTED', equipmentType: 'VAN', weightLbs: 40000, topSpendCents: 210000,
  spotRequestId: 'sr:u1:m1',
  stops: [
    { type: 'pickup', sequence: 0, appt: '2026-11-10T15:00:00.000Z', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' } },
    { type: 'delivery', sequence: 1, appt: '2026-11-11T15:00:00.000Z', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' } },
  ],
}

function setup(opts: { quote?: Row; live?: boolean } = {}) {
  const tables = new Map<string, Map<string, Row>>()
  const t = (n: string) => { if (!tables.has(n)) tables.set(n, new Map()); return tables.get(n)! }
  t('Quote').set('Q000007', opts.quote ?? QUOTE)
  const posted: Record<string, unknown>[] = []
  const live = opts.live === true
  const deps: PostingDeps = {
    tables: { posting: 'ShipmentPosting', shipment: 'Shipment', load: 'Load', order: 'Order', integration: 'Integration', quote: 'Quote' },
    getById: async (n, id) => t(n).get(id) ?? null,
    queryIndex: async (n, _i, _k, v) => [...t(n).values()].filter((r) => r.shipmentId === v),
    transact: async (items: TransactWriteItem[]) => {
      for (const item of items) {
        if (item.Update?.TableName === 'Shipment') throw new Error('a quote posting must not touch a shipment')
        if (!item.Update) continue
        const id = String((unmarshall(item.Update.Key!) as Row).id)
        const row = t('ShipmentPosting').get(id) ?? { id }
        const names = item.Update.ExpressionAttributeNames ?? {}
        const values = item.Update.ExpressionAttributeValues ?? {}
        for (const field of Object.values(names)) {
          if (`:${field}` in values) row[field] = unmarshall({ v: values[`:${field}`] }).v
        }
        const remove = /\bREMOVE\s+(.+)$/i.exec(item.Update.UpdateExpression ?? '')
        for (const alias of remove ? remove[1].split(',').map((s) => s.trim()) : []) delete row[names[alias]]
        t('ShipmentPosting').set(id, row)
      }
    },
    readBundle: async () => { throw new Error('a quote posting must not read a shipment bundle') },
    writeAudit: async () => undefined,
    adapterFor: async () => ({
      mode: live ? 'LIVE' : 'STUB',
      post: async (input): Promise<AdapterAnswer> => {
        posted.push(input)
        return live
          ? { mode: 'LIVE', ok: true, message: 'posted to DAT', externalId: 'dat-123' }
          : { mode: 'STUB', ok: true, message: 'STUB — no DAT call was made', externalId: 'stub:dat-1' }
      },
      unpost: async (): Promise<AdapterAnswer> => ({ mode: live ? 'LIVE' : 'STUB', ok: true, message: 'taken down' }),
    }),
    now: () => NOW,
  }
  return { deps, rows: () => [...t('ShipmentPosting').values()], posted }
}

describe('POST_QUOTE_LOAD', () => {
  it('records a labelled STUB posting for a quote with no shipment, linked to its spot request', async () => {
    const { deps, rows, posted } = setup()
    const out = await postQuoteLoad(deps, { quoteId: 'Q000007' }, caller)
    const row = (out.postings as Row[])[0]
    expect(row).toMatchObject({
      id: 'post:quote:Q000007:DAT', shipmentId: 'quote:Q000007', provider: 'DAT', status: 'POSTED', mode: 'STUB',
      originCity: 'Chicago', originState: 'IL', destinationCity: 'Dallas', destinationState: 'TX', equipmentType: 'VAN', rateCents: 210000,
    })
    expect(String(row.message)).toMatch(/^STUB/)
    expect(String(row.note)).toContain('quote Q000007')
    expect(String(row.note)).toContain('spot sr:u1:m1')
    expect(rows()).toHaveLength(1)
    expect(posted[0]).toMatchObject({ originCity: 'Chicago', rateCents: 210000 })
  })

  it('is LIVE when the provider is connected, and a re-post updates the one row', async () => {
    const { deps, rows } = setup({ live: true })
    await postQuoteLoad(deps, { quoteId: 'Q000007', rateCents: 220000 }, caller)
    await postQuoteLoad(deps, { quoteId: 'Q000007', rateCents: 230000 }, caller)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ mode: 'LIVE', status: 'POSTED', rateCents: 230000, boardPostingId: 'dat-123', version: 2 })
  })

  it('posts a spot request that has no quote from its own lane, keyed by the request', async () => {
    const { deps } = setup()
    const out = await postQuoteLoad(deps, {
      spotRequestId: 'sr:u1:m2', originCity: 'Joliet', originState: 'IL', destinationCity: 'Austin', destinationState: 'TX',
      equipmentType: 'REEFER', pickupDate: '2026-11-12', rateCents: 300000,
    }, caller)
    expect((out.postings as Row[])[0]).toMatchObject({ shipmentId: 'spot:sr:u1:m2', originCity: 'Joliet', equipmentType: 'REEFER', pickupAppt: '2026-11-12T12:00:00.000Z' })
  })

  it('refuses what a board cannot use: a closed quote, a converted quote, a buy-side offer, a lane with no city', async () => {
    await expect(postQuoteLoad(setup({ quote: { ...QUOTE, status: 'LOST' } }).deps, { quoteId: 'Q000007' }, caller)).rejects.toThrow(/lost quote cannot be posted/)
    await expect(postQuoteLoad(setup({ quote: { ...QUOTE, shipmentId: 'S1' } }).deps, { quoteId: 'Q000007' }, caller)).rejects.toThrow(/already a shipment/)
    await expect(postQuoteLoad(setup({ quote: { ...QUOTE, side: 'BUY' } }).deps, { quoteId: 'Q000007' }, caller)).rejects.toThrow(/customer quote/)
    await expect(postQuoteLoad(setup().deps, { spotRequestId: 'sr:x', equipmentType: 'VAN' }, caller)).rejects.toThrow(/pickup and a delivery/)
    await expect(postQuoteLoad(setup().deps, {}, caller)).rejects.toThrow(/quoteId or spotRequestId/)
    await expect(postQuoteLoad(setup().deps, { quoteId: 'Q000007', providers: ['NOPE'] }, caller)).rejects.toThrow(/not a postable provider/)
  })
})

describe('UNPOST_QUOTE_LOAD', () => {
  it('flips the row to UNPOSTED and keeps it', async () => {
    const { deps, rows } = setup()
    await postQuoteLoad(deps, { quoteId: 'Q000007' }, caller)
    const out = await unpostQuoteLoad(deps, { quoteId: 'Q000007' }, caller)
    expect((out.postings as Row[])[0]).toMatchObject({ status: 'UNPOSTED', unpostedBy: 'rep@bcat.com' })
    expect(rows()[0]).toMatchObject({ status: 'UNPOSTED', unpostedAt: NOW })
  })

  it('does nothing for a subject that was never posted', async () => {
    const out = await unpostQuoteLoad(setup().deps, { quoteId: 'Q000007' }, caller)
    expect(out.postings).toEqual([])
  })
})
