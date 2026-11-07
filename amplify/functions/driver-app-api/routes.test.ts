import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { ScanCommand, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { handler } from './handler'
import { applyUpdateExpression, matchesFilterExpression } from './routesFake'
import { buildDriverRoster, projectLoadStream, type ProjectorDeps } from '../load-tracking-projector/handler'
import { CHECK_CALL_TABLE, FakeDynamo, TABLES } from '../load-tracking-projector/fakeTables'
import { shipmentMirrors } from '../_shared/shipmentStore'
import { deriveLegacyFields } from '../../../src/lib/stops'
import type { Stop } from '../../../src/types'

/**
 * Driver-app routes the merge left without a handler test, and the two-way consistency
 * between a driver's taps, the Load row, and the shipment (Step AW stage C.4). The handler
 * runs against an in-memory DynamoDB exactly like handler.test.ts; the load-tracking
 * projector then consumes the Load rows the handler wrote, on its own in-memory tables.
 */

const mockVerify = vi.hoisted(() => vi.fn())
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({ verify: mockVerify }),
  },
}))

const mockGetSignedUrl = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mockGetSignedUrl }))
// The dispatch number comes from SSM; the fixture pretends it is set up.
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = async () => ({ Parameter: { Value: '+12248756477' } }) },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}))

const mockS3Send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: mockS3Send }
  }),
  GetObjectCommand: vi.fn(function (this: { input: { Bucket?: string; Key?: string } }, input: { Bucket?: string; Key?: string }) {
    this.input = input
  }),
  PutObjectCommand: vi.fn(function (this: { input: { Bucket?: string; Key?: string; ContentType?: string } }, input: { Bucket?: string; Key?: string; ContentType?: string }) {
    this.input = input
  }),
  HeadObjectCommand: vi.fn(function (this: { input: { Bucket?: string; Key?: string } }, input: { Bucket?: string; Key?: string }) {
    this.input = input
  }),
}))

interface MockDynamoGetInput {
  TableName?: string
  Key?: Record<string, unknown>
}
interface MockDynamoPutInput {
  TableName?: string
  Item?: Record<string, unknown>
  ConditionExpression?: string
}
interface MockDynamoScanInput {
  TableName?: string
  FilterExpression?: string
  ExpressionAttributeValues?: Record<string, unknown>
}
interface MockDynamoUpdateInput {
  TableName?: string
  Key?: Record<string, unknown>
  UpdateExpression?: string
  ExpressionAttributeValues?: Record<string, unknown>
}

const mockDynamoSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockDynamoSend }) },
  ScanCommand: vi.fn(function (this: { input: MockDynamoScanInput }, input: MockDynamoScanInput) {
    this.input = input
  }),
  GetCommand: vi.fn(function (this: { input: MockDynamoGetInput }, input: MockDynamoGetInput) {
    this.input = input
  }),
  PutCommand: vi.fn(function (this: { input: MockDynamoPutInput }, input: MockDynamoPutInput) {
    this.input = input
  }),
  UpdateCommand: vi.fn(function (this: { input: MockDynamoUpdateInput }, input: MockDynamoUpdateInput) {
    this.input = input
  }),
  QueryCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input
  }),
}))

// The projector under test uses the real command classes; only the client is stubbed.
vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-dynamodb')>()),
  DynamoDBClient: vi.fn(function () {}),
}))

const sesSendMock = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: vi.fn(function () {
    return { send: sesSendMock }
  }),
  SendEmailCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input
  }),
}))

interface SlackResponse {
  ok: boolean
  ts?: string
  error?: string
}

type FetchLike = (url: unknown, init?: { body?: string }) => Promise<{ json: () => Promise<SlackResponse> }>

const fetchMock = vi.fn<FetchLike>(async () => ({
  json: async () => ({ ok: true, ts: '1699999999.000100' }),
}))
vi.stubGlobal('fetch', fetchMock)

