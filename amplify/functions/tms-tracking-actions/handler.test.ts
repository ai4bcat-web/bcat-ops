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

// ── SEND_CUSTOMER_LINK ───────────────────────────────────────────────────────

describe('SEND_CUSTOMER_LINK', () => {
  it('refuses a shipment nobody has submitted yet', async () => {
    seed({ shipment: { status: 'DRAFT' } })

    await expect(
      call('SEND_CUSTOMER_LINK', { shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: [] }),
    ).rejects.toThrow(/Submit the order/)
    expect(links()).toHaveLength(0)
  })

  it('refuses a shipment in the trash', async () => {
    seed({ shipment: { deletedAt: '2026-01-03T00:00:00.000Z' } })

    await expect(
      call('SEND_CUSTOMER_LINK', { shipmentId: 'shp-1', expectedVersion: 3, via: 'COPY', to: [] }),
    ).rejects.toThrow(/trash/)
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
