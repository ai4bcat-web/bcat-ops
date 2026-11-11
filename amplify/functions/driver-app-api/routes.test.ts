import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { ScanCommand, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
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
  DeleteCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
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
  process.env.MAINTENANCE_TASK_TABLE_NAME = 'MaintenanceTask-test'
  process.env.MOTIVE_API_KEY = 'motive-test-key'
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
    'MaintenanceTask-test': {},
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
    if (cmd instanceof DeleteCommand) {
      const id = input.Key?.id as string | undefined
      if (id && records) delete records[id]
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
    expect(res).toEqual({ status: 200, body: { load: null, alsoOpen: [] } })
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
    // The next open load rides along, so a second delivery today is not hidden behind the first.
    expect((res.body.alsoOpen as Array<{ id: string; proNumber: string }>).map((l) => [l.id, l.proNumber])).toEqual([['load-later', '20002']])
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

// ── The routes still without a handler test (MERGE_REGRESSION C-R3, C-R6, C-R13, C-R16, C-R17) ──

describe('GET and POST /maintenance-tasks', () => {
  beforeEach(() => {
    tables['Equipment-test'] = {
      'k-1': { id: 'k-1', type: 'truck', unitNumber: ' 12 ', active: true },
      'k-off': { id: 'k-off', type: 'truck', unitNumber: '15', active: false },
    }
    tables['Driver-test'][DRIVER_A_ID].assignedTruckId = 'k-1'
  })
  const tasks = () => Object.values(tables['MaintenanceTask-test'])

  it('refuses a report with no title, writing nothing', async () => {
    expect((await call('/maintenance-tasks', 'POST', { title: '   ' })).status).toBe(400)
    expect(tasks()).toEqual([])
  })

  it("files the report on the driver's own truck as an upcoming task tagged with who reported it", async () => {
    const res = await call('/maintenance-tasks', 'POST', { title: 'Brake light out', notes: ' left rear ', priority: 'urgent' })
    expect(res.status).toBe(200)
    expect(tasks()).toHaveLength(1)
    expect(tasks()[0]).toMatchObject({ equipmentId: 'k-1', title: 'Brake light out', priority: 'med', status: 'upcoming', autoDot: false })
    expect(String(tasks()[0].notes)).toContain('left rear')
    expect(String(tasks()[0].notes)).toContain(`[driver:${DRIVER_A_ID}]`)
    expect(res.body.task).toMatchObject({ title: 'Brake light out', priority: 'med', status: 'upcoming', truck: { id: 'k-1', unitNumber: '12' } })
  })

  it('keeps a high or low priority, and files against a picked truck instead of the assigned one', async () => {
    tables['Equipment-test']['k-2'] = { id: 'k-2', type: 'truck', unitNumber: '20', active: true }
    expect((await call('/maintenance-tasks', 'POST', { title: 'Tire', priority: 'high', truckId: 'k-2' })).status).toBe(200)
    expect(tasks()[0]).toMatchObject({ equipmentId: 'k-2', priority: 'high' })
  })

  it('tells the driver to pick a truck when none is assigned, or the picked one is inactive', async () => {
    delete tables['Driver-test'][DRIVER_A_ID].assignedTruckId
    expect((await call('/maintenance-tasks', 'POST', { title: 'Tire' })).status).toBe(400)
    expect((await call('/maintenance-tasks', 'POST', { title: 'Tire', truckId: 'k-off' })).status).toBe(400)
    expect(tasks()).toEqual([])
  })

  it('lists the truck\'s tasks, open first then newest first, flagging only this driver\'s own reports', async () => {
    tables['MaintenanceTask-test'] = {
      a: { id: 'a', equipmentId: 'k-1', title: 'Old open', status: 'upcoming', createdAt: '2026-10-01T00:00:00Z', notes: 'x' },
      b: { id: 'b', equipmentId: 'k-1', title: 'New open', status: 'upcoming', createdAt: '2026-10-05T00:00:00Z', notes: `y\n[driver:${DRIVER_A_ID}]` },
      c: { id: 'c', equipmentId: 'k-1', title: 'Done', status: 'completed', createdAt: '2026-10-09T00:00:00Z' },
      d: { id: 'd', equipmentId: 'other', title: 'Other truck', status: 'upcoming', createdAt: '2026-10-09T00:00:00Z' },
    }
    const res = await call('/maintenance-tasks')
    expect(res.status).toBe(200)
    const list = res.body.tasks as Array<Row>
    expect(list.map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(list.map((t) => t.reportedByMe)).toEqual([true, false, false])
    expect(list[0].priority).toBe('med')
  })

  it('is an empty list with no truck', async () => {
    delete tables['Driver-test'][DRIVER_A_ID].assignedTruckId
    expect((await call('/maintenance-tasks')).body).toEqual({ truck: null, tasks: [] })
  })
})

describe('Motive routes: GET /motive/day and GET /staff/motive-days', () => {
  const motiveResponse = (logs: unknown[], ok = true, status = 200) =>
    fetchMock.mockResolvedValue({ ok, status, json: async () => ({ logs }) } as unknown as Awaited<ReturnType<FetchLike>>)
  const log = (driverMotiveId: number, date: string, over: Row = {}) => ({
    log: {
      date, driving_duration: 7200, on_duty_duration: 1800, total_miles: 90, vehicle_numbers: [' 12 ', ''],
      driver: { id: driverMotiveId },
      events: [{ event: { type: 'driving', start_time: `${date}T13:00:00Z`, end_time: `${date}T15:00:00Z`, location: 'Joliet, IL' } }],
      ...over,
    },
  })

  describe('/motive/day', () => {
    it('refuses a bad date, and a driver who is not on the Ivan program', async () => {
      tables['Driver-test'][DRIVER_A_ID].motiveDriverId = 77
      expect((await call('/motive/day', 'GET', undefined, { date: 'yesterday' })).status).toBe(400)
      tables['Driver-test'][DRIVER_A_ID].ivanApp = false
      tables['Driver-test'][DRIVER_A_ID].fleetGroup = 'OWNER_OPERATOR'
      expect((await call('/motive/day', 'GET', undefined, { date: '2026-10-05' })).status).toBe(409)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('says so, without asking Motive, when no Motive account is linked', async () => {
      const res = await call('/motive/day', 'GET', undefined, { date: '2026-10-05' })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ linked: false, day: null })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("asks Motive for the linked id only and returns that day's hours", async () => {
      tables['Driver-test'][DRIVER_A_ID].motiveDriverId = 77
      motiveResponse([log(77, '2026-10-05')])
      const res = await call('/motive/day', 'GET', undefined, { date: '2026-10-05' })
      expect(res.status).toBe(200)
      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('driver_ids[]=77')
      expect(url).toContain('start_date=2026-10-05')
      expect(res.body).toMatchObject({ date: '2026-10-05', linked: true })
      expect(res.body.day).toMatchObject({ drivingSeconds: 7200, onDutySeconds: 1800, workedSeconds: 9000, vehicleNumbers: ['12'] })
    })

    it('is a day with nothing on it when Motive has no log, and a reason when Motive fails', async () => {
      tables['Driver-test'][DRIVER_A_ID].motiveDriverId = 77
      motiveResponse([])
      expect((await call('/motive/day', 'GET', undefined, { date: '2026-10-05' })).body).toMatchObject({ linked: true, day: null })
      motiveResponse([], false, 502)
      const down = await call('/motive/day', 'GET', undefined, { date: '2026-10-05' })
      expect(down.status).toBe(200)
      expect(down.body).toMatchObject({ linked: false, day: null })
      expect(String(down.body.reason)).toContain('502')
    })
  })

  describe('/staff/motive-days', () => {
    const staff = (email = 'ryne@bcatcorp.com') => mockVerify.mockResolvedValue({ email })
    const q = { driverIds: `${DRIVER_A_ID},${DRIVER_B_ID}`, from: '2026-10-05', to: '2026-10-06' }

    it('is never answered to a driver token, or to staff who may not impersonate', async () => {
      expect((await call('/staff/motive-days', 'GET', undefined, q)).status).toBe(403)
      staff('someone@bcatcorp.com')
      expect((await call('/staff/motive-days', 'GET', undefined, q)).status).toBe(403)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('validates the drivers and the dates', async () => {
      staff()
      expect((await call('/staff/motive-days', 'GET', undefined, { ...q, driverIds: ' , ' })).status).toBe(400)
      expect((await call('/staff/motive-days', 'GET', undefined, { ...q, from: '10/05' })).status).toBe(400)
    })

    it('returns each linked driver\'s days keyed by our driver id, and never guesses for an unlinked one', async () => {
      staff()
      tables['Driver-test'][DRIVER_A_ID].motiveDriverId = 77
      motiveResponse([log(77, '2026-10-05'), log(999, '2026-10-05')])
      const res = await call('/staff/motive-days', 'GET', undefined, q)
      expect(res.status).toBe(200)
      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('driver_ids[]=77')
      expect(url).not.toContain('999')
      expect(res.body.days).toEqual({
        [DRIVER_A_ID]: {
          '2026-10-05': { firstMoveAt: '2026-10-05T13:00:00Z', lastMoveAt: '2026-10-05T15:00:00Z', drivingSeconds: 7200, onDutySeconds: 1800, vehicles: ['12'] },
        },
      })
    })

    it('is an empty answer, not an error, when nobody is linked or Motive fails', async () => {
      staff()
      expect((await call('/staff/motive-days', 'GET', undefined, q)).body).toEqual({ days: {} })
      expect(fetchMock).not.toHaveBeenCalled()
      tables['Driver-test'][DRIVER_A_ID].motiveDriverId = 77
      motiveResponse([], false, 500)
      expect((await call('/staff/motive-days', 'GET', undefined, q)).body).toEqual({ days: {} })
    })
  })
})

describe('POST /paperwork/location-note-edit', () => {
  const edit = (body: Row) => call('/paperwork/location-note-edit', 'POST', body)
  const notes = () => tables['Location-test']['loc-1'].driverNotes as Row[]
  beforeEach(() => {
    tables['Location-test'] = {
      'loc-1': {
        id: 'loc-1',
        driverNotes: [
          { at: '2026-10-01T10:00:00Z', driverId: DRIVER_A_ID, by: 'Driver A', text: 'dock 4' },
          { at: '2026-10-02T10:00:00Z', driverId: DRIVER_B_ID, by: 'Driver B', text: 'gate code' },
        ],
      },
    }
  })

  it('validates the request', async () => {
    expect((await edit({ at: 'x', text: 'y' })).status).toBe(400)
    expect((await edit({ locationId: 'loc-1', text: 'y' })).status).toBe(400)
    expect((await edit({ locationId: 'loc-1', at: '2026-10-01T10:00:00Z', text: '  ' })).status).toBe(400)
    expect((await edit({ locationId: 'nope', at: 'x', text: 'y' })).status).toBe(404)
  })

  it("will not touch another driver's note, and says the same as for one that is gone", async () => {
    expect((await edit({ locationId: 'loc-1', at: '2026-10-02T10:00:00Z', text: 'hijacked' })).status).toBe(404)
    expect((await edit({ locationId: 'loc-1', at: '2026-10-02T10:00:00Z', remove: true })).status).toBe(404)
    expect((await edit({ locationId: 'loc-1', at: 'never', text: 'x' })).status).toBe(404)
    expect(notes().map((n) => n.text)).toEqual(['dock 4', 'gate code'])
  })

  it('rewrites the driver\'s own note, trimmed and capped at 1000 characters, leaving the others', async () => {
    const res = await edit({ locationId: 'loc-1', at: '2026-10-01T10:00:00Z', text: `  ${'x'.repeat(1200)}  ` })
    expect(res.status).toBe(200)
    expect(String(notes()[0].text)).toHaveLength(1000)
    expect(notes()[1].text).toBe('gate code')
    expect((res.body.notes as Row[]).map((n) => n.mine)).toEqual([true, false])
  })

  it('removes the driver\'s own note', async () => {
    const res = await edit({ locationId: 'loc-1', at: '2026-10-01T10:00:00Z', remove: true })
    expect(res.status).toBe(200)
    expect(notes().map((n) => n.text)).toEqual(['gate code'])
    expect(res.body.notes).toEqual([{ at: '2026-10-02T10:00:00Z', by: 'Driver B', text: 'gate code', mine: false }])
  })
})

describe('submission upload and document routes', () => {
  const page = { fileName: 'bol.jpg', contentType: 'image/jpeg', byteSize: 1000 }
  const sub = () => tables['DriverSubmission-test']['sub-1']
  beforeEach(() => {
    tables['DriverSubmission-test'] = {
      'sub-1': {
        id: 'sub-1', driverId: DRIVER_A_ID, status: 'NEW', referenceNumber: '20001',
        pendingUploads: { POD: [{ fileName: 'p1.jpg', contentType: 'image/jpeg', byteSize: 10, s3Key: 'driver-docs/drv-a/sub-1/POD/1-1.jpg' }] },
        combinedPodKey: 'driver-docs/drv-a/sub-1/POD/combined.pdf',
      },
      'sub-b': { id: 'sub-b', driverId: DRIVER_B_ID, status: 'NEW', combinedPodKey: 'secret.pdf' },
    }
    tables['DriverSubmissionDoc-test'] = {
      'doc-raw': { id: 'doc-raw', submissionId: 'sub-1', driverId: DRIVER_A_ID, kind: 'POD', s3Key: 'raw.jpg', scanStatus: 'PENDING' },
      'doc-ready': { id: 'doc-ready', submissionId: 'sub-1', driverId: DRIVER_A_ID, kind: 'POD', s3Key: 'raw2.jpg', scanStatus: 'READY', enhancedKey: 'clean2.jpg' },
      'doc-misc': { id: 'doc-misc', submissionId: 'sub-1', driverId: DRIVER_A_ID, kind: 'MISC', s3Key: 'misc.jpg' },
      'doc-b': { id: 'doc-b', submissionId: 'sub-b', driverId: DRIVER_B_ID, kind: 'POD', s3Key: 'b.jpg' },
    }
    let n = 0
    mockGetSignedUrl.mockImplementation(async () => `https://s3.test/presigned-${++n}`)
  })
  const signedKey = () => (mockGetSignedUrl.mock.calls[0][1] as { input: { Key: string } }).input.Key

  describe('POST /submissions/:id/pod', () => {
    it('validates the pages before anything is signed', async () => {
      expect((await call('/submissions/sub-1/pod', 'POST', { pages: [] })).status).toBe(400)
      expect((await call('/submissions/sub-1/pod', 'POST', { pages: [{ ...page, contentType: 'text/html', fileName: 'x.html' }] })).status).toBe(400)
      expect((await call('/submissions/sub-1/pod', 'POST', { pages: [{ ...page, byteSize: 0 }] })).status).toBe(400)
      expect(mockGetSignedUrl).not.toHaveBeenCalled()
    })

    it("answers 404 for another driver's submission and for one that does not exist, signing nothing", async () => {
      expect((await call('/submissions/sub-b/pod', 'POST', { pages: [page] })).status).toBe(404)
      expect((await call('/submissions/nope/pod', 'POST', { pages: [page] })).status).toBe(404)
      expect(mockGetSignedUrl).not.toHaveBeenCalled()
    })

    it('signs an upload per page under the driver and submission, and appends the pages to the pending POD list', async () => {
      const res = await call('/submissions/sub-1/pod', 'POST', { pages: [page, { ...page, contentType: 'application/pdf', fileName: 'b.pdf' }] })
      expect(res.status).toBe(200)
      const uploads = res.body.uploads as Array<{ pageNumber: number; s3Key: string }>
      expect(uploads.map((u) => u.pageNumber)).toEqual([1, 2])
      expect(uploads[0].s3Key).toMatch(/^driver-docs\/drv-a\/sub-1\/POD\/\d+-1\.jpg$/)
      expect(uploads[1].s3Key).toMatch(/-2\.pdf$/)
      const pending = (sub().pendingUploads as { POD: Row[] }).POD
      expect(pending.map((p) => p.s3Key)).toEqual(['driver-docs/drv-a/sub-1/POD/1-1.jpg', uploads[0].s3Key, uploads[1].s3Key])
    })
  })

  describe('GET /submissions/:id/uploads', () => {
    it('needs a document kind, and only serves the owner', async () => {
      expect((await call('/submissions/sub-1/uploads')).status).toBe(400)
      expect((await call('/submissions/sub-b/uploads', 'GET', undefined, { kind: 'POD' })).status).toBe(404)
    })

    it('re-signs the pages already pending, so a retry can PUT them again', async () => {
      const res = await call('/submissions/sub-1/uploads', 'GET', undefined, { kind: 'POD' })
      expect(res.status).toBe(200)
      expect(res.body.uploads).toEqual([{ pageNumber: 1, url: 'https://s3.test/presigned-1', s3Key: 'driver-docs/drv-a/sub-1/POD/1-1.jpg' }])
      expect((await call('/submissions/sub-1/uploads', 'GET', undefined, { kind: 'RATECON' })).body.uploads).toEqual([])
    })
  })

  describe('GET /submissions/:id/doc/:docId/url', () => {
    const url = (id: string, doc: string) => call(`/submissions/${id}/doc/${doc}/url`)

    it('serves the original until the cleaned copy is READY, then the cleaned one', async () => {
      expect((await url('sub-1', 'doc-raw')).body).toEqual({ url: 'https://s3.test/presigned-1' })
      expect(signedKey()).toBe('raw.jpg')
      mockGetSignedUrl.mockClear()
      await url('sub-1', 'doc-ready')
      expect(signedKey()).toBe('clean2.jpg')
    })

    it('serves the merged PDF for combined-POD, and 404 for one that was never built', async () => {
      expect((await url('sub-1', 'combined-POD')).status).toBe(200)
      expect(signedKey()).toBe('driver-docs/drv-a/sub-1/POD/combined.pdf')
      expect((await url('sub-1', 'combined-RATECON')).status).toBe(404)
    })

    it("never opens another driver's document, or a real document through the wrong submission", async () => {
      expect((await url('sub-b', 'doc-b')).status).toBe(404)
      expect((await url('sub-1', 'doc-b')).status).toBe(404)
      expect((await url('sub-b', 'combined-POD')).status).toBe(404)
      expect((await url('sub-1', 'nope')).status).toBe(404)
      expect(mockGetSignedUrl).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /submissions/:id/docs', () => {
    const del = (id: string, kind?: string) => call(`/submissions/${id}/docs`, 'DELETE', undefined, kind ? { kind } : undefined)

    it('needs a kind and the owner', async () => {
      expect((await del('sub-1')).status).toBe(400)
      expect((await del('sub-b', 'POD')).status).toBe(404)
      expect(Object.keys(tables['DriverSubmissionDoc-test'])).toHaveLength(4)
      expect(tables['DriverSubmission-test']['sub-b'].combinedPodKey).toBe('secret.pdf')
    })

    it('removes only this driver\'s documents of that kind and drops the merged-PDF pointer, leaving S3 alone', async () => {
      const res = await del('sub-1', 'POD')
      expect(res).toMatchObject({ status: 200, body: { removed: 2 } })
      expect(Object.keys(tables['DriverSubmissionDoc-test']).sort()).toEqual(['doc-b', 'doc-misc'])
      expect(sub().combinedPodKey).toBeUndefined()
      expect(mockS3Send).not.toHaveBeenCalled()
    })

    it('leaves the merged-PDF pointer alone when the removed pages are photos', async () => {
      expect((await del('sub-1', 'MISC')).body).toEqual({ removed: 1 })
      expect(sub().combinedPodKey).toBe('driver-docs/drv-a/sub-1/POD/combined.pdf')
    })
  })
})