vi.hoisted(() => {
  process.env.DRIVER_SUBMISSION_TABLE_NAME = 'DriverSubmission-test'
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = 'DriverSubmissionDoc-test'
  process.env.DRIVER_TABLE_NAME = 'Driver-test'
  process.env.TRUCK_CONFIG_TABLE_NAME = 'TruckConfig-test'
  process.env.DISPATCH_PARAM_PATH = '/bcat/dispatch/test'
  process.env.DRIVER_PAY_SETTING_TABLE_NAME = 'DriverPaySetting-test'
  process.env.AMAZON_TRIP_TABLE_NAME = 'AmazonTrip-test'
  process.env.DRIVER_PAY_DEDUCTION_TABLE_NAME = 'DriverPayDeduction-test'
  process.env.DRIVER_PAY_CREDIT_TABLE_NAME = 'DriverPayCredit-test'
  process.env.FUEL_TRANSACTION_TABLE_NAME = 'FuelTransaction-test'
  process.env.BUCKET_NAME = 'bcat-docs-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.LOCATION_TABLE_NAME = 'Location-test'
  process.env.POD_DOCUMENT_TABLE_NAME = 'PodDocument-test'
  process.env.EQUIPMENT_TABLE_NAME = 'Equipment-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  process.env.TIME_CLOCK_TABLE_NAME = 'TimeClockEntry-test'
  process.env.DRIVER_AVAILABILITY_TABLE_NAME = 'DriverAvailability-test'
  process.env.STAFF_USER_POOL_ID = 'us-east-1_staffpool'
  process.env.STAFF_USER_POOL_CLIENT_ID = 'staff-client-id'
  process.env.DRIVER_USER_POOL_ID = 'us-east-1_testpool'
  process.env.DRIVER_USER_POOL_CLIENT_ID = 'test-client-id'
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
  process.env.INTAKE_IVAN_CHANNEL_ID = 'C0B4YJXLYM8'
  process.env.LOADS_EMAIL_TO = 'ivanloads@bcatcorp.com'
  process.env.SES_FROM_ADDRESS = 'onboarding@bcatcorp.com'
  process.env.AWS_REGION = 'us-east-1'
})

type Row = Record<string, unknown>
type Tables = Record<string, Record<string, Row>>

const DRIVER_A_ID = 'drv-a'
const DRIVER_B_ID = 'drv-b'
const EMAIL_A = 'driver.a@example.com'
const EMAIL_B = 'driver.b@example.com'


function baseEvent(rawPath: string, method = 'GET', body?: unknown, query?: Record<string, string>): Parameters<typeof handler>[0] {
  return {
    rawPath,
    requestContext: { http: { method } },
    queryStringParameters: query,
    headers: { authorization: 'Bearer valid-token' },
    body: body === undefined ? null : JSON.stringify(body),
  }
}

const call = async (path: string, method = 'GET', body?: unknown, query?: Record<string, string>) => {
  const res = await handler(baseEvent(path, method, body, query))
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, unknown> }
}

/** The in-memory DynamoDB behind the handler. */
let tables: Tables
let spies: MockInstance[] = []

afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies = []
})

beforeEach(() => {
  vi.clearAllMocks()
  spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ]
  mockVerify.mockReset()
  mockVerify.mockResolvedValue({ email: EMAIL_A, email_verified: true })
  mockGetSignedUrl.mockResolvedValue('https://s3.test/presigned-url')
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1699999999.000100' }) })
  sesSendMock.mockReset()
  sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-123' })

  tables = {
    'Driver-test': {
      [DRIVER_A_ID]: { id: DRIVER_A_ID, name: 'Driver A', active: true, email: EMAIL_A, ivanApp: true },
      [DRIVER_B_ID]: { id: DRIVER_B_ID, name: 'Driver B', active: true, email: EMAIL_B },
    },
    'DriverPaySetting-test': {
      'set-a': { id: 'set-a', driverId: DRIVER_A_ID, active: true, payGroup: 'AMAZON', payPercent: 0.88, expensesBeforePercent: false, email: EMAIL_A },
    },
    'Load-test': {},
    'Equipment-test': {},
    'DriverSubmission-test': {},
    'DriverSubmissionDoc-test': {},
    'PodDocument-test': {},
    'Location-test': {},
    'AuditLog-test': {},
    'TimeClockEntry-test': {},
    'DriverAvailability-test': {},
  }

  mockDynamoSend.mockImplementation(async (cmd: { input?: unknown }) => {
    const input = (cmd.input ?? {}) as {
      TableName?: string
      Key?: Record<string, unknown>
      Item?: Row
      FilterExpression?: string
      UpdateExpression?: string
      IndexName?: string
      ExpressionAttributeNames?: Record<string, string>
      ExpressionAttributeValues?: Record<string, unknown>
    }
    const records = tables[input.TableName ?? '']
    if (cmd instanceof GetCommand) {
      const id = input.Key?.id as string | undefined
      return { Item: id && records?.[id] ? { ...records[id] } : undefined }
    }
    if (cmd instanceof ScanCommand) {
      const values = input.ExpressionAttributeValues ?? {}
      return {
        Items: Object.values(records ?? {}).filter((r) => matchesFilterExpression(r, input.FilterExpression ?? '', values, input.ExpressionAttributeNames)),
      }
    }
    if (cmd instanceof PutCommand) {
      const id = input.Item?.id as string | undefined
      if (id && records) records[id] = { ...input.Item }
      return {}
    }
    if (cmd instanceof UpdateCommand) {
      const id = input.Key?.id as string | undefined
      if (id && records?.[id]) {
        applyUpdateExpression(records[id], input.UpdateExpression ?? '', input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {})
        records[id].updatedAt = new Date().toISOString()
      }
      return {}
    }
    if (cmd instanceof QueryCommand) return { Items: [] }
    return {}
  })
})

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────

