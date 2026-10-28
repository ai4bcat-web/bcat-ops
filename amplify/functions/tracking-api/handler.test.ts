// The handler reads its table names from process.env at module scope, so the import
// has to happen after beforeAll sets them — a genuine module-loading boundary.
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type * as HandlerModule from './handler'

const mockSend = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(function () {}),
}))

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  GetCommand: vi.fn(function (params: unknown) { return { __cmd: 'Get', ...(params as object) } }),
  PutCommand: vi.fn(function (params: unknown) { return { __cmd: 'Put', ...(params as object) } }),
  QueryCommand: vi.fn(function (params: unknown) { return { __cmd: 'Query', ...(params as object) } }),
  ScanCommand: vi.fn(function (params: unknown) { return { __cmd: 'Scan', ...(params as object) } }),
  UpdateCommand: vi.fn(function (params: unknown) { return { __cmd: 'Update', ...(params as object) } }),
}))

let handler: typeof HandlerModule.handler

const TOKEN = 'Hq3Zn7Lp0vWx9TbKcRdYu1Ms4Ae6Gi2J'   // 32 base64url chars
const BAD_TOKEN = 'too-short'

const TABLES = {
  link: 'test-TrackingLink',
  checkCall: 'test-LoadCheckCall',
  shipment: 'test-Shipment',
  order: 'test-Order',
  load: 'test-Load',
  loadCarrier: 'test-LoadCarrier',
  division: 'test-Division',
  settings: 'test-TmsSettings',
  history: 'test-TruckLocationHistory',
  equipment: 'test-Equipment',
  truckLocation: 'test-TruckLocation',
  driver: 'test-Driver',
}

beforeAll(async () => {
  process.env.EQUIPMENT_TABLE_NAME = TABLES.equipment
  process.env.TRUCK_LOCATION_TABLE_NAME = TABLES.truckLocation
  process.env.DRIVER_TABLE_NAME = TABLES.driver
  process.env.LOAD_TABLE_NAME = TABLES.load
  process.env.TRACKING_LINK_TABLE_NAME = TABLES.link
  process.env.LOAD_CHECK_CALL_TABLE_NAME = TABLES.checkCall
  process.env.SHIPMENT_TABLE_NAME = TABLES.shipment
  process.env.ORDER_TABLE_NAME = TABLES.order
  process.env.LOAD_CARRIER_TABLE_NAME = TABLES.loadCarrier
  process.env.DIVISION_TABLE_NAME = TABLES.division
  process.env.TMS_SETTINGS_TABLE_NAME = TABLES.settings
  process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME = TABLES.history
  handler = (await import('./handler')).handler
})

class ConditionalCheckFailedException extends Error {
  name = 'ConditionalCheckFailedException'
}

/** Every command the handler builds, flattened by the lib-dynamodb mock above. */
interface Cmd {
  __cmd: string
  TableName: string
  IndexName?: string
  Item?: Record<string, unknown>
  Key?: Record<string, unknown>
  UpdateExpression?: string
  ConditionExpression?: string
  ExpressionAttributeValues?: Record<string, unknown>
}

const sent = () => mockSend.mock.calls.map(([c]) => c as Cmd)
const writes = () => sent().filter((c) => c.__cmd === 'Put' || c.__cmd === 'Update')

const customerLink = (over: Record<string, unknown> = {}) => ({
  id: TOKEN,
  kind: 'CUSTOMER_VIEW',
  status: 'ACTIVE',
  shipmentId: 'shp-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  showCarrier: false,
  showPosition: true,
  createdBy: 'rep@bcat.com',
  ...over,
})

const carrierLink = (over: Record<string, unknown> = {}) => ({
  id: TOKEN,
  kind: 'CARRIER_PING',
  status: 'ACTIVE',
  shipmentId: 'shp-1',
  loadId: 'ld-1',
  loadCarrierId: 'lc-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdBy: 'rep@bcat.com',
  ...over,
})

