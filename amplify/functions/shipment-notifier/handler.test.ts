import { describe, expect, it } from 'vitest'
import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { SESv2Client } from '@aws-sdk/client-sesv2'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

import { notifyLoadStream, NOTIFIER_ACTOR, type NotifierDeps, type StreamEvent } from './handler'
import type { Row } from '../_shared/shipmentStore'

/**
 * The notifier talks to DynamoDB and SES and nothing else, so the fakes are the
 * table set and the mailbox: every read is served from the tables, every write is
 * recorded, and every e-mail is kept — which is what lets a test say "this batch
 * sent exactly one thing" and "this row carries the text nobody received".
 */
const TABLES = {
  load: 'Load-test',
  shipment: 'Shipment-test',
  order: 'Order-test',
  loadCarrier: 'LoadCarrier-test',
  customer: 'Customer-test',
  settings: 'TmsSettings-test',
  division: 'Division-test',
  trackingLink: 'TrackingLink-test',
  shipmentNotice: 'ShipmentNotice-test',
  shipmentDocument: 'ShipmentDocument-test',
}
const NOW = '2026-10-28T12:00:00.000Z'

interface Write { op: 'put' | 'update'; table: string; id: string }

class FakeDynamo {
  readonly rows = new Map<string, Map<string, Row>>()
  readonly writes: Write[] = []
  /** Row ids whose GetItem explodes, so a batch can carry one bad record. */
  readonly explodeOn = new Set<string>()

  table(name: string): Map<string, Row> {
    let t = this.rows.get(name)
    if (!t) { t = new Map(); this.rows.set(name, t) }
    return t
  }

  seed(name: string, ...rows: Row[]): void {
    for (const row of rows) this.table(name).set(String(row.id ?? row.key), row)
  }

  get(name: string, id: string): Row | undefined {
    return this.table(name).get(id)
  }