/** A past week, so the paperwork day sheet (which never looks past today) can show it. */
const PAST = { pickup: '2026-10-05T14:00:00Z', delivery: '2026-10-06T14:00:00Z', week: '2026-10-04', day: '2026-10-05' }
/** Far enough ahead that /loads/current still counts it as the driver's open load. */
const FUTURE = { pickup: '2036-03-10T14:00:00Z', delivery: '2036-03-11T14:00:00Z' }

function shipmentLoad(when: { pickup: string; delivery: string }, over: Row = {}): Row {
  return {
    __typename: 'Load',
    id: 'load-1',
    shipmentId: 'ship-1',
    orderId: 'order-1',
    loadNumber: '20001',
    leg: 1,
    aljexId: '20001',
    customer: 'Acme Test Co',
    status: 'DISPATCHED',
    statusSource: 'USER',
    pickupDriverId: DRIVER_A_ID,
    deliveryDriverId: DRIVER_A_ID,
    pickupAppt: when.pickup,
    deliveryAppt: when.delivery,
    originCity: 'Joliet, IL',
    destinationCity: 'Mesa, AZ',
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: 'dispatch@example.com',
    stops: [
      { id: 'st-p', type: 'pickup', sequence: 0, city: 'Joliet, IL', appt: when.pickup, driverId: DRIVER_A_ID },
      { id: 'st-d', type: 'delivery', sequence: 1, city: 'Mesa, AZ', appt: when.delivery, driverId: DRIVER_A_ID },
    ],
    ...over,
  }
}

const loadTable = () => tables['Load-test']
const loadRow = (id = 'load-1') => loadTable()[id]

// ── The routes the merge left without a handler test (MERGE_REGRESSION C-R4, C-R10, C-R11, C-R18) ──

describe('GET /trailers and GET /trucks', () => {
  beforeEach(() => {
    tables['Equipment-test'] = {
      'tr-2': { id: 'tr-2', type: 'trailer', unitNumber: '9002', active: true },
      'tr-10': { id: 'tr-10', type: 'trailer', unitNumber: '9010', active: true, nickname: ' Reefer ' },
      'tr-off': { id: 'tr-off', type: 'trailer', unitNumber: '9003', active: false },
      'tr-blank': { id: 'tr-blank', type: 'trailer', unitNumber: '  ', active: true },
      'k-1': { id: 'k-1', type: 'truck', unitNumber: '12', active: true, eldSource: 'Motive', motiveVehicleNumber: 'M12', assignedDriverId: DRIVER_A_ID },
      'k-2': { id: 'k-2', type: 'truck', unitNumber: '3', active: true, assignedDriverId: DRIVER_B_ID },
      'k-3': { id: 'k-3', type: 'truck', unitNumber: '4', active: true, eldSource: 'motive' },
      'k-off': { id: 'k-off', type: 'truck', unitNumber: '5', active: false },
    }
  })

  it('lists only active trailers that carry a unit number, in unit order, with the nickname trimmed', async () => {
    const res = await call('/trailers')
    expect(res.status).toBe(200)
    expect(res.body.trailers).toEqual([
      { id: 'tr-2', unitNumber: '9002', nickname: null },
      { id: 'tr-10', unitNumber: '9010', nickname: 'Reefer' },
    ])
  })

  it('lists active trucks numerically with who holds each one, which is mine, and whether the ELD is wired', async () => {
    const res = await call('/trucks')
    expect(res.status).toBe(200)
    expect(res.body.trucks).toEqual([
      { id: 'k-2', unitNumber: '3', eld: false, holder: 'Driver B', yours: false },
      // ELD source says motive but there is no vehicle number: not wired.
      { id: 'k-3', unitNumber: '4', eld: false, holder: null, yours: false },
      { id: 'k-1', unitNumber: '12', eld: true, holder: 'Driver A', yours: true },
    ])
  })
})

