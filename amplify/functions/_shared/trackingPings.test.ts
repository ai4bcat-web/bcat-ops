import { describe, expect, it } from 'vitest'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { TrackingLinkRecord } from '../../../src/types/tms'
import { ingestProviderDelivery, putPing, type ProviderDeliveryDeps } from './trackingPings'

class ConditionalCheckFailedException extends Error {
  name = 'ConditionalCheckFailedException'
}

function fakeDdb() {
  const rows = new Map<string, Record<string, unknown>>()
  const ddb = {
    send: async (cmd: { input: { Item: Record<string, unknown>; ConditionExpression?: string } }) => {
      const item = cmd.input.Item
      const key = `${item.truckId as string}|${item.locatedAt as string}`
      if (cmd.input.ConditionExpression === 'attribute_not_exists(locatedAt)' && rows.has(key)) {
        throw new ConditionalCheckFailedException('exists')
      }
      rows.set(key, item)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  return { ddb, rows }
}

const NOW = '2026-11-04T15:00:00.000Z'

function link(over: Partial<TrackingLinkRecord> = {}): TrackingLinkRecord {
  return {
    id: 'tok-1', kind: 'PROVIDER_TRACK', provider: 'MACROPOINT', shipmentId: 'S1', loadId: 'L1', loadCarrierId: 'LC1',
    status: 'ACTIVE', expiresAt: '2026-11-10T00:00:00.000Z', createdBy: 'staff@x.com', ...over,
  }
}

function setup(opts: { link?: TrackingLinkRecord | null; closed?: boolean } = {}) {
  const { ddb, rows } = fakeDdb()
  const bumps: Array<{ token: string; n: number }> = []
  const deps: ProviderDeliveryDeps = {
    ddb,
    table: 'History',
    getLink: async (t) => (opts.link === null ? null : t === 'tok-1' ? (opts.link ?? link()) : null),
    bumpLink: async (token, n) => { bumps.push({ token, n }) },
    loadClosed: async () => opts.closed ?? false,
  }
  return { deps, rows, bumps }
}

const delivery = (reference: string, fixes: Array<{ refId: string; at: string }>) => ({
  headers: {},
  body: JSON.stringify({ reference, status: 'ACTIVE', fixes: fixes.map((f) => ({ ...f, lat: 41.5, lng: -88.1, accuracyM: 30 })) }),
})

describe('putPing', () => {
  it('reports a duplicate instead of throwing', async () => {
    const { ddb, rows } = fakeDdb()
    const input = { loadId: 'L1', at: NOW, lat: 41.5, lng: -88.1, source: 'link' as const, nowIso: NOW }
    expect(await putPing({ ddb, table: 'H' }, input)).toBe('WRITTEN')
    expect(await putPing({ ddb, table: 'H' }, input)).toBe('DUPLICATE')
    expect(rows.size).toBe(1)
  })

  it('does not swallow other failures', async () => {
    const ddb = { send: async () => { throw new Error('throttled') } } as unknown as DynamoDBDocumentClient
    await expect(putPing({ ddb, table: 'H' }, { loadId: 'L1', at: NOW, lat: 1, lng: 1, source: 'link', nowIso: NOW })).rejects.toThrow('throttled')
  })
})

describe('ingestProviderDelivery', () => {
  const two = [{ refId: 'a', at: '2026-11-04T14:00:00Z' }, { refId: 'b', at: '2026-11-04T14:05:00Z' }]

  it('files provider fixes against the link\u2019s load and counts only what it accepted', async () => {
    const { deps, rows, bumps } = setup()
    const out = await ingestProviderDelivery(deps, 'MACROPOINT', delivery('tok-1', two), NOW)
    expect(out).toEqual({ accepted: 2, duplicates: 0, ignored: null })
    expect([...rows.values()].map((r) => [r.truckId, r.source])).toEqual([['load:L1', 'provider:macropoint'], ['load:L1', 'provider:macropoint']])
    expect(bumps).toEqual([{ token: 'tok-1', n: 2 }])
  })

  it('a replay writes nothing and bumps nothing', async () => {
    const { deps, rows, bumps } = setup()
    await ingestProviderDelivery(deps, 'MACROPOINT', delivery('tok-1', two), NOW)
    const again = await ingestProviderDelivery(deps, 'MACROPOINT', delivery('tok-1', [...two, { refId: 'c', at: '2026-11-04T14:10:00Z' }]), NOW)
    expect(again).toEqual({ accepted: 1, duplicates: 2, ignored: null })
    expect(rows.size).toBe(3)
    expect(bumps.map((b) => b.n)).toEqual([2, 1])
    const noop = await ingestProviderDelivery(deps, 'MACROPOINT', delivery('tok-1', two), NOW)
    expect(noop.accepted).toBe(0)
    expect(bumps).toHaveLength(2)
  })

  it.each([
    ['an unknown reference', { link: null }, 'MACROPOINT'],
    ['a link of another provider', { link: link({ provider: 'TRUCKER_TOOLS' }) }, 'MACROPOINT'],
    ['a revoked link', { link: link({ status: 'REVOKED' }) }, 'MACROPOINT'],
    ['an expired link', { link: link({ expiresAt: '2026-11-01T00:00:00.000Z' }) }, 'MACROPOINT'],
    ['a carrier-ping link', { link: link({ kind: 'CARRIER_PING' }) }, 'MACROPOINT'],
    ['a non-tracking provider', {}, 'DAT'],
  ] as const)('ignores %s and writes nothing', async (_name, opts, key) => {
    const { deps, rows, bumps } = setup(opts)
    const out = await ingestProviderDelivery(deps, key, delivery('tok-1', two), NOW)
    expect(out.accepted).toBe(0)
    expect(out.ignored).not.toBeNull()
    expect(rows.size).toBe(0)
    expect(bumps).toHaveLength(0)
  })

  it('writes nothing for a closed load', async () => {
    const { deps, rows } = setup({ closed: true })
    const out = await ingestProviderDelivery(deps, 'MACROPOINT', delivery('tok-1', two), NOW)
    expect(out).toEqual({ accepted: 0, duplicates: 0, ignored: 'load-closed' })
    expect(rows.size).toBe(0)
  })

  it('ignores an unparseable body', async () => {
    const { deps, rows } = setup()
    const out = await ingestProviderDelivery(deps, 'MACROPOINT', { headers: {}, body: '{"orderId":"x"}' }, NOW)
    expect(out.ignored).toBe('unparseable')
    expect(rows.size).toBe(0)
  })

  it('truncates a delivery to 100 fixes', async () => {
    const { deps, rows } = setup()
    const many = Array.from({ length: 130 }, (_, i) => ({ refId: `r${i}`, at: new Date(Date.parse('2026-11-04T12:00:00Z') + i * 60_000).toISOString() }))
    const out = await ingestProviderDelivery(deps, 'MACROPOINT', delivery('tok-1', many), NOW)
    expect(out.accepted).toBe(100)
    expect(rows.size).toBe(100)
  })
})
