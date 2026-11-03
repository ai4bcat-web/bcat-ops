import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { runTrackingAutomation, type AutomationDeps } from './automation'
import { requestPodForLeg } from './podReview'
import { MemoryStore, type Row } from './testSupport'

const ADMIN = { email: 'ryne@bcatcorp.com', sub: 'sub-admin', groups: ['ADMIN'], isAdmin: true }
const SYSTEM = { email: 'system@bcatcorp.com', sub: 'tracking-automation', groups: [], isAdmin: false }

let now = '2026-02-02T12:00:00.000Z' // 06:00 CST — outside the default quiet window
let seq = 0

function makeDeps(store: MemoryStore, overrides: Partial<AutomationDeps> = {}): AutomationDeps {
  const sendSms = vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'tw', error: null }))
  const sendEmail = vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'ses', error: null }))
  return {
    tables: {
      message: 'ShipmentMessage-test', shipment: 'Shipment-test', order: 'Order-test', load: 'Load-test',
      loadCarrier: 'LoadCarrier-test', customer: 'Customer-test', settings: 'TmsSettings-test',
      document: 'ShipmentDocument-test', checkCall: 'LoadCheckCall-test', trackingLink: 'TrackingLink-test',
    },
    getById: (t, id) => Promise.resolve(store.getById(t, id)),
    queryIndex: (t, i, k, v) => Promise.resolve(store.queryIndex(t, i, k, v)),
    transact: (items: TransactWriteItem[]) => store.transact(items),
    readBundle: async () => ({}),
    getSettings: async () => store.getById('TmsSettings-test', 'settings-1') ?? {},
    writeAudit: vi.fn(async () => undefined),
    sendEmail,
    sendSms,
    geocode: async () => null,
    readDocumentBytes: async () => new Uint8Array(0),
    trackingUrl: (token) => `https://track.test/l/${token}`,
    queryDeliveredShipments: async (since) =>
      [...(store as unknown as { table(n: string): Map<string, Row> }).table('Shipment-test').values()].filter(
        (s) => s.status === 'DELIVERED' && String(s.pickupAppt ?? '') >= since,
      ),
    now: () => now,
    randomId: () => `r${++seq}`,
    ...overrides,
  }
}

function seed(store: MemoryStore, opts: { settings?: Row; customer?: Row; shipment?: Row; load?: Row; carrier?: Row } = {}) {
  store.seed({ id: 'settings-1', __typename: 'TmsSettings', updatedAt: '2026-01-01T00:00:00.000Z', ...opts.settings })
  store.seed({ id: 'cus-1', __typename: 'Customer', name: 'ACME', ...opts.customer })
  store.seed({
    id: 'shp-1', __typename: 'Shipment', number: 'BC1001', status: 'IN_TRANSIT', customerId: 'cus-1',
    threadKey: 'tracking+shp-1', pickupAppt: '2026-01-30T12:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...opts.shipment,
  })
  store.seed({
    id: 'lod-1', __typename: 'Load', shipmentId: 'shp-1', loadNumber: 'BC1001-1', status: 'DISPATCHED',
    activeLoadCarrierId: 'lc-1', stops: [], checkCallOpen: 'OPEN', nextCheckCallAt: '2026-02-02T11:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z', ...opts.load,
  })
  store.seed({
    id: 'lc-1', __typename: 'LoadCarrier', loadId: 'lod-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE',
    carrierName: 'Swift', driverPhone: '+12245550137', dispatcherEmail: 'dispatch@swift.test', rateConStatus: 'SENT',
    updatedAt: '2026-01-02T00:00:00.000Z', ...opts.carrier,
  })
}

