import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  runCheckCallPlan,
  saveCheckCallPlan,
  sweepCheckCallPlans,
  type CheckCallDeps,
} from './checkCallAgent'
import { threadKeyFor } from '../../../src/lib/shipmentThread'
import { MemoryStore, type Row } from './testSupport'

const CALLER = { email: 'ops@bcatcorp.com', sub: 'sub-ops', groups: [], isAdmin: false }

function makeDeps(store: MemoryStore, overrides: Partial<CheckCallDeps> = {}): CheckCallDeps {
  const sentSms = vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'tw-sid', error: null }))
  const sentEmail = vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'ses-ref', error: null }))
  return {
    tables: {
      message: 'ShipmentMessage-test',
      shipment: 'Shipment-test',
      order: 'Order-test',
      load: 'Load-test',
      loadCarrier: 'LoadCarrier-test',
      customer: 'Customer-test',
      settings: 'TmsSettings-test',
      document: 'ShipmentDocument-test',
      checkCall: 'LoadCheckCall-test',
      trackingLink: 'TrackingLink-test',
    },
    getById: (table, id) => Promise.resolve(store.getById(table, id)),
    queryIndex: (table, index, key, value) => Promise.resolve(store.queryIndex(table, index, key, value)),
    transact: (items: TransactWriteItem[]) => store.transact(items),
    readBundle: async () => ({}),
    getSettings: async () => store.getById('TmsSettings-test', 'settings-1') ?? {},
    writeAudit: vi.fn(async () => undefined),
    sendEmail: overrides.sendEmail ?? sentEmail,
    sendSms: overrides.sendSms ?? sentSms,
    geocode: overrides.geocode ?? vi.fn(async () => null),
    readDocumentBytes: overrides.readDocumentBytes ?? vi.fn(async () => new Uint8Array(0)),
    trackingUrl: (token) => `https://track.test/l/${token}`,
    now: () => currentTime,
    randomId: () => `r${Math.random().toString(36).slice(2)}`,
    ...overrides,
  }
}

let currentTime = '2026-02-02T12:00:00.000Z'

