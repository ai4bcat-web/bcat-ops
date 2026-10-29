/**
 * tms-tracking-actions handler tests.
 *
 * The DynamoDB mock is a small in-memory engine rather than a list of scripted
 * replies: every action here is a transaction that has to leave several tables
 * agreeing — a minted TrackingLink, the LoadCarrier that points at it, the previous
 * link revoked — and a test that only asserts "a Put was sent" cannot tell a correct
 * transaction from a wrong one. The engine interprets the conditions the handler
 * writes (`attribute_not_exists(id)`, the `updatedAt` CAS, the `version` CAS) and
 * rolls a transaction back the way DynamoDB cancels one.
 *
 * Twilio and SES are the dev reality: `loadDispatchConfig` returns null unless a test
 * says otherwise, and SES is left to reject. Both paths must still hand back a URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  link: 'TrackingLink-test',
  checkCall: 'LoadCheckCall-test',
  shipment: 'Shipment-test',
  order: 'Order-test',
  load: 'Load-test',
  loadCarrier: 'LoadCarrier-test',
  settings: 'TmsSettings-test',
  audit: 'AuditLog-test',
  division: 'Division-test',
  conversation: 'DispatchConversation-test',
  message: 'DispatchMessage-test',
  document: 'ShipmentDocument-test',
  notice: 'ShipmentNotice-test',
  customer: 'Customer-test',
}

const store = vi.hoisted(() => {
  process.env.TRACKING_LINK_TABLE_NAME = 'TrackingLink-test'
  process.env.LOAD_CHECK_CALL_TABLE_NAME = 'LoadCheckCall-test'
  process.env.SHIPMENT_TABLE_NAME = 'Shipment-test'
  process.env.ORDER_TABLE_NAME = 'Order-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.LOAD_CARRIER_TABLE_NAME = 'LoadCarrier-test'
  process.env.TMS_SETTINGS_TABLE_NAME = 'TmsSettings-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  process.env.DIVISION_TABLE_NAME = 'Division-test'
  process.env.CONVERSATION_TABLE_NAME = 'DispatchConversation-test'
  process.env.MESSAGE_TABLE_NAME = 'DispatchMessage-test'
  process.env.SETTINGS_TABLE_NAME = 'DispatchSettings-test'
  process.env.DRIVER_TABLE_NAME = 'Driver-test'
  process.env.SHIPMENT_DOCUMENT_TABLE_NAME = 'ShipmentDocument-test'
  process.env.SHIPMENT_NOTICE_TABLE_NAME = 'ShipmentNotice-test'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.BUCKET_NAME = 'bcat-test-bucket'
  process.env.FROM_ADDRESS = 'ai4bcat@gmail.com'
  process.env.PORTAL_ORIGIN = 'https://portal.test'
  process.env.AMPLIFY_DATA_DEFAULT_NAME = 'amplifyData'
  return new Map<string, Map<string, Row>>()
})

function table(name: string): Map<string, Row> {
  let t = store.get(name)
  if (!t) {
    t = new Map<string, Row>()
    store.set(name, t)
  }
  return t
}

/** Division's primary key is `key`, not `id`; everything else here is keyed on `id`. */
function primaryKey(rawKey: Record<string, unknown>): string {
  const key = unmarshall(rawKey as never) as Row
  return String(key.id ?? Object.values(key)[0])
}

/** The deployed secondary indexes, by table. */
const INDEXES: Record<string, Record<string, readonly string[]>> = {
  [TABLES.link]: {
    trackingLinksByShipmentId: ['shipmentId'],
    trackingLinksByLoadId: ['loadId'],
  },
  [TABLES.order]: { ordersByShipmentId: ['shipmentId'] },
  [TABLES.load]: { loadsByShipmentId: ['shipmentId'] },
  [TABLES.loadCarrier]: { loadCarriersByShipmentId: ['shipmentId'] },
  [TABLES.checkCall]: { loadCheckCallsByLoadIdAndAt: ['loadId', 'at'] },
  [TABLES.conversation]: { dispatchConversationsByPhone: ['phone'] },
  [TABLES.message]: { dispatchMessagesByConversationIdAndAt: ['conversationId', 'at'] },
}

/** The rows a query sees through `indexName` — the sparse ones are not there. */
function indexRows(tableName: string, indexName: string): Row[] {
  const keys = INDEXES[tableName]?.[indexName]
  if (!keys) throw new Error(`no index ${indexName} on ${tableName}`)
  return [...table(tableName).values()].filter((row) => keys.every((key) => row[key] != null))
}

/**
 * The real class name matters: `claimNotice` in `_shared/shipmentNotices` decides
 * whether a deterministic id was already taken with `instanceof`, so the mocked SDK
 * has to hand back the same constructor the handler imports.
 */
const ConditionalCheckFailed = vi.hoisted(
  () =>
    class ConditionalCheckFailedException extends Error {
      constructor(message: string) {
        super(`ConditionalCheckFailedException: ${message}`)
      }
    },
)

class TransactionCanceled extends Error {
  constructor(message: string) {
    super(`TransactionCanceledException: ${message}`)
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

/** Apply the `SET #a = :a, … [ADD #c :delta]` shapes this handler and DispatchStore emit. */
function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const id = primaryKey(spec.Key)
  const existing = t.get(id) ?? null
  const values = spec.ExpressionAttributeValues
    ? (unmarshall(spec.ExpressionAttributeValues as never) as Row)
    : {}
  const names = spec.ExpressionAttributeNames ?? {}
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] ?? token : token)

  const condition = spec.ConditionExpression ?? ''
  if (condition.includes('casExpectedUpdatedAt')) {
    const expected = String(values[':casExpectedUpdatedAt'] ?? '')
    if (expected !== String(existing?.updatedAt ?? '')) {
      throw new ConditionalCheckFailed(`CAS on ${spec.TableName}/${id}`)
    }
  }
  if (condition.includes('casExpectedVersion')) {
    const expected = Number(values[':casExpectedVersion'] ?? 0)
    if (expected !== Number(existing?.version ?? 0)) {
      throw new ConditionalCheckFailed(`version CAS on ${spec.TableName}/${id}`)
    }
  }
  if (condition.includes('attribute_exists(id)') && !existing) {
    throw new ConditionalCheckFailed(`${spec.TableName}/${id} does not exist`)
  }

  const next: Row = { ...(existing ?? { id }) }
  const expression = spec.UpdateExpression ?? ''
  const addAt = expression.search(/\bADD\b/)
  const setAt = expression.search(/\bSET\b/)
  const setClause = setAt < 0 ? '' : expression.slice(setAt + 3, addAt < 0 ? undefined : addAt)
  for (const assignment of setClause.split(',')) {
    const m = /^\s*([#\w]+)\s*=\s*(:\w+)\s*$/.exec(assignment)
    if (!m) continue
    next[resolve(m[1])] = values[m[2]]
  }
  const addMatch = addAt < 0 ? null : /ADD\s+([#\w]+)\s+(:\w+)/.exec(expression)
  if (addMatch) {
    const field = resolve(addMatch[1])
    next[field] = Number(next[field] ?? 0) + Number(values[addMatch[2]] ?? 0)
  }

  t.set(id, next)
  return next
}

function applyPut(tableName: string, item: Record<string, unknown>, condition?: string): Row {
  const row = unmarshall(item as never) as Row
  const t = table(tableName)
  const id = String(row.id ?? row.key)
  if (condition === 'attribute_not_exists(id)' && t.has(id)) {
    throw new ConditionalCheckFailed(`${tableName}/${id} already exists`)
  }
  t.set(id, row)
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
    ConditionalCheckFailedException: ConditionalCheckFailed,
    GetItemCommand: make('Get'),
    BatchGetItemCommand: make('BatchGet'),
    PutItemCommand: make('Put'),
    UpdateItemCommand: make('Update'),
    DeleteItemCommand: make('Delete'),
    QueryCommand: make('Query'),
    TransactWriteItemsCommand: make('Transact'),
    ScanCommand: make('Scan'),
  }
})

// ── SES mock — denied on dev unless a test says otherwise ────────────────────
const sesSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-sesv2', () => {
  class SESv2Client {
    send = sesSend
  }
  class SendEmailCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { SESv2Client, SendEmailCommand }
})

