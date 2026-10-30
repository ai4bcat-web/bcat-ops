/**
 * tms-directory-actions handler tests.
 *
 * Uses the same DynamoDB mock pattern as vendor-ap-actions (vi.hoisted send mock).
 * Data client is not mocked; merge tests rely on the raw-SDK path for Customer/Location/etc.
 */

import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { DEFAULT_CHECK_CALL_PLAN, type CheckCallPlan } from '../../../src/lib/checkCallPlan'

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
  process.env.IMPORT_JOB_TABLE_NAME = 'ImportJob-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.USER_PROFILE_TABLE_NAME = 'UserProfile-test'
  process.env.OWNERSHIP_DIVISION_TABLE_NAME = 'OwnershipDivision-test'
  process.env.OWNERSHIP_RULE_TABLE_NAME = 'OwnershipRule-test'
  process.env.SHIPMENT_VIEW_TABLE_NAME = 'ShipmentView-test'
  process.env.SHIPMENT_COLUMN_TEMPLATE_TABLE_NAME = 'ShipmentColumnTemplate-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  process.env.GEOCODE_TOKEN_SECRET = 'test-geocode-secret'
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
  // Step J — the integration framework's table and its SSM path.
  process.env.INTEGRATION_TABLE_NAME = 'Integration-test'
  process.env.INTEGRATION_PARAM_PATH = '/bcat/integrations/us-east-1_TEST'
  process.env.DISPATCH_PARAM_PATH = '/bcat/dispatch/us-east-1_TEST'
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
  class DeleteItemCommand {
    input: unknown
    __type = 'Delete'
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
    DeleteItemCommand,
    TransactWriteItemsCommand,
  }
})

// ── SSM mock (Step J credential store) ───────────────────────────────────────
const ssmSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient {
    send = ssmSend
  }
  class GetParameterCommand {
    input: unknown
    __type = 'GetParameter'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class PutParameterCommand {
    input: unknown
    __type = 'PutParameter'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class DeleteParameterCommand {
    input: unknown
    __type = 'DeleteParameter'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class GetParametersByPathCommand {
    input: unknown
    __type = 'GetParametersByPath'
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand, GetParametersByPathCommand }
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

// ── Anthropic mock (Step M Ask assistant) ────────────────────────────────────
const finalMessage = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      stream: vi.fn(() => ({ finalMessage })),
    }
  }
  return { default: Anthropic }
})

import { handler, parseInput, resolveViewColumns } from './handler'
// The real signer: the token the geocode Lambda mints must verify here, byte for byte.
import { signGeocodePayload } from '../tms-geocode/handler'
import { SEED_DIVISIONS, SEED_RULES } from '../../../src/lib/ownership'
import { SEED_VIEWS } from '../../../src/lib/shipmentViewDefs'
import { PROVIDERS } from '../../../src/lib/integrations/registry'
import { resetIntegrationSecretsCache } from '../_shared/integrationSecrets'

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
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
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

interface MockDeleteCommand {
  __type: 'Delete'
  input: {
    TableName?: string
    Key?: Record<string, AttributeValue>
    ConditionExpression?: string
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, AttributeValue>
  }
}

type MockCommand = MockGetCommand | MockPutCommand | MockUpdateCommand | MockScanCommand | MockDeleteCommand

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

/**
 * Wraps a per-test mock so GetItem calls to the settings table return "not found".
 * Customer creates now read org defaults; tests that do not care about settings can
 * use this instead of enumerating every unrelated Get.
 */
function withSettingsGet(base: (cmd: MockCommand) => unknown): (cmd: MockCommand) => unknown {
  return (cmd: MockCommand) => {
    if (cmd.__type === 'Get' && String(cmd.input.TableName ?? '').includes('Settings')) {
      return Promise.resolve({ Item: undefined })
    }
    return base(cmd)
  }
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  send.mockReset()
  cognitoSend.mockReset()
  cognitoSend.mockRejectedValue(new Error('UserNotFoundException'))
  ssmSend.mockReset()
  // The credential store caches a parameter for 60 s; each case reads its own stub.
  resetIntegrationSecretsCache()
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
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    }))
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
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
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

  // ── Customer v2 ─────────────────────────────────────────────────────────────

  it('creates a customer defaulting to ACTIVE', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    }))
    const result = await handler(event('UPSERT_CUSTOMER', { name: 'Acme' }))
    expect(result.status).toBe('ACTIVE')
    expect(result.active).toBe(true)
  })

  it('creates a customer as PENDING under requireCustomerApproval for non-admin', async () => {
    const settings = makeDynamoItem({ id: 'default', requireCustomerApproval: true })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get' && String(cmd.input.TableName ?? '').includes('Settings')) {
        return Promise.resolve({ Item: settings })
      }
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(event('UPSERT_CUSTOMER', { name: 'Acme' }))
    expect(result.status).toBe('PENDING')
    expect(result.active).toBe(true)
  })

  it('creates a customer as ACTIVE under requireCustomerApproval for admin', async () => {
    const settings = makeDynamoItem({ id: 'default', requireCustomerApproval: true })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get' && String(cmd.input.TableName ?? '').includes('Settings')) {
        return Promise.resolve({ Item: settings })
      }
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(
      event('UPSERT_CUSTOMER', { name: 'Acme' }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.status).toBe('ACTIVE')
  })

  it('rejects update that carries a changed status', async () => {
    const existing = makeDynamoItem({
      id: 'c-1', name: 'Acme', normalizedName: 'acme', active: true, status: 'ACTIVE',
      createdAt: '2025-01-01', createdBy: 'someone@bcatcorp.com', updatedAt: '2025-01-02',
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [existing], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('UPSERT_CUSTOMER', { id: 'c-1', expectedUpdatedAt: '2025-01-02', name: 'Acme', status: 'BLOCKED' })),
    ).rejects.toThrow('Change status with SET_CUSTOMER_STATUS')
  })

  it('allows unchanged status echo on update', async () => {
    const existing = makeDynamoItem({
      id: 'c-1', name: 'Acme', normalizedName: 'acme', active: true, status: 'ACTIVE',
      createdAt: '2025-01-01', createdBy: 'someone@bcatcorp.com', updatedAt: '2025-01-02',
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [existing], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Update') return Promise.resolve({ Attributes: existing })
      throw new Error('unexpected')
    })
    const result = await handler(
      event('UPSERT_CUSTOMER', { id: 'c-1', expectedUpdatedAt: '2025-01-02', name: 'Acme', status: 'ACTIVE' }),
    )
    expect(result).toBeDefined()
  })

  it('rejects non-admin credit-field change', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', creditLimitCents: 50000 })),
    ).rejects.toThrow('Forbidden: creditLimitCents requires owner or ADMIN')
  })

  it('lets claim-CREDIT_LIMIT_EDIT set a credit limit without ADMIN', async () => {
    let put: MockPutCommand['input'] | undefined
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') { put = cmd.input; return Promise.resolve({}) }
      throw new Error('unexpected')
    }))
    await handler(event(
      'UPSERT_CUSTOMER',
      { name: 'Acme', creditLimitCents: 50000 },
      identity({ groups: ['page-customers', 'claim-CREDIT_LIMIT_EDIT'] }),
    ))
    expect(put?.Item?.creditLimitCents).toEqual({ N: '50000' })
  })

  it('allows unchanged credit-field echo for non-admin', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    }))
    const result = await handler(
      event('UPSERT_CUSTOMER', { name: 'Acme', creditLimitCents: null, creditHoldFlag: null, freeCreditRequired: null, creditUsageWarningBps: null, maxDaysLate: null }),
    )
    expect(result).toBeDefined()
  })

  it('rejects invalid contact type', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', {
        name: 'Acme',
        contacts: [{ id: 'x', name: 'Alice', types: ['NOT_A_TYPE'], notifications: [], active: true }],
      })),
    ).rejects.toThrow('contacts[0].types contains invalid value')
  })

  it('rejects duplicate default bill-to', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', {
        name: 'Acme',
        billToParties: [
          { id: 'b1', name: 'Billing 1', isDefault: true },
          { id: 'b2', name: 'Billing 2', isDefault: true },
        ],
      })),
    ).rejects.toThrow('At most one bill-to party may be default')
  })

  it('rejects contact billToId not present in payload', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', {
        name: 'Acme',
        contacts: [{ id: 'x', name: 'Alice', types: ['PRIMARY'], billToId: 'missing', notifications: [], active: true }],
      })),
    ).rejects.toThrow('contacts[0].billToId references a bill-to not present in this payload')
  })

  it('rejects bps greater than 10000', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', creditUsageWarningBps: 10001 })),
    ).rejects.toThrow('Value must be at most 10000')
  })

  it('rejects invalid pricingDefaults mode', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', pricingDefaults: { mode: 'GUESS' } })),
    ).rejects.toThrow('pricingDefaults.mode must be one of MARGIN, MARKUP, PROFIT')
  })

  it('rejects invalid invoiceFrequency', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', invoiceFrequency: 'YEARLY' })),
    ).rejects.toThrow('invoiceFrequency must be one of DAILY, TWICE_WEEKLY, WEEKLY, MONTHLY')
  })

  // ── Step P3: flow defaults ─────────────────────────────────────────────────
  it('stores Step P3 flow defaults on a customer', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    }))
    const result = await handler(event('UPSERT_CUSTOMER', {
      name: 'Acme',
      defaultCarrierTeamKey: 'DESK_A',
      defaultCarrierRepId: 'rep-1',
      marginTargetBps: 2500,
      marginFloorBps: 800,
      quoteAutoReply: true,
      requiredLoadFields: ['poNumber', 'equipmentType'],
      checkCallPlan: {
        intervalHours: 6,
        channels: ['SMS', 'EMAIL'],
        milestones: ['DISPATCHED', 'DELIVERED'],
        escalateAfterMinutes: 45,
        emailDispatcher: true,
        requestPodOnDelivery: false,
      },
    }))
    expect(result.defaultCarrierTeamKey).toBe('DESK_A')
    expect(result.defaultCarrierRepId).toBe('rep-1')
    expect(result.marginTargetBps).toBe(2500)
    expect(result.marginFloorBps).toBe(800)
    expect(result.quoteAutoReply).toBe(true)
    expect(result.requiredLoadFields).toEqual(['poNumber', 'equipmentType'])
    expect(result.checkCallPlan).toMatchObject({ intervalHours: 6, escalateAfterMinutes: 45 })
  })

  it('refuses a margin floor above the target', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', marginTargetBps: 1500, marginFloorBps: 2000 })),
    ).rejects.toThrow('marginFloorBps cannot be above marginTargetBps')
  })

  it('refuses required-load fields not in the catalog', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', requiredLoadFields: ['madeUpField'] })),
    ).rejects.toThrow('Unknown required-load field: madeUpField')
  })

  it('refuses a check-call interval outside 1–24 hours', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', checkCallPlan: { intervalHours: 25, escalateAfterMinutes: 30 } })),
    ).rejects.toThrow('checkCallPlan.intervalHours must be 1–24')
  })

  it('falls back to the default plan when channels and milestones are both cleared', async () => {
    let put: MockPutCommand['input'] | undefined
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') { put = cmd.input; return Promise.resolve({}) }
      throw new Error('unexpected')
    }))
    const result = await handler(event('UPSERT_CUSTOMER', {
      name: 'Acme',
      checkCallPlan: {
        intervalHours: 6,
        escalateAfterMinutes: 45,
        channels: [],
        milestones: [],
        emailDispatcher: false,
        requestPodOnDelivery: false,
      },
    }))
    const plan = result.checkCallPlan as CheckCallPlan
    expect(plan).toMatchObject({
      intervalHours: 6,
      escalateAfterMinutes: 45,
      emailDispatcher: false,
      requestPodOnDelivery: false,
    })
    expect(plan.channels).toEqual(DEFAULT_CHECK_CALL_PLAN.channels)
    expect(plan.milestones).toEqual(DEFAULT_CHECK_CALL_PLAN.milestones)
    expect(plan.channels).not.toContain('VOICE')
    expect(plan.milestones).not.toContain('IN_TRANSIT')
    expect(put?.Item).toBeDefined()
  })

  it('refuses an escalation timeout outside 5–1440 minutes', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    }))
    await expect(
      handler(event('UPSERT_CUSTOMER', { name: 'Acme', checkCallPlan: { intervalHours: 4, escalateAfterMinutes: 3 } })),
    ).rejects.toThrow('checkCallPlan.escalateAfterMinutes must be 5–1440')
  })
})