function seedSettings(store: MemoryStore): Row {
  return store.seed({
    id: 'settings-1',
    __typename: 'TmsSettings',
    defaultCheckCallPlan: {
      intervalHours: 4,
      channels: ['SMS', 'EMAIL'],
      milestones: ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'AT_DELIVERY', 'DELIVERED'],
      escalateAfterMinutes: 30,
      emailDispatcher: true,
      requestPodOnDelivery: true,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}

function seedCustomer(store: MemoryStore, overrides: Row = {}): Row {
  return store.seed({
    id: 'cus-1',
    __typename: 'Customer',
    name: 'ACME',
    checkCallPlan: null,
    ...overrides,
  })
}

function seedShipment(store: MemoryStore, overrides: Row = {}): Row {
  return store.seed({
    id: 'shp-1',
    __typename: 'Shipment',
    number: 'BC1001',
    status: 'IN_TRANSIT',
    customerId: 'cus-1',
    threadKey: threadKeyFor('shp-1'),
    threadOpenedAt: '2026-01-01T00:00:00.000Z',
    trackingFlaggedAt: null,
    podFlaggedAt: null,
    version: 1,
    createdBy: CALLER.email,
    updatedBy: CALLER.email,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  })
}

function seedLoad(store: MemoryStore, overrides: Row = {}): Row {
  return store.seed({
    id: 'lod-1',
    __typename: 'Load',
    shipmentId: 'shp-1',
    loadNumber: 'BC1001-1',
    status: 'IN_TRANSIT',
    activeLoadCarrierId: 'lc-1',
    stops: [
      { id: 'stp-1', type: 'pickup', sequence: 1, city: 'Chicago', state: 'IL' },
      { id: 'stp-2', type: 'delivery', sequence: 2, city: 'Dallas', state: 'TX' },
    ],
    checkCallPlan: null,
    checkCallOpen: null,
    nextCheckCallAt: null,
    checkCallAwaitingSince: null,
    checkCallEscalatedAt: null,
    checkCallFlaggedAt: null,
    lastCheckCallAt: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  })
}

function seedCarrier(store: MemoryStore, overrides: Row = {}): Row {
  return store.seed({
    id: 'lc-1',
    __typename: 'LoadCarrier',
    loadId: 'lod-1',
    shipmentId: 'shp-1',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierName: 'Swift',
    driverName: 'Jose',
    driverPhone: '+12245550137',
    dispatcherEmail: 'dispatch@swift.test',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  })
}

function seedLink(store: MemoryStore, overrides: Row = {}): Row {
  return store.seed({
    id: 'link-1',
    __typename: 'TrackingLink',
    kind: 'CARRIER_PING',
    shipmentId: 'shp-1',
    loadId: 'lod-1',
    loadCarrierId: 'lc-1',
    status: 'ACTIVE',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  })
}

function messagesForLoad(store: MemoryStore, loadId: string): Row[] {
  return store
    .queryIndex('ShipmentMessage-test', 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', 'shp-1')
    .filter((m) => m.loadId === loadId)
}

describe('runCheckCallPlan', () => {
  beforeEach(() => {
    currentTime = '2026-02-02T12:00:00.000Z'
  })

  it('sends SMS and dispatcher email at the DISPATCHED milestone', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, { status: 'DISPATCHED' })
    seedCarrier(store)
    seedLink(store)
    const deps = makeDeps(store)

    const result = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)

    expect(result.acted).toBe(1)
    expect(result.skipped).toBe(0)
    const msgs = messagesForLoad(store, 'lod-1')
    expect(msgs.filter((m) => m.channel === 'SMS' && m.kind === 'CHECK_CALL').length).toBe(1)
    expect(msgs.filter((m) => m.channel === 'EMAIL' && m.kind === 'CHECK_CALL').length).toBe(1)
    expect(msgs.every((m) => m.authorKind === 'AGENT')).toBe(true)

    const load = store.getById('Load-test', 'lod-1')
    expect(load?.lastCheckCallAt).toBe(currentTime)
    expect(load?.checkCallAwaitingSince).toBe(currentTime)
    expect(load?.checkCallOpen).toBe('OPEN')
    expect(load?.nextCheckCallAt).toBe('2026-02-02T16:00:00.000Z')
  })

  it('does not resend the same milestone', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, { status: 'DISPATCHED' })
    seedCarrier(store)
    seedLink(store)
    const deps = makeDeps(store)

    await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    const second = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)

    expect(second.acted).toBe(0)
    expect(second.skipped).toBe(1)
    const msgs = messagesForLoad(store, 'lod-1')
    expect(msgs.length).toBe(2) // one SMS + one email only
  })

  it('sends a cadence message once the interval has elapsed', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, { status: 'IN_TRANSIT' })
    seedCarrier(store)
    seedLink(store)
    const deps = makeDeps(store)

    await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER) // IN_TRANSIT milestone
    currentTime = '2026-02-02T16:00:01.000Z'
    const second = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)

    expect(second.acted).toBe(1)
    expect(second.skipped).toBe(0)
    const cadence = messagesForLoad(store, 'lod-1').find((m) => typeof m.id === 'string' && m.id.startsWith('msg:lod-1:r'))
    expect(cadence?.kind).toBe('CHECK_CALL')
  })

  it('emails the dispatcher after silence, then raises an exception after a second grace period', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, {
      status: 'IN_TRANSIT',
      checkCallAwaitingSince: '2026-02-02T11:25:00.000Z',
      checkCallOpen: 'OPEN',
      nextCheckCallAt: currentTime,
    })
    seedCarrier(store)
    seedLink(store)
    const deps = makeDeps(store)

    const first = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(first.acted).toBe(1)

    const load = store.getById('Load-test', 'lod-1')
    expect(load?.checkCallEscalatedAt).toBe(currentTime)
    expect(load?.checkCallFlaggedAt).toBeNull()
    const shipment = store.getById('Shipment-test', 'shp-1')
    expect(shipment?.trackingFlaggedAt).toBeNull()

    const msgs = messagesForLoad(store, 'lod-1')
    const dispatcherEmail = msgs.find((m) => m.channel === 'EMAIL' && m.kind === 'ESCALATION')
    expect(dispatcherEmail).toBeDefined()
    expect(dispatcherEmail?.authorKind).toBe('AGENT')
    expect(dispatcherEmail?.body).toMatch(/BCAT Tracking Assistant/)

    // A second run while still in the same silence does nothing.
    const second = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(second.acted).toBe(0)

    // Advance past the second grace period; the exception rung fires once.
    currentTime = '2026-02-02T13:00:00.000Z'
    const third = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(third.escalated).toBe(1)

    const loadAfter = store.getById('Load-test', 'lod-1')
    expect(loadAfter?.checkCallFlaggedAt).toBe(currentTime)
    const shipmentAfter = store.getById('Shipment-test', 'shp-1')
    expect(shipmentAfter?.trackingFlaggedAt).toBe(currentTime)

    const fourth = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(fourth.escalated).toBe(0)
  })

  it('is quiet when the load is not in motion and all milestones are sent', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store, { status: 'DELIVERED' })
    seedLoad(store, { status: 'DELIVERED', checkCallOpen: 'OPEN' })
    seedCarrier(store)
    const deps = makeDeps(store)
    // Mark DELIVERED milestone already sent.
    store.seed({
      id: 'msg:lod-1:DELIVERED',
      __typename: 'ShipmentMessage',
      shipmentId: 'shp-1',
      threadKey: threadKeyFor('shp-1'),
      loadId: 'lod-1',
      direction: 'OUT',
      channel: 'SMS',
      kind: 'CHECK_CALL',
      status: 'SENT',
      at: '2026-02-02T11:00:00.000Z',
      createdBy: CALLER.email,
      updatedAt: '2026-02-02T11:00:00.000Z',
    })

    const result = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)

    expect(result.acted).toBe(0)
    expect(result.skipped).toBe(1)
    const load = store.getById('Load-test', 'lod-1')
    expect(load?.checkCallOpen).toBeUndefined()
  })

  it('keeps VOICE in a stored plan but never sends it', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, { status: 'DISPATCHED', checkCallPlan: JSON.stringify({ channels: ['VOICE', 'SMS'] }) })
    seedCarrier(store)
    seedLink(store)
    const deps = makeDeps(store)

    const result = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)

    expect(result.acted).toBe(1)
    const msgs = messagesForLoad(store, 'lod-1')
    expect(msgs.some((m) => m.channel === 'VOICE')).toBe(false)
    expect(msgs.filter((m) => m.channel === 'SMS').length).toBe(1)
  })

  it('leaves the load clock untouched when the send is refused', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, { status: 'DISPATCHED' })
    seedCarrier(store)
    seedLink(store)
    const sendSms = vi.fn(async () => ({ status: 'NOT_SENT' as const, providerRef: null, error: 'Twilio unconfigured' }))
    const sendEmail = vi.fn(async () => ({ status: 'NOT_SENT' as const, providerRef: null, error: 'SES unconfigured' }))
    const deps = makeDeps(store, { sendSms, sendEmail })

    const before = store.getById('Load-test', 'lod-1')
    const result = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    const after = store.getById('Load-test', 'lod-1')

    expect(result.acted).toBe(0)
    expect(after?.checkCallAwaitingSince).toBe(before?.checkCallAwaitingSince)
    expect(after?.checkCallOpen).toBe(before?.checkCallOpen)
    expect(after?.lastCheckCallAt).toBe(before?.lastCheckCallAt)
    expect(after?.nextCheckCallAt).toBe(before?.nextCheckCallAt)
  })
})

