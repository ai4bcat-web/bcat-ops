import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest'

process.env.TABLE_NAME = 'VendorPayable-table'
process.env.BUCKET_NAME = 'bcat-bucket'
process.env.VENDOR_AP_INTAKE_SECRET = 'intake-secret'

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(),
  GetItemCommand: vi.fn(),
  PutItemCommand: vi.fn(),
}))

vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: vi.fn((value) => value),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  HeadObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}))

import { handler } from './handler'
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const dynamoSend = vi.fn()
const s3Send = vi.fn()

const DynamoDBClientMock = DynamoDBClient as unknown as MockedFunction<typeof DynamoDBClient>
const S3ClientMock = S3Client as unknown as MockedFunction<typeof S3Client>
const getSignedUrlMock = getSignedUrl as unknown as MockedFunction<typeof getSignedUrl>

function makeEvent(body: unknown) {
  return {
    body: JSON.stringify(body),
    requestContext: { http: { method: 'POST' } },
  }
}

interface MockCommand {
  mock: { calls: [Record<string, unknown>][] }
}

function lastCall(commandMock: MockCommand): Record<string, unknown> {
  const calls = commandMock.mock.calls
  if (calls.length === 0) throw new Error('no calls recorded')
  return calls[calls.length - 1][0] as Record<string, unknown>
}

