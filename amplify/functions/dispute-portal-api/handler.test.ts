import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type * as HandlerModule from './handler'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockS3Send = vi.hoisted(() => vi.fn())
const mockGetSignedUrl = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(function () {}),
}))

vi.mock('@aws-sdk/lib-dynamodb', async () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockDynamoSend }) },
  ScanCommand: vi.fn(function (params: unknown) { return params }),
  GetCommand: vi.fn(function (params: unknown) { return params }),
  PutCommand: vi.fn(function (params: unknown) { return params }),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () { return { send: mockS3Send } }),
  PutObjectCommand: vi.fn(function (params: unknown) { return params }),
  HeadObjectCommand: vi.fn(function (params: unknown) { return params }),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}))

let handler: typeof HandlerModule.handler
let validateListToken: typeof HandlerModule.validateListToken
let validateDateRange: typeof HandlerModule.validateDateRange
let validateSubmission: typeof HandlerModule.validateSubmission
let projectBoardItem: typeof HandlerModule.projectBoardItem

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-amazon-dispute'
  process.env.BUCKET_NAME = 'test-bucket'
  const mod = await import('./handler')
  handler = mod.handler
  validateListToken = mod.validateListToken
  validateDateRange = mod.validateDateRange
  validateSubmission = mod.validateSubmission
  projectBoardItem = mod.projectBoardItem
})

function baseEvent(body: unknown, method = 'POST') {
  return {
    body: JSON.stringify(body),
    requestContext: { http: { method } },
  }
}

const validEvidence = (submissionId: string, kind: 'CONFIRMATION' | 'PHOTO' = 'CONFIRMATION') => ({
  s3Key: `dispute-proofs/${submissionId}/00001111-2222-3333-4444-555566667777.png`,
  fileName: `proof.png`,
  contentType: kind === 'CONFIRMATION' ? 'application/pdf' : 'image/png',
  size: kind === 'CONFIRMATION' ? 1024 : 2048,
  kind,
})

const validSubmitPayload = (submissionId: string) => ({
  submissionId,
  driverName: 'Juan Pérez',
  tripNumber: 'TRP-100',
  payPeriod: '2026-09-13',
  shipmentDate: '2026-09-15',
  amountPaid: 0,
  amountRequested: 250,
  description: 'Short payment for detention',
  evidence: [validEvidence(submissionId, 'CONFIRMATION')],
})

const base64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64')

class ConditionalCheckFailedException extends Error {
  name = 'ConditionalCheckFailedException'
}

