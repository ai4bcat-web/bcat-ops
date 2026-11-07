import { describe, expect, it, vi } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  buildDriverRoster,
  driverIdFor,
  driverRoster,
  newStopEvents,
  projectLoadStream,
  PROJECTOR_ACTOR,
  type ProjectorDeps,
  type StreamEvent,
} from './handler'
import type { Row } from '../_shared/shipmentStore'
import { CHECK_CALL_TABLE, DRIVER_TABLE, FakeDynamo, NOW, TABLES } from './fakeTables'

type Stop = {
  id: string
  type: 'pickup' | 'delivery'
  sequence: number
  city?: string
  arrivedAt?: string | null
  departedAt?: string | null
}

const stops = (...list: Stop[]) => JSON.stringify(list)

const loadRow = (over: Row = {}): Row => ({
  __typename: 'Load',
  id: 'load-1',
  shipmentId: 'ship-1',
  orderId: 'order-1',
  loadNumber: 'S-1001-1',
  leg: 1,
  status: 'DISPATCHED',
  activeLoadCarrierId: 'lc-1',
  updatedAt: '2026-10-28T11:00:00.000Z',
  updatedBy: 'driver-app',
  createdBy: 'ryne@bcatcorp.com',
  stops: stops(
    { id: 'st-1', type: 'pickup', sequence: 0, city: 'JOLIET, IL' },
    { id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ' },
  ),
  ...over,
})

function setup(loads: Row[] = [loadRow()]): { db: FakeDynamo; deps: ProjectorDeps } {
  const db = new FakeDynamo()
  db.seed(TABLES.shipment, { __typename: 'Shipment', id: 'ship-1', number: 'S-1001', status: 'DISPATCHED', version: 3 })
  db.seed(TABLES.order, { __typename: 'Order', id: 'order-1', shipmentId: 'ship-1' })
  db.seed(TABLES.load, ...loads)
  db.seed(TABLES.loadCarrier, { __typename: 'LoadCarrier', id: 'lc-1', shipmentId: 'ship-1', loadId: 'load-1', status: 'ACTIVE' })
  const deps: ProjectorDeps = {
    store: { db: db as unknown as DynamoDBClient, tables: TABLES, now: () => NOW },
    checkCallTable: CHECK_CALL_TABLE,
    drivers: async () => buildDriverRoster([{ id: 'drv-7', email: 'Lee@bcatcorp.com' }]),
  }
  return { db, deps }
}

/** The stream record a stop stamp produces: same row, one stop time added. */
function stamp(before: Row, after: Row): StreamEvent {
  return {
    Records: [{
      eventName: 'MODIFY',
      dynamodb: {
        NewImage: marshall(after, { removeUndefinedValues: true }),
        OldImage: marshall(before, { removeUndefinedValues: true }),
      },
    }],
  }
}

const pickedUp = (over: Row = {}) => loadRow({
  stops: stops(
    { id: 'st-1', type: 'pickup', sequence: 0, city: 'JOLIET, IL', arrivedAt: '2026-10-28T09:00:00Z', departedAt: '2026-10-28T10:30:00Z' },
    { id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ' },
  ),
  updatedAt: '2026-10-28T11:00:00.000Z',
  ...over,
})

describe('newStopEvents', () => {
  it('reports a time that went blank to stamped, and ignores one that merely moved', () => {
    const before = [{ id: 'a', type: 'pickup', sequence: 0, arrivedAt: '2026-10-28T09:00:00Z' }]
    const after = [{ id: 'a', type: 'pickup', sequence: 0, arrivedAt: '2026-10-28T08:55:00Z', departedAt: '2026-10-28T10:00:00Z' }]
    expect(newStopEvents(after, before).map((e) => e.event)).toEqual(['DEPARTED'])
  })
})

describe('driverIdFor', () => {
  it('matches a driver by id, by `driver:<id>` and by e-mail, case-insensitively', () => {
    const roster = buildDriverRoster([{ id: 'drv-7', email: 'Lee@bcatcorp.com' }])
    expect(driverIdFor(roster, 'drv-7')).toBe('drv-7')
    expect(driverIdFor(roster, 'driver:drv-7')).toBe('drv-7')
    expect(driverIdFor(roster, 'lee@bcatcorp.com')).toBe('drv-7')
    expect(driverIdFor(roster, 'ryne@bcatcorp.com')).toBeNull()
  })
})

describe('projectLoadStream', () => {
  it('logs each newly stamped stop time once and moves the load up the ladder', async () => {
    const { db, deps } = setup()
    db.seed(TABLES.load, pickedUp())
    const summary = await projectLoadStream(stamp(loadRow(), pickedUp()), deps)

    expect(summary).toEqual({ records: 1, considered: 1, events: 2, skipped: 0, statusWrites: 1, conflicts: 0, mirrored: 0 })
    expect(db.get(CHECK_CALL_TABLE, 'evt:load-1:st-1:ARRIVED')).toMatchObject({
      loadId: 'load-1', shipmentId: 'ship-1', loadCarrierId: 'lc-1', stopId: 'st-1',
      type: 'ARRIVED', source: 'SYSTEM', at: '2026-10-28T09:00:00Z',
      city: 'JOLIET', state: 'IL', createdBy: 'driver-app', statusAfter: null,
    })
    expect(db.get(CHECK_CALL_TABLE, 'evt:load-1:st-1:DEPARTED')).toMatchObject({
      type: 'DEPARTED', statusBefore: 'DISPATCHED', statusAfter: 'IN_TRANSIT',
    })
    expect(db.get(TABLES.load, 'load-1')).toMatchObject({
      status: 'IN_TRANSIT', statusSource: 'SYSTEM', statusChangedAt: NOW, statusChangedBy: 'driver-app',
      lastCheckCallAt: '2026-10-28T10:30:00Z', lastCheckCallType: 'DEPARTED',
      lastKnownCity: 'JOLIET', lastKnownState: 'IL', lastKnownSource: 'SYSTEM',
      updatedAt: NOW, updatedBy: PROJECTOR_ACTOR,
    })
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ status: 'IN_TRANSIT' })
    // Only our own three tables, never anything else.
    expect([...new Set(db.writes.map((w) => w.table))].sort())
      .toEqual([CHECK_CALL_TABLE, TABLES.load, TABLES.shipment].sort())
  })

  it('credits the driver app when the stamp came from a driver', async () => {
    const { db, deps } = setup()
    const after = pickedUp({ updatedBy: 'Lee@bcatcorp.com' })
    db.seed(TABLES.load, after)
    await projectLoadStream(stamp(loadRow(), after), deps)

    expect(db.get(CHECK_CALL_TABLE, 'evt:load-1:st-1:ARRIVED')).toMatchObject({ source: 'DRIVER_APP', createdBy: 'driver:drv-7' })
    expect(db.get(TABLES.load, 'load-1')).toMatchObject({ statusSource: 'DRIVER_APP', statusChangedBy: 'driver:drv-7' })
  })

  it('ignores a legacy own-fleet load that belongs to no shipment', async () => {
    const { db, deps } = setup()
    const before = loadRow({ shipmentId: undefined, status: undefined })
    const after = pickedUp({ shipmentId: undefined, status: undefined })
    const summary = await projectLoadStream(stamp(before, after), deps)

    expect(summary).toEqual({ records: 1, considered: 0, events: 0, skipped: 0, statusWrites: 0, conflicts: 0, mirrored: 0 })
    expect(db.writes).toEqual([])
  })

  it('logs the stop event but writes no status when the ladder does not rise', async () => {
    const { db, deps } = setup()
    // Delivered already: a late pickup arrival proves nothing new.
    const before = loadRow({ status: 'DELIVERED' })
    const after = pickedUp({ status: 'DELIVERED' })
    db.seed(TABLES.load, after)
    const summary = await projectLoadStream(stamp(before, after), deps)

    expect(summary).toMatchObject({ events: 2, statusWrites: 0 })
    expect(db.writes.map((w) => w.table)).toEqual([CHECK_CALL_TABLE, CHECK_CALL_TABLE])
    expect(db.get(TABLES.load, 'load-1')).toMatchObject({ status: 'DELIVERED', updatedBy: 'driver-app' })
  })

  it('is a silent no-op on the stop event a staff action already logged', async () => {
    const { db, deps } = setup()
    db.seed(CHECK_CALL_TABLE, {
      id: 'evt:load-1:st-1:ARRIVED', loadId: 'load-1', source: 'MANUAL', createdBy: 'ryne@bcatcorp.com',
    })
    db.seed(TABLES.load, pickedUp())
    const summary = await projectLoadStream(stamp(loadRow(), pickedUp()), deps)

    expect(summary).toMatchObject({ events: 1, skipped: 1, statusWrites: 1 })
    expect(db.get(CHECK_CALL_TABLE, 'evt:load-1:st-1:ARRIVED')).toMatchObject({ source: 'MANUAL', createdBy: 'ryne@bcatcorp.com' })
  })

  it('leaves the status to the staff write that landed between the stamp and this record', async () => {
    const { db, deps } = setup()
    // The stored row has moved on; the stream image is stale.
    db.seed(TABLES.load, pickedUp({ updatedAt: '2026-10-28T11:30:00.000Z', status: 'IN_TRANSIT', updatedBy: 'ryne@bcatcorp.com' }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const summary = await projectLoadStream(stamp(loadRow(), pickedUp()), deps)
    expect(log).toHaveBeenCalledWith('[load-tracking-projector] load moved under us; skipping status', { loadId: 'load-1' })
    log.mockRestore()

    expect(summary).toMatchObject({ events: 2, statusWrites: 0, conflicts: 1 })
    expect(db.get(TABLES.load, 'load-1')).toMatchObject({ updatedAt: '2026-10-28T11:30:00.000Z', updatedBy: 'ryne@bcatcorp.com' })
    expect(db.writes.some((w) => w.table === TABLES.shipment)).toBe(false)
  })

  it('does not act on the record its own Load write produces', async () => {
    const { db, deps } = setup()
    db.seed(TABLES.load, pickedUp())
    await projectLoadStream(stamp(loadRow(), pickedUp()), deps)
    const own = db.get(TABLES.load, 'load-1')
    expect(own).toBeTruthy()
    db.writes.length = 0

    // The projector's own write: same stops, new status and lastKnown* columns.
    const summary = await projectLoadStream(stamp(pickedUp(), own as Row), deps)
    expect(summary).toEqual({ records: 1, considered: 0, events: 0, skipped: 0, statusWrites: 0, conflicts: 0, mirrored: 0 })
    expect(db.writes).toEqual([])
  })
})

describe('mirroring the driver app onto the shipment', () => {
  const withTrailer = (over: Row = {}) => loadRow({ trailerNumber: '5302', updatedBy: 'Lee@bcatcorp.com', ...over })
  const order = (db: FakeDynamo) => db.get(TABLES.order, 'order-1') as Row
  const refs = (db: FakeDynamo) => (order(db).references ?? []) as Array<{ code: string; value: string }>

  it('shows the trailer the driver picked as a reference on the shipment order, and in its search key', async () => {
    const { db, deps } = setup()
    db.seed(TABLES.load, withTrailer())
    const summary = await projectLoadStream(stamp(loadRow(), withTrailer()), deps)

    expect(summary).toMatchObject({ considered: 1, mirrored: 1, events: 0, statusWrites: 0 })
    expect(refs(db)).toEqual([expect.objectContaining({ code: 'TRAILER_NUMBER', value: '5302', level: 'ORDER', visibility: 'INTERNAL' })])
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ status: 'DISPATCHED', version: 4 })
    expect(String(db.get(TABLES.shipment, 'ship-1')?.searchKey)).toContain('5302')
    // No stop event, no status move: the check-call table and the Load stay untouched.
    expect(db.writes.map((w) => w.table).sort()).toEqual([TABLES.order, TABLES.shipment].sort())
  })

  it('mirrors the paperwork place whether the stream carries a map or a JSON string, but not a bare in-hand answer', async () => {
    for (const stored of [
      { kind: 'TRAILER', unit: '5302', at: NOW },
      JSON.stringify({ kind: 'TRAILER', unit: '5302', at: NOW }),
    ]) {
      const { db, deps } = setup()
      const after = loadRow({ paperworkLocation: stored })
      await projectLoadStream(stamp(loadRow(), after), deps)
      expect(refs(db)).toEqual([expect.objectContaining({ code: 'PAPERWORK_LOCATION', value: 'In trailer 5302' })])
    }

    const { db, deps } = setup()
    const after = loadRow({ paperworkLocation: { kind: 'UNKNOWN', unit: null, at: NOW, inHandAt: NOW } })
    const summary = await projectLoadStream(stamp(loadRow(), after), deps)
    expect(summary).toMatchObject({ considered: 0, mirrored: 0 })
    expect(db.writes).toEqual([])
  })

  it('is idempotent: replaying the same record, or one that changes nothing the order shows, writes nothing', async () => {
    const { db, deps } = setup()
    db.seed(TABLES.load, withTrailer())
    await projectLoadStream(stamp(loadRow(), withTrailer()), deps)
    db.writes.length = 0

    const replay = await projectLoadStream(stamp(loadRow(), withTrailer()), deps)
    expect(replay).toMatchObject({ considered: 1, mirrored: 0 })
    expect(db.writes).toEqual([])
  })

  it('replaces the trailer on a change and removes it when the driver clears it, leaving staff references alone', async () => {
    const { db, deps } = setup()
    db.seed(TABLES.order, {
      __typename: 'Order', id: 'order-1', shipmentId: 'ship-1',
      references: [{ code: 'PO', label: 'PO', value: 'PO-77', level: 'ORDER', visibility: 'ALL' }],
    })
    await projectLoadStream(stamp(loadRow(), withTrailer()), deps)
    await projectLoadStream(stamp(withTrailer(), withTrailer({ trailerNumber: '6001' })), deps)
    expect(refs(db).map((r) => `${r.code}=${r.value}`).sort()).toEqual(['PO=PO-77', 'TRAILER_NUMBER=6001'])

    await projectLoadStream(stamp(withTrailer({ trailerNumber: '6001' }), withTrailer({ trailerNumber: '' })), deps)
    expect(refs(db).map((r) => `${r.code}=${r.value}`)).toEqual(['PO=PO-77'])
  })

  it('ignores the link UpdateItem and any edit that changes neither stops, trailer nor paperwork place', async () => {
    const { db, deps } = setup()
    // C.2 step 4: the link writes shipmentId, orderId, loadNumber and leg onto a Load that had none.
    const bare = loadRow({ shipmentId: undefined, orderId: undefined, loadNumber: undefined, leg: undefined })
    const linked = await projectLoadStream(stamp(bare, loadRow()), deps)
    expect(linked).toEqual({ records: 1, considered: 0, events: 0, skipped: 0, statusWrites: 0, conflicts: 0, mirrored: 0 })

    // A rate edit, a staff note, a re-sort: still nothing for the shipment to learn.
    const edited = await projectLoadStream(stamp(loadRow(), loadRow({ sortOrder: 3, daySlot: 'AM', updatedBy: 'ryne@bcatcorp.com' })), deps)
    expect(edited.considered).toBe(0)
    // INSERT and REMOVE carry no change either.
    const insert = await projectLoadStream({ Records: [{ eventName: 'INSERT', dynamodb: { NewImage: marshall(withTrailer()) } }] }, deps)
    expect(insert.considered).toBe(0)
    expect(db.writes).toEqual([])
  })

  it('never writes a voided shipment or its order, but still logs the stop events and moves the load', async () => {
    const { db, deps } = setup()
    db.seed(TABLES.shipment, { __typename: 'Shipment', id: 'ship-1', number: 'S-1001', status: 'DISPATCHED', version: 3, voidedAt: '2026-10-27T00:00:00.000Z' })
    const after = pickedUp({ trailerNumber: '5302' })
    db.seed(TABLES.load, after)
    const summary = await projectLoadStream(stamp(loadRow(), after), deps)

    expect(summary).toMatchObject({ events: 2, statusWrites: 1, mirrored: 0 })
    expect(db.writes.some((w) => w.table === TABLES.shipment || w.table === TABLES.order)).toBe(false)
    expect(db.get(TABLES.load, 'load-1')).toMatchObject({ status: 'IN_TRANSIT' })
  })

  it('carries a driver delivery up to the shipment as DELIVERED with deliveredAt, once', async () => {
    const delivered = (over: Row = {}) => loadRow({
      status: 'OUT_FOR_DELIVERY',
      stops: stops(
        { id: 'st-1', type: 'pickup', sequence: 0, city: 'JOLIET, IL', arrivedAt: '2026-10-28T09:00:00Z', departedAt: '2026-10-28T10:30:00Z' },
        { id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ', arrivedAt: '2026-10-29T08:00:00Z', departedAt: '2026-10-29T09:15:00Z' },
      ),
      ...over,
    })
    const before = delivered({
      stops: stops(
        { id: 'st-1', type: 'pickup', sequence: 0, city: 'JOLIET, IL', arrivedAt: '2026-10-28T09:00:00Z', departedAt: '2026-10-28T10:30:00Z' },
        { id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ', arrivedAt: '2026-10-29T08:00:00Z' },
      ),
    })
    const { db, deps } = setup()
    db.seed(TABLES.shipment, { __typename: 'Shipment', id: 'ship-1', number: 'S-1001', status: 'OUT_FOR_DELIVERY', version: 3 })
    db.seed(TABLES.load, delivered())
    await projectLoadStream(stamp(before, delivered()), deps)

    expect(db.get(TABLES.load, 'load-1')).toMatchObject({ status: 'DELIVERED', deliveredAt: '2026-10-29T09:15:00Z' })
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ status: 'DELIVERED', deliveredAt: '2026-10-29T09:15:00Z' })
  })

  it('leaves a deliveredAt the shipment notifier stamped first', async () => {
    const delivered = loadRow({
      status: 'OUT_FOR_DELIVERY',
      stops: stops({ id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ', arrivedAt: '2026-10-29T08:00:00Z', departedAt: '2026-10-29T09:15:00Z' }),
    })
    const before = loadRow({
      status: 'OUT_FOR_DELIVERY',
      stops: stops({ id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ', arrivedAt: '2026-10-29T08:00:00Z' }),
    })
    const { db, deps } = setup()
    db.seed(TABLES.shipment, { __typename: 'Shipment', id: 'ship-1', number: 'S-1001', status: 'OUT_FOR_DELIVERY', version: 3, deliveredAt: '2026-10-29T09:20:00.000Z' })
    db.seed(TABLES.load, delivered)
    await projectLoadStream(stamp(before, delivered), deps)
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ status: 'DELIVERED', deliveredAt: '2026-10-29T09:20:00.000Z' })
  })
})

describe('driverRoster', () => {
  it('scans the roster once per container', async () => {
    const db = new FakeDynamo()
    db.seed(DRIVER_TABLE, { id: 'drv-7', email: 'lee@bcatcorp.com' })
    const client = db as unknown as DynamoDBClient
    expect(driverIdFor(await driverRoster(client, DRIVER_TABLE), 'lee@bcatcorp.com')).toBe('drv-7')
    expect(driverIdFor(await driverRoster(client, DRIVER_TABLE), 'drv-7')).toBe('drv-7')
    expect(db.scans).toBe(1)
  })
})