// ── SET_CUSTOMER_STATUS ───────────────────────────────────────────────────────

describe('SET_CUSTOMER_STATUS', () => {
  function existingCustomer(overrides: Record<string, unknown> = {}) {
    return makeDynamoItem({
      id: 'c-1', name: 'Acme', normalizedName: 'acme', active: true, status: 'ACTIVE',
      createdAt: '2025-01-01', createdBy: 'someone@bcatcorp.com', updatedAt: '2025-01-02',
      ...overrides,
    })
  }

  it('approves PENDING -> ACTIVE for admin', async () => {
    const existing = existingCustomer({ status: 'PENDING' })
    let update: MockUpdateCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') { update = cmd.input; return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })
    await handler(
      event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'ACTIVE' }, identity({ groups: ['ADMIN'] })),
    )
    const vals = update?.ExpressionAttributeValues ?? {}
    expect(vals[':status']).toEqual({ S: 'ACTIVE' })
    expect(vals[':active']).toEqual({ BOOL: true })
  })

  it('rejects PENDING -> ACTIVE for non-admin', async () => {
    const existing = existingCustomer({ status: 'PENDING' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'ACTIVE' })),
    ).rejects.toThrow('PENDING → ACTIVE requires owner or ADMIN')
  })

  it('non-admin requesting ACTIVE while requireCustomerApproval lands on PENDING', async () => {
    const existing = existingCustomer({ status: 'NEW' })
    const settings = makeDynamoItem({ id: 'default', requireCustomerApproval: true })
    let update: MockUpdateCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') {
        if (String(cmd.input.TableName ?? '').includes('Settings')) return Promise.resolve({ Item: settings })
        return Promise.resolve({ Item: existing })
      }
      if (cmd.__type === 'Update') { update = cmd.input; return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })
    await handler(
      event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'ACTIVE' }),
    )
    const vals = update?.ExpressionAttributeValues ?? {}
    expect(vals[':status']).toEqual({ S: 'PENDING' })
    expect(vals[':active']).toEqual({ BOOL: true })
  })

  it('BLOCKED requires a reason', async () => {
    const existing = existingCustomer()
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'BLOCKED' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('reason cannot be empty')
  })

  it('BLOCKED writes reason, replacement, and derived active=false', async () => {
    const existing = existingCustomer()
    const replacement = existingCustomer({ id: 'c-2', name: 'Replacement' })
    let update: MockUpdateCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') {
        const keyId = cmd.input.Key?.id?.S
        if (keyId === 'c-2') return Promise.resolve({ Item: replacement })
        return Promise.resolve({ Item: existing })
      }
      if (cmd.__type === 'Update') { update = cmd.input; return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })
    await handler(
      event('SET_CUSTOMER_STATUS', {
        id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'BLOCKED',
        reason: 'Bad debt', replacementCustomerId: 'c-2',
      }, identity({ groups: ['ADMIN'] })),
    )
    const vals = update?.ExpressionAttributeValues ?? {}
    expect(vals[':status']).toEqual({ S: 'BLOCKED' })
    expect(vals[':active']).toEqual({ BOOL: false })
    expect(vals[':statusReason']).toEqual({ S: 'Bad debt' })
    expect(vals[':replacementCustomerId']).toEqual({ S: 'c-2' })
  })

  it('BLOCKED rejects self-replacement', async () => {
    const existing = existingCustomer()
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', {
        id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'BLOCKED', reason: 'X', replacementCustomerId: 'c-1',
      }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('replacementCustomerId cannot be the customer itself')
  })

  it('BLOCKED rejects inactive replacement', async () => {
    const existing = existingCustomer()
    const replacement = existingCustomer({ id: 'c-2', status: 'BLOCKED', active: false })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') {
        const keyId = cmd.input.Key?.id?.S
        if (keyId === 'c-2') return Promise.resolve({ Item: replacement })
        return Promise.resolve({ Item: existing })
      }
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', {
        id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'BLOCKED', reason: 'X', replacementCustomerId: 'c-2',
      }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('Replacement customer is inactive')
  })

  it('CLOSED only allowed from a lead stage', async () => {
    const existing = existingCustomer({ status: 'ACTIVE' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'CLOSED' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('CLOSED is only allowed from a lead stage')
  })

  it('allows CLOSED from a lead stage', async () => {
    const existing = existingCustomer({ status: 'QUALIFIED' })
    let update: MockUpdateCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') { update = cmd.input; return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })
    await handler(
      event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'CLOSED', reason: 'No longer interested' }, identity({ groups: ['ADMIN'] })),
    )
    const vals = update?.ExpressionAttributeValues ?? {}
    expect(vals[':status']).toEqual({ S: 'CLOSED' })
    expect(vals[':active']).toEqual({ BOOL: false })
  })

  it('rejects DORMANT as a target status', async () => {
    const existing = existingCustomer()
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'DORMANT' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('DORMANT is derived, not a stored status')
  })

  it('refuses status change on merged customer', async () => {
    const merged = existingCustomer({ mergedIntoId: 'c-2' })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: merged })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: '2025-01-02', status: 'BLOCKED', reason: 'X' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('Cannot change status of a merged customer')
  })

  it('fails on CAS mismatch', async () => {
    const existing = existingCustomer()
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') {
        const err = new Error('ConditionalCheckFailed')
        err.name = 'ConditionalCheckFailedException'
        return Promise.reject(err)
      }
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SET_CUSTOMER_STATUS', { id: 'c-1', expectedUpdatedAt: 'wrong', status: 'BLOCKED', reason: 'X' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('was changed by someone else')
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

// ── SAVE_SETTINGS ─────────────────────────────────────────────────────────────

describe('SAVE_SETTINGS', () => {
  it('creates settings with v2 defaults', async () => {
    let put: MockPutCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Put') { put = cmd.input; return Promise.resolve({}) }
      throw new Error('unexpected')
    })
    const result = await handler(
      event('SAVE_SETTINGS', {
        defaultCreditLimitCents: 100000,
        defaultFreeCreditRequired: true,
        defaultCreditUsageWarningBps: 8000,
        defaultMaxDaysLate: 30,
        requireCustomerApproval: true,
        defaultRequiredDocs: ['POD', 'BOL'],
        defaultRequiredReferences: [{ code: 'PO', level: 'ORDER', display: true, countOnNewOrder: 1 }],
        chargeCodes: [{ code: 'FSC', label: 'Fuel Surcharge', calculatedBy: 'PERCENT' }],
        rateConTerms: 'Net 30.',
      }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.defaultCreditLimitCents).toBe(100000)
    expect(result.defaultFreeCreditRequired).toBe(true)
    expect(result.defaultCreditUsageWarningBps).toBe(8000)
    expect(result.defaultMaxDaysLate).toBe(30)
    expect(result.requireCustomerApproval).toBe(true)
    expect(result.defaultRequiredDocs).toEqual(['POD', 'BOL'])
    expect(result.rateConTerms).toBe('Net 30.')
    expect(put?.Item).toBeDefined()
  })

  it('keeps existing fields when not mentioned (keep semantics)', async () => {
    const existing = makeDynamoItem({
      id: 'default', marginFloorBps: 100, defaultCreditLimitCents: 50000, requireCustomerApproval: true,
      updatedAt: '2025-01-02',
    })
    let update: MockUpdateCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') { update = cmd.input; return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })
    await handler(
      event('SAVE_SETTINGS', { defaultMaxDaysLate: 45, expectedUpdatedAt: '2025-01-02' }, identity({ groups: ['ADMIN'] })),
    )
    const vals = update?.ExpressionAttributeValues ?? {}
    expect(vals[':marginFloorBps']).toEqual({ N: '100' })
    expect(vals[':defaultCreditLimitCents']).toEqual({ N: '50000' })
    expect(vals[':defaultMaxDaysLate']).toEqual({ N: '45' })
  })

  /*
   * Every settings field a row has never carried reads back `undefined`. Naming one in
   * the SET clause without a value is a DynamoDB validation error that takes the whole
   * save down with it — so saving the tracking toggles on a row that has never had an
   * AI memory card used to fail on `:aiAgents`, and saving anything on a fresh row
   * would fail on whichever field it had never seen.
   */
  it('does not name a field the row has never carried, and still writes an explicit clear', async () => {
    const existing = makeDynamoItem({ id: 'default', marginFloorBps: 100, updatedAt: '2025-01-02' })
    let update: MockUpdateCommand['input'] | undefined
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') { update = cmd.input; return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })
    await handler(
      event('SAVE_SETTINGS', { defaultMaxDaysLate: 45, rateConTerms: null, expectedUpdatedAt: '2025-01-02' }, identity({ groups: ['ADMIN'] })),
    )
    const vals = update?.ExpressionAttributeValues ?? {}
    const sets = String(update?.UpdateExpression ?? '')
    for (const [placeholder, value] of Object.entries(vals)) {
      expect(value, `${placeholder} was named with no value`).toBeDefined()
    }
    expect(sets).not.toContain(':aiAgents')
    expect(vals[':aiAgents']).toBeUndefined()
    // An explicit null is a clear, not an absence: it still has to be written.
    expect(vals[':rateConTerms']).toEqual({ NULL: true })
    expect(vals[':defaultMaxDaysLate']).toEqual({ N: '45' })
    expect(vals[':marginFloorBps']).toEqual({ N: '100' })
  })

  it('validates charge code shape', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', { chargeCodes: [{ code: 'FSC' }] }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('chargeCodes[0].label must be a string')
  })

  it('validates defaultRequiredReferences bounds', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', {
        defaultRequiredReferences: [{ code: 'PO', level: 'ORDER', countOnNewOrder: 11 }],
      }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('Value must be at most 10')
  })

  // ── Step P3: org flow defaults ─────────────────────────────────────────────
  it('stores Step P3 org defaults including per-mode margin and check-call plan', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Put') { return Promise.resolve({}) }
      throw new Error('unexpected')
    })
    const result = await handler(event('SAVE_SETTINGS', {
      marginTargetBps: 2000,
      marginTargetBpsByMode: { FTL: 2200, LTL: 2500 },
      marginFloorBps: 500,
      quoteAutoReplyDefault: true,
      defaultRequiredLoadFields: ['pickupAddress', 'deliveryAddress'],
      defaultCheckCallPlan: {
        intervalHours: 4,
        channels: ['SMS', 'EMAIL'],
        milestones: ['AT_PICKUP', 'DELIVERED'],
        escalateAfterMinutes: 30,
        emailDispatcher: true,
        requestPodOnDelivery: true,
      },
    }, identity({ groups: ['ADMIN'] })))
    expect(result.marginTargetBps).toBe(2000)
    expect(result.marginTargetBpsByMode).toEqual({ FTL: 2200, LTL: 2500 })
    expect(result.marginFloorBps).toBe(500)
    expect(result.quoteAutoReplyDefault).toBe(true)
    expect(result.defaultRequiredLoadFields).toEqual(['pickupAddress', 'deliveryAddress'])
    expect(result.defaultCheckCallPlan).toMatchObject({ intervalHours: 4, escalateAfterMinutes: 30 })
  })

  it('refuses an org floor above the org target', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', { marginTargetBps: 1500, marginFloorBps: 2000 }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('marginFloorBps cannot be above marginTargetBps')
  })

  it('refuses an out-of-range basis point value', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', { marginTargetBps: 15000 }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('marginTargetBps must be 0–9999 basis points')
  })

  it('stores the teams and mirrors membership onto the staff rows that moved', async () => {
    const existing = makeDynamoItem({ id: 'default', updatedAt: '2025-01-02' })
    const profiles = [
      makeDynamoItem({ id: 'rep@bcatcorp.com', email: 'rep@bcatcorp.com', teamKeys: [] }),
      makeDynamoItem({ id: 'other@bcatcorp.com', email: 'other@bcatcorp.com', teamKeys: [] }),
    ]
    const updates: MockUpdateCommand['input'][] = []
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: profiles, LastEvaluatedKey: undefined })
      if (cmd.__type === 'Update') { updates.push(cmd.input); return Promise.resolve({ Attributes: existing }) }
      throw new Error('unexpected')
    })

    await handler(event('SAVE_SETTINGS', {
      teams: [{ key: 'east', name: 'East desk', memberIds: ['REP@bcatcorp.com'] }],
      limitCustomerRepView: true,
      expectedUpdatedAt: '2025-01-02',
    }, identity({ groups: ['ADMIN'] })))

    const settingsUpdate = updates.find((u) => u.TableName === 'TmsSettings-test')
    const vals = settingsUpdate?.ExpressionAttributeValues ?? {}
    expect(unmarshall({ teams: vals[':teams'] }).teams).toEqual([
      { key: 'EAST', name: 'East desk', memberIds: ['REP@bcatcorp.com'], active: true },
    ])
    expect(vals[':limitCustomerRepView']).toEqual({ BOOL: true })

    // Only the member's row moved; the staff row already matching is left alone.
    const mirrored = updates.filter((u) => u.TableName === 'UserProfile-test')
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0].Key?.id).toEqual({ S: 'rep@bcatcorp.com' })
    expect(mirrored[0].ExpressionAttributeValues?.[':keys']).toEqual({ L: [{ S: 'EAST' }] })
  })

  it('refuses a team nobody is on', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', {
        teams: [{ key: 'EAST', name: 'East desk', memberIds: [] }],
      }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('Team EAST needs at least one member.')
  })

  it('refuses a commission plan paying a role the engine does not know', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', {
        commissionsEnabled: true,
        commissionPlans: [{
          id: 'house',
          name: 'House plan',
          roles: [{ roleName: 'DISPATCHER', rateType: 'PERCENT_PROFIT', rateBps: 1000 }],
        }],
      }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('commissionPlans[0].roles[0].roleName "DISPATCHER" is not a commission role')
  })
})