// ── S3 mock — the bytes a document e-mail attaches, and the fallback download ─
const s3Send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = s3Send
  }
  class GetObjectCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { S3Client, GetObjectCommand }
})

const getSignedUrl = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }))

// ── Amplify data client mock — Load.trackingProvider ────────────────────────
const loadUpdate = vi.hoisted(() => vi.fn())
vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }))
vi.mock('aws-amplify/data', () => ({
  generateClient: vi.fn(() => ({ models: { Load: { update: loadUpdate } } })),
}))
vi.mock('@aws-amplify/backend-function/runtime', () => ({
  getAmplifyDataClientConfig: vi.fn(async () => ({
    resourceConfig: { API: { GraphQL: { endpoint: 'http://localhost', region: 'us-east-1', defaultAuthMode: 'iam', modelIntrospection: {} } } },
    libraryOptions: {},
  })),
}))

// ── Twilio mocks ─────────────────────────────────────────────────────────────
const dispatchConfig = vi.hoisted(() => vi.fn())
vi.mock('../_shared/dispatchConfig', () => ({ loadDispatchConfig: dispatchConfig }))

const twilioSend = vi.hoisted(() => vi.fn())
vi.mock('../_shared/twilio', () => {
  class TwilioError extends Error {
    constructor(message: string, readonly code?: number | string) {
      super(message)
      this.name = 'TwilioError'
    }
  }
  return { TwilioError, sendMessage: twilioSend }
})

import { handler } from './handler'

// ── Engine wiring ────────────────────────────────────────────────────────────

interface MockCommand {
  __type: string
  input: Record<string, unknown>
}

function runCommand(cmd: MockCommand): unknown {
  const input = cmd.input
  switch (cmd.__type) {
    case 'Get': {
      const item = table(String(input.TableName)).get(primaryKey(input.Key as Record<string, unknown>))
      return { Item: item ? marshall(item, { removeUndefinedValues: true }) : undefined }
    }
    case 'Query': {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = unmarshall(input.ExpressionAttributeValues as never) as Row
      const m = /^\s*([#\w]+)\s*=\s*(:\w+)/.exec(String(input.KeyConditionExpression))
      if (!m) throw new Error(`unsupported KeyConditionExpression: ${String(input.KeyConditionExpression)}`)
      const field = m[1].startsWith('#') ? names[m[1]] : m[1]
      const items = indexRows(String(input.TableName), String(input.IndexName)).filter(
        (i) => i[field] === values[m[2]],
      )
      return { Items: items.map((i) => marshall(i, { removeUndefinedValues: true })) }
    }
    case 'Scan': {
      const items = [...table(String(input.TableName)).values()]
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
    case 'Delete':
      table(String(input.TableName)).delete(primaryKey(input.Key as Record<string, unknown>))
      return {}
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
          }
        }
      } catch (err) {
        store.clear()
        for (const [name, t] of snapshot) store.set(name, t)
        throw new TransactionCanceled(err instanceof Error ? err.message : String(err))
      }
      return {}
    }
    default:
      throw new Error(`Unhandled command: ${cmd.__type}`)
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DISPATCHER = {
  sub: 'sub-ops',
  username: 'ops',
  claims: { email: 'ops@bcatcorp.com', 'cognito:groups': ['page-loads'] },
}
const ADMIN = {
  sub: 'sub-admin',
  username: 'admin',
  claims: { email: 'admin@bcatcorp.com', 'cognito:groups': ['ADMIN'] },
}

function call(action: string, input: Row, identity: unknown = DISPATCHER): Promise<Row> {
  return handler({ arguments: { action, input: JSON.stringify(input) }, identity } as never)
}

function seed(overrides: { load?: Row; loadCarrier?: Row; shipment?: Row; order?: Row } = {}) {
  const shipment: Row = {
    id: 'shp-1',
    __typename: 'Shipment',
    number: 'BC1001',
    status: 'IN_TRANSIT',
    customerId: 'cus-1',
    mode: 'FTL',
    source: 'MANUAL',
    version: 3,
    createdBy: 'ops@bcatcorp.com',
    updatedBy: 'ops@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides.shipment,
  }
  const order: Row = {
    id: 'ord-1',
    __typename: 'Order',
    shipmentId: 'shp-1',
    customerId: 'cus-1',
    customerRepId: 'rep-sub-1',
    mode: 'FTL',
    createdBy: 'ops@bcatcorp.com',
    updatedBy: 'ops@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides.order,
  }
  const load: Row = {
    id: 'lod-1',
    __typename: 'Load',
    shipmentId: 'shp-1',
    loadNumber: 'BC1001-1',
    status: 'IN_TRANSIT',
    divisionKey: 'BCAT_LOGISTICS',
    trackingProvider: 'MANUAL',
    stops: JSON.stringify([
      { id: 'stp-1', type: 'pickup', sequence: 1, appt: '2026-02-01T15:00:00.000Z' },
      { id: 'stp-2', type: 'delivery', sequence: 2, appt: '2026-02-03T15:00:00.000Z' },
    ]),
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides.load,
  }
  const loadCarrier: Row = {
    id: 'lc-1',
    __typename: 'LoadCarrier',
    loadId: 'lod-1',
    shipmentId: 'shp-1',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: 'car-1',
    carrierName: 'SWIFT TRANSPORTATION',
    driverName: 'Jose Ruiz',
    driverPhone: '(224) 555-0137',
    createdBy: 'ops@bcatcorp.com',
    updatedBy: 'ops@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides.loadCarrier,
  }
  table(TABLES.shipment).set(String(shipment.id), shipment)
  table(TABLES.order).set(String(order.id), order)
  table(TABLES.load).set(String(load.id), load)
  table(TABLES.loadCarrier).set(String(loadCarrier.id), loadCarrier)
  table(TABLES.division).set('BCAT_LOGISTICS', {
    key: 'BCAT_LOGISTICS', __typename: 'Division', name: 'BCAT Logistics', active: true,
  })
  return { shipment, order, load, loadCarrier }
}

function links(): Row[] {
  return [...table(TABLES.link).values()]
}

function notices(): Row[] {
  return [...table(TABLES.notice).values()]
}

/** A customer with one contact who asked to hear about deliveries. */
function seedCustomer(overrides: Row = {}): Row {
  const customer: Row = {
    id: 'cus-1',
    __typename: 'Customer',
    name: 'ACME FOODS',
    status: 'ACTIVE',
    contacts: [
      {
        id: 'ctc-1',
        name: 'Pat Lane',
        email: 'pat@acme.test',
        types: ['OPERATIONS'],
        notifications: ['DELIVERED'],
        active: true,
      },
    ],
    visibilityPrefs: { milestoneEmails: true },
    ...overrides,
  }
  table(TABLES.customer).set(String(customer.id), customer)
  return customer
}

function seedDocument(overrides: Row = {}): Row {
  const doc: Row = {
    id: 'sdoc-1',
    __typename: 'ShipmentDocument',
    shipmentId: 'shp-1',
    orderId: 'ord-1',
    type: 'POD',
    name: 'pod-BC1001.pdf',
    s3Key: 'shipment-docs/shp-1/sdoc-1-pod.pdf',
    contentType: 'application/pdf',
    sizeBytes: 120_000,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    version: 1,
    uploadedBy: 'ops@bcatcorp.com',
    uploadedAt: '2026-02-02T11:00:00.000Z',
    createdBy: 'ops@bcatcorp.com',
    ...overrides,
  }
  table(TABLES.document).set(String(doc.id), doc)
  return doc
}

// Link expiry is measured from the last delivery appointment, so the fixtures below
// only mean anything against a fixed clock. Only Date is faked: the handler awaits
// real promises throughout.
afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-02-02T12:00:00.000Z'), toFake: ['Date'] })
  store.clear()
  send.mockReset()
  cognitoSend.mockReset()
  sesSend.mockReset()
  loadUpdate.mockReset()
  dispatchConfig.mockReset()
  twilioSend.mockReset()
  s3Send.mockReset()
  getSignedUrl.mockReset()

  send.mockImplementation(async (cmd: MockCommand) => runCommand(cmd))
  cognitoSend.mockResolvedValue({
    UserAttributes: [
      { Name: 'name', Value: 'Dana Reed' },
      { Name: 'email', Value: 'dana@bcatcorp.com' },
      { Name: 'phone_number', Value: '+13125550188' },
    ],
  })
  loadUpdate.mockImplementation(async (input: Row) => {
    const existing = table(TABLES.load).get(String(input.id))
    if (!existing) return { data: null, errors: [{ message: 'not found' }] }
    const next = { ...existing, ...input }
    table(TABLES.load).set(String(input.id), next)
    return { data: next }
  })
  // Dev: Twilio is unconfigured and SES is denied.
  dispatchConfig.mockResolvedValue(null)
  sesSend.mockRejectedValue(new Error('AccessDeniedException: not authorized to perform ses:SendEmail'))
  s3Send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
  }))
  getSignedUrl.mockImplementation(async (_client: unknown, command: { input: { Key: string } }) =>
    `https://s3.test/${command.input.Key}?signed`)
})