describe('dispute-portal-api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('validateListToken', () => {
    it('accepts a base64-encoded {id} token', () => {
      expect(validateListToken(base64({ id: 'abc123' }))).toEqual({ id: 'abc123' })
    })

    it('returns null for missing or null tokens', () => {
      expect(validateListToken(undefined)).toBeNull()
      expect(validateListToken(null)).toBeNull()
    })

    it('rejects non-base64 data', () => {
      expect(() => validateListToken('not-base64%%%')).toThrow('Invalid nextToken')
    })

    it('rejects non-object JSON', () => {
      expect(() => validateListToken(base64([1, 2, 3]))).toThrow('Invalid nextToken')
      expect(() => validateListToken(base64('nope'))).toThrow('Invalid nextToken')
    })

    it('rejects tokens with extra keys or missing/non-string id', () => {
      expect(() => validateListToken(base64({ id: 'abc', extra: true }))).toThrow('Invalid nextToken')
      expect(() => validateListToken(base64({}))).toThrow('Invalid nextToken')
      expect(() => validateListToken(base64({ id: 123 }))).toThrow('Invalid nextToken')
    })
  })

  describe('validateDateRange', () => {
    it('accepts Sunday pay period and a same-week shipment date', () => {
      expect(validateDateRange('2026-09-13', '2026-09-15')).toEqual({ payPeriod: '2026-09-13', shipmentDate: '2026-09-15' })
      expect(validateDateRange('2026-09-13', '2026-09-19')).toEqual({ payPeriod: '2026-09-13', shipmentDate: '2026-09-19' })
    })

    it('rejects pay periods that are not Sundays', () => {
      expect(() => validateDateRange('2026-09-14', '2026-09-15')).toThrow('payPeriod must be a Sunday')
    })

    it('rejects shipment dates outside Sunday–Saturday', () => {
      expect(() => validateDateRange('2026-09-13', '2026-09-12')).toThrow('within the selected pay period')
      expect(() => validateDateRange('2026-09-13', '2026-09-20')).toThrow('within the selected pay period')
    })
  })

  describe('validateSubmission', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    it('accepts one confirmation and up to five photos', () => {
      const payload = {
        ...validSubmitPayload(id),
        evidence: [
          validEvidence(id, 'CONFIRMATION'),
          { ...validEvidence(id, 'PHOTO'), s3Key: `dispute-proofs/${id}/11111111-2222-3333-4444-555566667777.jpg`, fileName: 'p1.jpg' },
        ],
      }
      const result = validateSubmission(payload)
      expect(result.evidence).toHaveLength(2)
      expect(result.amountRequested).toBe(250)
    })

    it('requires at least one confirmation', () => {
      const payload = {
        ...validSubmitPayload(id),
        evidence: [{ ...validEvidence(id, 'PHOTO'), s3Key: `dispute-proofs/${id}/11111111-2222-3333-4444-555566667777.jpg` }],
      }
      expect(() => validateSubmission(payload)).toThrow('Exactly one confirmation file is required')
    })

    it('rejects more than one confirmation', () => {
      const payload = {
        ...validSubmitPayload(id),
        evidence: [validEvidence(id, 'CONFIRMATION'), { ...validEvidence(id, 'CONFIRMATION'), s3Key: `dispute-proofs/${id}/x.pdf` }],
      }
      expect(() => validateSubmission(payload)).toThrow('Exactly one confirmation file is required')
    })

    it('rejects more than five photos', () => {
      const payload = {
        ...validSubmitPayload(id),
        evidence: [
          validEvidence(id, 'CONFIRMATION'),
          ...Array.from({ length: 6 }, (_, i) => ({
            ...validEvidence(id, 'PHOTO'),
            s3Key: `dispute-proofs/${id}/p${i}.jpg`,
            fileName: `p${i}.jpg`,
          })),
        ],
      }
      expect(() => validateSubmission(payload)).toThrow('At most 5 photos are allowed')
    })

    it('accepts any image type (phone HEIC) for both kinds and rejects non-image files', () => {
      const heic = (kind: 'CONFIRMATION' | 'PHOTO') => ({
        ...validSubmitPayload(id),
        evidence: [
          { ...validEvidence(id, 'CONFIRMATION'), contentType: kind === 'CONFIRMATION' ? 'image/heic' : 'application/pdf' },
          ...(kind === 'PHOTO' ? [{ ...validEvidence(id, 'PHOTO'), contentType: 'image/heic' }] : []),
        ],
      })
      expect(() => validateSubmission(heic('CONFIRMATION'))).not.toThrow()
      expect(() => validateSubmission(heic('PHOTO'))).not.toThrow()
      for (const contentType of ['application/zip', 'image/svg+xml']) {
        const bad = {
          ...validSubmitPayload(id),
          evidence: [{ ...validEvidence(id, 'CONFIRMATION'), contentType }],
        }
        expect(() => validateSubmission(bad)).toThrow('Invalid contentType for CONFIRMATION')
      }
    })

    it('rejects evidence keys outside the submission prefix', () => {
      const payload = {
        ...validSubmitPayload(id),
        evidence: [{ ...validEvidence(id, 'CONFIRMATION'), s3Key: 'dispute-proofs/other-sub/p.pdf' }],
      }
      expect(() => validateSubmission(payload)).toThrow('Invalid evidence key')
    })

    it('rejects PDF photos', () => {
      const payload = {
        ...validSubmitPayload(id),
        evidence: [validEvidence(id, 'CONFIRMATION')],
      }
      // Swap kind to PHOTO while keeping application/pdf
      payload.evidence[0].kind = 'PHOTO'
      expect(() => validateSubmission(payload)).toThrow('Invalid contentType for PHOTO')
    })
  })

  describe('projectBoardItem', () => {
    it('whitelists only the public board fields', () => {
      const item = projectBoardItem({
        id: '1',
        driverName: 'Juan',
        tripNumber: 'TRP-1',
        payPeriod: '2026-09-13',
        shipmentDate: '2026-09-15',
        status: 'PENDING',
        amountPaid: 999,
        amountRequested: 250,
        description: 'secret',
        evidence: '[]',
      })
      expect(item).toEqual({
        id: '1',
        driverName: 'Juan',
        tripNumber: 'TRP-1',
        payPeriod: '2026-09-13',
        shipmentDate: '2026-09-15',
        status: 'PENDING',
      })
      expect('amountPaid' in item).toBe(false)
      expect('description' in item).toBe(false)
      expect('evidence' in item).toBe(false)
    })

    it('shows legacy rows with a missing or unknown status as Pending rather than failing the board', () => {
      expect(projectBoardItem({ id: '1', driverName: 'Juan' }).status).toBe('PENDING')
      expect(projectBoardItem({ id: '1', driverName: 'Juan', status: 'HACKED' }).status).toBe('PENDING')
    })
  })

  describe('handler list', () => {
    it('projects a whitelisted board and returns a nextToken', async () => {
      mockDynamoSend.mockResolvedValueOnce({
        Items: [
          { id: '2', driverName: 'B', tripNumber: 'T2', payPeriod: '2026-09-13', shipmentDate: '2026-09-14', status: 'POSTED', submittedAt: '2026-09-15T00:00:00Z' },
          { id: '1', driverName: 'A', tripNumber: 'T1', payPeriod: '2026-09-13', shipmentDate: '2026-09-14', status: 'PENDING', submittedAt: '2026-09-16T00:00:00Z', description: 'secret' },
        ],
        LastEvaluatedKey: { id: '1' },
      })
      const res = await handler(baseEvent({ action: 'list' }))
      const body = JSON.parse(res.body)
      expect(body.items).toHaveLength(2)
      expect(body.items[0].id).toBe('1')
      expect(body.items[0]).not.toHaveProperty('description')
      expect(body.items[0]).not.toHaveProperty('submittedAt')
      expect(Buffer.from(body.nextToken, 'base64').toString('utf-8')).toBe(JSON.stringify({ id: '1' }))
      expect(mockDynamoSend).toHaveBeenCalledTimes(1)
      const cmd = mockDynamoSend.mock.calls[0][0]
      expect(cmd.Limit).toBe(100)
      expect(cmd.ProjectionExpression).toContain('driverName, tripNumber, payPeriod, shipmentDate')
    })

    it('rejects malformed nextToken', async () => {
      const res = await handler(baseEvent({ action: 'list', payload: { nextToken: 'bad' } }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toMatch(/Invalid nextToken/)
    })
  })

  describe('handler upload', () => {
    it('returns a signed PUT URL scoped to the submission prefix', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/put-url')
      const res = await handler(baseEvent({ action: 'upload', payload: { submissionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fileName: 'rate-confirm.pdf', contentType: 'application/pdf', size: 1024, kind: 'CONFIRMATION' } }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.uploadUrl).toBe('https://s3.example.com/put-url')
      expect(body.s3Key.startsWith('dispute-proofs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/')).toBe(true)
      expect(body.s3Key.endsWith('.pdf')).toBe(true)

      const signedCommand = mockGetSignedUrl.mock.calls[0][1]
      expect(signedCommand.ContentType).toBe('application/pdf')
      expect(signedCommand.ContentLength).toBe(1024)
      expect(signedCommand.IfNoneMatch).toBe('*')
    })

    it('rejects unsupported file types', async () => {
      const res = await handler(baseEvent({ action: 'upload', payload: { submissionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fileName: 'foo.txt', contentType: 'text/plain', size: 1024, kind: 'CONFIRMATION' } }))
      expect(res.statusCode).toBe(400)
    })

    it('rejects files over 10 MiB', async () => {
      const res = await handler(baseEvent({ action: 'upload', payload: { submissionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fileName: 'huge.pdf', contentType: 'application/pdf', size: 11 * 1024 * 1024, kind: 'CONFIRMATION' } }))
      expect(res.statusCode).toBe(400)
    })
  })

  describe('handler submit', () => {
    const submissionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    it('creates a PENDING dispute after validating evidence metadata', async () => {
      mockS3Send.mockResolvedValue({ ContentLength: 1024, ContentType: 'application/pdf' })
      mockDynamoSend.mockResolvedValue({})

      const res = await handler(baseEvent({ action: 'submit', payload: validSubmitPayload(submissionId) }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.id).toBe(submissionId)
      expect(body.duplicate).toBe(false)

      const putCall = mockDynamoSend.mock.calls.find((c) => c[0].ConditionExpression === 'attribute_not_exists(id)')
      expect(putCall).toBeTruthy()
      const item = putCall![0].Item
      expect(item.status).toBe('PENDING')
      expect(item.source).toBe('DRIVER_PORTAL')
      expect(item.evidence).toBe(JSON.stringify([validEvidence(submissionId, 'CONFIRMATION')]))
      expect(item.id).toBe(submissionId)
    })

    it('rejects a status injection attempt', async () => {
      const payload = { ...validSubmitPayload(submissionId), status: 'PAID' }
      mockS3Send.mockResolvedValue({ ContentLength: 1024, ContentType: 'application/pdf' })
      mockDynamoSend.mockResolvedValue({})

      const res = await handler(baseEvent({ action: 'submit', payload }))
      expect(res.statusCode).toBe(200)
      const putCall = mockDynamoSend.mock.calls.find((c) => c[0].ConditionExpression === 'attribute_not_exists(id)')
      expect(putCall![0].Item.status).toBe('PENDING')
    })

    it('rejects missing proof with a 400', async () => {
      const error = new Error('NotFound')
      error.name = 'NotFound'
      mockS3Send.mockRejectedValue(error)

      const res = await handler(baseEvent({ action: 'submit', payload: validSubmitPayload(submissionId) }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toMatch(/Missing proof/)
    })

    it('rejects mismatched file size', async () => {
      mockS3Send.mockResolvedValue({ ContentLength: 999, ContentType: 'application/pdf' })

      const res = await handler(baseEvent({ action: 'submit', payload: validSubmitPayload(submissionId) }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toMatch(/Size mismatch/)
    })

    it('returns the existing id on a duplicate submission without creating a new row', async () => {
      mockS3Send.mockResolvedValue({ ContentLength: 1024, ContentType: 'application/pdf' })
      mockDynamoSend
        .mockRejectedValueOnce(new ConditionalCheckFailedException())
        .mockResolvedValueOnce({
          Item: {
            id: submissionId,
            __typename: 'AmazonDispute',
            driverName: 'Juan Pérez',
            tripNumber: 'TRP-100',
            payPeriod: '2026-09-13',
            shipmentDate: '2026-09-15',
            amountPaid: 0,
            amountRequested: 250,
            description: 'Short payment for detention',
            status: 'PENDING',
          },
        })

      const res = await handler(baseEvent({ action: 'submit', payload: validSubmitPayload(submissionId) }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.id).toBe(submissionId)
      expect(body.duplicate).toBe(true)
      expect(mockDynamoSend).toHaveBeenCalledTimes(2)
    })

    it('rejects a conflicting duplicate submissionId', async () => {
      mockS3Send.mockResolvedValue({ ContentLength: 1024, ContentType: 'application/pdf' })
      mockDynamoSend
        .mockRejectedValueOnce(new ConditionalCheckFailedException())
        .mockResolvedValueOnce({
          Item: {
            id: submissionId,
            driverName: 'Other Driver',
            tripNumber: 'TRP-999',
            payPeriod: '2026-09-13',
            shipmentDate: '2026-09-15',
            amountPaid: 0,
            amountRequested: 999,
            description: 'Different',
            status: 'PENDING',
          },
        })

      const res = await handler(baseEvent({ action: 'submit', payload: validSubmitPayload(submissionId) }))
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body).error).toMatch(/different details/)
    })
  })
})
