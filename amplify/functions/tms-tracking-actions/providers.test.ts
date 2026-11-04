import { describe, expect, it, vi } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { simProviderDelivery, startProviderTracking, stopProviderTracking, type ProviderActionDeps } from './providers'
import type { Row } from '../_shared/shipmentStore'

const TABLES = { trackingLink: 'link', loadCarrier: 'lc', load: 'load', shipment: 'shp' }
const NOW = '2026-11-04T15:00:00.000Z'
const ADMIN = { email: 'ryne@bcatcorp.com', sub: 's', groups: [], isAdmin: true }
const DISPATCHER = { email: 'd@bcatcorp.com', sub: 's2', groups: ['page-loads'], isAdmin: false }

const STOPS = JSON.stringify([
  { id: 'p', type: 'pickup', sequence: 1, address: { city: 'Joliet', state: 'IL' }, appt: '2026-11-04T10:00:00.000Z' },
  { id: 'd', type: 'delivery', sequence: 2, address: { city: 'Dallas', state: 'TX' }, appt: '2026-11-06T09:00:00.000Z' },
])

/** Rows by table, a transact that applies Put / Update(SET) so a test reads back what was written. */
function fixture(seed: { carrier?: Row; load?: Row; shipment?: Row; links?: Row[] } = {}, dev = true) {
  const rows = new Map<string, Map<string, Row>>()
  const put = (table: string, row: Row) => {
    if (!rows.has(table)) rows.set(table, new Map())
    rows.get(table)!.set(String(row.id), row)
  }
  put(TABLES.loadCarrier, { id: 'lc-1', loadId: 'ld-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE', carrierName: 'Acme Freight', carrierMc: 'MC1', ...seed.carrier })
  put(TABLES.load, { id: 'ld-1', status: 'IN_TRANSIT', stops: STOPS, ...seed.load })
  put(TABLES.shipment, { id: 'shp-1', number: 'S-1', ...seed.shipment })
  for (const l of seed.links ?? []) put(TABLES.trackingLink, l)

  const apply = (item: TransactWriteItem) => {
    if (item.Put) put(item.Put.TableName!, unmarshall(item.Put.Item as Record<string, AttributeValue>))
    if (item.Update) {
      const u = item.Update
      const id = String(unmarshall(u.Key as Record<string, AttributeValue>).id)
      const row = rows.get(u.TableName!)!.get(id)!
      for (const [ph, attr] of Object.entries(u.ExpressionAttributeNames ?? {})) {
        const val = u.ExpressionAttributeValues?.[`:${ph.slice(1)}`]
        if (val) row[attr] = unmarshall({ v: val }).v
      }
    }
  }
  const pingPuts: Row[] = []
  const subscribed: string[] = []
  const audits: Row[] = []
  const deps: ProviderActionDeps = {
    tables: TABLES,
    getById: async (table, id) => (rows.get(table)?.get(id) ? { ...rows.get(table)!.get(id)! } : null),
    queryIndex: async (table, _i, key, value) => [...(rows.get(table)?.values() ?? [])].filter((r) => r[key] === value),
    transact: async (items) => { items.forEach(apply) },
    getSettings: async () => null,
    writeAudit: async (type, id, action, caller, changes) => { audits.push({ type, id, action, by: caller.email, ...changes }) },
    now: () => NOW,
    newToken: () => { subscribed.push('t'); return `tok-${subscribed.length}` },
    bumpLink: vi.fn(async () => {}),
    ping: {
      table: 'hist',
      ddb: { send: async (cmd: { input: { Item: Row } }) => { pingPuts.push(cmd.input.Item) } } as unknown as DynamoDBDocumentClient,
    },
    isDevStack: () => dev,
  }
  return { deps, rows, pingPuts, audits, link: (id: string) => rows.get(TABLES.trackingLink)?.get(id) }
}

