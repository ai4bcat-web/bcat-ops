import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  runCheckCallPlan,
  saveCheckCallPlan,
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
    const cadence = messagesForLoad(store, 'lod-1').find((m) => typeof m.id === 'string' && m.id.startsWith('auto:cc:lc-1:'))
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
    // nothing is due: the worklist index's sort key is removed, not set to NULL (which DynamoDB refuses)
    expect(load && 'nextCheckCallAt' in load ? load.nextCheckCallAt : undefined).toBeUndefined()
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

  it('records a refused send as an attempt: it occupies the slot and a second run adds nothing', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, { status: 'IN_TRANSIT' })
    seedCarrier(store)
    seedLink(store)
    const sendSms = vi.fn(async () => ({ status: 'NOT_SENT' as const, providerRef: null, error: 'Twilio unconfigured' }))
    const sendEmail = vi.fn(async () => ({ status: 'NOT_SENT' as const, providerRef: null, error: 'SES unconfigured' }))
    const deps = makeDeps(store, { sendSms, sendEmail })

    const first = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(first.acted).toBe(1)
    const afterFirst = store.getById('Load-test', 'lod-1')
    expect(messagesForLoad(store, 'lod-1').every((m) => m.status === 'NOT_SENT')).toBe(true)
    expect(afterFirst?.lastCheckCallAt).toBe(currentTime)
    expect(afterFirst?.nextCheckCallAt).toBe('2026-02-02T16:00:00.000Z')
    expect(afterFirst?.checkCallAwaitingSince ?? null).toBeNull() // nothing reached a provider: no reply clock

    // An immediate second run, and every 5-minute tick until the next slot, adds no row.
    for (const t of ['2026-02-02T12:00:30.000Z', '2026-02-02T12:05:00.000Z', '2026-02-02T15:59:00.000Z']) {
      currentTime = t
      const again = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
      expect(again.acted).toBe(0)
    }
    expect(messagesForLoad(store, 'lod-1')).toHaveLength(2)
    expect(sendSms).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('anchors cadence slots to the plan start and sends at most once per channel per slot', async () => {
    const store = new MemoryStore()
    seedSettings(store)
    seedCustomer(store)
    seedShipment(store)
    seedLoad(store, { status: 'IN_TRANSIT' })
    seedCarrier(store)
    seedLink(store)
    // Refused sends start no reply clock, so the ladder stays on the cadence.
    const refused = async () => ({ status: 'NOT_SENT' as const, providerRef: null, error: 'unconfigured' })
    const deps = makeDeps(store, { sendSms: refused, sendEmail: refused })
    await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER) // first cadence send at 12:00 is slot 0 and starts the plan

    // 30 minutes late for slot 1 (16:00): the stamp is the slot start, so the cadence does not drift.
    currentTime = '2026-02-02T16:30:00.000Z'
    await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    const load = store.getById('Load-test', 'lod-1')
    expect(load?.lastCheckCallAt).toBe('2026-02-02T16:00:00.000Z')
    expect(load?.nextCheckCallAt).toBe('2026-02-02T20:00:00.000Z')
    expect(messagesForLoad(store, 'lod-1').map((m) => m.id).filter((id) => String(id).startsWith('auto:cc:')).sort()).toEqual([
      'auto:cc:lc-1:0:EMAIL',
      'auto:cc:lc-1:0:SMS',
      'auto:cc:lc-1:1:EMAIL',
      'auto:cc:lc-1:1:SMS',
    ])

    // MANUAL "Run now" in the same slot is a no-op.
    currentTime = '2026-02-02T17:00:00.000Z'
    const again = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(again.acted).toBe(0)
    expect(messagesForLoad(store, 'lod-1')).toHaveLength(4)
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

describe('runCheckCallPlan in AUTO mode', () => {
  const AUTO = { mode: 'AUTO' as const }
  // 2026-02-02 12:00Z is 06:00 CST; the default quiet window (21:00–06:00, SMS) has just ended.
  const QUIET_NOW = '2026-02-02T04:00:00.000Z' // 22:00 the evening before, Chicago

  beforeEach(() => {
    currentTime = '2026-02-02T12:00:00.000Z'
  })

  function seedAutoWorld(store: MemoryStore, customerOverrides: Row = {}, carrierOverrides: Row = {}) {
    seedSettings(store)
    seedCustomer(store, customerOverrides)
    seedShipment(store)
    seedLoad(store, { status: 'DISPATCHED' })
    seedCarrier(store, { rateConStatus: 'SENT', ...carrierOverrides })
    seedLink(store)
  }
  const switchedOn = { trackingAutomation: { checkCallsAuto: true } }

  it('sends nothing while every automatic switch is at its default (off)', async () => {
    const store = new MemoryStore()
    seedAutoWorld(store)
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(result.acted).toBe(0)
    expect(messagesForLoad(store, 'lod-1')).toHaveLength(0)
    expect(store.getById('Load-test', 'lod-1')?.lastCheckCallAt).toBeNull()
  })

  it('MANUAL ignores the switch, the rate-con guard and quiet hours', async () => {
    const store = new MemoryStore()
    seedAutoWorld(store, {}, { rateConStatus: 'NOT_SENT' })
    currentTime = QUIET_NOW
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(result.acted).toBe(1)
    expect(messagesForLoad(store, 'lod-1').map((m) => m.channel).sort()).toEqual(['EMAIL', 'SMS'])
  })

  it('sends by SMS and e-mail once the customer switches automatic check calls on', async () => {
    const store = new MemoryStore()
    seedAutoWorld(store, switchedOn)
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(result.acted).toBe(1)
    expect(messagesForLoad(store, 'lod-1').map((m) => m.channel).sort()).toEqual(['EMAIL', 'SMS'])
  })

  it('skips a leg whose rate confirmation was not sent, an own-fleet leg and a voided shipment', async () => {
    for (const carrier of [{ rateConStatus: 'NOT_SENT' }, { rateConStatus: 'DECLINED' }, { kind: 'OWN_ASSET' }]) {
      const store = new MemoryStore()
      seedAutoWorld(store, switchedOn, carrier)
      const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER, AUTO)
      expect(result.acted).toBe(0)
      expect(messagesForLoad(store, 'lod-1')).toHaveLength(0)
    }
    const store = new MemoryStore()
    seedAutoWorld(store, switchedOn)
    store.seed({ ...(store.getById('Shipment-test', 'shp-1') as Row), voidedAt: '2026-02-01T00:00:00.000Z' })
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(result.acted).toBe(0)
    expect(messagesForLoad(store, 'lod-1')).toHaveLength(0)
  })

  it('holds an SMS back in quiet hours but still e-mails, and defers entirely when every channel is quiet', async () => {
    const store = new MemoryStore()
    seedAutoWorld(store, switchedOn)
    currentTime = QUIET_NOW
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(result.acted).toBe(1)
    expect(messagesForLoad(store, 'lod-1').map((m) => m.channel)).toEqual(['EMAIL'])

    const quietAll = new MemoryStore()
    seedAutoWorld(quietAll, {
      trackingAutomation: { checkCallsAuto: true, quietHours: { enabled: true, start: '21:00', end: '06:00', timezone: 'America/Chicago', channels: ['SMS', 'EMAIL'] } },
    })
    currentTime = QUIET_NOW
    const deferred = await runCheckCallPlan(makeDeps(quietAll), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(deferred.deferred).toBe(1)
    expect(deferred.acted).toBe(0)
    expect(messagesForLoad(quietAll, 'lod-1')).toHaveLength(0)
    const load = quietAll.getById('Load-test', 'lod-1')
    expect(load?.lastCheckCallAt).toBeNull()

    // The window ends; the same tick is still due and goes out.
    currentTime = '2026-02-02T12:30:00.000Z'
    const later = await runCheckCallPlan(makeDeps(quietAll), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(later.acted).toBe(1)
    expect(messagesForLoad(quietAll, 'lod-1').map((m) => m.channel).sort()).toEqual(['EMAIL', 'SMS'])
  })

  it('does not stamp a partial quiet tick: the held SMS still goes out later in the same slot, the e-mail is not repeated', async () => {
    const store = new MemoryStore()
    seedAutoWorld(store, switchedOn)
    seedLoad(store, { status: 'IN_TRANSIT', lastCheckCallAt: '2026-02-01T22:00:00.000Z', checkCallPlanStartedAt: '2026-02-01T22:00:00.000Z' })
    for (const m of ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'AT_DELIVERY', 'DELIVERED']) {
      store.seed({ id: `msg:lod-1:${m}`, __typename: 'ShipmentMessage', shipmentId: 'shp-1', loadId: 'lod-1', channel: 'SMS', direction: 'OUT', at: '2026-02-01T22:00:00.000Z' })
    }
    // 04:00Z = 22:00 Chicago (quiet for SMS); slot 1 of the 4 h cadence anchored at 22:00Z is 02:00Z–06:00Z.
    currentTime = '2026-02-02T04:00:00.000Z'
    const deps = makeDeps(store)
    const first = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(first.acted).toBe(1)
    expect(first.deferred).toBe(1)
    expect(messagesForLoad(store, 'lod-1').filter((m) => m.kind === 'CHECK_CALL').map((m) => m.channel)).toEqual(['EMAIL'])
    expect(store.getById('Load-test', 'lod-1')?.lastCheckCallAt).toBe('2026-02-01T22:00:00.000Z') // not stamped

    // Still quiet at the next tick: nothing new.
    currentTime = '2026-02-02T04:05:00.000Z'
    const second = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(second.acted).toBe(0)
    expect(messagesForLoad(store, 'lod-1').filter((m) => m.kind === 'CHECK_CALL')).toHaveLength(1)

    // The window ends inside the same slot: the SMS goes out, the e-mail is not repeated, and the slot is spent.
    currentTime = '2026-02-02T05:05:00.000Z'
    const policy = { trackingAutomation: { checkCallsAuto: true, quietHours: { enabled: true, start: '21:00', end: '23:00', timezone: 'America/Chicago', channels: ['SMS'] } } }
    store.seed({ ...(store.getById('Customer-test', 'cus-1') as Row), ...policy })
    const third = await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(third.acted).toBe(1)
    const checkCalls = messagesForLoad(store, 'lod-1').filter((m) => m.kind === 'CHECK_CALL')
    expect(checkCalls.map((m) => m.id).sort()).toEqual(['auto:cc:lc-1:1:EMAIL', 'auto:cc:lc-1:1:SMS'])
    expect(store.getById('Load-test', 'lod-1')?.lastCheckCallAt).toBe('2026-02-02T02:00:00.000Z')
  })

  it('renders the customer templates for a cadence check call and appends the tracking link to an SMS without one', async () => {
    const store = new MemoryStore()
    seedAutoWorld(store, {
      trackingAutomation: {
        checkCallsAuto: true,
        templates: { checkCallSms: 'Hi {driverName}, where is {proNumber}?', checkCallEmailSubject: 'Status {proNumber}', checkCallEmailBody: 'Update on {loadNumber} from {origin}' },
      },
    })
    seedLoad(store, { status: 'IN_TRANSIT', lastCheckCallAt: '2026-02-02T07:00:00.000Z', checkCallPlanStartedAt: '2026-02-02T00:00:00.000Z', milestonesDone: true })
    // All milestones are already sent, so the next tick is cadence.
    for (const m of ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'AT_DELIVERY', 'DELIVERED']) {
      store.seed({ id: `msg:lod-1:${m}`, __typename: 'ShipmentMessage', shipmentId: 'shp-1', loadId: 'lod-1', channel: 'SMS', direction: 'OUT', at: '2026-02-02T00:00:00.000Z' })
    }
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(result.acted).toBe(1)
    const sent = messagesForLoad(store, 'lod-1').filter((m) => m.kind === 'CHECK_CALL')
    const sms = sent.find((m) => m.channel === 'SMS')
    const email = sent.find((m) => m.channel === 'EMAIL')
    expect(String(sms?.body)).toContain('Hi Jose, where is BC1001?')
    expect(String(sms?.body)).toContain('https://track.test/l/link-1')
    expect(email?.subject).toBe('Status BC1001')
    expect(String(email?.body)).toContain('Update on BC1001-1 from Chicago, IL')
  })

  it('applies a division plan when the customer has none', async () => {
    const store = new MemoryStore()
    seedAutoWorld(store, switchedOn)
    store.seed({
      ...(store.getById('TmsSettings-test', 'settings-1') as Row),
      trackingAutomation: { global: {}, divisions: { WEST: { plan: { intervalHours: 2, channels: ['EMAIL'], milestones: ['DISPATCHED'], escalateAfterMinutes: 30, emailDispatcher: true } } } },
    })
    store.seed({ ...(store.getById('Shipment-test', 'shp-1') as Row), revDivision: 'WEST' })
    await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER, AUTO)
    expect(messagesForLoad(store, 'lod-1').map((m) => m.channel)).toEqual(['EMAIL'])
  })
})
