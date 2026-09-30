import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as HandlerModule from './handler'

const mockVerify = vi.hoisted(() => vi.fn())
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({ verify: mockVerify }),
  },
}))

const mockDynamoSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockDynamoSend }) },
  ScanCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input
  }),
  GetCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input
  }),
  PutCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input
  }),
  UpdateCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input
  }),
  QueryCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input
  }),
}))

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(function () {}),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: vi.fn() }
  }),
  GetObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
}))

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: vi.fn(function () {
    return { send: vi.fn() }
  }),
  SendEmailCommand: vi.fn(),
}))

vi.hoisted(() => {
  process.env.DRIVER_TABLE_NAME = 'Driver-test'
  process.env.DRIVER_PAY_SETTING_TABLE_NAME = 'DriverPaySetting-test'
  process.env.DRIVER_SUBMISSION_TABLE_NAME = 'DriverSubmission-test'
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = 'DriverSubmissionDoc-test'
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

import { handler } from './handler'

type Event = Parameters<typeof HandlerModule.handler>[0]

function baseEvent(rawPath: string, token: string): Event {
  return {
    rawPath,
    requestContext: { http: { method: 'GET' } },
    queryStringParameters: {},
    headers: { authorization: `Bearer ${token}` },
    body: null,
  }
}

describe('driver-app-api email verification regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerify.mockReset()
    mockDynamoSend.mockReset()
    mockDynamoSend.mockResolvedValue({ Items: [] })
  })

  it('rejects a verified email claim of false before touching roster data', async () => {
    mockVerify.mockResolvedValue({
      email: 'attacker@example.com',
      email_verified: false,
    })

    const response = await handler(baseEvent('/me', 'unverified-token'))

    expect(response.statusCode).toBe(401)
    expect(JSON.parse(response.body)).toMatchObject({
      error: expect.stringMatching(/email not verified/i),
    })
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })

  it('rejects a missing email_verified claim before touching roster data', async () => {
    mockVerify.mockResolvedValue({
      email: 'attacker@example.com',
    })

    const response = await handler(baseEvent('/me', 'missing-verified-token'))

    expect(response.statusCode).toBe(401)
    expect(JSON.parse(response.body)).toMatchObject({
      error: expect.stringMatching(/email not verified/i),
    })
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })

  it('succeeds only when email_verified is explicitly true', async () => {
    mockVerify.mockResolvedValue({
      email: 'driver.a@example.com',
      email_verified: true,
    })
    function tableNameFrom(cmd: unknown): string | undefined {
      if (cmd && typeof cmd === 'object' && 'input' in cmd) {
        const input = cmd.input
        if (
          input &&
          typeof input === 'object' &&
          'TableName' in input &&
          typeof input.TableName === 'string'
        ) {
          return input.TableName
        }
      }
      return undefined
    }
    mockDynamoSend.mockImplementation(async (cmd: unknown) => {
      const tableName = tableNameFrom(cmd)
      if (tableName === 'Driver-test') {
        return {
          Items: [
            {
              id: 'drv-a',
              name: 'Driver A',
              active: true,
              email: 'driver.a@example.com',
            },
          ],
        }
      }
      if (tableName === 'DriverPaySetting-test') {
        return {
          Items: [
            {
              driverId: 'drv-a',
              active: true,
              payGroup: 'AMAZON',
              email: 'driver.a@example.com',
            },
          ],
        }
      }
      return { Items: [] }
    })

    const response = await handler(baseEvent('/me', 'verified-token'))

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      driverId: 'drv-a',
      name: 'Driver A',
    })
  })
})