// ── SEND_TRACKING_LINK ───────────────────────────────────────────────────────

describe('SEND_TRACKING_LINK', () => {
  it('refuses an own-asset leg and points at Motive instead', async () => {
    seed({ loadCarrier: { kind: 'OWN_ASSET', carrierId: null, carrierName: null } })

    await expect(call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })).rejects.toThrow(
      /Motive and the driver app/,
    )
    expect(links()).toHaveLength(0)
  })

  it('refuses a load that already delivered', async () => {
    seed({ load: { status: 'DELIVERED' } })

    await expect(call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })).rejects.toThrow(
      /nothing left to track/,
    )
    expect(links()).toHaveLength(0)
  })

  it('refuses a voided shipment — the leg is still ACTIVE but the freight is gone', async () => {
    seed({ shipment: { voidedAt: '2026-01-03T00:00:00.000Z', voidReason: 'Duplicate' } })

    await expect(call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })).rejects.toThrow(
      /Shipment BC1001 is voided/,
    )
    expect(links()).toHaveLength(0)
  })

  it('refuses an assignment the carrier already bounced off', async () => {
    seed({ loadCarrier: { status: 'BOUNCED' } })

    await expect(call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })).rejects.toThrow(
      /carrier currently on the load/,
    )
  })

  it('refuses to text an assignment with no driver number', async () => {
    seed({ loadCarrier: { driverPhone: null } })

    await expect(call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'SMS' })).rejects.toThrow(
      /No phone number to text/,
    )
  })

  it('revokes the previous ping link so only one is ever live', async () => {
    seed()
    const first = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })
    const firstToken = String((first.link as Row).id)

    const second = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })
    const secondToken = String((second.link as Row).id)

    expect(secondToken).not.toBe(firstToken)
    expect(table(TABLES.link).get(firstToken)).toMatchObject({ status: 'REVOKED', revokedBy: 'ops@bcatcorp.com' })
    expect(table(TABLES.link).get(secondToken)).toMatchObject({ status: 'ACTIVE' })
    expect(links().filter((l) => l.status === 'ACTIVE')).toHaveLength(1)
    // The assignment points at the live one, not the dead one.
    expect(table(TABLES.loadCarrier).get('lc-1')).toMatchObject({ trackingLinkId: secondToken })
  })

  it('hands back a usable url when Twilio was never connected', async () => {
    seed()

    const result = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'SMS' })

    expect(result.smsStatus).toBe('NOT_CONFIGURED')
    expect(result.messageId).toBeNull()
    const token = String((result.link as Row).id)
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(result.url).toBe(`https://portal.test/track/l/${token}`)
    // Nothing claims the driver got it.
    expect(table(TABLES.link).get(token)).toMatchObject({ status: 'ACTIVE', sentVia: 'SMS', sentAt: null })
    expect(table(TABLES.message).size).toBe(0)
  })

  it('writes the link, the assignment, the check call and the provider in one go', async () => {
    seed()

    const result = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })
    const token = String((result.link as Row).id)

    expect(table(TABLES.link).get(token)).toMatchObject({
      kind: 'CARRIER_PING',
      shipmentId: 'shp-1',
      loadId: 'lod-1',
      loadCarrierId: 'lc-1',
      status: 'ACTIVE',
      sentTo: '+12245550137',
      openCount: 0,
      pingCount: 0,
    })
    // 72 hours past the last delivery appointment, by default.
    expect((result.link as Row).expiresAt).toBe('2026-02-06T15:00:00.000Z')
    expect(table(TABLES.loadCarrier).get('lc-1')).toMatchObject({ trackingLinkId: token, trackingStartedAt: expect.any(String) })
    const events = [...table(TABLES.checkCall).values()]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'TRACKING_LINK_SENT', source: 'SYSTEM', loadId: 'lod-1',
      note: 'Tracking link created to copy',
    })
    expect(loadUpdate).toHaveBeenCalledWith({ id: 'lod-1', trackingProvider: 'LINK' })
    expect([...table(TABLES.audit).values()][0]).toMatchObject({ entityType: 'TRACKING_LINK', action: 'SEND_TRACKING_LINK' })
  })

  it('texts the link into a new conversation labelled carrier · driver', async () => {
    seed()
    dispatchConfig.mockResolvedValue({
      accountSid: 'AC', apiKeySid: 'SK', apiKeySecret: 's', authToken: null,
      messagingServiceSid: null, dispatchNumber: '+12242221305', webhookSecret: 'shh',
    })
    twilioSend.mockResolvedValue({ sid: 'SM123', status: 'queued' })

    const result = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'SMS' })
    const token = String((result.link as Row).id)

    expect(result.smsStatus).toBe('SENT')
    const body = String(twilioSend.mock.calls[0][1].body)
    expect(body).toContain(`https://portal.test/track/l/${token}`)
    expect(body).toContain('BCAT Logistics')
    const conversations = [...table(TABLES.conversation).values()]
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({ phone: '+12245550137', displayName: 'SWIFT TRANSPORTATION · Jose Ruiz' })
    // The sent stamps only land once Twilio accepted it.
    expect(table(TABLES.link).get(token)).toMatchObject({ sentAt: expect.any(String), smsMessageId: result.messageId })
  })

  it('reports a refused text instead of pretending the link went out', async () => {
    seed()
    dispatchConfig.mockResolvedValue({
      accountSid: 'AC', apiKeySid: 'SK', apiKeySecret: 's', authToken: null,
      messagingServiceSid: null, dispatchNumber: '+12242221305', webhookSecret: 'shh',
    })
    twilioSend.mockRejectedValue(new Error('21610 unsubscribed recipient'))

    const result = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'SMS' })
    const token = String((result.link as Row).id)

    expect(result.smsStatus).toBe('FAILED')
    expect(result.url).toBe(`https://portal.test/track/l/${token}`)
    expect(table(TABLES.link).get(token)).toMatchObject({ status: 'ACTIVE', sentAt: null })
    // And the check call carries the gateway's reason, not a claim of delivery.
    expect([...table(TABLES.checkCall).values()][0]).toMatchObject({
      note: expect.stringContaining('not texted: Twilio refused the text'),
    })
  })

  it('leaves a check call that says the text never went out when Twilio is unconfigured', async () => {
    seed()

    const result = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'SMS' })

    expect(result.smsStatus).toBe('NOT_CONFIGURED')
    const events = [...table(TABLES.checkCall).values()]
    expect(events).toHaveLength(1)
    // The timeline is read long after the dialog is closed; it must not claim a text
    // that Twilio never accepted.
    expect(String(events[0].note)).not.toMatch(/sent to|texted to/i)
    expect(events[0]).toMatchObject({
      note: 'Tracking link created for +12245550137 — not texted: dispatch texting is not connected',
    })
    expect(events[0]).not.toHaveProperty('driverMessageId')
  })

  it('rewrites the check call to say it was texted once Twilio accepts it', async () => {
    seed()
    dispatchConfig.mockResolvedValue({
      accountSid: 'AC', apiKeySid: 'SK', apiKeySecret: 's', authToken: null,
      messagingServiceSid: null, dispatchNumber: '+12242221305', webhookSecret: 'shh',
    })
    twilioSend.mockResolvedValue({ sid: 'SM123', status: 'queued' })

    const result = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'SMS' })

    expect(result.smsStatus).toBe('SENT')
    const events = [...table(TABLES.checkCall).values()]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      note: 'Tracking link texted to +12245550137',
      driverMessageId: result.messageId,
    })
  })
})