describe('POST /me/truck', () => {
  beforeEach(() => {
    tables['Equipment-test'] = {
      'k-1': { id: 'k-1', type: 'truck', unitNumber: '12', active: true },
      'k-2': { id: 'k-2', type: 'truck', unitNumber: '14', active: true, assignedDriverId: DRIVER_A_ID },
      'k-off': { id: 'k-off', type: 'truck', unitNumber: '15', active: false },
      'tr-1': { id: 'tr-1', type: 'trailer', unitNumber: '9001', active: true },
    }
    tables['Driver-test'][DRIVER_A_ID].assignedTruckId = 'k-2'
    tables['Driver-test'][DRIVER_B_ID].assignedTruckId = 'k-1'
  })

  it('refuses a missing id, an unknown truck, an inactive truck and a trailer id, writing nothing', async () => {
    expect((await call('/me/truck', 'POST', {})).status).toBe(400)
    for (const truckId of ['nope', 'k-off', 'tr-1']) {
      expect((await call('/me/truck', 'POST', { truckId })).status).toBe(404)
    }
    expect(tables['Driver-test'][DRIVER_A_ID].assignedTruckId).toBe('k-2')
    expect(tables['Equipment-test']['k-2'].assignedDriverId).toBe(DRIVER_A_ID)
  })

  it('assigns on both sides, takes the truck from its previous holder and frees the one this driver had', async () => {
    const res = await call('/me/truck', 'POST', { truckId: 'k-1' })
    expect(res.status).toBe(200)
    expect(res.body.truck).toEqual({ id: 'k-1', unitNumber: '12' })
    expect(tables['Driver-test'][DRIVER_A_ID].assignedTruckId).toBe('k-1')
    expect(tables['Equipment-test']['k-1'].assignedDriverId).toBe(DRIVER_A_ID)
    expect(tables['Driver-test'][DRIVER_B_ID].assignedTruckId).toBeNull()
    expect(tables['Equipment-test']['k-2'].assignedDriverId).toBeNull()
  })
})

describe('POST /me/trailer', () => {
  beforeEach(() => {
    tables['Equipment-test'] = { 'tr-1': { id: 'tr-1', type: 'trailer', unitNumber: '9001', active: true } }
  })

  it('is a driver-file change only: no Load row is touched, so nothing reaches a shipment from it', async () => {
    tables['Load-test'] = { 'load-1': shipmentLoad(FUTURE) }
    const before = structuredClone(loadRow())
    const res = await call('/me/trailer', 'POST', { trailerId: 'tr-1' })
    expect(res.status).toBe(200)
    expect(tables['Driver-test'][DRIVER_A_ID]).toMatchObject({ assignedTrailerId: 'tr-1', bobtail: false })
    expect(loadRow()).toEqual(before)
  })

  it('refuses a truck id and clears to bobtail on an empty id', async () => {
    tables['Equipment-test']['k-1'] = { id: 'k-1', type: 'truck', unitNumber: '12', active: true }
    expect((await call('/me/trailer', 'POST', { trailerId: 'k-1' })).status).toBe(404)
    expect((await call('/me/trailer', 'POST', { trailerId: '' })).status).toBe(200)
    expect(tables['Driver-test'][DRIVER_A_ID]).toMatchObject({ assignedTrailerId: null, bobtail: true })
  })
})

