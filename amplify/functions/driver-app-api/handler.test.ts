import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import type * as HandlerModule from './handler'

const mockVerify = vi.hoisted(() => vi.fn())
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({ verify: mockVerify }),
  },
}))

const mockGetSignedUrl = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mockGetSignedUrl }))

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

vi.mock('@aws-sdk/client-dynamodb', () => ({
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
  process.env.DRIVER_USER_POOL_ID = 'us-east-1_testpool'
  process.env.DRIVER_USER_POOL_CLIENT_ID = 'test-client-id'
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
  process.env.INTAKE_IVAN_CHANNEL_ID = 'C0B4YJXLYM8'
  process.env.LOADS_EMAIL_TO = 'ivanloads@bcatcorp.com'
  process.env.SES_FROM_ADDRESS = 'onboarding@bcatcorp.com'
  process.env.AWS_REGION = 'us-east-1'
})

class ConditionalCheckFailedException extends Error {
  name = 'ConditionalCheckFailedException'
}

function resolvePath(path: string, names: Record<string, string>): string[] {
  return path
    .split('.')
    .map((part) => (part.startsWith('#') ? names[part] ?? part : part))
}

function getPath(obj: Record<string, unknown>, path: string, names: Record<string, string>): unknown {
  const parts = resolvePath(path, names)
  let current: unknown = obj
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setPath(obj: Record<string, unknown>, path: string, names: Record<string, string>, value: unknown) {
  const parts = resolvePath(path, names)
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function deletePath(obj: Record<string, unknown>, path: string, names: Record<string, string>) {
  const parts = resolvePath(path, names)
  let current: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!current || typeof current !== 'object') return
    current = (current as Record<string, unknown>)[part]
  }
  if (current && typeof current === 'object') {
    delete (current as Record<string, unknown>)[parts[parts.length - 1]]
  }
}

function applyUpdateExpression(
  rec: Record<string, unknown>,
  expr: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
) {
  if (!expr.trim()) throw new Error('UpdateExpression is empty')

  // Reject unbound or undefined value references like DynamoDB would.
  for (const ref of Array.from(new Set(expr.match(/:\w+/g) ?? []))) {
    if (!(ref in values)) throw new Error(`UpdateExpression references unbound value ${ref}`)
    if (values[ref] === undefined) throw new Error(`UpdateExpression references undefined value ${ref}`)
  }
  // Reject unbound name references.
  for (const ref of Array.from(new Set(expr.match(/#\w+/g) ?? []))) {
    if (!(ref in names)) throw new Error(`UpdateExpression references unbound name ${ref}`)
  }

  const clauses = Array.from(expr.matchAll(/(SET|REMOVE)\s+([^]*?)(?=\s*(?:SET|REMOVE)\s|$)/gi))
  for (const clause of clauses) {
    const action = (clause[1] as string).toUpperCase()
    const body = (clause[2] as string).trim()
    if (!body) continue
    const assignments = splitAssignments(body)
    for (const assignment of assignments) {
      const trimmed = assignment.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf('=')
      if (action === 'REMOVE' && eq < 0) {
        deletePath(rec, trimmed, names)
        continue
      }
      if (eq < 0) continue
      const lhs = trimmed.slice(0, eq).trim()
      const rhs = trimmed.slice(eq + 1).trim()
      if (action === 'SET') {
        const value = evaluateRhs(rhs, rec, names, values)
        setPath(rec, lhs, names, value)
      }
    }
  }
}

function splitAssignments(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(body.slice(start).trim())
  return out.filter(Boolean)
}

function evaluateRhs(
  rhs: string,
  rec: Record<string, unknown>,
  names: Record<string, string>,
  values: Record<string, unknown>,
): unknown {
  rhs = rhs.trim()
  if (rhs.startsWith(':')) return values[rhs]
  const listAppend = rhs.match(/^list_append\s*\(\s*if_not_exists\s*\(\s*([^,]+)\s*,\s*(:\w+)\s*\)\s*,\s*(:\w+)\s*\)$/i)
  if (listAppend) {
    const existing = getPath(rec, listAppend[1], names) as unknown[] | undefined
    const empty = values[listAppend[2]] as unknown[] | undefined
    const appended = values[listAppend[3]] as unknown[]
    return [...(existing ?? empty ?? []), ...appended]
  }
  return rhs
}

const DRIVER_A_ID = 'drv-a'
const DRIVER_B_ID = 'drv-b'
const DRIVER_C_ID = 'drv-c'
const EMAIL_A = 'driver.a@example.com'
const EMAIL_B = 'driver.b@example.com'
const EMAIL_C = 'driver.c@example.com'
const SUBMISSION_A = 'sub-a-1'
const SUBMISSION_B = 'sub-b-1'
const DOC_A = 'doc-a-1'

let handler: typeof HandlerModule.handler
let token: string

beforeAll(async () => {
  const mod = await import('./handler')
  handler = mod.handler
  token = 'valid-token'
})

function baseEvent(
  rawPath: string,
  method = 'GET',
  overrides: {
    body?: unknown
    auth?: boolean
    query?: Record<string, string>
  } = {},
): Parameters<typeof handler>[0] {
  const headers: Record<string, string> = {}
  if (overrides.auth !== false) {
    headers.authorization = `Bearer ${token}`
  }
  return {
    rawPath,
    requestContext: { http: { method } },
    queryStringParameters: overrides.query,
    headers,
    body: overrides.body === undefined ? null : JSON.stringify(overrides.body),
  }
}

function defaultTables(): Record<string, Record<string, Record<string, unknown>>> {
  return {
    'Driver-test': {
      [DRIVER_A_ID]: { id: DRIVER_A_ID, name: 'Driver A', active: true, email: EMAIL_A },
      [DRIVER_B_ID]: { id: DRIVER_B_ID, name: 'Driver B', active: true, email: EMAIL_B },
      [DRIVER_C_ID]: { id: DRIVER_C_ID, name: 'Driver C', active: true, email: EMAIL_C },
    },
    'DriverPaySetting-test': {
      'set-a': {
        id: 'set-a',
        driverId: DRIVER_A_ID,
        active: true,
        payGroup: 'AMAZON',
        payPercent: 0.88,
        expensesBeforePercent: false,
        email: EMAIL_A,
        fuelCardNumber: '123',
      },
      'set-b': {
        id: 'set-b',
        driverId: DRIVER_B_ID,
        active: true,
        payGroup: 'AMAZON',
        payPercent: 0.85,
        expensesBeforePercent: false,
        email: EMAIL_B,
        fuelCardNumber: '456',
      },
      'set-c': {
        id: 'set-c',
        driverId: DRIVER_C_ID,
        active: true,
        payGroup: 'OWNER_OPERATOR',
        payPercent: 0.88,
        expensesBeforePercent: false,
        email: EMAIL_C,
        fuelCardNumber: '789',
      },
    },
    'DriverSubmission-test': {
      [SUBMISSION_A]: {
        id: SUBMISSION_A,
        driverId: DRIVER_A_ID,
        driverName: 'Driver A',
        status: 'NEW',
        referenceNumber: 'VRID-1',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        pendingUploads: {
          RATECON: [
            {
              fileName: 'rc.jpg',
              contentType: 'image/jpeg',
              byteSize: 1000,
              s3Key: 'driver-docs/drv-a/sub-a-1/RATECON/1-1.jpg',
            },
          ],
        },
      },
      [SUBMISSION_B]: {
        id: SUBMISSION_B,
        driverId: DRIVER_B_ID,
        driverName: 'Driver B',
        status: 'NEW',
        referenceNumber: 'VRID-B',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        pendingUploads: { RATECON: [] },
      },
    },
    'DriverSubmissionDoc-test': {
      [DOC_A]: {
        id: DOC_A,
        submissionId: SUBMISSION_A,
        driverId: DRIVER_A_ID,
        kind: 'RATECON',
        s3Key: 'driver-docs/drv-a/sub-a-1/RATECON/1-1.jpg',
        fileName: 'rc.jpg',
        contentType: 'image/jpeg',
        byteSize: 1000,
        pageNumber: 1,
        uploadedAt: '2026-09-01T00:00:00.000Z',
      },
    },
    'AmazonTrip-test': {
      'amz-a-1': {
        id: 'amz-a-1',
        driverId: DRIVER_A_ID,
        periodStart: '2026-09-20',
        shipmentDate: '2026-09-21',
        freightAmount: 1000,
        loadId: 'AMZ-1',
        origin: 'Joliet, IL',
        destination: 'Indianapolis, IN',
        miles: 180,
        sortOrder: 1,
      },
      'amz-a-2': {
        id: 'amz-a-2',
        driverId: DRIVER_A_ID,
        periodStart: '2026-09-27',
        shipmentDate: '2026-09-28',
        freightAmount: 500,
        loadId: 'AMZ-2',
        origin: 'Joliet, IL',
        destination: 'Columbus, OH',
        miles: 120,
        sortOrder: 1,
      },
    },
    'Load-test': {
      'load-c-1': {
        id: 'load-c-1',
        tmsId: 'TMS-450',
        aljexId: '14452',
        pickupNumber: 'PO-450',
        customer: 'Broker X',
        customerId: 'cust-1',
        rateConfirmKey: 'rate-confirms/load-c-1/rate-confirm.pdf',
        miles: 300,
        rate: 45000,
        deliveryAppt: '2026-09-29T14:00:00Z',
        deliveryDriverId: DRIVER_C_ID,
        originCity: 'Chicago, IL',
        destinationCity: 'Detroit, MI',
        stops: [
          { type: 'pickup', city: 'Chicago, IL', locationId: 'loc-1', address: { city: 'Chicago', state: 'IL', zip: '60601' } },
          { type: 'delivery', city: 'Detroit, MI', locationId: 'loc-2', address: { city: 'Detroit', state: 'MI', zip: '48201' } },
        ],
      },
      'load-c-old': {
        id: 'load-c-old',
        tmsId: 'TMS-OLD',
        customer: 'Broker X',
        miles: 100,
        rate: 10000,
        deliveryAppt: '2026-09-20T10:00:00Z',
        deliveryDriverId: DRIVER_C_ID,
        originCity: 'Milwaukee, WI',
        destinationCity: 'Chicago, IL',
      },
      'load-a-old': {
        id: 'load-a-old',
        tmsId: 'TMS-A-OLD',
        customer: 'Broker X',
        miles: 150,
        rate: 99900,
        deliveryAppt: '2026-09-22T09:00:00Z',
        deliveryDriverId: DRIVER_A_ID,
        originCity: 'Gary, IN',
        destinationCity: 'Akron, OH',
      },
      'load-a-oo': {
        id: 'load-a-oo',
        tmsId: 'TMS-A-OO',
        customer: 'Broker X',
        miles: 200,
        rate: 20000,
        deliveryAppt: '2026-09-29T09:00:00Z',
        deliveryDriverId: DRIVER_A_ID,
        originCity: 'Gary, IN',
        destinationCity: 'Toledo, OH',
      },
      // Delivered ON the final Saturday of the 9/27 week, with a real time component —
      // the shape that an inclusive BETWEEN against a date-only bound silently drops.
      'load-c-saturday': {
        id: 'load-c-saturday',
        tmsId: 'N/A',
        aljexId: '14452  ',
        pickupNumber: 'PO-SAT',
        customer: 'Broker Sat',
        customerId: 'cust-1',
        rateConfirmKey: 'rate-confirms/load-c-saturday/rate-confirm.pdf',
        miles: 500,
        rate: 250000,
        deliveryAppt: '2026-10-03T05:00:00.000Z',
        deliveryDriverId: DRIVER_C_ID,
        originCity: 'Peoria, IL',
        destinationCity: 'Akron, OH',
        stops: [
          { type: 'pickup', city: 'Peoria, IL', locationId: 'loc-3', address: { city: 'Peoria', state: 'IL', zip: '61602' } },
          { type: 'delivery', city: 'Akron, OH', locationId: 'loc-4', address: { city: 'Akron', state: 'OH', zip: '44301' } },
        ],
      },
    },
    'Customer-test': {
      'cust-1': { id: 'cust-1', name: 'Broker X', mcNumber: '123456' },
    },
    'Location-test': {
      'loc-1': { id: 'loc-1', city: 'CHICAGO', state: 'IL', zip: '60601' },
      'loc-2': { id: 'loc-2', city: 'DETROIT', state: 'MI', zip: '48201' },
    },
    // A POD is now what lets a load be paid, so the fixtures carry one for every load
    // whose pay these tests assert. The hold itself has its own tests below.
    'PodDocument-test': {
      'pod-sat': { id: 'pod-sat', loadId: 'load-c-saturday', processingStatus: 'READY' },
      'pod-a-oo': { id: 'pod-a-oo', loadId: 'load-a-oo', processingStatus: 'READY' },
    },
    'DriverPayDeduction-test': {},
    'DriverPayCredit-test': {},
    'FuelTransaction-test': {},
  }
}

function matchesFilterExpression(
  rec: Record<string, unknown>,
  filter: string,
  values: Record<string, unknown>,
): boolean {
  if (!filter) return true
  const clauses = filter.split(/\s+AND\s+/i)
  for (const clause of clauses) {
    const between = clause.match(/^\s*([\w]+)\s+BETWEEN\s+(:\w+)\s+AND\s+(:\w+)\s*$/i)
    if (between) {
      const field = between[1]
      const a = values[between[2]]
      const b = values[between[3]]
      const v = rec[field]
      if (typeof v !== 'string' || typeof a !== 'string' || typeof b !== 'string') return false
      if (v < a || v > b) return false
      continue
    }
    // DynamoDB compares strings lexicographically; the handler relies on that to bound a
    // pay week, so the fake must model >= / < rather than quietly ignoring them.
    const cmp = clause.match(/^\s*([\w]+)\s*(>=|<=|>|<)\s*(:\w+)\s*$/i)
    if (cmp) {
      const v = rec[cmp[1]]
      const bound = values[cmp[3]]
      if (typeof v !== 'string' || typeof bound !== 'string') return false
      if (cmp[2] === '>=' && !(v >= bound)) return false
      if (cmp[2] === '<=' && !(v <= bound)) return false
      if (cmp[2] === '>' && !(v > bound)) return false
      if (cmp[2] === '<' && !(v < bound)) return false
      continue
    }
    const eq = clause.match(/^\s*([\w]+)\s*=\s*(:\w+)\s*$/i)
    if (eq) {
      if (rec[eq[1]] !== values[eq[2]]) return false
      continue
    }
    // A clause this fake cannot parse must NOT quietly widen the result set — that is how
    // a scoping test goes green while the real query filters nothing.
    throw new Error(`matchesFilterExpression: unsupported clause ${JSON.stringify(clause)}`)
  }
  return true
}

/** The in-memory DynamoDB. Module-scoped so a test can seed an extra row. */
let tables: ReturnType<typeof defaultTables>

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockReset()
  mockVerify.mockResolvedValue({ email: EMAIL_A, email_verified: true })
  mockGetSignedUrl.mockResolvedValue('https://s3.test/presigned-url')
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1699999999.000100' }) })
  sesSendMock.mockReset()
  sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-123' })

  tables = defaultTables()

  mockDynamoSend.mockImplementation(async (cmd: { input?: unknown }) => {
    const input = (cmd.input ?? {}) as {
      TableName?: string
      Key?: Record<string, unknown>
      Item?: Record<string, unknown>
      FilterExpression?: string
      ConditionExpression?: string
      UpdateExpression?: string
      IndexName?: string
      ExpressionAttributeNames?: Record<string, string>
      ExpressionAttributeValues?: Record<string, unknown>
    }
    const table = input.TableName ?? ''
    const tableRecords = tables[table]

    if (cmd instanceof GetCommand) {
      const id = input.Key?.id as string | undefined
      return { Item: id && tableRecords?.[id] ? { ...tableRecords[id] } : undefined }
    }

    if (cmd instanceof ScanCommand) {
      const values = input.ExpressionAttributeValues ?? {}
      const items = Object.values(tableRecords ?? {})
      const filtered = items.filter((item) =>
        matchesFilterExpression(item as Record<string, unknown>, input.FilterExpression ?? '', values),
      )
      return { Items: filtered }
    }

    if (cmd instanceof PutCommand) {
      const id = input.Item?.id as string | undefined
      if (!id) return {}
      if (tableRecords?.[id] && input.ConditionExpression?.includes('attribute_not_exists')) {
        throw new ConditionalCheckFailedException('already exists')
      }
      if (tableRecords) {
        tableRecords[id] = { ...input.Item }
      }
      return {}
    }

    if (cmd instanceof UpdateCommand) {
      const id = input.Key?.id as string | undefined
      if (id && tableRecords?.[id]) {
        const rec = tableRecords[id]
        const names = input.ExpressionAttributeNames ?? {}
        const values = input.ExpressionAttributeValues ?? {}
        applyUpdateExpression(rec, input.UpdateExpression ?? '', names, values)
        rec.updatedAt = new Date().toISOString()
      }
      return {}
    }

    if (cmd instanceof QueryCommand) {
      if (
        table === 'PodDocument-test' &&
        input.IndexName === 'podDocumentsByLoadIdAndReceivedAt'
      ) {
        const loadId = input.ExpressionAttributeValues?.[':loadId']
        return { Items: Object.values(tableRecords ?? {}).filter((p) => p.loadId === loadId) }
      }
      return { Items: [] }
    }

    return {}
  })

  mockS3Send.mockImplementation(async (cmd: { input?: unknown; constructor?: unknown }) => {
    if (cmd.constructor === HeadObjectCommand) {
      return { ContentLength: 1000, ContentType: 'image/jpeg' }
    }
    return {
      Body: {
        transformToByteArray: async () => Buffer.from('image-bytes'),
      },
    }
  })
})

describe('driver-app-api handler', () => {
  describe('security', () => {
    it('rejects all unauthenticated requests before path routing', async () => {
      const res = await handler(baseEvent('/submissions', 'GET', { auth: false }))
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body)).toEqual({ error: 'Missing authorization' })
    })

    it('returns 404 for an unknown route when authenticated, leaking no roster data', async () => {
      const res = await handler(baseEvent('/unknown-route', 'GET'))
      expect(res.statusCode).toBe(404)
      const parsed = JSON.parse(res.body)
      expect(parsed.error).toBeDefined()
      expect(parsed).not.toHaveProperty('driverId')
      expect(parsed).not.toHaveProperty('driverName')
      expect(parsed).not.toHaveProperty('payGroup')
    })

    it('returns 404 (not 403) when driver A requests driver B submission', async () => {
      const res = await handler(baseEvent(`/submissions/${SUBMISSION_B}/complete`, 'POST', { body: { kind: 'RATECON' } }))
      expect(res.statusCode).toBe(404)
      const parsed = JSON.parse(res.body)
      expect(parsed.error).toContain('Submission not found')
      // must leak nothing about which driver owns it
      expect(parsed).not.toHaveProperty('driverId')
      expect(parsed).not.toHaveProperty('driverName')
    })
  })

  describe('GET /me', () => {
    it('returns the resolved driver profile', async () => {
      const res = await handler(baseEvent('/me'))
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        driverId: DRIVER_A_ID,
        name: 'Driver A',
        email: EMAIL_A,
        payGroup: 'AMAZON',
        // Which page the app shows. SETTLEMENT here, and notably this driver carries no
        // fleetGroup and no driverType — the unstated case has to keep the pay page.
        program: 'SETTLEMENT',
        active: true,
        // No truck assigned to this fixture driver, so there is no PM to report.
        pm: null,
      })
    })
  })

  describe('POST /submissions', () => {
    it('rejects an oversized page', async () => {
      const res = await handler(
        baseEvent('/submissions', 'POST', {
          body: {
            pages: [{ fileName: 'big.jpg', contentType: 'image/jpeg', byteSize: 16 * 1024 * 1024 }],
          },
        }),
      )
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('size invalid')
    })

    it('rejects something that is neither an image nor a PDF', async () => {
      const res = await handler(
        baseEvent('/submissions', 'POST', {
          body: {
            pages: [{ fileName: 'bad.exe', contentType: 'application/octet-stream', byteSize: 1024 }],
          },
        }),
      )
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('not an image or a PDF')
    })

    it('takes the HEIC an iPhone actually produces', async () => {
      /*
       * The list used to name four formats, so a photo from any recent iPhone was refused
       * by the upload it had just been allowed to start. The cleanup pipeline decides for
       * itself what it can improve and keeps the original when it cannot, so there was
       * nothing here for that list to protect.
       */
      const res = await handler(
        baseEvent('/submissions', 'POST', {
          body: {
            pages: [{ fileName: 'IMG_4312.HEIC', contentType: 'image/heic', byteSize: 2048 }],
          },
        }),
      )
      expect(res.statusCode).toBe(200)
    })

    it('takes a file an Android file manager handed over with no type at all', async () => {
      const res = await handler(
        baseEvent('/submissions', 'POST', {
          body: { pages: [{ fileName: 'pod.jpg', contentType: 'application/octet-stream', byteSize: 2048 }] },
        }),
      )
      expect(res.statusCode).toBe(200)
    })

    it('creates a submission and returns presigned PUTs scoped to the driver', async () => {
      const res = await handler(
        baseEvent('/submissions', 'POST', {
          body: {
            referenceNumber: 'VRID-NEW',
            note: 'Dock 7',
            pages: [
              { fileName: 'rc1.jpg', contentType: 'image/jpeg', byteSize: 1000 },
              { fileName: 'rc2.jpg', contentType: 'image/png', byteSize: 2000 },
            ],
          },
        }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.submissionId).toBeDefined()
      expect(body.uploads).toHaveLength(2)
      expect(body.uploads[0].s3Key).toContain('/RATECON/')
      expect(body.uploads[0].url).toBe('https://s3.test/presigned-url')

      const putCalls = mockDynamoSend.mock.calls.filter((c) => c[0] instanceof PutCommand)
      const submissionPut = putCalls.find(
        (c) => (c[0].input as MockDynamoPutInput).TableName === 'DriverSubmission-test',
      )
      expect(submissionPut).toBeDefined()
      const item = (submissionPut![0].input as MockDynamoPutInput).Item!
      expect(item.driverId).toBe(DRIVER_A_ID)
      expect(item.driverName).toBe('Driver A')
      expect(item.status).toBe('NEW')
      expect(item.referenceNumber).toBe('VRID-NEW')
      expect(item.note).toBe('Dock 7')
    })

    it('creates a standalone POD submission when kind is POD', async () => {
      const res = await handler(
        baseEvent('/submissions', 'POST', {
          body: {
            kind: 'POD',
            referenceNumber: 'VRID-POD',
            pages: [{ fileName: 'pod.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
          },
        }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.uploads[0].s3Key).toContain('/POD/')

      const putCalls = mockDynamoSend.mock.calls.filter((c) => c[0] instanceof PutCommand)
      const submissionPut = putCalls.find(
        (c) => (c[0].input as MockDynamoPutInput).TableName === 'DriverSubmission-test',
      )
      const item = (submissionPut![0].input as MockDynamoPutInput).Item!
      expect(item.pendingUploads).toHaveProperty('POD')
      expect(item.pendingUploads).not.toHaveProperty('RATECON')
    })

    it('re-signs a submission’s saved RATECON pages so a retry can re-PUT them', async () => {
      const res = await handler(
        baseEvent(`/submissions/${SUBMISSION_A}/uploads`, 'GET', { query: { kind: 'RATECON' } }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.uploads).toHaveLength(1)
      expect(body.uploads[0].url).toBe('https://s3.test/presigned-url')
      expect(body.uploads[0].s3Key).toContain('/RATECON/')
    })
  })

  describe('POST /submissions/:id/complete', () => {
    it('persists docs, posts Slack + email, and is idempotent', async () => {
      const first = await handler(baseEvent(`/submissions/${SUBMISSION_A}/complete`, 'POST', { body: { kind: 'RATECON' } }))
      expect(first.statusCode).toBe(200)
      expect(JSON.parse(first.body)).toEqual({ ok: true })

      const slackCalls = fetchMock.mock.calls.filter((c) => c[0] === 'https://slack.com/api/chat.postMessage')
      const sesCalls = sesSendMock.mock.calls
      expect(slackCalls.length).toBeGreaterThanOrEqual(1)
      expect(sesCalls.length).toBeGreaterThanOrEqual(1)

      fetchMock.mockClear()
      sesSendMock.mockClear()

      const second = await handler(baseEvent(`/submissions/${SUBMISSION_A}/complete`, 'POST', { body: { kind: 'RATECON' } }))
      expect(second.statusCode).toBe(200)
      expect(JSON.parse(second.body)).toEqual({ ok: true })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(sesSendMock).not.toHaveBeenCalled()
    })

    it('does not reference undefined Slack refs when a leg fails on first attempt', async () => {
      // Slack fails and there are no previous Slack refs. Those attributes must be
      // omitted from the SET clause entirely; binding them to undefined would be a
      //ValidationException in real DynamoDB.
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'account_inactive' }),
      })

      const res = await handler(
        baseEvent(`/submissions/${SUBMISSION_A}/complete`, 'POST', { body: { kind: 'RATECON' } }),
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({
        ok: true,
        error: expect.stringContaining('Slack'),
      })

      const submissionUpdate = mockDynamoSend.mock.calls
        .filter((c) => c[0] instanceof UpdateCommand)
        .map((c) => c[0].input as MockDynamoUpdateInput)
        .find((input) => input.TableName === 'DriverSubmission-test' && input.Key?.id === SUBMISSION_A)
      expect(submissionUpdate).toBeDefined()
      // Slack failed with no message timestamp, so slackMessageTs must not be SET.
      expect(submissionUpdate!.UpdateExpression).not.toMatch(/slackMessageTs\s*=/u)
      // Email succeeded, so its refs were bound and persisted.
      expect(submissionUpdate!.UpdateExpression).toMatch(/emailMessageId\s*=/u)
      expect(submissionUpdate!.ExpressionAttributeValues).toMatchObject({
        ':mid': expect.stringMatching(/^<ses-msg-123@/u),
      })
    })

    it('rejects an S3 attachment whose size does not match the declared byteSize', async () => {
      mockS3Send.mockImplementation(
        async (cmd: { input?: unknown; constructor?: unknown }) => {
          if (cmd.constructor === HeadObjectCommand) {
            return { ContentLength: 2000 } // pending page claims 1000
          }
          return {
            Body: { transformToByteArray: async () => Buffer.from('image-bytes') },
          }
        },
      )

      const res = await handler(
        baseEvent(`/submissions/${SUBMISSION_A}/complete`, 'POST', { body: { kind: 'RATECON' } }),
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({
        ok: true,
        error: expect.stringContaining('size mismatch'),
      })
      // Notification must be short-circuited; no real Slack/email calls.
      expect(fetchMock).not.toHaveBeenCalled()
      expect(sesSendMock).not.toHaveBeenCalled()
    })

    it('rejects an S3 attachment exceeding the per-page max', async () => {
      mockS3Send.mockImplementation(
        async (cmd: { input?: unknown; constructor?: unknown }) => {
          if (cmd.constructor === HeadObjectCommand) {
            return { ContentLength: 16 * 1024 * 1024 }
          }
          return {
            Body: { transformToByteArray: async () => Buffer.from('image-bytes') },
          }
        },
      )

      const res = await handler(
        baseEvent(`/submissions/${SUBMISSION_A}/complete`, 'POST', { body: { kind: 'RATECON' } }),
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({
        ok: true,
        error: expect.stringContaining('max size'),
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(sesSendMock).not.toHaveBeenCalled()
    })
  })

  describe('OWNER_OPERATOR settlement', () => {
    beforeEach(() => {
      mockVerify.mockReset()
      mockVerify.mockResolvedValue({ email: EMAIL_C, email_verified: true })
    })

    it('lists a brokerage load delivered in the week with its lane', async () => {
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.weekStart).toBe('2026-09-27')
      const wed = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-450')
      expect(wed).toBeDefined()
      expect(wed.origin).toBe('Chicago, IL')
      expect(wed.destination).toBe('Detroit, MI')
    })

    it('holds a load with no POD off the check and tells the driver why', async () => {
      // load-c-1 has a rate confirmation but no POD. The driver did the work, so the
      // load is listed — it just cannot be invoiced yet, so it is not on this cheque.
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      const body = JSON.parse(res.body)
      const held = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-450')
      expect(held.heldReason).toBe('NO_POD')
      expect(held.heldLabel).toBe('POD required')
      // The pay IS shown. The row says it is not on this check and grossPay excludes it,
      // so hiding the figure only left the driver ringing the office to ask their rate.
      expect(held.amount).toBeGreaterThan(0)
      expect(held.onThisCheck).toBe(false)
      // Only the Saturday load, which has a POD, reaches the money math.
      expect(body.grossPay).toBe(2500)
    })

    it('pays a held load as soon as the driver sends the POD themselves', async () => {
      // The driver's own scan lands in DriverSubmissionDoc, not the JobsDone POD table.
      // Before this, their POD was invisible to the check that gates their own pay.
      tables['DriverSubmission-test']['sub-pod'] = {
        id: 'sub-pod', driverId: DRIVER_C_ID, driverName: 'Driver C',
        referenceNumber: '14452', createdAt: '2026-09-29T15:00:00Z', status: 'NEW',
      }
      tables['DriverSubmissionDoc-test']['doc-pod'] = {
        id: 'doc-pod', submissionId: 'sub-pod', driverId: DRIVER_C_ID,
        kind: 'POD', s3Key: 'driver-docs/c/sub-pod/POD/1.jpg', uploadedAt: '2026-09-29T15:00:00Z',
      }

      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      const body = JSON.parse(res.body)
      const paid = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-450')
      expect(paid.heldReason).toBeNull()
      // 45000 cents -> $450.00 freight -> $396.00 pay. Never $45,000.
      expect(paid.amount).toBeCloseTo(396, 2)
    })

    it('includes a load delivered on the final Saturday of the week', async () => {
      // Regression: the query bounded deliveryAppt with an inclusive BETWEEN against a
      // date-only end, so '2026-10-03T05:00:00.000Z' sorted past '2026-10-03' and a real
      // $2,500 load vanished from the driver's check while staff still saw it.
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      const body = JSON.parse(res.body)
      const saturday = body.trips.find((t: { loadId?: string }) => t.loadId === '14452')
      expect(saturday).toBeDefined()
      expect(saturday.destination).toBe('Akron, OH')
      // The Wednesday load is held for its missing POD, so gross is the Saturday load
      // alone — which still proves it reaches the money math at all.
      expect(body.grossPay).toBe(2500)
    })

    /*
     * A driver sees what they have run, not what they are booked for.
     *
     * The week query used to run to the end of the pay week, so on Monday a driver's
     * settlement already listed Friday's load — pay they had not earned — and the paperwork
     * page asked for a POD for a delivery that had not happened.
     */
    describe('loads that have not delivered yet', () => {
      const MONDAY = new Date('2026-09-28T09:00:00Z') // inside the 2026-09-27 week

      beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(MONDAY)
        mockVerify.mockReset()
        mockVerify.mockResolvedValue({ email: EMAIL_C, email_verified: true })
        // Booked for Thursday of the same week, already assigned to the driver.
        tables['Load-test']['load-c-future'] = {
          id: 'load-c-future', tmsId: 'TMS-FUTURE', aljexId: '19999',
          customer: 'Broker Later', miles: 100, rate: 100000,
          deliveryAppt: '2026-10-01T18:00:00.000Z',
          deliveryDriverId: DRIVER_C_ID,
          originCity: 'Joliet, IL', destinationCity: 'Gary, IN',
        }
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('LISTS a load booked later this week, marked as not delivered yet', async () => {
        /*
         * It used to be dropped entirely, so a driver saw two shipments where the office
         * saw four — Roy's week was missing the two that deliver later in it. Hiding work
         * a driver is about to run, and the money on it, made the app look wrong.
         */
        const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        const future = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-FUTURE')
        expect(future).toBeDefined()
        expect(future.heldReason).toBe('NOT_DELIVERED')
        expect(future.heldLabel).toBe('Not delivered yet')
        expect(future.onThisCheck).toBe(false)
        // It shows what it will pay...
        expect(future.amount).toBeGreaterThan(0)
      })

      it('keeps an undelivered load OUT of the check amount', async () => {
        // The whole reason it used to be hidden: it must never read as pay already earned.
        const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
        const body = JSON.parse(res.body)
        const future = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-FUTURE')
        const onCheck = body.trips.filter((t: { onThisCheck?: boolean }) => t.onThisCheck)
        expect(onCheck).not.toContainEqual(future)
        // The invariant that matters, stated directly: the cheque is exactly the loads
        // marked as on it, and the future one is not among them however much it pays.
        const paid = onCheck.reduce((n: number, t: { amount: number }) => n + t.amount, 0)
        expect(body.grossPay).toBe(paid)
        expect(future.amount).toBeGreaterThan(0)
      })

      it('says NOT_DELIVERED rather than NO_POD on a future load', async () => {
        // It has no POD either, but "you have not run it" is the true answer; asking for
        // paperwork that cannot exist yet is the wrong thing to put in front of a driver.
        const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
        const body = JSON.parse(res.body)
        const future = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-FUTURE')
        expect(future.heldReason).not.toBe('NO_POD')
      })

      it('still shows a load delivered earlier the same day', async () => {
        // Nothing records an actual delivery, so today counts — otherwise a driver who
        // delivered at 08:00 would not see it until tomorrow.
        tables['Load-test']['load-c-today'] = {
          id: 'load-c-today', tmsId: 'TMS-TODAY', aljexId: '19998',
          customer: 'Broker Today', miles: 50, rate: 50000,
          deliveryAppt: '2026-09-28T08:00:00.000Z',
          deliveryDriverId: DRIVER_C_ID,
          originCity: 'Elgin, IL', destinationCity: 'Aurora, IL',
        }
        const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
        const body = JSON.parse(res.body)
        expect(body.trips.some((t: { loadId?: string }) => t.loadId === 'TMS-TODAY')).toBe(true)
      })

      it('does not count the undelivered load in the week picker either', async () => {
        // The count and the page have to agree, or the driver is told about work the
        // statement does not show.
        const res = await handler(baseEvent('/settlement/weeks'))
        const weeks = JSON.parse(res.body).weeks as Array<{ weekStart: string; tripCount: number }>
        const wk = weeks.find((w) => w.weekStart === '2026-09-27')
        expect(wk).toBeDefined()
        const res2 = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
        expect(wk!.tripCount).toBe(JSON.parse(res2.body).trips.length)
      })
    })

    it('attaches the per-trip factoring readiness resolved from Load/Customer/Location/POD rows', async () => {
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      const body = JSON.parse(res.body)

      const wed = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-450')
      expect(wed.factoring).toMatchObject({
        invoiceNo: '14452',
        poNumber: 'PO-450',
        brokerMc: '123456',
        invoiceAmount: 450,
        invoiceDate: '2026-09-29',
        fromCity: 'Chicago',
        fromState: 'IL',
        fromZip: '60601',
        toCity: 'Detroit',
        toState: 'MI',
        toZip: '48201',
        podPresent: false,
        rateconPresent: true,
        blocked: true,
      })

      const saturday = body.trips.find((t: { loadId?: string }) => t.loadId === '14452')
      expect(saturday.factoring.podPresent).toBe(true)
      expect(saturday.factoring.blocked).toBe(false)
    })

    it('never includes another driver’s delivered loads', async () => {
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.trips.every((t: { loadId?: string }) => t.loadId !== 'TMS-A-OO')).toBe(true)
    })

    it('rejects weeks before the first owner-operator period', async () => {
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-20' } }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('owner-operator start')
    })

    it('lists only owner-operator weeks on or after 2026-09-27', async () => {
      const res = await handler(baseEvent('/settlement/weeks'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      const starts = body.weeks.map((w: { weekStart: string }) => w.weekStart)
      expect(starts).toContain('2026-09-27')
      expect(starts.every((s: string) => s >= '2026-09-27')).toBe(true)
    })
  })

  describe('AMAZON settlement regression guard', () => {
    it('still reads AmazonTrip and ignores Load rows for Amazon drivers', async () => {
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-20' } }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.weekStart).toBe('2026-09-20')
      expect(body.trips).toHaveLength(1)
      expect(body.trips[0].loadId).toBe('AMZ-1')
      expect(body.grossPay).toBe(1000)
    })

    it('pays an Amazon driver both Relay trips and brokerage loads after the changeover', async () => {
      // Staff split the week across two statements from 2026-09-27 while the driver keeps
      // payGroup AMAZON; picking one source hid half the week from the driver.
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.trips.map((t: { loadId?: string }) => t.loadId).sort()).toEqual(['AMZ-2', 'TMS-A-OO'])
      expect(body.grossPay).toBe(700)
    })

    it('lists the week in progress even when no trip has landed in it yet', async () => {
      // A Thursday three weeks past every seeded trip: the state the app is in
      // early in any week, before that week's loads are processed.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
      try {
        const res = await handler(baseEvent('/settlement/weeks'))
        expect(res.statusCode).toBe(200)
        const weeks = JSON.parse(res.body).weeks as { weekStart: string; tripCount: number }[]
        const starts = weeks.map((w) => w.weekStart)
        // Newest first, and the newest is the week we are actually in.
        expect(starts[0]).toBe('2026-10-18')
        expect(weeks[0].tripCount).toBe(0)
        // History is still offered behind it.
        expect(starts).toContain('2026-09-27')
      } finally {
        vi.useRealTimers()
      }
    })

    it('lists both the Amazon history and the brokerage weeks for an Amazon driver', async () => {
      const res = await handler(baseEvent('/settlement/weeks'))
      expect(res.statusCode).toBe(200)
      const weeks = JSON.parse(res.body).weeks as { weekStart: string; gross: number }[]
      const starts = weeks.map((w) => w.weekStart)
      expect(starts).toContain('2026-09-20')
      expect(starts).toContain('2026-09-27')
      // A brokerage load delivered BEFORE the changeover was never settled to the driver,
      // so the list must report the same gross the detail view builds for that week.
      expect(weeks.find((w) => w.weekStart === '2026-09-20')?.gross).toBe(1000)
    })
  })

  describe('attaching a POD to a load', () => {
    beforeEach(() => {
      mockVerify.mockReset()
      mockVerify.mockResolvedValue({ email: EMAIL_C, email_verified: true })
    })

    /** A POD driver C sent with no load number. */
    function seedUnattachedPod() {
      tables['DriverSubmission-test']['sub-loose'] = {
        id: 'sub-loose', driverId: DRIVER_C_ID, driverName: 'Driver C',
        status: 'NEW', referenceNumber: null, loadId: null,
        createdAt: '2026-09-29T15:00:00Z',
      }
      tables['DriverSubmissionDoc-test']['doc-loose'] = {
        id: 'doc-loose', submissionId: 'sub-loose', driverId: DRIVER_C_ID,
        kind: 'POD', s3Key: 'driver-docs/c/sub-loose/POD/1.jpg', uploadedAt: '2026-09-29T15:00:00Z',
      }
    }

    it('offers the driver their own recent loads to attach to', async () => {
      const res = await handler(baseEvent('/loads/recent', 'GET'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      const ids = body.loads.map((l: { id: string }) => l.id)
      expect(ids).toContain('load-c-1')
      // Another driver's load is never offered.
      expect(ids).not.toContain('load-a-oo')
    })

    it('attaches the POD and marks the submission linked', async () => {
      seedUnattachedPod()
      const res = await handler(
        baseEvent('/submissions/sub-loose/attach', 'POST', { body: { loadId: 'load-c-1' } }),
      )

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ loadId: 'load-c-1', proNumber: '14452' })

      const update = mockDynamoSend.mock.calls
        .map((c) => (c[0] as { input: Record<string, unknown> }).input)
        .find((i) => i.TableName === 'DriverSubmission-test' && i.UpdateExpression)
      expect(update?.ExpressionAttributeValues).toMatchObject({ ':l': 'load-c-1', ':s': 'LINKED' })
    })

    it('releases the load pay once the POD is attached', async () => {
      // This is the whole point: an unattached POD counts for nothing, so the load is
      // held. Attaching it is what puts the load back on the cheque.
      seedUnattachedPod()
      const before = JSON.parse(
        (await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))).body,
      )
      expect(before.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-450').heldReason).toBe('NO_POD')

      tables['DriverSubmission-test']['sub-loose'].loadId = 'load-c-1'

      const after = JSON.parse(
        (await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))).body,
      )
      expect(after.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-450').heldReason).toBeNull()
    })

    it('refuses a load that is not this driver\'s, with no payload', async () => {
      seedUnattachedPod()
      const res = await handler(
        baseEvent('/submissions/sub-loose/attach', 'POST', { body: { loadId: 'load-a-oo' } }),
      )
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'Not found' })
    })

    it('refuses a submission that is not this driver\'s', async () => {
      tables['DriverSubmission-test']['sub-other'] = {
        id: 'sub-other', driverId: DRIVER_A_ID, driverName: 'Driver A',
        status: 'NEW', createdAt: '2026-09-29T15:00:00Z',
      }
      const res = await handler(
        baseEvent('/submissions/sub-other/attach', 'POST', { body: { loadId: 'load-c-1' } }),
      )
      expect(res.statusCode).toBe(404)
    })

    it('requires a loadId', async () => {
      seedUnattachedPod()
      const res = await handler(baseEvent('/submissions/sub-loose/attach', 'POST', { body: {} }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'loadId required' })
    })

    it('no longer exposes a driver status route', async () => {
      // Driver-reported status was removed; the route must be gone, not merely unused.
      const res = await handler(
        baseEvent('/loads/load-c-1/status', 'POST', { body: { status: 'DELIVERED' } }),
      )
      expect(res.statusCode).toBe(404)
    })
  })
})