// ── REVOKE_TRACKING_LINK ─────────────────────────────────────────────────────

describe('REVOKE_TRACKING_LINK', () => {
  it('kills the link, stops the clock and falls tracking back to manual', async () => {
    seed()
    const sent = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })
    const token = String((sent.link as Row).id)
    loadUpdate.mockClear()

    await call('REVOKE_TRACKING_LINK', { trackingLinkId: token })

    expect(table(TABLES.link).get(token)).toMatchObject({ status: 'REVOKED' })
    expect(table(TABLES.loadCarrier).get('lc-1')).toMatchObject({ trackingLinkId: null, trackingStoppedAt: expect.any(String) })
    expect(loadUpdate).toHaveBeenCalledWith({ id: 'lod-1', trackingProvider: 'MANUAL' })
  })
})

// ── Step R: the one BROKERAGE grant ──────────────────────────────────────────

describe('page-tms authorization', () => {
  it('lets a page-tms caller work a load exactly as page-loads does', async () => {
    seed()
    const tmsUser = { sub: 'sub-tms', username: 'tms', claims: { email: 'broker@bcatcorp.com', 'cognito:groups': ['page-tms'] } }

    const sent = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' }, tmsUser)

    expect((sent.link as Row).id).toBeTruthy()
  })

  it('still refuses a caller holding neither grant', async () => {
    seed()
    const outsider = { sub: 'sub-out', username: 'out', claims: { email: 'driveradmin@bcatcorp.com', 'cognito:groups': ['page-drivers'] } }

    await expect(call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' }, outsider))
      .rejects.toThrow('Forbidden: SEND_TRACKING_LINK requires owner, ADMIN, page-loads, or page-tms')
  })
})

// ── SEND_CUSTOMER_LINK ───────────────────────────────────────────────────────

describe('SEND_CUSTOMER_LINK', () => {
  it('refuses a shipment nobody has submitted yet', async () => {
    seed({ shipment: { status: 'DRAFT' } })

    await expect(
      call('SEND_CUSTOMER_LINK', { shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: [] }),
    ).rejects.toThrow(/Submit the order/)
    expect(links()).toHaveLength(0)
  })

  it('refuses a voided shipment, and reads the pre-R soft delete as a void too', async () => {
    seed({ shipment: { voidedAt: '2026-01-03T00:00:00.000Z' } })

    await expect(
      call('SEND_CUSTOMER_LINK', { shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: [] }),
    ).rejects.toThrow(/Shipment BC1001 is voided/)
    expect(links()).toHaveLength(0)

    seed({ shipment: { voidedAt: null, deletedAt: '2026-01-03T00:00:00.000Z' } })

    await expect(
      call('SEND_CUSTOMER_LINK', { shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: [] }),
    ).rejects.toThrow(/Shipment BC1001 is voided/)
  })

  it('refuses a stale expectedVersion', async () => {
    seed()

    await expect(
      call('SEND_CUSTOMER_LINK', { shipmentId: 'shp-1', expectedVersion: 2, via: 'COPY', to: [] }),
    ).rejects.toThrow(/changed by someone else/)
  })

  it('re-sends the same token, and mints a new one only on regenerate', async () => {
    seed()

    const first = await call('SEND_CUSTOMER_LINK', {
      shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: ['ops@acme.test'],
    })
    const firstToken = String((first.link as Row).id)
    expect(table(TABLES.shipment).get('shp-1')).toMatchObject({ customerLinkId: firstToken, version: 4 })

    const again = await call('SEND_CUSTOMER_LINK', {
      shipmentId: 'shp-1', expectedVersion: 4, via: 'COPY', to: ['ops@acme.test', 'ap@acme.test'],
    })
    expect(String((again.link as Row).id)).toBe(firstToken)
    expect(again.url).toBe(`https://portal.test/track/s/${firstToken}`)
    expect(links()).toHaveLength(1)
    expect(table(TABLES.link).get(firstToken)).toMatchObject({ sentTo: 'ops@acme.test, ap@acme.test' })

    const regenerated = await call('SEND_CUSTOMER_LINK', {
      shipmentId: 'shp-1', expectedVersion: 5, via: 'COPY', to: ['ops@acme.test'], regenerate: true,
    })
    const newToken = String((regenerated.link as Row).id)
    expect(newToken).not.toBe(firstToken)
    expect(table(TABLES.link).get(firstToken)).toMatchObject({ status: 'REVOKED' })
    expect(table(TABLES.link).get(newToken)).toMatchObject({ status: 'ACTIVE' })
    expect(table(TABLES.shipment).get('shp-1')).toMatchObject({ customerLinkId: newToken, version: 6 })
  })

  it('snapshots the rep and the visibility flags onto the link', async () => {
    seed()
    table(TABLES.settings).set('default', {
      id: 'default', __typename: 'TmsSettings', customerLinkShowsCarrier: true, updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const result = await call('SEND_CUSTOMER_LINK', {
      shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: ['ops@acme.test'],
    })

    expect(result.link).toMatchObject({
      kind: 'CUSTOMER_VIEW',
      contactName: 'Dana Reed',
      contactEmail: 'dana@bcatcorp.com',
      contactPhone: '+13125550188',
      showCarrier: true,
      showPosition: true,
    })
    expect(cognitoSend).toHaveBeenCalled()
    // A customer link belongs to no load, so it stays out of trackingLinksByLoadId.
    expect(Object.keys(result.link as Row)).not.toContain('loadId')
  })

  it('returns the url with emailStatus NOT_SENT when SES refuses', async () => {
    seed()

    const result = await call('SEND_CUSTOMER_LINK', {
      shipmentId: 'shp-1', expectedVersion: 3, via: 'EMAIL', to: ['ops@acme.test'],
    })
    const token = String((result.link as Row).id)

    expect(result.emailStatus).toBe('NOT_SENT')
    expect(result.emailError).toMatch(/AccessDenied/)
    expect(result.url).toBe(`https://portal.test/track/s/${token}`)
    // Nothing was delivered, so nothing is stamped as sent.
    expect(table(TABLES.link).get(token)).toMatchObject({ sentAt: null })
    expect(table(TABLES.shipment).get('shp-1')?.customerLinkSentAt).toBeUndefined()
  })

  it('stamps the send when SES accepts it', async () => {
    seed()
    sesSend.mockResolvedValue({ MessageId: 'ses-1' })

    const result = await call('SEND_CUSTOMER_LINK', {
      shipmentId: 'shp-1', expectedVersion: 3, via: 'EMAIL', to: ['ops@acme.test'], cc: ['boss@acme.test'],
      message: 'Here is live tracking for your load.',
    })
    const token = String((result.link as Row).id)

    expect(result.emailStatus).toBe('SENT')
    const raw = new TextDecoder().decode(sesSend.mock.calls[0][0].input.Content.Raw.Data)
    expect(raw).toContain('To: ops@acme.test')
    expect(raw).toContain('Cc: boss@acme.test')
    expect(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).toContain(
      `https://portal.test/track/s/${token}`,
    )
    expect(table(TABLES.shipment).get('shp-1')).toMatchObject({ customerLinkSentAt: expect.any(String) })
  })

  it('refuses an email send with no recipient', async () => {
    seed()

    await expect(
      call('SEND_CUSTOMER_LINK', { shipmentId: 'shp-1', expectedVersion: 3, via: 'EMAIL', to: [] }),
    ).rejects.toThrow(/at least one recipient/)
  })
})

// ── REVOKE_CUSTOMER_LINK ─────────────────────────────────────────────────────

describe('REVOKE_CUSTOMER_LINK', () => {
  it('revokes the link and clears the shipment pointer', async () => {
    seed()
    const sent = await call('SEND_CUSTOMER_LINK', {
      shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: ['ops@acme.test'],
    })
    const token = String((sent.link as Row).id)

    await call('REVOKE_CUSTOMER_LINK', { trackingLinkId: token })

    expect(table(TABLES.link).get(token)).toMatchObject({ status: 'REVOKED' })
    expect(table(TABLES.shipment).get('shp-1')).toMatchObject({ customerLinkId: null })
  })

  it('refuses to revoke a carrier link through the customer action', async () => {
    seed()
    const sent = await call('SEND_TRACKING_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })

    await expect(
      call('REVOKE_CUSTOMER_LINK', { trackingLinkId: String((sent.link as Row).id) }),
    ).rejects.toThrow(/carrier link/)
  })
})

// ── TEXT_DRIVER ──────────────────────────────────────────────────────────────

describe('TEXT_DRIVER', () => {
  it('reports NOT_CONFIGURED rather than throwing at a caller that already logged a check call', async () => {
    seed()

    const result = await call('TEXT_DRIVER', { loadCarrierId: 'lc-1', body: 'Where are you?' })

    expect(result).toMatchObject({ smsStatus: 'NOT_CONFIGURED', messageId: null })
  })

  it('reports a missing driver number rather than throwing', async () => {
    seed({ loadCarrier: { driverPhone: null } })

    const result = await call('TEXT_DRIVER', { loadCarrierId: 'lc-1', body: 'Where are you?' })

    expect(result).toMatchObject({ smsStatus: 'FAILED', smsError: expect.stringContaining('No driver phone') })
  })

  it('refuses to text the driver on a voided shipment', async () => {
    seed({ shipment: { voidedAt: '2026-01-03T00:00:00.000Z' } })

    await expect(call('TEXT_DRIVER', { loadCarrierId: 'lc-1', body: 'Where are you?' })).rejects.toThrow(
      /Shipment BC1001 is voided/,
    )
  })

  it('returns the DispatchMessage id when the text goes out', async () => {
    seed()
    dispatchConfig.mockResolvedValue({
      accountSid: 'AC', apiKeySid: 'SK', apiKeySecret: 's', authToken: null,
      messagingServiceSid: null, dispatchNumber: '+12242221305', webhookSecret: 'shh',
    })
    twilioSend.mockResolvedValue({ sid: 'SM999', status: 'queued' })

    const result = await call('TEXT_DRIVER', { loadCarrierId: 'lc-1', body: 'Call dispatch when you load.' })

    expect(result.smsStatus).toBe('SENT')
    expect(table(TABLES.message).get(String(result.messageId))).toMatchObject({ twilioSid: 'SM999', direction: 'OUT' })
  })
})

// ── SAVE_TRACKING_SETTINGS ───────────────────────────────────────────────────

describe('SAVE_TRACKING_SETTINGS', () => {
  it('refuses a dispatcher who is not an admin', async () => {
    await expect(
      call('SAVE_TRACKING_SETTINGS', { id: 'default', checkCallDefaultIntervalHours: 6 }),
    ).rejects.toThrow(/requires owner or ADMIN/)
    expect(table(TABLES.settings).size).toBe(0)
  })

  it('refuses an interval outside one to forty-eight hours', async () => {
    await expect(
      call('SAVE_TRACKING_SETTINGS', { id: 'default', checkCallDefaultIntervalHours: 72 }, ADMIN),
    ).rejects.toThrow(/between 1 and 48/)
    await expect(
      call('SAVE_TRACKING_SETTINGS', { id: 'default', checkCallDefaultIntervalHours: 0 }, ADMIN),
    ).rejects.toThrow(/between 1 and 48/)
    expect(table(TABLES.settings).size).toBe(0)
  })

  it('refuses a text template with no link in it', async () => {
    await expect(
      call('SAVE_TRACKING_SETTINGS', { id: 'default', trackingSmsTemplate: 'Call dispatch please' }, ADMIN),
    ).rejects.toThrow(/must contain \{url\}/)
    expect(table(TABLES.settings).size).toBe(0)
  })

  it('saves the tracking block and leaves the rest of the row alone', async () => {
    table(TABLES.settings).set('default', {
      id: 'default', __typename: 'TmsSettings', marginFloorBps: 1200, updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const saved = await call('SAVE_TRACKING_SETTINGS', {
      id: 'default',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      checkCallDefaultIntervalHours: 6,
      checkCallGraceMinutes: 20,
      checkCallNotifyChannel: 'BOTH',
      trackingSmsTemplate: '{broker}: ping us for load {loadNumber}: {url}',
      trackingContact: { mode: 'FIXED', name: 'Night desk', email: 'NIGHT@bcatcorp.com', phone: '+13125550100' },
    }, ADMIN)

    expect(saved).toMatchObject({
      marginFloorBps: 1200,
      checkCallDefaultIntervalHours: 6,
      checkCallGraceMinutes: 20,
      checkCallNotifyChannel: 'BOTH',
      trackingContact: { mode: 'FIXED', name: 'Night desk', email: 'night@bcatcorp.com' },
    })
  })

  it('refuses a stale expectedUpdatedAt', async () => {
    table(TABLES.settings).set('default', {
      id: 'default', __typename: 'TmsSettings', updatedAt: '2026-01-02T00:00:00.000Z',
    })

    await expect(
      call('SAVE_TRACKING_SETTINGS', {
        id: 'default', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', checkCallGraceMinutes: 30,
      }, ADMIN),
    ).rejects.toThrow(/changed by someone else/)
  })
})

// ── SEND_UPLOAD_LINK ─────────────────────────────────────────────────────────

describe('SEND_UPLOAD_LINK', () => {
  it('refuses an own-asset leg and points at the driver app instead', async () => {
    seed({ load: { status: 'DELIVERED' }, loadCarrier: { kind: 'OWN_ASSET', carrierId: null, carrierName: null } })

    await expect(call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })).rejects.toThrow(
      /driver app/,
    )
    expect(links()).toHaveLength(0)
  })

  it('refuses a load that has not delivered unless the send is deliberate', async () => {
    seed()

    await expect(call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })).rejects.toThrow(
      /has not delivered yet/,
    )
    expect(links()).toHaveLength(0)

    const early = await call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY', early: true })

    expect(early.emailStatus).toBe('COPY')
    expect(links()).toHaveLength(1)
  })

  it('refuses to ask for paperwork on a voided shipment', async () => {
    seed({ load: { status: 'DELIVERED' }, shipment: { voidedAt: '2026-01-03T00:00:00.000Z' } })

    await expect(call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })).rejects.toThrow(
      /Shipment BC1001 is voided/,
    )
    expect(links()).toHaveLength(0)
  })

  it('re-mails the same token, and mints a new one only on regenerate', async () => {
    seed({ load: { status: 'DELIVERED', deliveredAt: '2026-02-02T09:00:00.000Z' } })

    const first = await call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })
    const token = String((first.link as Row).id)

    expect(first.url).toBe(`https://portal.test/track/u/${token}`)
    expect(first.link).toMatchObject({
      kind: 'CARRIER_UPLOAD',
      status: 'ACTIVE',
      loadCarrierId: 'lc-1',
      uploadCount: 0,
      // Thirty days past delivery, the step E default.
      expiresAt: '2026-03-04T09:00:00.000Z',
      neededTypes: ['POD', 'CARRIER_INVOICE'],
    })
    expect(table(TABLES.loadCarrier).get('lc-1')).toMatchObject({
      uploadLinkId: token,
      podRequestedAt: expect.any(String),
    })
    // The first request for an assignment is the row the notifier would have claimed.
    expect(notices().map((n) => n.id)).toEqual(['pod:lc-1'])

    const again = await call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })

    expect(String((again.link as Row).id)).toBe(token)
    expect(links()).toHaveLength(1)
    // A deliberate resend is a second e-mail, so it is a second row.
    expect(notices()).toHaveLength(2)

    const regenerated = await call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY', regenerate: true })
    const newToken = String((regenerated.link as Row).id)

    expect(newToken).not.toBe(token)
    expect(table(TABLES.link).get(token)).toMatchObject({ status: 'REVOKED' })
    expect(table(TABLES.link).get(newToken)).toMatchObject({ status: 'ACTIVE' })
    expect(table(TABLES.loadCarrier).get('lc-1')).toMatchObject({ uploadLinkId: newToken })
  })

  it('keeps the rendered body on a NOT_SENT notice when SES refuses', async () => {
    seed({
      load: { status: 'DELIVERED', deliveredAt: '2026-02-02T09:00:00.000Z' },
      loadCarrier: { dispatcherEmail: 'Dispatch@Swift.test', dispatcherName: 'Rosa Vega' },
    })

    const result = await call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'EMAIL' })
    const token = String((result.link as Row).id)

    expect(result.emailStatus).toBe('NOT_SENT')
    expect(result.emailError).toMatch(/AccessDenied/)
    const notice = table(TABLES.notice).get('pod:lc-1')!
    expect(notice).toMatchObject({
      kind: 'POD_REQUEST',
      status: 'NOT_SENT',
      // The dispatcher on the assignment is the default recipient.
      to: 'dispatch@swift.test',
      loadCarrierId: 'lc-1',
      trackingLinkId: token,
    })
    expect(String(notice.body)).toContain(`https://portal.test/track/u/${token}`)
    expect(String(notice.body)).toContain('Proof of delivery')
    expect(String(notice.error)).toMatch(/AccessDenied/)
    // Nothing was delivered, so nothing is stamped as sent.
    expect(table(TABLES.link).get(token)).toMatchObject({ sentAt: null })
  })

  it('does not e-mail the carrier twice when the notifier already claimed pod:lc-1', async () => {
    // The notifier claimed the deterministic notice and sent it, but its follow-up
    // stamp on the assignment has not landed (or the operator read the row before it
    // did), so the manual send still believes this is the first request and draws the
    // same id. The claim is what stops the second e-mail.
    seed({
      load: { status: 'DELIVERED', deliveredAt: '2026-02-02T09:00:00.000Z' },
      loadCarrier: { dispatcherEmail: 'dispatch@swift.test', dispatcherName: 'Rosa Vega' },
    })
    table(TABLES.notice).set('pod:lc-1', {
      id: 'pod:lc-1',
      __typename: 'ShipmentNotice',
      shipmentId: 'shp-1',
      loadId: 'lod-1',
      loadCarrierId: 'lc-1',
      kind: 'POD_REQUEST',
      channel: 'EMAIL',
      to: 'dispatch@swift.test',
      subject: 'Paperwork needed for BC1001-1',
      body: 'Sent by the notifier',
      status: 'SENT',
      messageId: 'ses-notifier-1',
      sentAt: '2026-02-02T11:00:00.000Z',
      createdBy: 'shipment-notifier',
      createdAt: '2026-02-02T11:00:00.000Z',
      updatedAt: '2026-02-02T11:00:00.000Z',
    })

    const result = await call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'EMAIL' })
    const token = String((result.link as Row).id)

    // Nothing left the building a second time, and the notifier's row is untouched.
    expect(sesSend).not.toHaveBeenCalled()
    expect(notices()).toHaveLength(1)
    expect(table(TABLES.notice).get('pod:lc-1')).toMatchObject({
      status: 'SENT',
      messageId: 'ses-notifier-1',
      body: 'Sent by the notifier',
    })
    expect(result.emailStatus).toBe('NOT_SENT')
    expect(result.emailError).toBe('This carrier has already been asked for the paperwork once')
    // The operator still gets a working link to copy — the link itself was written.
    expect(result.url).toBe(`https://portal.test/track/u/${token}`)
    expect(result.link).toMatchObject({ kind: 'CARRIER_UPLOAD', status: 'ACTIVE', loadCarrierId: 'lc-1', sentAt: null })
  })

  it('refuses an email send to an assignment with no dispatcher address', async () => {
    seed({ load: { status: 'DELIVERED' } })

    await expect(call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'EMAIL' })).rejects.toThrow(
      /No dispatcher email/,
    )
    expect(links()).toHaveLength(0)
  })
})

