/**
 * tms-carrier-actions handler tests.
 *
 * The DynamoDB mock is a small in-memory engine, not a list of scripted replies.
 * This handler's bugs live in the *shape* of the writes it emits — an UpdateExpression
 * that SETs a GSI key to NULL is accepted by every "assert a Put was sent" mock and
 * refused by the real table — so the engine interprets UpdateExpression (both SET and
 * REMOVE) against the stored item and refuses a NULL in an index key exactly the way
 * DynamoDB refuses it:
 *
 *   One or more parameter values were invalid: Type mismatch for Index Key dotNumber
 *   Expected: S Actual: NULL IndexName: carriersByDotNumber
 *
 * That ValidationException is what dev verification hit when a carrier was edited
 * without re-supplying its DOT number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

type Row = Record<string, unknown>

// ── Cognito mock ─────────────────────────────────────────────────────────────
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
const TABLES = {
  carrier: 'Carrier-test',
  contact: 'CarrierContact-test',
  payment: 'CarrierPaymentMethod-test',
  document: 'CarrierDocument-test',
  loadCarrier: 'LoadCarrier-test',
  settings: 'TmsSettings-test',
  audit: 'AuditLog-test',
}

const store = vi.hoisted(() => {
  process.env.TABLE_NAME = 'Carrier-test'
  process.env.CARRIER_TABLE_NAME = 'Carrier-test'
  process.env.CARRIER_CONTACT_TABLE_NAME = 'CarrierContact-test'
  process.env.CARRIER_PAYMENT_METHOD_TABLE_NAME = 'CarrierPaymentMethod-test'
  process.env.CARRIER_DOCUMENT_TABLE_NAME = 'CarrierDocument-test'
  process.env.LOAD_CARRIER_TABLE_NAME = 'LoadCarrier-test'
  process.env.SETTINGS_TABLE_NAME = 'TmsSettings-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  process.env.BUCKET_NAME = 'bcat-test-bucket'
  return new Map<string, Map<string, Record<string, unknown>>>()
})

function table(name: string): Map<string, Row> {
  let t = store.get(name)
  if (!t) {
    t = new Map<string, Row>()
    store.set(name, t)
  }
  return t
}

/**
 * The deployed secondary indexes, by table. Two things follow from a real index and
 * both matter here: DynamoDB refuses a wrongly typed key attribute outright, and a row
 * missing a key attribute is simply absent from the index (sparse).
 */
const INDEXES: Record<string, Record<string, readonly string[]>> = {
  [TABLES.carrier]: {
    carriersByNormalizedName: ['normalizedName'],
    carriersByStatusAndName: ['status', 'name'],
    carriersByMcNumber: ['mcNumber'],
    carriersByDotNumber: ['dotNumber'],
  },
  [TABLES.contact]: { carrierContactsByCarrierId: ['carrierId'] },
  [TABLES.payment]: { carrierPaymentMethodsByCarrierId: ['carrierId'] },
  [TABLES.document]: { carrierDocumentsByCarrierIdAndType: ['carrierId', 'type'] },
  [TABLES.loadCarrier]: { loadCarriersByCarrierId: ['carrierId'] },
}

/** The rows a generated list query sees through `indexName` — the sparse ones are not there. */
function indexRows(tableName: string, indexName: string): Row[] {
  const keys = INDEXES[tableName]?.[indexName]
  if (!keys) throw new Error(`no index ${indexName} on ${tableName}`)
  return [...table(tableName).values()].filter((row) => keys.every((key) => row[key] != null))
}

class ValidationException extends Error {
  name = 'ValidationException'
}

class ConditionalCheckFailed extends Error {
  constructor(message: string) {
    super(`ConditionalCheckFailedException: ${message}`)
  }
}

class TransactionCanceled extends Error {
  constructor(message: string) {
    super(`TransactionCanceledException: ${message}`)
  }
}

/**
 * DynamoDB types index keys. A NULL written into one fails the whole request — the row
 * is not written and no index is updated.
 */