describe('a full-table scan with no filter', () => {
  beforeEach(() => {
    mockVerify.mockReset()
    mockVerify.mockResolvedValue({ email: EMAIL_C, email_verified: true })
  })

  it('does not send empty expression values, which DynamoDB rejects outright', async () => {
    // ExpressionAttributeValues: {} with no FilterExpression is a ValidationException, and
    // {} is truthy — so the guard that omitted it had to check the key count, not the
    // object. /loads/recent scans the whole Load table, and it was failing every call.
    const res = await handler(baseEvent('/loads/recent', 'GET'))
    expect(res.statusCode).toBe(200)

    const scans = mockDynamoSend.mock.calls
      .map((c) => (c[0] as { input: Record<string, unknown> }).input)
      .filter((i) => i.TableName === 'Load-test' && !i.Key)
    expect(scans.length).toBeGreaterThan(0)
    for (const input of scans) {
      if (!input.FilterExpression) {
        expect(input.ExpressionAttributeValues).toBeUndefined()
      }
    }
  })
})

/*
 * A driver types a PRO; nothing ever turned it into a link.
 *
 * Every submission sat with loadId null forever — Chad's POD for 14547 among them — so
 * only screens that ALSO matched on the PRO found it, and everything keyed on loadId (the
 * load's own documents, the factoring queue) did not. Six live submissions were in that
 * state and every one of them matched a real load.
 */
