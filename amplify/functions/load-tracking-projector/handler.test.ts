import { describe, expect, it } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
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

/**
 * The projector talks to DynamoDB and nothing else, so the fake is the table set:
 * every read the shipment store does is served from it and every write is recorded,
 * which is what lets a test say "this record wrote nothing at all".
 */
const TABLES = {
  shipment: 'Shipment-test',
  order: 'Order-test',
  load: 'Load-test',
  loadCarrier: 'LoadCarrier-test',
  loadFinancials: 'LoadFinancials-test',
  loadCharge: 'LoadCharge-test',
}
const CHECK_CALL_TABLE = 'LoadCheckCall-test'
const DRIVER_TABLE = 'Driver-test'
const NOW = '2026-10-28T12:00:00.000Z'

interface Write { op: 'put' | 'update'; table: string; id: string }

function conditionFailed(): Error {
  const err = new Error('ConditionalCheckFailedException: the conditional request failed')
  err.name = 'ConditionalCheckFailedException'
  return err
}

class FakeDynamo {
  readonly rows = new Map<string, Map<string, Row>>()
  readonly writes: Write[] = []
  scans = 0

  table(name: string): Map<string, Row> {
    let t = this.rows.get(name)
    if (!t) { t = new Map(); this.rows.set(name, t) }
    return t
  }

  seed(name: string, ...rows: Row[]): void {
    for (const row of rows) this.table(name).set(String(row.id), row)
  }

  get(name: string, id: string): Row | undefined {
    return this.table(name).get(id)
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const input = command.input
    const name = command.constructor.name
    const tableName = String(input.TableName ?? '')
    switch (name) {
      case 'GetItemCommand': {
        const key = unmarshall(input.Key as Record<string, never>)
        const row = this.get(tableName, String(key.id))
        return { Item: row ? marshall(row, { removeUndefinedValues: true }) : undefined }
      }
      case 'QueryCommand': {
        const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
        const key = names['#k'] ?? 'shipmentId'
        const items = [...this.table(tableName).values()].filter((r) => r[key] === values[':v'])
        return { Items: items.map((r) => marshall(r, { removeUndefinedValues: true })) }
      }
      case 'BatchGetItemCommand': {
        const requested = input.RequestItems as Record<string, { Keys: Record<string, never>[] }>
        const Responses: Record<string, unknown[]> = {}
        for (const [table, spec] of Object.entries(requested)) {
          Responses[table] = spec.Keys
            .map((k) => this.get(table, String(unmarshall(k).id)))
            .filter((r): r is Row => !!r)
            .map((r) => marshall(r, { removeUndefinedValues: true }))
        }
        return { Responses }
      }
      case 'ScanCommand': {
        this.scans += 1
        return { Items: [...this.table(tableName).values()].map((r) => marshall(r, { removeUndefinedValues: true })) }
      }
      case 'PutItemCommand': {
        const item = unmarshall(input.Item as Record<string, never>)
        const id = String(item.id)
        if (String(input.ConditionExpression ?? '').includes('attribute_not_exists(id)') && this.table(tableName).has(id)) {
          throw conditionFailed()
        }
        this.table(tableName).set(id, item)
        this.writes.push({ op: 'put', table: tableName, id })
        return {}
      }
      case 'UpdateItemCommand':
        this.applyUpdate(input)
        return {}
      case 'TransactWriteItemsCommand': {
        for (const entry of (input.TransactItems ?? []) as Array<{ Update?: Record<string, unknown> }>) {
          if (entry.Update) this.applyUpdate(entry.Update)
        }
        return {}
      }
      default:
        throw new Error(`FakeDynamo: unexpected ${name}`)
    }
  }

  /** Only the `SET #k = :k` shape the projector and the shipment store build. */
  private applyUpdate(input: Record<string, unknown>): void {
    const tableName = String(input.TableName ?? '')
    const id = String(unmarshall(input.Key as Record<string, never>).id)
    const row = this.get(tableName, id) ?? { id }
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
    const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
    const condition = String(input.ConditionExpression ?? '')
    if (condition.includes(':expectedUpdatedAt') && row.updatedAt !== values[':expectedUpdatedAt']) {
      throw conditionFailed()
    }
    if (condition.includes('attribute_not_exists(updatedAt)') && row.updatedAt !== undefined) {
      throw conditionFailed()
    }
    for (const [, nameRef, valueRef] of String(input.UpdateExpression ?? '').matchAll(/(#\w+) = (:\w+)/g)) {
      row[names[nameRef] ?? nameRef.slice(1)] = values[valueRef]
    }
    this.table(tableName).set(id, row)
    this.writes.push({ op: 'update', table: tableName, id })
  }
}

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

    expect(summary).toEqual({ records: 1, considered: 1, events: 2, skipped: 0, statusWrites: 1, conflicts: 0 })
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

    expect(summary).toEqual({ records: 1, considered: 0, events: 0, skipped: 0, statusWrites: 0, conflicts: 0 })
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
    const summary = await projectLoadStream(stamp(loadRow(), pickedUp()), deps)

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
    expect(summary).toEqual({ records: 1, considered: 0, events: 0, skipped: 0, statusWrites: 0, conflicts: 0 })
    expect(db.writes).toEqual([])
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