// ── Step L: My Brokerage settings, divisions, webhook secrets and import ─────

describe('Step L settings fields', () => {
  it('stores branding, signature, payment terms and notification defaults', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(
      event('SAVE_SETTINGS', {
        brandAccent: 'BLUE',
        brandTheme: 'DARK',
        brandSenders: { shipment: 'ship@bcatcorp.com' },
        emailSignatureTemplate: 'Best, {name} at {company}',
        customerPortalDefaults: { ltlQuoting: 'RATE_CARD', portalStatusMask: ['DRAFT'] },
        customerTags: [{ key: 'VIP', label: 'VIP', color: 'blue' }],
        paymentTerms: [{ name: 'Net 30', days: 30 }],
        notificationDefaults: { pauseAll: true },
      }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.brandAccent).toBe('BLUE')
    expect(result.brandTheme).toBe('DARK')
    expect(result.emailSignatureTemplate).toBe('Best, {name} at {company}')
    expect((result.customerPortalDefaults as Record<string, unknown>)?.ltlQuoting).toBe('RATE_CARD')
    expect((result.customerTags as unknown[])[0]).toMatchObject({ key: 'VIP' })
    expect((result.paymentTerms as unknown[])[0]).toMatchObject({ key: 'net-30' })
    expect((result.notificationDefaults as Record<string, unknown>)?.pauseAll).toBe(true)
  })

  it('refuses a signature token outside the allowed set', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', { emailSignatureTemplate: '{bogus}' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('Unknown template token')
  })

  it('refuses a logo key outside brand/', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', { brandLogoSquareKey: 'invoices/logo.pdf' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('brand/')
  })

  it('refuses LIGHT theme until a second stylesheet exists', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_SETTINGS', { brandTheme: 'LIGHT' }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('dark theme is built')
  })
})

describe('Step L divisions', () => {
  it('stores the new billing-entity fields', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(
      event('SAVE_DIVISION', {
        key: 'BCAT_LOGISTICS',
        name: 'BCAT Logistics',
        taxId: '12-3456789',
        termsUrl: 'https://bcatcorp.com/terms',
        isPrimary: true,
      }, identity({ groups: ['ADMIN'] })),
    )
    expect(result.taxId).toBe('12-3456789')
    expect(result.termsUrl).toBe('https://bcatcorp.com/terms')
    expect(result.isPrimary).toBe(true)
  })

  it('refuses a second primary division', async () => {
    const existingPrimary = makeDynamoItem({
      key: 'OTHER', id: 'OTHER', name: 'Other Entity', isPrimary: true, active: true, updatedAt: '2025-01-02',
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: undefined })
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [existingPrimary], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    await expect(
      handler(event('SAVE_DIVISION', { key: 'BCAT_LOGISTICS', name: 'BCAT', isPrimary: true }, identity({ groups: ['ADMIN'] }))),
    ).rejects.toThrow('already primary')
  })
})

describe('Step L webhook secret rotation', () => {
  it('stores the secret in SSM and updates the webhook row', async () => {
    const existing = makeDynamoItem({
      id: 'default',
      notificationWebhooks: [{ id: 'wh-1', url: 'https://example.com/hook', events: ['SHIPMENT_MILESTONE'], active: true }],
      updatedAt: '2025-01-02',
    })
    let updatedWebhooks: unknown
    ssmSend.mockImplementation(() => Promise.resolve({}))
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Get') return Promise.resolve({ Item: existing })
      if (cmd.__type === 'Update') {
        const vals = (cmd.input.ExpressionAttributeValues ?? {}) as Record<string, AttributeValue>
        updatedWebhooks = unmarshall({ webhooks: vals[':webhooks'] }).webhooks
        return Promise.resolve({ Attributes: existing })
      }
      throw new Error('unexpected')
    })
    const result = await handler(
      event('ROTATE_WEBHOOK_SECRET', { webhookId: 'wh-1' }, identity({ groups: ['ADMIN'] })),
    )
    expect((result as Record<string, unknown>).webhookId).toBe('wh-1')
    const secret = String((result as Record<string, unknown>).secret)
    expect(secret).toBeTruthy()
    const row = (updatedWebhooks as unknown[])[0] as Record<string, unknown>
    expect(row.secretRef).toContain('WEBHOOK:WH-1')
    expect(row.secretLast4).toBe(secret.slice(-4))
    expect(ssmSend).toHaveBeenCalled()
  })
})

describe('Step L import preview', () => {
  it('validates, plans and writes an ImportJob row', async () => {
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    })
    const result = await handler(
      event('PREVIEW_IMPORT', {
        entity: 'CUSTOMER',
        fileName: 'customers.csv',
        fileHash: 'abc123',
        mapping: { Company: 'name', 'MC #': 'mcNumber' },
        rows: [{ Company: 'Acme Inc', 'MC #': '12345' }],
      }, identity({ groups: ['ADMIN'] })),
    )
    expect((result as Record<string, unknown>).jobId).toMatch(/^imp:abc123:CUSTOMER$/)
    expect(((result as Record<string, unknown>).counts as Record<string, number>).created).toBe(1)
    expect((result as Record<string, unknown>).errors).toEqual([])
  })

  it('lists import jobs by entity', async () => {
    const job = makeDynamoItem({
      id: 'imp:hash:CUSTOMER', entity: 'CUSTOMER', status: 'VALIDATED', fileName: 'c.csv', fileHash: 'hash',
      mapping: JSON.stringify({ Company: 'name' }), counts: JSON.stringify({ created: 1, updated: 0, skipped: 0, errored: 0 }),
      createdBy: 'admin@bcatcorp.com', createdAt: '2025-01-02T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
    })
    send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [job], LastEvaluatedKey: undefined })
      throw new Error('unexpected')
    })
    const result = await handler(
      event('LIST_IMPORT_JOBS', { entity: 'CUSTOMER' }, identity({ groups: ['ADMIN'] })),
    )
    const jobs = (result as Record<string, unknown>).jobs as unknown[]
    expect(jobs).toHaveLength(1)
    expect((jobs[0] as Record<string, unknown>).entity).toBe('CUSTOMER')
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
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') { put = cmd.input; return Promise.resolve({}) }
      throw new Error('unexpected')
    }))
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

// ── Step R: ownership taxonomy and department views ──────────────────────────
//
// These three tables decide who earns every shipment and what each department sees,
// so the tests are about the refusals: a tree that loops, a code saved twice, a
// division archived out from under its children or its rules, a rule dropped from
// the list (deactivated, never deleted), and a caller who only has a page group.

const ADMIN_CALLER = identity({ groups: ['ADMIN'] })
const PAGE_CUSTOMER_CALLER = identity({ groups: ['page-customers'] })

function conditionFailed(): Error {
  const err = new Error('ConditionalCheckFailedException: the conditional request failed')
  err.name = 'ConditionalCheckFailedException'
  return err
}

