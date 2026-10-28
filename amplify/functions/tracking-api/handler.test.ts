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

const mockS3Send = vi.hoisted(() => vi.fn())
const mockGetSignedUrl = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () { return { send: mockS3Send } }),
  HeadObjectCommand: vi.fn(function (params: unknown) { return { __cmd: 'Head', ...(params as object) } }),
  PutObjectCommand: vi.fn(function (params: unknown) { return { __cmd: 'PutObject', ...(params as object) } }),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mockGetSignedUrl }))

let handler: typeof HandlerModule.handler

const TOKEN = 'Hq3Zn7Lp0vWx9TbKcRdYu1Ms4Ae6Gi2J'   // 32 base64url chars
const BAD_TOKEN = 'too-short'
const BUCKET = 'test-bcat-docs'

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
  document: 'test-ShipmentDocument',
  equipment: 'test-Equipment',
  truckLocation: 'test-TruckLocation',
  driver: 'test-Driver',
  quote: 'test-Quote',
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
  process.env.SHIPMENT_DOCUMENT_TABLE_NAME = TABLES.document
  process.env.BUCKET_NAME = BUCKET
  process.env.QUOTE_TABLE_NAME = TABLES.quote
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
  carrier?: unknown
  documents?: unknown[]
  /** The one row a commit retry finds already written, read by id. */
  document?: unknown
  checkCalls?: unknown[]
  positions?: unknown[]
  division?: unknown
  quotes?: unknown[]
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
      if (cmd.TableName === TABLES.loadCarrier) return { Item: by.carrier ?? undefined }
      if (cmd.TableName === TABLES.document) return { Item: by.document ?? undefined }
      return { Item: undefined }
    }
    if (cmd.__cmd === 'Query') {
      if (cmd.TableName === TABLES.order) return { Items: by.orders ?? [] }
      if (cmd.TableName === TABLES.load) return { Items: by.loads ?? [] }
      if (cmd.TableName === TABLES.loadCarrier) return { Items: by.carriers ?? [] }
      if (cmd.TableName === TABLES.checkCall) return { Items: by.checkCalls ?? [] }
      if (cmd.TableName === TABLES.history) return { Items: by.positions ?? [] }
      if (cmd.TableName === TABLES.document) return { Items: by.documents ?? [] }
      if (cmd.TableName === TABLES.quote) return { Items: by.quotes ?? [] }
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
  mockS3Send.mockReset()
  mockGetSignedUrl.mockReset()
  mockGetSignedUrl.mockResolvedValue('https://s3.example/signed-put')
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

// ── Step E: the carrier upload portal ───────────────────────────────────────

const uploadLink = (over: Record<string, unknown> = {}) => ({
  id: TOKEN,
  kind: 'CARRIER_UPLOAD',
  status: 'ACTIVE',
  shipmentId: 'shp-1',
  loadId: 'ld-1',
  loadCarrierId: 'lc-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  neededTypes: ['POD', 'CARRIER_INVOICE'],
  createdBy: 'rep@bcat.com',
  ...over,
})

/** The assignment, and a load row carrying everything the portal may never show. */
const CARRIER_ROW = { id: 'lc-1', loadId: 'ld-1', shipmentId: 'shp-1', status: 'ACTIVE', carrierName: 'Blue Sky Trucking', rateCents: 185000, dispatcherEmail: 'ops@bluesky.com' }
const PORTAL_LOAD = { ...LOAD, customerName: 'Acme Foods', customerRefs: 'PO-99-12', rateCents: 250000, carrierRateCents: 185000 }

const DOC_ID = 'sdoc-11111111-2222-4333-8444-555555555555'
const DOC_KEY = `shipment-docs/shp-1/${DOC_ID}-pod.pdf`
const portalDoc = (over: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  shipmentId: 'shp-1',
  loadId: 'ld-1',
  loadCarrierId: 'lc-1',
  type: 'POD',
  name: 'pod.pdf',
  s3Key: DOC_KEY,
  contentType: 'application/pdf',
  sizeBytes: 2048,
  source: 'CARRIER_PORTAL',
  audience: 'ALL',
  status: 'ACTIVE',
  version: 1,
  reviewStatus: 'PENDING',
  uploadLinkId: TOKEN,
  uploadedBy: `link:${TOKEN.slice(0, 8)}`,
  uploadedAt: '2026-10-23T10:00:00.000Z',
  createdBy: `link:${TOKEN.slice(0, 8)}`,
  ...over,
})

const upload = { type: 'POD', name: 'pod.pdf', contentType: 'application/pdf', sizeBytes: 2048 }
const commit = { ...upload, documentId: DOC_ID, s3Key: DOC_KEY }