const SHIPMENT = { id: 'shp-1', number: 'S-1001', status: 'IN_TRANSIT', customerId: 'cus-1', mode: 'TL', source: 'MANUAL', createdBy: 'x', updatedBy: 'x', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
const LOAD = {
  id: 'ld-1',
  shipmentId: 'shp-1',
  loadNumber: 'S-1001-1',
  status: 'IN_TRANSIT',
  leg: 1,
  divisionKey: 'BCAT_LOGISTICS',
  stops: JSON.stringify([
    { id: 'st-1', type: 'pickup', sequence: 1, name: 'Shipper', address: { city: 'Joliet', state: 'IL' }, appt: '2026-10-20T14:00:00.000Z', arrivedAt: '2026-10-20T13:50:00.000Z', departedAt: '2026-10-20T15:10:00.000Z' },
    { id: 'st-2', type: 'delivery', sequence: 2, name: 'Consignee', address: { city: 'Dallas', state: 'TX' }, appt: '2026-10-22T09:00:00.000Z' },
  ]),
}

/** Answers each DynamoDB call by table, so the handler's own order never matters. */
function route(by: {
  link?: unknown
  shipment?: unknown
  load?: unknown
  orders?: unknown[]
  loads?: unknown[]
  carriers?: unknown[]
  checkCalls?: unknown[]
  positions?: unknown[]
  division?: unknown
  settings?: unknown
  onUpdate?: (cmd: Cmd) => void
}) {
  mockSend.mockImplementation(async (cmd: Cmd) => {
    if (cmd.__cmd === 'Update') { by.onUpdate?.(cmd); return {} }
    if (cmd.__cmd === 'Put') return {}
    if (cmd.__cmd === 'Get') {
      if (cmd.TableName === TABLES.link) return { Item: by.link ?? undefined }
      if (cmd.TableName === TABLES.shipment) return { Item: by.shipment ?? undefined }
      if (cmd.TableName === TABLES.load) return { Item: by.load ?? undefined }
      if (cmd.TableName === TABLES.division) return { Item: by.division ?? undefined }
      if (cmd.TableName === TABLES.settings) return { Item: by.settings ?? undefined }
      return { Item: undefined }
    }
    if (cmd.__cmd === 'Query') {
      if (cmd.TableName === TABLES.order) return { Items: by.orders ?? [] }
      if (cmd.TableName === TABLES.load) return { Items: by.loads ?? [] }
      if (cmd.TableName === TABLES.loadCarrier) return { Items: by.carriers ?? [] }
      if (cmd.TableName === TABLES.checkCall) return { Items: by.checkCalls ?? [] }
      if (cmd.TableName === TABLES.history) return { Items: by.positions ?? [] }
      return { Items: [] }
    }
    return { Items: [] }
  })
}

const get = (path: string) => handler({ rawPath: path, requestContext: { http: { method: 'GET' } } })
const post = (path: string, body: unknown) =>
  handler({ rawPath: path, body: JSON.stringify(body), requestContext: { http: { method: 'POST' } } })
const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  mockSend.mockReset()
})