const messages = (store: MemoryStore) =>
  store.queryIndex('ShipmentMessage-test', 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', 'shp-1')

const ON = { trackingAutomation: { global: { checkCallsAuto: true, podAuto: true } } }

describe('runTrackingAutomation', () => {
  beforeEach(() => {
    now = '2026-02-02T12:00:00.000Z'
  })

  it('AUTO with every default sends nothing (master switches are off)', async () => {
    const store = new MemoryStore()
    seed(store, { shipment: { status: 'DELIVERED' }, load: { status: 'DELIVERED' } })
    const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
    expect(result.mode).toBe('AUTO')
    expect(result.acted).toBe(0)
    expect(result.pod.requested).toBe(0)
    expect(messages(store)).toHaveLength(0)
  })

  it('AUTO check-call pass sends on the settings-level switch and reports counts', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON })
    const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
    expect(result.checked).toBe(1)
    expect(result.acted).toBe(1)
    expect(messages(store).map((m) => m.channel).sort()).toEqual(['EMAIL', 'SMS'])
  })

  it('records NOT_SENT with the text when the providers refuse (dev)', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON })
    const refuse = { status: 'NOT_SENT' as const, providerRef: null, error: 'AccessDenied' }
    await runTrackingAutomation(makeDeps(store, { sendSms: async () => refuse, sendEmail: async () => refuse }), {}, SYSTEM)
    const rows = messages(store)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((m) => m.status === 'NOT_SENT' && m.error === 'AccessDenied' && String(m.body).length > 0)).toBe(true)
  })

  it('a refused send occupies its cadence slot: an immediate second run, and every later tick of the slot, add nothing', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON })
    const refuse = { status: 'NOT_SENT' as const, providerRef: null, error: 'AccessDenied' }
    const deps = makeDeps(store, { sendSms: async () => refuse, sendEmail: async () => refuse })
    const first = await runTrackingAutomation(deps, {}, SYSTEM)
    expect(first.acted).toBe(1)
    expect(messages(store)).toHaveLength(2)

    const load = store.getById('Load-test', 'lod-1')
    expect(load?.lastCheckCallAt).toBe(now)
    expect(load?.nextCheckCallAt).toBe('2026-02-02T16:00:00.000Z')

    const second = await runTrackingAutomation(deps, {}, SYSTEM)
    expect(second.checked).toBe(0) // no longer due: the sweep does not even pick it up
    const scoped = await runTrackingAutomation(deps, { shipmentIds: ['shp-1'] }, SYSTEM)
    expect(scoped.acted).toBe(0)
    now = '2026-02-02T12:05:00.000Z'
    await runTrackingAutomation(deps, { shipmentIds: ['shp-1'] }, SYSTEM)
    expect(messages(store)).toHaveLength(2)
  })

  it('does not touch loads that are not yet due', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON, load: { nextCheckCallAt: '2026-02-02T13:00:00.000Z' } })
    const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
    expect(result.checked).toBe(0)
    expect(messages(store)).toHaveLength(0)
  })

  it('scoped shipmentIds touch only those shipments', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON })
    store.seed({ id: 'shp-2', __typename: 'Shipment', number: 'BC1002', status: 'IN_TRANSIT', threadKey: 'tracking+shp-2', updatedAt: '2026-01-02T00:00:00.000Z' })
    store.seed({ id: 'lod-2', __typename: 'Load', shipmentId: 'shp-2', status: 'DISPATCHED', activeLoadCarrierId: 'lc-2', stops: [], checkCallOpen: 'OPEN', nextCheckCallAt: '2026-02-02T11:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })
    store.seed({ id: 'lc-2', __typename: 'LoadCarrier', loadId: 'lod-2', shipmentId: 'shp-2', kind: 'CARRIER', status: 'ACTIVE', driverPhone: '+12245550138', rateConStatus: 'SENT', updatedAt: '2026-01-02T00:00:00.000Z' })
    const result = await runTrackingAutomation(makeDeps(store), { shipmentIds: ['shp-2'] }, SYSTEM)
    expect(result.checked).toBe(1)
    expect(messages(store)).toHaveLength(0) // shp-1 untouched
    expect(store.queryIndex('ShipmentMessage-test', 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', 'shp-2').length).toBeGreaterThan(0)
  })

  it('MANUAL is refused for a non-admin (system) caller and ignores the switches for an admin', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: { rateConStatus: 'NOT_SENT' } })
    await expect(runTrackingAutomation(makeDeps(store), { mode: 'MANUAL' }, SYSTEM)).rejects.toThrow(/Forbidden/)
    const result = await runTrackingAutomation(makeDeps(store), { mode: 'MANUAL' }, ADMIN)
    expect(result.mode).toBe('MANUAL')
    expect(result.acted).toBe(1)
    expect(result.pod.checked).toBe(0) // MANUAL is the check-call pass only
  })

  it('rejects an oversize scope', async () => {
    const store = new MemoryStore()
    seed(store)
    const ids = Array.from({ length: 201 }, (_, i) => `s${i}`)
    await expect(runTrackingAutomation(makeDeps(store), { shipmentIds: ids }, SYSTEM)).rejects.toThrow(/200/)
  })

  it('counts a failing shipment as an error and carries on with the rest', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON })
    const deps = makeDeps(store)
    const getById = deps.getById
    deps.getById = async (t, id) => {
      if (t === deps.tables.shipment && id === 'shp-boom') throw new Error('boom')
      return getById(t, id)
    }
    const result = await runTrackingAutomation(deps, { shipmentIds: ['shp-boom', 'shp-1'] }, SYSTEM)
    expect(result.errors).toBe(1)
    expect(result.acted).toBe(1)
    expect(result.reasons.some((r) => r.includes('boom'))).toBe(true)
  })

  describe('POD pass', () => {
    const delivered = { shipment: { status: 'DELIVERED' }, load: { status: 'DELIVERED', checkCallOpen: undefined, nextCheckCallAt: undefined } }
    const podMessages = (store: MemoryStore) => messages(store).filter((m) => m.kind === 'POD_REQUEST')

    it('asks once per leg and channel, and a second sweep is a no-op', async () => {
      const store = new MemoryStore()
      seed(store, { settings: ON, ...delivered })
      const first = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      expect(first.pod.requested).toBe(2)
      expect(podMessages(store).map((m) => m.id).sort()).toEqual(['auto:pod:lc-1:EMAIL', 'auto:pod:lc-1:SMS'])
      expect(store.getById('LoadCarrier-test', 'lc-1')?.podRequestedAt).toBe(now)

      const second = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      expect(second.pod.requested).toBe(0)
      expect(second.errors).toBe(0)
      expect(podMessages(store)).toHaveLength(2)
    })

    it('does not ask a leg again once a person already requested the POD (manual then auto asks once)', async () => {
      const store = new MemoryStore()
      seed(store, { settings: ON, ...delivered })
      const deps = makeDeps(store)
      await requestPodForLeg(deps, {
        shipment: store.getById('Shipment-test', 'shp-1') as Row,
        load: store.getById('Load-test', 'lod-1') as Row,
        carrier: store.getById('LoadCarrier-test', 'lc-1') as Row,
        caller: ADMIN,
      })
      expect(podMessages(store).map((m) => m.channel).sort()).toEqual(['EMAIL', 'SMS'])

      const result = await runTrackingAutomation(deps, {}, SYSTEM)
      expect(result.pod.requested).toBe(0)
      expect(podMessages(store)).toHaveLength(2)
      expect(podMessages(store).some((m) => String(m.id).startsWith('auto:pod:'))).toBe(false)
    })

    it('only skips the channels a person already asked on', async () => {
      const store = new MemoryStore()
      seed(store, { settings: ON, ...delivered })
      const deps = makeDeps(store)
      await requestPodForLeg(deps, {
        shipment: store.getById('Shipment-test', 'shp-1') as Row,
        load: store.getById('Load-test', 'lod-1') as Row,
        carrier: store.getById('LoadCarrier-test', 'lc-1') as Row,
        channels: ['EMAIL'],
        caller: ADMIN,
      })
      await runTrackingAutomation(deps, {}, SYSTEM)
      expect(podMessages(store).map((m) => m.channel).sort()).toEqual(['EMAIL', 'SMS'])
      expect(podMessages(store).filter((m) => m.channel === 'EMAIL')).toHaveLength(1)
    })

    it('stays off unless podAuto is on, and honours podChannels', async () => {
      const off = new MemoryStore()
      seed(off, { settings: { trackingAutomation: { global: { checkCallsAuto: true } } }, ...delivered })
      expect((await runTrackingAutomation(makeDeps(off), {}, SYSTEM)).pod.requested).toBe(0)

      const emailOnly = new MemoryStore()
      seed(emailOnly, { settings: { trackingAutomation: { global: { podAuto: true, podChannels: ['EMAIL'] } } }, ...delivered })
      await runTrackingAutomation(makeDeps(emailOnly), {}, SYSTEM)
      expect(podMessages(emailOnly).map((m) => m.channel)).toEqual(['EMAIL'])
    })

    it('skips legs without a sent rate con, own-fleet legs and voided shipments', async () => {
      for (const world of [
        { carrier: { rateConStatus: 'NOT_SENT' } },
        { carrier: { kind: 'OWN_ASSET' } },
        { shipment: { status: 'DELIVERED', voidedAt: '2026-02-01T00:00:00.000Z' } },
      ]) {
        const store = new MemoryStore()
        seed(store, { settings: ON, ...delivered, ...world })
        await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
        expect(podMessages(store)).toHaveLength(0)
      }
    })

    it('looks back 21 days only', async () => {
      const store = new MemoryStore()
      seed(store, { settings: ON, ...delivered, shipment: { status: 'DELIVERED', pickupAppt: '2026-01-01T00:00:00.000Z' } })
      const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      expect(result.pod.checked).toBe(0)
    })

    it('sends the e-mail in quiet hours and the SMS after the window ends', async () => {
      const store = new MemoryStore()
      seed(store, { settings: ON, ...delivered })
      now = '2026-02-02T04:00:00.000Z' // 22:00 Chicago
      const night = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      expect(night.pod.requested).toBe(1)
      expect(podMessages(store).map((m) => m.channel)).toEqual(['EMAIL'])
      now = '2026-02-02T12:30:00.000Z'
      await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      expect(podMessages(store).map((m) => m.channel).sort()).toEqual(['EMAIL', 'SMS'])
    })

    it('defers entirely when every enabled channel is quiet', async () => {
      const store = new MemoryStore()
      seed(store, { settings: { trackingAutomation: { global: { podAuto: true, podChannels: ['SMS'] } } }, ...delivered })
      now = '2026-02-02T04:00:00.000Z'
      const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      expect(result.pod.deferred).toBe(1)
      expect(podMessages(store)).toHaveLength(0)
    })

    it('uses the POD templates, with the built-in subject when only the body is customised', async () => {
      const store = new MemoryStore()
      seed(store, { settings: { trackingAutomation: { global: { podAuto: true, templates: { podEmailBody: 'POD for {proNumber} please', podSms: 'POD {proNumber}' } } } }, ...delivered })
      await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      const email = podMessages(store).find((m) => m.channel === 'EMAIL')
      const sms = podMessages(store).find((m) => m.channel === 'SMS')
      expect(String(email?.body)).toContain('POD for BC1001 please')
      expect(email?.subject).toBe('Load BC1001 — POD needed')
      expect(String(sms?.body)).toContain('POD BC1001')
    })
  })
})
