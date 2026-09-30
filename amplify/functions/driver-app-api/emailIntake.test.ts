/**
 * Tests for the loads inbox email-intake routes in driver-app-api/handler.ts.
 *
 * These focus on behavior a plausible bug would break: the loop guard that stops our own
 * notification emails from re-entering, name-based driver resolution, secret gating,
 * and the end-to-end prepare/commit flow.
 */
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
interface MockDynamoQueryInput {
  TableName?: string
  IndexName?: string
  KeyConditionExpression?: string
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
  QueryCommand: vi.fn(function (this: { input: MockDynamoQueryInput }, input: MockDynamoQueryInput) {
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
  process.env.DRIVER_USER_POOL_ID = 'us-east-1_testpool'
  process.env.DRIVER_USER_POOL_CLIENT_ID = 'test-client-id'
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
  process.env.INTAKE_IVAN_CHANNEL_ID = 'C0B4YJXLYM8'
  process.env.LOADS_EMAIL_TO = 'ivanloads@bcatcorp.com'
  process.env.SES_FROM_ADDRESS = 'onboarding@bcatcorp.com'
  process.env.AWS_REGION = 'us-east-1'
  process.env.LOADS_INTAKE_SECRET = 'loads-intake-secret'
})

class ConditionalCheckFailedException extends Error {
  name = 'ConditionalCheckFailedException'
}

function resolvePath(path: string, names: Record<string, string>): string[] {
  // DynamoDB semantics: the document path splits on '.', and each segment that is an
  // ExpressionAttributeName resolves to ONE literal attribute name. A resolved name is never
  // re-split — mapping '#x' to 'a.b' addresses a top-level attribute literally called "a.b",
  // NOT a nested map. Re-splitting here would let a dotted-name bug pass its tests and then
  // silently write the wrong shape against the real table.
  return path.split('.').map((part) => (part.startsWith('#') ? names[part] ?? part : part))
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
        setPath(rec, lhs, names, evaluateRhs(rhs, rec, names, values))
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
const GMAIL_ID = 'msg-123456'
const SUBMISSION_EMAIL_ID = `email:${GMAIL_ID}`
const SECRET = 'loads-intake-secret'

// Cannot static-import handler because these tests must install SDK mocks first.
let handler: typeof HandlerModule.handler
let nameMatchesBody: typeof HandlerModule.nameMatchesBody
let shouldSkipEmailIntake: typeof HandlerModule.shouldSkipEmailIntake
let isOwnNotificationSubject: typeof HandlerModule.isOwnNotificationSubject

beforeAll(async () => {
  const mod = (await import('./handler')) as typeof HandlerModule
  handler = mod.handler
  nameMatchesBody = mod.nameMatchesBody
  shouldSkipEmailIntake = mod.shouldSkipEmailIntake
  isOwnNotificationSubject = mod.isOwnNotificationSubject
})

function defaultTables(): Record<string, Record<string, Record<string, unknown>>> {
  return {
    'Driver-test': {
      [DRIVER_A_ID]: { id: DRIVER_A_ID, name: 'Jose Ramirez', active: true, email: EMAIL_A },
      [DRIVER_B_ID]: { id: DRIVER_B_ID, name: 'Maria Lopez', active: true, email: EMAIL_B },
      [DRIVER_C_ID]: { id: DRIVER_C_ID, name: 'Al', active: true, email: 'al@example.com' },
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
      },
      'set-b': {
        id: 'set-b',
        driverId: DRIVER_B_ID,
        active: true,
        payGroup: 'AMAZON',
        payPercent: 0.85,
        expensesBeforePercent: false,
        email: EMAIL_B,
      },
    },
    'DriverSubmission-test': {},
    'DriverSubmissionDoc-test': {},
    'AmazonTrip-test': {},
    'DriverPayDeduction-test': {},
    'DriverPayCredit-test': {},
    'FuelTransaction-test': {},
  }
}

let currentTables = defaultTables()

function baseEvent(rawPath: string, body: unknown): Parameters<typeof handler>[0] {
  return {
    rawPath,
    requestContext: { http: { method: 'POST' } },
    headers: {},
    body: JSON.stringify(body),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockReset()
  mockGetSignedUrl.mockReset()
  mockGetSignedUrl.mockResolvedValue('https://s3.test/presigned-url')
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1699999999.000100' }) })
  sesSendMock.mockReset()
  sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-123' })
  process.env.LOADS_INTAKE_SECRET = SECRET
  process.env.SES_FROM_ADDRESS = 'onboarding@bcatcorp.com'
  currentTables = defaultTables()

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
      IndexName?: string
      KeyConditionExpression?: string
    }
    const table = input.TableName ?? ''
    const tableRecords = currentTables[table]

    if (cmd instanceof GetCommand) {
      const id = input.Key?.id as string | undefined
      return { Item: id && tableRecords?.[id] ? { ...tableRecords[id] } : undefined }
    }

    if (cmd instanceof ScanCommand) {
      const values = input.ExpressionAttributeValues ?? {}
      const items = Object.values(tableRecords ?? {})
      const expr = input.FilterExpression ?? ''
      const valueToField: Record<string, string> = {}
      for (const placeholder of Object.keys(values)) {
        const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`([#?][\\w]+|\\w+)\\s*=\\s*${escaped}`)
        const match = expr.match(regex)
        if (match) {
          const attr = match[1]
          valueToField[placeholder] = attr.startsWith('#')
            ? (input.ExpressionAttributeNames?.[attr] ?? attr)
            : attr
        }
      }
      const filtered = items.filter((item) => {
        const rec = item as Record<string, unknown>
        for (const [key, v] of Object.entries(values)) {
          const field = valueToField[key] ?? key.replace(/^:/, '')
          if (rec[field] !== v) return false
        }
        return true
      })
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
      // Honour the actual KeyConditionExpression rather than assuming one index: a Query that
      // matched everything would make an index-scoped lookup look like it worked while returning
      // every row in the table.
      const values = input.ExpressionAttributeValues ?? {}
      const cond = input.KeyConditionExpression ?? ''
      const match = cond.match(/(\w+)\s*=\s*(:\w+)/)
      if (!match) return { Items: [] }
      const field = match[1]
      const wanted = values[match[2]]
      const items = Object.values(tableRecords ?? {}).filter(
        (item) => (item as Record<string, unknown>)[field] === wanted,
      )
      return { Items: items }
    }