describe('vendor-ap-intake handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    DynamoDBClientMock.mockImplementation(function () { return { send: dynamoSend } })
    S3ClientMock.mockImplementation(function () { return { send: s3Send } })
    getSignedUrlMock.mockResolvedValue('https://signed.url')
  })

  describe('prepare', () => {
    it('returns presigned PUT URLs for each attachment when the row does not exist', async () => {
      dynamoSend.mockResolvedValue({ Item: undefined })

      const res = await handler(
        makeEvent({
          action: 'prepare',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice from Vendor',
          from: 'vendor@example.com',
          receivedAt: '2026-09-28T10:00:00Z',
          emailBody: 'Please pay this invoice.',
          attachments: [
            { name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 },
            { name: 'receipt.png', contentType: 'image/png', size: 67890 },
          ],
        })
      )

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body as string)
      expect(body.ok).toBe(true)
      expect(body.duplicate).toBe(false)
      expect(body.rowId).toBe('email:msg-123')
      expect(body.uploadUrls).toHaveLength(2)

      const first = body.uploadUrls[0]
      expect(first.url).toBe('https://signed.url')
      expect(first.name).toBe('invoice.pdf')
      expect(first.contentType).toBe('application/pdf')
      expect(first.s3Key).toMatch(/^intake-pdfs\/vendor-ap\/[a-f0-9]+\/0-invoice\.pdf$/)

      const second = body.uploadUrls[1]
      expect(second.s3Key).toMatch(/^intake-pdfs\/vendor-ap\/[a-f0-9]+\/1-receipt\.png$/)

      expect(GetItemCommand).toHaveBeenCalled()
      const getKey = lastCall(GetItemCommand as unknown as MockCommand)
      expect(getKey).toMatchObject({ TableName: 'VendorPayable-table', Key: { id: 'email:msg-123' }, ConsistentRead: true })
    })

    it('returns a duplicate when the row already exists', async () => {
      dynamoSend.mockResolvedValue({ Item: { id: 'email:msg-123' } })

      const res = await handler(
        makeEvent({
          action: 'prepare',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ name: 'a.pdf', contentType: 'application/pdf', size: 1 }],
        })
      )

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body as string)
      expect(body.duplicate).toBe(true)
      expect(body.uploadUrls).toBeUndefined()
      expect(getSignedUrl).not.toHaveBeenCalled()
    })

    it('rejects an invalid secret', async () => {
      const res = await handler(
        makeEvent({
          action: 'prepare',
          secret: 'wrong',
          messageId: 'msg-123',
          subject: 'Invoice',
        })
      )

      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body as string).error).toBe('unauthorized')
    })

    it('rejects a missing messageId', async () => {
      const res = await handler(
        makeEvent({
          action: 'prepare',
          secret: 'intake-secret',
          subject: 'Invoice',
        })
      )

      expect(res.statusCode).toBe(400)
    })

    it('rejects attachments larger than the Gmail limit', async () => {
      dynamoSend.mockResolvedValue({ Item: undefined })

      const res = await handler(
        makeEvent({
          action: 'prepare',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ name: 'huge.pdf', contentType: 'application/pdf', size: 26 * 1024 * 1024 }],
        })
      )

      expect(res.statusCode).toBe(422)
    })

    it('normalizes unsafe content types to application/octet-stream', async () => {
      dynamoSend.mockResolvedValue({ Item: undefined })

      const res = await handler(
        makeEvent({
          action: 'prepare',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ name: 'spreadsheet.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 1024 }],
        })
      )

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body as string)
      expect(body.uploadUrls[0].contentType).toBe('application/octet-stream')
      expect(body.uploadUrls[0].s3Key).toMatch(/\.xlsx$/)
    })

    it('falls back to a bin extension when the original extension is unknown', async () => {
      dynamoSend.mockResolvedValue({ Item: undefined })

      const res = await handler(
        makeEvent({
          action: 'prepare',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ name: 'weird', contentType: 'application/octet-stream', size: 1024 }],
        })
      )

      const body = JSON.parse(res.body as string)
      expect(body.uploadUrls[0].s3Key).toMatch(/\.bin$/)
    })
  })

  describe('commit', () => {
    it('creates the VendorPayable row after verifying attachments', async () => {
      dynamoSend
        .mockResolvedValueOnce({ Item: undefined }) // existence check
        .mockResolvedValueOnce({}) // put success
      s3Send
        .mockResolvedValueOnce({ ContentLength: 12345, ContentType: 'application/pdf' })
        .mockResolvedValueOnce({ ContentLength: 67890, ContentType: 'image/png' })

      const res = await handler(
        makeEvent({
          action: 'commit',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice from Vendor',
          from: 'vendor@example.com',
          receivedAt: '2026-09-28T10:00:00Z',
          emailBody: 'Please pay.',
          attachments: [
            { s3Key: 'intake-pdfs/vendor-ap/abc/0-invoice.pdf', name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 },
            { s3Key: 'intake-pdfs/vendor-ap/abc/1-receipt.png', name: 'receipt.png', contentType: 'image/png', size: 67890 },
          ],
        })
      )

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body as string)
      expect(body.ok).toBe(true)
      expect(body.duplicate).toBe(false)
      expect(body.rowId).toBe('email:msg-123')

      expect(HeadObjectCommand).toHaveBeenCalledTimes(2)
      expect(PutItemCommand).toHaveBeenCalledTimes(1)

      const item = lastCall(PutItemCommand as unknown as MockCommand).Item as Record<string, unknown> | undefined
      expect(item).toBeDefined()
      expect(item).toMatchObject({
        status: 'NEED_TO_PAY',
        source: 'EMAIL',
        sourceMessageId: 'msg-123',
        subject: 'Invoice from Vendor',
        fromEmail: 'vendor@example.com',
        emailBody: 'Please pay.',
        receivedAt: '2026-09-28T10:00:00.000Z',
      })

      const attachments = item!.attachments as unknown[]
      expect(attachments).toHaveLength(2)
      expect(attachments[0]).toMatchObject({ key: 'intake-pdfs/vendor-ap/abc/0-invoice.pdf', name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 })
    })

    it('treats an existing row as a duplicate on commit', async () => {
      dynamoSend.mockResolvedValue({ Item: { id: 'email:msg-123' } })

      const res = await handler(
        makeEvent({
          action: 'commit',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ s3Key: 'k', name: 'a.pdf', contentType: 'application/pdf', size: 1 }],
        })
      )

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body as string).duplicate).toBe(true)
      expect(s3Send).not.toHaveBeenCalled()
      expect(PutItemCommand).not.toHaveBeenCalled()
    })

    it('returns 422 when an attachment size does not match', async () => {
      dynamoSend.mockResolvedValueOnce({ Item: undefined })
      s3Send.mockResolvedValueOnce({ ContentLength: 999, ContentType: 'application/pdf' })

      const res = await handler(
        makeEvent({
          action: 'commit',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ s3Key: 'k', name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 }],
        })
      )

      expect(res.statusCode).toBe(422)
      expect(PutItemCommand).not.toHaveBeenCalled()
    })

    it('returns 503 when an attachment is missing from S3 so the bridge retries', async () => {
      dynamoSend.mockResolvedValueOnce({ Item: undefined })
      s3Send.mockRejectedValueOnce({ name: 'NotFound' })

      const res = await handler(
        makeEvent({
          action: 'commit',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ s3Key: 'k', name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 }],
        })
      )

      expect(res.statusCode).toBe(503)
      expect(PutItemCommand).not.toHaveBeenCalled()
    })

    it('treats a conditional put conflict as a duplicate', async () => {
      dynamoSend.mockResolvedValueOnce({ Item: undefined })
      s3Send.mockResolvedValueOnce({ ContentLength: 1, ContentType: 'application/pdf' })
      dynamoSend.mockRejectedValueOnce({ name: 'ConditionalCheckFailedException' })

      const res = await handler(
        makeEvent({
          action: 'commit',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: 'Invoice',
          attachments: [{ s3Key: 'k', name: 'a.pdf', contentType: 'application/pdf', size: 1 }],
        })
      )

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body as string).duplicate).toBe(true)
    })

    it('uses "no subject" and null for optional fields when omitted', async () => {
      dynamoSend
        .mockResolvedValueOnce({ Item: undefined })
        .mockResolvedValueOnce({})
      s3Send.mockResolvedValueOnce({ ContentLength: 1, ContentType: 'application/pdf' })

      const res = await handler(
        makeEvent({
          action: 'commit',
          secret: 'intake-secret',
          messageId: 'msg-123',
          subject: '',
          attachments: [{ s3Key: 'k', name: 'a.pdf', contentType: 'application/pdf', size: 1 }],
        })
      )

      expect(res.statusCode).toBe(200)
      const item = lastCall(PutItemCommand as unknown as MockCommand).Item
      expect(item).toMatchObject({ subject: 'no subject', fromEmail: null, emailBody: null })
    })
  })
})
