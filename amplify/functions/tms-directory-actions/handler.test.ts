/**
 * tms-directory-actions handler tests.
 *
 * Uses the same DynamoDB mock pattern as vendor-ap-actions (vi.hoisted send mock).
 * Data client is not mocked; merge tests rely on the raw-SDK path for Customer/Location/etc.
 */

import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'

// ── Cognito mock ──────────────────────────────────────────────────────────────
const cognitoSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class CognitoIdentityProviderClient {
    send = cognitoSend
  }
  class AdminGetUserCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { CognitoIdentityProviderClient, AdminGetUserCommand }
})

// ── DynamoDB mock ────────────────────────────────────────────────────────────
const send = vi.hoisted(() => {
  process.env.TABLE_NAME = 'test-table'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.LOCATION_TABLE_NAME = 'Location-test'
  process.env.DIVISION_TABLE_NAME = 'Division-test'
  process.env.SETTINGS_TABLE_NAME = 'TmsSettings-test'
  process.env.MERGE_JOB_TABLE_NAME = 'DirectoryMergeJob-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.GEOCODE_TOKEN_SECRET = 'test-geocode-secret'
  return vi.fn()
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send = send
  }
  class GetItemCommand {
    input: unknown
    __type = 'Get'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class PutItemCommand {
    input: unknown
    __type = 'Put'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class UpdateItemCommand {
    input: unknown
    __type = 'Update'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class ScanCommand {
    input: unknown
    __type = 'Scan'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class TransactWriteItemsCommand {
    input: unknown
    __type = 'Transact'
    constructor(input: unknown) {
      this.input = input
    }
  }
  return {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand,
    ScanCommand,
    TransactWriteItemsCommand,
  }
})

// ── Amplify data client mock (not exercised in SDK-path tests) ─────────────
vi.hoisted(() => {
  process.env.AMPLIFY_DATA_DEFAULT_NAME = 'amplifyData'
})

vi.mock('aws-amplify', () => {
  return { Amplify: { configure: vi.fn() } }
})

// The one AppSync writer (merge repoint) is observable: tests read what reached
// updateLoad and can script conflict responses ({ data: null, errors }).
type LoadUpdateResult = { data: Record<string, unknown> | null; errors?: unknown }
const loadUpdate = vi.hoisted(() => vi.fn(async (input: Record<string, unknown>, _options?: { condition?: unknown }): Promise<LoadUpdateResult> => ({ data: { id: input.id } })))
vi.mock('aws-amplify/data', () => {
  return { generateClient: vi.fn(() => ({ models: { Load: { update: loadUpdate } } })) }
})

vi.mock('@aws-amplify/backend-function/runtime', () => {
  return {
    getAmplifyDataClientConfig: vi.fn(async () => ({
      resourceConfig: { API: { GraphQL: { endpoint: 'http://localhost', region: 'us-east-1', defaultAuthMode: 'iam', modelIntrospection: {} } } },
      libraryOptions: { Auth: { credentialsProvider: { getCredentialsAndIdentityId: async () => ({ credentials: { accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' } }), clearCredentialsAndIdentityId: () => {} } } },
    })),
  }
})

import { handler, parseInput } from './handler'
// The real signer: the token the geocode Lambda mints must verify here, byte for byte.
import { signGeocodePayload } from '../tms-geocode/handler'

// ── Mock types ────────────────────────────────────────────────────────────────

interface MockGetCommand {
  __type: 'Get'
  input: { TableName?: string; Key?: Record<string, AttributeValue> }
}

interface MockPutCommand {
  __type: 'Put'
  input: {
    TableName?: string
    Item?: Record<string, AttributeValue>
    ConditionExpression?: string
  }
}

interface MockUpdateCommand {
  __type: 'Update'
  input: {
    TableName?: string
    Key?: Record<string, AttributeValue>
    ConditionExpression?: string
    UpdateExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
    ReturnValues?: string
  }
}

interface MockScanCommand {
  __type: 'Scan'
  input: {
    TableName?: string
    FilterExpression?: string
    ExpressionAttributeValues?: Record<string, AttributeValue>
    Limit?: number
    ExclusiveStartKey?: Record<string, AttributeValue>
  }
}

type MockCommand = MockGetCommand | MockPutCommand | MockUpdateCommand | MockScanCommand

interface TestIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

function identity(overrides?: { email?: string; groups?: string[] }): TestIdentity {
  return {
    sub: 'sub-1',
    username: overrides?.email ?? 'dennis@bcatcorp.com',
    claims: { email: overrides?.email ?? 'dennis@bcatcorp.com', 'cognito:groups': overrides?.groups ?? ['page-customers', 'page-locations'] },
  }
}

interface TestEvent {
  arguments: {
    action: string
    input?: string | Record<string, unknown> | null
  }
  identity?: TestIdentity | null
}

function event(action: string, input?: Record<string, unknown>, id?: TestIdentity): TestEvent {
  return { arguments: { action, input }, identity: id ?? identity() }
}

// ── DynamoDB response helpers ─────────────────────────────────────────────────

function makeDynamoItem(overrides: Record<string, unknown>): Record<string, AttributeValue> {
  return marshall(overrides, { removeUndefinedValues: true })
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  send.mockReset()
  cognitoSend.mockReset()
  cognitoSend.mockRejectedValue(new Error('UserNotFoundException'))
})

// ── Authorization ─────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('rejects missing identity', async () => {
    await expect(
      handler({ arguments: { action: 'UPSERT_CUSTOMER', input: {} }, identity: null }),
    ).rejects.toThrow('Unauthorized: missing identity')
  })

  it('rejects missing email from unresolved username', async () => {
    await expect(
      handler({
        arguments: { action: 'UPSERT_CUSTOMER', input: {} },
        identity: { sub: 'sub', username: 'nope', claims: {} },
      }),
    ).rejects.toThrow('could not resolve caller email')
  })

  it('resolves UUID username through Cognito', async () => {
    cognitoSend.mockResolvedValue({ UserAttributes: [{ Name: 'email', Value: 'Dennis@bcatcorp.com' }] })
    // Send back an empty scan for customers; the insert will then fail because not-found
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      return Promise.reject(new Error('unexpected'))
    })
    await expect(
      handler({
        arguments: { action: 'SAVE_SETTINGS', input: {} },
        identity: { sub: 'sub', username: 'uuid', claims: {} },
      }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('blocks non-page-users from settings actions', async () => {
    const h = handler(event('SAVE_SETTINGS', {}, identity({ groups: ['page-customers'] })))
    await expect(h).rejects.toThrow('Forbidden')
  })

  it('allows owner', async () => {
    cognitoSend.mockRejectedValue(new Error('UserNotFoundException'))
    // Mock empty settings scan (not found) and empty list of customers for customerId lookups
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error(`unexpected ${cmd.__type}`)
    })
    const h = handler(
      event('SAVE_DIVISION', { key: 'TEST', name: 'Test Division' }, { ...identity(), claims: { email: 'ryne@bcatcorp.com' } }),
    )
    await expect(h).resolves.toBeDefined()
  })

  it('block merge for page-users; requires admin', async () => {
    const h = handler(event('PREVIEW_MERGE_LOCATIONS', { sourceId: 's1', targetId: 't1' }, identity({ groups: ['page-locations'] })))
    await expect(h).rejects.toThrow('Forbidden')
  })
})

// ── UPSERT_CUSTOMER ───────────────────────────────────────────────────────────

describe('UPSERT_CUSTOMER', () => {
  it('creates a customer with normalized name', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(
      event('UPSERT_CUSTOMER', { name: 'Batory Foods Inc.', contactName: 'Alice' }),
    )
    expect(result.name).toBe('Batory Foods Inc.')
    expect(result.normalizedName).toBe('batory foods')
    expect(result.active).toBe(true)
    // Not decided yet: the Batory name match stays in force until an admin sets it.
    expect(result.apptWorkflow).toBeNull()
  })

  it('refuses an appointment workflow outside the schema enum', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    await expect(handler(event('UPSERT_CUSTOMER', { name: 'Acme', apptWorkflow: 'batory' }))).rejects.toThrow('apptWorkflow must be one of NONE, BATORY')
  })

  it('rejects duplicate customer by normalized name', async () => {
    const existing1 = makeDynamoItem({ id: 'c-1', name: 'BATORY FOODS LLC', normalizedName: 'batory foods', active: true, updatedAt: '2025-01-02' })
    const existing2 = makeDynamoItem({ id: 'c-2', name: 'Batory Foods Inc', normalizedName: 'batory foods', active: true, updatedAt: '2025-01-02' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [existing1, existing2], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Get') {
        const keyId = cmd.input.Key?.id?.S
        if (keyId === 'c-1') return Promise.resolve({ Item: existing1 })
        return Promise.resolve({ Item: undefined })
      }
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_CUSTOMER', { id: 'c-1', expectedUpdatedAt: '2025-01-02', name: 'Batory Foods' })),
    ).rejects.toThrow('Duplicate customer name')
  })

  it('updates with CAS', async () => {
    const existing = makeDynamoItem({
      id: 'c-1', name: 'Batory Foods', normalizedName: 'batory foods', active: true,
      createdAt: '2025-01-01', createdBy: 'someone@bcatcorp.com', updatedAt: '2025-01-02',
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [existing], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Update') {
        const vals = cmd.input.ExpressionAttributeValues ?? {}
        const condition = cmd.input.ConditionExpression ?? ''
        if (condition.includes(':casExpectedUpdatedAt') && vals[':casExpectedUpdatedAt']?.S === 'wrong') {
          const err = new Error('ConditionalCheckFailed')
          err.name = 'ConditionalCheckFailedException'
          return Promise.reject(err)
        }
        return Promise.resolve({ Attributes: existing })
      }
      throw new Error('unexpected')
    })
    // Matching CAS
    const result = await handler(
      event('UPSERT_CUSTOMER', { id: 'c-1', expectedUpdatedAt: '2025-01-02', name: 'Batory Foods', contactPhone: '555-1234' }),
    )
    expect(result).toBeDefined()

    // Wrong CAS
    await expect(
      handler(event('UPSERT_CUSTOMER', { id: 'c-1', expectedUpdatedAt: 'wrong', name: 'Batory Foods' })),
    ).rejects.toThrow('was changed by someone else')
  })

  it('rejects non-integer creditLimitCents', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Test', creditLimitCents: 50.5 })),
    ).rejects.toThrow('Value must be an integer')
  })

  it('rejects negative creditLimitCents', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Test', creditLimitCents: -1 })),
    ).rejects.toThrow('Value must be at least 0')
  })

  it('cannot edit a merged customer', async () => {
    const merged = makeDynamoItem({ id: 'c-1', name: 'Old Co', mergedIntoId: 'c-2', active: false })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: merged })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_CUSTOMER', { id: 'c-1', expectedUpdatedAt: '', name: 'Old Co' })),
    ).rejects.toThrow('Cannot edit a merged customer')
  })
})