  all(name: string): Row[] {
    return [...this.table(name).values()]
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const input = command.input
    const tableName = String(input.TableName ?? '')
    switch (command.constructor.name) {
      case 'GetItemCommand': {
        // Division's primary key is `key`, every other model's is `id`.
        const key = unmarshall(input.Key as Record<string, never>)
        const id = String(key.id ?? key.key)
        if (this.explodeOn.has(id)) throw new Error('ProvisionedThroughputExceededException')
        const row = this.get(tableName, id)
        return { Item: row ? marshall(row, { removeUndefinedValues: true }) : undefined }
      }
      case 'QueryCommand': {
        const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
        const key = names['#k'] ?? 'shipmentId'
        const items = this.all(tableName).filter((r) => r[key] === values[':v'])
        return { Items: items.map((r) => marshall(r, { removeUndefinedValues: true })) }
      }
      case 'PutItemCommand': {
        const item = unmarshall(input.Item as Record<string, never>)
        const id = String(item.id)
        if (String(input.ConditionExpression ?? '').includes('attribute_not_exists(id)') && this.table(tableName).has(id)) {
          throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} })
        }
        this.table(tableName).set(id, item)
        this.writes.push({ op: 'put', table: tableName, id })
        return {}
      }
      case 'UpdateItemCommand': {
        const id = String(unmarshall(input.Key as Record<string, never>).id)
        const row = this.get(tableName, id) ?? { id }
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
        const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
        const absent = /attribute_not_exists\((\w+)\)/.exec(String(input.ConditionExpression ?? ''))
        if (absent && row[absent[1]] !== undefined && row[absent[1]] !== null) {
          throw new ConditionalCheckFailedException({ message: 'already set', $metadata: {} })
        }
        for (const [, nameRef, valueRef] of String(input.UpdateExpression ?? '').matchAll(/(#?\w+) = (:\w+)/g)) {
          row[names[nameRef] ?? nameRef.replace(/^#/, '')] = values[valueRef]
        }
        this.table(tableName).set(id, row)
        this.writes.push({ op: 'update', table: tableName, id })
        return {}
      }
      default:
        throw new Error(`FakeDynamo: unexpected ${command.constructor.name}`)
    }
  }
}

class FakeSes {
  readonly sent: string[] = []
  constructor(private readonly fail: string | null = null) {}

  async send(command: { input: Record<string, unknown> }): Promise<unknown> {
    if (this.fail) throw new Error(this.fail)
    const content = command.input.Content as { Raw: { Data: Uint8Array } }
    this.sent.push(Buffer.from(content.Raw.Data).toString('utf8'))
    return { MessageId: `ses-${this.sent.length}` }
  }
}

type Stop = { id: string; type: 'pickup' | 'delivery'; sequence: number; city?: string; appt?: string }

const stops = (...list: Stop[]) => JSON.stringify(list)

const loadRow = (over: Row = {}): Row => ({
  __typename: 'Load',
  id: 'load-1',
  shipmentId: 'ship-1',
  orderId: 'order-1',
  loadNumber: 'S-1001-1',
  leg: 1,
  status: 'DISPATCHED',
  divisionKey: 'BCAT',
  activeLoadCarrierId: 'lc-1',
  updatedAt: '2026-10-28T11:00:00.000Z',
  stops: stops(
    { id: 'st-1', type: 'pickup', sequence: 0, city: 'JOLIET, IL', appt: '2026-10-26 08:00' },
    { id: 'st-2', type: 'delivery', sequence: 1, city: 'MESA, AZ', appt: '2026-10-28 09:00' },
  ),
  ...over,
})

const carrierRow = (over: Row = {}): Row => ({
  __typename: 'LoadCarrier',
  id: 'lc-1',
  loadId: 'load-1',
  shipmentId: 'ship-1',
  kind: 'CARRIER',
  status: 'ACTIVE',
  carrierName: 'Roadrunner Express',
  dispatcherName: 'Pat Mills',
  dispatcherEmail: 'dispatch@roadrunner.test',
  ...over,
})

function setup(options: { sesFailure?: string } = {}): { db: FakeDynamo; ses: FakeSes; deps: NotifierDeps } {
  const db = new FakeDynamo()
  const ses = new FakeSes(options.sesFailure ?? null)
  db.seed(TABLES.shipment, {
    __typename: 'Shipment', id: 'ship-1', number: 'S-1001', status: 'DISPATCHED',
    customerId: 'cus-1', customerName: 'Acme Foods', version: 3,
  })
  db.seed(TABLES.customer, {
    __typename: 'Customer', id: 'cus-1', name: 'Acme Foods',
    visibilityPrefs: { milestoneEmails: true, sharedTrackingLink: true, shipperPortal: false },
    contacts: [
      { id: 'ct-1', name: 'Dana Reed', email: 'dana@acme.test', types: ['OPERATIONS'], notifications: ['IN_TRANSIT', 'DELIVERED'], active: true },
      { id: 'ct-2', name: 'Gone Guy', email: 'gone@acme.test', types: ['OPERATIONS'], notifications: ['IN_TRANSIT'], active: false },
    ],
  })
  db.seed(TABLES.order, {
    __typename: 'Order', id: 'order-1', shipmentId: 'ship-1', customerId: 'cus-1',
    references: [
      { code: 'PO', label: 'PO number', value: '44-118', level: 'ORDER', visibility: 'CUSTOMER' },
      { code: 'MARGIN', label: 'Margin note', value: 'never leaves', level: 'ORDER', visibility: 'INTERNAL' },
    ],
  })
  db.seed(TABLES.division, { __typename: 'Division', key: 'BCAT', name: 'BCAT Logistics Inc' })
  db.seed(TABLES.load, loadRow())
  db.seed(TABLES.loadCarrier, carrierRow())
  const deps: NotifierDeps = {
    db: db as unknown as DynamoDBClient,
    ses: ses as unknown as SESv2Client,
    tables: TABLES,
    now: () => NOW,
    portalOrigin: 'https://portal.test',
    from: 'ai4bcat@gmail.com',
  }
  return { db, ses, deps }
}

/** The stream record a status change produces: same row, `status` moved. */
function moved(before: Row, after: Row): StreamEvent {
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

describe('notifyLoadStream', () => {
  it('writes one milestone notice per shipment and milestone, however often the record arrives', async () => {
    const { db, ses, deps } = setup()
    db.seed(TABLES.trackingLink, {
      __typename: 'TrackingLink', id: 'tok-customer', kind: 'CUSTOMER_VIEW', shipmentId: 'ship-1',
      status: 'ACTIVE', showCarrier: false, expiresAt: '2026-11-28T00:00:00.000Z',
    })
    const event = moved(loadRow(), loadRow({ status: 'IN_TRANSIT' }))

    const first = await notifyLoadStream(event, deps)
    expect(first).toMatchObject({ records: 1, considered: 1, milestones: 1, sent: 1, failures: 0 })

    const notice = db.get(TABLES.shipmentNotice, 'ms:ship-1:IN_TRANSIT')
    expect(notice).toMatchObject({
      shipmentId: 'ship-1', loadId: 'load-1', kind: 'MILESTONE', milestone: 'IN_TRANSIT',
      channel: 'EMAIL', to: 'dana@acme.test', status: 'SENT', trackingLinkId: 'tok-customer',
      createdBy: NOTIFIER_ACTOR,
    })
    // Customer-facing: the link, the customer reference, the broker — no margin note,
    // and no carrier, because the customer's page does not name one.
    expect(String(notice?.body)).toContain('https://portal.test/track/s/tok-customer')
    expect(String(notice?.body)).toContain('PO number: 44-118')
    expect(String(notice?.body)).toContain('BCAT Logistics Inc')
    expect(String(notice?.body)).not.toContain('never leaves')
    expect(String(notice?.body)).not.toContain('Roadrunner')
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ lastNoticeAt: NOW, lastNoticeStatus: 'SENT' })

    // The stream redelivers the same record; the conditional Put is what makes the
    // customer hear about this milestone exactly once.
    const second = await notifyLoadStream(event, deps)
    expect(second).toMatchObject({ considered: 1, milestones: 0, sent: 0 })
    expect(ses.sent).toHaveLength(1)
    expect(db.all(TABLES.shipmentNotice)).toHaveLength(1)
  })

  it('holds the customer milestone and the delivery stamp until the last leg has delivered', async () => {
    const { db, ses, deps } = setup()
    const legTwo = loadRow({ id: 'load-2', leg: 2, loadNumber: 'S-1001-2', status: 'IN_TRANSIT', activeLoadCarrierId: null })
    db.seed(TABLES.load, legTwo)

    const early = await notifyLoadStream(
      moved(loadRow({ status: 'OUT_FOR_DELIVERY' }), loadRow({ status: 'DELIVERED', deliveredAt: '2026-10-28T09:40:00.000Z' })),
      deps,
    )
    // Leg one's own carrier is asked for its own paperwork straight away; the
    // customer hears nothing, because the shipment has not landed yet.
    expect(early).toMatchObject({ considered: 1, milestones: 0, podRequests: 1, deliveries: 0 })
    expect(db.get(TABLES.shipmentNotice, 'ms:ship-1:DELIVERED')).toBeUndefined()
    expect(db.get(TABLES.shipment, 'ship-1')?.deliveredAt).toBeUndefined()

    // The first leg is in now; the second one landing completes the shipment.
    db.seed(TABLES.load, loadRow({ status: 'DELIVERED', deliveredAt: '2026-10-28T09:40:00.000Z' }))
    const last = await notifyLoadStream(
      moved(legTwo, { ...legTwo, status: 'DELIVERED', deliveredAt: '2026-10-28T11:20:00.000Z' }),
      deps,
    )
    // Leg two carries no outside assignment, so the last leg is a milestone only.
    expect(last).toMatchObject({ considered: 1, milestones: 1, podRequests: 0, deliveries: 1, sent: 1 })
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ deliveredAt: '2026-10-28T11:20:00.000Z' })
    expect(db.get(TABLES.shipmentNotice, 'ms:ship-1:DELIVERED')).toMatchObject({ status: 'SENT' })
    expect(ses.sent).toHaveLength(2)
  })

  it('asks each leg\u2019s carrier for paperwork when that leg delivers, not when the shipment does', async () => {
    const { db, ses, deps } = setup()
    const legTwo = loadRow({ id: 'load-2', leg: 2, loadNumber: 'S-1001-2', status: 'IN_TRANSIT', activeLoadCarrierId: 'lc-2' })
    db.seed(TABLES.load, legTwo)
    db.seed(TABLES.loadCarrier, carrierRow({
      id: 'lc-2', loadId: 'load-2', carrierName: 'Desert Haul', dispatcherName: 'Sam Ortiz',
      dispatcherEmail: 'dispatch@deserthaul.test',
    }))
    const legOneDelivered = loadRow({ status: 'DELIVERED', deliveredAt: '2026-10-28T09:40:00.000Z' })

    // ── Leg one lands. Its carrier is the only one with anything to answer for.
    const first = await notifyLoadStream(moved(loadRow({ status: 'OUT_FOR_DELIVERY' }), legOneDelivered), deps)
    expect(first).toMatchObject({ considered: 1, milestones: 0, podRequests: 1, deliveries: 0, sent: 1 })
    expect(db.get(TABLES.shipmentNotice, 'pod:lc-1')).toMatchObject({
      kind: 'POD_REQUEST', loadId: 'load-1', loadCarrierId: 'lc-1',
      to: 'dispatch@roadrunner.test', status: 'SENT',
    })
    expect(db.get(TABLES.loadCarrier, 'lc-1')).toMatchObject({ podRequestedAt: NOW })
    expect(db.get(TABLES.shipmentNotice, 'pod:lc-2')).toBeUndefined()
    // Nothing customer-facing: the shipment has not delivered, only a leg of it.
    expect(db.get(TABLES.shipmentNotice, 'ms:ship-1:DELIVERED')).toBeUndefined()
    expect(db.get(TABLES.shipment, 'ship-1')?.deliveredAt).toBeUndefined()
    // Leg one's link is measured from leg one's delivery, 30 days by default.
    const legOneLink = db.all(TABLES.trackingLink).find((row) => row.loadCarrierId === 'lc-1')
    expect(legOneLink).toMatchObject({ loadId: 'load-1', expiresAt: '2026-11-27T09:40:00.000Z' })

    // ── Leg two lands: its own carrier, and now the customer too.
    db.seed(TABLES.load, legOneDelivered)
    const legTwoDelivered = { ...legTwo, status: 'DELIVERED', deliveredAt: '2026-10-28T11:20:00.000Z' }
    const second = await notifyLoadStream(moved(legTwo, legTwoDelivered), deps)
    expect(second).toMatchObject({ considered: 1, milestones: 1, podRequests: 1, deliveries: 1, sent: 2 })
    expect(db.get(TABLES.shipmentNotice, 'pod:lc-2')).toMatchObject({
      loadId: 'load-2', loadCarrierId: 'lc-2', to: 'dispatch@deserthaul.test', status: 'SENT',
    })
    expect(db.get(TABLES.loadCarrier, 'lc-2')).toMatchObject({ podRequestedAt: NOW })
    expect(db.get(TABLES.shipmentNotice, 'ms:ship-1:DELIVERED')).toMatchObject({ status: 'SENT' })
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ deliveredAt: '2026-10-28T11:20:00.000Z' })
    const legTwoLink = db.all(TABLES.trackingLink).find((row) => row.loadCarrierId === 'lc-2')
    expect(legTwoLink).toMatchObject({ loadId: 'load-2', expiresAt: '2026-11-27T11:20:00.000Z' })
    expect(ses.sent).toHaveLength(3)

    // ── The stream redelivers leg one. The `pod:<loadCarrierId>` claim it already
    // holds is what keeps a carrier from being asked twice for the same paperwork.
    db.seed(TABLES.load, legTwoDelivered)
    const replay = await notifyLoadStream(moved(loadRow({ status: 'OUT_FOR_DELIVERY' }), legOneDelivered), deps)
    expect(replay).toMatchObject({ considered: 1, milestones: 0, podRequests: 0, deliveries: 0, sent: 0 })
    expect(ses.sent).toHaveLength(3)
    expect(db.all(TABLES.shipmentNotice)).toHaveLength(3)
  })

  it('asks the outside carrier for paperwork, through an upload link the assignment keeps', async () => {
    const { db, deps } = setup()
    const summary = await notifyLoadStream(
      moved(loadRow({ status: 'OUT_FOR_DELIVERY' }), loadRow({ status: 'DELIVERED', deliveredAt: '2026-10-28T09:40:00.000Z' })),
      deps,
    )
    expect(summary).toMatchObject({ milestones: 1, podRequests: 1, deliveries: 1 })

    const link = db.all(TABLES.trackingLink)[0]
    expect(link).toMatchObject({
      kind: 'CARRIER_UPLOAD', status: 'ACTIVE', shipmentId: 'ship-1', loadId: 'load-1',
      loadCarrierId: 'lc-1', uploadCount: 0, neededTypes: ['POD', 'CARRIER_INVOICE'],
      sentTo: 'dispatch@roadrunner.test', sentAt: NOW,
      createdBy: NOTIFIER_ACTOR,
    })
    // 24 random bytes, base64url: the row id IS the token.
    expect(String(link.id)).toHaveLength(32)
    expect(db.get(TABLES.loadCarrier, 'lc-1')).toMatchObject({ uploadLinkId: link.id, podRequestedAt: NOW })

    const notice = db.get(TABLES.shipmentNotice, 'pod:lc-1')
    expect(notice).toMatchObject({ kind: 'POD_REQUEST', loadCarrierId: 'lc-1', to: 'dispatch@roadrunner.test', status: 'SENT' })
    expect(String(notice?.body)).toContain(`https://portal.test/track/u/${link.id}`)
    expect(String(notice?.body)).toContain('Proof of delivery')
  })

  it('never asks our own drivers for a POD; the driver app is where theirs comes from', async () => {
    const { db, deps } = setup()
    db.seed(TABLES.loadCarrier, carrierRow({ kind: 'OWN_ASSET', dispatcherEmail: 'dispatch@bcatcorp.com' }))

    const summary = await notifyLoadStream(
      moved(loadRow({ status: 'OUT_FOR_DELIVERY' }), loadRow({ status: 'DELIVERED' })),
      deps,
    )
    expect(summary).toMatchObject({ milestones: 1, podRequests: 0 })
    expect(db.get(TABLES.shipmentNotice, 'pod:lc-1')).toBeUndefined()
    expect(db.all(TABLES.trackingLink)).toEqual([])
    expect(db.get(TABLES.loadCarrier, 'lc-1')?.uploadLinkId).toBeUndefined()
  })

  it('keeps the rendered text on a NOT_SENT row when SES refuses, and carries on', async () => {
    const { db, deps } = setup({ sesFailure: 'AccessDenied: not authorized to SendEmail' })
    const summary = await notifyLoadStream(moved(loadRow(), loadRow({ status: 'IN_TRANSIT' })), deps)

    expect(summary).toMatchObject({ considered: 1, milestones: 1, sent: 0, failures: 0 })
    const notice = db.get(TABLES.shipmentNotice, 'ms:ship-1:IN_TRANSIT')
    expect(notice).toMatchObject({ status: 'NOT_SENT', messageId: null, sentAt: null })
    expect(String(notice?.error)).toContain('AccessDenied')
    expect(String(notice?.subject)).toBe('S-1001 — In transit')
    expect(String(notice?.body)).toContain('BCAT Logistics Inc')
    expect(db.get(TABLES.shipment, 'ship-1')).toMatchObject({ lastNoticeStatus: 'NOT_SENT' })
  })

  it('ignores a legacy load that belongs to no shipment', async () => {
    const { db, ses, deps } = setup()
    const before = loadRow({ id: 'legacy-1', shipmentId: undefined, status: 'DISPATCHED' })
    const summary = await notifyLoadStream(moved(before, { ...before, status: 'DELIVERED' }), deps)

    expect(summary).toMatchObject({ records: 1, considered: 0, milestones: 0, podRequests: 0 })
    expect(db.writes).toEqual([])
    expect(ses.sent).toEqual([])
  })

  it('ignores an edit that left the status where it was, and a status nobody is told about', async () => {
    const { db, deps } = setup()
    const quiet = await notifyLoadStream(moved(loadRow(), loadRow({ updatedAt: NOW })), deps)
    expect(quiet).toMatchObject({ considered: 0 })

    const internal = await notifyLoadStream(moved(loadRow({ status: 'PLANNED' }), loadRow({ status: 'DISPATCHED' })), deps)
    expect(internal).toMatchObject({ considered: 0 })
    expect(db.writes).toEqual([])
  })

  it('finishes the batch when one record cannot be read', async () => {
    const { db, ses, deps } = setup()
    db.explodeOn.add('ship-bad')
    const doomed = loadRow({ id: 'load-9', shipmentId: 'ship-bad' })
    const event: StreamEvent = {
      Records: [
        ...(moved(doomed, { ...doomed, status: 'IN_TRANSIT' }).Records ?? []),
        ...(moved(loadRow(), loadRow({ status: 'IN_TRANSIT' })).Records ?? []),
      ],
    }

    const summary = await notifyLoadStream(event, deps)
    expect(summary).toMatchObject({ records: 2, considered: 1, milestones: 1, sent: 1, failures: 1 })
    expect(ses.sent).toHaveLength(1)
  })
})
