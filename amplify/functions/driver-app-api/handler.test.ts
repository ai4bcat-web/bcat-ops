import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
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
        customer: 'Broker X',
        miles: 300,
        rate: 45000,
        deliveryAppt: '2026-09-29T14:00:00Z',
        deliveryDriverId: DRIVER_C_ID,
        originCity: 'Chicago, IL',
        destinationCity: 'Detroit, MI',
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
        customer: 'Broker Sat',
        miles: 500,
        rate: 250000,
        deliveryAppt: '2026-10-03T05:00:00.000Z',
        deliveryDriverId: DRIVER_C_ID,
        originCity: 'Peoria, IL',
        destinationCity: 'Akron, OH',
      },
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

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockReset()
  mockVerify.mockResolvedValue({ email: EMAIL_A, email_verified: true })
  mockGetSignedUrl.mockResolvedValue('https://s3.test/presigned-url')
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1699999999.000100' }) })
  sesSendMock.mockReset()
  sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-123' })

  const tables = defaultTables()

  mockDynamoSend.mockImplementation(async (cmd: { input?: unknown }) => {
    const input = (cmd.input ?? {}) as {
      TableName?: string
      Key?: Record<string, unknown>
      Item?: Record<string, unknown>
      FilterExpression?: string
      ConditionExpression?: string
      UpdateExpression?: string
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
        active: true,
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

    it('rejects a wrong content type', async () => {
      const res = await handler(
        baseEvent('/submissions', 'POST', {
          body: {
            pages: [{ fileName: 'bad.exe', contentType: 'application/octet-stream', byteSize: 1024 }],
          },
        }),
      )
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('unsupported content type')
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

    it('returns a settlement line with freight in dollars from Load.rate cents', async () => {
      const res = await handler(baseEvent('/settlement', 'GET', { query: { week: '2026-09-27' } }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.weekStart).toBe('2026-09-27')
      const wed = body.trips.find((t: { loadId?: string }) => t.loadId === 'TMS-450')
      expect(wed).toBeDefined()
      expect(wed.origin).toBe('Chicago, IL')
      expect(wed.destination).toBe('Detroit, MI')
      // 45000 cents -> $450.00, never $45,000.
      expect(wed.amount).toBeCloseTo(396, 2)
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
      // gross = 450 + 2500, proving the Saturday load reaches the money math.
      expect(body.grossPay).toBe(2950)
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
})