// ── REVOKE_UPLOAD_LINK ───────────────────────────────────────────────────────

describe('REVOKE_UPLOAD_LINK', () => {
  it('kills the link and clears the assignment pointer', async () => {
    seed({ load: { status: 'DELIVERED' } })
    const sent = await call('SEND_UPLOAD_LINK', { loadCarrierId: 'lc-1', via: 'COPY' })
    const token = String((sent.link as Row).id)

    await call('REVOKE_UPLOAD_LINK', { trackingLinkId: token })

    expect(table(TABLES.link).get(token)).toMatchObject({ status: 'REVOKED', revokedBy: 'ops@bcatcorp.com' })
    expect(table(TABLES.loadCarrier).get('lc-1')).toMatchObject({ uploadLinkId: null })
  })
})

// ── SEND_MILESTONE_NOTICE ────────────────────────────────────────────────────

describe('SEND_MILESTONE_NOTICE', () => {
  it('refuses an email send nobody is subscribed to', async () => {
    seed()
    seedCustomer({ visibilityPrefs: { milestoneEmails: false } })

    await expect(
      call('SEND_MILESTONE_NOTICE', { shipmentId: 'shp-1', milestone: 'DELIVERED', via: 'EMAIL' }),
    ).rejects.toThrow(/Nobody is subscribed/)
    expect(notices()).toHaveLength(0)
  })

  it('mails everyone who subscribed and stamps the shipment', async () => {
    seed()
    seedCustomer()
    sesSend.mockResolvedValue({ MessageId: 'ses-7' })

    const result = await call('SEND_MILESTONE_NOTICE', {
      shipmentId: 'shp-1', milestone: 'DELIVERED', via: 'EMAIL', message: 'Signed BOL to follow.',
    })

    expect(result).toMatchObject({ emailStatus: 'SENT', to: ['pat@acme.test'] })
    const notice = notices()[0]
    expect(notice).toMatchObject({ kind: 'MILESTONE', milestone: 'DELIVERED', status: 'SENT', messageId: 'ses-7' })
    expect(String(notice.body)).toContain('Signed BOL to follow.')
    expect(table(TABLES.shipment).get('shp-1')).toMatchObject({ lastNoticeStatus: 'SENT', lastNoticeAt: expect.any(String) })

    // A resend is a real second row, not a conditional write that silently did nothing.
    await call('SEND_MILESTONE_NOTICE', { shipmentId: 'shp-1', milestone: 'DELIVERED', via: 'EMAIL' })
    expect(notices()).toHaveLength(2)
  })

  it('refuses a shipment nobody has submitted yet', async () => {
    seed({ shipment: { status: 'DRAFT' } })
    seedCustomer()

    await expect(
      call('SEND_MILESTONE_NOTICE', { shipmentId: 'shp-1', milestone: 'DELIVERED', via: 'COPY' }),
    ).rejects.toThrow(/Submit the order/)
  })

  it('refuses to tell the customer anything about a voided shipment', async () => {
    seed({ shipment: { status: 'DELIVERED', voidedAt: '2026-01-03T00:00:00.000Z' } })
    seedCustomer()

    await expect(
      call('SEND_MILESTONE_NOTICE', { shipmentId: 'shp-1', milestone: 'DELIVERED', via: 'EMAIL' }),
    ).rejects.toThrow(/Shipment BC1001 is voided/)
    expect(notices()).toHaveLength(0)
  })
})