describe('tracking-api routing', () => {
  it('still answers the truck link, and OPTIONS, exactly as before', async () => {
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__cmd === 'Scan' && cmd.TableName === TABLES.equipment) {
        return { Items: [{ id: 'eq-1', unitNumber: '104', active: true }] }
      }
      if (cmd.__cmd === 'Scan') return { Items: [] }
      return { Item: { lat: 41.5, lon: -88.1, description: 'Joliet, IL', locatedAt: '2026-10-21T12:00:00.000Z' } }
    })
    const res = await get('/t/abc123')
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ unit: '104', position: { lat: 41.5, lon: -88.1 } })

    const opts = await handler({ rawPath: '/s/anything', requestContext: { http: { method: 'OPTIONS' } } })
    expect(opts.statusCode).toBe(200)
  })

  it('404s an unknown path and refuses a DELETE', async () => {
    expect((await get('/nope')).statusCode).toBe(404)
    const res = await handler({ rawPath: `/l/${TOKEN}/ping`, requestContext: { http: { method: 'DELETE' } } })
    expect(res.statusCode).toBe(405)
  })

  it('never reads the link table for a malformed token', async () => {
    route({})
    const res = await get(`/s/${BAD_TOKEN}`)
    expect(res.statusCode).toBe(404)
    expect(json(res).error).toBe('This tracking link is no longer active')
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('GET /s/<token>', () => {
  it('renders the customer view and counts the open', async () => {
    const updates: Cmd[] = []
    route({
      link: customerLink(),
      shipment: SHIPMENT,
      loads: [LOAD],
      orders: [{ id: 'ord-1', shipmentId: 'shp-1', references: JSON.stringify([{ code: 'PO', value: '99-12', visibility: 'CUSTOMER' }]) }],
      carriers: [{ id: 'lc-1', loadId: 'ld-1', shipmentId: 'shp-1', status: 'ACTIVE', carrierName: 'Blue Sky Trucking', deliveryEtaAt: '2026-10-22T08:30:00.000Z' }],
      checkCalls: [{ id: 'cc-1', loadId: 'ld-1', shipmentId: 'shp-1', at: '2026-10-21T12:00:00.000Z', type: 'LOCATION_UPDATE', source: 'MANUAL', lat: 38.4, lng: -92.1, city: 'Columbia', state: 'MO', createdBy: 'rep@bcat.com' }],
      division: { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', active: true },
      onUpdate: (cmd) => updates.push(cmd),
    })

    const res = await get(`/s/${TOKEN}`)
    expect(res.statusCode).toBe(200)
    const view = json(res)
    expect(view).toMatchObject({ number: 'S-1001', statusLabel: 'In transit', broker: { name: 'BCAT Logistics' } })
    expect((view.stops as unknown[]).length).toBe(2)
    expect(view.position).toMatchObject({ lat: 38.4, lng: -92.1 })
    // showCarrier is false on this link, so the carrier is absent from the shape.
    expect(view.carrier).toBeUndefined()

    expect(updates[0].UpdateExpression).toContain('ADD requestCount :one, openCount :one')
    expect(updates[0].ConditionExpression).toContain('requestCount < :max')
  })

  it('404s a revoked link, an expired one, and the wrong kind, all with one wording', async () => {
    for (const link of [
      customerLink({ status: 'REVOKED' }),
      customerLink({ expiresAt: '2020-01-01T00:00:00.000Z' }),
      carrierLink(),
      undefined,
    ]) {
      route({ link })
      const res = await get(`/s/${TOKEN}`)
      expect(res.statusCode).toBe(404)
      expect(json(res).error).toBe('This tracking link is no longer active')
    }
  })

  it('marks an expired link EXPIRED instead of counting the open', async () => {
    const updates: Cmd[] = []
    route({ link: customerLink({ expiresAt: '2020-01-01T00:00:00.000Z' }), onUpdate: (c) => updates.push(c) })
    await get(`/s/${TOKEN}`)
    expect(updates).toHaveLength(1)
    expect(updates[0].ExpressionAttributeValues?.[':expired']).toBe('EXPIRED')
  })

  it('429s once the link is past its request budget', async () => {
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__cmd === 'Get' && cmd.TableName === TABLES.link) return { Item: customerLink() }
      if (cmd.__cmd === 'Update') throw new ConditionalCheckFailedException()
      return { Items: [] }
    })
    const res = await get(`/s/${TOKEN}`)
    expect(res.statusCode).toBe(429)
  })
})

describe('GET /l/<token>', () => {
  it('renders the carrier view with the office phone from settings', async () => {
    route({
      link: carrierLink(),
      load: LOAD,
      checkCalls: [],
      settings: { id: 'default', trackingContact: JSON.stringify({ mode: 'FIXED', phone: '(224) 875-6477' }) },
    })
    const res = await get(`/l/${TOKEN}`)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({
      loadNumber: 'S-1001-1',
      contactPhone: '(224) 875-6477',
      nextStop: { id: 'st-2', city: 'Dallas' },
    })
  })

  it('404s when the link has no load behind it', async () => {
    route({ link: carrierLink({ loadId: null }) })
    expect((await get(`/l/${TOKEN}`)).statusCode).toBe(404)
  })
})