/**
 * An in-memory stand-in for the three tables that honours the two conditions this
 * handler writes with — `attribute_not_exists(id)` and the `version` CAS — so an
 * idempotent seed and a stale save behave here the way they do on DynamoDB.
 */
function ownershipTables(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const tableOf = (name: string): Map<string, Record<string, unknown>> => {
    const found = tables.get(name)
    if (found) return found
    const created = new Map<string, Record<string, unknown>>()
    tables.set(name, created)
    return created
  }
  for (const [name, rows] of Object.entries(seed)) {
    for (const row of rows) tableOf(name).set(String(row.id), row)
  }

  send.mockImplementation((cmd: MockCommand) => {
    const table = tableOf(String(cmd.input.TableName ?? ''))
    // Only the two conditions this handler writes with are honoured; anything else
    // would be a condition the production table would not enforce either.
    const versionMatches = (
      existing: Record<string, unknown> | undefined,
      values: Record<string, AttributeValue>,
    ): boolean => existing != null && Number(existing.version ?? 0) === Number(values[':expectedVersion']?.N)

    if (cmd.__type === 'Scan') {
      return Promise.resolve({ Items: [...table.values()].map((row) => makeDynamoItem(row)), LastEvaluatedKey: undefined })
    }
    if (cmd.__type === 'Get') {
      const row = table.get(String(cmd.input.Key?.id?.S ?? ''))
      return Promise.resolve({ Item: row ? makeDynamoItem(row) : undefined })
    }
    if (cmd.__type === 'Put') {
      const condition = cmd.input.ConditionExpression ?? ''
      const item = unmarshall(cmd.input.Item ?? {})
      const existing = table.get(String(item.id))
      if (condition.includes('attribute_not_exists(id)') && existing) return Promise.reject(conditionFailed())
      if (condition.includes('#version = :expectedVersion') && !versionMatches(existing, cmd.input.ExpressionAttributeValues ?? {})) {
        return Promise.reject(conditionFailed())
      }
      table.set(String(item.id), item)
      return Promise.resolve({})
    }
    const values = cmd.input.ExpressionAttributeValues ?? {}
    const id = String(cmd.input.Key?.id?.S ?? '')
    const existing = table.get(id)
    if ((cmd.input.ConditionExpression ?? '').includes('#version = :expectedVersion') && !versionMatches(existing, values)) {
      return Promise.reject(conditionFailed())
    }
    const next = {
      ...(existing ?? { id }),
      active: values[':active']?.BOOL ?? false,
      updatedAt: values[':updatedAt']?.S,
      updatedBy: values[':updatedBy']?.S,
      version: Number(values[':version']?.N ?? 1),
    }
    table.set(id, next)
    return Promise.resolve({ Attributes: makeDynamoItem(next) })
  })

  return {
    divisions: tableOf('OwnershipDivision-test'),
    rules: tableOf('OwnershipRule-test'),
    views: tableOf('ShipmentView-test'),
    audit: tableOf('AuditLog-test'),
  }
}

const division = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: over.code, code: over.code, name: `Division ${String(over.code)}`, parentId: null,
  sortOrder: 10, active: true, owners: null, flows: null,
  createdBy: 'seed', updatedBy: 'seed', version: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const ownershipRule = (over: Record<string, unknown>): Record<string, unknown> => ({
  name: 'A rule', sortOrder: 0, active: true,
  condition: { kind: 'ALWAYS', value: null }, divisionCode: 'BROKERAGE',
  createdBy: 'seed', updatedBy: 'seed', version: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('ENSURE_OWNERSHIP_SEED', () => {
  it('writes every seed row once and reports zeros on the second call', async () => {
    const tables = ownershipTables()

    const first = await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER)) as Record<string, number>
    expect(first).toMatchObject({
      divisionsCreated: SEED_DIVISIONS.length,
      rulesCreated: SEED_RULES.length,
      rulesUpdated: 0,
      rulesDeactivated: 0,
      viewsCreated: SEED_VIEWS.length,
    })

    const second = await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER)) as Record<string, number>
    expect(second).toMatchObject({
      divisionsCreated: 0,
      rulesCreated: 0,
      rulesUpdated: 0,
      rulesDeactivated: 0,
      rulesUnchanged: SEED_RULES.length,
      viewsCreated: 0,
    })

    expect(tables.divisions.size).toBe(SEED_DIVISIONS.length)
    expect(tables.rules.size).toBe(SEED_RULES.length)
    expect(tables.views.size).toBe(SEED_VIEWS.length)
    expect(tables.divisions.get('ASSETS')).toMatchObject({ createdBy: 'seed', updatedBy: 'seed', version: 1 })
  })

  it('leaves an edited seed row exactly as the admin left it', async () => {
    const tables = ownershipTables({
      'OwnershipDivision-test': [division({ code: 'ASSETS', name: 'Ivan Cartage LLC', active: false, version: 4 })],
    })
    await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER))
    expect(tables.divisions.get('ASSETS')).toMatchObject({ name: 'Ivan Cartage LLC', active: false, version: 4 })
  })

  it('resolves the Auto Shipper customer and points the car-shipping rule at it', async () => {
    const tables = ownershipTables({
      'Customer-test': [{ id: 'cust-auto', name: 'Auto Shipper', active: true }],
    })

    await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER))

    const rule = tables.rules.get('rule-seed-auto-shipper')
    expect(rule).toMatchObject({
      name: 'Auto Shipper customer',
      active: true,
      condition: { kind: 'CUSTOMER_IS', value: 'cust-auto' },
    })
  })

  it('writes the Auto Shipper rule inactive when the customer is missing', async () => {
    const tables = ownershipTables()

    const result = await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER)) as Record<string, number>

    expect(result.rulesCreated).toBe(SEED_RULES.length)
    const rule = tables.rules.get('rule-seed-auto-shipper')
    expect(rule).toMatchObject({
      name: 'Auto Shipper customer (not found — rule inactive)',
      active: false,
      condition: { kind: 'CUSTOMER_IS', value: '' },
    })
  })

  it('updates a changed seed rule in place', async () => {
    const tables = ownershipTables({
      'OwnershipRule-test': [
        ownershipRule({
          id: 'rule-seed-1',
          name: 'Old owner operator name',
          condition: { kind: 'DRIVER_FLEET_GROUP_IS', value: 'OWNER_OPERATOR' },
          divisionCode: 'OWNER_OPERATOR',
          sortOrder: 200,
          version: 3,
        }),
      ],
    })

    const result = await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER)) as Record<string, number>

    expect(result.rulesUpdated).toBe(1)
    expect(tables.rules.get('rule-seed-1')).toMatchObject({ name: 'Owner operator driver', sortOrder: 10, version: 4 })
  })

  it('deactivates a rule that was removed from the seed', async () => {
    const tables = ownershipTables({
      'OwnershipRule-test': [
        ownershipRule({
          id: 'rule-seed-legacy',
          name: 'Retired rule',
          condition: { kind: 'ALWAYS', value: null },
          divisionCode: 'BROKERAGE',
          sortOrder: 999,
          active: true,
          version: 2,
        }),
      ],
    })

    const result = await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER)) as Record<string, number>

    expect(result.rulesDeactivated).toBe(1)
    expect(tables.rules.get('rule-seed-legacy')).toMatchObject({ active: false, version: 3 })
  })

  it('leaves an admin-authored ownership rule active when re-seeding', async () => {
    const tables = ownershipTables({
      'OwnershipRule-test': [
        ownershipRule({
          id: 'rule-b9965c7a-3f10-4b26-9f3e-3e3e3e3e3e3e',
          name: 'Acme account catch-all',
          condition: { kind: 'CUSTOMER_IS', value: 'cust-acme' },
          divisionCode: 'BROKERAGE',
          sortOrder: 100,
          active: true,
          version: 1,
        }),
      ],
    })

    const result = await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER)) as Record<string, number>

    expect(result.rulesDeactivated).toBe(0)
    expect(tables.rules.get('rule-b9965c7a-3f10-4b26-9f3e-3e3e3e3e3e3e')).toMatchObject({
      active: true,
      version: 1,
    })
  })

  it('leaves exactly one Active Shipments view on a second seed', async () => {
    const tables = ownershipTables()
    await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER))
    await handler(event('ENSURE_OWNERSHIP_SEED', {}, ADMIN_CALLER))
    const active = [...tables.views.values()].filter((v) => v.slug === 'active-shipments')
    expect(active).toHaveLength(1)
  })
})

describe('SAVE_OWNERSHIP_DIVISION', () => {
  it('refuses a parent chain that loops', async () => {
    ownershipTables({
      'OwnershipDivision-test': [division({ code: 'ASSETS' }), division({ code: 'BOX_TRUCK', parentId: 'ASSETS' })],
    })
    await expect(
      handler(event('SAVE_OWNERSHIP_DIVISION', { id: 'ASSETS', code: 'ASSETS', name: 'Ivan Cartage', parentId: 'BOX_TRUCK' }, ADMIN_CALLER)),
    ).rejects.toThrow(/its own ancestor/)
  })

  it('refuses a code that is already a division', async () => {
    const tables = ownershipTables({ 'OwnershipDivision-test': [division({ code: 'ASSETS' })] })
    await expect(
      handler(event('SAVE_OWNERSHIP_DIVISION', { code: 'ASSETS', name: 'Something else' }, ADMIN_CALLER)),
    ).rejects.toThrow(/already exists/)
    expect(tables.divisions.get('ASSETS')).toMatchObject({ name: 'Division ASSETS' })
  })

  it('refuses to rename a code and keeps the row the shipments are tagged with', async () => {
    ownershipTables({ 'OwnershipDivision-test': [division({ code: 'ASSETS' })] })
    await expect(
      handler(event('SAVE_OWNERSHIP_DIVISION', { id: 'ASSETS', code: 'FLEET', name: 'Ivan Cartage' }, ADMIN_CALLER)),
    ).rejects.toThrow(/code cannot be changed/)
  })

  it('creates a subsidiary and bumps the version on the next save', async () => {
    const tables = ownershipTables({ 'OwnershipDivision-test': [division({ code: 'ASSETS' })] })
    await handler(event('SAVE_OWNERSHIP_DIVISION', { code: 'LOCAL', name: 'Local Drivers', parentId: 'ASSETS' }, ADMIN_CALLER))
    expect(tables.divisions.get('LOCAL')).toMatchObject({ parentId: 'ASSETS', version: 1, active: true })

    await handler(event('SAVE_OWNERSHIP_DIVISION', { id: 'LOCAL', code: 'LOCAL', name: 'Local drivers', parentId: 'ASSETS' }, ADMIN_CALLER))
    expect(tables.divisions.get('LOCAL')).toMatchObject({ name: 'Local drivers', version: 2 })
  })

  it('refuses an active subdivision under an archived parent, at any depth', async () => {
    const tables = ownershipTables({
      'OwnershipDivision-test': [
        division({ code: 'ASSETS', active: false }),
        division({ code: 'BOX_TRUCK', parentId: 'ASSETS', active: false }),
      ],
    })

    await expect(
      handler(event('SAVE_OWNERSHIP_DIVISION', {
        id: 'BOX_TRUCK', code: 'BOX_TRUCK', name: 'Box trucks', parentId: 'ASSETS', active: true,
      }, ADMIN_CALLER)),
    ).rejects.toThrow(/"Box trucks" cannot be active under the archived division "Division ASSETS"/)

    // A grandchild is refused by the same walk, through an active parent.
    await expect(
      handler(event('SAVE_OWNERSHIP_DIVISION', {
        code: 'LOCAL', name: 'Local drivers', parentId: 'BOX_TRUCK', active: true,
      }, ADMIN_CALLER)),
    ).rejects.toThrow(/cannot be active under the archived division/)
    expect(tables.divisions.get('LOCAL')).toBeUndefined()

    // An archived child under an archived parent is fine — nothing is tagged with it.
    await handler(event('SAVE_OWNERSHIP_DIVISION', {
      id: 'BOX_TRUCK', code: 'BOX_TRUCK', name: 'Box trucks', parentId: 'ASSETS', active: false,
    }, ADMIN_CALLER))
    expect(tables.divisions.get('BOX_TRUCK')).toMatchObject({ name: 'Box trucks', active: false })
  })
})