describe('GET /u/<token>', () => {
  it('shows the load, what is still needed and what this link sent — and nothing else', async () => {
    const updates: Cmd[] = []
    route({
      link: uploadLink(),
      load: PORTAL_LOAD,
      carrier: CARRIER_ROW,
      documents: [
        portalDoc(),
        // The customer's own paperwork on the same shipment: never the carrier's business.
        portalDoc({ id: 'sdoc-other', loadCarrierId: null, orderId: 'ord-1', type: 'CUSTOMER_RATE_CON', name: 'acme-rate-confirmation.pdf', uploadLinkId: null }),
      ],
      division: { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', active: true },
      settings: { id: 'default', trackingContact: JSON.stringify({ mode: 'FIXED', phone: '(224) 875-6477' }) },
      onUpdate: (cmd) => updates.push(cmd),
    })

    const res = await get(`/u/${TOKEN}`)
    expect(res.statusCode).toBe(200)
    const view = json(res)
    expect(view).toMatchObject({
      broker: { name: 'BCAT Logistics' },
      loadNumber: 'S-1001-1',
      carrierName: 'Blue Sky Trucking',
      contactPhone: '(224) 875-6477',
    })
    expect(view.needed).toEqual([
      { type: 'POD', label: 'Proof of delivery', satisfied: true },
      { type: 'CARRIER_INVOICE', label: 'Carrier invoice', satisfied: false },
    ])
    expect(view.uploads).toHaveLength(1)
    expect((view.uploads as Record<string, unknown>[])[0]).toMatchObject({ id: DOC_ID, reviewStatus: 'PENDING' })

    // Nobody outside the company learns who the customer is, what the load pays, or
    // what anybody else attached to the shipment.
    expect(res.body).not.toContain('Acme Foods')
    expect(res.body).not.toContain('PO-99-12')
    expect(res.body).not.toContain('250000')
    expect(res.body).not.toContain('185000')
    expect(res.body).not.toContain('acme-rate-confirmation.pdf')

    expect(updates[0].UpdateExpression).toContain('ADD requestCount :one, openCount :one')
    expect(updates[0].ConditionExpression).toContain('requestCount < :max')
  })

  it('404s an expired link, a revoked one, a ping token and a stranger, all the same way', async () => {
    for (const link of [
      uploadLink({ expiresAt: '2020-01-01T00:00:00.000Z' }),
      uploadLink({ status: 'REVOKED' }),
      carrierLink(),
      undefined,
    ]) {
      route({ link, load: PORTAL_LOAD, carrier: CARRIER_ROW })
      const res = await get(`/u/${TOKEN}`)
      expect(res.statusCode).toBe(404)
      expect(json(res).error).toBe('That upload link is no longer active.')
    }
  })

  it('marks an expired upload link EXPIRED instead of counting the open', async () => {
    const updates: Cmd[] = []
    route({ link: uploadLink({ expiresAt: '2020-01-01T00:00:00.000Z' }), onUpdate: (c) => updates.push(c) })
    await get(`/u/${TOKEN}`)
    expect(updates).toHaveLength(1)
    expect(updates[0].ExpressionAttributeValues?.[':expired']).toBe('EXPIRED')
  })
})

describe('POST /u/<token>/upload', () => {
  it('presigns a PUT under this shipment and writes nothing', async () => {
    route({ link: uploadLink() })
    const res = await post(`/u/${TOKEN}/upload`, upload)
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.uploadUrl).toBe('https://s3.example/signed-put')
    expect(String(body.documentId)).toMatch(/^sdoc-[0-9a-f-]{36}$/)
    expect(body.s3Key).toBe(`shipment-docs/shp-1/${body.documentId}-pod.pdf`)

    const signed = mockGetSignedUrl.mock.calls[0]
    expect(signed[1]).toMatchObject({ Bucket: BUCKET, ContentType: 'application/pdf', ContentLength: 2048 })
    // The presigner drops `content-type` unless it is named explicitly, so this is
    // what makes the signed URL refuse a PUT of some other type.
    expect(signed[2]).toEqual({ expiresIn: 300, signableHeaders: new Set(['content-type']) })
    expect(writes()).toHaveLength(0)
  })

  it('400s a document type a carrier may not send here', async () => {
    route({ link: uploadLink() })
    const res = await post(`/u/${TOKEN}/upload`, { ...upload, type: 'BOL' })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toBe('That document type cannot be uploaded here.')
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('400s a file past the portal ceiling, and one that is not a PDF or photo', async () => {
    route({ link: uploadLink() })
    const big = await post(`/u/${TOKEN}/upload`, { ...upload, sizeBytes: 16 * 1024 * 1024 })
    expect(big.statusCode).toBe(400)
    expect(json(big).error).toBe('Files must be smaller than 15 MB.')
    const wrong = await post(`/u/${TOKEN}/upload`, { ...upload, contentType: 'application/zip' })
    expect(wrong.statusCode).toBe(400)
    expect(json(wrong).error).toBe('Please send a PDF, JPG or PNG.')
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('429s the twenty-first file and tells the carrier to call dispatch', async () => {
    route({ link: uploadLink({ uploadCount: 20 }) })
    const res = await post(`/u/${TOKEN}/upload`, upload)
    expect(res.statusCode).toBe(429)
    expect(json(res).error).toBe('This link has received all the files it can. Call dispatch.')
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
    expect(writes()).toHaveLength(0)
  })

  it('404s a revoked link before looking at the body', async () => {
    route({ link: uploadLink({ status: 'REVOKED' }) })
    expect((await post(`/u/${TOKEN}/upload`, upload)).statusCode).toBe(404)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })
})

describe('POST /u/<token>/commit', () => {
  beforeEach(() => {
    mockS3Send.mockResolvedValue({ ContentLength: 2048, ContentType: 'application/pdf' })
  })

  it('writes one PENDING document row and the link counter, and touches nothing else', async () => {
    route({ link: uploadLink() })
    const res = await post(`/u/${TOKEN}/commit`, commit)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ ok: true, documentId: DOC_ID })

    const puts = sent().filter((c) => c.__cmd === 'Put')
    expect(puts).toHaveLength(1)
    expect(puts[0].TableName).toBe(TABLES.document)
    expect(puts[0].ConditionExpression).toBe('attribute_not_exists(id)')
    expect(puts[0].Item).toMatchObject({
      id: DOC_ID,
      shipmentId: 'shp-1',
      loadId: 'ld-1',
      loadCarrierId: 'lc-1',
      type: 'POD',
      s3Key: DOC_KEY,
      source: 'CARRIER_PORTAL',
      reviewStatus: 'PENDING',
      status: 'ACTIVE',
      version: 1,
      audience: 'ALL',
      uploadLinkId: TOKEN,
      uploadedBy: `link:${TOKEN.slice(0, 8)}`,
      createdBy: `link:${TOKEN.slice(0, 8)}`,
    })

    const updates = sent().filter((c) => c.__cmd === 'Update')
    expect(updates).toHaveLength(1)
    expect(updates[0].TableName).toBe(TABLES.link)
    expect(updates[0].UpdateExpression).toContain('ADD uploadCount :one')
    expect(updates[0].UpdateExpression).toContain('lastUploadAt')

    // A carrier-portal upload influences a billing decision only once staff accept
    // it: this role writes no Order, Load, LoadCarrier, Shipment or settings row.
    const forbidden = [TABLES.order, TABLES.load, TABLES.loadCarrier, TABLES.shipment, TABLES.settings]
    expect(writes().filter((c) => forbidden.includes(c.TableName))).toHaveLength(0)
  })

  it('refuses a key that belongs to another shipment', async () => {
    route({ link: uploadLink() })
    const res = await post(`/u/${TOKEN}/commit`, { ...commit, s3Key: `shipment-docs/shp-9/${DOC_ID}-pod.pdf` })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toBe('That file does not belong to this load.')
    expect(writes()).toHaveLength(0)
    expect(mockS3Send).not.toHaveBeenCalled()
  })

  it('refuses bytes that are not the ones the presign was issued for', async () => {
    route({ link: uploadLink() })
    mockS3Send.mockResolvedValue({ ContentLength: 9_000_000, ContentType: 'application/pdf' })
    const res = await post(`/u/${TOKEN}/commit`, commit)
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toBe('That file does not match what was uploaded.')
    expect(writes()).toHaveLength(0)
  })

  it('409s a file that has not landed yet, leaving no row behind', async () => {
    route({ link: uploadLink() })
    mockS3Send.mockRejectedValue(Object.assign(new Error('NotFound'), { name: 'NotFound' }))
    const res = await post(`/u/${TOKEN}/commit`, commit)
    expect(res.statusCode).toBe(409)
    expect(writes()).toHaveLength(0)
  })

  it('does not spend a second slot when the same commit is retried', async () => {
    mockSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.__cmd === 'Get' && cmd.TableName === TABLES.link) return { Item: uploadLink() }
      if (cmd.__cmd === 'Put') throw new ConditionalCheckFailedException()
      return {}
    })
    const res = await post(`/u/${TOKEN}/commit`, commit)
    expect(res.statusCode).toBe(200)
    expect(sent().some((c) => c.__cmd === 'Update')).toBe(false)
  })

  it('429s the twenty-first file at commit, not only at presign', async () => {
    // A link holder can hold twenty presigned PUTs minted while the count was still
    // low; the ceiling is only a ceiling if the commit refuses them too.
    route({ link: uploadLink({ uploadCount: 20 }) })
    const res = await post(`/u/${TOKEN}/commit`, commit)
    expect(res.statusCode).toBe(429)
    expect(json(res).error).toBe('This link has received all the files it can. Call dispatch.')
    expect(writes()).toHaveLength(0)
  })

  it('still answers a retried commit of an already-written file at the ceiling', async () => {
    route({ link: uploadLink({ uploadCount: 20 }), document: portalDoc() })
    const res = await post(`/u/${TOKEN}/commit`, commit)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ ok: true, documentId: DOC_ID })
    expect(writes()).toHaveLength(0)
  })

  it('400s a document id this route never minted', async () => {
    route({ link: uploadLink() })
    const res = await post(`/u/${TOKEN}/commit`, { ...commit, documentId: '../../etc/passwd' })
    expect(res.statusCode).toBe(400)
    expect(writes()).toHaveLength(0)
  })
})