    return {}
  })

  mockS3Send.mockImplementation(async (cmd: { constructor?: { name: string }; input?: { Key?: string } }) => {
    if (cmd instanceof HeadObjectCommand) {
      return {
        ContentLength: 2000,
        ContentType: 'image/jpeg',
      }
    }
    return {
      Body: {
        transformToByteArray: async () => Buffer.from('image-bytes'),
      },
    }
  })
})

describe('email intake pure helpers', () => {
  describe('shouldSkipEmailIntake', () => {
    it('skips an email from the SES_FROM_ADDRESS', () => {
      const result = shouldSkipEmailIntake('BCAT Onboarding <onboarding@bcatcorp.com>', 'Fwd: Rate con')
      expect(result.skip).toBe(true)
      expect(result.reason).toBe('self-sent')
    })

    it('skips subjects matching our own notification subjects', () => {
      expect(shouldSkipEmailIntake(undefined, 'New load from Jose Ramirez').skip).toBe(true)
      expect(shouldSkipEmailIntake(undefined, 'new load from maria lopez').skip).toBe(true)
      expect(shouldSkipEmailIntake(undefined, 'Re: New load from Jose Ramirez').skip).toBe(true)
    })

    it('does not skip a normal forwarded rate confirmation', () => {
      const result = shouldSkipEmailIntake('dispatch@broker.com', 'FW: Load 12345 rate confirmation')
      expect(result.skip).toBe(false)
    })
  })

  describe('isOwnNotificationSubject', () => {
    it('matches the exported subject prefix exactly', () => {
      expect(isOwnNotificationSubject('New load from Jose Ramirez')).toBe(true)
      expect(isOwnNotificationSubject('Re: New load from Jose Ramirez')).toBe(true)
      expect(isOwnNotificationSubject('New load from Jose Ramirez - thanks')).toBe(true)
    })

    it('does not match unrelated subjects', () => {
      expect(isOwnNotificationSubject('Rate confirmation for load 123')).toBe(false)
      expect(isOwnNotificationSubject('RE:new load details')).toBe(false)
    })
  })

  describe('nameMatchesBody', () => {
    it('matches a driver name that appears verbatim in the body', () => {
      expect(nameMatchesBody('Jose Ramirez', 'The load is for Jose Ramirez please')).toBe(true)
    })

    it('ignores case and punctuation', () => {
      expect(nameMatchesBody('Jose Ramirez', 'JOSE RAMIREZ! Please confirm.')).toBe(true)
      expect(nameMatchesBody('Maria Lopez', 'Driver: maria---lopez.')).toBe(true)
    })

    it('does not match a driver name as a substring of an unrelated word', () => {
      expect(nameMatchesBody('Jose', 'The contact is Joseline Ramirez')).toBe(false)
      expect(nameMatchesBody('Maria Lopez', 'Maria Lopezenski is available')).toBe(false)
    })

    it('does not match when the driver name is very short', () => {
      expect(nameMatchesBody('Al', 'The load is for Al')).toBe(false)
    })

    it('does not match when no driver is mentioned', () => {
      expect(nameMatchesBody('Jose Ramirez', 'Here is the load info')).toBe(false)
    })

    it('matches two different drivers each as whole words when both appear', () => {
      const body = 'Jose Ramirez and Maria Lopez both submitted docs'
      expect(nameMatchesBody('Jose Ramirez', body)).toBe(true)
      expect(nameMatchesBody('Maria Lopez', body)).toBe(true)
    })
  })
})