describe('ARCHIVE_OWNERSHIP_DIVISION', () => {
  it('refuses while an active subsidiary hangs off it', async () => {
    const tables = ownershipTables({
      'OwnershipDivision-test': [division({ code: 'ASSETS' }), division({ code: 'BOX_TRUCK', parentId: 'ASSETS' })],
    })
    await expect(handler(event('ARCHIVE_OWNERSHIP_DIVISION', { id: 'ASSETS' }, ADMIN_CALLER)))
      .rejects.toThrow(/active subsidiary/)
    expect(tables.divisions.get('ASSETS')).toMatchObject({ active: true })
  })

  it('refuses while an active rule still tags shipments with it', async () => {
    ownershipTables({
      'OwnershipDivision-test': [division({ code: 'CAR_SHIPPING' })],
      'OwnershipRule-test': [ownershipRule({ id: 'rule-1', name: 'Vehicle transport', divisionCode: 'CAR_SHIPPING' })],
    })
    await expect(handler(event('ARCHIVE_OWNERSHIP_DIVISION', { id: 'CAR_SHIPPING' }, ADMIN_CALLER)))
      .rejects.toThrow(/Vehicle transport/)
  })

  it('archives rather than deletes once nothing points at it', async () => {
    const tables = ownershipTables({
      'OwnershipDivision-test': [division({ code: 'CAR_SHIPPING' })],
      'OwnershipRule-test': [ownershipRule({ id: 'rule-1', divisionCode: 'CAR_SHIPPING', active: false })],
    })
    await handler(event('ARCHIVE_OWNERSHIP_DIVISION', { id: 'CAR_SHIPPING' }, ADMIN_CALLER))
    expect(tables.divisions.get('CAR_SHIPPING')).toMatchObject({ active: false, version: 2 })
  })
})

describe('SAVE_OWNERSHIP_RULES', () => {
  it('orders by array index and deactivates the rules left out, deleting none', async () => {
    const tables = ownershipTables({
      'OwnershipDivision-test': [division({ code: 'BROKERAGE' }), division({ code: 'ASSETS' })],
      'OwnershipRule-test': [
        ownershipRule({ id: 'rule-1', name: 'Own fleet', divisionCode: 'ASSETS', sortOrder: 0 }),
        ownershipRule({ id: 'rule-2', name: 'Everything else', divisionCode: 'BROKERAGE', sortOrder: 10 }),
      ],
    })

    const saved = await handler(event('SAVE_OWNERSHIP_RULES', {
      rules: [
        { id: 'rule-2', name: 'Everything else', divisionCode: 'BROKERAGE', condition: { kind: 'ALWAYS', value: null } },
        { name: 'Own trucks', divisionCode: 'ASSETS', condition: { kind: 'CARRIER_IS', value: 'OWN_FLEET' } },
      ],
    }, ADMIN_CALLER)) as unknown as Record<string, unknown>[]

    expect(saved.map((r) => [r.id, r.sortOrder])).toEqual([['rule-2', 0], [saved[1].id, 10]])
    expect(String(saved[1].id)).toMatch(/^rule-/)
    // The dropped rule is deactivated and still readable, never removed.
    expect(tables.rules.size).toBe(3)
    expect(tables.rules.get('rule-1')).toMatchObject({ active: false, name: 'Own fleet' })
    expect(tables.rules.get('rule-2')).toMatchObject({ sortOrder: 0, version: 2 })
  })

  it('refuses a rule pointing at a division that is not there', async () => {
    ownershipTables({ 'OwnershipDivision-test': [division({ code: 'BROKERAGE' })] })
    await expect(handler(event('SAVE_OWNERSHIP_RULES', {
      rules: [{ name: 'Ghost', divisionCode: 'NOPE', condition: { kind: 'ALWAYS', value: null } }],
    }, ADMIN_CALLER))).rejects.toThrow(/unknown division "NOPE"/)
  })
})

describe('SAVE_SHIPMENT_VIEW', () => {
  it('slugs a new name into the id the URL carries', async () => {
    const tables = ownershipTables()
    const view = await handler(event('SAVE_SHIPMENT_VIEW', {
      name: 'POD collection', department: 'Documents', filters: { statuses: ['DELIVERED'], docsState: 'POD_MISSING' },
    }, ADMIN_CALLER)) as Record<string, unknown>
    expect(view).toMatchObject({ id: 'pod-collection', slug: 'pod-collection', version: 1 })
    expect(tables.views.get('pod-collection')).toMatchObject({ name: 'POD collection' })
  })

  it('rejects a filter key that is not a shipment filter', async () => {
    const tables = ownershipTables()
    await expect(handler(event('SAVE_SHIPMENT_VIEW', {
      name: 'Typo', filters: { divisons: ['BROKERAGE'] },
    }, ADMIN_CALLER))).rejects.toThrow('"divisons" is not a shipment filter.')
    expect(tables.views.size).toBe(0)
  })

  it('rejects a status that is not a shipment status', async () => {
    ownershipTables()
    await expect(handler(event('SAVE_SHIPMENT_VIEW', {
      name: 'Bad status', filters: { statuses: ['SHIPPED'] },
    }, ADMIN_CALLER))).rejects.toThrow(/not a shipment status/)
  })

  it('archives a view without removing it', async () => {
    const tables = ownershipTables()
    await handler(event('SAVE_SHIPMENT_VIEW', { name: 'Sales' }, ADMIN_CALLER))
    await handler(event('ARCHIVE_SHIPMENT_VIEW', { id: 'sales' }, ADMIN_CALLER))
    expect(tables.views.get('sales')).toMatchObject({ active: false, version: 2 })
  })
})

describe('ownership authorization', () => {
  it('refuses every taxonomy action for a page-customers caller', async () => {
    ownershipTables()
    const actions = [
      'SAVE_OWNERSHIP_DIVISION',
      'ARCHIVE_OWNERSHIP_DIVISION',
      'SAVE_OWNERSHIP_RULES',
      'SAVE_SHIPMENT_VIEW',
      'ARCHIVE_SHIPMENT_VIEW',
      'ENSURE_OWNERSHIP_SEED',
    ]
    for (const action of actions) {
      await expect(handler(event(action, { id: 'x', code: 'X', name: 'X', rules: [] }, PAGE_CUSTOMER_CALLER)))
        .rejects.toThrow(`Forbidden: ${action} requires owner or ADMIN`)
    }
  })

  it('lets a page-tms caller create the customer a shipment needs', async () => {
    send.mockImplementation(withSettingsGet((cmd: MockCommand) => {
      if (cmd.__type === 'Scan') return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      if (cmd.__type === 'Put') return Promise.resolve({})
      throw new Error('unexpected')
    }))
    await expect(handler(event('UPSERT_CUSTOMER', { name: 'Shipments Inc' }, identity({ groups: ['page-tms'] }))))
      .resolves.toMatchObject({ name: 'Shipments Inc' })
  })
})

// ── Step R2: column templates ───────────────────────────────────────────────

function columnTemplateTables(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const tableOf = (name: string): Map<string, Record<string, unknown>> => {
    const found = tables.get(name)
    if (found) return found
    const created = new Map<string, Record<string, unknown>>()
    tables.set(name, created)
    return created
  }
  for (const [name, rows] of Object.entries(seed)) {
    for (const row of rows) tableOf(name).set(String(row.id), row)
  }

  send.mockImplementation((cmd: MockCommand) => {
    const tableName = String(cmd.input.TableName ?? '')
    const table = tableOf(tableName)
    const type = cmd.__type
    if (type === 'Scan') {
      return Promise.resolve({ Items: [...table.values()].map((row) => makeDynamoItem(row)), LastEvaluatedKey: undefined })
    }
    if (type === 'Get') {
      const row = table.get(String(cmd.input.Key?.id?.S ?? ''))
      return Promise.resolve({ Item: row ? makeDynamoItem(row) : undefined })
    }
    if (type === 'Put') {
      const condition = cmd.input.ConditionExpression ?? ''
      const item = unmarshall(cmd.input.Item ?? {})
      const existing = table.get(String(item.id))
      if (condition.includes('attribute_not_exists(id)') && existing) return Promise.reject(conditionFailed())
      if (condition.includes('#version = :expectedVersion') && Number(existing?.version ?? 0) !== Number(cmd.input.ExpressionAttributeValues?.[':expectedVersion']?.N)) {
        return Promise.reject(conditionFailed())
      }
      table.set(String(item.id), item)
      return Promise.resolve({})
    }
    if (type === 'Update') {
      const values = cmd.input.ExpressionAttributeValues ?? {}
      const id = String(cmd.input.Key?.id?.S ?? '')
      const existing = table.get(id)
      if ((cmd.input.ConditionExpression ?? '').includes('#version = :expectedVersion') && Number(existing?.version ?? 0) !== Number(values[':expectedVersion']?.N)) {
        return Promise.reject(conditionFailed())
      }
      const next = {
        ...(existing ?? { id }),
        active: values[':active']?.BOOL ?? false,
        updatedAt: values[':updatedAt']?.S,
        updatedBy: values[':updatedBy']?.S,
        version: Number(values[':version']?.N ?? 1),
      }
      table.set(id, next)
      return Promise.resolve({ Attributes: makeDynamoItem(next) })
    }
    if (type === 'Delete') {
      const id = String(cmd.input.Key?.id?.S ?? '')
      const existing = table.get(id)
      if (!existing) {
        const err = new Error('ResourceNotFoundException')
        err.name = 'ResourceNotFoundException'
        return Promise.reject(err)
      }
      if ((cmd.input.ConditionExpression ?? '').includes('#version = :expectedVersion') && Number(existing.version ?? 0) !== Number(cmd.input.ExpressionAttributeValues?.[':expectedVersion']?.N)) {
        return Promise.reject(conditionFailed())
      }
      table.delete(id)
      return Promise.resolve({})
    }
    throw new Error(`unexpected ${type}`)
  })

  return {
    templates: tableOf('ShipmentColumnTemplate-test'),
    views: tableOf('ShipmentView-test'),
    audit: tableOf('AuditLog-test'),
  }
}