// ── Step H: the public quote link ───────────────────────────────────────────

/** Everything on a quote row that a public page may never print. */
const QUOTE_SECRETS = {
  internalNotes: 'Customer always pays late — hold the margin',
  carrierName: 'Blue Sky Trucking',
  carrierMc: 'MC-998877',
  carrierEmail: 'dispatch@blueskytrucking.example',
  customerName: 'Midwest Millwork',
  customerId: 'cus-77421',
  street: '4120 Dock Row',
  reference: 'PO-55512',
  targetBuyCents: 111_777,
  topSpendCents: 123_456,
  customerRateCents: 145_511,
  marginBps: 2_447,
}

const QUOTE_STOPS = [
  { id: 'qs-1', type: 'pickup', sequence: 0, name: 'Shipper', address: { street: QUOTE_SECRETS.street, city: 'Chicago', state: 'IL' }, appt: '2026-10-29T14:00:00.000Z' },
  { id: 'qs-2', type: 'delivery', sequence: 1, name: 'Consignee', address: { street: QUOTE_SECRETS.street, city: 'Danville', state: 'IL' }, appt: '2026-10-30T09:00:00.000Z' },
]

const QUOTE_LINES = [
  { side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 120_000, isRate: true, sortOrder: 0 },
  { side: 'CUSTOMER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1_500, isRate: false, sortOrder: 1 },
  { side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: QUOTE_SECRETS.targetBuyCents, isRate: true, sortOrder: 2 },
]

/** The thread as tms-shipment-actions stores it: one list, oldest line first. */
const QUOTE_EVENTS = [{ at: '2026-10-28T12:00:00.000Z', by: 'rep@bcat.com', kind: 'SENT', amountCents: 145_500 }]

/**
 * The row as DynamoDB hands it back. Every list column is a native list: that is
 * what `marshallRow` in tms-shipment-actions puts in, and a fixture that strings
 * them is a fixture no writer agrees with.
 */
const quoteRow = (over: Record<string, unknown> = {}) => ({
  id: 'Q000012',
  side: 'SELL',
  status: 'QUOTED',
  groupId: 'grp-4',
  quoteDate: '2026-10-28',
  quoteMonth: '2026-10',
  customerId: QUOTE_SECRETS.customerId,
  customerName: QUOTE_SECRETS.customerName,
  contactName: 'Dana Reed',
  contactEmail: 'dana@midwest.example',
  carrierId: 'car-5150',
  carrierName: QUOTE_SECRETS.carrierName,
  carrierMc: QUOTE_SECRETS.carrierMc,
  carrierEmail: QUOTE_SECRETS.carrierEmail,
  divisionKey: 'BCAT_LOGISTICS',
  mode: 'FTL',
  rateType: 'SPOT',
  equipmentType: 'Dry Van',
  equipmentLengthFt: 53,
  stops: QUOTE_STOPS,
  laneKey: 'CHICAGO|IL>DANVILLE|IL',
  pickupAppt: '2026-10-29T14:00:00.000Z',
  commodity: 'Paper',
  weightLbs: 42_000,
  miles: 412,
  references: [{ code: 'PO', value: QUOTE_SECRETS.reference, level: 'ORDER', visibility: 'CUSTOMER' }],
  lines: QUOTE_LINES,
  amountCents: 145_500,
  customerRateCents: QUOTE_SECRETS.customerRateCents,
  targetBuyCents: QUOTE_SECRETS.targetBuyCents,
  topSpendCents: QUOTE_SECRETS.topSpendCents,
  marginBps: QUOTE_SECRETS.marginBps,
  rounds: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
  linkToken: TOKEN,
  quoteOpen: 'OPEN',
  customerMessage: 'Rate includes two hours free at each stop.',
  internalNotes: QUOTE_SECRETS.internalNotes,
  events: QUOTE_EVENTS,
  createdBy: 'rep@bcat.com',
  updatedBy: 'rep@bcat.com',
  version: 3,
  ...over,
})

const offerRow = (over: Record<string, unknown> = {}) => quoteRow({
  id: 'Q000013',
  side: 'BUY',
  status: 'QUOTED',
  loadId: 'ld-1',
  loadNumber: 'S-1001-1',
  amountCents: 120_000,
  bookNowRateCents: 125_000,
  customerMessage: 'Tarps required.',
  ...over,
})

const DIVISION = { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', active: true }

const respond = (body: unknown, over: { token?: string; ip?: string } = {}) =>
  handler({
    rawPath: `/q/${over.token ?? TOKEN}/respond`,
    body: JSON.stringify(body),
    requestContext: { http: { method: 'POST', sourceIp: over.ip ?? '203.0.113.9' } },
  })

const ANSWER = { name: 'Dana Reed', email: 'dana@midwest.example' }

describe('GET /q/<token>', () => {
  it('renders the customer page off the linkToken index and counts the read', async () => {
    route({ quotes: [quoteRow()], division: DIVISION, settings: { id: 'default', quoteTermsText: 'Payment net 30.' } })
    const res = await get(`/q/${TOKEN}`)
    expect(res.statusCode).toBe(200)

    const query = sent().find((c) => c.__cmd === 'Query' && c.TableName === TABLES.quote)
    // The physical GSI name Amplify mints for Quote's `index('linkToken')`, exactly
    // as `loadCarriersByShipmentId` is minted for LoadCarrier's `index('shipmentId')`.
    // A wrong name here is a 400 from DynamoDB on a page a customer is looking at.
    expect(query?.IndexName).toBe('quotesByLinkToken')

    const view = json(res)
    expect(view).toMatchObject({
      side: 'SELL',
      quoteNumber: 'Q000012',
      status: 'QUOTED',
      brokerName: 'BCAT Logistics',
      amountCents: 145_500,
      awaiting: 'YOU',
      terms: 'Payment net 30.',
      rounds: 1,
    })
    expect((view.stops as unknown[]).length).toBe(2)

    const counted = writes().filter((c) => c.TableName === TABLES.quote)
    expect(counted).toHaveLength(1)
    expect(counted[0].UpdateExpression).toBe('ADD requestCount :one')
    expect(counted[0].ConditionExpression).toContain('requestCount < :max')
  })

  it('shows a carrier the book-now rate only while the setting allows it', async () => {
    route({ quotes: [offerRow()], division: DIVISION, settings: { id: 'default' } })
    expect(json(await get(`/q/${TOKEN}`))).toMatchObject({ side: 'BUY', bookNowRateCents: 125_000 })

    route({ quotes: [offerRow()], division: DIVISION, settings: { id: 'default', quoteOffersCarrierSeesBookNow: false } })
    expect(json(await get(`/q/${TOKEN}`)).bookNowRateCents).toBeNull()
  })

  it("prints none of the row's internal numbers, on either side", async () => {
    for (const row of [quoteRow(), offerRow()]) {
      route({ quotes: [row], division: DIVISION, settings: { id: 'default' } })
      const res = await get(`/q/${TOKEN}`)
      expect(res.statusCode).toBe(200)
      const sell = row.side === 'SELL'
      const forbidden = [
        QUOTE_SECRETS.internalNotes,
        QUOTE_SECRETS.street,
        QUOTE_SECRETS.reference,
        String(QUOTE_SECRETS.targetBuyCents),
        String(QUOTE_SECRETS.topSpendCents),
        String(QUOTE_SECRETS.customerRateCents),
        String(QUOTE_SECRETS.marginBps),
        TOKEN,
        // A customer never learns who hauls it; a carrier never learns whose it is.
        ...(sell ? [QUOTE_SECRETS.carrierName, QUOTE_SECRETS.carrierMc, QUOTE_SECRETS.carrierEmail] : [QUOTE_SECRETS.customerName, QUOTE_SECRETS.customerId]),
      ]
      for (const secret of forbidden) expect(res.body).not.toContain(secret)
      for (const key of ['targetBuyCents', 'topSpendCents', 'marginBps', 'internalNotes', 'customerRateCents', 'linkToken', 'events']) {
        expect(Object.keys(json(res))).not.toContain(key)
      }
    }
  })

  it('never reads the quote table for a malformed token', async () => {
    route({})
    const res = await get(`/q/${BAD_TOKEN}`)
    expect(res.statusCode).toBe(404)
    expect(json(res).error).toBe('This quote link is no longer active')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('404s every rung that is not waiting on an answer, with one wording', async () => {
    // REQUESTED is a buy-side rung: a sell quote nobody has priced has no number
    // to show. WON, LOST and a token nobody minted answer the same way.
    for (const quotes of [
      [quoteRow({ status: 'REQUESTED' })],
      [quoteRow({ status: 'WON' })],
      [quoteRow({ status: 'LOST' })],
      [quoteRow({ linkToken: 'Zz3Zn7Lp0vWx9TbKcRdYu1Ms4Ae6Gi2J' })],
      [],
      [quoteRow(), offerRow()],
    ]) {
      route({ quotes })
      const res = await get(`/q/${TOKEN}`)
      expect(res.statusCode).toBe(404)
      expect(json(res).error).toBe('This quote link is no longer active')
      expect(writes()).toHaveLength(0)
    }
  })

  it('answers a carrier sitting on REQUESTED, which is a buy-side rung', async () => {
    route({ quotes: [offerRow({ status: 'REQUESTED' })], division: DIVISION })
    const res = await get(`/q/${TOKEN}`)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ side: 'BUY', status: 'REQUESTED', awaiting: 'YOU' })
  })

  it('writes an expired quote LOST/EXPIRED, takes the token off it, and 404s', async () => {
    const updates: Cmd[] = []
    route({ quotes: [quoteRow({ expiresAt: '2020-01-01T00:00:00.000Z' })], onUpdate: (c) => updates.push(c) })
    const res = await get(`/q/${TOKEN}`)
    expect(res.statusCode).toBe(404)
    expect(json(res).error).toBe('This quote link is no longer active')

    expect(updates).toHaveLength(1)
    expect(updates[0].TableName).toBe(TABLES.quote)
    expect(updates[0].Key).toEqual({ id: 'Q000012' })
    expect(updates[0].ExpressionAttributeValues).toMatchObject({ ':lost': 'LOST', ':expired': 'EXPIRED', ':was': 'QUOTED' })
    expect(updates[0].UpdateExpression).toContain('REMOVE #lt, #qo')
    // A sweep that closed it a second ago must win, not be overwritten.
    expect(updates[0].ConditionExpression).toBe('#lt = :tok AND #st = :was')
  })

  it('leaves a quote with no clock on it alone', async () => {
    route({ quotes: [quoteRow({ expiresAt: null })], division: DIVISION })
    expect((await get(`/q/${TOKEN}`)).statusCode).toBe(200)
  })

  it('429s once the link is past its request budget', async () => {
    route({ quotes: [quoteRow()], onUpdate: () => { throw new ConditionalCheckFailedException() } })
    const res = await get(`/q/${TOKEN}`)
    expect(res.statusCode).toBe(429)
    expect(json(res).error).toBe('This quote link has been opened too many times')
  })
})

describe('POST /q/<token>/respond', () => {
  const answered = (over: Record<string, unknown> = {}) => {
    const updates: Cmd[] = []
    route({ quotes: [over.row ?? quoteRow()], settings: over.settings, onUpdate: (c) => updates.push(c) })
    return updates
  }

  it("accepts a customer's yes once, and 410s the replay the stale index serves", async () => {
    let seen = 0
    route({
      quotes: [quoteRow()],
      // The index still hands back the row with its token after the first answer:
      // only the condition on the base table makes the answer once-only.
      onUpdate: () => { if (++seen > 1) throw new ConditionalCheckFailedException() },
    })

    const first = await respond({ ...ANSWER, action: 'ACCEPT' })
    expect(first.statusCode).toBe(200)
    expect(json(first)).toEqual({ ok: true, status: 'RECEIVED_REPLY', response: 'ACCEPTED' })

    const second = await respond({ ...ANSWER, action: 'ACCEPT' })
    expect(second.statusCode).toBe(410)
    expect(json(second).error).toBe('This quote has already been answered')
  })

  it('writes the whole answer in one conditioned update and spends the token', async () => {
    const updates = answered()
    const res = await respond({ ...ANSWER, action: 'ACCEPT', message: 'Go ahead.' }, { ip: '198.51.100.7' })
    expect(res.statusCode).toBe(200)

    expect(updates).toHaveLength(1)
    const cmd = updates[0]
    expect(cmd.TableName).toBe(TABLES.quote)
    expect(cmd.ConditionExpression).toBe('#lt = :tok AND #st IN (:from0, :from1)')
    expect(cmd.ExpressionAttributeValues).toMatchObject({
      ':tok': TOKEN,
      ':status': 'RECEIVED_REPLY',
      ':response': 'ACCEPTED',
      ':via': 'LINK',
      ':name': 'Dana Reed',
      ':email': 'dana@midwest.example',
      ':ip': '198.51.100.7',
      ':from0': 'QUOTED',
      ':from1': 'SENT_COUNTER',
    })
    // One use per round: the next round mints a new token.
    expect(cmd.UpdateExpression).toContain('REMOVE #lt')
    // An accepted quote is still open — a rep converts it.
    expect(cmd.UpdateExpression).not.toContain('#qo')
    expect(cmd.UpdateExpression).not.toContain('ADD')

    const events = cmd.ExpressionAttributeValues?.[':events'] as Record<string, unknown>[]
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ kind: 'ACCEPTED_ON_LINK', by: 'dana@midwest.example', note: 'Go ahead.' })
  })

  it('hands the thread back as a list the staff writer can append to', async () => {
    const updates = answered()
    expect((await respond({ ...ANSWER, action: 'COUNTER', amountCents: 139_900 })).statusCode).toBe(200)

    // tms-shipment-actions keeps Quote.events as a native DynamoDB list, and its
    // `pushEvent` only appends to `Array.isArray(quote.events)`. A string written
    // here reads back as no thread at all, so the first staff action after any
    // public answer replaces the whole history with a single line.
    const events = updates[0].ExpressionAttributeValues?.[':events']
    expect(Array.isArray(events)).toBe(true)
    const thread = events as Record<string, unknown>[]
    expect(thread).toHaveLength(2)
    // The rep's own line is still the first one on it, untouched.
    expect(thread[0]).toEqual(QUOTE_EVENTS[0])
    expect(thread[thread.length - 1]).toEqual({
      at: expect.any(String),
      by: 'dana@midwest.example',
      kind: 'COUNTERED_ON_LINK',
      amountCents: 139_900,
      note: null,
    })
  })

  it('declines to LOST with the reason, and takes it off the open board', async () => {
    const updates = answered()
    const res = await respond({ ...ANSWER, action: 'DECLINE', reason: 'TOO_HIGH' })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ ok: true, status: 'LOST', response: 'DECLINED' })
    expect(updates[0].ExpressionAttributeValues).toMatchObject({ ':lostReason': 'TOO_HIGH' })
    expect(updates[0].UpdateExpression).toContain('REMOVE #lt, #qo')
  })

  it('refuses a decline with no reason, or a reason nobody may send', async () => {
    for (const body of [
      { ...ANSWER, action: 'DECLINE' },
      { ...ANSWER, action: 'DECLINE', reason: 'EXPIRED' },
      { ...ANSWER, action: 'DECLINE', reason: 'NO_RESPONSE' },
      { ...ANSWER, action: 'DECLINE', reason: 'not-a-reason' },
    ]) {
      const updates = answered()
      const res = await respond(body)
      expect(res.statusCode).toBe(400)
      expect(json(res).error).toBe('Choose a reason so we know why this one did not work')
      expect(updates).toHaveLength(0)
    }
  })

  it('counters to RECEIVED_COUNTER at their number, and moves the round on', async () => {
    const updates = answered()
    const res = await respond({ ...ANSWER, action: 'COUNTER', amountCents: 139_900 })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ ok: true, status: 'RECEIVED_COUNTER', response: 'COUNTERED' })
    expect(updates[0].ExpressionAttributeValues).toMatchObject({ ':counter': 139_900, ':counterBy': 'THEM' })
    expect(updates[0].UpdateExpression).toContain('ADD #rd :one')
  })

  it('refuses a counter at the number already on the table, or at no number at all', async () => {
    const same = answered()
    const res = await respond({ ...ANSWER, action: 'COUNTER', amountCents: 145_500 })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toBe('That is already the number on the table — accept it instead')
    expect(same).toHaveLength(0)

    for (const amountCents of [undefined, 0, -100, 1_399.5, '139900']) {
      const updates = answered()
      expect((await respond({ ...ANSWER, action: 'COUNTER', amountCents })).statusCode).toBe(400)
      expect(updates).toHaveLength(0)
    }
  })

  it("refuses our own counter's number when it is the one on the table", async () => {
    // SENT_COUNTER: the page is showing our counter on the buy side, so countering
    // at that number is an accept wearing a counter's clothes.
    const updates = answered({ row: offerRow({ status: 'SENT_COUNTER', counterCents: 118_000, counterBy: 'US' }) })
    const res = await respond({ ...ANSWER, action: 'COUNTER', amountCents: 118_000 })
    expect(res.statusCode).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it("takes a carrier's price onto the row, and only from the rung that asked", async () => {
    const updates = answered({ row: offerRow({ status: 'REQUESTED', amountCents: 0 }) })
    const res = await respond({ ...ANSWER, action: 'QUOTE', amountCents: 132_500 })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ ok: true, status: 'QUOTED', response: 'COUNTERED' })
    expect(updates[0].ConditionExpression).toBe('#lt = :tok AND #st IN (:from0)')
    expect(updates[0].ExpressionAttributeValues).toMatchObject({ ':from0': 'REQUESTED', ':amount': 132_500 })
    expect(updates[0].UpdateExpression).toContain('ADD #rd :one')
  })

  it("refuses a carrier's quote with no price on it", async () => {
    const updates = answered({ row: offerRow({ status: 'REQUESTED', amountCents: 0 }) })
    const res = await respond({ ...ANSWER, action: 'QUOTE' })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toBe('Enter the rate you will haul this load for')
    expect(updates).toHaveLength(0)
  })

  it('lets a carrier take our number or the book-now rate, and nothing else', async () => {
    const ours = answered({ row: offerRow() })
    expect((await respond({ ...ANSWER, action: 'ACCEPT' })).statusCode).toBe(200)
    expect(ours[0].ExpressionAttributeValues).toMatchObject({ ':amount': 120_000, ':via': 'LINK' })

    const bookNow = answered({ row: offerRow() })
    expect((await respond({ ...ANSWER, action: 'ACCEPT', amountCents: 125_000 })).statusCode).toBe(200)
    expect(bookNow[0].ExpressionAttributeValues).toMatchObject({ ':amount': 125_000 })

    const invented = answered({ row: offerRow() })
    const res = await respond({ ...ANSWER, action: 'ACCEPT', amountCents: 150_000 })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toBe('That is not a number this offer is open at')
    expect(invented).toHaveLength(0)

    // Hidden book-now rate: a number the page never showed cannot be accepted.
    const hidden = answered({ row: offerRow(), settings: { id: 'default', quoteOffersCarrierSeesBookNow: false } })
    expect((await respond({ ...ANSWER, action: 'ACCEPT', amountCents: 125_000 })).statusCode).toBe(400)
    expect(hidden).toHaveLength(0)

    // A request nobody has priced has no number on it to take.
    const unpriced = answered({ row: offerRow({ status: 'REQUESTED', amountCents: 0, bookNowRateCents: null }) })
    const bare = await respond({ ...ANSWER, action: 'ACCEPT' })
    expect(bare.statusCode).toBe(400)
    expect(json(bare).error).toBe('There is no rate on this offer to accept yet')
    expect(unpriced).toHaveLength(0)
  })

  it('passes a carrier out of the round and off the open board', async () => {
    const updates = answered({ row: offerRow() })
    const res = await respond({ ...ANSWER, action: 'PASS' })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ ok: true, status: 'PASS', response: 'PASSED' })
    expect(updates[0].UpdateExpression).toContain('REMOVE #lt, #qo')
  })

  it('refuses a verb that belongs to the other side', async () => {
    const sell = answered()
    const onSell = await respond({ ...ANSWER, action: 'PASS' })
    expect(onSell.statusCode).toBe(400)
    expect(json(onSell).error).toBe('This quote can be accepted, countered or declined')
    expect(sell).toHaveLength(0)

    const buy = answered({ row: offerRow() })
    const onBuy = await respond({ ...ANSWER, action: 'DECLINE', reason: 'TOO_HIGH' })
    expect(onBuy.statusCode).toBe(400)
    expect(json(onBuy).error).toBe('This offer can be quoted, accepted, countered or passed')
    expect(buy).toHaveLength(0)
  })

  it('refuses an answer with nobody behind it', async () => {
    for (const body of [
      { action: 'ACCEPT', email: 'dana@midwest.example' },
      { action: 'ACCEPT', name: '  ', email: 'dana@midwest.example' },
      { action: 'ACCEPT', name: '...', email: 'dana@midwest.example' },
      { action: 'ACCEPT', name: 'Dana Reed' },
      { action: 'ACCEPT', name: 'Dana Reed', email: 'dana@midwest' },
      { action: 'ACCEPT', name: 'Dana Reed', email: 'dana at midwest.example' },
      { action: 'NUDGE', name: 'Dana Reed', email: 'dana@midwest.example' },
      { name: 'Dana Reed', email: 'dana@midwest.example' },
    ]) {
      const updates = answered()
      expect((await respond(body)).statusCode).toBe(400)
      expect(updates).toHaveLength(0)
    }
  })

  it('never reads the quote table for a malformed token, and 404s a dead one', async () => {
    route({})
    const bad = await respond({ ...ANSWER, action: 'ACCEPT' }, { token: BAD_TOKEN })
    expect(bad.statusCode).toBe(404)
    expect(mockSend).not.toHaveBeenCalled()

    route({ quotes: [quoteRow({ status: 'WON' })] })
    const dead = await respond({ ...ANSWER, action: 'ACCEPT' })
    expect(dead.statusCode).toBe(404)
    expect(json(dead).error).toBe('This quote link is no longer active')
    expect(writes()).toHaveLength(0)
  })

  it('says nothing but its own fixed sentence in every refusal', async () => {
    // A refusal is read by whoever holds the link: a customer, or the carrier on
    // the other side of the same load. Neither may learn a number off the row or
    // who the other one is, and the 200 body is not the only way out of here.
    const refusals: { statusCode: number; body: string }[] = []

    route({ quotes: [quoteRow({ status: 'WON' })] })
    refusals.push(await get(`/q/${TOKEN}`))
    refusals.push(await respond({ ...ANSWER, action: 'ACCEPT' }))

    // The budget on the way in, and the round moving under an answer on the way out.
    route({ quotes: [quoteRow()], onUpdate: () => { throw new ConditionalCheckFailedException() } })
    refusals.push(await get(`/q/${TOKEN}`))
    refusals.push(await respond({ ...ANSWER, action: 'ACCEPT' }))

    // The two refusals that are read against the row's own numbers.
    route({ quotes: [offerRow({ status: 'SENT_COUNTER', counterCents: 118_000, counterBy: 'US' })] })
    refusals.push(await respond({ ...ANSWER, action: 'COUNTER', amountCents: 118_000 }))
    refusals.push(await respond({ ...ANSWER, action: 'ACCEPT', amountCents: 150_000 }))

    expect(refusals.map((res) => res.statusCode)).toEqual([404, 404, 429, 410, 400, 400])
    for (const res of refusals) {
      const body = json(res)
      expect(Object.keys(body)).toEqual(['error'])
      // Fixed sentences: no amount, no round, no id can ride out on one.
      expect(String(body.error)).not.toMatch(/\d/)
      for (const secret of [
        QUOTE_SECRETS.internalNotes,
        QUOTE_SECRETS.street,
        QUOTE_SECRETS.reference,
        QUOTE_SECRETS.carrierName,
        QUOTE_SECRETS.carrierMc,
        QUOTE_SECRETS.carrierEmail,
        QUOTE_SECRETS.customerName,
        QUOTE_SECRETS.customerId,
        String(QUOTE_SECRETS.targetBuyCents),
        String(QUOTE_SECRETS.topSpendCents),
        String(QUOTE_SECRETS.customerRateCents),
        String(QUOTE_SECRETS.marginBps),
        TOKEN,
      ]) expect(res.body).not.toContain(secret)
    }
  })
})