describe('saveCheckCallPlan', () => {
  it('stores a plan that lists VOICE', async () => {
    const store = new MemoryStore()
    seedLoad(store)
    const deps = makeDeps(store)

    const result = await saveCheckCallPlan(
      deps,
      {
        loadId: 'lod-1',
        expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
        plan: { channels: ['VOICE'], intervalHours: 4 },
      },
      CALLER,
    )

    const savedPlan = result.plan as { channels: string[] }
    expect(savedPlan.channels).toContain('VOICE')
    const load = store.getById('Load-test', 'lod-1')
    const stored = JSON.parse(String(load?.checkCallPlan ?? '{}'))
    expect(stored.channels).toContain('VOICE')
  })

  it('fails CAS when expectedUpdatedAt does not match', async () => {
    const store = new MemoryStore()
    seedLoad(store)
    const deps = makeDeps(store)

    await expect(
      saveCheckCallPlan(
        deps,
        { loadId: 'lod-1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', plan: { intervalHours: 2 } },
        CALLER,
      ),
    ).rejects.toThrow('CAS')
  })
})

describe('sweepCheckCallPlans', () => {
  it('runs loads whose nextCheckCallAt is now or in the past', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, {
      status: 'IN_TRANSIT',
      checkCallOpen: 'OPEN',
      nextCheckCallAt: '2026-02-02T11:59:00.000Z',
      lastCheckCallAt: '2026-02-02T08:00:00.000Z',
    })
    seedCarrier(store)
    seedLink(store)
    const deps = makeDeps(store)

    const result = await sweepCheckCallPlans(deps, CALLER)

    expect(result.acted).toBeGreaterThan(0)
    expect(result.checked).toBeGreaterThan(0)
  })

  it('continues past one shipment that throws', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)

    seedShipment(store, { id: 'shp-1', number: 'BC1001' })
    seedLoad(store, { id: 'lod-1', shipmentId: 'shp-1', status: 'DISPATCHED', checkCallOpen: 'OPEN', nextCheckCallAt: currentTime })
    seedCarrier(store)
    seedLink(store)

    seedShipment(store, { id: 'shp-2', number: 'BC1002' })
    seedLoad(store, {
      id: 'lod-2',
      shipmentId: 'shp-2',
      status: 'DISPATCHED',
      checkCallOpen: 'OPEN',
      nextCheckCallAt: currentTime,
      activeLoadCarrierId: 'lc-2',
    })
    seedCarrier(store, { id: 'lc-2', loadId: 'lod-2', shipmentId: 'shp-2', status: 'ACTIVE' })
    seedLink(store, { id: 'link-2', shipmentId: 'shp-2', loadId: 'lod-2', loadCarrierId: 'lc-2' })

    const deps = makeDeps(store)
    const originalGetById = deps.getById
    deps.getById = async (table, id) => {
      if (table === deps.tables.shipment && id === 'shp-1') throw new Error('boom')
      return originalGetById(table, id)
    }

    const result = await sweepCheckCallPlans(deps, CALLER)

    expect(result.errors).toBe(1)
    expect(result.acted).toBe(1)
    expect(result.checked).toBe(1)
  })
})