// ── EMAIL_DOCUMENTS ──────────────────────────────────────────────────────────

describe('EMAIL_DOCUMENTS', () => {
  it('refuses a document marked internal', async () => {
    seed()
    seedDocument({ id: 'sdoc-int', type: 'LOAD_SUMMARY', name: 'load-summary.pdf', audience: 'INTERNAL' })

    await expect(
      call('EMAIL_DOCUMENTS', {
        shipmentId: 'shp-1', documentIds: ['sdoc-int'], to: ['ap@acme.test'], recipientKind: 'CUSTOMER',
      }),
    ).rejects.toThrow(/never leaves the office/)
    expect(notices()).toHaveLength(0)
  })

  it("refuses the carrier's paperwork on a customer e-mail", async () => {
    seed()
    seedDocument({ id: 'sdoc-ci', type: 'CARRIER_INVOICE', name: 'swift-invoice.pdf', audience: 'CARRIER' })

    await expect(
      call('EMAIL_DOCUMENTS', {
        shipmentId: 'shp-1', documentIds: ['sdoc-ci'], to: ['ap@acme.test'], recipientKind: 'CUSTOMER',
      }),
    ).rejects.toThrow(/does not go to the customer/)
  })

  it('refuses to e-mail documents off a voided shipment', async () => {
    seed({ shipment: { voidedAt: '2026-01-03T00:00:00.000Z' } })
    seedDocument()

    await expect(
      call('EMAIL_DOCUMENTS', {
        shipmentId: 'shp-1', documentIds: ['sdoc-1'], to: ['ap@acme.test'], recipientKind: 'CUSTOMER',
      }),
    ).rejects.toThrow(/Shipment BC1001 is voided/)
    expect(notices()).toHaveLength(0)
  })

  it('refuses a carrier-portal upload nobody has reviewed yet', async () => {
    seed()
    seedDocument({ source: 'CARRIER_PORTAL', reviewStatus: 'PENDING' })

    await expect(
      call('EMAIL_DOCUMENTS', {
        shipmentId: 'shp-1', documentIds: ['sdoc-1'], to: ['ap@acme.test'], recipientKind: 'CUSTOMER',
      }),
    ).rejects.toThrow(/waiting to be reviewed/)
  })

  it('attaches the bytes and records what went out', async () => {
    seed()
    seedDocument()
    sesSend.mockResolvedValue({ MessageId: 'ses-9' })

    const result = await call('EMAIL_DOCUMENTS', {
      shipmentId: 'shp-1', documentIds: ['sdoc-1'], to: ['ap@acme.test'], cc: ['ops@acme.test'],
      recipientKind: 'CUSTOMER', message: 'POD for BC1001.',
    })

    expect(result).toMatchObject({ emailStatus: 'SENT', downloads: [] })
    const raw = new TextDecoder().decode(sesSend.mock.calls[0][0].input.Content.Raw.Data)
    expect(raw).toContain('filename="pod-BC1001.pdf"')
    expect(raw).toContain(Buffer.from('%PDF', 'utf8').toString('base64'))
    expect(notices()[0]).toMatchObject({
      kind: 'DOCUMENTS',
      status: 'SENT',
      to: 'ap@acme.test',
      cc: 'ops@acme.test',
      attachments: [{ documentId: 'sdoc-1', name: 'pod-BC1001.pdf', sizeBytes: 120_000 }],
    })
  })

  it('hands back a download for every file when SES refuses', async () => {
    seed()
    seedDocument()

    const result = await call('EMAIL_DOCUMENTS', {
      shipmentId: 'shp-1', documentIds: ['sdoc-1'], to: ['ap@acme.test'], recipientKind: 'CUSTOMER',
    })

    expect(result.emailStatus).toBe('NOT_SENT')
    expect(result.downloads).toEqual([
      {
        documentId: 'sdoc-1',
        name: 'pod-BC1001.pdf',
        url: 'https://s3.test/shipment-docs/shp-1/sdoc-1-pod.pdf?signed',
      },
    ])
    expect(notices()[0]).toMatchObject({ status: 'NOT_SENT', body: expect.stringContaining('Proof of delivery') })
  })

  it('refuses more than ten megabytes of attachments', async () => {
    seed()
    seedDocument({ id: 'sdoc-big', name: 'photos.pdf', sizeBytes: 11 * 1024 * 1024 })

    await expect(
      call('EMAIL_DOCUMENTS', {
        shipmentId: 'shp-1', documentIds: ['sdoc-big'], to: ['ap@acme.test'], recipientKind: 'CUSTOMER',
      }),
    ).rejects.toThrow(/at most 10 MB/)
    expect(s3Send).not.toHaveBeenCalled()
  })
})