describe('POST /paperwork/stop-event', () => {
  const post = (body: Row) => call('/paperwork/stop-event', 'POST', body)

  beforeEach(() => {
    tables['Load-test'] = { 'load-1': shipmentLoad(PAST), 'load-b': shipmentLoad(PAST, { id: 'load-b', pickupDriverId: DRIVER_B_ID, deliveryDriverId: DRIVER_B_ID, stops: [{ id: 'b-p', type: 'pickup', sequence: 0, driverId: DRIVER_B_ID }] }) }
  })

  it('validates the request before reading anything', async () => {
    expect((await post({ stopId: 'st-p', event: 'ARRIVED' })).status).toBe(400)
    expect((await post({ loadId: 'load-1', event: 'ARRIVED' })).status).toBe(400)
    const bad = await post({ loadId: 'load-1', stopId: 'st-p', event: 'LOITERED' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('ARRIVED or DEPARTED')
  })

  it("answers 404, leaking nothing, for another driver's load and for a stop that is not on the load", async () => {
    expect((await post({ loadId: 'load-b', stopId: 'b-p', event: 'ARRIVED' })).status).toBe(404)
    expect((await post({ loadId: 'nope', stopId: 'st-p', event: 'ARRIVED' })).status).toBe(404)
    expect((await post({ loadId: 'load-1', stopId: 'st-x', event: 'ARRIVED' })).status).toBe(404)
    expect(loadRow('load-b').stops).toEqual([{ id: 'b-p', type: 'pickup', sequence: 0, driverId: DRIVER_B_ID }])
  })

  it('stamps the arrival on the stop and credits the driver on the Load row, touching no other stop', async () => {
    const res = await post({ loadId: 'load-1', stopId: 'st-p', event: 'arrived' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, loadId: 'load-1', stopId: 'st-p', event: 'ARRIVED' })
    const stops = loadRow().stops as Array<Row>
    expect(stops[0].arrivedAt).toBe(res.body.at)
    expect(stops[1].arrivedAt ?? null).toBeNull()
    expect(loadRow().updatedBy).toBe(EMAIL_A)
    expect(loadRow().trailerNumber).toBeUndefined()
  })

  it('records the trailer only when leaving a pickup, trimmed to 20 characters', async () => {
    await post({ loadId: 'load-1', stopId: 'st-p', event: 'ARRIVED', trailer: '5302' })
    expect(loadRow().trailerNumber).toBeUndefined()
    const res = await post({ loadId: 'load-1', stopId: 'st-p', event: 'DEPARTED', trailer: `  ${'T'.repeat(30)}  ` })
    expect(res.status).toBe(200)
    expect(loadRow().trailerNumber).toBe('T'.repeat(20))
  })

  it('holds a delivery departure until the POD is on file, then lets it through', async () => {
    const held = await post({ loadId: 'load-1', stopId: 'st-d', event: 'DEPARTED' })
    expect(held.status).toBe(409)
    expect(held.body.needsPod).toBe(true)
    expect((loadRow().stops as Array<Row>)[1].departedAt ?? null).toBeNull()

    tables['DriverSubmission-test']['sub-1'] = { id: 'sub-1', driverId: DRIVER_A_ID, loadId: 'load-1', referenceNumber: '20001' }
    tables['DriverSubmissionDoc-test']['doc-1'] = { id: 'doc-1', submissionId: 'sub-1', driverId: DRIVER_A_ID, kind: 'POD' }
    expect((await post({ loadId: 'load-1', stopId: 'st-d', event: 'DEPARTED' })).status).toBe(200)
    expect((loadRow().stops as Array<Row>)[1].departedAt).toBeTruthy()
  })
})

describe('POST /paperwork/paperwork-location', () => {
  const post = (body: Row) => call('/paperwork/paperwork-location', 'POST', body)

  beforeEach(() => {
    tables['Load-test'] = { 'load-1': shipmentLoad(PAST) }
  })

  it('asks where the paperwork is when the answer is missing or not a place', async () => {
    expect((await post({ kind: 'SHED' })).status).toBe(400)
    expect((await post({ loadId: 'load-1', kind: 'GLOVEBOX' })).status).toBe(400)
    expect((await post({ loadId: 'load-1', confirm: 'MAYBE' })).status).toBe(400)
    expect(loadRow().paperworkLocation).toBeUndefined()
  })

  it('refuses a load that is not this driver\'s', async () => {
    tables['Load-test']['load-b'] = shipmentLoad(PAST, { id: 'load-b', pickupDriverId: DRIVER_B_ID, deliveryDriverId: DRIVER_B_ID, stops: [{ id: 'b-p', type: 'pickup', sequence: 0, driverId: DRIVER_B_ID }] })
    expect((await post({ loadId: 'load-b', kind: 'SHED' })).status).toBe(404)
    expect(loadRow('load-b').paperworkLocation).toBeUndefined()
  })

  it('files the place with who and when, then the next driver\'s in-hand answer keeps the place', async () => {
    const filed = await post({ loadId: 'load-1', kind: 'TRAILER', unit: '5302' })
    expect(filed.status).toBe(200)
    expect(loadRow().paperworkLocation).toMatchObject({ kind: 'TRAILER', unit: '5302', byDriverId: DRIVER_A_ID, byName: 'Driver A' })

    const have = await post({ loadId: 'load-1', confirm: 'have' })
    expect(have.status).toBe(200)
    expect(loadRow().paperworkLocation).toMatchObject({ kind: 'TRAILER', unit: '5302', inHandBy: 'Driver A', missingAt: null })
  })
})

describe('GET /loads/current', () => {
  it('is an empty rest state when the driver has nothing open', async () => {
    tables['Load-test'] = { 'load-b': shipmentLoad(FUTURE, { id: 'load-b', pickupDriverId: DRIVER_B_ID, deliveryDriverId: DRIVER_B_ID, stops: [{ id: 'b-p', type: 'pickup', sequence: 0, driverId: DRIVER_B_ID }] }), 'load-old': shipmentLoad(PAST, { id: 'load-old' }) }
    const res = await call('/loads/current')
    expect(res).toEqual({ status: 200, body: { load: null } })
  })

  it('shows the soonest open load with its lane, PRO and what still blocks invoicing, and nothing money-shaped', async () => {
    tables['Load-test'] = {
      'load-1': shipmentLoad(FUTURE, { rate: 123400, rateConfirmKey: 'rate-confirms/load-1/rc.pdf' }),
      'load-later': shipmentLoad({ pickup: '2036-04-10T14:00:00Z', delivery: '2036-04-11T14:00:00Z' }, { id: 'load-later', aljexId: '20002' }),
    }
    tables['PodDocument-test']['pod-1'] = { id: 'pod-1', loadId: 'load-1', processingStatus: 'READY' }
    const res = await call('/loads/current')
    expect(res.status).toBe(200)
    expect(res.body.load).toEqual({
      id: 'load-1',
      proNumber: '20001',
      lane: 'Joliet, IL → Mesa, AZ',
      originCity: 'Joliet, IL',
      destinationCity: 'Mesa, AZ',
      pickupAppt: FUTURE.pickup,
      deliveryAppt: FUTURE.delivery,
      customer: 'Acme Test Co',
      hasRateConfirmation: true,
      hasPod: true,
    })
    expect(JSON.stringify(res.body)).not.toContain('123400')
  })
})

// ── Two-way consistency: shipment <-> Load <-> driver app ────────────────────

/** The projector, on its own in-memory tables, fed the same Load rows the handler just wrote. */
function projectorHarness() {
  const db = new FakeDynamo()
  db.seed(TABLES.shipment, { __typename: 'Shipment', id: 'ship-1', number: '20001', status: 'DISPATCHED', version: 1, searchKey: '20001 acme test co' })
  db.seed(TABLES.order, { __typename: 'Order', id: 'order-1', shipmentId: 'ship-1', updatedAt: '2026-10-01T00:00:00.000Z' })
  const deps: ProjectorDeps = {
    store: { db: db as unknown as DynamoDBClient, tables: TABLES, now: () => '2026-10-05T16:00:00.000Z' },
    checkCallTable: CHECK_CALL_TABLE,
    drivers: async () => buildDriverRoster([{ id: DRIVER_A_ID, email: EMAIL_A }]),
  }
  /** Run the stream record for whatever the handler just did to `load-1`, then keep the projector's own writes. */
  async function relay(before: Row) {
    const after = structuredClone(loadRow())
    db.seed(TABLES.load, after)
    const summary = await projectLoadStream({
      Records: [{ eventName: 'MODIFY', dynamodb: { NewImage: marshall(after, { removeUndefinedValues: true }), OldImage: marshall(before, { removeUndefinedValues: true }) } }],
    }, deps)
    tables['Load-test']['load-1'] = structuredClone(db.get(TABLES.load, 'load-1') as Row)
    return summary
  }
  const shipment = () => db.get(TABLES.shipment, 'ship-1') as Row
  const references = () => ((db.get(TABLES.order, 'order-1') as Row).references ?? []) as Array<{ code: string; value: string }>
  return { db, relay, shipment, references }
}

describe('a driver change shows on the shipment', () => {
  it('walks a run: pickup, trailer, paperwork place, delivery; the shipment, its order and the load agree at every step', async () => {
    tables['Load-test'] = { 'load-1': shipmentLoad(PAST) }
    const p = projectorHarness()
    const step = async (path: string, body: Row) => {
      const before = structuredClone(loadRow())
      const res = await call(path, 'POST', body)
      expect(res.status).toBe(200)
      return p.relay(before)
    }

    // Arrive at the pickup: the arrival is logged, the shipment moves off DISPATCHED.
    const arrived = await step('/paperwork/stop-event', { loadId: 'load-1', stopId: 'st-p', event: 'ARRIVED' })
    expect(arrived).toMatchObject({ events: 1, statusWrites: 1 })
    expect(p.shipment().status).toBe(loadRow().status)
    expect(p.shipment().status).not.toBe('DISPATCHED')

    // Leave the pickup naming the trailer: IN_TRANSIT everywhere, trailer on the order.
    const departed = await step('/paperwork/stop-event', { loadId: 'load-1', stopId: 'st-p', event: 'DEPARTED', trailer: '5302' })
    expect(departed).toMatchObject({ events: 1, statusWrites: 1, mirrored: 1 })
    expect(loadRow()).toMatchObject({ status: 'IN_TRANSIT', trailerNumber: '5302' })
    expect(p.shipment().status).toBe('IN_TRANSIT')
    expect(p.references()).toEqual([expect.objectContaining({ code: 'TRAILER_NUMBER', value: '5302' })])
    expect(String(p.shipment().searchKey)).toContain('5302')

    // Paperwork put in the trailer: another reference, no status movement.
    const filed = await step('/paperwork/paperwork-location', { loadId: 'load-1', kind: 'TRAILER', unit: '5302' })
    expect(filed).toMatchObject({ events: 0, statusWrites: 0, mirrored: 1 })
    expect(p.references().map((r) => `${r.code}=${r.value}`).sort()).toEqual(['PAPERWORK_LOCATION=In trailer 5302', 'TRAILER_NUMBER=5302'])

    // The driver confirming the paperwork is in hand changes no place: nothing to mirror.
    const inHand = await step('/paperwork/paperwork-location', { loadId: 'load-1', confirm: 'HAVE' })
    expect(inHand).toMatchObject({ considered: 0, mirrored: 0 })

    // Delivery: POD on file, arrival and departure stamped, the shipment lands DELIVERED with its time.
    tables['DriverSubmission-test']['sub-1'] = { id: 'sub-1', driverId: DRIVER_A_ID, loadId: 'load-1', referenceNumber: '20001' }
    tables['DriverSubmissionDoc-test']['doc-1'] = { id: 'doc-1', submissionId: 'sub-1', driverId: DRIVER_A_ID, kind: 'POD' }
    await step('/paperwork/stop-event', { loadId: 'load-1', stopId: 'st-d', event: 'ARRIVED' })
    await step('/paperwork/stop-event', { loadId: 'load-1', stopId: 'st-d', event: 'DEPARTED' })
    const stops = loadRow().stops as Array<Row>
    expect(loadRow().status).toBe('DELIVERED')
    expect(p.shipment()).toMatchObject({ status: 'DELIVERED', deliveredAt: stops[1].departedAt })
    // Every arrival and departure is one tracking row, credited to the driver app.
    const events = [...p.db.table(CHECK_CALL_TABLE).values()]
    expect(events).toHaveLength(4)
    expect(events.every((e) => e.source === 'DRIVER_APP' && e.createdBy === `driver:${DRIVER_A_ID}`)).toBe(true)
  })

  it('a reorder moves sortOrder on the Load for the calendar and leaves the shipment alone', async () => {
    tables['Load-test'] = {
      'load-1': shipmentLoad(PAST, { sortOrder: 1, stops: [{ id: 'st-p', type: 'pickup', sequence: 0, appt: PAST.pickup, driverId: DRIVER_A_ID }] }),
      'load-2': shipmentLoad(PAST, { id: 'load-2', shipmentId: undefined, orderId: undefined, sortOrder: 2, stops: [{ id: 'l2-p', type: 'pickup', sequence: 0, appt: PAST.pickup, driverId: DRIVER_A_ID }] }),
    }
    const p = projectorHarness()
    const before = structuredClone(loadRow())
    const res = await call('/paperwork/reorder', 'POST', { date: PAST.day, loadIds: ['load-2', 'load-1'] })
    expect(res.status).toBe(200)
    expect(loadRow().sortOrder).toBe(2)
    expect(loadRow('load-2').sortOrder).toBe(1)

    const summary = await p.relay(before)
    expect(summary).toMatchObject({ considered: 0, events: 0, mirrored: 0 })
    expect(p.db.writes).toEqual([])
    expect(p.shipment()).toMatchObject({ status: 'DISPATCHED', version: 1 })
  })
})

describe('a shipment edit shows on what the driver app and the dispatch board read', () => {
  /**
   * What UPDATE_STOP / SET_APPT leaves on the Load: the new stops plus the legacy mirror
   * columns derived from them (the same `deriveLegacyFields` the calendar and the board read).
   */
  function editDeliveryAppt(appt: string) {
    const load = loadRow()
    const stops = (load.stops as Stop[]).map((s) => (s.type === 'delivery' ? { ...s, appt } : s))
    Object.assign(load, { stops, ...deriveLegacyFields(stops), updatedBy: 'dispatch@example.com' })
  }

  it('moves the delivery appointment the driver sees on /loads/current and /paperwork, and the shipment mirror agrees', async () => {
    tables['Load-test'] = { 'load-1': shipmentLoad(FUTURE) }
    const moved = '2036-03-12T09:30:00Z'
    editDeliveryAppt(moved)

    expect((await call('/loads/current')).body.load).toMatchObject({ id: 'load-1', deliveryAppt: moved, pickupAppt: FUTURE.pickup })
    expect(shipmentMirrors([loadRow()])).toMatchObject({ pickupAppt: FUTURE.pickup, deliveryAppt: moved, originCity: 'Joliet, IL', destinationCity: 'Mesa, AZ' })
  })

  it('puts the edited stop on the paperwork day sheet', async () => {
    tables['Load-test'] = { 'load-1': shipmentLoad(PAST) }
    const moved = '2026-10-06T20:00:00Z'
    editDeliveryAppt(moved)

    const res = await call('/paperwork', 'GET', undefined, { week: PAST.week })
    expect(res.status).toBe(200)
    const mine = (res.body.loads as Array<Row>).find((l) => l.id === 'load-1')
    expect(mine).toBeTruthy()
    const delivery = (mine?.stops as Array<Row>).find((s) => s.id === 'st-d')
    expect(delivery?.appt).toBe(moved)
  })

  it('a shipment edit made after the driver stamped an arrival keeps the stamp, so the next projector pass sees no new event', async () => {
    tables['Load-test'] = { 'load-1': shipmentLoad(PAST) }
    const p = projectorHarness()
    const before = structuredClone(loadRow())
    await call('/paperwork/stop-event', 'POST', { loadId: 'load-1', stopId: 'st-p', event: 'ARRIVED' })
    await p.relay(before)
    const stamped = (loadRow().stops as Array<Row>)[0].arrivedAt

    const beforeEdit = structuredClone(loadRow())
    editDeliveryAppt('2026-10-07T12:00:00Z')
    expect((loadRow().stops as Array<Row>)[0].arrivedAt).toBe(stamped)
    p.db.writes.length = 0
    const summary = await p.relay(beforeEdit)
    expect(summary).toMatchObject({ considered: 0, events: 0, mirrored: 0 })
    expect(p.db.writes).toEqual([])
  })
})
