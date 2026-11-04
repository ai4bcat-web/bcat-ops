import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { runTrackingAutomation, type AutomationDeps } from './automation'
import { runCheckCallPlan } from './checkCallAgent'
import { resolveDriverSms, resolveDriverSmsForLeg } from './driverPhone'
import { sendShipmentMessage } from './thread'
import { MemoryStore, type Row } from './testSupport'

const CALLER = { email: 'ops@bcatcorp.com', sub: 'sub-ops', groups: [], isAdmin: false }
const SYSTEM = { email: 'system@bcatcorp.com', sub: 'tracking-automation', groups: [], isAdmin: false }

const TRUCK_PHONE = '+13125550111'
const PERSONAL = '+13125550122'
const SNAPSHOT = '+12245550137'

let now = '2026-02-02T12:00:00.000Z' // 06:00 CST — outside the default quiet window
let seq = 0

function makeDeps(store: MemoryStore, opts: { withPhones?: boolean } = {}): AutomationDeps & { sendSms: Mock; sendEmail: Mock } {
  const withPhones = opts.withPhones ?? true
  const sendSms = vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'tw', error: null }))
  const sendEmail = vi.fn(async () => ({ status: 'SENT' as const, providerRef: 'ses', error: null }))
  return {
    tables: {
      message: 'ShipmentMessage-test', shipment: 'Shipment-test', order: 'Order-test', load: 'Load-test',
      loadCarrier: 'LoadCarrier-test', customer: 'Customer-test', settings: 'TmsSettings-test',
      document: 'ShipmentDocument-test', checkCall: 'LoadCheckCall-test', trackingLink: 'TrackingLink-test',
      ...(withPhones ? { driver: 'Driver-test' } : {}),
    },
    getById: (t, id) => Promise.resolve(store.getById(t, id)),
    ...(withPhones ? { getTruckConfig: (truckId: string) => Promise.resolve(store.getById('TruckConfig-test', truckId)) } : {}),
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
    queryDeliveredShipments: async () => [],
    now: () => now,
    randomId: () => `r${++seq}`,
  }
}

const ON = { trackingAutomation: { global: { checkCallsAuto: true, podAuto: true } } }

interface SeedOpts { settings?: Row; customer?: Row; shipment?: Row; load?: Row; carrier?: Row }

/** A brokered, rate-con-sent leg by default; pass `carrier` to turn it into an own-fleet leg. */
function seed(store: MemoryStore, o: SeedOpts = {}): void {
  store.seed({ id: 'settings-1', __typename: 'TmsSettings', updatedAt: '2026-01-01T00:00:00.000Z', ...o.settings })
  store.seed({ id: 'cus-1', __typename: 'Customer', name: 'ACME', ...o.customer })
  store.seed({
    id: 'shp-1', __typename: 'Shipment', number: 'BC1001', status: 'IN_TRANSIT', customerId: 'cus-1',
    threadKey: 'tracking+shp-1', pickupAppt: '2026-01-30T12:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...o.shipment,
  })
  store.seed({
    id: 'lod-1', __typename: 'Load', shipmentId: 'shp-1', loadNumber: 'BC1001-1', status: 'DISPATCHED',
    activeLoadCarrierId: 'lc-1', stops: [], checkCallOpen: 'OPEN', nextCheckCallAt: '2026-02-02T11:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z', ...o.load,
  })
  store.seed({
    id: 'lc-1', __typename: 'LoadCarrier', loadId: 'lod-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE',
    carrierName: 'Swift', driverPhone: SNAPSHOT, dispatcherEmail: 'dispatch@swift.test', rateConStatus: 'SENT',
    updatedAt: '2026-01-02T00:00:00.000Z', ...o.carrier,
  })
}

/** An own-fleet leg: truck 12 with a work phone, a driver with a personal number. */
const OWN_FLEET: Row = {
  kind: 'OWN_ASSET', carrierName: null, dispatcherEmail: null, rateConStatus: null,
  driverId: 'drv-1', truckId: 'trk-12', truckNumber: '12', driverPhone: PERSONAL,
}

function seedFleet(store: MemoryStore, truck: Row | null = { phone: TRUCK_PHONE, phoneLabel: 'Cab phone' }): void {
  store.seed({ id: 'drv-1', __typename: 'Driver', name: 'Jose', phone: PERSONAL, assignedTruckId: 'trk-12' })
  if (truck) store.seed({ id: 'trk-12', truckId: 'trk-12', __typename: 'TruckConfig', unitNumber: '12', ...truck })
}