// ── SAVE_DOCUMENT_SETTINGS ───────────────────────────────────────────────────

describe('SAVE_DOCUMENT_SETTINGS', () => {
  it('refuses a dispatcher who is not an admin', async () => {
    await expect(call('SAVE_DOCUMENT_SETTINGS', { podRequestEnabled: false })).rejects.toThrow(
      /requires owner or ADMIN/,
    )
    expect(table(TABLES.settings).size).toBe(0)
  })

  it('refuses a required type nobody can map to a document', async () => {
    await expect(
      call('SAVE_DOCUMENT_SETTINGS', { requiredCarrierUploadTypes: ['POD', 'Whatever Ryne wants'] }, ADMIN),
    ).rejects.toThrow(/does not recognise: Whatever Ryne wants/)
    expect(table(TABLES.settings).size).toBe(0)
  })

  it('refuses an email template with no link in it', async () => {
    await expect(
      call('SAVE_DOCUMENT_SETTINGS', { podRequestEmailTemplate: 'Send us the POD' }, ADMIN),
    ).rejects.toThrow(/must contain \{url\}/)
  })

  it('saves the document block and leaves the rest of the row alone', async () => {
    table(TABLES.settings).set('default', {
      id: 'default', __typename: 'TmsSettings', marginFloorBps: 1200, updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const saved = await call('SAVE_DOCUMENT_SETTINGS', {
      id: 'default',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      milestoneNoticesEnabled: true,
      podRequestEnabled: false,
      // The free-text vocabulary people already type is normalised, not refused.
      requiredCarrierUploadTypes: ['Proof of delivery', 'carrier invoice'],
      uploadLinkExpiryDays: 45,
      podRequestEmailTemplate: 'Load {loadNumber} delivered — upload here: {url}',
      documentDeleteAdminOnly: true,
    }, ADMIN)

    expect(saved).toMatchObject({
      marginFloorBps: 1200,
      milestoneNoticesEnabled: true,
      podRequestEnabled: false,
      requiredCarrierUploadTypes: ['POD', 'CARRIER_INVOICE'],
      uploadLinkExpiryDays: 45,
      documentDeleteAdminOnly: true,
    })
  })

  it('refuses an expiry outside one to a hundred and eighty days', async () => {
    await expect(
      call('SAVE_DOCUMENT_SETTINGS', { uploadLinkExpiryDays: 365 }, ADMIN),
    ).rejects.toThrow(/between 1 and 180/)
  })
})