describe('POST /l/<token>/ping', () => {
  const fix = { lat: 38.4, lng: -92.1, accuracyM: 12 }

  it('writes one check call and the link counters, and never touches Load', async () => {
    route({ link: carrierLink() })
    const res = await post(`/l/${TOKEN}/ping`, fix)
    expect(res.statusCode).toBe(200)
    expect(json(res).ok).toBe(true)

    const puts = sent().filter((c) => c.__cmd === 'Put')
    expect(puts).toHaveLength(1)
    expect(puts[0].TableName).toBe(TABLES.checkCall)
    expect(puts[0].Item).toMatchObject({
      loadId: 'ld-1',
      shipmentId: 'shp-1',
      loadCarrierId: 'lc-1',
      type: 'TRACKING_PING',
      source: 'LINK',
      lat: 38.4,
      lng: -92.1,
      accuracyM: 12,
      createdBy: `link:${TOKEN.slice(0, 8)}`,
    })

    const update = sent().find((c) => c.__cmd === 'Update')
    expect(update?.TableName).toBe(TABLES.link)
    expect(update?.UpdateExpression).toContain('ADD pingCount :one')
    // The public role has no Load write; nothing here may try one.
    expect(writes().some((c) => c.TableName === TABLES.load)).toBe(false)
  })

  it('409s a fix too coarse to mean anything, before writing', async () => {
    route({ link: carrierLink() })
    const res = await post(`/l/${TOKEN}/ping`, { ...fix, accuracyM: 5001 })
    expect(res.statusCode).toBe(409)
    expect(json(res).error).toBe('Location too imprecise — turn on precise location')
    expect(writes()).toHaveLength(0)
  })

  it('400s coordinates outside the globe', async () => {
    route({ link: carrierLink() })
    expect((await post(`/l/${TOKEN}/ping`, { lat: 91, lng: 0, accuracyM: 5 })).statusCode).toBe(400)
    expect((await post(`/l/${TOKEN}/ping`, { lat: 0, lng: -181, accuracyM: 5 })).statusCode).toBe(400)
    expect((await post(`/l/${TOKEN}/ping`, { lat: 'north', lng: 0 })).statusCode).toBe(400)
    expect(writes()).toHaveLength(0)
  })

  it('429s a second tap inside a minute, and writes nothing', async () => {
    route({ link: carrierLink({ lastPingAt: new Date(Date.now() - 30_000).toISOString() }) })
    const res = await post(`/l/${TOKEN}/ping`, fix)
    expect(res.statusCode).toBe(429)
    expect(writes()).toHaveLength(0)
  })

  it('accepts the next tap once the minute is up', async () => {
    route({ link: carrierLink({ lastPingAt: new Date(Date.now() - 90_000).toISOString() }) })
    expect((await post(`/l/${TOKEN}/ping`, fix)).statusCode).toBe(200)
  })

  it('429s a link that has spent its ping budget', async () => {
    route({ link: carrierLink({ pingCount: 500 }) })
    const res = await post(`/l/${TOKEN}/ping`, fix)
    expect(res.statusCode).toBe(429)
    expect(writes()).toHaveLength(0)
  })

  it('404s a revoked link without reading anything else', async () => {
    route({ link: carrierLink({ status: 'REVOKED' }) })
    const res = await post(`/l/${TOKEN}/ping`, fix)
    expect(res.statusCode).toBe(404)
    expect(writes()).toHaveLength(0)
  })

  it('leaves no check call behind when the counter guard refuses the tap', async () => {
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__cmd === 'Get' && cmd.TableName === TABLES.link) return { Item: carrierLink() }
      if (cmd.__cmd === 'Update') throw new ConditionalCheckFailedException()
      return {}
    })
    const res = await post(`/l/${TOKEN}/ping`, fix)
    expect(res.statusCode).toBe(429)
    expect(sent().some((c) => c.__cmd === 'Put')).toBe(false)
  })
})