const messages = (store: MemoryStore) =>
  store.queryIndex('ShipmentMessage-test', 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', 'shp-1')
const smsRows = (store: MemoryStore) => messages(store).filter((m) => m.channel === 'SMS')
const channels = (store: MemoryStore) => messages(store).map((m) => m.channel).sort()

beforeEach(() => {
  now = '2026-02-02T12:00:00.000Z'
})

describe('tracking mode (AJ): MANUAL blocks automatic requests only', () => {
  it('AUTO sends nothing for a MANUAL customer, and says why', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON, customer: { trackingMode: 'MANUAL' } })
    const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
    expect(result.acted).toBe(0)
    expect(messages(store)).toHaveLength(0)
    expect(result.reasons.join(' ')).toMatch(/Customer tracking is manual/)
  })

  it('a person\'s Request check call still works for a MANUAL customer', async () => {
    const store = new MemoryStore()
    seed(store, { customer: { trackingMode: 'MANUAL' } }) // switches off too: manual is a person pressing the button
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(result.acted).toBe(1)
    expect(channels(store)).toEqual(['EMAIL', 'SMS'])
  })

  it('a shipment override beats the customer: AGENT on the shipment lets the sweep run for a MANUAL customer', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON, customer: { trackingMode: 'MANUAL' }, shipment: { trackingPrefs: { mode: 'AGENT' } } })
    const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
    expect(result.acted).toBe(1)
  })

  it('AUTO leaves the POD ask alone for a MANUAL customer', async () => {
    const store = new MemoryStore()
    seed(store, {
      settings: ON,
      customer: { trackingMode: 'MANUAL' },
      shipment: { status: 'DELIVERED' },
      load: { status: 'DELIVERED', nextCheckCallAt: null },
    })
    const deps = makeDeps(store)
    deps.queryDeliveredShipments = async () => [store.getById('Shipment-test', 'shp-1') as Row]
    const result = await runTrackingAutomation(deps, {}, SYSTEM)
    expect(result.pod.requested).toBe(0)
    expect(result.pod.skipped).toBe(1)
    expect(messages(store)).toHaveLength(0)
  })

  it('a null mode (legacy customer) lets Step V decide: switches on ⇒ sends', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON })
    const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
    expect(result.acted).toBe(1)
  })
})

describe('tracking method (AJ): filters channels in AUTO and manual runs', () => {
  it.each([
    ['EMAIL', ['EMAIL']],
    ['SMS', ['SMS']],
    ['BOTH', ['EMAIL', 'SMS']],
  ])('method %s sends %j', async (method, expected) => {
    for (const run of ['auto', 'manual'] as const) {
      const store = new MemoryStore()
      seed(store, { settings: ON, customer: { trackingMethod: method } })
      if (run === 'auto') await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
      else await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
      expect(channels(store), run).toEqual(expected)
    }
  })

  it('a shipment method override beats the customer', async () => {
    const store = new MemoryStore()
    seed(store, { customer: { trackingMethod: 'BOTH' }, shipment: { trackingPrefs: { method: 'EMAIL' } } })
    await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(channels(store)).toEqual(['EMAIL'])
  })

  it('an intersection with no channel left is reported, not sent', async () => {
    const store = new MemoryStore()
    seed(store, {
      settings: { defaultCheckCallPlan: { intervalHours: 4, channels: ['SMS'], milestones: ['DISPATCHED'], escalateAfterMinutes: 30, emailDispatcher: true } },
      customer: { trackingMethod: 'EMAIL' },
    })
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(result.acted).toBe(0)
    expect(result.reasons).toEqual(['Tracking method excludes every enabled channel'])
    expect(messages(store)).toHaveLength(0)
  })

  it('the POD sweep honours the method', async () => {
    const store = new MemoryStore()
    seed(store, {
      settings: ON,
      customer: { trackingMethod: 'SMS' },
      shipment: { status: 'DELIVERED' },
      load: { status: 'DELIVERED', nextCheckCallAt: null },
    })
    const deps = makeDeps(store)
    deps.queryDeliveredShipments = async () => [store.getById('Shipment-test', 'shp-1') as Row]
    await runTrackingAutomation(deps, {}, SYSTEM)
    expect(messages(store).filter((m) => m.kind === 'POD_REQUEST').map((m) => m.channel)).toEqual(['SMS'])
  })
})