const template = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 't-1',
  name: 'Template',
  columns: ['status'],
  widths: {},
  ownerEmail: 'alice@bcatcorp.com',
  shared: false,
  createdBy: 'alice@bcatcorp.com',
  updatedBy: 'alice@bcatcorp.com',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('SAVE_COLUMN_TEMPLATE and DELETE_COLUMN_TEMPLATE', () => {
  const TMS_CALLER = identity({ groups: ['page-tms'] })
  const ADMIN = identity({ groups: ['ADMIN'] })

  it('creates a template and takes ownerEmail from the caller, ignoring input', async () => {
    const tables = columnTemplateTables()
    const result = (await handler(event('SAVE_COLUMN_TEMPLATE', {
      name: 'Ryne',
      columns: ['status', 'proNumber'],
      ownerEmail: 'someone@else.com',
    }, TMS_CALLER))) as Record<string, unknown>
    expect(result).toMatchObject({ name: 'Ryne', ownerEmail: 'dennis@bcatcorp.com', shared: false, version: 1 })
    expect(result.columns).toEqual(['status', 'proNumber'])
    expect(tables.templates.size).toBe(1)
  })

  it('refuses an unknown column key by name', async () => {
    columnTemplateTables()
    await expect(
      handler(event('SAVE_COLUMN_TEMPLATE', { name: 'Bad', columns: ['status', 'notAColumn'] }, TMS_CALLER)),
    ).rejects.toThrow('"notAColumn" is not a board column')
  })

  it('refuses an empty column list', async () => {
    columnTemplateTables()
    await expect(
      handler(event('SAVE_COLUMN_TEMPLATE', { name: 'Empty', columns: [] }, TMS_CALLER)),
    ).rejects.toThrow('columns cannot be empty')
  })

  it('refuses a non-owner update of a private template', async () => {
    const tables = columnTemplateTables({ 'ShipmentColumnTemplate-test': [template({ id: 't-private' })] })
    await expect(
      handler(event('SAVE_COLUMN_TEMPLATE', { id: 't-private', name: 'Hacked', columns: ['status'] }, identity({ email: 'bob@bcatcorp.com', groups: ['page-tms'] }))),
    ).rejects.toThrow(/Forbidden/)
    expect(tables.templates.get('t-private')).toMatchObject({ name: 'Template' })
  })

  it('refuses a non-owner delete of a private template', async () => {
    const tables = columnTemplateTables({ 'ShipmentColumnTemplate-test': [template({ id: 't-private' })] })
    await expect(
      handler(event('DELETE_COLUMN_TEMPLATE', { id: 't-private' }, identity({ email: 'bob@bcatcorp.com', groups: ['page-tms'] }))),
    ).rejects.toThrow(/Forbidden/)
    expect(tables.templates.has('t-private')).toBe(true)
  })

  it('lets an admin update a shared template', async () => {
    const tables = columnTemplateTables({ 'ShipmentColumnTemplate-test': [template({ id: 't-shared', shared: true })] })
    const result = (await handler(event('SAVE_COLUMN_TEMPLATE', { id: 't-shared', name: 'Updated', columns: ['status'] }, ADMIN))) as Record<string, unknown>
    expect(result.name).toBe('Updated')
    expect(tables.templates.get('t-shared')).toMatchObject({ name: 'Updated', version: 2 })
  })

  it('resolves a view to its own columns when its template is gone', () => {
    const templates = new Map<string, Record<string, unknown>>()
    expect(resolveViewColumns({ columnTemplateId: 'deleted', columns: ['originCity'] }, templates)).toEqual(['originCity'])
    templates.set('deleted', { columns: ['status'] })
    expect(resolveViewColumns({ columnTemplateId: 'deleted', columns: ['originCity'] }, templates)).toEqual(['status'])
  })

  it('preserves the existing ownerEmail when an admin edits a shared template', async () => {
    const tables = columnTemplateTables({ 'ShipmentColumnTemplate-test': [template({ id: 't-shared', shared: true, ownerEmail: 'alice@bcatcorp.com' })] })
    const result = (await handler(event('SAVE_COLUMN_TEMPLATE', { id: 't-shared', name: 'Updated', columns: ['status'] }, ADMIN))) as Record<string, unknown>
    expect(result.ownerEmail).toBe('alice@bcatcorp.com')
    expect(tables.templates.get('t-shared')).toMatchObject({ ownerEmail: 'alice@bcatcorp.com', version: 2 })
  })

  it('accepts non-default board columns that are still valid', async () => {
    const tables = columnTemplateTables()
    const result = (await handler(event('SAVE_COLUMN_TEMPLATE', {
      name: 'Extended',
      columns: ['number', 'pickupAppt', 'salesRepId', 'division'],
    }, TMS_CALLER))) as Record<string, unknown>
    expect(result.columns).toEqual(['number', 'pickupAppt', 'salesRepId', 'division'])
    expect(tables.templates.size).toBe(1)
  })

  it('refuses an unknown column key by name even when validating against the full board list', async () => {
    columnTemplateTables()
    await expect(
      handler(event('SAVE_COLUMN_TEMPLATE', { name: 'Bad', columns: ['status', 'notAColumn'] }, TMS_CALLER)),
    ).rejects.toThrow('"notAColumn" is not a board column')
  })
})

// ── Step J: the integration framework ─────────────────────────────────────────

interface SsmCommand {
  __type: 'GetParameter' | 'PutParameter' | 'DeleteParameter' | 'GetParametersByPath'
  input: { Name?: string; Value?: string; Type?: string; Overwrite?: boolean; Path?: string; WithDecryption?: boolean }
}

const INTEGRATION_PATH = '/bcat/integrations/us-east-1_TEST'

/** An in-memory Parameter Store that answers ParameterNotFound like the real one. */
function ssmStore(seed: Record<string, string> = {}) {
  const params = new Map<string, string>(Object.entries(seed))
  const puts: SsmCommand[] = []
  const deletes: string[] = []
  ssmSend.mockImplementation((cmd: SsmCommand) => {
    if (cmd.__type === 'GetParameter') {
      const value = params.get(String(cmd.input.Name ?? ''))
      if (value == null) {
        const err = new Error('ParameterNotFound')
        err.name = 'ParameterNotFound'
        return Promise.reject(err)
      }
      return Promise.resolve({ Parameter: { Name: cmd.input.Name, Value: value } })
    }
    if (cmd.__type === 'PutParameter') {
      puts.push(cmd)
      params.set(String(cmd.input.Name ?? ''), String(cmd.input.Value ?? ''))
      return Promise.resolve({})
    }
    if (cmd.__type === 'DeleteParameter') {
      deletes.push(String(cmd.input.Name ?? ''))
      params.delete(String(cmd.input.Name ?? ''))
      return Promise.resolve({})
    }
    const prefix = String(cmd.input.Path ?? '')
    const found = [...params.entries()].filter(([name]) => name.startsWith(prefix))
    return Promise.resolve({ Parameters: found.map(([Name, Value]) => ({ Name, Value })) })
  })
  return { params, puts, deletes }
}

interface IntegrationMockUpdate {
  __type: 'Update'
  input: {
    TableName?: string
    Key?: Record<string, AttributeValue>
    UpdateExpression?: string
    ExpressionAttributeValues?: Record<string, AttributeValue>
  }
}

/**
 * The Integration + AuditLog tables, honouring `attribute_not_exists(id)` and the
 * `version` CAS, plus the one `SET … ADD …` update RUN_STUB issues. Every command
 * the handler sent is kept so a test can assert over the WHOLE set of tables
 * touched — which is how "a stub writes nothing else" is proved.
 */
function integrationTables(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const seen: MockCommand[] = []
  const tableOf = (name: string): Map<string, Record<string, unknown>> => {
    const found = tables.get(name)
    if (found) return found
    const created = new Map<string, Record<string, unknown>>()
    tables.set(name, created)
    return created
  }
  for (const [name, rows] of Object.entries(seed)) {
    for (const row of rows) tableOf(name).set(String(row.id), row)
  }

  send.mockImplementation((cmd: MockCommand) => {
    seen.push(cmd)
    const table = tableOf(String(cmd.input.TableName ?? ''))
    if (cmd.__type === 'Scan') {
      return Promise.resolve({ Items: [...table.values()].map((row) => makeDynamoItem(row)), LastEvaluatedKey: undefined })
    }
    if (cmd.__type === 'Get') {
      const row = table.get(String(cmd.input.Key?.id?.S ?? ''))
      return Promise.resolve({ Item: row ? makeDynamoItem(row) : undefined })
    }
    if (cmd.__type === 'Put') {
      const condition = cmd.input.ConditionExpression ?? ''
      const item = unmarshall(cmd.input.Item ?? {})
      const existing = table.get(String(item.id))
      if (condition.includes('attribute_not_exists(id)') && existing) {
        return Promise.reject(conditionFailed())
      }
      if (condition.includes('#version = :expectedVersion')) {
        const expected = Number(cmd.input.ExpressionAttributeValues?.[':expectedVersion']?.N)
        if (!existing || Number(existing.version ?? 0) !== expected) return Promise.reject(conditionFailed())
      }
      table.set(String(item.id), item)
      return Promise.resolve({})
    }
    const update = cmd as unknown as IntegrationMockUpdate
    const id = String(update.input.Key?.id?.S ?? '')
    const existing = table.get(id) ?? { id }
    const values = update.input.ExpressionAttributeValues ?? {}
    const next: Record<string, unknown> = {
      ...existing,
      lastStubAt: values[':at']?.S,
      updatedAt: values[':at']?.S,
      updatedBy: values[':by']?.S,
      stubCount: Number(existing.stubCount ?? 0) + Number(values[':one']?.N ?? 0),
      version: Number(existing.version ?? 0) + Number(values[':one']?.N ?? 0),
    }
    table.set(id, next)
    return Promise.resolve({ Attributes: makeDynamoItem(next) })
  })

  return {
    integrations: tableOf('Integration-test'),
    audit: tableOf('AuditLog-test'),
    seen,
    tableNames: (): string[] => [...new Set(seen.map((cmd) => String(cmd.input.TableName ?? '')))].sort(),
  }
}

function auditRows(audit: Map<string, Record<string, unknown>>): Record<string, unknown>[] {
  return [...audit.values()]
}