describe('START_PROVIDER_TRACKING', () => {
  it('records an honest STUB subscription: ACTIVE row, STUB message, providerRef, audit', async () => {
    const f = fixture()
    const res = await startProviderTracking(f.deps, { loadCarrierId: 'lc-1', provider: 'macropoint' }, DISPATCHER)
    expect(res.mode).toBe('STUB')
    expect(String(res.message)).toMatch(/^STUB — /)
    expect(f.link('tok-1')).toMatchObject({
      kind: 'PROVIDER_TRACK', provider: 'MACROPOINT', status: 'ACTIVE', loadId: 'ld-1', loadCarrierId: 'lc-1', providerRef: 'stub:tok-1',
    })
    expect(Date.parse(String(f.link('tok-1')!.expiresAt))).toBeGreaterThan(Date.parse(NOW))
    expect(f.audits).toHaveLength(1)
    expect(f.audits[0]).toMatchObject({ action: 'START_PROVIDER_TRACKING', provider: 'MACROPOINT' })
  })

  it('a second start revokes the first subscription for the same leg', async () => {
    const f = fixture()
    await startProviderTracking(f.deps, { loadCarrierId: 'lc-1', provider: 'MACROPOINT' }, DISPATCHER)
    await startProviderTracking(f.deps, { loadCarrierId: 'lc-1', provider: 'MACROPOINT' }, DISPATCHER)
    expect(f.link('tok-1')).toMatchObject({ status: 'REVOKED', revokedBy: DISPATCHER.email })
    expect(f.link('tok-2')).toMatchObject({ status: 'ACTIVE' })
  })

  it('leaves the driver ping link alone', async () => {
    const f = fixture({ links: [{ id: 'ping', kind: 'CARRIER_PING', status: 'ACTIVE', loadId: 'ld-1', loadCarrierId: 'lc-1' }] })
    await startProviderTracking(f.deps, { loadCarrierId: 'lc-1', provider: 'MACROPOINT' }, DISPATCHER)
    expect(f.link('ping')).toMatchObject({ status: 'ACTIVE' })
  })

  it.each([
    ['an own-asset leg', { carrier: { kind: 'OWN_ASSET' } }, 'MACROPOINT', /Own trucks/],
    ['a leg that is no longer active', { carrier: { status: 'REPLACED' } }, 'MACROPOINT', /currently on the load/],
    ['a closed load', { load: { status: 'DELIVERED' } }, 'MACROPOINT', /nothing left to track/],
    ['a voided shipment', { shipment: { voidedAt: NOW } }, 'MACROPOINT', /voided/],
    ['a provider that is not a tracking provider', {}, 'OTR', /not a tracking provider/],
    ['an unknown provider', {}, 'NOPE', /not a tracking provider/],
  ])('refuses %s and writes nothing', async (_n, seed, provider, message) => {
    const f = fixture(seed as Parameters<typeof fixture>[0])
    await expect(startProviderTracking(f.deps, { loadCarrierId: 'lc-1', provider }, DISPATCHER)).rejects.toThrow(message)
    expect(f.rows.get(TABLES.trackingLink)).toBeUndefined()
    expect(f.audits).toHaveLength(0)
  })
})

describe('STOP_PROVIDER_TRACKING', () => {
  it('revokes an active subscription and is a no-op on one already stopped', async () => {
    const f = fixture()
    await startProviderTracking(f.deps, { loadCarrierId: 'lc-1', provider: 'MACROPOINT' }, DISPATCHER)
    const res = await stopProviderTracking(f.deps, { linkId: 'tok-1' }, DISPATCHER)
    expect(String(res.message)).toMatch(/^STUB — /)
    expect(f.link('tok-1')).toMatchObject({ status: 'REVOKED' })
    const audits = f.audits.length
    await stopProviderTracking(f.deps, { linkId: 'tok-1' }, DISPATCHER)
    expect(f.audits).toHaveLength(audits)
  })

  it('refuses a driver ping link', async () => {
    const f = fixture({ links: [{ id: 'ping', kind: 'CARRIER_PING', status: 'ACTIVE' }] })
    await expect(stopProviderTracking(f.deps, { linkId: 'ping' }, DISPATCHER)).rejects.toThrow(/not a provider/)
  })
})

describe('TRACKING_SIM_PROVIDER', () => {
  const live = { id: 'tok', kind: 'PROVIDER_TRACK', provider: 'MACROPOINT', status: 'ACTIVE', loadId: 'ld-1', expiresAt: '2099-01-01T00:00:00.000Z' }
  const input = { linkId: 'tok', fixes: [{ minutesAgo: 30, lat: 41.5, lng: -88 }, { minutesAgo: 5, lat: 41.1, lng: -87.9, speedMph: 55 }] }

  it('refuses outside the dev stack and for a non-admin', async () => {
    await expect(simProviderDelivery(fixture({ links: [live] }, false).deps, input, ADMIN)).rejects.toThrow('This action only exists on the dev stack')
    await expect(simProviderDelivery(fixture({ links: [live] }).deps, input, DISPATCHER)).rejects.toThrow(/ADMIN/)
  })

  it('runs the webhook consumer chain: breadcrumbs under the load, source provider:macropoint', async () => {
    const f = fixture({ links: [live] })
    const out = await simProviderDelivery(f.deps, input, ADMIN)
    expect(out).toMatchObject({ accepted: 2, duplicates: 0, ignored: null })
    expect(f.pingPuts.map((r) => [r.truckId, r.source])).toEqual([['load:ld-1', 'provider:macropoint'], ['load:ld-1', 'provider:macropoint']])
    expect(f.deps.bumpLink).toHaveBeenCalledWith('tok', 2, expect.any(String))
  })

  it('files nothing for a closed load', async () => {
    const f = fixture({ links: [live], load: { status: 'DELIVERED' } })
    expect(await simProviderDelivery(f.deps, input, ADMIN)).toMatchObject({ accepted: 0, ignored: 'load-closed' })
    expect(f.pingPuts).toHaveLength(0)
  })
})