function assertIndexKeyType(tableName: string, attribute: string, raw: unknown): void {
  const indexName = Object.entries(INDEXES[tableName] ?? {}).find(([, keys]) => keys.includes(attribute))?.[0]
  if (!indexName) return
  if (raw && typeof raw === 'object' && 'NULL' in raw) {
    throw new ValidationException(
      `One or more parameter values were invalid: Type mismatch for Index Key ${attribute} ` +
        `Expected: S Actual: NULL IndexName: ${indexName}`,
    )
  }
}

interface UpdateSpec {
  TableName: string
  Key: Record<string, unknown>
  UpdateExpression: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, unknown>
  ConditionExpression?: string
}

/** Apply the `SET #a = :a, … REMOVE #b, #c` shape this handler emits. */
function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const key = unmarshall(spec.Key as never) as { id: string }
  const existing = t.get(key.id) ?? null
  const raw = (spec.ExpressionAttributeValues ?? {}) as Record<string, unknown>
  const values = spec.ExpressionAttributeValues
    ? (unmarshall(spec.ExpressionAttributeValues as never) as Row)
    : {}
  const names = spec.ExpressionAttributeNames ?? {}
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] ?? token : token)

  if (spec.ConditionExpression?.includes('casExpectedUpdatedAt')) {
    const expected = String(values[':casExpectedUpdatedAt'] ?? '')
    const actual = String(existing?.updatedAt ?? '')
    if (expected !== actual) throw new ConditionalCheckFailed(`CAS on ${spec.TableName}/${key.id}`)
  }

  const expression = spec.UpdateExpression ?? ''
  const removeAt = expression.search(/\bREMOVE\b/)
  const setAt = expression.search(/\bSET\b/)
  const setClause = setAt < 0 ? '' : expression.slice(setAt + 3, removeAt < 0 ? undefined : removeAt)
  const removeClause = removeAt < 0 ? '' : expression.slice(removeAt + 6)

  const next: Row = { ...(existing ?? { id: key.id }) }
  for (const assignment of setClause.split(',')) {
    const m = /^\s*([#\w]+)\s*=\s*(:\w+)\s*$/.exec(assignment)
    if (!m) continue
    const field = resolve(m[1])
    assertIndexKeyType(spec.TableName, field, raw[m[2]])
    next[field] = values[m[2]]
  }
  for (const token of removeClause.split(',')) {
    const trimmed = token.trim()
    if (!trimmed) continue
    delete next[resolve(trimmed)]
  }

  t.set(key.id, next)
  return next
}

function applyPut(tableName: string, item: Record<string, unknown>, condition?: string): Row {
  for (const [attribute, raw] of Object.entries(item)) {
    assertIndexKeyType(tableName, attribute, raw)
  }
  const row = unmarshall(item as never) as Row
  const t = table(tableName)
  if (condition === 'attribute_not_exists(id)' && t.has(String(row.id))) {
    throw new ConditionalCheckFailed(`${tableName}/${String(row.id)} already exists`)
  }
  t.set(String(row.id), row)
  return row
}

const send = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send = send
  }
  const make = (type: string) =>
    class {
      input: Record<string, unknown>
      __type = type
      constructor(input: Record<string, unknown>) {
        this.input = input
      }
    }
  return {
    DynamoDBClient,
    GetItemCommand: make('Get'),
    PutItemCommand: make('Put'),
    UpdateItemCommand: make('Update'),
    DeleteItemCommand: make('Delete'),
    QueryCommand: make('Query'),
    TransactWriteItemsCommand: make('Transact'),
  }
})

// ── S3 mocks ─────────────────────────────────────────────────────────────────
const s3Send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = s3Send
  }
  const make = (type: string) =>
    class {
      input: unknown
      __type = type
      constructor(input: unknown) {
        this.input = input
      }
    }
  return { S3Client, HeadObjectCommand: make('Head'), PutObjectCommand: make('PutObject') }
})

const getSignedUrl = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }))