/** Replace global fetch for one test and hand back the spy. */
function mockFetch(answer: { status: number; body: string }): Mock<() => Promise<Response>> {
  const spy = vi.fn(async () => new Response(answer.body, { status: answer.status }))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

describe('LIST_INTEGRATIONS', () => {
  it('creates every registry row once and writes nothing on a second call', async () => {
    const tables = integrationTables()
    const first = (await handler(event('LIST_INTEGRATIONS', {}, ADMIN_CALLER))) as unknown as Record<string, unknown>[]

    expect(first).toHaveLength(PROVIDERS.length)
    // Spec §8.1 order, which is what the index page's category tabs print.
    expect(first.map((r) => r.provider)).toEqual(PROVIDERS.map((p) => p.key))
    expect(tables.integrations.size).toBe(PROVIDERS.length)
    expect([...tables.integrations.keys()].sort()).toEqual(PROVIDERS.map((p) => p.key).sort())
    for (const row of tables.integrations.values()) {
      expect(row).toMatchObject({ kind: 'PROVIDER', status: 'NOT_CONNECTED', health: 'UNKNOWN', version: 1 })
    }

    const putsAfterSeed = tables.seen.filter((cmd) => cmd.__type === 'Put').length
    const second = (await handler(event('LIST_INTEGRATIONS', {}, ADMIN_CALLER))) as unknown as Record<string, unknown>[]
    expect(second).toHaveLength(PROVIDERS.length)
    expect(tables.seen.filter((cmd) => cmd.__type === 'Put').length).toBe(putsAfterSeed)
  })

  it('names the stack secrets a STACK provider is missing, and none when it holds them', async () => {
    integrationTables()
    delete process.env.MOTIVE_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real'
    const rows = (await handler(event('LIST_INTEGRATIONS', {}, ADMIN_CALLER))) as unknown as Record<string, unknown>[]
    const motive = rows.find((r) => r.provider === 'MOTIVE')
    const anthropic = rows.find((r) => r.provider === 'ANTHROPIC')
    expect(motive?.missingCredentials).toEqual(['MOTIVE_API_KEY'])
    expect(motive?.credentialRef).toBe('MOTIVE_API_KEY')
    expect(anthropic?.missingCredentials).toEqual([])
    delete process.env.ANTHROPIC_API_KEY
  })
})

describe('CONNECT_INTEGRATION', () => {
  it('writes one SecureString at the pool path and never a value into the table or the audit row', async () => {
    const tables = integrationTables()
    const store = ssmStore()
    const fetchSpy = mockFetch({ status: 200, body: '{}' })

    const row = (await handler(
      event(
        'CONNECT_INTEGRATION',
        {
          provider: 'DAT',
          credentials: {
            serviceAccountEmail: 'ops@bcatcorp.com',
            serviceAccountPassword: 'hunter2-super-secret',
            rateViewTier: 'Combo Premium',
          },
        },
        ADMIN_CALLER,
      ),
    )) as Record<string, unknown>

    expect(store.puts).toHaveLength(1)
    expect(store.puts[0].input).toMatchObject({ Name: `${INTEGRATION_PATH}/DAT`, Type: 'SecureString', Overwrite: true })

    expect(row).toMatchObject({ status: 'CONNECTED', credentialRef: `${INTEGRATION_PATH}/DAT` })
    expect(row.credentialMask).toEqual([
      { key: 'serviceAccountEmail', last4: '.com' },
      { key: 'serviceAccountPassword', last4: 'cret' },
      { key: 'rateViewTier', last4: 'mium' },
    ])

    // The whole serialised state of every table this action touched, and the audit
    // row's whole `changes` blob: the password must appear in neither.
    const everything = JSON.stringify([...tables.integrations.values(), ...auditRows(tables.audit)])
    expect(everything).not.toContain('hunter2-super-secret')
    const connectAudit = auditRows(tables.audit).find((a) => a.action === 'CONNECT_INTEGRATION')
    expect(String(connectAudit?.changes)).not.toContain('hunter2-super-secret')
    expect(JSON.parse(String(connectAudit?.changes)) as Record<string, unknown>).toMatchObject({
      provider: 'DAT',
      fields: ['rateViewTier', 'serviceAccountEmail', 'serviceAccountPassword'],
    })
    // DAT has no read call to prove the credential with, so nothing was called.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts a one-field re-entry and keeps the fields that were not typed', async () => {
    integrationTables()
    const store = ssmStore({
      [`${INTEGRATION_PATH}/DAT`]: JSON.stringify({
        serviceAccountEmail: 'ops@bcatcorp.com',
        serviceAccountPassword: 'old-password-value',
        rateViewTier: 'Combo Pro',
      }),
    })
    mockFetch({ status: 200, body: '{}' })

    // The page sends ONLY what was typed: a masked field it did not touch has no
    // value to send. Rotating the password must not answer "the e-mail is required".
    const row = (await handler(
      event(
        'CONNECT_INTEGRATION',
        { provider: 'DAT', credentials: { serviceAccountPassword: 'new-password-value' } },
        ADMIN_CALLER,
      ),
    )) as Record<string, unknown>

    expect(row).toMatchObject({ status: 'CONNECTED' })
    const stored = JSON.parse(String(store.params.get(`${INTEGRATION_PATH}/DAT`))) as Record<string, string>
    expect(stored).toEqual({
      serviceAccountEmail: 'ops@bcatcorp.com',
      serviceAccountPassword: 'new-password-value',
      rateViewTier: 'Combo Pro',
    })
    // The mask still covers all three, so the page knows nothing was lost.
    expect(row.credentialMask).toHaveLength(3)
  })

  it('keeps the webhook signing secret in a parameter of its own', async () => {
    integrationTables()
    const store = ssmStore()
    mockFetch({ status: 200, body: '{}' })

    const row = (await handler(
      event(
        'CONNECT_INTEGRATION',
        {
          provider: 'MYCARRIERPACKETS',
          credentials: { username: 'bcat', password: 'mcp-password', webhookSigningSecret: 'whsec-abcdef' },
        },
        ADMIN_CALLER,
      ),
    )) as Record<string, unknown>

    // The public tracking Lambda may read `<PROVIDER>/webhook` and nothing else,
    // so the password must not be in the parameter it can decrypt.
    const main = String(store.params.get(`${INTEGRATION_PATH}/MYCARRIERPACKETS`))
    const webhook = String(store.params.get(`${INTEGRATION_PATH}/MYCARRIERPACKETS/webhook`))
    expect(JSON.parse(webhook) as Record<string, string>).toEqual({ webhookSigningSecret: 'whsec-abcdef' })
    expect(main).not.toContain('whsec-abcdef')
    expect(webhook).not.toContain('mcp-password')
    // The page still sees one object: all three fields are masked on the row.
    expect(row.credentialMask).toHaveLength(3)
  })

  it('refuses a DAT service account with a plus address', async () => {
    integrationTables()
    ssmStore()
    await expect(
      handler(
        event(
          'CONNECT_INTEGRATION',
          {
            provider: 'DAT',
            credentials: { serviceAccountEmail: 'ops+dat@bcatcorp.com', serviceAccountPassword: 'x', rateViewTier: 'Combo Pro' },
          },
          ADMIN_CALLER,
        ),
      ),
    ).rejects.toThrow(/without a "\+"/)
  })

  it('refuses a STACK provider with the rotation command', async () => {
    integrationTables()
    ssmStore()
    await expect(
      handler(event('CONNECT_INTEGRATION', { provider: 'MOTIVE', credentials: { key: 'x' } }, ADMIN_CALLER)),
    ).rejects.toThrow('managed by the stack — rotate with `npx ampx secret set MOTIVE_API_KEY`')
  })
})

describe('DISCONNECT_INTEGRATION', () => {
  it('deletes the parameter, keeps the settings and the row', async () => {
    const tables = integrationTables({
      'Integration-test': [
        {
          id: 'DAT',
          provider: 'DAT',
          kind: 'PROVIDER',
          credentialSource: 'PAGE',
          status: 'CONNECTED',
          mode: 'LIVE',
          health: 'OK',
          settings: { refreshIntervalMin: 20 },
          credentialMask: [{ key: 'serviceAccountPassword', last4: 'cret' }],
          version: 3,
        },
      ],
    })
    const store = ssmStore({ [`${INTEGRATION_PATH}/DAT`]: JSON.stringify({ serviceAccountPassword: 'x' }) })

    const row = (await handler(event('DISCONNECT_INTEGRATION', { provider: 'DAT' }, ADMIN_CALLER))) as Record<string, unknown>

    // Both: leaving the webhook secret behind would let a disconnected provider
    // keep posting to the public receiver.
    expect(store.deletes).toEqual([`${INTEGRATION_PATH}/DAT`, `${INTEGRATION_PATH}/DAT/webhook`])
    expect(row).toMatchObject({ status: 'DISCONNECTED', mode: 'STUB', credentialMask: null, version: 4 })
    expect(row.settings).toEqual({ refreshIntervalMin: 20 })
    expect(tables.integrations.get('DAT')).toBeDefined()
  })

  it('refuses a STACK provider', async () => {
    integrationTables({ 'Integration-test': [{ id: 'MOTIVE', provider: 'MOTIVE', kind: 'PROVIDER', version: 1 }] })
    ssmStore()
    await expect(handler(event('DISCONNECT_INTEGRATION', { provider: 'MOTIVE' }, ADMIN_CALLER)))
      .rejects.toThrow('managed by the stack — rotate with `npx ampx secret set MOTIVE_API_KEY`')
  })
})

describe('VALIDATE_INTEGRATION', () => {
  it('answers NEUTERED_ON_DEV for a disabled-on-dev secret without calling the provider', async () => {
    const tables = integrationTables()
    ssmStore()
    const fetchSpy = mockFetch({ status: 200, body: '{}' })
    process.env.MOTIVE_API_KEY = 'disabled-on-dev'

    const row = (await handler(event('VALIDATE_INTEGRATION', { provider: 'MOTIVE' }, ADMIN_CALLER))) as Record<string, unknown>

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(row).toMatchObject({ health: 'UNABLE_TO_VERIFY', healthReason: 'NEUTERED_ON_DEV', mode: 'STUB' })
    expect(row.health).not.toBe('OK')
    expect(row.lastOkAt ?? null).toBeNull()
    expect(auditRows(tables.audit).filter((a) => a.action === 'VALIDATE_INTEGRATION')).toHaveLength(1)
    delete process.env.MOTIVE_API_KEY
  })

  it('connects a STACK provider that answers, and keeps its 2xx body out of the row', async () => {
    const tables = integrationTables()
    ssmStore()
    // Motive's vehicle list answers with drivers and positions. A successful check
    // must say that it worked, not who it worked as — nothing of this body is stored.
    mockFetch({ status: 200, body: '{"user":{"email":"ryne@bcatcorp.com","phone":"630-555-0100"}}' })
    process.env.MOTIVE_API_KEY = 'motive-live-key'

    const row = (await handler(event('VALIDATE_INTEGRATION', { provider: 'MOTIVE' }, ADMIN_CALLER))) as Record<string, unknown>

    // A STACK secret is never "connected" by a page action; a working key is what
    // connects it, or the badge would read Not connected for a key that just worked.
    expect(row).toMatchObject({ status: 'CONNECTED', health: 'OK', healthReason: 'OK' })
    expect(row.lastOkAt).toBeTruthy()
    expect(row.healthDetail ?? null).toBeNull()
    const everything = JSON.stringify([...tables.integrations.values(), ...auditRows(tables.audit)])
    expect(everything).not.toContain('630-555-0100')
    expect(everything).not.toContain('ryne@bcatcorp.com')
    delete process.env.MOTIVE_API_KEY
  })

  it('maps a 401 to INVALID_CREDENTIALS and records the check', async () => {
    integrationTables()
    ssmStore()
    const fetchSpy = mockFetch({ status: 401, body: '{"error":"unauthorized"}' })
    process.env.MOTIVE_API_KEY = 'motive-live-key'

    const row = (await handler(event('VALIDATE_INTEGRATION', { provider: 'MOTIVE' }, ADMIN_CALLER))) as Record<string, unknown>

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(row).toMatchObject({ health: 'INVALID_CREDENTIALS', healthReason: 'INVALID_CREDENTIALS' })
    expect(String(row.healthDetail)).toContain('HTTP 401')
    expect(row.lastCheckBy).toBe('dennis@bcatcorp.com')
    const events = row.events as Array<Record<string, unknown>>
    expect(events[0]).toMatchObject({ action: 'VALIDATE', outcome: 'INVALID_CREDENTIALS' })
    delete process.env.MOTIVE_API_KEY
  })

  it('never leaks the key into the stored detail', async () => {
    const tables = integrationTables()
    ssmStore()
    mockFetch({ status: 403, body: '{"message":"bad key motive-live-key"}' })
    process.env.MOTIVE_API_KEY = 'motive-live-key'

    await handler(event('VALIDATE_INTEGRATION', { provider: 'MOTIVE' }, ADMIN_CALLER))
    const everything = JSON.stringify([...tables.integrations.values(), ...auditRows(tables.audit)])
    expect(everything).not.toContain('motive-live-key')
    delete process.env.MOTIVE_API_KEY
  })
})

describe('RUN_STUB', () => {
  it('writes exactly one AuditLog row and touches no other table', async () => {
    const tables = integrationTables({
      'Integration-test': [
        { id: 'DAT', provider: 'DAT', kind: 'PROVIDER', mode: 'STUB', status: 'NOT_CONNECTED', settings: {}, version: 1 },
      ],
    })
    ssmStore()

    const result = (await handler(event('RUN_STUB', { provider: 'DAT', capability: 'post' }, ADMIN_CALLER))) as {
      row: Record<string, unknown>
      result: Record<string, unknown>
    }

    expect(result.result).toMatchObject({ mode: 'STUB', ok: true })
    expect(String(result.result.message)).toMatch(/^STUB — /)
    expect(String(result.result.externalId)).toMatch(/^stub:/)
    expect(result.row).toMatchObject({ stubCount: 1 })

    // Every table this action reached, Load / Shipment / Order / Invoice included.
    expect(tables.tableNames()).toEqual(['AuditLog-test', 'Integration-test'])
    const rows = auditRows(tables.audit)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entityType: 'INTEGRATION', entityId: 'DAT', action: 'STUB_POST' })
    expect(JSON.parse(String(rows[0].changes)) as Record<string, unknown>).toMatchObject({ stub: true, provider: 'DAT' })
  })

  it('refuses a capability the provider does not declare', async () => {
    integrationTables({ 'Integration-test': [{ id: 'DAT', provider: 'DAT', kind: 'PROVIDER', mode: 'STUB', version: 1 }] })
    ssmStore()
    await expect(handler(event('RUN_STUB', { provider: 'DAT', capability: 'factor' }, ADMIN_CALLER)))
      .rejects.toThrow('DAT does not declare the factor capability.')
  })

  it('refuses a capability that has a real implementation, whatever the row says', async () => {
    // OTR's `factor` IS implemented — it is F's gated SEND_TO_FACTOR — so a stub
    // of it would be a second door into AR dressed up as a demo (invariant 1).
    integrationTables({ 'Integration-test': [{ id: 'OTR', provider: 'OTR', kind: 'PROVIDER', mode: 'STUB', version: 1 }] })
    ssmStore()
    await expect(handler(event('RUN_STUB', { provider: 'OTR', capability: 'factor' }, ADMIN_CALLER)))
      .rejects.toThrow(/is live for factor/)
  })
})