// ── UPSERT_LOCATION ───────────────────────────────────────────────────────────

describe('UPSERT_LOCATION', () => {
  it('creates a location with normalized address', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(
      event('UPSERT_LOCATION', { name: 'Bat Warehouse', street: '123 Main St', city: 'Chicago', state: 'IL', zip: '60601' }),
    )
    expect(result.name).toBe('Bat Warehouse')
    expect(result.normalizedName).toBe('bat warehouse')
    expect(result.normalizedAddress).toBeTruthy()
  })

  it('rejects duplicate by normalized address', async () => {
    const existing1 = makeDynamoItem({
      id: 'l-1', name: 'Warehouse', street: '123 main st', city: 'chicago', state: 'il', zip: '60601', country: 'US',
      normalizedAddress: '123 main st chicago il 60601', active: true, updatedAt: '2025-01-02',
    })
    const existing2 = makeDynamoItem({
      id: 'l-2', name: 'Depot', street: '123 main st', city: 'chicago', state: 'il', zip: '60601', country: 'US',
      normalizedAddress: '123 main st chicago il 60601', active: true, updatedAt: '2025-01-02',
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [existing1, existing2], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Get') {
        const keyId = cmd.input.Key?.id?.S
        if (keyId === 'l-1') return Promise.resolve({ Item: existing1 })
        return Promise.resolve({ Item: undefined })
      }
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_LOCATION', { id: 'l-1', expectedUpdatedAt: '2025-01-02', name: 'New Name', street: '123 Main St', city: 'Chicago', state: 'IL', zip: '60601' })),
    ).rejects.toThrow('Duplicate location address')
  })

  it('stores coordinates only from a token the geocode Lambda signed, and refuses a tampered one', async () => {
    const puts: Record<string, unknown>[] = []
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') { puts.push(cmd.input as Record<string, unknown>); return Promise.resolve({}) }
      throw new Error('unexpected')
    })
    const expires = new Date(Date.now() + 86_400_000).toISOString()
    const token = signGeocodePayload({ lat: 41.5, lng: -88.1, placeId: 'ChIJ123', geocodedAt: '2026-09-01T00:00:00.000Z', geocodeExpiresAt: expires })
    const created = await handler(event('UPSERT_LOCATION', { name: 'Signed Dock', city: 'Joliet', lat: 41.5, lng: -88.1, placeId: 'ChIJ123', geocodeToken: token }))
    expect(created).toMatchObject({ lat: 41.5, lng: -88.1, placeId: 'ChIJ123', geocodeExpiresAt: expires })
    expect(puts).toHaveLength(1)

    // Coordinates the token did not sign are refused.
    await expect(handler(event('UPSERT_LOCATION', { name: 'Moved Dock', city: 'Joliet', lat: 41.6, lng: -88.1, placeId: 'ChIJ123', geocodeToken: token })))
      .rejects.toThrow('does not match the supplied coordinates')
    // A payload edited after signing is refused.
    const [payload] = token.split('.')
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), lat: 0 })).toString('base64url')}.${token.split('.')[1]}`
    await expect(handler(event('UPSERT_LOCATION', { name: 'Forged Dock', city: 'Joliet', lat: 0, lng: -88.1, geocodeToken: forged })))
      .rejects.toThrow('signature mismatch')
  })

  it('rejects fabricated coordinates without geocode token', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_LOCATION', { name: 'Test', lat: 41.882, lng: -87.623 })),
    ).rejects.toThrow('require a verified geocode token')
  })

  it('cannot edit a merged location', async () => {
    const merged = makeDynamoItem({ id: 'l-1', name: 'Old Location', mergedIntoId: 'l-2', active: false })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: merged })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_LOCATION', { id: 'l-1', expectedUpdatedAt: '', name: 'Old Location' })),
    ).rejects.toThrow('Cannot edit a merged location')
  })

  const geocoded = () => makeDynamoItem({
    id: 'l-geo', name: 'Oakley DC', street: '1 Dock Rd', city: 'Joliet', state: 'IL', zip: '60431', country: 'US',
    lat: 41.5, lng: -88.1, placeId: 'place_abc', geocodedAt: '2025-01-01T00:00:00.000Z', geocodeExpiresAt: '2025-01-31T00:00:00.000Z',
    active: true, updatedAt: '2025-01-02',
  })
  const wireGeocoded = () => {
    const writes: Record<string, unknown>[] = []
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: cmd.input.Key?.id?.S === 'l-geo' ? geocoded() : undefined })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [geocoded()], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Update') { writes.push(cmd.input as Record<string, unknown>); return Promise.resolve({ Attributes: geocoded() }) }
      throw new Error('unexpected')
    })
    return writes
  }
  const written = (writes: Record<string, unknown>[], key: string) =>
    (writes[0].ExpressionAttributeValues as Record<string, Record<string, unknown>>)[`:${key}`]

  it('keeps the verified geocode when only hours/notes change (no token needed)', async () => {
    const writes = wireGeocoded()
    await handler(event('UPSERT_LOCATION', {
      id: 'l-geo', expectedUpdatedAt: '2025-01-02', name: 'Oakley DC', street: '1 Dock Rd', city: 'Joliet', state: 'IL', zip: '60431',
      lat: 41.5, lng: -88.1, placeId: 'place_abc', hours: '06:00-14:00',
    }))
    expect(written(writes, 'lat')).toEqual({ N: '41.5' })
    expect(written(writes, 'placeId')).toEqual({ S: 'place_abc' })
    expect(written(writes, 'hours')).toEqual({ S: '06:00-14:00' })
  })

  it('drops the stale pin when the address changes without a new geocode', async () => {
    const writes = wireGeocoded()
    await handler(event('UPSERT_LOCATION', {
      id: 'l-geo', expectedUpdatedAt: '2025-01-02', name: 'Oakley DC', street: '9 New Rd', city: 'Joliet', state: 'IL', zip: '60431',
    }))
    expect(written(writes, 'lat')).toEqual({ NULL: true })
    expect(written(writes, 'placeId')).toEqual({ NULL: true })
  })

  it('a create never adopts an existing record: same name+city is rejected, same name elsewhere is a new facility', async () => {
    const puts: unknown[] = []
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [geocoded()], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') { puts.push(cmd.input); return Promise.resolve({}) }
      throw new Error('unexpected')
    })
    await expect(handler(event('UPSERT_LOCATION', { name: 'Oakley DC', city: 'Joliet', state: 'IL' })))
      .rejects.toThrow(/Duplicate location name in Joliet: Oakley DC \(id l-geo\)/)
    const created = await handler(event('UPSERT_LOCATION', { name: 'Oakley DC', city: 'Dallas', state: 'TX' }))
    expect(created.id).not.toBe('l-geo')
    expect(puts).toHaveLength(1)
  })
})

// ── ARCHIVE actions ──────────────────────────────────────────────────────────

describe('ARCHIVE actions', () => {
  it('archives a customer with CAS', async () => {
    const existing = makeDynamoItem({ id: 'c-1', name: 'Old', active: true, updatedAt: '2025-01-02' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') return Promise.resolve({ Attributes: existing })
      throw new Error('unexpected')
    })
    const result = await handler(
      event('ARCHIVE_CUSTOMER', { id: 'c-1', expectedUpdatedAt: '2025-01-02' }),
    )
    expect(result).toBeDefined()
  })

  it('rejects archive of merged customer', async () => {
    const merged = makeDynamoItem({ id: 'c-1', name: 'Old Co', mergedIntoId: 'c-2', active: false, updatedAt: '2025-01-02' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: merged })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('ARCHIVE_CUSTOMER', { id: 'c-1', expectedUpdatedAt: '2025-01-02' })),
    ).rejects.toThrow('Cannot archive a merged customer')
  })
})

// ── SAVE_DIVISION ─────────────────────────────────────────────────────────────

describe('SAVE_DIVISION', () => {
  it('creates a division', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(
      event('SAVE_DIVISION', { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics' }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.key).toBe('BCAT_LOGISTICS')
    expect(result.active).toBe(true)
  })

  it('updates division with CAS', async () => {
    const existing = makeDynamoItem({ key: 'BCAT_LOGISTICS', id: 'BCAT_LOGISTICS', name: 'BCAT Logistics', active: true, updatedAt: '2025-01-02' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') {
        const vals = cmd.input.ExpressionAttributeValues ?? {}
        if (vals[':casExpectedUpdatedAt']?.S === 'wrong') {
          const err = new Error('ConditionalCheckFailed')
          err.name = 'ConditionalCheckFailedException'
          return Promise.reject(err)
        }
        return Promise.resolve({ Attributes: existing })
      }
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_DIVISION', { key: 'BCAT_LOGISTICS', expectedUpdatedAt: 'wrong', name: 'BCAT Updated' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('was changed by someone else')
  })

  it('refuses configuration writes from page-settings alone — ADMIN only', async () => {
    await expect(
      handler(event('SAVE_DIVISION', { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics' }, identity({ groups: ['page-settings'] }))),
    ).rejects.toThrow('requires owner or ADMIN')
  })
})

// ── PREVIEW_MERGE_LOCATIONS ───────────────────────────────────────────────────

describe('PREVIEW_MERGE_LOCATIONS', () => {
  it('returns load count', async () => {
    const source = makeDynamoItem({ id: 's1', name: 'Source', active: true, updatedAt: '2025-01-02' })
    const target = makeDynamoItem({ id: 't1', name: 'Target', active: true, updatedAt: '2025-01-02' })
    // A load with a stop pointing at the source
    const load = makeDynamoItem({
      id: 'l-1', stops: [{ type: 'pickup', locationId: 's1', appt: '2025-03-01T10:00:00Z', sequence: 0 }],
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') {
        const key = cmd.input.Key
        if (key?.id?.S === 's1') return Promise.resolve({ Item: source })
        if (key?.id?.S === 't1') return Promise.resolve({ Item: target })
        return Promise.resolve({ Item: undefined })
      }
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [load], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    const result = await handler(
      event('PREVIEW_MERGE_LOCATIONS', { sourceId: 's1', targetId: 't1' }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.loadCount).toBe(1)
  })

  it('rejects self-merge', async () => {
    await expect(
      handler(event('PREVIEW_MERGE_LOCATIONS', { sourceId: 's1', targetId: 's1' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('Source and target must differ')
  })

  it('rejects merge cycle', async () => {
    const source = makeDynamoItem({ id: 's1', name: 'Source', active: true })
    const target = makeDynamoItem({ id: 't1', name: 'Target', active: true, mergedIntoId: 's1' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') {
        const key = cmd.input.Key
        if (key?.id?.S === 's1') return Promise.resolve({ Item: source })
        if (key?.id?.S === 't1') return Promise.resolve({ Item: target })
        return Promise.resolve({ Item: undefined })
      }
      throw new Error('unexpected')
    })
    await expect(
      handler(event('PREVIEW_MERGE_LOCATIONS', { sourceId: 's1', targetId: 't1' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('already merged')
  })

  it('processes large merges in pages and returns RUNNING', async () => {
    const source = makeDynamoItem({ id: 's1', name: 'Source', active: true, updatedAt: '2025-01-02' })
    const target = makeDynamoItem({ id: 't1', name: 'Target', active: true, updatedAt: '2025-01-02' })
    const loads = Array.from({ length: 101 }, (_, i) =>
      makeDynamoItem({ id: `l-${i}`, stops: [{ type: 'pickup', locationId: 's1', appt: '2025-03-01T10:00:00Z', sequence: 0 }], updatedAt: '2025-01-02' }),
    )
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') {
        const key = cmd.input.Key
        if (key?.id?.S === 's1') return Promise.resolve({ Item: source })
        if (key?.id?.S === 't1') return Promise.resolve({ Item: target })
        return Promise.resolve({ Item: undefined })
      }
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: loads, LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      if (cmd.__type === 'Update') {
        return Promise.resolve({ Attributes: makeDynamoItem({ status: 'RUNNING', processedCount: 25, remainingCount: 76 }) })
      }
      throw new Error('unexpected')
    })
    const result = await handler(
      event('MERGE_LOCATIONS', { sourceId: 's1', targetId: 't1' }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.status).toBe('RUNNING')
    expect(result.processedCount).toBe(25)
    expect(result.remainingCount).toBe(76)
  })
})

// ── RESUME_MERGE ─────────────────────────────────────────────────────────────

describe('RESUME_MERGE', () => {
  it('returns completed job without re-processing', async () => {
    const job = makeDynamoItem({
      id: 'job-1', sourceId: 's1', targetId: 't1', status: 'COMPLETED',
      processedCount: 10, remainingCount: 0, createdAt: '2025-01-02',
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: job })
      throw new Error('unexpected')
    })
    const result = await handler(
      event('RESUME_MERGE', { jobId: 'job-1' }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.status).toBe('COMPLETED')
  })

  it('resumes failed job and completes', async () => {
    const job = makeDynamoItem({
      id: 'job-1', sourceId: 's1', targetId: 't1', status: 'FAILED',
      processedCount: 3, remainingCount: 7, error: 'Load 4 CAS conflict',
    })
    const completedJob = makeDynamoItem({
      id: 'job-1', sourceId: 's1', targetId: 't1', status: 'COMPLETED',
      processedCount: 10, remainingCount: 0, error: null,
    })
    const source = makeDynamoItem({ id: 's1', name: 'Source', active: false, mergedIntoId: 't1', mergeJobId: 'job-1' })
    const loads = Array.from({ length: 7 }, (_, i) =>
      makeDynamoItem({ id: `l-${i + 3}`, stops: [{ type: 'pickup', locationId: 's1', appt: '2025-03-01T10:00:00Z', sequence: 0 }], updatedAt: '2025-01-02' }),
    )
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') {
        const key = cmd.input.Key
        if (key?.id?.S === 'job-1') return Promise.resolve({ Item: job })
        if (key?.id?.S === 's1') return Promise.resolve({ Item: source })
        return Promise.resolve({ Item: undefined })
      }
      if (cmd.__type === 'Update') return Promise.resolve({ Attributes: completedJob })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: loads, LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    const result = await handler(
      event('RESUME_MERGE', { jobId: 'job-1' }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.status).toBe('COMPLETED')
    expect(result.processedCount).toBe(10)
    expect(result.remainingCount).toBe(0)
  })
})

// ── Merge repoint — the only Load writer ─────────────────────────────────────

describe('merge repoint via the generated updateLoad mutation', () => {
  const source = makeDynamoItem({ id: 's1', name: 'Source', active: true, updatedAt: '2025-01-02' })
  const target = makeDynamoItem({ id: 't1', name: 'Target', active: true, updatedAt: '2025-01-02' })
  // stops as AppSync stores AWSJSON in DynamoDB (parsed list) AND as a raw JSON string
  // (double-encoded by a client) — both must be found and repointed.
  const stops = [
    { id: 'p', type: 'pickup', name: 'Old dock', city: 'Joliet, IL', locationId: 's1', appt: '2025-03-01T10:00:00Z', apptType: 'exact', sequence: 0, driverId: 'd1',
      apptStatus: 'confirmed', apptProofs: { request: 'r', e2open: 'e', email: 'm' }, apptThreadTs: '1.2', address: { street: '1 Old St' } },
    { id: 'd', type: 'delivery', name: 'Elsewhere', locationId: 'other', appt: '2025-03-02T10:00:00Z', sequence: 1, driverId: null },
  ]
  const loads = [
    makeDynamoItem({ id: 'l-list', stops, updatedAt: '2025-01-05', pickupAppt: 'stale', deliveryAppt: 'stale' }),
    makeDynamoItem({ id: 'l-string', stops: JSON.stringify(stops), updatedAt: '2025-01-06' }),
  ]
  const wire = (over?: (cmd: MockCommand) => unknown) => send.mockImplementation((cmd: MockCommand) => {
    const o = over?.(cmd)
    if (o !== undefined) return Promise.resolve(o)
    if (cmd.__type === 'Get') {
      const key = cmd.input.Key
      if (key?.id?.S === 's1') return Promise.resolve({ Item: source })
      if (key?.id?.S === 't1') return Promise.resolve({ Item: target })
      const load = loads.find((l) => l.id?.S === key?.id?.S)
      if (load) return Promise.resolve({ Item: load })
      return Promise.resolve({ Item: undefined })
    }
    if (cmd.__type === 'Scan') return Promise.resolve({ Items: loads, LastEvaluatedKey: undefined })
    if (cmd.__type === 'Put') return Promise.resolve({})
    if (cmd.__type === 'Update') return Promise.resolve({ Attributes: makeDynamoItem({ id: 'job', status: 'COMPLETED', processedCount: 2, remainingCount: 0 }) })
    throw new Error('unexpected')
  })

  beforeEach(() => { loadUpdate.mockClear(); loadUpdate.mockImplementation(async (input: Record<string, unknown>) => ({ data: { id: input.id } })) })

  it('repoints only the source stop, keeps proofs/history, re-derives mirrors, sends stops as a JSON string under CAS', async () => {
    wire()
    const result = await handler(event('MERGE_LOCATIONS', { sourceId: 's1', targetId: 't1' }, identity({ groups: ['ADMIN'] })))
    expect(result.status).toBe('COMPLETED')
    expect(loadUpdate).toHaveBeenCalledTimes(2)
    for (const [input, options] of loadUpdate.mock.calls as [Record<string, unknown>, { condition: unknown }][]) {
      expect(typeof input.stops).toBe('string')
      const written = JSON.parse(input.stops as string)
      expect(written[0]).toMatchObject({ locationId: 't1', name: 'Old dock', apptStatus: 'confirmed', apptProofs: { request: 'r', e2open: 'e', email: 'm' }, apptThreadTs: '1.2', address: { street: '1 Old St', mergedFromLocationId: 's1' } })
      expect(written[1].locationId).toBe('other')
      expect(input).toMatchObject({ pickupAppt: '2025-03-01T10:00:00Z', deliveryAppt: '2025-03-02T10:00:00Z', originName: 'Old dock', destinationName: 'Elsewhere', pickupDriverId: 'd1', deliveryDriverId: null })
      expect(options.condition).toEqual({ updatedAt: { eq: String(input.id === 'l-list' ? '2025-01-05' : '2025-01-06') } })
    }
  })

  it('treats { data: null, errors } as a conflict: re-reads the load and retries with its fresh updatedAt', async () => {
    const fresh = makeDynamoItem({ id: 'l-list', stops, updatedAt: '2025-01-09' })
    wire((cmd) => (cmd.__type === 'Get' && cmd.input.Key?.id?.S === 'l-list' ? { Item: fresh } : undefined))
    loadUpdate.mockImplementationOnce(async () => ({ data: null, errors: [{ errorType: 'DynamoDB:ConditionalCheckFailedException' }] }))
    const result = await handler(event('MERGE_LOCATIONS', { sourceId: 's1', targetId: 't1' }, identity({ groups: ['ADMIN'] })))
    expect(result.status).toBe('COMPLETED')
    const retries = (loadUpdate.mock.calls as [Record<string, unknown>, { condition: unknown }][]).filter(([i]) => i.id === 'l-list')
    expect(retries).toHaveLength(2)
    expect(retries[1][1].condition).toEqual({ updatedAt: { eq: '2025-01-09' } })
  })

  it('fails the job (never COMPLETED) when a load keeps conflicting', async () => {
    const updates: Record<string, unknown>[] = []
    wire((cmd) => {
      if (cmd.__type === 'Update' && cmd.input.TableName === 'DirectoryMergeJob-test') { updates.push(cmd.input as Record<string, unknown>); return { Attributes: makeDynamoItem({ id: 'job', status: 'FAILED' }) } }
      return undefined
    })
    loadUpdate.mockImplementation(async () => ({ data: null, errors: [{ errorType: 'DynamoDB:ConditionalCheckFailedException' }] }))
    const result = await handler(event('MERGE_LOCATIONS', { sourceId: 's1', targetId: 't1' }, identity({ groups: ['ADMIN'] })))
    expect(result.status).toBe('FAILED')
    expect(JSON.stringify(updates[updates.length - 1])).toContain('could not be repointed')
  })
})

// ── parseInput ───────────────────────────────────────────────────────────────

describe('parseInput', () => {
  it('accepts a raw object', () => {
    expect(parseInput({ a: 1 })).toEqual({ a: 1 })
  })
  it('parses JSON string', () => {
    expect(parseInput('{"b":2}')).toEqual({ b: 2 })
  })
  it('returns empty for null', () => {
    expect(parseInput(null)).toEqual({})
  })
  it('rejects non-object JSON', () => {
    expect(() => parseInput('"hello"')).toThrow('must be a JSON object')
  })
})
// ── DynamoDB write shape ──────────────────────────────────────────────────────
// Each of these was found live in the tmsp1 sandbox: the mocks above accept any Put/
// Update, so the marshalled item and expressions must be asserted explicitly.

const DYNAMO_RESERVED_BARE = /\b(?<![#:])(key|name|status|data|value|type|count)\b/i

describe('DynamoDB write shape (sandbox regressions)', () => {
  it('UPSERT_LOCATION create omits NULL GSI keys and writes normalizedAddress only with an address', async () => {
    const puts: MockPutCommand['input'][] = []
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') { puts.push(cmd.input); return Promise.resolve({}) }
      throw new Error('unexpected')
    })
    await handler(event('UPSERT_LOCATION', { name: 'Full Address', street: '1 Main St', city: 'Danville', state: 'IL', zip: '61834' }))
    await handler(event('UPSERT_LOCATION', { name: 'Name Only' }))

    const [full, nameOnly] = puts.map((p) => p.Item ?? {})
    // mergedIntoId / normalizedAddress are GSI partition keys: NULL or '' is rejected by DynamoDB.
    for (const item of [full, nameOnly]) {
      expect(item).not.toHaveProperty('mergedIntoId')
      expect(item).not.toHaveProperty('mergeJobId')
    }
    expect(full.normalizedAddress).toEqual({ S: '1 main st danville il 61834 us' })
    expect(nameOnly).not.toHaveProperty('normalizedAddress')
  })

  it('a name-only location does not collide on the defaulted country alone', async () => {
    const other = makeDynamoItem({ id: 'l-x', name: 'Elsewhere', country: 'US', active: true, updatedAt: '2025-01-02' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [other], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    await expect(handler(event('UPSERT_LOCATION', { name: 'Second Name Only' }))).resolves.toMatchObject({ name: 'Second Name Only' })
  })

  it('UPSERT_LOCATION update REMOVEs a cleared normalizedAddress instead of SETting it to NULL', async () => {
    const existing = makeDynamoItem({
      id: 'l-1', name: 'Dock', street: '1 Main St', city: 'Danville', state: 'IL', zip: '61834', country: 'US',
      normalizedAddress: '1 main st danville il 61834 us', active: true, updatedAt: '2025-01-02',
    })
    let update: MockUpdateCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [existing], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Update') { update = cmd.input; return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })
    await handler(event('UPSERT_LOCATION', { id: 'l-1', expectedUpdatedAt: '2025-01-02', name: 'Dock' }))
    expect(update?.UpdateExpression).toMatch(/REMOVE .*#normalizedAddress/)
    expect(update?.UpdateExpression).not.toMatch(/#normalizedAddress = /)
    expect(update?.ExpressionAttributeValues).not.toHaveProperty(':normalizedAddress')
    expect(Object.values(update?.ExpressionAttributeValues ?? {})).not.toContainEqual(undefined)
    // Merge pointers are owned by MERGE_LOCATIONS; a normal edit must not touch them.
    expect(update?.UpdateExpression).not.toMatch(/mergedIntoId|mergeJobId/)
  })

  it('UPSERT_CUSTOMER create omits the mergedIntoId GSI key', async () => {
    let put: MockPutCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') { put = cmd.input; return Promise.resolve({}) }
      throw new Error('unexpected')
    })
    await handler(event('UPSERT_CUSTOMER', { name: 'Acme' }))
    expect(put?.Item).not.toHaveProperty('mergedIntoId')
  })

  it('SAVE_DIVISION create never uses the reserved word `key` bare in a condition', async () => {
    let put: MockPutCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Put') { put = cmd.input; return Promise.resolve({}) }
      throw new Error('unexpected')
    })
    await handler(event('SAVE_DIVISION', { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics' }, identity({ groups: ['ADMIN'] })))
    expect(put?.ConditionExpression).toBe('attribute_not_exists(#key)')
    expect((put as { ExpressionAttributeNames?: Record<string, string> } | undefined)?.ExpressionAttributeNames).toEqual({ '#key': 'key' })
    expect(put?.ConditionExpression ?? '').not.toMatch(DYNAMO_RESERVED_BARE)
  })
})