import { handler } from './handler'

// ── Engine wiring ────────────────────────────────────────────────────────────

interface MockCommand {
  __type: string
  input: Record<string, unknown>
}

const sent: MockCommand[] = []

function runCommand(cmd: MockCommand): unknown {
  const input = cmd.input
  switch (cmd.__type) {
    case 'Get': {
      const key = unmarshall(input.Key as never) as { id: string }
      const item = table(String(input.TableName)).get(key.id)
      return { Item: item ? marshall(item, { removeUndefinedValues: true }) : undefined }
    }
    case 'Query': {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = unmarshall(input.ExpressionAttributeValues as never) as Row
      const token = String(input.KeyConditionExpression).split(' ')[0]
      const field = names[token] ?? token
      const items = indexRows(String(input.TableName), String(input.IndexName)).filter(
        (i) => i[field] === values[':v'],
      )
      return { Items: items.map((i) => marshall(i, { removeUndefinedValues: true })) }
    }
    case 'Put':
      applyPut(
        String(input.TableName),
        input.Item as Record<string, unknown>,
        input.ConditionExpression as string | undefined,
      )
      return {}
    case 'Update':
      return {
        Attributes: marshall(applyUpdate(input as unknown as UpdateSpec), { removeUndefinedValues: true }),
      }
    case 'Delete': {
      const key = unmarshall(input.Key as never) as { id: string }
      table(String(input.TableName)).delete(key.id)
      return {}
    }
    case 'Transact': {
      const items = input.TransactItems as Record<string, Record<string, unknown>>[]
      const snapshot = new Map<string, Map<string, Row>>()
      for (const [name, t] of store) snapshot.set(name, new Map(t))
      try {
        for (const entry of items) {
          if (entry.Put) {
            const put = entry.Put as { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string }
            applyPut(put.TableName, put.Item, put.ConditionExpression)
          } else if (entry.Update) {
            applyUpdate(entry.Update as unknown as UpdateSpec)
          } else if (entry.Delete) {
            const del = entry.Delete as { TableName: string; Key: Record<string, unknown> }
            table(del.TableName).delete(String((unmarshall(del.Key as never) as { id: string }).id))
          }
        }
      } catch (err) {
        store.clear()
        for (const [name, t] of snapshot) store.set(name, t)
        // A ValidationException is not a cancellation: DynamoDB rejects the request
        // before it ever runs, and the handler must not report it as a write conflict.
        if (err instanceof ValidationException) throw err
        throw new TransactionCanceled(err instanceof Error ? err.message : String(err))
      }
      return {}
    }
    default:
      throw new Error(`Unhandled command: ${cmd.__type}`)
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CARRIER_USER = {
  sub: 'sub-carrier',
  username: 'carrier',
  claims: { email: 'carrieradmin@bcatcorp.com', 'cognito:groups': ['page-carriers'] },
}
const ADMIN = {
  sub: 'sub-admin',
  username: 'admin',
  claims: { email: 'admin@bcatcorp.com', 'cognito:groups': ['ADMIN'] },
}
const OUTSIDER = {
  sub: 'sub-out',
  username: 'out',
  claims: { email: 'driveradmin@bcatcorp.com', 'cognito:groups': ['page-drivers'] },
}

function call(action: string, input: Row, identity: unknown = CARRIER_USER): Promise<Row> {
  return handler({ arguments: { action, input: JSON.stringify(input) }, identity } as never)
}

function carrier(overrides: Row = {}): Row {
  const row: Row = {
    id: 'car-1',
    __typename: 'Carrier',
    name: 'SWIFT TRANSPORTATION',
    normalizedName: 'swift transportation',
    type: 'TL',
    status: 'ACTIVE',
    mcNumber: '123456',
    dotNumber: '987654',
    loadCount: 0,
    version: 1,
    createdBy: 'carrieradmin@bcatcorp.com',
    updatedBy: 'carrieradmin@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
  table(TABLES.carrier).set(String(row.id), row)
  return row
}

function storedCarrier(id = 'car-1'): Row {
  const row = table(TABLES.carrier).get(id)
  if (!row) throw new Error(`no carrier ${id} in the store`)
  return row
}

function updates(): UpdateSpec[] {
  return sent.filter((c) => c.__type === 'Update').map((c) => c.input as unknown as UpdateSpec)
}

beforeEach(() => {
  store.clear()
  sent.length = 0
  send.mockReset()
  cognitoSend.mockReset()
  s3Send.mockReset()
  getSignedUrl.mockReset()

  send.mockImplementation(async (cmd: MockCommand) => {
    sent.push(cmd)
    return runCommand(cmd)
  })
  s3Send.mockResolvedValue({ ContentLength: 1024, ContentType: 'application/pdf' })
  getSignedUrl.mockResolvedValue('https://signed.example/upload')
})

// ── The regression: a NULL in a GSI key ──────────────────────────────────────

describe('UPSERT_CARRIER clears index keys by removing them', () => {
  it('the mock refuses a NULL index key the way the table does', async () => {
    // Guards every test below: if the engine tolerated a NULL in dotNumber, the
    // regression tests would pass against the broken handler too.
    await expect(
      send({
        __type: 'Put',
        input: { TableName: TABLES.carrier, Item: marshall({ id: 'x', name: 'n', normalizedName: 'n', status: 'ACTIVE', dotNumber: null }) },
      }),
    ).rejects.toThrow('Type mismatch for Index Key dotNumber')
  })

  it('an edit that does not re-supply the DOT number removes it instead of NULLing the GSI key', async () => {
    carrier()

    const saved = await call('UPSERT_CARRIER', {
      id: 'car-1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      name: 'SWIFT TRANSPORTATION',
      type: 'TL',
      mcNumber: '123456',
      phone: '555-0100',
    })

    expect(saved.phone).toBe('555-0100')
    const stored = storedCarrier()
    expect('dotNumber' in stored).toBe(false)
    expect(stored.mcNumber).toBe('123456')

    const update = updates().find((u) => u.TableName === TABLES.carrier)!
    expect(update.UpdateExpression).toMatch(/REMOVE\b[^]*#dotNumber/)
    expect(update.UpdateExpression).not.toMatch(/#dotNumber = /)
    expect(update.ExpressionAttributeValues).not.toHaveProperty(':dotNumber')
  })

  it('clearing a DOT number explicitly removes the attribute and leaves the carrier readable', async () => {
    carrier({ dotNumber: '987654' })

    await call('UPSERT_CARRIER', {
      id: 'car-1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      name: 'SWIFT TRANSPORTATION',
      type: 'TL',
      dotNumber: null,
      mcNumber: '123456',
    })

    const cleared = storedCarrier()
    expect('dotNumber' in cleared).toBe(false)
    expect(cleared.name).toBe('SWIFT TRANSPORTATION')

    // The row is still a carrier a second edit can open and re-key.
    const reKeyed = await call('UPSERT_CARRIER', {
      id: 'car-1',
      expectedUpdatedAt: String(cleared.updatedAt),
      name: 'SWIFT TRANSPORTATION',
      type: 'TL',
      mcNumber: '123456',
      dotNumber: '111222',
    })
    expect(reKeyed.dotNumber).toBe('111222')
    expect(storedCarrier().dotNumber).toBe('111222')
  })

  it('every attribute an edit clears leaves the stored row, never a NULL index key', async () => {
    carrier({ mcNumber: '123456', dotNumber: '987654' })

    await call('UPSERT_CARRIER', {
      id: 'car-1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      name: 'SWIFT TRANSPORTATION',
      type: 'TL',
    })

    const stored = storedCarrier()
    expect('mcNumber' in stored).toBe(false)
    expect('dotNumber' in stored).toBe(false)
    expect(stored.normalizedName).toBe('swift transportation')
  })
})

// ── Creating a carrier ───────────────────────────────────────────────────────

describe('UPSERT_CARRIER create', () => {
  it('opens a carrier that has neither an MC nor a DOT number on file', async () => {
    // A broker types the name and the phone first; the numbers arrive with the packet.
    // Writing those two index keys as NULL fails the PutItem outright, so the carrier
    // could never be opened at all.
    const created = await call('UPSERT_CARRIER', { name: 'No Numbers Trucking', type: 'TL', phone: '555-0101' })

    const stored = storedCarrier(String(created.id))
    expect('mcNumber' in stored).toBe(false)
    expect('dotNumber' in stored).toBe(false)
    expect(stored.phone).toBe('555-0101')

    // The carriers page reads the status index; a row left out of it is invisible.
    expect(indexRows(TABLES.carrier, 'carriersByStatusAndName').map((r) => r.id)).toEqual([created.id])
    expect(indexRows(TABLES.carrier, 'carriersByNormalizedName').map((r) => r.id)).toEqual([created.id])
    expect(indexRows(TABLES.carrier, 'carriersByMcNumber')).toEqual([])
    expect(indexRows(TABLES.carrier, 'carriersByDotNumber')).toEqual([])
  })

  it('lands PENDING even when the caller asks for ACTIVE', async () => {
    const created = await call('UPSERT_CARRIER', {
      name: 'Knight Swift Logistics',
      type: 'TL',
      mcNumber: '222333',
      dotNumber: '444555',
      status: 'ACTIVE',
    })
    expect(created.status).toBe('PENDING')
    expect(storedCarrier(String(created.id)).status).toBe('PENDING')
  })

  it('lets an admin open a carrier straight to ACTIVE', async () => {
    const created = await call(
      'UPSERT_CARRIER',
      { name: 'Knight Swift Logistics', type: 'TL', mcNumber: '222333', dotNumber: '444555', status: 'ACTIVE' },
      ADMIN,
    )
    expect(created.status).toBe('ACTIVE')
  })

  it('keeps the approval queue when the setting was never saved', async () => {
    expect(table(TABLES.settings).size).toBe(0)
    const created = await call('UPSERT_CARRIER', {
      name: 'Unvetted Freight',
      type: 'TL',
      mcNumber: '222333',
      dotNumber: '444555',
      status: 'ACTIVE',
    })
    expect(created.status).toBe('PENDING')
  })

  it('lets a page-carriers user open an ACTIVE carrier once approval is switched off', async () => {
    table(TABLES.settings).set('default', {
      id: 'default',
      requireCarrierApproval: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const created = await call('UPSERT_CARRIER', {
      name: 'Knight Swift Logistics',
      type: 'TL',
      mcNumber: '222333',
      dotNumber: '444555',
      status: 'ACTIVE',
    })
    expect(created.status).toBe('ACTIVE')
  })
})

// ── Duplicates ───────────────────────────────────────────────────────────────

describe('UPSERT_CARRIER duplicate refusal', () => {
  beforeEach(() => {
    carrier({ id: 'car-1', name: 'SWIFT TRANSPORTATION LLC', normalizedName: 'swift transportation' })
  })

  it('refuses a second row for the same normalized name and names the carrier on file', async () => {
    await expect(
      call('UPSERT_CARRIER', { name: 'Swift Transportation, Inc.', type: 'TL', mcNumber: '999999' }),
    ).rejects.toThrow('Duplicate carrier name: SWIFT TRANSPORTATION LLC (id car-1)')
  })

  it('refuses a duplicate MC number', async () => {
    await expect(
      call('UPSERT_CARRIER', { name: 'Totally Different Trucking', type: 'TL', mcNumber: '123456' }),
    ).rejects.toThrow('Duplicate carrier MC number: SWIFT TRANSPORTATION LLC (id car-1)')
  })

  it('refuses a duplicate DOT number', async () => {
    await expect(
      call('UPSERT_CARRIER', { name: 'Totally Different Trucking', type: 'TL', dotNumber: '987654' }),
    ).rejects.toThrow('Duplicate carrier DOT number: SWIFT TRANSPORTATION LLC (id car-1)')
  })

  it('does not collide a carrier with itself on edit', async () => {
    const saved = await call('UPSERT_CARRIER', {
      id: 'car-1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      name: 'SWIFT TRANSPORTATION LLC',
      type: 'TL',
      mcNumber: '123456',
      dotNumber: '987654',
      phone: '555-0199',
    })
    expect(saved.phone).toBe('555-0199')
  })
})

// ── Status transitions ───────────────────────────────────────────────────────

describe('SET_CARRIER_STATUS', () => {
  it('demands a reason when a carrier is switched off', async () => {
    carrier()
    await expect(
      call('SET_CARRIER_STATUS', { id: 'car-1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', status: 'INACTIVE' }),
    ).rejects.toThrow('reason is required when a carrier moves to INACTIVE')

    await expect(
      call('SET_CARRIER_STATUS', { id: 'car-1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', status: 'DO_NOT_USE' }),
    ).rejects.toThrow('reason is required when a carrier moves to DO_NOT_USE')
  })

  it('refuses an INACTIVE reason on a DO_NOT_USE move', async () => {
    carrier()
    await expect(
      call('SET_CARRIER_STATUS', {
        id: 'car-1',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        status: 'DO_NOT_USE',
        reason: 'OTHER',
      }),
    ).rejects.toThrow(/reason must be one of DOUBLE_BROKERING/)

    const accepted = await call('SET_CARRIER_STATUS', {
      id: 'car-1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      status: 'DO_NOT_USE',
      reason: 'DOUBLE_BROKERING',
    })
    expect(accepted.status).toBe('DO_NOT_USE')
    expect(accepted.statusReason).toBe('DOUBLE_BROKERING')
  })

  it('keeps the way back out of DO_NOT_USE with admins only', async () => {
    carrier({ status: 'DO_NOT_USE' })
    await expect(
      call('SET_CARRIER_STATUS', {
        id: 'car-1',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        status: 'INACTIVE',
        reason: 'SAFETY_ISSUES',
      }),
    ).rejects.toThrow('Cannot move a carrier from DO_NOT_USE to INACTIVE')

    const reopened = await call(
      'SET_CARRIER_STATUS',
      { id: 'car-1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', status: 'INACTIVE', reason: 'SAFETY_ISSUES' },
      ADMIN,
    )
    expect(reopened.status).toBe('INACTIVE')
  })

  it('never reopens DO_NOT_USE straight to ACTIVE, even for an admin', async () => {
    carrier({ status: 'DO_NOT_USE' })
    await expect(
      call('SET_CARRIER_STATUS', { id: 'car-1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', status: 'ACTIVE' }, ADMIN),
    ).rejects.toThrow('Cannot move a carrier from DO_NOT_USE to ACTIVE')
  })

  it('flags the open loads of a carrier that goes INACTIVE without bouncing them', async () => {
    carrier()
    table(TABLES.loadCarrier).set('lc-open', {
      id: 'lc-open', carrierId: 'car-1', status: 'ACTIVE', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    table(TABLES.loadCarrier).set('lc-rolling', {
      id: 'lc-rolling', carrierId: 'car-1', status: 'ACTIVE', dispatchedAt: '2026-01-02T00:00:00.000Z',
      bookingWarnings: ['LATE_PICKUP'], updatedAt: '2026-01-01T00:00:00.000Z',
    })
    table(TABLES.loadCarrier).set('lc-gone', {
      id: 'lc-gone', carrierId: 'car-1', status: 'REMOVED', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    table(TABLES.loadCarrier).set('lc-other', {
      id: 'lc-other', carrierId: 'car-2', status: 'ACTIVE', updatedAt: '2026-01-01T00:00:00.000Z',
    })

    await call('SET_CARRIER_STATUS', {
      id: 'car-1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      status: 'INACTIVE',
      reason: 'EXPIRED_INSURANCE',
    })

    const open = table(TABLES.loadCarrier).get('lc-open')!
    expect(open.bookingWarnings).toEqual(['CARRIER_STATUS_CHANGED:INACTIVE'])
    // Flagged, not bounced: taking the load off the carrier is a phone call.
    expect(open.status).toBe('ACTIVE')

    expect(table(TABLES.loadCarrier).get('lc-rolling')!.bookingWarnings).toEqual(['LATE_PICKUP'])
    expect(table(TABLES.loadCarrier).get('lc-gone')!.bookingWarnings).toBeUndefined()
    expect(table(TABLES.loadCarrier).get('lc-other')!.bookingWarnings).toBeUndefined()
  })
})

// ── Compare-and-swap ─────────────────────────────────────────────────────────

describe('compare-and-swap', () => {
  it('refuses an edit built on a stale read', async () => {
    carrier({ updatedAt: '2026-02-01T00:00:00.000Z' })
    await expect(
      call('UPSERT_CARRIER', {
        id: 'car-1',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        name: 'SWIFT TRANSPORTATION',
        type: 'TL',
      }),
    ).rejects.toThrow('This carrier was changed by someone else — reload and try again.')
    expect(storedCarrier().updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })
})

// ── Payment methods ──────────────────────────────────────────────────────────

describe('UPSERT_PAYMENT_METHOD', () => {
  beforeEach(() => {
    carrier()
  })

  it('refuses a factor payee with no factor named', async () => {
    await expect(
      call('UPSERT_PAYMENT_METHOD', { carrierId: 'car-1', method: 'ACH', recipientType: 'FACTOR' }),
    ).rejects.toThrow('factorName is required when the payee is a factor')
  })

  it('refuses a full account or routing number outright', async () => {
    await expect(
      call('UPSERT_PAYMENT_METHOD', {
        carrierId: 'car-1', method: 'ACH', recipientType: 'CARRIER', accountNumber: '12345678901',
      }),
    ).rejects.toThrow('accountNumber is never stored')

    await expect(
      call('UPSERT_PAYMENT_METHOD', {
        carrierId: 'car-1', method: 'ACH', recipientType: 'CARRIER', routingNumber: '071000013',
      }),
    ).rejects.toThrow('routingNumber is never stored')

    await expect(
      call('UPSERT_PAYMENT_METHOD', {
        carrierId: 'car-1', method: 'ACH', recipientType: 'CARRIER', accountLast4: '12345678901',
      }),
    ).rejects.toThrow('accountLast4 must be at most the last 4 digits')

    expect(table(TABLES.payment).size).toBe(0)
  })

  it('leaves exactly one preferred payee behind', async () => {
    const first = await call('UPSERT_PAYMENT_METHOD', {
      carrierId: 'car-1', method: 'ACH', recipientType: 'CARRIER', accountLast4: '1234', isPreferred: true,
    })
    const second = await call('UPSERT_PAYMENT_METHOD', {
      carrierId: 'car-1', method: 'WIRE', recipientType: 'CARRIER', accountLast4: '5678', isPreferred: true,
    })

    const preferred = [...table(TABLES.payment).values()].filter((m) => m.isPreferred === true)
    expect(preferred.map((m) => m.id)).toEqual([String(second.id)])
    expect(table(TABLES.payment).get(String(first.id))!.isPreferred).toBe(false)
  })
})

// ── Authorization ────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('refuses a caller who is neither owner, admin, nor on the carriers page', async () => {
    await expect(
      call('UPSERT_CARRIER', { name: 'Anything', type: 'TL' }, OUTSIDER),
    ).rejects.toThrow('Forbidden: UPSERT_CARRIER requires owner, ADMIN, or page-carriers')
  })

  it('refuses a missing identity', async () => {
    await expect(
      handler({ arguments: { action: 'UPSERT_CARRIER', input: '{}' }, identity: null } as never),
    ).rejects.toThrow('Unauthorized: missing identity')
  })

  it('keeps the org booking rules with owner and ADMIN', async () => {
    await expect(call('SAVE_CARRIER_SETTINGS', { requireCarrierApproval: false })).rejects.toThrow(
      'Forbidden: SAVE_CARRIER_SETTINGS requires owner or ADMIN',
    )

    const saved = await call('SAVE_CARRIER_SETTINGS', { requireCarrierApproval: false }, ADMIN)
    expect(saved.requireCarrierApproval).toBe(false)

    const asOwner = await call(
      'SAVE_CARRIER_SETTINGS',
      { requireCarrierApproval: true, expectedUpdatedAt: String(table(TABLES.settings).get('default')!.updatedAt) },
      { sub: 'sub-owner', username: 'owner', claims: { email: 'ryne@bcatcorp.com' } },
    )
    expect(asOwner.requireCarrierApproval).toBe(true)
  })

  it('lets the uploader take back their own document and nobody else', async () => {
    carrier()
    table(TABLES.document).set('doc-1', {
      id: 'doc-1', carrierId: 'car-1', type: 'W9', name: 'w9.pdf',
      s3Key: 'carrier-docs/car-1/w9.pdf', uploadedBy: 'carrieradmin@bcatcorp.com',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const someoneElse = {
      sub: 'sub-two', username: 'two',
      claims: { email: 'other@bcatcorp.com', 'cognito:groups': ['page-carriers'] },
    }
    await expect(call('DELETE_DOCUMENT', { id: 'doc-1' }, someoneElse)).rejects.toThrow(
      'Forbidden: DELETE_DOCUMENT requires owner, ADMIN, or the person who uploaded the document',
    )
    expect(table(TABLES.document).has('doc-1')).toBe(true)

    await call('DELETE_DOCUMENT', { id: 'doc-1' })
    expect(table(TABLES.document).has('doc-1')).toBe(false)
  })
})

// ── Documents ────────────────────────────────────────────────────────────────

describe('COMMIT_DOCUMENT', () => {
  const COMMIT = {
    carrierId: 'car-1',
    type: 'W9',
    name: 'w9.pdf',
    s3Key: 'carrier-docs/car-1/abc-w9.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
  }

  beforeEach(() => {
    carrier()
  })

  it('refuses a file whose size does not match what was signed for', async () => {
    s3Send.mockResolvedValue({ ContentLength: 2048, ContentType: 'application/pdf' })
    await expect(call('COMMIT_DOCUMENT', COMMIT)).rejects.toThrow(
      'Document size mismatch: expected 1024 bytes, found 2048',
    )
    expect(table(TABLES.document).size).toBe(0)
  })

  it('refuses a file whose content type does not match what was signed for', async () => {
    s3Send.mockResolvedValue({ ContentLength: 1024, ContentType: 'image/png' })
    await expect(call('COMMIT_DOCUMENT', COMMIT)).rejects.toThrow(
      'Document content type mismatch: expected application/pdf, found image/png',
    )
    expect(table(TABLES.document).size).toBe(0)
  })

  it('tells the caller to retry when the upload has not landed yet', async () => {
    const missing = Object.assign(new Error('Not Found'), { name: 'NotFound' })
    s3Send.mockRejectedValue(missing)
    await expect(call('COMMIT_DOCUMENT', COMMIT)).rejects.toThrow(
      'The upload has not landed in S3 yet — wait a moment and commit the document again.',
    )
    expect(table(TABLES.document).size).toBe(0)
  })

  it('refuses a key belonging to another carrier', async () => {
    await expect(
      call('COMMIT_DOCUMENT', { ...COMMIT, s3Key: 'carrier-docs/car-9/abc-w9.pdf' }),
    ).rejects.toThrow('s3Key does not belong to this carrier')
  })

  it('is idempotent: a retried commit of the same key does not list the file twice', async () => {
    const first = await call('COMMIT_DOCUMENT', COMMIT)
    const second = await call('COMMIT_DOCUMENT', COMMIT)
    expect(second.id).toBe(first.id)
    expect(table(TABLES.document).size).toBe(1)
  })
})