describe('SAVE_INTEGRATION_SETTINGS', () => {
  it('validates the behaviour card and CASes on version', async () => {
    const tables = integrationTables({
      'Integration-test': [{ id: 'DAT', provider: 'DAT', kind: 'PROVIDER', mode: 'STUB', settings: {}, version: 2 }],
    })
    ssmStore()

    await expect(
      handler(event('SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: { refreshIntervalMin: 17 } }, ADMIN_CALLER)),
    ).rejects.toThrow(/refresh/i)

    const row = (await handler(
      event('SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: { refreshIntervalMin: 20 }, expectedVersion: 2 }, ADMIN_CALLER),
    )) as Record<string, unknown>
    expect(row.version).toBe(3)
    expect((row.settings as Record<string, unknown>).refreshIntervalMin).toBe(20)

    await expect(
      handler(event('SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: { refreshIntervalMin: 25 }, expectedVersion: 2 }, ADMIN_CALLER)),
    ).rejects.toThrow(/changed by someone else/)
    expect(tables.integrations.get('DAT')).toMatchObject({ version: 3 })
  })
})

describe('ISSUE_API_CLIENT', () => {
  it('returns the secret once and stores only its hash', async () => {
    const tables = integrationTables()
    const store = ssmStore()

    const issued = (await handler(event('ISSUE_API_CLIENT', { name: 'Batory portal', scopes: ['READ'] }, ADMIN_CALLER))) as {
      row: Record<string, unknown>
      clientId: string
      secret: string
    }

    expect(issued.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(issued.row).toMatchObject({ id: `api:${issued.clientId}`, kind: 'API_CLIENT', scopes: ['READ'] })

    const parameter = JSON.parse(String(store.params.get(`${INTEGRATION_PATH}/OPENAPI`))) as {
      signingKey: string
      clients: Record<string, { hash: string }>
    }
    expect(parameter.signingKey).toMatch(/^[0-9a-f]{64}$/)
    expect(parameter.clients[issued.clientId].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(parameter)).not.toContain(issued.secret)

    const everything = JSON.stringify([...tables.integrations.values(), ...auditRows(tables.audit)])
    expect(everything).not.toContain(issued.secret)

    const revoked = (await handler(event('REVOKE_API_CLIENT', { clientId: issued.clientId }, ADMIN_CALLER))) as Record<string, unknown>
    expect(revoked).toMatchObject({ status: 'DISCONNECTED' })
    expect(revoked.revokedAt).toBeTruthy()
    expect(tables.integrations.get(`api:${issued.clientId}`)).toBeDefined()
  })
})

describe('PREVIEW_QBO_SYNC', () => {
  it('returns the payload and sends nothing', async () => {
    integrationTables()
    ssmStore()
    const fetchSpy = mockFetch({ status: 200, body: '{}' })
    const preview = (await handler(
      event(
        'PREVIEW_QBO_SYNC',
        {
          kind: 'INVOICE',
          record: {
            number: 'INV-1',
            invoiceDate: '2026-03-04',
            dueAt: '2026-04-03',
            customerId: 'c1',
            lines: [{ code: 'LINEHAUL', label: 'Linehaul', amountCents: 125000 }],
            totalCents: 125000,
          },
          mappings: { arAccountRef: '84', chargeCodeItems: { LINEHAUL: '1' }, customerRefs: { c1: '58' } },
        },
        ADMIN_CALLER,
      ),
    )) as { payload: Record<string, unknown>; mode: string }
    expect(preview.mode).toBe('STUB')
    expect(preview.payload).toMatchObject({ DocNumber: 'INV-1', TotalAmt: '1250.00' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('integration authorization and the no-delete rule', () => {
  const J_ACTIONS: Array<[string, Record<string, unknown>]> = [
    ['LIST_INTEGRATIONS', {}],
    ['CONNECT_INTEGRATION', { provider: 'DAT', credentials: { serviceAccountEmail: 'a@b.com' } }],
    ['VALIDATE_INTEGRATION', { provider: 'DAT' }],
    ['SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: {} }],
    ['DISCONNECT_INTEGRATION', { provider: 'DAT' }],
    ['RUN_STUB', { provider: 'DAT', capability: 'post' }],
    ['CONNECT_QUICKBOOKS', { code: 'c', realmId: 'r', redirectUri: 'https://x' }],
    ['REFRESH_QUICKBOOKS', {}],
    ['PREVIEW_QBO_SYNC', { kind: 'INVOICE', record: {} }],
    ['ISSUE_API_CLIENT', { name: 'x', scopes: ['READ'] }],
    ['REVOKE_API_CLIENT', { clientId: 'x' }],
  ]

  it('refuses a page-tms caller on every J action', async () => {
    integrationTables()
    ssmStore()
    const pageTms = identity({ groups: ['page-tms', 'page-customers'] })
    for (const [action, input] of J_ACTIONS) {
      await expect(handler(event(action, input, pageTms))).rejects.toThrow(
        `Forbidden: ${action} requires owner or ADMIN`,
      )
    }
  })

  it('issues no DynamoDB Delete anywhere in the framework', async () => {
    const tables = integrationTables({
      'Integration-test': [
        { id: 'DAT', provider: 'DAT', kind: 'PROVIDER', credentialSource: 'PAGE', mode: 'STUB', settings: {}, status: 'CONNECTED', version: 1 },
      ],
    })
    ssmStore({ [`${INTEGRATION_PATH}/DAT`]: JSON.stringify({ serviceAccountPassword: 'x' }) })
    mockFetch({ status: 200, body: '{}' })

    await handler(event('LIST_INTEGRATIONS', {}, ADMIN_CALLER))
    await handler(event('RUN_STUB', { provider: 'DAT', capability: 'post' }, ADMIN_CALLER))
    await handler(event('VALIDATE_INTEGRATION', { provider: 'DAT' }, ADMIN_CALLER))
    await handler(event('DISCONNECT_INTEGRATION', { provider: 'DAT' }, ADMIN_CALLER))

    const kinds = [...new Set(tables.seen.map((cmd) => cmd.__type))].sort()
    expect(kinds).not.toContain('Delete')
    expect(kinds).not.toContain('Transact')
    expect(tables.tableNames()).toEqual(['AuditLog-test', 'Integration-test'])
  })
})

describe('ASK_ACADEMY', () => {
  const event = (input: Record<string, unknown>) => ({
    arguments: { action: 'ASK_ACADEMY', input: JSON.stringify(input) },
    identity: ADMIN_CALLER,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    finalMessage.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ answer: 'Use the release gate.', citations: ['release-to-accounting'] }) }],
      usage: { input_tokens: 1000, output_tokens: 50 },
    })
  })

  it('answers a question with cited Academy articles', async () => {
    const result = await handler(event({
      question: 'How do I invoice a load?',
      articles: [{ slug: 'release-to-accounting', title: 'Release to Accounting', content: '# Release\nDelivered loads need documents.' }],
    }))
    expect(result).toEqual({ answer: 'Use the release gate.', citations: ['release-to-accounting'] })
  })

  it('rejects a missing question', async () => {
    await expect(handler(event({ articles: [] }))).rejects.toThrow('question must be a string')
  })

  it('rejects empty articles', async () => {
    await expect(handler(event({ question: 'What?' }))).rejects.toThrow('At least one Academy article is required')
  })
})