describe('driver SMS routing (AK)', () => {
  it('a manual check call on an own-fleet leg texts the truck phone, not the personal number', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET })
    seedFleet(store)
    const deps = makeDeps(store)
    await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(smsRows(store).map((m) => m.to)).toEqual([TRUCK_PHONE])
    expect(deps.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: TRUCK_PHONE }))
  })

  it('falls back to the personal number only when the truck has no phone', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET })
    seedFleet(store, { phone: null })
    await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(smsRows(store).map((m) => m.to)).toEqual([PERSONAL])
  })

  it('uses the driver\'s assigned truck when the leg names none', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: { ...OWN_FLEET, truckId: null, truckNumber: null } })
    seedFleet(store)
    await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(smsRows(store).map((m) => m.to)).toEqual([TRUCK_PHONE])
  })

  it('the customer override WORK_ONLY never falls back, so a truck with no phone gets no text', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET, customer: { driverSmsTarget: 'WORK_ONLY' } })
    seedFleet(store, { phone: null })
    const result = await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(smsRows(store)).toHaveLength(0)
    expect(result.processed).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'Truck 12 has no work phone' })]))
  })

  it('the shipment override PERSONAL beats the customer and the truck phone', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET, customer: { driverSmsTarget: 'WORK_ONLY' }, shipment: { trackingPrefs: { driverSms: 'PERSONAL' } } })
    seedFleet(store)
    await runCheckCallPlan(makeDeps(store), { shipmentId: 'shp-1' }, CALLER)
    expect(smsRows(store).map((m) => m.to)).toEqual([PERSONAL])
  })

  it('the AUTO sweep still skips own-fleet legs (brokered only)', async () => {
    const store = new MemoryStore()
    seed(store, { settings: ON, carrier: OWN_FLEET })
    seedFleet(store)
    const result = await runTrackingAutomation(makeDeps(store), {}, SYSTEM)
    expect(result.acted).toBe(0)
    expect(messages(store)).toHaveLength(0)
    expect(result.reasons.join(' ')).toMatch(/Not a brokered carrier leg/)
  })

  it('a brokered leg is unchanged: the snapshot number, with or without the new lookups wired', async () => {
    for (const withPhones of [true, false]) {
      const store = new MemoryStore()
      seed(store, { settings: ON })
      await runTrackingAutomation(makeDeps(store, { withPhones }), {}, SYSTEM)
      expect(smsRows(store).map((m) => m.to), String(withPhones)).toEqual([SNAPSHOT])
    }
  })

  it('without the lookup tables an own-fleet leg uses the leg snapshot, exactly as before', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET })
    seedFleet(store)
    await runCheckCallPlan(makeDeps(store, { withPhones: false }), { shipmentId: 'shp-1' }, CALLER)
    expect(smsRows(store).map((m) => m.to)).toEqual([PERSONAL])
  })

  it('a failing truck lookup degrades to the personal number instead of failing the send', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET })
    seedFleet(store)
    const deps = makeDeps(store)
    deps.getTruckConfig = async () => { throw new Error('AccessDenied') }
    await runCheckCallPlan(deps, { shipmentId: 'shp-1' }, CALLER)
    expect(smsRows(store).map((m) => m.to)).toEqual([PERSONAL])
  })

  it('the composer (no `to`) goes to the truck phone; a typed number always wins', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET })
    seedFleet(store)
    const deps = makeDeps(store)
    const base = { shipmentId: 'shp-1', loadId: 'lod-1', loadCarrierId: 'lc-1', channel: 'SMS', kind: 'NOTE', party: 'DRIVER', body: 'Where are you?' }
    const routed = await sendShipmentMessage(deps, base, CALLER)
    const typed = await sendShipmentMessage(deps, { ...base, to: '+13125550199' }, CALLER)
    expect(routed.to).toBe(TRUCK_PHONE)
    expect(typed.to).toBe('+13125550199')
  })

  it('the composer refuses with the reason when WORK_ONLY finds no truck phone', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET, shipment: { trackingPrefs: { driverSms: 'WORK_ONLY' } } })
    seedFleet(store, { phone: null })
    const input = { shipmentId: 'shp-1', loadCarrierId: 'lc-1', channel: 'SMS', party: 'DRIVER', body: 'hi' }
    await expect(sendShipmentMessage(makeDeps(store), input, CALLER)).rejects.toThrow('Truck 12 has no work phone')
    expect(messages(store)).toHaveLength(0)
  })
})

describe('resolveDriverSms / resolveDriverSmsForLeg', () => {
  it('reports the source and the truck unit it used', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: OWN_FLEET })
    seedFleet(store)
    const deps = makeDeps(store)
    const carrier = store.getById('LoadCarrier-test', 'lc-1') as Row
    const shipment = store.getById('Shipment-test', 'shp-1') as Row
    const work = await resolveDriverSms(deps, { carrier, shipment, customer: null })
    expect(work).toMatchObject({ to: TRUCK_PHONE, source: 'WORK' })
    expect(work.phones.truckNumber).toBe('12')
    const viaLeg = await resolveDriverSmsForLeg(deps, { carrier })
    expect(viaLeg.to).toBe(TRUCK_PHONE)
  })

  it('a leg with no phone anywhere has nothing to send to', async () => {
    const store = new MemoryStore()
    seed(store, { carrier: { driverPhone: null } })
    const target = await resolveDriverSmsForLeg(makeDeps(store), { carrier: store.getById('LoadCarrier-test', 'lc-1') as Row })
    expect(target).toMatchObject({ to: null, source: 'NONE' })
  })
})