describe('attaching a submission to its load', () => {
  /** The DriverSubmission row this request wrote. */
  function submissionPut(): Record<string, unknown> {
    const call = mockDynamoSend.mock.calls
      .map((c) => c[0] as { input?: { TableName?: string; Item?: Record<string, unknown> } })
      .filter((c) => c instanceof PutCommand && c.input?.TableName === 'DriverSubmission-test')
      .pop()
    return (call?.input?.Item ?? {}) as Record<string, unknown>
  }

  beforeEach(() => {
    mockVerify.mockReset()
    mockVerify.mockResolvedValue({ email: EMAIL_C, email_verified: true })
    // A PRO on exactly one load. The shared fixtures put 14452 on two, which the
    // ambiguity test below depends on, so this one is added for the happy path.
    tables['Load-test']['load-unique-pro'] = {
      id: 'load-unique-pro', tmsId: 'TMS-UNIQ', aljexId: '77777  ',
      customer: 'Broker Uniq', rate: 100000,
      deliveryAppt: '2026-09-29T14:00:00Z', deliveryDriverId: DRIVER_C_ID,
    }
  })

  it('links the submission to the load the PRO names', async () => {
    const res = await handler(baseEvent('/submissions', 'POST', {
      body: { kind: 'POD', referenceNumber: '77777', pages: [{ fileName: 'p.jpg', contentType: 'image/jpeg', byteSize: 10 }] },
    }))
    expect(res.statusCode).toBe(200)
    // Matched on the padded '77777  ' the table really stores, via normalizePro.
    const put = submissionPut()
    expect(put.loadId).toBe('load-unique-pro')
    expect(put.status).toBe('LINKED')
  })

  it('leaves it unattached when the PRO matches nothing, rather than losing the POD', async () => {
    const res = await handler(baseEvent('/submissions', 'POST', {
      body: { kind: 'POD', referenceNumber: '00000', pages: [{ fileName: 'p.jpg', contentType: 'image/jpeg', byteSize: 10 }] },
    }))
    expect(res.statusCode).toBe(200)
    const put = submissionPut()
    expect(put.loadId).toBeUndefined()
    expect(put.status).toBe('NEW')
  })

  it('refuses to guess when a PRO is on more than one load', async () => {
    /*
     * 14452 is on two fixture loads, and one live PRO is on two loads today. Papering the
     * wrong shipment is worse than leaving the POD loose — loose, it still shows against
     * the load by PRO and a person can place it.
     */
    const res = await handler(baseEvent('/submissions', 'POST', {
      body: { kind: 'POD', referenceNumber: '14452', pages: [{ fileName: 'p.jpg', contentType: 'image/jpeg', byteSize: 10 }] },
    }))
    expect(res.statusCode).toBe(200)
    const put = submissionPut()
    expect(put.loadId).toBeUndefined()
    expect(put.status).toBe('NEW')
  })

  it('leaves it unattached when the driver typed no reference at all', async () => {
    const res = await handler(baseEvent('/submissions', 'POST', {
      body: { kind: 'POD', pages: [{ fileName: 'p.jpg', contentType: 'image/jpeg', byteSize: 10 }] },
    }))
    expect(res.statusCode).toBe(200)
    expect(submissionPut().loadId).toBeUndefined()
  })
})