describe('email intake handler routes', () => {
  describe('secret gate', () => {
    it('rejects a request with the wrong secret', async () => {
      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: 'wrong-secret',
          gmailMessageId: GMAIL_ID,
          from: 'dispatch@broker.com',
          subject: 'Rate con',
          body: 'Jose Ramirez',
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
        }),
      )
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' })
    })

    it('fails closed when LOADS_INTAKE_SECRET is missing', async () => {
      process.env.LOADS_INTAKE_SECRET = ''
      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'dispatch@broker.com',
          subject: 'Rate con',
          body: 'Jose Ramirez',
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
        }),
      )
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' })
    })
  })

  describe('POST /email-intake/prepare', () => {
    it('skips self-sent emails', async () => {
      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'onboarding@bcatcorp.com',
          subject: 'Rate con',
          body: 'Jose Ramirez',
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
        }),
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ skipped: true, reason: 'self-sent' })
    })

    it('skips our own notification subjects', async () => {
      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'loads@broker.com',
          subject: 'New load from Jose Ramirez',
          body: 'attached',
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
        }),
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ skipped: true, reason: 'own-notification' })
    })

    it('skips a duplicate gmailMessageId and returns the existing submissionId', async () => {
      // A real duplicate is one that already COMMITTED: docs persisted and notification sent.
      // An uncommitted row is a half-finished attempt and must be resumable instead (below).
      currentTables['DriverSubmission-test'][SUBMISSION_EMAIL_ID] = {
        id: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NOTIFIED',
        source: 'EMAIL',
        externalMessageId: GMAIL_ID,
      }
      currentTables['DriverSubmissionDoc-test']['doc-1'] = {
        id: 'doc-1',
        submissionId: SUBMISSION_EMAIL_ID,
        kind: 'RATECON',
        notifiedAt: '2026-09-30T00:00:00.000Z',
      }

      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'dispatch@broker.com',
          subject: 'Rate con',
          body: 'Jose Ramirez',
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
        }),
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        skipped: true,
        reason: 'duplicate',
        submissionId: SUBMISSION_EMAIL_ID,
      })
    })

    it('resolves a single matching driver and creates a submission', async () => {
      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'dispatch@broker.com',
          subject: 'Rate con',
          body: 'Please send the rate con to Jose Ramirez',
          attachments: [
            { fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 },
            { fileName: 'rc.pdf', contentType: 'application/pdf', byteSize: 5000 },
          ],
        }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as {
        submissionId: string
        driverId: string
        driverName: string
        driverMatched: boolean
        targets: Array<{ pageNumber: number; url: string; s3Key: string }>
      }
      expect(body.submissionId).toBe(SUBMISSION_EMAIL_ID)
      expect(body.driverId).toBe(DRIVER_A_ID)
      expect(body.driverName).toBe('Jose Ramirez')
      expect(body.driverMatched).toBe(true)
      expect(body.targets).toHaveLength(2)
      expect(body.targets[0].s3Key).toMatch(/\.jpg$/)
      expect(body.targets[1].s3Key).toMatch(/\.pdf$/)

      const putCalls = mockDynamoSend.mock.calls.filter((c) => c[0] instanceof PutCommand)
      const submissionPut = putCalls.find(
        (c) => (c[0].input as MockDynamoPutInput).TableName === 'DriverSubmission-test',
      )!
      const item = submissionPut[0].input.Item!
      expect(item.source).toBe('EMAIL')
      expect(item.externalMessageId).toBe(GMAIL_ID)
      expect(item.note).not.toContain('DRIVER NOT MATCHED')
    })

    it('marks unmatched when no driver matches and still ingests', async () => {
      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'dispatch@broker.com',
          subject: 'Rate con',
          body: 'No driver name here',
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
        }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.driverId).toBe('UNMATCHED')
      expect(body.driverMatched).toBe(false)

      const putCalls = mockDynamoSend.mock.calls.filter((c) => c[0] instanceof PutCommand)
      const submissionPut = putCalls.find(
        (c) => (c[0].input as MockDynamoPutInput).TableName === 'DriverSubmission-test',
      )!
      expect(submissionPut).toBeDefined()
      const item = submissionPut[0].input.Item!
      expect(item.note).toContain('DRIVER NOT MATCHED')
    })

    it('marks unmatched when two drivers match', async () => {
      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'dispatch@broker.com',
          subject: 'Rate con',
          body: 'Jose Ramirez and Maria Lopez',
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 1000 }],
        }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.driverId).toBe('UNMATCHED')
      expect(body.driverName).toMatch(/Unmatched \(2 candidates\)/)
      expect(body.driverMatched).toBe(false)
    })

  })

  describe('POST /email-intake/commit', () => {
    it('rejects a commit for a driver-sourced submission', async () => {
      currentTables['DriverSubmission-test']['sub-driver'] = {
        id: 'sub-driver',
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NEW',
        source: 'PWA',
        externalMessageId: null,
      }

      const res = await handler(
        baseEvent('/email-intake/commit', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          submissionId: 'sub-driver',
          attachments: [],
        }),
      )
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body).error).toBe('Submission not found')
    })

    it('rejects a commit when the gmailMessageId does not match the stored one', async () => {
      currentTables['DriverSubmission-test'][SUBMISSION_EMAIL_ID] = {
        id: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NEW',
        source: 'EMAIL',
        externalMessageId: 'different-gmail-id',
      }

      const res = await handler(
        baseEvent('/email-intake/commit', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          submissionId: SUBMISSION_EMAIL_ID,
          attachments: [],
        }),
      )
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body).error).toBe('Submission not found')
    })

    it('reports in-flight, not duplicate, when a concurrent call already wrote the row', async () => {
      // The row exists but the GSI has not caught up (eventually consistent), so the index lookup
      // misses and the conditional Put loses the race. The caller must be told to try again later
      // rather than retire the message: the concurrent call may still fail before it commits.
      currentTables['DriverSubmission-test'][SUBMISSION_EMAIL_ID] = {
        id: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NEW',
        source: 'EMAIL',
        // no externalMessageId: invisible to querySubmissionByExternalMessageId
      }

      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'ivan@bcatcorp.com',
          subject: 'FW: rate con',
          body: 'Jose Ramirez',
          attachments: [{ fileName: 'rc.pdf', contentType: 'application/pdf', byteSize: 2000 }],
        }),
      )

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.skipped).toBe(true)
      expect(body.reason).toBe('in-flight')
    })

    it('re-presigns targets when a previous attempt never committed, so a failed upload can retry', async () => {
      // Simulates the bridge dying between prepare and commit: the row exists at NEW with
      // pendingUploads, but no DriverSubmissionDoc was ever written and nothing was notified.
      currentTables['DriverSubmission-test'][SUBMISSION_EMAIL_ID] = {
        id: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NEW',
        source: 'EMAIL',
        externalMessageId: GMAIL_ID,
        // No `pendingUploads` attribute at all: the first attempt can die before the map is ever
        // written, and a nested `SET pendingUploads.RATECON` would fail on that row in real
        // DynamoDB. Resume must handle the attribute being absent.
      }

      const res = await handler(
        baseEvent('/email-intake/prepare', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          from: 'ivan@bcatcorp.com',
          subject: 'FW: rate con',
          body: 'Jose Ramirez',
          attachments: [{ fileName: 'rc.pdf', contentType: 'application/pdf', byteSize: 2000 }],
        }),
      )

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.skipped).toBeUndefined()
      expect(body.resumed).toBe(true)
      expect(body.submissionId).toBe(SUBMISSION_EMAIL_ID)
      expect(body.targets).toHaveLength(1)
      expect(body.targets[0].s3Key).toContain(`${DRIVER_A_ID}/${SUBMISSION_EMAIL_ID}/RATECON/`)
    })

    it('refuses an s3Key outside this submission, so no unrelated object can be emailed out', async () => {
      currentTables['DriverSubmission-test'][SUBMISSION_EMAIL_ID] = {
        id: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NEW',
        source: 'EMAIL',
        externalMessageId: GMAIL_ID,
        pendingUploads: { RATECON: [] },
      }

      const res = await handler(
        baseEvent('/email-intake/commit', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          submissionId: SUBMISSION_EMAIL_ID,
          attachments: [
            { fileName: 'payroll.pdf', contentType: 'application/pdf', byteSize: 2000, s3Key: 'driver-docs/other-driver/other-submission/RATECON/1-1.pdf' },
          ],
        }),
      )
      expect(res.statusCode).toBe(403)
      // Nothing was persisted and, critically, nothing was emailed.
      expect(sesSendMock).not.toHaveBeenCalled()
    })

    it('verifies S3 heads, persists docs, and notifies through the same path as the PWA', async () => {
      currentTables['DriverSubmission-test'][SUBMISSION_EMAIL_ID] = {
        id: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NEW',
        source: 'EMAIL',
        externalMessageId: GMAIL_ID,
        pendingUploads: { RATECON: [] },
      }

      const res = await handler(
        baseEvent('/email-intake/commit', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          submissionId: SUBMISSION_EMAIL_ID,
          attachments: [
            { fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 2000, s3Key: `driver-docs/${DRIVER_A_ID}/${SUBMISSION_EMAIL_ID}/RATECON/12345-1.jpg` },
          ],
        }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.notified).toBe(true)

      const headCalls = mockS3Send.mock.calls.filter((c) => c[0] instanceof HeadObjectCommand)
      // One HEAD during commit validation and one more when notification buffers the attachment.
      expect(headCalls.length).toBe(2)

      const putCalls = mockDynamoSend.mock.calls.filter((c) => c[0] instanceof PutCommand)
      const docPut = putCalls.find(
        (c) => (c[0].input as MockDynamoPutInput).TableName === 'DriverSubmissionDoc-test',
      )!
      expect(docPut).toBeDefined()
      const doc = docPut[0].input.Item!
      expect(doc.kind).toBe('RATECON')
      expect(doc.driverId).toBe(DRIVER_A_ID)

      expect(sesSendMock).toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', expect.anything())
    })

    it('is idempotent when the submission is already committed', async () => {
      currentTables['DriverSubmission-test'][SUBMISSION_EMAIL_ID] = {
        id: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        driverName: 'Jose Ramirez',
        status: 'NOTIFIED',
        source: 'EMAIL',
        externalMessageId: GMAIL_ID,
      }
      currentTables['DriverSubmissionDoc-test']['doc-1'] = {
        id: 'doc-1',
        submissionId: SUBMISSION_EMAIL_ID,
        driverId: DRIVER_A_ID,
        kind: 'RATECON',
        s3Key: 'driver-docs/x/y/RATECON/1.jpg',
        pageNumber: 1,
        uploadedAt: '2026-09-01T00:00:00.000Z',
      }

      const res = await handler(
        baseEvent('/email-intake/commit', {
          secret: SECRET,
          gmailMessageId: GMAIL_ID,
          submissionId: SUBMISSION_EMAIL_ID,
          attachments: [{ fileName: 'rc.jpg', contentType: 'image/jpeg', byteSize: 2000, s3Key: 'driver-docs/x/y/RATECON/1.jpg' }],
        }),
      )
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.notified).toBe(true)

      const putCalls = mockDynamoSend.mock.calls.filter((c) => c[0] instanceof PutCommand)
      const docPuts = putCalls.filter(
        (c) => (c[0].input as MockDynamoPutInput).TableName === 'DriverSubmissionDoc-test',
      )
      expect(docPuts).toHaveLength(0)
      expect(sesSendMock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
