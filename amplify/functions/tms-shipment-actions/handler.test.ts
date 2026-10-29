/**
 * tms-shipment-actions handler tests.
 *
 * The DynamoDB mock is a small in-memory engine rather than a list of scripted
 * responses: this router's whole job is keeping five tables agreeing with each
 * other inside one transaction, and a test that only asserts "a Put was sent"
 * cannot tell a correct transaction from a wrong one. The engine implements
 * exactly what the handler emits — GetItem, Query on a GSI, BatchGetItem,
 * UpdateItem with ADD, and TransactWriteItems with the conditions it writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
// The rule the public offer page shows a carrier, used here to answer a link the
// way a carrier would rather than by hard-coding the number we hope is on it.
import { ourOfferCents } from '../../../src/lib/quotes'

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
  shipment: 'Shipment-test',
  order: 'Order-test',
  carrier: 'LoadCarrier-test',
  financials: 'LoadFinancials-test',
  charge: 'LoadCharge-test',
  load: 'Load-test',
  customer: 'Customer-test',
  settings: 'TmsSettings-test',
  audit: 'AuditLog-test',
  carrierDirectory: 'Carrier-test',
  carrierDoc: 'CarrierDocument-test',
  driver: 'Driver-test',
  checkCall: 'LoadCheckCall-test',
  trackingLink: 'TrackingLink-test',
  shipmentDocument: 'ShipmentDocument-test',
  driverSubmission: 'DriverSubmission-test',
  driverSubmissionDoc: 'DriverSubmissionDoc-test',
  quote: 'Quote-test',
  laneSample: 'LaneRateSample-test',
  carrierContact: 'CarrierContact-test',
  division: 'Division-test',
  notice: 'ShipmentNotice-test',
}

const store = vi.hoisted(() => {
  process.env.SHIPMENT_TABLE_NAME = 'Shipment-test'
  process.env.ORDER_TABLE_NAME = 'Order-test'
  process.env.LOAD_CARRIER_TABLE_NAME = 'LoadCarrier-test'
  process.env.LOAD_FINANCIALS_TABLE_NAME = 'LoadFinancials-test'
  process.env.LOAD_CHARGE_TABLE_NAME = 'LoadCharge-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.SETTINGS_TABLE_NAME = 'TmsSettings-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  process.env.DRIVER_TABLE_NAME = 'Driver-test'
  process.env.CARRIER_TABLE_NAME = 'Carrier-test'
  process.env.CARRIER_DOCUMENT_TABLE_NAME = 'CarrierDocument-test'
  process.env.LOAD_CHECK_CALL_TABLE_NAME = 'LoadCheckCall-test'
  process.env.TRACKING_LINK_TABLE_NAME = 'TrackingLink-test'
  process.env.SHIPMENT_DOCUMENT_TABLE_NAME = 'ShipmentDocument-test'
  process.env.DRIVER_SUBMISSION_TABLE_NAME = 'DriverSubmission-test'
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = 'DriverSubmissionDoc-test'
  process.env.QUOTE_TABLE_NAME = 'Quote-test'
  process.env.LANE_RATE_SAMPLE_TABLE_NAME = 'LaneRateSample-test'
  process.env.CARRIER_CONTACT_TABLE_NAME = 'CarrierContact-test'
  process.env.DIVISION_TABLE_NAME = 'Division-test'
  process.env.SHIPMENT_NOTICE_TABLE_NAME = 'ShipmentNotice-test'
  process.env.BUCKET_NAME = 'bcat-test-bucket'
  process.env.PORTAL_ORIGIN = 'https://portal.test'
  process.env.AMPLIFY_DATA_DEFAULT_NAME = 'amplifyData'
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
 * The GSI hash keys of every table this router writes (`amplify/data/resource.ts`).
 *
 * DynamoDB refuses an item that carries a NULL on one of these — `Type mismatch
 * for Index Key …` — and refuses it only in production, where the indexes exist.
 * A Map does not, which is how a revert that SET `loadId: null` passed its test and
 * then stranded a quote at WON on dev. The engine enforces it here instead.
 */
const INDEX_HASH_KEYS: Record<string, readonly string[]> = {
  [TABLES.shipment]: ['number', 'status', 'customerId', 'pickupMonth'],
  [TABLES.order]: ['shipmentId', 'customerId', 'arStatus'],
  [TABLES.load]: ['customerId', 'shipmentId', 'status', 'checkCallOpen'],
  [TABLES.carrier]: ['loadId', 'shipmentId', 'carrierId', 'apOpen'],
  [TABLES.checkCall]: ['loadId', 'shipmentId', 'incidentOpen'],
  [TABLES.notice]: ['shipmentId', 'loadId'],
  [TABLES.shipmentDocument]: ['shipmentId', 'reviewStatus'],
  [TABLES.carrierDirectory]: ['normalizedName', 'status', 'mcNumber', 'dotNumber'],
  [TABLES.carrierContact]: ['carrierId'],
  [TABLES.carrierDoc]: ['carrierId'],
  [TABLES.quote]: ['customerId', 'loadId', 'quoteOpen', 'quoteMonth', 'linkToken'],
  [TABLES.laneSample]: ['laneKey', 'laneKey3'],
}

/** DynamoDB's own refusal, in its own words, before the item reaches the table. */
function assertIndexKeys(tableName: string, item: Row): void {
  for (const key of INDEX_HASH_KEYS[tableName] ?? []) {
    if (key in item && item[key] === null) {
      throw new Error(`ValidationException: Type mismatch for Index Key ${key} Expected: S Actual: NULL`)
    }
  }
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

/** Split `SET … ADD … REMOVE …` into its clauses, in whatever order they came. */
function updateClauses(expression: string): Record<string, string> {
  const clauses: Record<string, string> = {}
  for (const part of expression.split(/\s+(?=SET\s|ADD\s|REMOVE\s)/)) {
    const m = /^(SET|ADD|REMOVE)\s+(.*)$/s.exec(part.trim())
    if (m) clauses[m[1]] = m[2]
  }
  return clauses
}

/**
 * One term of a condition expression, against the row as it stands.
 *
 * A `#name` resolves through ExpressionAttributeNames, a `:token` through the
 * values, and a bare word is the attribute itself — which is how
 * `attribute_not_exists(id)` and step H's `#casStatus IN (…)` both read.
 */
function termHolds(term: string, existing: Row | null, values: Row, names: Record<string, string>): boolean {
  const read = (token: string): unknown =>
    token.startsWith(':') ? values[token] : existing?.[token.startsWith('#') ? names[token] : token]

  const exists = /^attribute_(not_)?exists\(([#\w]+)\)$/.exec(term)
  if (exists) {
    const present = read(exists[2]) != null
    return exists[1] ? !present : present
  }
  const inList = /^([#\w]+)\s+IN\s+\(([^)]*)\)$/.exec(term)
  if (inList) {
    const actual = read(inList[1])
    return inList[2].split(',').some((token) => read(token.trim()) === actual)
  }
  const compare = /^([#\w]+)\s*(<>|<=|>=|=|<|>)\s*([:#\w]+)$/.exec(term)
  if (compare) {
    const left = read(compare[1])
    const right = read(compare[3])
    switch (compare[2]) {
      case '=': return left === right
      case '<>': return left !== right
      case '<': return String(left ?? '') < String(right ?? '')
      case '>': return String(left ?? '') > String(right ?? '')
      case '<=': return String(left ?? '') <= String(right ?? '')
      default: return String(left ?? '') >= String(right ?? '')
    }
  }
  // A condition the engine cannot read is a test that cannot tell a guarded write
  // from an unguarded one. Fail loudly rather than wave it through.
  throw new Error(`Unhandled condition term: ${term}`)
}

/** The AND-joined terms of a condition, with the `updatedAt` CAS read whole. */
function conditionHolds(
  expression: string | undefined,
  existing: Row | null,
  values: Row,
  names: Record<string, string>,
): boolean {
  if (!expression) return true
  if (expression.includes('casExpectedUpdatedAt')) {
    return String(values[':casExpectedUpdatedAt'] ?? '') === String(existing?.updatedAt ?? '')
  }
  return expression.split(' AND ').every((term) => termHolds(term.trim(), existing, values, names))
}

/** Apply the `SET #a = :a, …`, `ADD counter :one` and `REMOVE #a, #b` shapes. */
function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const key = unmarshall(spec.Key as never) as { id: string }
  const existing = t.get(key.id) ?? null
  const values = spec.ExpressionAttributeValues
    ? (unmarshall(spec.ExpressionAttributeValues as never) as Row)
    : {}
  const names = spec.ExpressionAttributeNames ?? {}
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] : token)

  if (!conditionHolds(spec.ConditionExpression, existing, values, names)) {
    throw new ConditionalCheckFailed(`${spec.ConditionExpression} on ${spec.TableName}/${key.id}`)
  }

  const next: Row = { ...(existing ?? { id: key.id }) }
  const clauses = updateClauses(spec.UpdateExpression)
  const addMatch = clauses.ADD ? /^(\w+)\s+(:\w+)/.exec(clauses.ADD) : null
  if (addMatch) {
    const field = addMatch[1]
    const delta = Number(values[addMatch[2]] ?? 0)
    next[field] = Number(next[field] ?? 0) + delta
  }
  if (clauses.SET) {
    for (const assignment of clauses.SET.split(/,\s*/)) {
      const m = /^\s*([#\w]+)\s*=\s*(.+?)\s*$/.exec(assignment)
      if (!m) continue
      const field = resolve(m[1])
      const rhs = m[2]
      const ifNotExists = /^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)$/.exec(rhs)
      if (ifNotExists) {
        const target = resolve(ifNotExists[1])
        if (next[target] === undefined) next[target] = values[ifNotExists[2]]
        continue
      }
      next[field] = values[rhs]
    }
  }
  if (clauses.REMOVE) {
    for (const token of clauses.REMOVE.split(/,\s*/)) {
      delete next[resolve(token.trim())]
    }
  }
  assertIndexKeys(spec.TableName, next)
  t.set(key.id, next)
  return next
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
    QueryCommand: make('Query'),
    TransactWriteItemsCommand: make('Transact'),
    ScanCommand: make('Scan'),
  }
})

// ── S3 / SES mocks — generated PDFs, uploaded documents and the rate con email ──
const s3Send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = s3Send
  }
  const make = (type: string) =>
    class {
      input: Record<string, unknown>
      __type = type
      constructor(input: Record<string, unknown>) {
        this.input = input
      }
    }
  return { S3Client, PutObjectCommand: make('PutObject'), HeadObjectCommand: make('Head') }
})

const getSignedUrl = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }))

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

// ── Amplify data client mock — Load writes land in the same store ────────────
const loadCreate = vi.hoisted(() => vi.fn())
const loadUpdate = vi.hoisted(() => vi.fn())

vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }))
vi.mock('aws-amplify/data', () => ({
  generateClient: vi.fn(() => ({ models: { Load: { create: loadCreate, update: loadUpdate } } })),
}))
vi.mock('@aws-amplify/backend-function/runtime', () => ({
  getAmplifyDataClientConfig: vi.fn(async () => ({
    resourceConfig: { API: { GraphQL: { endpoint: 'http://localhost', region: 'us-east-1', defaultAuthMode: 'iam', modelIntrospection: {} } } },
    libraryOptions: {},
  })),
}))

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
      // `Division` is identified by `key`, every other model here by `id`; a GetItem
      // that keys a division on `id` is a schema mismatch the real table refuses.
      const key = unmarshall(input.Key as never) as { id?: string; key?: string }
      const item = table(String(input.TableName)).get(String(key.id ?? key.key))
      return { Item: item ? marshall(item, { removeUndefinedValues: true }) : undefined }
    }
    case 'BatchGet': {
      const requests = input.RequestItems as Record<string, { Keys: Record<string, unknown>[] }>
      const Responses: Record<string, unknown[]> = {}
      for (const [name, req] of Object.entries(requests)) {
        Responses[name] = req.Keys
          .map((k) => table(name).get(String((unmarshall(k as never) as { id: string }).id)))
          .filter((i): i is Row => !!i)
          .map((i) => marshall(i, { removeUndefinedValues: true }))
      }
      return { Responses, UnprocessedKeys: {} }
    }
    case 'Query': {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = unmarshall(input.ExpressionAttributeValues as never) as Row
      const cond = String(input.KeyConditionExpression)
      const field = names[cond.split(' ')[0]] ?? cond.split(' ')[0]
      const wanted = values[':v']
      const items = [...table(String(input.TableName)).values()].filter((i) => i[field] === wanted)
      return { Items: items.map((i) => marshall(i, { removeUndefinedValues: true })) }
    }
    case 'Put': {
      const item = unmarshall(input.Item as never) as Row
      const t = table(String(input.TableName))
      if (input.ConditionExpression === 'attribute_not_exists(id)' && t.has(String(item.id))) {
        throw new ConditionalCheckFailed(`${String(input.TableName)}/${String(item.id)} already exists`)
      }
      assertIndexKeys(String(input.TableName), item)
      t.set(String(item.id), item)
      return {}
    }
    case 'Update':
      return { Attributes: marshall(applyUpdate(input as unknown as UpdateSpec), { removeUndefinedValues: true }) }
    case 'Scan': {
      const items = [...table(String(input.TableName)).values()]
      return { Items: items.map((i) => marshall(i, { removeUndefinedValues: true })) }
    }
    case 'Transact': {
      const items = input.TransactItems as Record<string, Record<string, unknown>>[]
      // All-or-nothing: stage against a copy of every touched table, then commit.
      const snapshot = new Map<string, Map<string, Row>>()
      for (const [name, t] of store) snapshot.set(name, new Map(t))
      try {
        for (const entry of items) {
          if (entry.Put) {
            const put = entry.Put as { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string }
            const item = unmarshall(put.Item as never) as Row
            const t = table(put.TableName)
            if (put.ConditionExpression === 'attribute_not_exists(id)' && t.has(String(item.id))) {
              throw new ConditionalCheckFailed(`${put.TableName}/${String(item.id)} already exists`)
            }
            assertIndexKeys(put.TableName, item)
            t.set(String(item.id), item)
          } else if (entry.Update) {
            applyUpdate(entry.Update as unknown as UpdateSpec)
          } else if (entry.Delete) {
            const del = entry.Delete as { TableName: string; Key: Record<string, unknown> }
            table(del.TableName).delete(String((unmarshall(del.Key as never) as { id: string }).id))
          } else if (entry.ConditionCheck) {
            // Guards a row the transaction does not write; the whole thing is
            // refused when that row no longer matches.
            const check = entry.ConditionCheck as {
              TableName: string
              Key: Record<string, unknown>
              ConditionExpression: string
              ExpressionAttributeValues?: Record<string, unknown>
            }
            const key = unmarshall(check.Key as never) as { id: string }
            const id = String(key.id)
            const values = check.ExpressionAttributeValues
              ? (unmarshall(check.ExpressionAttributeValues as never) as Row)
              : {}
            if (check.ConditionExpression.includes('casExpectedUpdatedAt')) {
              const actual = table(check.TableName).get(id)?.updatedAt ?? ''
              if (String(values[':casExpectedUpdatedAt'] ?? '') !== String(actual ?? '')) {
                throw new ConditionalCheckFailed(`CAS on ${check.TableName}/${id}`)
              }
            }
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
  sub: 'sub-dispatch',
  username: 'dispatch',
  claims: { email: 'dispatch@bcatcorp.com', 'cognito:groups': ['page-loads'] },
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

function call(action: string, input: Row, identity: unknown = DISPATCHER): Promise<Row> {
  return handler({ arguments: { action, input: JSON.stringify(input) }, identity } as never)
}

function seedSettings(extra: Row = {}): void {
  table(TABLES.settings).set('default', {
    id: 'default',
    shipmentPrefix: 'S',
    nextShipmentNumber: 0,
    marginFloorBps: 1500,
    chargeCodes: [
      { code: 'LINEHAUL', label: 'Linehaul', calculatedBy: 'FLAT' },
      { code: 'FSC', label: 'Fuel surcharge', calculatedBy: 'PERCENT' },
      { code: 'DETENTION', label: 'Detention', calculatedBy: 'FLAT' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  })
}

function seedCustomer(extra: Row = {}): Row {
  const customer: Row = {
    id: 'cus-1',
    name: 'BATORY FOODS',
    status: 'ACTIVE',
    active: true,
    creditLimitCents: 10_000_00,
    defaultCharges: [{ code: 'LINEHAUL', amountCents: 250_000 }],
    pricingDefaults: { mode: 'MARGIN', defaultBps: 2000 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
  table(TABLES.customer).set(String(customer.id), customer)
  return customer
}

const PICKUP = {
  id: 'stp-pu',
  type: 'pickup',
  name: 'OAKLEY CHICAGO',
  city: 'CHICAGO, IL',
  appt: '2026-03-02T13:00:00.000Z',
  sequence: 0,
}
const DELIVERY = {
  id: 'stp-de',
  type: 'delivery',
  name: 'KANSAS CITY DC',
  city: 'KANSAS CITY, MO',
  appt: '2026-03-03T13:00:00.000Z',
  sequence: 1,
}

/** Create a draft and save the standard one-pickup/one-delivery order onto it. */
async function createDraft(identity: unknown = DISPATCHER): Promise<{ shipmentId: string; loadId: string; orderId: string }> {
  const bundle = (await call('CREATE_SHIPMENT', { customerId: 'cus-1' }, identity)) as {
    shipment: Row
    orders: Row[]
    loads: Row[]
  }
  return {
    shipmentId: String(bundle.shipment.id),
    orderId: String(bundle.orders[0].id),
    loadId: String(bundle.loads[0].id),
  }
}

async function saveForm(shipmentId: string, overrides: Row = {}): Promise<Row> {
  const shipment = table(TABLES.shipment).get(shipmentId)!
  return call('SAVE_ORDER_FORM', {
    shipmentId,
    expectedUpdatedAt: shipment.updatedAt,
    order: { equipmentType: "53' VAN" },
    stops: [PICKUP, DELIVERY],
    ...overrides,
  })
}

/**
 * What is actually in the bucket, so a COMMIT_DOCUMENT that HEADs an object sees
 * what the browser's PUT put there — a commit before the upload lands, or one
 * that lies about the size, is the behaviour under test.
 */
interface S3Head {
  ContentLength: number
  ContentType: string
}
const s3Objects = new Map<string, S3Head>()

/** Stand in for the browser's presigned PUT. */
function putS3Object(key: string, head: S3Head): void {
  s3Objects.set(key, head)
}

function runS3Command(cmd: MockCommand): unknown {
  const key = String(cmd.input.Key)
  if (cmd.__type === 'PutObject') {
    const body = cmd.input.Body as Uint8Array | undefined
    s3Objects.set(key, {
      ContentLength: body ? body.length : 0,
      ContentType: String(cmd.input.ContentType ?? ''),
    })
    return {}
  }
  if (cmd.__type === 'Head') {
    const head = s3Objects.get(key)
    if (!head) {
      const err = new Error(`NotFound: ${key}`)
      err.name = 'NotFound'
      throw err
    }
    return head
  }
  return {}
}

beforeEach(() => {
  store.clear()
  send.mockReset()
  cognitoSend.mockReset()
  loadCreate.mockReset()
  loadUpdate.mockReset()
  s3Send.mockReset()
  sesSend.mockReset()
  getSignedUrl.mockReset()
  s3Objects.clear()
  s3Send.mockImplementation(async (cmd: MockCommand) => runS3Command(cmd))
  sesSend.mockResolvedValue({ MessageId: 'msg-1' })
  getSignedUrl.mockResolvedValue('https://signed.example/upload')

  send.mockImplementation(async (cmd: MockCommand) => runCommand(cmd))
  loadCreate.mockImplementation(async (input: Row) => {
    const now = new Date().toISOString()
    const item = { ...input, createdAt: now, updatedAt: now }
    table(TABLES.load).set(String(input.id), item)
    return { data: { id: input.id } }
  })
  loadUpdate.mockImplementation(async (input: Row, options?: { condition?: { updatedAt?: { eq?: string } } }) => {
    const existing = table(TABLES.load).get(String(input.id))
    if (!existing) return { data: null, errors: [{ message: 'not found' }] }
    const expected = options?.condition?.updatedAt?.eq
    if (expected != null && existing.updatedAt !== expected) {
      return { data: null, errors: [{ message: 'ConditionalCheckFailedException' }] }
    }
    const next = { ...existing, ...input, updatedAt: new Date().toISOString() }
    table(TABLES.load).set(String(input.id), next)
    return { data: { id: input.id } }
  })

  seedSettings()
  seedCustomer()
})

// ── Authorization ────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('refuses a caller with neither ADMIN nor page-loads', async () => {
    await expect(call('CREATE_SHIPMENT', { customerId: 'cus-1' }, OUTSIDER)).rejects.toThrow(/page-loads/)
  })

  it('refuses a request with no identity at all', async () => {
    await expect(call('CREATE_SHIPMENT', { customerId: 'cus-1' }, null)).rejects.toThrow(/Unauthorized/)
  })
})

// ── CREATE_SHIPMENT ──────────────────────────────────────────────────────────

describe('CREATE_SHIPMENT', () => {
  it('builds the shipment, order, financials, default charges and leg 1', async () => {
    const bundle = (await call('CREATE_SHIPMENT', { customerId: 'cus-1' })) as {
      shipment: Row
      orders: Row[]
      loads: Row[]
      charges: Row[]
      financials: Row[]
    }

    expect(bundle.shipment.number).toBe('S000001')
    expect(bundle.shipment.status).toBe('DRAFT')
    expect(bundle.shipment.source).toBe('MANUAL')
    expect(bundle.orders).toHaveLength(1)
    expect(bundle.orders[0].arStatus).toBe('DOCS_NEEDED')
    expect(bundle.loads).toHaveLength(1)
    expect(bundle.loads[0].leg).toBe(1)
    expect(bundle.loads[0].status).toBe('SOURCING')
    expect(bundle.loads[0].loadNumber).toBe('S000001-1')
    expect(bundle.loads[0].assignmentType).toBe('NEED_TO_COVER')
    // The customer's default LINEHAUL became a CUSTOMER line and the revenue mirror.
    expect(bundle.charges).toHaveLength(1)
    expect(bundle.charges[0]).toMatchObject({ side: 'CUSTOMER', code: 'LINEHAUL', amountCents: 250_000, isRate: true })
    expect(bundle.financials[0]).toMatchObject({ revenueCents: 250_000, customerRateCents: 250_000, costCents: 0 })
  })

  it('takes the next number atomically, so two drafts never collide', async () => {
    await call('CREATE_SHIPMENT', { customerId: 'cus-1' })
    const second = (await call('CREATE_SHIPMENT', { customerId: 'cus-1' })) as { shipment: Row }
    expect(second.shipment.number).toBe('S000002')
  })

  it('refuses a customer that is not ACTIVE', async () => {
    seedCustomer({ status: 'PENDING' })
    await expect(call('CREATE_SHIPMENT', { customerId: 'cus-1' })).rejects.toThrow(/not an active customer/)
  })

  it('refuses a free-credit customer with no approved limit', async () => {
    seedCustomer({ freeCreditRequired: true, creditLimitCents: null })
    await expect(call('CREATE_SHIPMENT', { customerId: 'cus-1' })).rejects.toThrow(/credit limit/)
  })

  it('takes the mode from the customer default before the org default', async () => {
    seedSettings({ defaultMode: 'LTL' })
    seedCustomer({ quotingDefaults: { defaultMode: 'DRAYAGE' } })
    const bundle = (await call('CREATE_SHIPMENT', { customerId: 'cus-1' })) as { shipment: Row }
    expect(bundle.shipment.mode).toBe('DRAYAGE')
  })
})

// ── SAVE_ORDER_FORM ──────────────────────────────────────────────────────────

describe('SAVE_ORDER_FORM', () => {
  it('writes the stops, legacy mirrors and shipment mirrors', async () => {
    const { shipmentId, loadId } = await createDraft()
    const bundle = (await saveForm(shipmentId)) as { shipment: Row; loads: Row[] }

    expect(bundle.shipment.pickupAppt).toBe(PICKUP.appt)
    expect(bundle.shipment.deliveryAppt).toBe(DELIVERY.appt)
    expect(bundle.shipment.pickupMonth).toBe('2026-03')
    expect(bundle.shipment.originCity).toBe('CHICAGO, IL')
    expect(bundle.shipment.destinationCity).toBe('KANSAS CITY, MO')

    const load = table(TABLES.load).get(loadId)!
    expect(load.pickupAppt).toBe(PICKUP.appt)
    expect(load.destinationCity).toBe('KANSAS CITY, MO')
    expect(load.pickupMonth).toBe('2026-03')
  })

  it('allows a draft to be saved with only a pickup', async () => {
    const { shipmentId } = await createDraft()
    const bundle = (await saveForm(shipmentId, { stops: [PICKUP] })) as { shipment: Row; loads: Row[] }
    expect(bundle.shipment.status).toBe('DRAFT')
    expect(JSON.parse(bundle.loads[0].stops as string)).toHaveLength(1)
  })

  it('refuses to submit an order with no delivery', async () => {
    const { shipmentId } = await createDraft()
    await saveForm(shipmentId, { stops: [PICKUP] })
    await expect(
      call('SUBMIT_ORDER', {
        shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
        order: { equipmentType: "53' VAN" },
      }),
    ).rejects.toThrow(/at least one delivery/)
  })

  it('refuses stops whose appointments run backwards', async () => {
    const { shipmentId } = await createDraft()
    await expect(
      saveForm(shipmentId, { stops: [{ ...PICKUP, appt: '2026-03-05T13:00:00.000Z' }, DELIVERY] }),
    ).rejects.toThrow(/chronological/)
  })

  it('refuses a truckload order with no equipment type', async () => {
    const { shipmentId } = await createDraft()
    await expect(saveForm(shipmentId, { order: {} })).rejects.toThrow(/equipment type/)
  })

  it('refuses freight lines weighed in different units', async () => {
    const { shipmentId } = await createDraft()
    await expect(
      saveForm(shipmentId, {
        order: {
          equipmentType: "53' VAN",
          freight: [
            { handlingUnit: 'PALLET', qty: 10, weightLbs: 2000, weightUnit: 'LB' },
            { handlingUnit: 'PALLET', qty: 4, weightLbs: 900, weightUnit: 'KG' },
          ],
        },
      }),
    ).rejects.toThrow(/same weight unit/)
  })

  it('refuses an order missing a reference the customer requires', async () => {
    seedCustomer({ requiredReferences: [{ code: 'PO', level: 'ORDER', display: true, countOnNewOrder: 1 }] })
    const { shipmentId } = await createDraft()
    await expect(saveForm(shipmentId)).rejects.toThrow(/requires 1 PO reference/)
  })

  it('refuses a stale expectedUpdatedAt', async () => {
    const { shipmentId } = await createDraft()
    await expect(
      call('SAVE_ORDER_FORM', {
        shipmentId,
        expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
        order: { equipmentType: "53' VAN" },
        stops: [PICKUP, DELIVERY],
      }),
    ).rejects.toThrow(/changed by someone else/)
  })

  it('refuses to edit a shipment that is no longer a draft', async () => {
    const { shipmentId } = await createDraft()
    await saveForm(shipmentId)
    await call('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt })
    await expect(saveForm(shipmentId)).rejects.toThrow(/Only a draft order/)
  })

  it('prices a percent line off the same side rate base', async () => {
    const { shipmentId } = await createDraft()
    const bundle = (await saveForm(shipmentId, {
      charges: [
        { side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 200_000, sortOrder: 0 },
        { side: 'CUSTOMER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1500, sortOrder: 1 },
      ],
    })) as { financials: Row[] }
    // FSC is itself a rate code, so the base is the LINEHAUL alone: 15% of 200000.
    expect(bundle.financials[0].revenueCents).toBe(230_000)
  })
})

// ── SUBMIT_ORDER ─────────────────────────────────────────────────────────────

describe('SUBMIT_ORDER', () => {
  it('opens the shipment and names the carrier rep', async () => {
    const { shipmentId, loadId } = await createDraft()
    await saveForm(shipmentId)
    const bundle = (await call('SUBMIT_ORDER', {
      shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
      carrierRepId: 'rep-1',
    })) as { shipment: Row }

    expect(bundle.shipment.status).toBe('OPEN')
    expect(bundle.shipment.previousStatus).toBe('DRAFT')
    expect(table(TABLES.load).get(loadId)!.status).toBe('SOURCING')
    expect(table(TABLES.load).get(loadId)!.carrierRepId).toBe('rep-1')
  })

  it('refuses when the order would push the customer past its credit limit', async () => {
    seedCustomer({ creditLimitCents: 100_000 })
    const { shipmentId } = await createDraft()
    await saveForm(shipmentId)
    await expect(
      call('SUBMIT_ORDER', {
        shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
        order: { equipmentType: "53' VAN" },
        stops: [PICKUP, DELIVERY],
      }),
    ).rejects.toThrow(/credit limit/)
  })

  it('refuses when the customer is on credit hold', async () => {
    seedCustomer({ creditHoldFlag: true })
    const { shipmentId } = await createDraft()
    await saveForm(shipmentId)
    await expect(
      call('SUBMIT_ORDER', {
        shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
        order: { equipmentType: "53' VAN" },
        stops: [PICKUP, DELIVERY],
      }),
    ).rejects.toThrow(/credit hold/)
  })

  it('refuses a mode whose editor is not built yet', async () => {
    seedCustomer({ quotingDefaults: { defaultMode: 'OCEAN' } })
    const { shipmentId } = await createDraft()
    await saveForm(shipmentId)
    await expect(
      call('SUBMIT_ORDER', {
        shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
        order: { equipmentType: "53' VAN" },
        stops: [PICKUP, DELIVERY],
      }),
    ).rejects.toThrow(/cannot be submitted yet/)
  })
})

// ── CHECK_CREDIT ─────────────────────────────────────────────────────────────

describe('CHECK_CREDIT', () => {
  it('counts an open order as exposure and reports the projected block', async () => {
    const { shipmentId } = await createDraft()
    await saveForm(shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })

    const summary = (await call('CHECK_CREDIT', { customerId: 'cus-1', projectedCents: 0 })) as {
      byBucket: Record<string, number>
      usedCents: number
      availableCents: number
      blockReasons: string[]
    }
    expect(summary.byBucket.OPEN).toBe(250_000)
    expect(summary.usedCents).toBe(250_000)
    expect(summary.availableCents).toBe(1_000_000 - 250_000)
    expect(summary.blockReasons).toEqual([])

    const projected = (await call('CHECK_CREDIT', { customerId: 'cus-1', projectedCents: 900_000 })) as {
      blockReasons: string[]
    }
    expect(projected.blockReasons).toContain('CREDIT_LIMIT_REACHED')
  })

  it('leaves a draft out of exposure entirely', async () => {
    const { shipmentId } = await createDraft()
    await saveForm(shipmentId)
    const summary = (await call('CHECK_CREDIT', { customerId: 'cus-1', projectedCents: 0 })) as { usedCents: number }
    expect(summary.usedCents).toBe(0)
  })
})

// ── Status ───────────────────────────────────────────────────────────────────

describe('status', () => {
  async function openShipment(): Promise<{ shipmentId: string; loadId: string; orderId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    return ids
  }

  it('refuses INVOICING by hand', async () => {
    const { loadId } = await openShipment()
    await expect(call('SET_LOAD_STATUS', { loadId, status: 'INVOICING' })).rejects.toThrow(/not by hand/)
  })

  it('refuses a regression down the ladder', async () => {
    const { loadId } = await openShipment()
    await call('SET_LOAD_STATUS', { loadId, status: 'BOOKED' })
    await call('SET_LOAD_STATUS', { loadId, status: 'DISPATCHED' })
    await expect(call('SET_LOAD_STATUS', { loadId, status: 'BOOKED' })).rejects.toThrow(/cannot go from DISPATCHED to BOOKED/)
  })

  it('re-derives the shipment from its loads after a load moves', async () => {
    const { loadId } = await openShipment()
    await call('SET_LOAD_STATUS', { loadId, status: 'BOOKED' })
    const bundle = (await call('SET_LOAD_STATUS', { loadId, status: 'DISPATCHED' })) as { shipment: Row }
    expect(bundle.shipment.status).toBe('DISPATCHED')
  })

  it('holds and releases without losing where the shipment was', async () => {
    const { shipmentId, loadId } = await openShipment()
    await call('SET_LOAD_STATUS', { loadId, status: 'BOOKED' })
    const held = (await call('SET_SHIPMENT_STATUS', {
      shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
      status: 'ON_HOLD',
      reason: 'customer asked us to wait',
    })) as { shipment: Row }
    expect(held.shipment.status).toBe('ON_HOLD')
    expect(held.shipment.holdReason).toBe('customer asked us to wait')

    const released = (await call('SET_SHIPMENT_STATUS', {
      shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
      status: 'OPEN',
    })) as { shipment: Row }
    expect(released.shipment.status).toBe('BOOKED')
    expect(released.shipment.holdReason).toBeNull()
  })

  it('a hold survives a load moving underneath it', async () => {
    const { shipmentId, loadId } = await openShipment()
    await call('SET_SHIPMENT_STATUS', {
      shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
      status: 'ON_HOLD',
      reason: 'awaiting appointment',
    })
    const bundle = (await call('SET_LOAD_STATUS', { loadId, status: 'BOOKED' })) as { shipment: Row }
    expect(bundle.shipment.status).toBe('ON_HOLD')
  })

  it('requires a reason to cancel, and un-cancel returns the previous status', async () => {
    const { shipmentId } = await openShipment()
    await expect(
      call('SET_SHIPMENT_STATUS', {
        shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
        status: 'CANCELED',
      }),
    ).rejects.toThrow(/cancel reason/)

    await call('SET_SHIPMENT_STATUS', {
      shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
      status: 'CANCELED',
      reason: 'customer canceled',
    })
    const back = (await call('SET_SHIPMENT_STATUS', {
      shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
      status: 'UNCANCEL',
    })) as { shipment: Row }
    expect(back.shipment.status).toBe('OPEN')
    expect(back.shipment.cancelReason).toBeNull()
  })

  it('refuses to cancel under an invoiced order, and allows it once the invoice is gone', async () => {
    const { shipmentId, orderId } = await openShipment()
    table(TABLES.order).set(orderId, {
      ...table(TABLES.order).get(orderId)!,
      arStatus: 'UNPAID',
      invoiceId: 'inv-412',
      invoiceNumber: 'INV-000412',
    })
    const cancel = (): Promise<Row> =>
      call('SET_SHIPMENT_STATUS', {
        shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
        status: 'CANCELED',
        reason: 'customer canceled',
      })
    await expect(cancel()).rejects.toThrow(/invoice INV-000412; void the invoice first/)

    table(TABLES.order).set(orderId, {
      ...table(TABLES.order).get(orderId)!,
      arStatus: 'UNBILLED',
      invoiceId: null,
      invoiceNumber: null,
    })
    const canceled = (await cancel()) as { shipment: Row }
    expect(canceled.shipment.status).toBe('CANCELED')
  })
})

// ── Delete / restore ─────────────────────────────────────────────────────────

describe('DELETE_SHIPMENT', () => {
  it('refuses a non-admin when cancel/delete is admin-only', async () => {
    seedSettings({ cancelDeleteAdminOnly: true })
    const { shipmentId } = await createDraft()
    await expect(
      call('DELETE_SHIPMENT', { shipmentId, expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt }),
    ).rejects.toThrow(/requires owner or ADMIN/)
  })

  it('soft-deletes a draft and restores it', async () => {
    seedSettings({ cancelDeleteAdminOnly: true })
    const { shipmentId } = await createDraft()
    const deleted = (await call(
      'DELETE_SHIPMENT',
      { shipmentId, expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt },
      ADMIN,
    )) as { shipment: Row }
    expect(deleted.shipment.deletedAt).toBeTruthy()

    const restored = (await call(
      'RESTORE_SHIPMENT',
      { shipmentId, expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt },
      ADMIN,
    )) as { shipment: Row }
    expect(restored.shipment.deletedAt).toBeNull()
  })

  it('refuses to delete a shipment that is moving', async () => {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    await expect(
      call('DELETE_SHIPMENT', {
        shipmentId: ids.shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      }),
    ).rejects.toThrow(/cancel it first/)
  })

  it('refuses to delete under an invoiced order, and allows it once the invoice is gone', async () => {
    const { shipmentId, orderId } = await createDraft()
    table(TABLES.order).set(orderId, {
      ...table(TABLES.order).get(orderId)!,
      arStatus: 'PAID',
      invoiceId: 'inv-501',
      invoiceNumber: 'INV-000501',
    })
    const remove = (): Promise<Row> =>
      call('DELETE_SHIPMENT', { shipmentId, expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt })
    await expect(remove()).rejects.toThrow(/invoice INV-000501; void the invoice first/)

    table(TABLES.order).set(orderId, {
      ...table(TABLES.order).get(orderId)!,
      arStatus: 'DOCS_NEEDED',
      invoiceId: null,
      invoiceNumber: null,
    })
    const deleted = (await remove()) as { shipment: Row }
    expect(deleted.shipment.deletedAt).toBeTruthy()
  })

  it('takes the shipment’s carrier legs off the AP board, and puts back the ones still owed', async () => {
    const { shipmentId, loadId } = await createDraft()
    const seedLeg = (id: string, extra: Row): void => {
      table(TABLES.carrier).set(id, {
        id, shipmentId, loadId, kind: 'CARRIER', status: 'ACTIVE',
        apStatus: 'AWAITING_INVOICE', apOpen: 'OPEN',
        apStatusChangedAt: '2026-10-01T00:00:00.000Z',
        carrierName: 'Test Carrier', createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        ...extra,
      })
    }
    seedLeg('lcr-open', {})
    seedLeg('lcr-paid', { apStatus: 'PAID', apOpen: undefined })
    seedLeg('lcr-own', { kind: 'OWN_ASSET', apStatus: undefined, apOpen: undefined })

    await call('DELETE_SHIPMENT', { shipmentId, expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt })
    // A leg nobody can reach is not work: the sparse marker leaves with the shipment,
    // and everything else on the row stays exactly where it was.
    expect(table(TABLES.carrier).get('lcr-open')!.apOpen).toBeUndefined()
    expect(table(TABLES.carrier).get('lcr-open')!.apStatus).toBe('AWAITING_INVOICE')
    expect(table(TABLES.carrier).get('lcr-open')!.updatedAt).toBe('2026-10-01T00:00:00.000Z')

    await call('RESTORE_SHIPMENT', { shipmentId, expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt })
    expect(table(TABLES.carrier).get('lcr-open')!.apOpen).toBe('OPEN')
    // Settled and own-fleet legs were never on the board and do not arrive on it now.
    expect(table(TABLES.carrier).get('lcr-paid')!.apOpen).toBeUndefined()
    expect(table(TABLES.carrier).get('lcr-own')!.apOpen).toBeUndefined()
  })
})

// ── Stops ────────────────────────────────────────────────────────────────────

describe('UPDATE_STOP', () => {
  async function draftWithStops(): Promise<{ shipmentId: string; loadId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    return ids
  }

  it('refuses to remove the only delivery', async () => {
    const { loadId } = await draftWithStops()
    await expect(
      call('UPDATE_STOP', {
        loadId,
        expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
        op: 'REMOVE',
        stopId: 'stp-de',
      }),
    ).rejects.toThrow(/at least one pickup and one delivery/)
  })

  it('adds a stop and renumbers the sequence', async () => {
    const { loadId } = await draftWithStops()
    await call('UPDATE_STOP', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      op: 'ADD',
      patch: { type: 'delivery', name: 'SECOND DROP', city: 'ST LOUIS, MO', appt: '2026-03-04T13:00:00.000Z' },
    })
    const stops = JSON.parse(String(table(TABLES.load).get(loadId)!.stops)) as Row[]
    expect(stops).toHaveLength(3)
    expect(stops.map((s) => s.sequence)).toEqual([0, 1, 2])
    expect(table(TABLES.load).get(loadId)!.destinationCity).toBe('ST LOUIS, MO')
  })

  it('advances the load from the stop clock, and never backwards', async () => {
    const { loadId } = await draftWithStops()
    await call('UPDATE_STOP', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      op: 'SET_TIMES',
      stopId: 'stp-pu',
      patch: { arrivedAt: '2026-03-02T13:05:00.000Z', departedAt: '2026-03-02T15:00:00.000Z' },
    })
    expect(table(TABLES.load).get(loadId)!.status).toBe('IN_TRANSIT')

    // Clearing the times back off does not un-drive the truck.
    await call('UPDATE_STOP', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      op: 'SET_TIMES',
      stopId: 'stp-pu',
      patch: { arrivedAt: null, departedAt: null },
    })
    expect(table(TABLES.load).get(loadId)!.status).toBe('IN_TRANSIT')
  })

  it('refuses a departure before the arrival', async () => {
    const { loadId } = await draftWithStops()
    await expect(
      call('UPDATE_STOP', {
        loadId,
        expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
        op: 'SET_TIMES',
        stopId: 'stp-pu',
        patch: { arrivedAt: '2026-03-02T15:00:00.000Z', departedAt: '2026-03-02T13:05:00.000Z' },
      }),
    ).rejects.toThrow(/departed before it was arrived/)
  })

  it('refuses a stale load', async () => {
    const { loadId } = await draftWithStops()
    await expect(
      call('UPDATE_STOP', {
        loadId,
        expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
        op: 'SET_APPT',
        stopId: 'stp-pu',
        patch: { appt: '2026-03-02T18:00:00.000Z' },
      }),
    ).rejects.toThrow(/changed by someone else/)
  })
})

// ── Assignment ───────────────────────────────────────────────────────────────

describe('assignment', () => {
  async function openLoad(): Promise<{ shipmentId: string; loadId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    return ids
  }

  it('puts the driver on every stop and books the load', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_ASSET', { loadId, driverId: 'drv-1', driverName: 'Chad', truckId: 'trk-7' })

    const load = table(TABLES.load).get(loadId)!
    expect(load.status).toBe('BOOKED')
    expect(load.assignmentType).toBe('OWN_ASSET')
    expect(load.truckId).toBe('trk-7')
    const stops = JSON.parse(String(load.stops)) as Row[]
    expect(stops.every((s) => s.driverId === 'drv-1')).toBe(true)
    expect(stops.every((s) => s.truckId === 'trk-7')).toBe(true)
    expect(load.pickupDriverId).toBe('drv-1')
  })

  it('bounces the previous assignment instead of erasing it', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_ASSET', { loadId, driverId: 'drv-1' })
    await call('ASSIGN_ASSET', { loadId, driverId: 'drv-2' })

    const carriers = [...table(TABLES.carrier).values()].filter((c) => c.loadId === loadId)
    expect(carriers).toHaveLength(2)
    const bounced = carriers.find((c) => c.status === 'BOUNCED')!
    expect(bounced.driverId).toBe('drv-1')
    expect(bounced.removalReason).toBe('REASSIGNED')
    expect(carriers.find((c) => c.status === 'ACTIVE')!.driverId).toBe('drv-2')
  })

  it('writes the carrier rate as a CARRIER linehaul line', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_CARRIER', { loadId, carrierName: 'SWIFT', carrierMc: '123456', carrierRateCents: 180_000 })

    const load = table(TABLES.load).get(loadId)!
    expect(load.assignmentType).toBe('CARRIER')
    expect(load.carrierName).toBe('SWIFT')
    const carrierLine = [...table(TABLES.charge).values()].find((c) => c.side === 'CARRIER')!
    expect(carrierLine).toMatchObject({ code: 'LINEHAUL', amountCents: 180_000, isRate: true })
  })

  it('requires a reason to take a carrier off a load', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_CARRIER', { loadId, carrierName: 'SWIFT', carrierRateCents: 180_000 })
    const carrierId = String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
    await expect(call('REMOVE_LOAD_CARRIER', { loadCarrierId: carrierId, outcome: 'BOUNCED' })).rejects.toThrow(/reason/)
  })

  it('a bounce takes the carrier charge with it; a TONU leaves it to be paid', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_CARRIER', { loadId, carrierName: 'SWIFT', carrierRateCents: 180_000 })
    const bouncedId = String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: bouncedId, outcome: 'BOUNCED', reason: 'CARRIER_CANNOT_TAKE' })
    expect([...table(TABLES.charge).values()].some((c) => c.side === 'CARRIER')).toBe(false)
    expect(table(TABLES.load).get(loadId)!.status).toBe('SOURCING')
    expect(table(TABLES.load).get(loadId)!.activeLoadCarrierId).toBeNull()

    await call('ASSIGN_CARRIER', { loadId, carrierName: 'WERNER', carrierRateCents: 190_000 })
    const tonuId = String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: tonuId, outcome: 'TONU', reason: 'CUSTOMER_NOT_READY' })
    const kept = [...table(TABLES.charge).values()].filter((c) => c.side === 'CARRIER')
    expect(kept).toHaveLength(1)
    expect(kept[0].amountCents).toBe(190_000)
  })

  it('refuses to remove an assignment twice', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_ASSET', { loadId, driverId: 'drv-1' })
    const carrierId = String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: carrierId, outcome: 'BOUNCED', reason: 'GAVE_BACK' })
    await expect(
      call('REMOVE_LOAD_CARRIER', { loadCarrierId: carrierId, outcome: 'BOUNCED', reason: 'GAVE_BACK' }),
    ).rejects.toThrow(/already been removed/)
  })
})

// ── Carrier booking (step C) ─────────────────────────────────────────────────

describe('carrier booking', () => {
  const PDF_BASE64 = Buffer.from('%PDF-1.4 rate con').toString('base64')

  async function bookableLoad(): Promise<{ shipmentId: string; loadId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    return ids
  }

  function seedCarrier(extra: Row = {}): void {
    table(TABLES.carrierDirectory).set('car-1', {
      id: 'car-1',
      __typename: 'Carrier',
      name: 'SWIFT TRANSPORTATION',
      type: 'TL',
      status: 'ACTIVE',
      authorityStatus: 'ACTIVE',
      mcNumber: '123456',
      dotNumber: '77',
      paymentTermsDays: 30,
      insurancePolicies: [
        { id: 'ins-1', type: 'AUTO_LIABILITY', limitCents: 100_000_00, expiresAt: '2030-01-01T00:00:00.000Z' },
        { id: 'ins-2', type: 'CARGO', limitCents: 100_000_00, expiresAt: '2030-01-01T00:00:00.000Z' },
      ],
      loadCount: 2,
      createdBy: 'admin@bcatcorp.com',
      updatedBy: 'admin@bcatcorp.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    })
  }

  /** The four documents the default settings require, so booking is warning-free. */
  function seedCarrierDocs(): void {
    for (const type of ['COI_CARGO', 'COI_AUTO', 'W9', 'CARRIER_AGREEMENT']) {
      table(TABLES.carrierDoc).set(`cdoc-${type}`, {
        id: `cdoc-${type}`,
        __typename: 'CarrierDocument',
        carrierId: 'car-1',
        type,
        name: `${type}.pdf`,
        s3Key: `carrier-docs/car-1/${type}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 1024,
        source: 'UPLOAD',
        uploadedBy: 'admin@bcatcorp.com',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    }
  }

  async function book(loadId: string, input: Row = {}): Promise<Row> {
    return call('BOOK_CARRIER', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      carrierId: 'car-1',
      carrierRateCents: 180_000,
      ...input,
    })
  }

  function activeCarrier(): Row {
    return [...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!
  }

  it('sends a directory carrier to BOOK_CARRIER instead of ASSIGN_CARRIER', async () => {
    const { loadId } = await bookableLoad()
    await expect(
      call('ASSIGN_CARRIER', { loadId, carrierName: 'SWIFT', carrierId: 'car-1', carrierRateCents: 180_000 }),
    ).rejects.toThrow(/BOOK_CARRIER/)
  })

  it('books the carrier, prices the linehaul and moves the load to BOOKED', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()

    await book(loadId, { quickPayDays: 7 })

    const assignment = activeCarrier()
    expect(assignment).toMatchObject({
      kind: 'CARRIER',
      carrierId: 'car-1',
      carrierName: 'SWIFT TRANSPORTATION',
      carrierMc: '123456',
      paymentTermsDays: 30,
      rateConStatus: 'NOT_SENT',
      rateConVersion: 0,
      // 7 days is the 250 bps tier: 180_000 * 250 / 10_000.
      quickPay: true,
      quickPayDays: 7,
      quickPayFeeBps: 250,
      quickPayFeeCents: 4_500,
    })
    expect(assignment.bookingWarnings).toEqual([])

    const load = table(TABLES.load).get(loadId)!
    expect(load.status).toBe('BOOKED')
    expect(load.assignmentType).toBe('CARRIER')
    expect(load.activeLoadCarrierId).toBe(assignment.id)
    expect([...table(TABLES.charge).values()].find((c) => c.side === 'CARRIER')).toMatchObject({
      code: 'LINEHAUL', amountCents: 180_000, loadCarrierId: assignment.id,
    })
    expect(table(TABLES.financials).get(loadId)!.costCents).toBe(180_000)
    // The directory keeps its own count of what it has hauled for us.
    expect(table(TABLES.carrierDirectory).get('car-1')!.loadCount).toBe(3)
  })

  it('puts the booked assignment on AP\'s worklist', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()

    await book(loadId)

    const assignment = activeCarrier()
    expect(assignment.apStatus).toBe('AWAITING_INVOICE')
    expect(assignment.apOpen).toBe('OPEN')
    expect(String(assignment.apStatusChangedAt)).toBe(String(assignment.bookedAt))
  })

  it('refuses a rate over the load\'s top spend, and leaves nothing behind', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()

    // Revenue 250_000 at a 1500 bps floor tops out at 212_500.
    await expect(book(loadId, { carrierRateCents: 230_000 })).rejects.toThrow(/top spend/)
    expect([...table(TABLES.carrier).values()]).toHaveLength(0)
    expect(table(TABLES.load).get(loadId)!.status).toBe('SOURCING')
  })

  it('refuses a carrier whose authority is inactive', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier({ authorityStatus: 'INACTIVE' })
    seedCarrierDocs()
    await expect(book(loadId)).rejects.toThrow(/operating authority is inactive/)
  })

  it('needs every warning acknowledged by key before it books', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()

    await expect(book(loadId)).rejects.toThrow(/Acknowledge these before booking/)

    const keys = ['MISSING_DOC:COI_CARGO', 'MISSING_DOC:COI_AUTO', 'MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT']
    await book(loadId, { acknowledgeWarnings: keys })
    expect(activeCarrier().bookingWarnings).toEqual(expect.arrayContaining(keys))
  })

  it('refuses to book onto a load that already has a carrier', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    await expect(book(loadId)).rejects.toThrow(/sourcing/)
  })

  it('only caches a quick-pay fee for a configured tier', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    const loadCarrierId = String(activeCarrier().id)

    await expect(call('SET_QUICK_PAY', { loadCarrierId, quickPayDays: 9 })).rejects.toThrow(/quick-pay tiers/)

    await call('SET_QUICK_PAY', { loadCarrierId, quickPayDays: 1 })
    expect(table(TABLES.carrier).get(loadCarrierId)).toMatchObject({
      quickPay: true, quickPayDays: 1, quickPayFeeBps: 300, quickPayFeeCents: 5_400,
    })

    await call('SET_QUICK_PAY', { loadCarrierId, quickPayDays: null })
    expect(table(TABLES.carrier).get(loadCarrierId)).toMatchObject({
      quickPay: false, quickPayDays: null, quickPayFeeCents: null,
    })
  })

  it('pays the rebooked carrier their own rate, not the load\'s total with the TONU on it', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()

    await book(loadId, { carrierRateCents: 60_000 })
    const first = String(activeCarrier().id)
    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: first, outcome: 'TONU', reason: 'CUSTOMER_NOT_READY' })

    await book(loadId, { carrierRateCents: 120_000 })
    const second = activeCarrier()
    expect(second.id).not.toBe(first)
    // The row the rate confirmation and the carrier portal read carries this
    // carrier's money alone — the TONU'd carrier's 60_000 is not theirs.
    expect(second).toMatchObject({ carrierRateCents: 120_000, costCents: 120_000 })
    // The load's cached totals are still the whole load's, TONU included.
    expect(table(TABLES.financials).get(loadId)).toMatchObject({ carrierRateCents: 180_000, costCents: 180_000 })

    await call('SET_QUICK_PAY', { loadCarrierId: String(second.id), quickPayDays: 1 })
    // 300 bps of 120_000, not of the load's 180_000.
    expect(table(TABLES.carrier).get(String(second.id))).toMatchObject({
      quickPay: true, quickPayFeeBps: 300, quickPayFeeCents: 3_600,
    })
  })

  it('moves the cached quick-pay fee when the rate is edited on the financials tab', async () => {
    const { shipmentId, loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId, { carrierRateCents: 180_000, quickPayDays: 7 })
    const loadCarrierId = String(activeCarrier().id)
    expect(table(TABLES.carrier).get(loadCarrierId)!.quickPayFeeCents).toBe(4_500)

    await call('RECALC_CHARGES', {
      shipmentId,
      expectedVersion: Number(table(TABLES.shipment).get(shipmentId)!.version),
      charges: [
        { side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 300_000, sortOrder: 0 },
        { side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 200_000, sortOrder: 0 },
      ],
    })

    // 250 bps of the new 200_000, and the row's own money followed the edit.
    expect(table(TABLES.carrier).get(loadCarrierId)).toMatchObject({
      carrierRateCents: 200_000, costCents: 200_000, quickPayFeeCents: 5_000,
    })
  })

  it('writes nothing when the load moves between the read and the booking transaction', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()

    // Someone else touches the load after BOOK_CARRIER read it and before its
    // transaction lands: the booking must leave no assignment behind.
    let raced = false
    send.mockImplementation(async (cmd: MockCommand) => {
      if (!raced && cmd.__type === 'Transact') {
        raced = true
        const load = table(TABLES.load).get(loadId)!
        table(TABLES.load).set(loadId, { ...load, updatedAt: '2026-04-01T00:00:00.000Z' })
      }
      return runCommand(cmd)
    })

    await expect(book(loadId)).rejects.toThrow(/changed by someone else/)
    expect([...table(TABLES.carrier).values()]).toHaveLength(0)
    expect([...table(TABLES.charge).values()].filter((c) => c.side === 'CARRIER')).toHaveLength(0)
    expect(table(TABLES.carrierDirectory).get('car-1')!.loadCount).toBe(2)
    expect(table(TABLES.load).get(loadId)!.status).toBe('SOURCING')
  })

  it('mints a token per send, and a re-send replaces the one before it', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    const loadCarrierId = String(activeCarrier().id)

    await call('SEND_RATE_CON', { loadCarrierId, pdfBase64: PDF_BASE64, to: ['dispatch@swift.com'] })
    const first = table(TABLES.carrier).get(loadCarrierId)!
    expect(first).toMatchObject({ rateConStatus: 'SENT', rateConVersion: 1, rateConSentTo: 'dispatch@swift.com' })
    expect(String(first.rateConToken)).toHaveLength(43)
    expect(s3Send).toHaveBeenCalledTimes(1)
    expect(sesSend).toHaveBeenCalledTimes(1)
    const generated = [...table(TABLES.carrierDoc).values()].filter((d) => d.type === 'RATE_CON')
    expect(generated).toHaveLength(1)
    expect(generated[0]).toMatchObject({ source: 'GENERATED', carrierId: 'car-1', loadCarrierId })

    await call('SEND_RATE_CON', { loadCarrierId, pdfBase64: PDF_BASE64, to: ['dispatch@swift.com'] })
    const second = table(TABLES.carrier).get(loadCarrierId)!
    expect(second.rateConVersion).toBe(2)
    expect(second.rateConToken).not.toBe(first.rateConToken)
  })

  it('refuses a recipient that is not an email address', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    const loadCarrierId = String(activeCarrier().id)
    await expect(
      call('SEND_RATE_CON', { loadCarrierId, pdfBase64: PDF_BASE64, to: ['dispatch@swift.com\r\nBcc: x@y.com'] }),
    ).rejects.toThrow(/email address/)
  })

  it('voids the open link without touching the assignment', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    const loadCarrierId = String(activeCarrier().id)
    await call('SEND_RATE_CON', { loadCarrierId, pdfBase64: PDF_BASE64, to: ['dispatch@swift.com'] })

    await call('VOID_RATE_CON', { loadCarrierId })
    expect(table(TABLES.carrier).get(loadCarrierId)).toMatchObject({ rateConStatus: 'VOIDED', rateConToken: null, status: 'ACTIVE' })
    await expect(call('VOID_RATE_CON', { loadCarrierId })).rejects.toThrow(/sent and not yet signed/)
  })

  it('dispatches a booked load and remembers the rate con was never signed', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    const loadCarrierId = String(activeCarrier().id)

    await call('DISPATCH_LOAD', {
      loadId,
      dispatchedAt: '2026-03-02T11:00:00.000Z',
      driverName: 'Yuri',
      truckNumber: '4471',
      nextCheckCallAt: '2026-03-02T18:00:00.000Z',
      note: 'Loaded and rolling',
    })

    const load = table(TABLES.load).get(loadId)!
    expect(load.status).toBe('DISPATCHED')
    expect(load.checkCallOpen).toBe('OPEN')
    expect(table(TABLES.carrier).get(loadCarrierId)).toMatchObject({
      dispatchedAt: '2026-03-02T11:00:00.000Z',
      dispatchNote: 'Loaded and rolling',
      driverName: 'Yuri',
      truckNumber: '4471',
      bookingWarnings: ['RATE_CON_NOT_SIGNED'],
    })
  })

  it('refuses to dispatch a load nobody is on', async () => {
    const { loadId } = await bookableLoad()
    await expect(call('DISPATCH_LOAD', { loadId, dispatchedAt: '2026-03-02T11:00:00.000Z' }))
      .rejects.toThrow(/booked load/)
  })

  it('takes the reason from the list that fits the outcome, and voids an open rate con', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    const loadCarrierId = String(activeCarrier().id)
    await call('SEND_RATE_CON', { loadCarrierId, pdfBase64: PDF_BASE64, to: ['dispatch@swift.com'] })

    // FORGOT_TO_BOUNCE is a TONU reason; a bounce may not borrow it.
    await expect(
      call('REMOVE_LOAD_CARRIER', { loadCarrierId, outcome: 'BOUNCED', reason: 'FORGOT_TO_BOUNCE' }),
    ).rejects.toThrow(/reason must be one of/)

    await call('REMOVE_LOAD_CARRIER', {
      loadCarrierId,
      outcome: 'BOUNCED',
      reason: 'REJECTED_RATE_CON',
      note: 'Driver would not sign at that rate',
    })
    expect(table(TABLES.carrier).get(loadCarrierId)).toMatchObject({
      status: 'BOUNCED',
      removalReason: 'REJECTED_RATE_CON',
      removalNote: 'Driver would not sign at that rate',
      rateConStatus: 'VOIDED',
      rateConToken: null,
    })
  })

  it('refuses a note longer than 250 characters', async () => {
    const { loadId } = await bookableLoad()
    seedCarrier()
    seedCarrierDocs()
    await book(loadId)
    const loadCarrierId = String(activeCarrier().id)
    await expect(
      call('REMOVE_LOAD_CARRIER', { loadCarrierId, outcome: 'TONU', reason: 'OTHER', note: 'x'.repeat(251) }),
    ).rejects.toThrow(/maximum length/)
  })
})

// ── RECALC_CHARGES ───────────────────────────────────────────────────────────

describe('RECALC_CHARGES', () => {
  async function priced(): Promise<{ shipmentId: string; loadId: string; orderId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    return ids
  }

  it('replaces the lines, caches the totals and mirrors Load.rate', async () => {
    const { shipmentId, loadId, orderId } = await priced()
    const version = Number(table(TABLES.shipment).get(shipmentId)!.version)
    const bundle = (await call('RECALC_CHARGES', {
      shipmentId,
      expectedVersion: version,
      charges: [
        { side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 300_000, sortOrder: 0 },
        { side: 'CUSTOMER', code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 7_500, count: 2, sortOrder: 1 },
        { side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 240_000, sortOrder: 0 },
      ],
    })) as { charges: Row[]; financials: Row[] }

    expect(bundle.charges).toHaveLength(3)
    expect(bundle.financials[0]).toMatchObject({
      customerRateCents: 300_000,
      revenueCents: 315_000,
      carrierRateCents: 240_000,
      costCents: 240_000,
      profitCents: 75_000,
    })
    expect(table(TABLES.order).get(orderId)!.revenueCents).toBe(315_000)
    expect(table(TABLES.load).get(loadId)!.rate).toBe(315_000)
  })

  it('refuses a stale version', async () => {
    const { shipmentId } = await priced()
    await expect(
      call('RECALC_CHARGES', { shipmentId, expectedVersion: 99, charges: [] }),
    ).rejects.toThrow(/changed by someone else/)
  })

  it('refuses once the financials are frozen', async () => {
    const { shipmentId, loadId } = await priced()
    const financials = table(TABLES.financials).get(loadId)!
    table(TABLES.financials).set(loadId, { ...financials, frozenAt: '2026-03-10T00:00:00.000Z', frozenBy: 'admin@bcatcorp.com' })
    await expect(
      call('RECALC_CHARGES', {
        shipmentId,
        expectedVersion: Number(table(TABLES.shipment).get(shipmentId)!.version),
        charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 1, sortOrder: 0 }],
      }),
    ).rejects.toThrow(/frozen/)
  })

  it('refuses a negative carrier rate', async () => {
    const { shipmentId } = await priced()
    await expect(
      call('RECALC_CHARGES', {
        shipmentId,
        expectedVersion: Number(table(TABLES.shipment).get(shipmentId)!.version),
        charges: [{ side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: -100, sortOrder: 0 }],
      }),
    ).rejects.toThrow(/cannot be negative/)
  })
})

// ── Carrier charges and AP state (step G) ────────────────────────────────────

describe('UPDATE_CARRIER_CHARGES', () => {
  async function assignedLoad(): Promise<{ shipmentId: string; loadId: string; loadCarrierId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    await call('ASSIGN_CARRIER', { loadId: ids.loadId, carrierName: 'SWIFT', carrierRateCents: 180_000 })
    const loadCarrierId = String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
    return { ...ids, loadCarrierId }
  }

  function carrierLines(loadCarrierId: string): Row[] {
    return [...table(TABLES.charge).values()]
      .filter((c) => c.side === 'CARRIER' && c.loadCarrierId === loadCarrierId)
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
  }

  function customerLines(): Row[] {
    return [...table(TABLES.charge).values()].filter((c) => c.side === 'CUSTOMER')
  }

  function update(loadCarrierId: string, shipmentId: string, charges: Row[]): Promise<Row> {
    return call('UPDATE_CARRIER_CHARGES', {
      loadCarrierId,
      expectedVersion: Number(table(TABLES.shipment).get(shipmentId)!.version),
      charges,
    })
  }

  it('rewrites the carrier lines, re-caches the cost and leaves the customer side alone', async () => {
    const { shipmentId, loadId, loadCarrierId } = await assignedLoad()
    const customerBefore = customerLines().map((c) => ({ ...c }))
    const lineId = String(carrierLines(loadCarrierId)[0].id)

    await update(loadCarrierId, shipmentId, [
      { id: lineId, side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 190_000, sortOrder: 0 },
      { side: 'CARRIER', code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 15_000, sortOrder: 1 },
    ])

    expect(carrierLines(loadCarrierId).map((c) => c.amountCents)).toEqual([190_000, 15_000])
    expect(customerLines()).toEqual(customerBefore)
    expect(table(TABLES.financials).get(loadId)!).toMatchObject({
      revenueCents: 250_000,
      costCents: 205_000,
      profitCents: 45_000,
    })
    // Only the rate line is the carrier's rate; detention is cost on top of it.
    expect(table(TABLES.carrier).get(loadCarrierId)!).toMatchObject({
      carrierRateCents: 190_000,
      costCents: 205_000,
    })
  })

  it('refuses once the bill is recorded, and allows it while the customer side is frozen', async () => {
    const { shipmentId, loadId, loadCarrierId } = await assignedLoad()
    const assignment = table(TABLES.carrier).get(loadCarrierId)!
    const lineId = String(carrierLines(loadCarrierId)[0].id)
    const edit = [{ id: lineId, side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 170_000, sortOrder: 0 }]

    table(TABLES.carrier).set(loadCarrierId, {
      ...assignment,
      chargesFinalizedAt: '2026-03-12T00:00:00.000Z',
      invoiceId: 'cbl-1',
    })
    await expect(update(loadCarrierId, shipmentId, edit)).rejects.toThrow(/void it first/)

    // The customer's invoice froze the customer's lines; what the carrier is owed
    // is still open until their own bill is recorded.
    table(TABLES.carrier).set(loadCarrierId, assignment)
    table(TABLES.financials).set(loadId, {
      ...table(TABLES.financials).get(loadId)!,
      frozenAt: '2026-03-12T00:00:00.000Z',
      frozenBy: 'admin@bcatcorp.com',
    })
    await update(loadCarrierId, shipmentId, edit)

    expect(table(TABLES.carrier).get(loadCarrierId)!.costCents).toBe(170_000)
    expect(table(TABLES.financials).get(loadId)!).toMatchObject({
      costCents: 170_000,
      frozenAt: '2026-03-12T00:00:00.000Z',
    })
  })

  it('refuses a customer line and a line belonging to somebody else', async () => {
    const { shipmentId, loadCarrierId } = await assignedLoad()
    const customerId = String(customerLines()[0].id)
    await expect(
      update(loadCarrierId, shipmentId, [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 1, sortOrder: 0 }]),
    ).rejects.toThrow(/must be CARRIER/)
    await expect(
      update(loadCarrierId, shipmentId, [{ id: customerId, side: 'CARRIER', code: 'LINEHAUL', rateCents: 1, sortOrder: 0 }]),
    ).rejects.toThrow(/not a line on this assignment/)
    expect(customerLines()[0].amountCents).toBe(250_000)
  })

  it('re-caches a TONU\'d assignment, which is still owed its retained line', async () => {
    const { shipmentId, loadCarrierId } = await assignedLoad()
    await call('REMOVE_LOAD_CARRIER', { loadCarrierId, outcome: 'TONU', reason: 'CUSTOMER_NOT_READY' })
    const lineId = String(carrierLines(loadCarrierId)[0].id)

    await update(loadCarrierId, shipmentId, [
      { id: lineId, side: 'CARRIER', code: 'TONU', calculatedBy: 'FLAT', rateCents: 50_000, sortOrder: 0 },
    ])

    expect(table(TABLES.carrier).get(loadCarrierId)!.costCents).toBe(50_000)
  })

  it('refuses an own-fleet leg, which is paid by settlement', async () => {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('ASSIGN_ASSET', { loadId: ids.loadId, driverId: 'drv-1' })
    const loadCarrierId = String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
    await expect(update(loadCarrierId, ids.shipmentId, [])).rejects.toThrow(/settlement/)
  })

  it('refuses a stale version', async () => {
    const { loadCarrierId } = await assignedLoad()
    await expect(
      call('UPDATE_CARRIER_CHARGES', { loadCarrierId, expectedVersion: 99, charges: [] }),
    ).rejects.toThrow(/changed by someone else/)
  })

  it('holds a finalized assignment\'s lines still against every other pricing path', async () => {
    const { shipmentId, loadCarrierId } = await assignedLoad()
    const customerId = String(customerLines()[0].id)
    const lineId = String(carrierLines(loadCarrierId)[0].id)
    table(TABLES.carrier).set(loadCarrierId, {
      ...table(TABLES.carrier).get(loadCarrierId)!,
      chargesFinalizedAt: '2026-03-12T00:00:00.000Z',
    })
    const recalc = (charges: Row[]): Promise<Row> =>
      call('RECALC_CHARGES', {
        shipmentId,
        expectedVersion: Number(table(TABLES.shipment).get(shipmentId)!.version),
        charges,
      })
    const customerLine = { id: customerId, side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 250_000, count: 1, sortOrder: 0 }
    const carrierLine = { id: lineId, side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 180_000, count: 1, sortOrder: 0, loadCarrierId }

    await expect(recalc([customerLine])).rejects.toThrow(/void it first/)
    await expect(recalc([customerLine, { ...carrierLine, rateCents: 175_000 }])).rejects.toThrow(/void it first/)
    await expect(
      recalc([customerLine, carrierLine, { side: 'CARRIER', code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 100, sortOrder: 1, loadCarrierId }]),
    ).rejects.toThrow(/void it first/)

    // The same lines, resubmitted unchanged, are not an edit.
    await recalc([customerLine, carrierLine])
    expect(carrierLines(loadCarrierId)).toHaveLength(1)
    expect(carrierLines(loadCarrierId)[0].amountCents).toBe(180_000)
  })
})

describe('AP state on an assignment', () => {
  async function openLoad(): Promise<{ shipmentId: string; loadId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    return ids
  }

  function assignment(id: string): Row {
    return table(TABLES.carrier).get(id)!
  }

  function activeId(): string {
    return String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
  }

  it('keeps an own-fleet leg out of AP entirely', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_ASSET', { loadId, driverId: 'drv-1' })

    const own = assignment(activeId())
    expect(own.apStatus).toBeUndefined()
    expect(own.apOpen).toBeUndefined()
  })

  it('takes a bounced assignment off the AP worklist and leaves a TONU\'d one on it', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_CARRIER', { loadId, carrierName: 'SWIFT', carrierRateCents: 180_000 })
    const bouncedId = activeId()
    expect(assignment(bouncedId).apOpen).toBe('OPEN')

    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: bouncedId, outcome: 'BOUNCED', reason: 'CARRIER_CANNOT_TAKE' })
    // The key has to leave the row: a NULL in an index key is refused outright.
    expect('apOpen' in assignment(bouncedId)).toBe(false)

    await call('ASSIGN_CARRIER', { loadId, carrierName: 'WERNER', carrierRateCents: 190_000 })
    const tonuId = activeId()
    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: tonuId, outcome: 'TONU', reason: 'CUSTOMER_NOT_READY' })
    expect(assignment(tonuId).apOpen).toBe('OPEN')
  })

  it('refuses to bounce an assignment that has a bill, and still allows a TONU', async () => {
    const { loadId } = await openLoad()
    await call('ASSIGN_CARRIER', { loadId, carrierName: 'SWIFT', carrierRateCents: 180_000 })
    const loadCarrierId = activeId()
    table(TABLES.carrier).set(loadCarrierId, { ...assignment(loadCarrierId), invoiceId: 'cbl-1' })

    await expect(
      call('REMOVE_LOAD_CARRIER', { loadCarrierId, outcome: 'BOUNCED', reason: 'CARRIER_CANNOT_TAKE' }),
    ).rejects.toThrow(/void the bill first/)
    expect(assignment(loadCarrierId).status).toBe('ACTIVE')

    await call('REMOVE_LOAD_CARRIER', { loadCarrierId, outcome: 'TONU', reason: 'CUSTOMER_NOT_READY' })
    expect(assignment(loadCarrierId).status).toBe('TONU')
  })

  it('refuses to cancel a shipment with a carrier bill on it', async () => {
    const { shipmentId, loadId } = await openLoad()
    await call('ASSIGN_CARRIER', { loadId, carrierName: 'SWIFT', carrierRateCents: 180_000 })
    const loadCarrierId = activeId()
    table(TABLES.carrier).set(loadCarrierId, { ...assignment(loadCarrierId), invoiceId: 'cbl-1' })

    const cancel = (): Promise<Row> =>
      call('SET_SHIPMENT_STATUS', {
        shipmentId,
        expectedUpdatedAt: table(TABLES.shipment).get(shipmentId)!.updatedAt,
        status: 'CANCELED',
        reason: 'customer canceled',
      })
    await expect(cancel()).rejects.toThrow(/SWIFT has a carrier bill/)

    table(TABLES.carrier).set(loadCarrierId, { ...assignment(loadCarrierId), invoiceId: null })
    const canceled = (await cancel()) as { shipment: Row }
    expect(canceled.shipment.status).toBe('CANCELED')
  })
})

// ── Check calls and tracking (step D) ────────────────────────────────────────

describe('check calls', () => {
  async function openLoad(): Promise<{ shipmentId: string; loadId: string; orderId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    return ids
  }

  async function trackedLoad(): Promise<{ shipmentId: string; loadId: string; orderId: string; carrierId: string }> {
    const ids = await openLoad()
    await call('ASSIGN_CARRIER', { loadId: ids.loadId, carrierName: 'SWIFT', carrierRateCents: 180_000 })
    const carrierId = String([...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!.id)
    return { ...ids, carrierId }
  }

  const stamp = (loadId: string): string => String(table(TABLES.load).get(loadId)!.updatedAt)
  const logged = (): Row[] => [...table(TABLES.checkCall).values()]
  const stopsOf = (loadId: string): Row[] => JSON.parse(String(table(TABLES.load).get(loadId)!.stops)) as Row[]

  /** The last raw UpdateItem this handler sent to the Load table. */
  function lastLoadUpdate(): UpdateSpec {
    const updates = send.mock.calls
      .map(([cmd]) => cmd as MockCommand)
      .filter((cmd) => cmd.__type === 'Update' && cmd.input.TableName === TABLES.load)
    return updates[updates.length - 1].input as unknown as UpdateSpec
  }

  it('logs where the truck is without touching the stop clock', async () => {
    const { loadId } = await trackedLoad()
    const result = (await call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T15:00:00.000Z',
      type: 'LOCATION_UPDATE',
      city: 'JOLIET',
      state: 'IL',
      lat: 41.525,
      lng: -88.081,
      personName: 'Mark at Swift',
      note: 'rolling, no delays',
    })) as { bundle: { loads: Row[] }; event: Row }

    expect(result.event).toMatchObject({
      type: 'LOCATION_UPDATE',
      source: 'MANUAL',
      note: 'rolling, no delays',
      createdBy: 'dispatch@bcatcorp.com',
      statusAfter: null,
    })
    expect(table(TABLES.load).get(loadId)).toMatchObject({
      status: 'BOOKED',
      lastCheckCallAt: '2026-03-02T15:00:00.000Z',
      lastCheckCallType: 'LOCATION_UPDATE',
      lastKnownCity: 'JOLIET',
      lastKnownState: 'IL',
      lastKnownLat: 41.525,
      lastKnownSource: 'MANUAL',
    })
    expect(stopsOf(loadId)[0].arrivedAt ?? null).toBeNull()
    // The bundle comes back fresh, so the dialog's next call has a live CAS token.
    expect(String(result.bundle.loads[0].updatedAt)).toBe(stamp(loadId))
  })

  it('stamps the stop it is told about and moves the load from the clock', async () => {
    const { loadId } = await trackedLoad()
    const result = (await call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T13:05:00.000Z',
      type: 'ARRIVED',
      stopId: 'stp-pu',
    })) as { event: Row }

    expect(result.event.id).toBe(`evt:${loadId}:stp-pu:ARRIVED`)
    expect(result.event).toMatchObject({ statusBefore: 'BOOKED', statusAfter: 'LOADING' })
    expect(stopsOf(loadId)[0].arrivedAt).toBe('2026-03-02T13:05:00.000Z')
    expect(table(TABLES.load).get(loadId)).toMatchObject({ status: 'LOADING', statusSource: 'CHECK_CALL' })
  })

  it('delivers the load and stamps when it happened', async () => {
    const { loadId } = await trackedLoad()
    await call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-03T15:00:00.000Z',
      type: 'DEPARTED',
      stopId: 'stp-de',
    })
    expect(table(TABLES.load).get(loadId)).toMatchObject({
      status: 'DELIVERED',
      deliveredAt: '2026-03-03T15:00:00.000Z',
    })
  })

  it('counts a stop event once when the driver app reported it first', async () => {
    const { loadId, shipmentId } = await trackedLoad()
    const eventId = `evt:${loadId}:stp-pu:ARRIVED`
    table(TABLES.checkCall).set(eventId, {
      id: eventId,
      loadId,
      shipmentId,
      stopId: 'stp-pu',
      at: '2026-03-02T12:55:00.000Z',
      type: 'ARRIVED',
      source: 'DRIVER_APP',
      createdBy: 'driver:drv-1',
    })

    const result = (await call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T13:30:00.000Z',
      type: 'ARRIVED',
      stopId: 'stp-pu',
      note: 'driver says he is in the door',
    })) as { event: Row }

    expect(result.event.type).toBe('LOCATION_UPDATE')
    expect(result.event.note).toBe('driver says he is in the door')
    const arrivals = logged().filter((r) => r.type === 'ARRIVED')
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]).toMatchObject({ source: 'DRIVER_APP', at: '2026-03-02T12:55:00.000Z' })
    // The first report of an arrival is the one that counts.
    expect(stopsOf(loadId)[0].arrivedAt ?? null).toBeNull()
  })

  it('refuses a row the system writes for itself', async () => {
    const { loadId } = await trackedLoad()
    await expect(call('LOG_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), at: '2026-03-02T15:00:00.000Z', type: 'DISPATCH',
    })).rejects.toThrow(/written by the system/)
  })

  it('refuses an arrival that names no stop on the load', async () => {
    const { loadId } = await trackedLoad()
    await expect(call('LOG_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), at: '2026-03-02T15:00:00.000Z', type: 'ARRIVED',
    })).rejects.toThrow(/name a stop/)
    await expect(call('LOG_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), at: '2026-03-02T15:00:00.000Z', type: 'DEPARTED', stopId: 'stp-nope',
    })).rejects.toThrow(/name a stop/)
  })

  it('refuses an incident with no incident type', async () => {
    const { loadId } = await trackedLoad()
    await expect(call('LOG_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), at: '2026-03-02T15:00:00.000Z', type: 'INCIDENT',
    })).rejects.toThrow(/incident type/)
  })

  it('refuses a check call logged from the future', async () => {
    const { loadId } = await trackedLoad()
    const future = new Date(Date.now() + 20 * 60_000).toISOString()
    await expect(call('LOG_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), at: future, type: 'NOTE',
    })).rejects.toThrow(/in the future/)
  })

  it('refuses a canceled load', async () => {
    const { loadId } = await trackedLoad()
    table(TABLES.load).set(loadId, { ...table(TABLES.load).get(loadId)!, status: 'CANCELED' })
    await expect(call('LOG_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), at: '2026-03-02T15:00:00.000Z', type: 'NOTE',
    })).rejects.toThrow(/canceled/)
  })

  it('refuses a load that is not part of a shipment', async () => {
    table(TABLES.load).set('lod-legacy', {
      id: 'lod-legacy', status: 'BOOKED', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await expect(call('LOG_CHECK_CALL', {
      loadId: 'lod-legacy',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      at: '2026-03-02T15:00:00.000Z',
      type: 'NOTE',
    })).rejects.toThrow(/not part of a shipment/)
  })

  it('refuses a load somebody else moved first', async () => {
    const { loadId } = await trackedLoad()
    await expect(call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      at: '2026-03-02T15:00:00.000Z',
      type: 'NOTE',
    })).rejects.toThrow(/changed by someone else/)
    expect(logged()).toHaveLength(0)
  })

  it('refuses incident charges once the financials are frozen', async () => {
    const { loadId } = await trackedLoad()
    const financials = table(TABLES.financials).get(loadId)!
    table(TABLES.financials).set(loadId, { ...financials, frozenAt: '2026-03-10T00:00:00.000Z' })
    await expect(call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T15:00:00.000Z',
      type: 'INCIDENT',
      incidentType: 'DETENTION',
      charges: [{ side: 'CUSTOMER', code: 'DETENTION', rateCents: 7_500 }],
    })).rejects.toThrow(/frozen/)
  })

  it('refuses a carrier charge with nobody on the load, and a negative one', async () => {
    const { loadId } = await openLoad()
    await expect(call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T15:00:00.000Z',
      type: 'INCIDENT',
      incidentType: 'DETENTION',
      charges: [{ side: 'CARRIER', code: 'DETENTION', rateCents: 7_500 }],
    })).rejects.toThrow(/active carrier/)

    const { loadId: covered } = await trackedLoad()
    await expect(call('LOG_CHECK_CALL', {
      loadId: covered,
      expectedUpdatedAt: stamp(covered),
      at: '2026-03-02T15:00:00.000Z',
      type: 'INCIDENT',
      incidentType: 'DETENTION',
      charges: [{ side: 'CARRIER', code: 'DETENTION', rateCents: -7_500 }],
    })).rejects.toThrow(/cannot be negative/)
    expect([...table(TABLES.charge).values()].filter((c) => c.code === 'DETENTION')).toHaveLength(0)
  })

  it('bills an incident on both sides and moves every cached total', async () => {
    const { loadId, orderId, carrierId } = await trackedLoad()
    const result = (await call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T18:00:00.000Z',
      type: 'INCIDENT',
      incidentType: 'DETENTION',
      note: 'three hours on the dock',
      charges: [{ side: 'BOTH', code: 'DETENTION', rateCents: 7_500, count: 3 }],
    })) as { event: Row }

    const detention = [...table(TABLES.charge).values()].filter((c) => c.code === 'DETENTION')
    expect(detention.map((c) => c.side).sort()).toEqual(['CARRIER', 'CUSTOMER'])
    expect(detention.every((c) => c.amountCents === 22_500)).toBe(true)
    expect(detention.find((c) => c.side === 'CARRIER')!.loadCarrierId).toBe(carrierId)
    expect(detention.find((c) => c.side === 'CUSTOMER')!.loadCarrierId).toBeNull()
    expect(table(TABLES.financials).get(loadId)).toMatchObject({
      revenueCents: 272_500,
      costCents: 202_500,
      carrierRateCents: 180_000,
    })
    expect(table(TABLES.order).get(orderId)!.revenueCents).toBe(272_500)
    expect(table(TABLES.load).get(loadId)).toMatchObject({ rate: 272_500, openIncidentCount: 1 })
    expect(table(TABLES.carrier).get(carrierId)!.costCents).toBe(202_500)
    expect(result.event.incidentOpen).toBe('OPEN')
    expect(result.event.charges).toHaveLength(2)
  })

  it('refuses the event and its money when the load moves under the transaction', async () => {
    const { loadId } = await trackedLoad()
    const chargesBefore = table(TABLES.charge).size
    const expectedUpdatedAt = stamp(loadId)
    // The projector stamps the same load after the handler read it. The CAS the
    // Load's own mutation carries is too late: the event row and the charge lines
    // commit first, so the guard has to be inside the transaction.
    send.mockImplementation(async (cmd: MockCommand) => {
      if (cmd.__type === 'Transact') {
        table(TABLES.load).set(loadId, {
          ...table(TABLES.load).get(loadId)!,
          updatedAt: '2026-03-02T18:00:01.000Z',
        })
      }
      return runCommand(cmd)
    })

    await expect(call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt,
      at: '2026-03-02T18:00:00.000Z',
      type: 'ARRIVED',
      stopId: 'stp-pu',
      charges: [{ side: 'BOTH', code: 'DETENTION', rateCents: 7_500, count: 3 }],
    })).rejects.toThrow(/changed by someone else/)

    const transacted = send.mock.calls
      .map(([cmd]) => cmd as MockCommand)
      .filter((cmd) => cmd.__type === 'Transact')
      .pop()!.input.TransactItems as Record<string, Record<string, unknown>>[]
    // The load's CAS is the first item, so the refusal covers the whole write.
    expect(Object.keys(transacted[0])).toEqual(['ConditionCheck'])
    const check = transacted[0].ConditionCheck as {
      TableName: string
      ExpressionAttributeValues: Record<string, { S?: string }>
    }
    expect(check.TableName).toBe(TABLES.load)
    expect(check.ExpressionAttributeValues[':casExpectedUpdatedAt'].S).toBe(expectedUpdatedAt)

    expect(logged()).toHaveLength(0)
    expect(table(TABLES.charge).size).toBe(chargesBefore)
    expect(stopsOf(loadId)[0].arrivedAt ?? null).toBeNull()
  })

  it('recounts the open incidents instead of decrementing a stale read', async () => {
    const { loadId } = await trackedLoad()
    const openIncident = async (incidentType: string, at: string): Promise<string> => {
      const { event } = (await call('LOG_CHECK_CALL', {
        loadId, expectedUpdatedAt: stamp(loadId), at, type: 'INCIDENT', incidentType,
      })) as { event: Row }
      return String(event.id)
    }
    const first = await openIncident('BREAKDOWN', '2026-03-02T18:00:00.000Z')
    const second = await openIncident('DELAY', '2026-03-02T19:00:00.000Z')
    expect(table(TABLES.load).get(loadId)!.openIncidentCount).toBe(2)

    // Both dispatchers read the load while two exceptions are open. The first is
    // held right after its REMOVE lands, so it writes the count last.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    send.mockImplementation(async (cmd: MockCommand) => {
      const holds = cmd.__type === 'Update'
        && cmd.input.TableName === TABLES.checkCall
        && JSON.stringify(cmd.input.Key).includes(first)
      const result = runCommand(cmd)
      if (holds) await held
      return result
    })

    const slow = call('RESOLVE_INCIDENT', { checkCallId: first, note: 'towed in' })
    await call('RESOLVE_INCIDENT', { checkCallId: second, note: 'roads opened' })
    release()
    await slow

    expect([...table(TABLES.checkCall).values()].filter((c) => c.incidentOpen === 'OPEN')).toHaveLength(0)
    expect(table(TABLES.load).get(loadId)!.openIncidentCount).toBe(0)
  })

  it('resolves an incident once, and refuses the second attempt', async () => {
    const { loadId } = await trackedLoad()
    const { event } = (await call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T18:00:00.000Z',
      type: 'INCIDENT',
      incidentType: 'BREAKDOWN',
      note: 'blew a steer tire',
    })) as { event: Row }
    expect(table(TABLES.load).get(loadId)!.openIncidentCount).toBe(1)

    const resolved = (await call('RESOLVE_INCIDENT', {
      checkCallId: event.id,
      note: 'back on the road at 20:00',
    })) as { event: Row }

    expect(resolved.event).toMatchObject({
      resolvedBy: 'dispatch@bcatcorp.com',
      resolutionNote: 'back on the road at 20:00',
    })
    expect('incidentOpen' in table(TABLES.checkCall).get(String(event.id))!).toBe(false)
    expect(table(TABLES.load).get(loadId)!.openIncidentCount).toBe(0)

    await expect(call('RESOLVE_INCIDENT', { checkCallId: event.id })).rejects.toThrow(/already resolved/)
    expect(table(TABLES.load).get(loadId)!.openIncidentCount).toBe(0)
  })

  it('sets the reminder, then clears it with a REMOVE rather than a stored null', async () => {
    const { loadId } = await trackedLoad()
    await call('LOG_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      at: '2026-03-02T15:00:00.000Z',
      type: 'NOTE',
      note: 'spoke to the driver',
      nextCheckCallAt: '2026-03-02T19:00:00.000Z',
      nextCheckCallNote: 'call once he clears the DC',
    })
    expect(table(TABLES.load).get(loadId)).toMatchObject({
      checkCallOpen: 'OPEN',
      nextCheckCallAt: '2026-03-02T19:00:00.000Z',
      nextCheckCallNote: 'call once he clears the DC',
    })

    // The notifier nagged for that schedule before anybody cleared it.
    table(TABLES.load).set(loadId, {
      ...table(TABLES.load).get(loadId)!,
      checkCallDueNotifiedAt: '2026-03-02T19:01:00.000Z',
    })
    await call('SET_NEXT_CHECK_CALL', { loadId, expectedUpdatedAt: stamp(loadId), nextCheckCallAt: null })

    const load = table(TABLES.load).get(loadId)!
    expect('checkCallOpen' in load).toBe(false)
    expect('nextCheckCallAt' in load).toBe(false)
    expect('nextCheckCallNote' in load).toBe(false)
    expect('checkCallDueNotifiedAt' in load).toBe(false)
    const update = lastLoadUpdate()
    expect(update.UpdateExpression).toMatch(/REMOVE\b[^]*#checkCallOpen/)
    expect(JSON.stringify(update.ExpressionAttributeValues)).not.toContain('NULL')
  })

  it('re-arms the notifier when the reminder is moved', async () => {
    const { loadId } = await trackedLoad()
    await call('SET_NEXT_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), nextCheckCallAt: '2026-03-02T19:00:00.000Z',
    })
    table(TABLES.load).set(loadId, {
      ...table(TABLES.load).get(loadId)!,
      checkCallDueNotifiedAt: '2026-03-02T19:01:00.000Z',
      checkCallOverdueNotifiedAt: '2026-03-02T19:16:00.000Z',
    })

    await call('SET_NEXT_CHECK_CALL', {
      loadId, expectedUpdatedAt: stamp(loadId), nextCheckCallAt: '2026-03-02T23:00:00.000Z', note: 'snoozed',
    })
    const load = table(TABLES.load).get(loadId)!
    expect(load).toMatchObject({
      checkCallOpen: 'OPEN',
      nextCheckCallAt: '2026-03-02T23:00:00.000Z',
      nextCheckCallNote: 'snoozed',
    })
    expect('checkCallDueNotifiedAt' in load).toBe(false)
    expect('checkCallOverdueNotifiedAt' in load).toBe(false)
  })

  it('refuses a reminder on a load somebody else moved first', async () => {
    const { loadId } = await trackedLoad()
    await expect(call('SET_NEXT_CHECK_CALL', {
      loadId, expectedUpdatedAt: '2020-01-01T00:00:00.000Z', nextCheckCallAt: null,
    })).rejects.toThrow(/changed by someone else/)
  })

  it('records the ETA the carrier gave, and refuses one from a carrier off the load', async () => {
    const { loadId, carrierId } = await trackedLoad()
    const result = (await call('SET_ETA', {
      loadCarrierId: carrierId,
      expectedUpdatedAt: String(table(TABLES.carrier).get(carrierId)!.updatedAt),
      deliveryEtaAt: '2026-03-03T12:00:00.000Z',
      note: 'running two hours early',
    })) as { event: Row }

    expect(result.event).toMatchObject({
      type: 'ETA_UPDATE',
      source: 'SYSTEM',
      loadId,
      deliveryEtaAt: '2026-03-03T12:00:00.000Z',
      createdBy: 'dispatch@bcatcorp.com',
    })
    expect(table(TABLES.carrier).get(carrierId)!.deliveryEtaAt).toBe('2026-03-03T12:00:00.000Z')

    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: carrierId, outcome: 'BOUNCED', reason: 'GAVE_BACK' })
    await expect(call('SET_ETA', {
      loadCarrierId: carrierId,
      expectedUpdatedAt: String(table(TABLES.carrier).get(carrierId)!.updatedAt),
      deliveryEtaAt: '2026-03-03T14:00:00.000Z',
    })).rejects.toThrow(/currently on the load/)
  })

  it('logs the stop event a dispatcher types in, and never over the driver app', async () => {
    const { loadId, shipmentId } = await trackedLoad()
    await call('UPDATE_STOP', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      op: 'SET_TIMES',
      stopId: 'stp-pu',
      patch: { arrivedAt: '2026-03-02T13:05:00.000Z', departedAt: '2026-03-02T15:00:00.000Z' },
    })
    expect(logged().map((r) => String(r.id)).sort()).toEqual([
      `evt:${loadId}:stp-pu:ARRIVED`,
      `evt:${loadId}:stp-pu:DEPARTED`,
    ])
    expect(logged().every((r) => r.source === 'MANUAL')).toBe(true)

    // The projector got to the delivery first; the staff edit must not overwrite it.
    const eventId = `evt:${loadId}:stp-de:ARRIVED`
    table(TABLES.checkCall).set(eventId, {
      id: eventId, loadId, shipmentId, stopId: 'stp-de',
      at: '2026-03-03T11:00:00.000Z', type: 'ARRIVED', source: 'DRIVER_APP', createdBy: 'driver:drv-1',
    })
    await call('UPDATE_STOP', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      op: 'SET_TIMES',
      stopId: 'stp-de',
      patch: { arrivedAt: '2026-03-03T11:30:00.000Z' },
    })
    expect(table(TABLES.checkCall).get(eventId)).toMatchObject({
      source: 'DRIVER_APP',
      at: '2026-03-03T11:00:00.000Z',
    })
    expect(logged()).toHaveLength(3)
  })

  it('opens the tracking log when the load is dispatched', async () => {
    const { loadId } = await trackedLoad()
    await call('DISPATCH_LOAD', {
      loadId,
      dispatchedAt: '2026-03-02T11:00:00.000Z',
      nextCheckCallAt: '2026-03-02T15:00:00.000Z',
      nextCheckCallNote: 'first call after the yard',
    })
    expect(logged()).toHaveLength(1)
    expect(logged()[0]).toMatchObject({
      type: 'DISPATCH',
      source: 'SYSTEM',
      at: '2026-03-02T11:00:00.000Z',
      statusAfter: 'DISPATCHED',
      nextCheckCallAt: '2026-03-02T15:00:00.000Z',
    })
    expect(table(TABLES.load).get(loadId)).toMatchObject({
      status: 'DISPATCHED',
      checkCallOpen: 'OPEN',
    })
  })

  it('revokes the carrier ping link when the carrier comes off the load', async () => {
    const { loadId, shipmentId, carrierId } = await trackedLoad()
    table(TABLES.trackingLink).set('tok-1', {
      id: 'tok-1',
      kind: 'CARRIER_PING',
      status: 'ACTIVE',
      shipmentId,
      loadId,
      loadCarrierId: carrierId,
      expiresAt: '2026-03-10T00:00:00.000Z',
      createdBy: 'dispatch@bcatcorp.com',
    })
    table(TABLES.carrier).set(carrierId, {
      ...table(TABLES.carrier).get(carrierId)!,
      trackingLinkId: 'tok-1',
      trackingStartedAt: '2026-03-01T00:00:00.000Z',
    })

    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: carrierId, outcome: 'BOUNCED', reason: 'GAVE_BACK' })

    expect(table(TABLES.trackingLink).get('tok-1')).toMatchObject({
      status: 'REVOKED',
      revokedBy: 'dispatch@bcatcorp.com',
    })
    expect(table(TABLES.trackingLink).get('tok-1')!.revokedAt).toBeTruthy()
    const carrier = table(TABLES.carrier).get(carrierId)!
    expect(carrier.trackingLinkId).toBeNull()
    expect(carrier.trackingStoppedAt).toBeTruthy()
  })

  it('disarms the check-call reminder when the carrier comes off the load', async () => {
    const { loadId, carrierId } = await trackedLoad()
    await call('SET_NEXT_CHECK_CALL', {
      loadId,
      expectedUpdatedAt: stamp(loadId),
      nextCheckCallAt: '2026-03-02T19:00:00.000Z',
      note: 'call once he clears the DC',
    })
    table(TABLES.load).set(loadId, {
      ...table(TABLES.load).get(loadId)!,
      checkCallDueNotifiedAt: '2026-03-02T19:01:00.000Z',
      checkCallOverdueNotifiedAt: '2026-03-02T19:16:00.000Z',
    })

    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: carrierId, outcome: 'BOUNCED', reason: 'GAVE_BACK' })

    const load = table(TABLES.load).get(loadId)!
    expect(load.status).toBe('SOURCING')
    expect('checkCallOpen' in load).toBe(false)
    expect('nextCheckCallAt' in load).toBe(false)
    expect('nextCheckCallNote' in load).toBe(false)
    expect('checkCallDueNotifiedAt' in load).toBe(false)
    expect('checkCallOverdueNotifiedAt' in load).toBe(false)
    // Cleared through the REMOVE path; a stored NULL breaks the sparse GSI key.
    const update = lastLoadUpdate()
    expect(update.UpdateExpression).toMatch(/REMOVE\b[^]*#checkCallOpen/)
    expect(JSON.stringify(update.ExpressionAttributeValues)).not.toContain('NULL')
  })
})

// ── SET_AR_STATUS ────────────────────────────────────────────────────────────

describe('SET_AR_STATUS', () => {
  async function deliverable(): Promise<{ shipmentId: string; orderId: string; loadId: string }> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    return ids
  }

  it('refuses UNBILLED before the shipment is delivered', async () => {
    const { orderId } = await deliverable()
    await expect(call('SET_AR_STATUS', { orderId, status: 'UNBILLED' })).rejects.toThrow(/once it is delivered/)
  })

  it('allows UNBILLED once delivered', async () => {
    const { shipmentId, orderId, loadId } = await deliverable()
    for (const status of ['BOOKED', 'DISPATCHED', 'LOADING', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
      await call('SET_LOAD_STATUS', { loadId, status })
    }
    expect(table(TABLES.shipment).get(shipmentId)!.status).toBe('DELIVERED')
    const bundle = (await call('SET_AR_STATUS', { orderId, status: 'UNBILLED' })) as { orders: Row[] }
    expect(bundle.orders[0].arStatus).toBe('UNBILLED')
    expect(bundle.orders[0].readyToInvoiceAt).toBeTruthy()
  })

  it('allows UNBILLED early when the order says to bill early', async () => {
    const { orderId } = await deliverable()
    const order = table(TABLES.order).get(orderId)!
    table(TABLES.order).set(orderId, { ...order, invoiceEarly: true })
    const bundle = (await call('SET_AR_STATUS', { orderId, status: 'UNBILLED' })) as { orders: Row[] }
    expect(bundle.orders[0].arStatus).toBe('UNBILLED')
    expect(table(TABLES.shipment).get(String(table(TABLES.order).get(orderId)!.shipmentId))!.status).not.toBe('DELIVERED')
  })

  it('refuses INVOICE_NOT_NEEDED while the order has revenue', async () => {
    const { orderId } = await deliverable()
    await expect(call('SET_AR_STATUS', { orderId, status: 'INVOICE_NOT_NEEDED' })).rejects.toThrow(/still needs an invoice/)
  })

  it('refuses UNPAID and PAID outright', async () => {
    const { orderId } = await deliverable()
    await expect(call('SET_AR_STATUS', { orderId, status: 'UNPAID' })).rejects.toThrow(/recorded by invoicing/)
    await expect(call('SET_AR_STATUS', { orderId, status: 'PAID' })).rejects.toThrow(/recorded by invoicing/)
  })

  it('refuses LEGACY, which only the backfill writes', async () => {
    const { orderId } = await deliverable()
    await expect(call('SET_AR_STATUS', { orderId, status: 'LEGACY' })).rejects.toThrow(
      /recorded by invoicing, not set by hand/,
    )
  })

  it('refuses any hand-set once the order carries an invoice', async () => {
    const { orderId } = await deliverable()
    table(TABLES.order).set(orderId, {
      ...table(TABLES.order).get(orderId)!,
      arStatus: 'UNPAID',
      invoiceId: 'inv-123',
      invoiceNumber: 'INV-000123',
    })
    await expect(call('SET_AR_STATUS', { orderId, status: 'DOCS_NEEDED' })).rejects.toThrow(
      /invoice INV-000123; void the invoice first/,
    )
  })

  it('still allows DOCS_NEEDED on an order with no invoice', async () => {
    const { orderId } = await deliverable()
    const bundle = (await call('SET_AR_STATUS', { orderId, status: 'DOCS_NEEDED' })) as { orders: Row[] }
    expect(bundle.orders[0].arStatus).toBe('DOCS_NEEDED')
  })
})

// ── Documents and the AR gate (step E) ───────────────────────────────────────

interface DocIds {
  shipmentId: string
  orderId: string
  loadId: string
}

interface Prepared {
  uploadUrl: string
  s3Key: string
  documentId: string
}

const PDF_BASE64 = Buffer.from('%PDF-1.4 a generated document').toString('base64')

describe('documents', () => {
  /** A shipment that has actually delivered, which is where paperwork arrives. */
  async function delivered(): Promise<DocIds> {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    for (const status of ['BOOKED', 'DISPATCHED', 'LOADING', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
      await call('SET_LOAD_STATUS', { loadId: ids.loadId, status })
    }
    return ids
  }

  async function prepare(shipmentId: string, overrides: Row = {}): Promise<Prepared> {
    return (await call('PREPARE_DOCUMENT_UPLOAD', {
      shipmentId,
      type: 'POD',
      name: 'pod.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      ...overrides,
    })) as unknown as Prepared
  }

  function commit(ids: DocIds, prepared: Prepared, overrides: Row = {}): Promise<Row> {
    return call('COMMIT_DOCUMENT', {
      shipmentId: ids.shipmentId,
      documentId: prepared.documentId,
      s3Key: prepared.s3Key,
      type: 'POD',
      name: 'pod.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      orderId: ids.orderId,
      ...overrides,
    })
  }

  /** The driver app's own rows: a submission and the page it carries. */
  function seedDriverPod(loadId: string, submissionId: string, docId: string, extra: Row = {}): void {
    table(TABLES.driverSubmission).set(submissionId, {
      id: submissionId,
      driverId: 'drv-1',
      driverName: 'Ivan',
      loadId,
      combinedPodKey: `driver-docs/drv-1/${submissionId}/pod-combined.pdf`,
      podReviewStatus: 'APPROVED',
      createdAt: '2026-03-03T18:00:00.000Z',
      ...extra,
    })
    table(TABLES.driverSubmissionDoc).set(docId, {
      id: docId,
      submissionId,
      driverId: 'drv-1',
      kind: 'POD',
      s3Key: `driver-docs/drv-1/${submissionId}/pod-1.jpg`,
      fileName: 'pod-1.jpg',
      contentType: 'image/jpeg',
      byteSize: 2048,
      uploadedAt: '2026-03-03T18:00:00.000Z',
    })
  }

  /** A carrier's upload exactly as the portal files it: ACTIVE, and waiting for a person. */
  function seedPortalUpload(ids: DocIds, overrides: Row = {}): void {
    const id = String(overrides.id ?? 'sdoc-portal')
    table(TABLES.shipmentDocument).set(id, {
      id,
      __typename: 'ShipmentDocument',
      shipmentId: ids.shipmentId,
      orderId: ids.orderId,
      type: 'OTHER',
      name: 'scan.pdf',
      s3Key: `shipment-docs/${ids.shipmentId}/${id}-scan.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 10,
      source: 'CARRIER_PORTAL',
      audience: 'ALL',
      status: 'ACTIVE',
      version: 1,
      reviewStatus: 'PENDING',
      uploadedBy: 'link:abcd1234',
      uploadedAt: '2026-03-04T00:00:00.000Z',
      createdBy: 'link:abcd1234',
      ...overrides,
    })
  }

  it('binds the upload URL to the content type and the exact length', async () => {
    const ids = await delivered()
    const prepared = await prepare(ids.shipmentId)
    expect(prepared.uploadUrl).toBe('https://signed.example/upload')
    const calls = getSignedUrl.mock.calls
    const [, command, options] = calls[calls.length - 1] as [unknown, { input: Row }, Row]
    expect(command.input).toMatchObject({ ContentType: 'application/pdf', ContentLength: 1024 })
    // `content-type` is unsignable by default, so naming it here is the whole reason
    // the URL cannot be reused to drop something else in the bucket.
    expect(options).toEqual({ expiresIn: 300, signableHeaders: new Set(['content-type']) })
  })

  it('refuses a key that belongs to a different shipment', async () => {
    const ids = await delivered()
    const prepared = await prepare(ids.shipmentId)
    const foreign = `shipment-docs/shp-someone-else/${prepared.documentId}-pod.pdf`
    putS3Object(foreign, { ContentLength: 1024, ContentType: 'application/pdf' })
    await expect(commit(ids, { ...prepared, s3Key: foreign })).rejects.toThrow(/does not belong to this shipment/)
  })

  it('refuses a commit the bytes do not back up', async () => {
    const ids = await delivered()
    const prepared = await prepare(ids.shipmentId)
    // Nothing uploaded yet: the client is told to come back, not that it failed.
    await expect(commit(ids, prepared)).rejects.toThrow(/has not landed in S3 yet/)
    putS3Object(prepared.s3Key, { ContentLength: 999, ContentType: 'application/pdf' })
    await expect(commit(ids, prepared)).rejects.toThrow(/size mismatch/)
    putS3Object(prepared.s3Key, { ContentLength: 1024, ContentType: 'image/png' })
    await expect(commit(ids, prepared)).rejects.toThrow(/content type mismatch/)
    expect(table(TABLES.shipmentDocument).size).toBe(0)
  })

  it('lists one row when the same upload is committed twice', async () => {
    const ids = await delivered()
    const prepared = await prepare(ids.shipmentId)
    putS3Object(prepared.s3Key, { ContentLength: 1024, ContentType: 'application/pdf' })

    const first = (await commit(ids, prepared)) as { document: Row }
    // A retried commit mints a new document id; the key is what identifies the file.
    const second = (await commit(ids, { ...prepared, documentId: 'sdoc-retry' })) as {
      document: Row
      bundle: { documents: Row[] }
    }
    expect(second.document.id).toBe(first.document.id)
    expect(second.bundle.documents).toHaveLength(1)
    expect(table(TABLES.shipmentDocument).size).toBe(1)
  })

  it('re-caches what the order still needs in the same write', async () => {
    seedCustomer({ requiredDocsForInvoice: ['POD', 'BOL'] })
    const ids = await delivered()
    const prepared = await prepare(ids.shipmentId)
    putS3Object(prepared.s3Key, { ContentLength: 1024, ContentType: 'application/pdf' })
    await commit(ids, prepared)

    const order = table(TABLES.order).get(ids.orderId)!
    expect(order.docsRequired).toEqual(['POD', 'BOL'])
    expect(order.docsMissing).toEqual(['BOL'])
    expect(order.docsCheckedAt).toBeTruthy()
  })

  it('supersedes exactly the previous version of a generated document', async () => {
    const ids = await delivered()
    const save = (): Promise<Row> =>
      call('SAVE_GENERATED_DOCUMENT', {
        shipmentId: ids.shipmentId,
        type: 'BOL',
        loadId: ids.loadId,
        pdfBase64: PDF_BASE64,
        filename: 'bol.pdf',
      })

    const v1 = (await save()) as { document: Row }
    const v2 = (await save()) as { document: Row }
    const v3 = (await save()) as { document: Row; bundle: { documents: Row[] } }

    expect(v3.document.version).toBe(3)
    expect(v3.document.supersedesId).toBe(v2.document.id)
    const rows = v3.bundle.documents
    expect(rows.filter((d) => d.status === 'ACTIVE').map((d) => d.id)).toEqual([v3.document.id])
    expect(rows.find((d) => d.id === v1.document.id)!.status).toBe('SUPERSEDED')
    expect(rows.find((d) => d.id === v2.document.id)!.status).toBe('SUPERSEDED')
  })

  it('refuses a driver document filed against another load, and attaches once', async () => {
    const ids = await delivered()
    seedDriverPod('lod-somewhere-else', 'dsb-1', 'dsd-1')
    await expect(
      call('ATTACH_DRIVER_DOC', {
        shipmentId: ids.shipmentId,
        loadId: ids.loadId,
        submissionDocId: 'dsd-1',
        type: 'POD',
      }),
    ).rejects.toThrow(/different load/)

    seedDriverPod(ids.loadId, 'dsb-2', 'dsd-2')
    const attach = (): Promise<Row> =>
      call('ATTACH_DRIVER_DOC', {
        shipmentId: ids.shipmentId,
        loadId: ids.loadId,
        submissionDocId: 'dsd-2',
        type: 'POD',
      })
    const first = (await attach()) as { document: Row }
    expect(first.document.id).toBe('drv:dsd-2')
    // The merged PDF, not the page it was built from, and never copied.
    expect(first.document.s3Key).toBe('driver-docs/drv-1/dsb-2/pod-combined.pdf')
    expect(first.document.reviewStatus).toBeUndefined()

    const second = (await attach()) as { document: Row; bundle: { documents: Row[] } }
    expect(second.document.id).toBe('drv:dsd-2')
    expect(second.bundle.documents).toHaveLength(1)
  })

  it('refuses a POD the driver was asked to replace', async () => {
    const ids = await delivered()
    seedDriverPod(ids.loadId, 'dsb-3', 'dsd-3', { podReviewStatus: 'NEEDS_REPLACEMENT' })
    await expect(
      call('ATTACH_DRIVER_DOC', {
        shipmentId: ids.shipmentId,
        loadId: ids.loadId,
        submissionDocId: 'dsd-3',
        type: 'POD',
      }),
    ).rejects.toThrow(/replacement/)
  })

  /**
   * The decision the whole portal rests on: a carrier's upload satisfies nothing
   * until a person accepts it, and voiding it puts the requirement straight back.
   */
  it('moves the gate only once a portal upload is accepted, and back when it is voided', async () => {
    seedCustomer({ requiredDocsForInvoice: ['POD'] })
    const ids = await delivered()
    seedPortalUpload(ids)

    // A carrier labelling their POD "other" is the common case, so accepting retypes.
    const reviewed = (await call('REVIEW_DOCUMENT', {
      documentId: 'sdoc-portal',
      decision: 'ACCEPT',
      type: 'POD',
    })) as { document: Row }
    expect(reviewed.document.reviewStatus).toBe('ACCEPTED')
    expect(table(TABLES.order).get(ids.orderId)!.docsMissing).toEqual([])

    // Nobody but an admin may take somebody else's upload off the shipment.
    await expect(call('VOID_DOCUMENT', { documentId: 'sdoc-portal', reason: 'wrong load' })).rejects.toThrow(
      /filed the document/,
    )
    const voided = (await call('VOID_DOCUMENT', { documentId: 'sdoc-portal', reason: 'wrong load' }, ADMIN)) as {
      document: Row
    }
    expect(voided.document.status).toBe('VOID')
    expect(voided.document.reviewStatus).toBe('ACCEPTED')
    expect(table(TABLES.order).get(ids.orderId)!.docsMissing).toEqual(['POD'])
  })

  /**
   * The review worklist is the sparse reviewStatus index and does not filter on
   * status, so a junk upload voided while still PENDING would otherwise sit in
   * dispatch's queue and in the sidebar badge forever.
   */
  it('takes a voided upload out of the pending review set', async () => {
    const ids = await delivered()
    seedPortalUpload(ids)

    const voided = (await call('VOID_DOCUMENT', { documentId: 'sdoc-portal', reason: 'junk scan' }, ADMIN)) as {
      document: Row
    }
    expect(voided.document.status).toBe('VOID')
    expect(voided.document.reviewStatus).toBe('REJECTED')
    expect(voided.document.voidReason).toBe('junk scan')
    const stored = [...table(TABLES.shipmentDocument).values()]
    expect(stored.filter((doc) => doc.reviewStatus === 'PENDING')).toEqual([])
  })

  it('refuses to review a document that is no longer active', async () => {
    const ids = await delivered()
    seedPortalUpload(ids, { id: 'sdoc-void', status: 'VOID', voidReason: 'filed on the wrong shipment' })
    await expect(call('REVIEW_DOCUMENT', { documentId: 'sdoc-void', decision: 'ACCEPT' })).rejects.toThrow(
      /active document/,
    )
    expect(table(TABLES.shipmentDocument).get('sdoc-void')!.reviewStatus).toBe('PENDING')
  })

  /**
   * Every page of a merged submission resolves to the same combined PDF, so a
   * three-page POD must still be one row pointing at one file.
   */
  it('files a merged POD once however many pages it was built from', async () => {
    const ids = await delivered()
    seedDriverPod(ids.loadId, 'dsb-4', 'dsd-4')
    // The submission's second page: another driver row, the same merged PDF.
    table(TABLES.driverSubmissionDoc).set('dsd-5', {
      ...table(TABLES.driverSubmissionDoc).get('dsd-4')!,
      id: 'dsd-5',
      s3Key: 'driver-docs/drv-1/dsb-4/pod-2.jpg',
      fileName: 'pod-2.jpg',
    })
    const attach = (submissionDocId: string): Promise<Row> =>
      call('ATTACH_DRIVER_DOC', { shipmentId: ids.shipmentId, loadId: ids.loadId, submissionDocId, type: 'POD' })

    const first = (await attach('dsd-4')) as { document: Row }
    const second = (await attach('dsd-5')) as { document: Row; bundle: { documents: Row[] } }
    expect(second.document.id).toBe(first.document.id)
    expect(second.bundle.documents).toHaveLength(1)
    expect(table(TABLES.shipmentDocument).size).toBe(1)
  })
})

describe('READY_TO_INVOICE', () => {
  async function deliveredOrder(customer: Row = {}): Promise<DocIds> {
    seedCustomer(customer)
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    for (const status of ['BOOKED', 'DISPATCHED', 'LOADING', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
      await call('SET_LOAD_STATUS', { loadId: ids.loadId, status })
    }
    return ids
  }

  function ready(orderId: string, extra: Row = {}, identity: unknown = DISPATCHER): Promise<Row> {
    return call(
      'READY_TO_INVOICE',
      { orderId, expectedUpdatedAt: table(TABLES.order).get(orderId)!.updatedAt, ...extra },
      identity,
    )
  }

  it('names the paperwork it is still waiting on', async () => {
    const { orderId } = await deliveredOrder({ requiredDocsForInvoice: ['POD', 'BOL'] })
    await expect(ready(orderId)).rejects.toThrow(/Proof of delivery, Bill of lading/)
    expect(table(TABLES.order).get(orderId)!.arStatus).toBe('DOCS_NEEDED')
  })

  it('overrides only for an admin, and only with a note', async () => {
    const { orderId } = await deliveredOrder({ requiredDocsForInvoice: ['POD'] })
    await expect(ready(orderId, { override: true, overrideNote: 'bills on the BOL' })).rejects.toThrow(
      /owner or ADMIN/,
    )
    await expect(ready(orderId, { override: true }, ADMIN)).rejects.toThrow(/needs a note/)

    const result = (await ready(orderId, { override: true, overrideNote: 'bills on the BOL' }, ADMIN)) as {
      bundle: { orders: Row[] }
      gate: { missing: string[] }
    }
    expect(result.gate.missing).toEqual(['POD'])
    const saved = result.bundle.orders[0]
    expect(saved.arStatus).toBe('UNBILLED')
    expect(saved.docsOverrideBy).toBe('admin@bcatcorp.com')
    expect(saved.docsOverrideNote).toBe('bills on the BOL')
  })

  it('writes what SET_AR_STATUS writes, plus the gate it checked', async () => {
    const { orderId } = await deliveredOrder()
    const before = table(TABLES.order).get(orderId)!
    const result = (await ready(orderId)) as { bundle: { orders: Row[] } }

    const saved = result.bundle.orders[0]
    expect(saved.arStatus).toBe('UNBILLED')
    expect(saved.arStatusChangedAt).toBeTruthy()
    expect(saved.readyToInvoiceAt).toBeTruthy()
    expect(saved.updatedBy).toBe('dispatch@bcatcorp.com')
    expect(saved.version).toBe(Number(before.version ?? 1) + 1)
    expect(saved.docsMissing).toEqual([])
    expect(saved.docsCheckedAt).toBeTruthy()
    expect(saved.docsOverrideAt).toBeUndefined()
  })

  it('refuses an order that is not waiting on documents', async () => {
    const { orderId } = await deliveredOrder()
    await ready(orderId)
    await expect(ready(orderId)).rejects.toThrow(/already UNBILLED/)
  })
})

// ── DUPLICATE_SHIPMENT ───────────────────────────────────────────────────────

describe('DUPLICATE_SHIPMENT', () => {
  it('copies the plan but not the truck or the stop clock', async () => {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await call('SUBMIT_ORDER', {
      shipmentId: ids.shipmentId,
      expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
      order: { equipmentType: "53' VAN" },
      stops: [PICKUP, DELIVERY],
    })
    await call('ASSIGN_ASSET', { loadId: ids.loadId, driverId: 'drv-1', truckId: 'trk-7' })

    const result = (await call('DUPLICATE_SHIPMENT', {
      shipmentId: ids.shipmentId,
      copies: [{ pickupAppt: '2026-03-09T13:00:00.000Z', deliveryAppt: '2026-03-10T13:00:00.000Z' }],
    })) as { shipment: Row }

    // The answer is the source shipment's own bundle; the copies are new rows.
    expect(result.shipment.id).toBe(ids.shipmentId)
    const copies = [...table(TABLES.shipment).values()].filter((s) => s.id !== ids.shipmentId)
    expect(copies).toHaveLength(1)
    const copy = copies[0]
    expect(copy.status).toBe('DRAFT')
    expect(copy.source).toBe('DUPLICATE')
    expect(copy.number).not.toBe(table(TABLES.shipment).get(ids.shipmentId)!.number)

    const copiedLoad = [...table(TABLES.load).values()].find((l) => l.shipmentId === copy.id)!
    expect(copiedLoad.status).toBe('SOURCING')
    const stops = JSON.parse(String(copiedLoad.stops)) as Row[]
    expect(stops.map((s) => s.appt)).toEqual(['2026-03-09T13:00:00.000Z', '2026-03-10T13:00:00.000Z'])
    expect(stops.every((s) => s.driverId === null && s.arrivedAt === null)).toBe(true)
  })

  it('credit-checks the whole batch, not one copy', async () => {
    seedCustomer({ creditLimitCents: 600_000 })
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await expect(
      call('DUPLICATE_SHIPMENT', {
        shipmentId: ids.shipmentId,
        copies: [{}, {}, {}],
      }),
    ).rejects.toThrow(/credit limit/)
  })

  it('refuses more copies than the cap', async () => {
    const ids = await createDraft()
    await saveForm(ids.shipmentId)
    await expect(
      call('DUPLICATE_SHIPMENT', { shipmentId: ids.shipmentId, copies: new Array(21).fill({}) }),
    ).rejects.toThrow(/at most 20/)
  })
})

// ── Audit ────────────────────────────────────────────────────────────────────

describe('audit log', () => {
  it('records a row for a write action and none for a read', async () => {
    await call('CREATE_SHIPMENT', { customerId: 'cus-1' })
    const rows = [...table(TABLES.audit).values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entityType: 'SHIPMENT', action: 'CREATE_SHIPMENT', user: 'dispatch@bcatcorp.com' })

    await call('CHECK_CREDIT', { customerId: 'cus-1', projectedCents: 0 })
    expect([...table(TABLES.audit).values()]).toHaveLength(1)
  })
})

// ── BACKFILL_SHIPMENT ────────────────────────────────────────────────────────

describe('BACKFILL_SHIPMENT', () => {
  function seedLegacyLoad(id: string, extra: Row = {}): Row {
    const load: Row = {
      id,
      aljexId: '14589',
      tmsId: '14589',
      pickupNumber: 'PU-1',
      customer: 'BATORY FOODS',
      customerId: 'cus-1',
      rate: 185_000,
      readyToInvoice: false,
      originCity: 'CHICAGO, IL',
      destinationCity: 'KANSAS CITY, MO',
      pickupAppt: '2026-02-10T13:00:00.000Z',
      deliveryAppt: '2026-02-11T13:00:00.000Z',
      stops: JSON.stringify([
        { ...PICKUP, appt: '2026-02-10T13:00:00.000Z', driverId: 'drv-1' },
        { ...DELIVERY, appt: '2026-02-11T13:00:00.000Z', driverId: 'drv-1' },
      ]),
      createdBy: 'legacy',
      updatedBy: 'legacy',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      ...extra,
    }
    table(TABLES.load).set(id, load)
    return load
  }

  beforeEach(() => {
    table(TABLES.driver).set('drv-1', { id: 'drv-1', name: 'Chad', type: 'owner_operator', active: true })
    table(TABLES.driver).set('drv-broker', { id: 'drv-broker', name: 'BROKER NEED TO COVER', type: 'broker', active: true })
  })

  it('refuses a non-admin', async () => {
    seedLegacyLoad('lod-legacy')
    await expect(call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'] })).rejects.toThrow(/requires owner or ADMIN/)
  })

  it('plans without writing by default', async () => {
    seedLegacyLoad('lod-legacy')
    const report = (await call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'] }, ADMIN)) as {
      dryRun: boolean
      applied: number
      planned: Row[]
    }
    expect(report.dryRun).toBe(true)
    expect(report.applied).toBe(0)
    expect(report.planned[0]).toMatchObject({ number: 'L14589', loadStatus: 'BOOKED', assignmentType: 'OWN_ASSET' })
    expect(table(TABLES.shipment).size).toBe(0)
    expect(table(TABLES.load).get('lod-legacy')!.shipmentId).toBeUndefined()
  })

  it('writes the shipment, order, financials, linehaul line, carrier row and load patch', async () => {
    seedLegacyLoad('lod-legacy')
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'], dryRun: false }, ADMIN)

    const shipment = [...table(TABLES.shipment).values()][0]
    expect(shipment).toMatchObject({
      number: 'L14589',
      source: 'BACKFILL',
      status: 'BOOKED',
      customerId: 'cus-1',
      originCity: 'CHICAGO, IL',
      pickupMonth: '2026-02',
    })
    const order = [...table(TABLES.order).values()][0]
    expect(order).toMatchObject({ revenueCents: 185_000, arStatus: 'DOCS_NEEDED', shipmentId: shipment.id })
    expect([...table(TABLES.financials).values()][0]).toMatchObject({ revenueCents: 185_000, costCents: 0 })
    expect([...table(TABLES.charge).values()][0]).toMatchObject({ side: 'CUSTOMER', code: 'LINEHAUL', amountCents: 185_000 })
    expect([...table(TABLES.carrier).values()][0]).toMatchObject({ kind: 'OWN_ASSET', status: 'ACTIVE', driverId: 'drv-1' })

    const load = table(TABLES.load).get('lod-legacy')!
    expect(load).toMatchObject({
      shipmentId: shipment.id,
      orderId: order.id,
      leg: 1,
      loadNumber: 'L14589-1',
      status: 'BOOKED',
      statusSource: 'BACKFILL',
      assignmentType: 'OWN_ASSET',
    })
  })

  it('re-running changes nothing', async () => {
    seedLegacyLoad('lod-legacy')
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'], dryRun: false }, ADMIN)
    const first = JSON.stringify([...table(TABLES.shipment).values()])

    const again = (await call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'], dryRun: false }, ADMIN)) as {
      applied: number
      skipped: { loadId: string; reason: string }[]
    }
    expect(again.applied).toBe(0)
    expect(again.skipped).toEqual([{ loadId: 'lod-legacy', reason: 'ALREADY_LINKED' }])
    expect(table(TABLES.shipment).size).toBe(1)
    expect(JSON.stringify([...table(TABLES.shipment).values()])).toBe(first)
  })

  it('points a load whose link was erased back at its surviving shipment, without a second one', async () => {
    // A Load table refreshed from production: the freight is back as it was, the
    // shipmentId/orderId/customerId a previous run wrote are gone, the Shipment,
    // Order and own-asset leg it wrote are still there.
    seedLegacyLoad('lod-legacy')
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'], dryRun: false }, ADMIN)
    const shipmentsBefore = JSON.stringify([...table(TABLES.shipment).values()])
    const ordersBefore = JSON.stringify([...table(TABLES.order).values()])
    const legsBefore = JSON.stringify([...table(TABLES.carrier).values()])
    const linked = table(TABLES.load).get('lod-legacy')!
    const { shipmentId, orderId, loadNumber, activeLoadCarrierId } = linked
    seedLegacyLoad('lod-legacy', { customerId: null, customer: 'SOME SHIPPER WE NEVER ADDED' })

    const plan = (await call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'] }, ADMIN)) as {
      planned: { relink: boolean; skipped: string | null; customerId: string | null }[]
    }
    expect(plan.planned[0]).toMatchObject({ relink: true, skipped: null, customerId: 'cus-1' })

    const report = (await call('BACKFILL_SHIPMENT', { loadIds: ['lod-legacy'], dryRun: false }, ADMIN)) as {
      applied: number
      skipped: unknown[]
    }
    expect(report).toMatchObject({ applied: 1, skipped: [] })
    expect(table(TABLES.shipment).size).toBe(1)
    expect(JSON.stringify([...table(TABLES.shipment).values()])).toBe(shipmentsBefore)
    expect(JSON.stringify([...table(TABLES.order).values()])).toBe(ordersBefore)
    expect(JSON.stringify([...table(TABLES.carrier).values()])).toBe(legsBefore)
    expect(table(TABLES.load).get('lod-legacy')).toMatchObject({
      shipmentId, orderId, loadNumber, activeLoadCarrierId, assignmentType: 'OWN_ASSET',
    })
  })

  it('leaves a broker pseudo-driver load needing cover, with no carrier row', async () => {
    seedLegacyLoad('lod-broker', {
      stops: JSON.stringify([
        { ...PICKUP, appt: '2026-02-10T13:00:00.000Z', driverId: 'drv-broker' },
        { ...DELIVERY, appt: '2026-02-11T13:00:00.000Z', driverId: 'drv-broker' },
      ]),
    })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-broker'], dryRun: false }, ADMIN)
    expect(table(TABLES.load).get('lod-broker')!.assignmentType).toBe('NEED_TO_COVER')
    expect(table(TABLES.load).get('lod-broker')!.activeLoadCarrierId).toBeNull()
    expect(table(TABLES.carrier).size).toBe(0)
  })

  it('derives the status from the stop clock, not from the appointments', async () => {
    seedLegacyLoad('lod-moving', {
      stops: JSON.stringify([
        { ...PICKUP, appt: '2026-02-10T13:00:00.000Z', driverId: 'drv-1', arrivedAt: '2026-02-10T13:10:00.000Z', departedAt: '2026-02-10T15:00:00.000Z' },
        { ...DELIVERY, appt: '2026-02-11T13:00:00.000Z', driverId: 'drv-1' },
      ]),
    })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-moving'], dryRun: false }, ADMIN)
    expect(table(TABLES.load).get('lod-moving')!.status).toBe('IN_TRANSIT')
    expect([...table(TABLES.shipment).values()][0].status).toBe('IN_TRANSIT')
  })

  it('marks a ready-to-invoice load delivered and unbilled, never paid', async () => {
    seedLegacyLoad('lod-ready', { readyToInvoice: true })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-ready'], dryRun: false }, ADMIN)
    expect(table(TABLES.load).get('lod-ready')!.status).toBe('DELIVERED')
    expect([...table(TABLES.order).values()][0].arStatus).toBe('UNBILLED')
  })

  it('marks a delivered load that nobody cleared as still needing docs', async () => {
    seedLegacyLoad('lod-delivered', {
      stops: JSON.stringify([
        { ...PICKUP, appt: '2026-02-10T13:00:00.000Z', driverId: 'drv-1', departedAt: '2026-02-10T15:00:00.000Z' },
        { ...DELIVERY, appt: '2026-02-11T13:00:00.000Z', driverId: 'drv-1', arrivedAt: '2026-02-11T13:05:00.000Z', departedAt: '2026-02-11T14:00:00.000Z' },
      ]),
    })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-delivered'], dryRun: false }, ADMIN)
    expect(table(TABLES.load).get('lod-delivered')!.status).toBe('DELIVERED')
    expect([...table(TABLES.order).values()][0].arStatus).toBe('DOCS_NEEDED')
  })

  it('sources an unassigned load and opens its shipment', async () => {
    seedLegacyLoad('lod-open', {
      stops: JSON.stringify([
        { ...PICKUP, appt: '2026-02-10T13:00:00.000Z', driverId: null },
        { ...DELIVERY, appt: '2026-02-11T13:00:00.000Z', driverId: null },
      ]),
    })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-open'], dryRun: false }, ADMIN)
    expect(table(TABLES.load).get('lod-open')!.status).toBe('SOURCING')
    expect([...table(TABLES.shipment).values()][0].status).toBe('OPEN')
  })

  it('writes zero financials and no charge line for a load with no rate', async () => {
    seedLegacyLoad('lod-norate', { rate: null })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-norate'], dryRun: false }, ADMIN)
    expect([...table(TABLES.financials).values()][0]).toMatchObject({ revenueCents: 0, marginBps: 0 })
    expect(table(TABLES.charge).size).toBe(0)
  })

  it('reports load ids that are not there instead of failing the batch', async () => {
    seedLegacyLoad('lod-legacy')
    const report = (await call(
      'BACKFILL_SHIPMENT',
      { loadIds: ['lod-legacy', 'lod-gone'], dryRun: false },
      ADMIN,
    )) as { applied: number; missing: string[] }
    expect(report.applied).toBe(1)
    expect(report.missing).toEqual(['lod-gone'])
  })

  it('matches a legacy load with no customerId to the customer by name', async () => {
    seedCustomer({ id: 'cus-midwest', name: 'Midwest Grocers, Inc.' })
    seedLegacyLoad('lod-byname', { customerId: null, customer: 'MIDWEST GROCERS' })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-byname'], dryRun: false }, ADMIN)
    expect([...table(TABLES.shipment).values()][0].customerId).toBe('cus-midwest')
    expect([...table(TABLES.order).values()][0].customerId).toBe('cus-midwest')
  })

  it('matches on an alias as well as on the name', async () => {
    seedCustomer({ id: 'cus-midwest', name: 'Midwest Grocers', aliases: ['Midwest Ingredients LLC'] })
    seedLegacyLoad('lod-alias', { customerId: null, customer: 'MIDWEST INGREDIENTS' })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-alias'], dryRun: false }, ADMIN)
    expect([...table(TABLES.shipment).values()][0].customerId).toBe('cus-midwest')
  })

  it('skips a load whose customer name matches nobody instead of writing an empty key', async () => {
    seedCustomer({ id: 'cus-midwest', name: 'Midwest Grocers' })
    seedLegacyLoad('lod-nocust', { customerId: null, customer: 'SOME SHIPPER WE NEVER ADDED' })
    const report = (await call('BACKFILL_SHIPMENT', { loadIds: ['lod-nocust'], dryRun: false }, ADMIN)) as {
      applied: number
      skipped: { loadId: string; reason: string }[]
    }
    expect(report.applied).toBe(0)
    expect(report.skipped).toEqual([{ loadId: 'lod-nocust', reason: 'NO_CUSTOMER_MATCH' }])
    expect(table(TABLES.shipment).size).toBe(0)
    expect(table(TABLES.load).get('lod-nocust')!.shipmentId).toBeUndefined()
  })

  it('refuses to guess when two customers answer to the same name', async () => {
    seedCustomer({ id: 'cus-a', name: 'Midwest Grocers' })
    seedCustomer({ id: 'cus-b', name: 'Midwest Grocers LLC' })
    seedLegacyLoad('lod-ambig', { customerId: null, customer: 'MIDWEST GROCERS' })
    const report = (await call('BACKFILL_SHIPMENT', { loadIds: ['lod-ambig'], dryRun: false }, ADMIN)) as {
      skipped: { loadId: string; reason: string }[]
    }
    expect(report.skipped).toEqual([{ loadId: 'lod-ambig', reason: 'NO_CUSTOMER_MATCH' }])
  })

  it('ignores an archived customer when matching by name', async () => {
    seedCustomer({ id: 'cus-dead', name: 'Midwest Grocers', status: 'ARCHIVED' })
    seedLegacyLoad('lod-archived', { customerId: null, customer: 'MIDWEST GROCERS' })
    const report = (await call('BACKFILL_SHIPMENT', { loadIds: ['lod-archived'], dryRun: false }, ADMIN)) as {
      skipped: { loadId: string; reason: string }[]
    }
    expect(report.skipped).toEqual([{ loadId: 'lod-archived', reason: 'NO_CUSTOMER_MATCH' }])
  })

  it('omits the appointment keys entirely for an undated load', async () => {
    seedLegacyLoad('lod-undated', {
      pickupAppt: '',
      deliveryAppt: '',
      stops: JSON.stringify([
        { ...PICKUP, appt: '', driverId: 'drv-1' },
        { ...DELIVERY, appt: '', driverId: 'drv-1' },
      ]),
    })
    await call('BACKFILL_SHIPMENT', { loadIds: ['lod-undated'], dryRun: false }, ADMIN)

    const shipment = [...table(TABLES.shipment).values()][0]
    expect('pickupAppt' in shipment).toBe(false)
    expect('deliveryAppt' in shipment).toBe(false)
    expect('pickupMonth' in shipment).toBe(false)
    expect('pickupAppt' in [...table(TABLES.order).values()][0]).toBe(false)
    expect(table(TABLES.load).get('lod-undated')!.shipmentId).toBe(shipment.id)
  })

  it('refuses a batch bigger than the cap', async () => {
    await expect(
      call('BACKFILL_SHIPMENT', { loadIds: new Array(51).fill('lod-legacy') }, ADMIN),
    ).rejects.toThrow(/at most 50/)
  })
})

// ── Quotes, offers and lane history (step H) ─────────────────────────────────

const QUOTER = {
  sub: 'sub-quote',
  username: 'quoter',
  claims: { email: 'quotes@bcatcorp.com', 'cognito:groups': ['page-quotes'] },
}

/** One priced customer line: $2,500 of line haul, which is the quote's whole number. */
const QUOTE_LINES = [{ side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 250_000, count: 1 }]

function quoteRow(id: string): Row {
  return table(TABLES.quote).get(id)!
}

function quotesOf(): Row[] {
  return [...table(TABLES.quote).values()]
}

async function newQuote(input: Row = {}, identity: unknown = QUOTER): Promise<Row> {
  const saved = (await call('SAVE_QUOTE', {
    customerId: 'cus-1',
    contactEmail: 'traffic@batory.test',
    stops: [PICKUP, DELIVERY],
    equipmentType: "53' VAN",
    mode: 'FTL',
    lines: QUOTE_LINES,
    ...input,
  }, identity)) as { quote: Row }
  return saved.quote
}

/** Save and send, which is the only way a quote ever gets a link. */
async function sentQuote(input: Row = {}, identity: unknown = QUOTER): Promise<Row> {
  const quote = await newQuote(input, identity)
  const sent = (await call('SEND_QUOTE', {
    quoteId: quote.id,
    expectedVersion: quote.version,
    to: ['traffic@batory.test'],
  }, identity)) as { quote: Row }
  return sent.quote
}

/** A carrier with its authority, its insurance and its paperwork: no findings at all. */
function seedBookableCarrier(id = 'car-1', extra: Row = {}): void {
  table(TABLES.carrierDirectory).set(id, {
    id,
    __typename: 'Carrier',
    name: id === 'car-1' ? 'SWIFT TRANSPORTATION' : 'KNIGHT REFRIGERATED',
    type: 'TL',
    status: 'ACTIVE',
    authorityStatus: 'ACTIVE',
    mcNumber: '123456',
    dispatcherEmail: `dispatch@${id}.test`,
    paymentTermsDays: 30,
    insurancePolicies: [
      { id: 'ins-1', type: 'AUTO_LIABILITY', limitCents: 100_000_00, expiresAt: '2030-01-01T00:00:00.000Z' },
      { id: 'ins-2', type: 'CARGO', limitCents: 100_000_00, expiresAt: '2030-01-01T00:00:00.000Z' },
    ],
    createdBy: 'admin@bcatcorp.com',
    updatedBy: 'admin@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  })
  for (const type of ['COI_CARGO', 'COI_AUTO', 'W9', 'CARRIER_AGREEMENT']) {
    table(TABLES.carrierDoc).set(`cdoc-${id}-${type}`, {
      id: `cdoc-${id}-${type}`,
      __typename: 'CarrierDocument',
      carrierId: id,
      type,
      name: `${type}.pdf`,
      s3Key: `carrier-docs/${id}/${type}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 1024,
      source: 'UPLOAD',
      uploadedBy: 'admin@bcatcorp.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  }
}

/** A submitted shipment with one sourcing leg — what an offer request is about. */
async function sourcingLoad(): Promise<{ shipmentId: string; loadId: string; orderId: string }> {
  const ids = await createDraft()
  await saveForm(ids.shipmentId)
  await call('SUBMIT_ORDER', {
    shipmentId: ids.shipmentId,
    expectedUpdatedAt: table(TABLES.shipment).get(ids.shipmentId)!.updatedAt,
    order: { equipmentType: "53' VAN" },
    stops: [PICKUP, DELIVERY],
  })
  return ids
}

describe('SAVE_QUOTE', () => {
  it('mints the number once on create and the next one on the next quote', async () => {
    const first = await newQuote()
    expect(first.id).toBe('Q000001')
    expect(first).toMatchObject({
      side: 'SELL',
      status: 'DRAFT',
      quoteOpen: 'OPEN',
      amountCents: 250_000,
      rounds: 0,
      version: 1,
      laneKey: 'CHICAGO|IL>KANSAS CITY|MO',
    })
    // The composite open-board index needs both keys, so an unsent quote carries a
    // clock that never strikes rather than none at all.
    expect(first.expiresAt).toBe('9999-12-31T23:59:59.999Z')
    expect(first.linkToken).toBeUndefined()

    // An edit is the same row, the same number and no visit to the counter.
    await call('SAVE_QUOTE', { quoteId: 'Q000001', expectedVersion: 1, miles: 510 }, QUOTER)
    expect(quotesOf()).toHaveLength(1)
    expect(quoteRow('Q000001')).toMatchObject({ miles: 510, version: 2 })
    expect(table(TABLES.settings).get('default')!.nextQuoteNumber).toBe(1)

    expect((await newQuote()).id).toBe('Q000002')
  })

  it('lands an intake at REQUESTED instead of DRAFT', async () => {
    expect((await newQuote({ intake: true })).status).toBe('REQUESTED')
  })

  it('carries no customerId at all on a quote nobody has named a customer for', async () => {
    // An intake off the e-mail agent or a prospect somebody is pricing blind: a
    // supported quote, and `customerId` is a GSI hash key, so it is absent rather
    // than NULL — on the create, on the edit after it and on a duplicate of it.
    const intake = (await call('SAVE_QUOTE', {
      intake: true,
      contactEmail: 'traffic@prospect.test',
      stops: [PICKUP, DELIVERY],
      lines: QUOTE_LINES,
    }, QUOTER)) as { quote: Row }
    expect(intake.quote.status).toBe('REQUESTED')
    expect(intake.quote.customerId).toBeUndefined()
    expect(quoteRow('Q000001').customerId).toBeUndefined()

    await call('SAVE_QUOTE', { quoteId: 'Q000001', expectedVersion: 1, miles: 510 }, QUOTER)
    expect(quoteRow('Q000001')).toMatchObject({ miles: 510, version: 2 })
    expect(quoteRow('Q000001').customerId).toBeUndefined()

    const copied = (await call('DUPLICATE_QUOTE', { quoteId: 'Q000001' }, QUOTER)) as { quotes: Row[] }
    expect(copied.quotes[0].customerId).toBeUndefined()
    expect(quoteRow(String(copied.quotes[0].id)).customerId).toBeUndefined()
  })

  it('refuses an edit once the number has gone out', async () => {
    const quote = await sentQuote()
    await expect(
      call('SAVE_QUOTE', { quoteId: quote.id, expectedVersion: quote.version, miles: 10 }, QUOTER),
    ).rejects.toThrow(/QUOTED quote can no longer be edited/)
  })

  it('refuses an edit against a stale version', async () => {
    const quote = await newQuote()
    await expect(
      call('SAVE_QUOTE', { quoteId: quote.id, expectedVersion: 9, miles: 10 }, QUOTER),
    ).rejects.toThrow(/changed by someone else/)
  })
})

describe('SEND_QUOTE', () => {
  it('writes QUOTED, the token, the clock and the lead stage in one go', async () => {
    seedCustomer({ status: 'NEW' })
    const quote = await newQuote()
    const before = Date.now()
    const result = (await call('SEND_QUOTE', {
      quoteId: quote.id,
      expectedVersion: quote.version,
      to: ['traffic@batory.test'],
    }, QUOTER)) as { quote: Row; link: string; sent: boolean; subject: string; body: string }

    const row = quoteRow(String(quote.id))
    expect(row.status).toBe('QUOTED')
    expect(String(row.linkToken)).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(row.linkVersion).toBe(1)
    expect(row.sendCount).toBe(1)
    expect(row.sentTo).toBe('traffic@batory.test')
    // The customer's own hours are unset, so the org's 24 apply.
    const hours = (Date.parse(String(row.expiresAt)) - before) / 3_600_000
    expect(hours).toBeGreaterThan(23.9)
    expect(hours).toBeLessThan(24.1)

    expect(result.sent).toBe(true)
    expect(result.link).toBe(`https://portal.test/quote/${String(row.linkToken)}`)
    expect(result.body).toContain(result.link)
    expect(row.lastSendStatus).toBe('SENT')
    // A lead that has been quoted is no longer merely contacted.
    expect(table(TABLES.customer).get('cus-1')!.status).toBe('QUOTED')
  })

  it('keeps the token and reports the failure when SES refuses', async () => {
    sesSend.mockRejectedValueOnce(new Error('AccessDenied'))
    const quote = await newQuote()
    const result = (await call('SEND_QUOTE', {
      quoteId: quote.id,
      expectedVersion: quote.version,
      to: ['traffic@batory.test'],
    }, QUOTER)) as { sent: boolean; link: string }

    expect(result.sent).toBe(false)
    expect(result.link).toContain('/quote/')
    const row = quoteRow(String(quote.id))
    expect(row.status).toBe('QUOTED')
    expect(row.linkToken).toBeTruthy()
    expect(row.lastSendStatus).toBe('NOT_SENT')
  })

  it('leaves the lead stage alone once the customer is active', async () => {
    const quote = await sentQuote()
    expect(quoteRow(String(quote.id)).status).toBe('QUOTED')
    expect(table(TABLES.customer).get('cus-1')!.status).toBe('ACTIVE')
  })

  it('keeps the buy target an operator typed through the send and the counter', async () => {
    // The customer's 2,000 bps default would price the target at $2,000; the
    // operator decided $1,900 is what this one may be bought for, and a re-price
    // of what we sell has no opinion about that.
    const quote = await newQuote({ targetBuyCents: 190_000, topSpendCents: 205_000 })
    expect(quote).toMatchObject({ targetBuyCents: 190_000, topSpendCents: 205_000 })

    await call('SEND_QUOTE', {
      quoteId: quote.id, expectedVersion: quote.version, to: ['traffic@batory.test'],
    }, QUOTER)
    expect(quoteRow(String(quote.id))).toMatchObject({ targetBuyCents: 190_000, topSpendCents: 205_000 })

    // Their counter, then ours: the override survives that re-price too.
    table(TABLES.quote).set(String(quote.id), {
      ...quoteRow(String(quote.id)), status: 'RECEIVED_COUNTER', counterCents: 230_000, counterBy: 'THEM',
    })
    await call('COUNTER_QUOTE', { quoteId: quote.id, amountCents: 245_000 }, QUOTER)
    expect(quoteRow(String(quote.id))).toMatchObject({ targetBuyCents: 190_000, topSpendCents: 205_000 })
  })

  it('refuses to send a quote that has already been won', async () => {
    const quote = await sentQuote()
    await call('CONVERT_QUOTE', { quoteId: quote.id, expectedVersion: quoteRow(String(quote.id)).version }, QUOTER)
    await expect(
      call('SEND_QUOTE', { quoteId: quote.id, to: ['traffic@batory.test'] }, QUOTER),
    ).rejects.toThrow(/WON quote cannot be sent/)
  })

  it('refuses a below-floor send for a rep and allows it for an admin who acknowledges', async () => {
    // $2,500 sold against a $2,400 buy is 400 bps, under the 1,500 bps floor.
    const belowFloor = [
      ...QUOTE_LINES,
      { side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 240_000, count: 1 },
    ]
    const quote = await newQuote({ lines: belowFloor })
    const send = (identity: unknown, acknowledgeWarnings?: string[]): Promise<Row> =>
      call('SEND_QUOTE', {
        quoteId: quote.id,
        to: ['traffic@batory.test'],
        ...(acknowledgeWarnings ? { acknowledgeWarnings } : {}),
      }, identity)

    await expect(send(QUOTER)).rejects.toThrow(/Acknowledge these before sending/)
    // Ticking a finding nobody but an admin may overrule does not make it theirs.
    await expect(send(QUOTER, ['BELOW_MARGIN_FLOOR'])).rejects.toThrow(/Only an admin can send/)
    expect(quoteRow(String(quote.id)).status).toBe('DRAFT')

    await send(ADMIN, ['BELOW_MARGIN_FLOOR'])
    const row = quoteRow(String(quote.id))
    expect(row.status).toBe('QUOTED')
    expect(row.pricingWarnings).toEqual(['BELOW_MARGIN_FLOOR'])
  })
})

describe('COUNTER_QUOTE and ACCEPT_COUNTER', () => {
  /** What the public `respond` leaves behind: their number, and no token. */
  function theyCountered(id: string, counterCents: number): void {
    const row = quoteRow(id)
    delete row.linkToken
    table(TABLES.quote).set(id, {
      ...row,
      status: 'RECEIVED_COUNTER',
      counterCents,
      counterBy: 'THEM',
      response: 'COUNTERED',
    })
  }

  it('rotates the token and counts the round', async () => {
    const quote = await sentQuote()
    const firstToken = String(quoteRow(String(quote.id)).linkToken)
    theyCountered(String(quote.id), 230_000)

    await call('COUNTER_QUOTE', {
      quoteId: quote.id,
      amountCents: 245_000,
      to: ['traffic@batory.test'],
    }, QUOTER)

    const row = quoteRow(String(quote.id))
    expect(row.status).toBe('SENT_COUNTER')
    expect(row.amountCents).toBe(245_000)
    expect(row.rounds).toBe(1)
    expect(row.linkVersion).toBe(2)
    expect(String(row.linkToken)).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(row.linkToken).not.toBe(firstToken)
  })

  it('refuses to counter a quote nobody has answered', async () => {
    const quote = await sentQuote()
    await expect(
      call('COUNTER_QUOTE', { quoteId: quote.id, amountCents: 245_000 }, QUOTER),
    ).rejects.toThrow(/has nothing to counter/)
  })

  it('refuses to accept a carrier\'s counter, which is money we pay', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const logged = (await call('LOG_OFFER', { loadId, carrierId: 'car-1', amountCents: 190_000 })) as { quote: Row }
    const quoteId = String(logged.quote.id)
    table(TABLES.quote).set(quoteId, {
      ...quoteRow(quoteId), status: 'RECEIVED_COUNTER', counterCents: 182_500, counterBy: 'THEM',
    })

    await expect(
      call('ACCEPT_COUNTER', { quoteId }, QUOTER),
    ).rejects.toThrow(/Use ACCEPT_OFFER to book a carrier counter/)
    // No invented CUSTOMER line, and the offer is still the carrier's to answer.
    expect(quoteRow(quoteId)).toMatchObject({ status: 'RECEIVED_COUNTER', amountCents: 190_000 })
  })

  it('absorbs their number into the line haul so the lines still sum to it', async () => {
    const withFuel = [
      ...QUOTE_LINES,
      { side: 'CUSTOMER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1_500, count: 1 },
    ]
    const quote = await sentQuote({ lines: withFuel })
    expect(quoteRow(String(quote.id)).amountCents).toBe(287_500)
    theyCountered(String(quote.id), 230_000)

    await call('ACCEPT_COUNTER', { quoteId: quote.id }, QUOTER)

    const row = quoteRow(String(quote.id))
    expect(row.status).toBe('RECEIVED_REPLY')
    expect(row.acceptedVia).toBe('EMAIL')
    expect(row.amountCents).toBe(230_000)
    expect(row.linkToken).toBeUndefined()
    // Only the line haul moved; the fuel line still rides on it at 15%.
    const lines = row.lines as { code: string; rateCents: number }[]
    const linehaul = lines.find((line) => line.code === 'LINEHAUL')!.rateCents
    expect(lines.find((line) => line.code === 'FSC')!.rateCents).toBe(1_500)
    expect(linehaul + Math.round((linehaul * 1_500) / 10_000)).toBe(230_000)
  })
})

describe('quote rungs that close and reopen', () => {
  it('marks a quote lost and takes it off the open board', async () => {
    const quote = await sentQuote()
    await call('MARK_QUOTE_LOST', { quoteId: quote.id, reason: 'TOO_HIGH', note: 'Beat by $200' }, QUOTER)

    const row = quoteRow(String(quote.id))
    expect(row).toMatchObject({ status: 'LOST', lostReason: 'TOO_HIGH', lostNote: 'Beat by $200' })
    expect(row.quoteOpen).toBeUndefined()
    expect(row.linkToken).toBeUndefined()
  })

  it('restores a lost quote to QUOTED without resurrecting its link', async () => {
    const quote = await sentQuote()
    const token = quoteRow(String(quote.id)).linkToken
    await call('MARK_QUOTE_LOST', { quoteId: quote.id, reason: 'TOO_SLOW' }, QUOTER)
    await call('RESTORE_QUOTE', { quoteId: quote.id }, QUOTER)

    const row = quoteRow(String(quote.id))
    expect(row).toMatchObject({ status: 'QUOTED', quoteOpen: 'OPEN', lostReason: null })
    expect(row.linkToken).toBeUndefined()
    expect(row.linkToken).not.toBe(token)
    expect(row.expiresAt).toBe('9999-12-31T23:59:59.999Z')
  })

  it('refuses to close a quote twice', async () => {
    const quote = await newQuote()
    await call('CANCEL_QUOTE', { quoteId: quote.id }, QUOTER)
    await expect(call('CANCEL_QUOTE', { quoteId: quote.id }, QUOTER)).rejects.toThrow(/already CANCELED/)
  })
})

describe('SWEEP_EXPIRED_QUOTES', () => {
  it('expires only the lapsed sent quotes, and says so once', async () => {
    const lapsed = await sentQuote()
    const draft = await newQuote()
    const live = await sentQuote()
    table(TABLES.quote).set(String(lapsed.id), {
      ...quoteRow(String(lapsed.id)),
      expiresAt: '2020-01-01T00:00:00.000Z',
    })

    expect(await call('SWEEP_EXPIRED_QUOTES', {}, QUOTER)).toEqual({ expired: 1 })
    const row = quoteRow(String(lapsed.id))
    expect(row).toMatchObject({ status: 'LOST', lostReason: 'EXPIRED' })
    expect(row.quoteOpen).toBeUndefined()
    expect(row.linkToken).toBeUndefined()
    // A draft's never-striking clock is not a lapsed one, and a live quote is live.
    expect(quoteRow(String(draft.id)).status).toBe('DRAFT')
    expect(quoteRow(String(live.id)).status).toBe('QUOTED')

    // Idempotent: the second sweep finds nothing left to close.
    expect(await call('SWEEP_EXPIRED_QUOTES', {}, QUOTER)).toEqual({ expired: 0 })
  })

  it('loses the race to a customer who answered, rather than overwriting them', async () => {
    const quote = await sentQuote()
    table(TABLES.quote).set(String(quote.id), {
      ...quoteRow(String(quote.id)),
      expiresAt: '2020-01-01T00:00:00.000Z',
    })
    // The public `respond` lands in the window between the sweep's Query and its
    // write, which is exactly what the update's condition exists for: the sweep's
    // own in-memory filter has already decided this row is expirable.
    send.mockImplementation(async (cmd: MockCommand) => {
      const result = runCommand(cmd)
      if (cmd.__type === 'Query' && String(cmd.input.TableName) === TABLES.quote) {
        table(TABLES.quote).set(String(quote.id), {
          ...quoteRow(String(quote.id)),
          status: 'RECEIVED_REPLY',
          response: 'ACCEPTED',
        })
      }
      return result
    })

    expect(await call('SWEEP_EXPIRED_QUOTES', {}, QUOTER)).toEqual({ expired: 0 })
    const row = quoteRow(String(quote.id))
    expect(row).toMatchObject({ status: 'RECEIVED_REPLY', response: 'ACCEPTED' })
    expect(row.lostReason).toBeUndefined()
  })
})

describe('DUPLICATE_QUOTE', () => {
  it('copies the freight without the conversation and scores the exposure', async () => {
    const quote = await sentQuote()
    const result = (await call('DUPLICATE_QUOTE', {
      quoteId: quote.id,
      count: 2,
      pickupAppts: ['2026-04-06T13:00:00.000Z'],
    }, QUOTER)) as { quotes: Row[]; exposure: { projectedCents: number; creditLimitCents: number; overLimit: boolean } }

    expect(result.quotes.map((q) => q.id)).toEqual(['Q000002', 'Q000003'])
    for (const copy of result.quotes) {
      expect(copy).toMatchObject({ status: 'DRAFT', quoteOpen: 'OPEN', duplicatedFromId: quote.id, rounds: 0 })
      expect(copy.linkToken).toBeUndefined()
    }
    expect(result.quotes[0].pickupAppt).toBe('2026-04-06T13:00:00.000Z')
    // Three open sell quotes at $2,500 against a $10,000 limit: a warning, not a block.
    expect(result.exposure).toEqual({ projectedCents: 750_000, creditLimitCents: 1_000_000, overLimit: false })
  })
})

describe('CONVERT_QUOTE', () => {
  it('builds the shipment, stamps the order and wins the quote', async () => {
    const sibling = await newQuote({ groupId: 'grp-1' })
    const quote = await sentQuote({ groupId: 'grp-1' })
    const result = (await call('CONVERT_QUOTE', {
      quoteId: quote.id,
      expectedVersion: quoteRow(String(quote.id)).version,
      acceptedVia: 'PHONE',
    }, QUOTER)) as { quote: Row; bundle: { shipment: Row; orders: Row[]; loads: Row[]; charges: Row[] } }

    expect(result.bundle.shipment.status).toBe('OPEN')
    expect(result.bundle.loads).toHaveLength(1)
    expect(result.bundle.orders[0]).toMatchObject({
      quoteId: quote.id,
      quoteNumber: quote.id,
      quoteAmountCents: 250_000,
      revenueCents: 250_000,
      rateType: 'SPOT',
    })

    const row = quoteRow(String(quote.id))
    expect(row).toMatchObject({ status: 'WON', shipmentId: result.bundle.shipment.id, acceptedVia: 'PHONE' })
    expect(row.wonAt).toBeTruthy()
    expect(row.quoteOpen).toBeUndefined()
    expect(row.linkToken).toBeUndefined()
    // The rest of the round goes down with it: priced, so LOST rather than canceled.
    const other = quoteRow(String(sibling.id))
    expect(other.status).toBe('LOST')
    expect(other.quoteOpen).toBeUndefined()
  })

  it('files the order and the leg under the division and rep the dialog chose', async () => {
    // `Division` is keyed by `key`, which is what a load's `divisionKey` points at.
    table(TABLES.division).set('IVAN_CARTAGE', {
      key: 'IVAN_CARTAGE', name: 'Ivan Cartage', active: true,
    })
    seedCustomer({ defaultDivisionKey: 'BCAT_LOGISTICS' })
    const quote = await sentQuote()

    const result = (await call('CONVERT_QUOTE', {
      quoteId: quote.id,
      expectedVersion: quoteRow(String(quote.id)).version,
      divisionKey: 'IVAN_CARTAGE',
      customerRepId: 'rep-amanda',
    }, QUOTER)) as { bundle: { orders: Row[]; loads: Row[] } }

    expect(result.bundle.orders[0].customerRepId).toBe('rep-amanda')
    // Not the customer's default, which is what the shipment was created with.
    expect(result.bundle.loads[0].divisionKey).toBe('IVAN_CARTAGE')

    const events = quoteRow(String(quote.id)).events as { kind: string; note?: string | null }[]
    const won = events[events.length - 1]
    expect(won).toMatchObject({ kind: 'WON' })
    expect(String(won.note)).toContain('IVAN_CARTAGE')
    expect(String(won.note)).toContain('rep-amanda')
  })

  it('refuses a division key that is not on the table', async () => {
    const quote = await sentQuote()

    await expect(
      call('CONVERT_QUOTE', { quoteId: quote.id, divisionKey: 'NO_SUCH_DIVISION' }, QUOTER),
    ).rejects.toThrow(/Unknown division: NO_SUCH_DIVISION/)
    // Refused before anything was written: no shipment, and the quote is where it was.
    expect(quoteRow(String(quote.id)).status).toBe('QUOTED')
    expect([...table(TABLES.shipment).values()]).toHaveLength(0)
  })

  it('blocks on credit and leaves the quote where it was', async () => {
    const quote = await sentQuote()
    seedCustomer({ creditHoldFlag: true })

    await expect(call('CONVERT_QUOTE', { quoteId: quote.id }, QUOTER)).rejects.toThrow(/credit hold/)
    expect(quoteRow(String(quote.id)).status).toBe('QUOTED')
    expect([...table(TABLES.shipment).values()]).toHaveLength(0)
  })

  it('refuses when the shipment no longer prices to the quoted number', async () => {
    const quote = await sentQuote()
    // What a charge code re-rated behind the quote's back looks like from here.
    table(TABLES.quote).set(String(quote.id), { ...quoteRow(String(quote.id)), amountCents: 300_000 })

    await expect(call('CONVERT_QUOTE', { quoteId: quote.id }, QUOTER)).rejects.toThrow(/re-price the quote first/)
    expect(quoteRow(String(quote.id)).status).toBe('QUOTED')
    // The half-made shipment does not stay on the board.
    expect([...table(TABLES.shipment).values()].every((s) => s.deletedAt)).toBe(true)
  })

  it('leaves the quote untouched when the shipment cannot be created', async () => {
    const quote = await sentQuote()
    loadCreate.mockResolvedValueOnce({ data: null, errors: [{ message: 'Load create refused' }] })

    await expect(call('CONVERT_QUOTE', { quoteId: quote.id }, QUOTER)).rejects.toThrow(/Load create/)
    expect(quoteRow(String(quote.id))).toMatchObject({ status: 'QUOTED', quoteOpen: 'OPEN', version: 2 })
    expect([...table(TABLES.order).values()]).toHaveLength(0)
  })

  it('refuses an expired quote', async () => {
    const quote = await sentQuote()
    table(TABLES.quote).set(String(quote.id), {
      ...quoteRow(String(quote.id)),
      expiresAt: '2020-01-01T00:00:00.000Z',
    })
    await expect(call('CONVERT_QUOTE', { quoteId: quote.id }, QUOTER)).rejects.toThrow(/expired/)
  })
})

describe('REVERT_TO_QUOTE', () => {
  async function converted(): Promise<{ quoteId: string; shipmentId: string; loadId: string }> {
    const quote = await sentQuote()
    const result = (await call('CONVERT_QUOTE', { quoteId: quote.id }, QUOTER)) as {
      bundle: { shipment: Row; loads: Row[] }
    }
    return {
      quoteId: String(quote.id),
      shipmentId: String(result.bundle.shipment.id),
      loadId: String(result.bundle.loads[0].id),
    }
  }

  it('takes the shipment back and puts the quote at RECEIVED_REPLY', async () => {
    const { quoteId, shipmentId } = await converted()
    const result = (await call('REVERT_TO_QUOTE', { quoteId, reason: 'Customer moved it to next week' }, QUOTER)) as {
      quote: Row
    }

    expect(result.quote).toMatchObject({ status: 'RECEIVED_REPLY', quoteOpen: 'OPEN', wonAt: null })
    expect(table(TABLES.shipment).get(shipmentId)!.deletedAt).toBeTruthy()
    // `loadId` is a GSI hash key: the way off a load is REMOVE, never SET null.
    const row = quoteRow(quoteId)
    expect(row.loadId).toBeUndefined()
    expect(row.shipmentId).toBeUndefined()
    expect(row.orderId).toBeUndefined()
  })

  it('refuses a shipment that has grown a second leg', async () => {
    const { quoteId, shipmentId } = await converted()
    const first = [...table(TABLES.load).values()].find((l) => l.shipmentId === shipmentId)!
    table(TABLES.load).set('lod-second', { ...first, id: 'lod-second', loadNumber: '2' })

    await expect(
      call('REVERT_TO_QUOTE', { quoteId, reason: 'Customer moved it' }, QUOTER),
    ).rejects.toThrow(/single-order, single-load/)
    expect(quoteRow(quoteId).status).toBe('WON')
  })

  it('refuses while a carrier is on the load', async () => {
    const { quoteId, loadId } = await converted()
    seedBookableCarrier()
    await call('BOOK_CARRIER', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      carrierId: 'car-1',
      carrierRateCents: 180_000,
    }, ADMIN)

    await expect(
      call('REVERT_TO_QUOTE', { quoteId, reason: 'Customer moved it' }, QUOTER),
    ).rejects.toThrow(/remove them first/)
    expect(quoteRow(quoteId).status).toBe('WON')
  })

  it('refuses once the order is invoiced', async () => {
    const { shipmentId } = await converted()
    const order = [...table(TABLES.order).values()].find((o) => o.shipmentId === shipmentId)!
    table(TABLES.order).set(String(order.id), { ...order, arStatus: 'UNPAID', invoiceNumber: 'INV-1' })

    await expect(
      call('REVERT_TO_QUOTE', { shipmentId, reason: 'Customer moved it' }, QUOTER),
    ).rejects.toThrow(/void the invoice first/)
  })

  it('refuses when the two ids name different things', async () => {
    const { shipmentId } = await converted()
    const other = await newQuote()
    await expect(
      call('REVERT_TO_QUOTE', { shipmentId, quoteId: other.id, reason: 'Wrong one' }, QUOTER),
    ).rejects.toThrow(/not Q000002/)
  })
})

describe('carrier offers', () => {
  async function requested(loadId: string, input: Row = {}): Promise<Row[]> {
    seedBookableCarrier('car-1')
    seedBookableCarrier('car-2')
    const result = (await call('REQUEST_OFFERS', {
      loadId,
      carrierIds: ['car-1', 'car-2'],
      message: 'Dry van, drop trailer at origin',
      ...input,
    }, QUOTER)) as { offers: Row[]; sends: Row[]; groupId: string }
    return result.offers
  }

  it('writes one row per carrier under one group, each with its own link', async () => {
    const { loadId, shipmentId } = await sourcingLoad()
    const before = Date.now()
    const offers = await requested(loadId, { bookNowRateCents: 180_000 })

    expect(offers).toHaveLength(2)
    expect(new Set(offers.map((o) => o.groupId)).size).toBe(1)
    expect(new Set(offers.map((o) => o.linkToken)).size).toBe(2)
    for (const offer of offers) {
      expect(offer).toMatchObject({
        side: 'BUY',
        status: 'REQUESTED',
        quoteOpen: 'OPEN',
        loadId,
        shipmentId,
        // The org shows the book-now number, so it is also what we are offering.
        amountCents: 180_000,
        bookNowRateCents: 180_000,
        laneKey: 'CHICAGO|IL>KANSAS CITY|MO',
      })
      expect(String(offer.linkToken)).toMatch(/^[A-Za-z0-9_-]{32}$/)
      // The pickup is already behind us, so the clock is the one-hour floor rather
      // than a link that was dead the moment it was minted.
      const expiresAt = Date.parse(String(offer.expiresAt))
      expect(expiresAt).toBeGreaterThan(before)
      expect(expiresAt).toBeLessThan(before + 2 * 3_600_000)
    }

    // One notice per send, addressed at the carrier's dispatch desk.
    const notices = [...table(TABLES.notice).values()]
    expect(notices).toHaveLength(2)
    expect(notices[0]).toMatchObject({ kind: 'CARRIER_OFFER', status: 'SENT', loadId })
    expect(notices.map((n) => n.to).sort()).toEqual(['dispatch@car-1.test', 'dispatch@car-2.test'])
  })

  it('names no number at all when the org hides the book-now rate', async () => {
    seedSettings({ quoteOffersCarrierSeesBookNow: false })
    const { loadId } = await sourcingLoad()
    const offers = await requested(loadId, { bookNowRateCents: 180_000 })

    for (const offer of offers) {
      // Nothing for `quotePublicView` to print as our offer, and nothing for
      // `planResponse` to let a carrier take: an open request names no price.
      expect(offer.amountCents).toBe(0)
      expect(offer.bookNowRateCents).toBeNull()
      expect(ourOfferCents(quoteRow(String(offer.id)) as never)).toBe(0)
    }
  })

  it('records the request on the shipment\'s notice log when SES refuses it', async () => {
    // Dev: SES is denied, and an offer request that cannot be sent is still a
    // request somebody made — it belongs on the load's notice log either way.
    sesSend.mockRejectedValue(new Error('AccessDenied'))
    const { loadId, shipmentId } = await sourcingLoad()
    const offers = await requested(loadId)

    const notices = [...table(TABLES.notice).values()]
    expect(notices).toHaveLength(2)
    for (const notice of notices) {
      expect(notice).toMatchObject({ kind: 'CARRIER_OFFER', status: 'NOT_SENT', loadId, shipmentId })
    }
    expect(notices.map((n) => n.id).sort()).toEqual(offers.map((o) => `cof:${String(o.id)}`).sort())
    expect(offers.every((o) => quoteRow(String(o.id)).lastSendStatus === 'NOT_SENT')).toBe(true)
  })

  it('prefers the carrier\'s dispatch contacts over the row\'s own address', async () => {
    const { loadId } = await sourcingLoad()
    table(TABLES.carrierContact).set('cct-1', {
      id: 'cct-1',
      __typename: 'CarrierContact',
      carrierId: 'car-1',
      name: 'Night dispatch',
      types: ['DISPATCH'],
      email: 'nights@car-1.test',
      active: true,
    })
    const offers = await requested(loadId)
    expect(offers.find((o) => o.carrierId === 'car-1')!.carrierEmail).toBe('nights@car-1.test')
  })

  it('refuses on a load that is already covered', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    await call('BOOK_CARRIER', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      carrierId: 'car-1',
      carrierRateCents: 180_000,
    })
    await expect(
      call('REQUEST_OFFERS', { loadId, carrierIds: ['car-1'] }, QUOTER),
    ).rejects.toThrow(/already has an active assignment/)
  })

  it('refuses on a load that is already on the road', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    await call('BOOK_CARRIER', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      carrierId: 'car-1',
      carrierRateCents: 180_000,
    })
    await call('REMOVE_LOAD_CARRIER', { loadCarrierId: [...table(TABLES.carrier).values()][0].id, outcome: 'BOUNCED', reason: 'GAVE_BACK' })
    for (const status of ['BOOKED', 'DISPATCHED', 'LOADING']) {
      await call('SET_LOAD_STATUS', { loadId, status })
    }
    await expect(
      call('REQUEST_OFFERS', { loadId, carrierIds: ['car-1'] }, QUOTER),
    ).rejects.toThrow(/already LOADING/)
  })

  it('logs a phone quote at QUOTED with no link at all', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const result = (await call('LOG_OFFER', {
      loadId,
      carrierId: 'car-1',
      amountCents: 175_000,
      note: 'Called in',
    })) as { quote: Row }

    expect(result.quote).toMatchObject({
      side: 'BUY', status: 'QUOTED', amountCents: 175_000, acceptedVia: 'PHONE', quoteOpen: 'OPEN',
    })
    expect(result.quote.linkToken).toBeUndefined()
    expect(result.quote.expiresAt).toBe('9999-12-31T23:59:59.999Z')
  })

  it('counters a carrier with a fresh token and one more round', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const logged = (await call('LOG_OFFER', { loadId, carrierId: 'car-1', amountCents: 190_000 })) as { quote: Row }

    await call('COUNTER_OFFER', { quoteId: logged.quote.id, amountCents: 175_000 }, QUOTER)

    // Our number is the counter; theirs stays the row's own, which is what every
    // reader of a BUY row — ours, the public page's and the booking's — takes it as.
    const row = quoteRow(String(logged.quote.id))
    expect(row).toMatchObject({
      status: 'SENT_COUNTER', amountCents: 190_000, counterCents: 175_000, counterBy: 'US', rounds: 1,
    })
    expect(String(row.linkToken)).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('books the carrier at our counter once they take it, not at their ask', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const logged = (await call('LOG_OFFER', { loadId, carrierId: 'car-1', amountCents: 190_000 })) as { quote: Row }
    const quoteId = String(logged.quote.id)
    await call('COUNTER_OFFER', { quoteId, amountCents: 175_000 }, QUOTER)

    // What the carrier's click on the public link leaves behind: the number that
    // was on the table becomes the row's own, and nothing is booked yet.
    const onTheTable = ourOfferCents(quoteRow(quoteId) as never)
    table(TABLES.quote).set(quoteId, {
      ...quoteRow(quoteId),
      status: 'RECEIVED_REPLY',
      amountCents: onTheTable,
      response: 'ACCEPTED',
      acceptedVia: 'LINK',
    })

    const result = (await call('ACCEPT_OFFER', {
      quoteId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
    })) as { bundle: { loadCarriers: Row[] } }

    expect(result.bundle.loadCarriers.find((c) => c.status === 'ACTIVE')!.carrierRateCents).toBe(175_000)
    expect(quoteRow(quoteId)).toMatchObject({ status: 'WON', amountCents: 175_000 })
  })

  it('books a carrier counter at their number and records it on the row', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const logged = (await call('LOG_OFFER', { loadId, carrierId: 'car-1', amountCents: 190_000 })) as { quote: Row }
    const quoteId = String(logged.quote.id)
    await call('COUNTER_OFFER', { quoteId, amountCents: 175_000 }, QUOTER)
    // Their answer to our counter: 182,500, which is the number we would be buying at.
    table(TABLES.quote).set(quoteId, {
      ...quoteRow(quoteId),
      status: 'RECEIVED_COUNTER',
      counterCents: 182_500,
      counterBy: 'THEM',
    })

    const result = (await call('ACCEPT_OFFER', {
      quoteId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
    })) as { bundle: { loadCarriers: Row[]; charges: Row[] } }

    expect(result.bundle.loadCarriers.find((c) => c.status === 'ACTIVE')!.carrierRateCents).toBe(182_500)
    const linehaul = result.bundle.charges.find((c) => c.side === 'CARRIER' && c.code === 'LINEHAUL')!
    expect(linehaul.amountCents).toBe(182_500)
    expect(quoteRow(quoteId)).toMatchObject({ status: 'WON', amountCents: 182_500 })
  })

  it('refuses to book a counter the carrier has not answered', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const logged = (await call('LOG_OFFER', { loadId, carrierId: 'car-1', amountCents: 190_000 })) as { quote: Row }
    const quoteId = String(logged.quote.id)
    await call('COUNTER_OFFER', { quoteId, amountCents: 175_000 }, QUOTER)

    await expect(
      call('ACCEPT_OFFER', { quoteId, expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt }),
    ).rejects.toThrow(/has not answered our counter/)
    expect(quoteRow(quoteId).status).toBe('SENT_COUNTER')

    // Unless the dispatcher names the rate they agreed on the phone.
    const result = (await call('ACCEPT_OFFER', {
      quoteId,
      carrierRateCents: 180_000,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
    })) as { bundle: { loadCarriers: Row[] } }
    expect(result.bundle.loadCarriers.find((c) => c.status === 'ACTIVE')!.carrierRateCents).toBe(180_000)
    expect(quoteRow(quoteId)).toMatchObject({ status: 'WON', amountCents: 180_000 })
  })

  it('rejects an offer without touching the load', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const logged = (await call('LOG_OFFER', { loadId, carrierId: 'car-1', amountCents: 190_000 })) as { quote: Row }

    await call('REJECT_OFFER', { quoteId: logged.quote.id, reason: 'TOO_HIGH' }, QUOTER)

    const row = quoteRow(String(logged.quote.id))
    expect(row).toMatchObject({ status: 'LOST', lostReason: 'TOO_HIGH' })
    expect(row.quoteOpen).toBeUndefined()
    expect(table(TABLES.load).get(loadId)!.status).toBe('SOURCING')
  })

  it('books the winner, names the offer on the assignment and closes the round', async () => {
    const { loadId } = await sourcingLoad()
    const offers = await requested(loadId)
    const winner = offers.find((o) => o.carrierId === 'car-1')!
    const loser = offers.find((o) => o.carrierId === 'car-2')!
    // What the carrier's public reply leaves behind: their number, and no token.
    table(TABLES.quote).set(String(winner.id), {
      ...quoteRow(String(winner.id)), status: 'QUOTED', amountCents: 178_500,
    })

    const result = (await call('ACCEPT_OFFER', {
      quoteId: winner.id,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
    })) as { quote: Row; bundle: { loadCarriers: Row[] } }

    const assignment = result.bundle.loadCarriers.find((c) => c.status === 'ACTIVE')!
    expect(assignment).toMatchObject({ carrierId: 'car-1', carrierRateCents: 178_500, quoteId: winner.id })
    expect(quoteRow(String(winner.id))).toMatchObject({ status: 'WON' })
    expect(quoteRow(String(winner.id)).quoteOpen).toBeUndefined()
    // The sibling nobody priced was never in the running: canceled, not lost.
    expect(quoteRow(String(loser.id))).toMatchObject({ status: 'CANCELED', lostReason: null })
    expect(table(TABLES.load).get(loadId)!.status).toBe('BOOKED')
  })

  it('surfaces the booking gate\'s refusal verbatim and books nothing', async () => {
    const { loadId } = await sourcingLoad()
    const offers = await requested(loadId)
    const winner = offers[0]
    table(TABLES.quote).set(String(winner.id), {
      ...quoteRow(String(winner.id)), status: 'QUOTED', amountCents: 178_500,
    })
    seedBookableCarrier(String(winner.carrierId), { authorityStatus: 'INACTIVE', status: 'INACTIVE' })

    await expect(
      call('ACCEPT_OFFER', {
        quoteId: winner.id,
        expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      }),
    ).rejects.toThrow(/cannot be booked/)
    expect(quoteRow(String(winner.id)).status).toBe('QUOTED')
    expect([...table(TABLES.carrier).values()]).toHaveLength(0)
  })

  it('cancels the open offers when the load is covered by a plain booking', async () => {
    const { loadId } = await sourcingLoad()
    const offers = await requested(loadId)
    seedBookableCarrier()

    await call('BOOK_CARRIER', {
      loadId,
      expectedUpdatedAt: table(TABLES.load).get(loadId)!.updatedAt,
      carrierId: 'car-1',
      carrierRateCents: 180_000,
    })

    for (const offer of offers) {
      const row = quoteRow(String(offer.id))
      expect(row.status).toBe('CANCELED')
      expect(row.quoteOpen).toBeUndefined()
      expect(row.linkToken).toBeUndefined()
    }
  })

  it('cancels the open offers when our own truck takes the load', async () => {
    const { loadId } = await sourcingLoad()
    const offers = await requested(loadId)
    table(TABLES.driver).set('drv-1', { id: 'drv-1', name: 'R. LOPEZ' })

    await call('ASSIGN_ASSET', { loadId, driverId: 'drv-1', driverName: 'R. LOPEZ' })

    expect(offers.every((offer) => quoteRow(String(offer.id)).status === 'CANCELED')).toBe(true)
  })
})

describe('lane rate samples', () => {
  async function delivered(): Promise<{ shipmentId: string; loadId: string }> {
    const ids = await sourcingLoad()
    seedBookableCarrier()
    await call('BOOK_CARRIER', {
      loadId: ids.loadId,
      expectedUpdatedAt: table(TABLES.load).get(ids.loadId)!.updatedAt,
      carrierId: 'car-1',
      carrierRateCents: 180_000,
    })
    for (const status of ['DISPATCHED', 'LOADING', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
      await call('SET_LOAD_STATUS', { loadId: ids.loadId, status })
    }
    return ids
  }

  it('records the lane when a priced load delivers', async () => {
    const { loadId, shipmentId } = await delivered()

    const sample = table(TABLES.laneSample).get(`lrs:${loadId}`)!
    expect(sample).toMatchObject({
      laneKey: 'CHICAGO|IL>KANSAS CITY|MO',
      loadId,
      shipmentId,
      customerId: 'cus-1',
      carrierId: 'car-1',
      assignmentKind: 'CARRIER',
      revenueCents: 250_000,
      costCents: 180_000,
      profitCents: 70_000,
      loadStatus: 'DELIVERED',
      source: 'LOAD',
      version: 1,
    })
    expect(sample.excluded).toBe(false)
  })

  it('stamps the sample with the team the billed account belongs to', async () => {
    seedCustomer({ teamKey: 'EAST' })
    const { loadId } = await delivered()

    const sample = table(TABLES.laneSample).get(`lrs:${loadId}`)!
    expect(sample.teamKey).toBe('EAST')
    expect(sample.sampleMonth).toBe('2026-03')
  })

  it('still records the lane when the stops carry no ZIPs', async () => {
    // `laneKey3` is the hash key of the zip3 index, and these stops have no ZIPs to
    // build one from. The attribute comes off the item — a NULL there is refused by
    // DynamoDB, and this module's catch-all would swallow the refusal, leaving the
    // lane with no history at all.
    const { loadId } = await delivered()

    const sample = table(TABLES.laneSample).get(`lrs:${loadId}`)!
    expect(sample.laneKey).toBe('CHICAGO|IL>KANSAS CITY|MO')
    expect('laneKey3' in sample).toBe(false)
  })

  it('records nothing for a load with no financials to learn from', async () => {
    const ids = await sourcingLoad()
    table(TABLES.financials).delete(ids.loadId)
    for (const status of ['BOOKED', 'DISPATCHED', 'LOADING', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
      await call('SET_LOAD_STATUS', { loadId: ids.loadId, status })
    }
    expect(table(TABLES.laneSample).get(`lrs:${ids.loadId}`)).toBeUndefined()
  })

  it('refreshes the sample when the delivered load is re-priced', async () => {
    const { loadId, shipmentId } = await delivered()
    const shipment = table(TABLES.shipment).get(shipmentId)!
    const charges = [...table(TABLES.charge).values()].map((row) => ({
      id: row.id,
      side: row.side,
      code: row.code,
      calculatedBy: row.calculatedBy,
      rateCents: row.code === 'LINEHAUL' && row.side === 'CUSTOMER' ? 265_000 : row.rateCents,
      count: row.count,
      loadId: row.loadId,
      loadCarrierId: row.loadCarrierId,
    }))

    await call('RECALC_CHARGES', { shipmentId, expectedVersion: shipment.version, charges })

    const sample = table(TABLES.laneSample).get(`lrs:${loadId}`)!
    expect(sample.revenueCents).toBe(265_000)
    expect(sample.version).toBe(2)
  })

  it('keeps the sample but stops counting it after a post-delivery TONU', async () => {
    const { loadId } = await delivered()
    const assignment = [...table(TABLES.carrier).values()].find((c) => c.status === 'ACTIVE')!

    await call('REMOVE_LOAD_CARRIER', {
      loadCarrierId: assignment.id,
      outcome: 'TONU',
      reason: 'CONSIGNEE_NOT_READY',
    })

    const sample = table(TABLES.laneSample).get(`lrs:${loadId}`)!
    expect(sample.excluded).toBe(true)
    expect(sample.revenueCents).toBe(250_000)
  })

  it('keeps the sample but stops counting it when the shipment is canceled', async () => {
    const { loadId, shipmentId } = await delivered()
    const shipment = table(TABLES.shipment).get(shipmentId)!

    await call('SET_SHIPMENT_STATUS', {
      shipmentId,
      expectedUpdatedAt: shipment.updatedAt,
      status: 'CANCELED',
      reason: 'Customer never shipped it',
    }, ADMIN)

    expect(table(TABLES.laneSample).get(`lrs:${loadId}`)!.excluded).toBe(true)
  })
})

describe('step H authorization', () => {
  it('does not let the quote desk re-price a shipment', async () => {
    await expect(
      call('RECALC_CHARGES', { shipmentId: 'shp-1', expectedVersion: 1, charges: [] }, QUOTER),
    ).rejects.toThrow(/requires owner, ADMIN, or page-loads/)
  })

  it('does not let the quote desk move a load', async () => {
    await expect(
      call('SET_LOAD_STATUS', { loadId: 'lod-1', status: 'DELIVERED' }, QUOTER),
    ).rejects.toThrow(/requires owner, ADMIN, or page-loads/)
  })

  it('does not let dispatch send a customer a price', async () => {
    await expect(
      call('SEND_QUOTE', { quoteId: 'Q000001', to: ['x@y.test'] }, DISPATCHER),
    ).rejects.toThrow(/requires owner, ADMIN, or page-quotes/)
  })

  it('lets dispatch shop the load it has to cover', async () => {
    const { loadId } = await sourcingLoad()
    seedBookableCarrier()
    const result = (await call('LOG_OFFER', { loadId, carrierId: 'car-1', amountCents: 175_000 }, DISPATCHER)) as {
      quote: Row
    }
    expect(result.quote.status).toBe('QUOTED')
  })

  it('keeps org quote defaults in admin hands', async () => {
    await expect(
      call('SAVE_QUOTE_SETTINGS', { hoursToQuote: 48 }, QUOTER),
    ).rejects.toThrow(/requires owner or ADMIN/)
  })
})

describe('SAVE_QUOTE_SETTINGS', () => {
  it('saves the quote defaults an admin may change', async () => {
    const result = (await call('SAVE_QUOTE_SETTINGS', {
      hoursToQuote: 48,
      offerExpiryHours: 6,
      quoteNumberFormat: 'Q{yyyy}-{n:4}',
      quoteTermsText: 'Rates valid for the lane and dates quoted.',
    }, ADMIN)) as { settings: Row }

    expect(result.settings).toMatchObject({
      hoursToQuote: 48,
      offerExpiryHours: 6,
      quoteNumberFormat: 'Q{yyyy}-{n:4}',
    })
    expect((await newQuote()).id).toBe('Q2026-0001')
  })

  it('refuses a template nobody could answer', async () => {
    await expect(
      call('SAVE_QUOTE_SETTINGS', { quoteEmailTemplate: 'Here is our price. Call us.' }, ADMIN),
    ).rejects.toThrow(/\{link\} token/)
  })

  it('refuses a number format that would reuse the same id', async () => {
    await expect(
      call('SAVE_QUOTE_SETTINGS', { quoteNumberFormat: 'Q-{yyyy}' }, ADMIN),
    ).rejects.toThrow(/\{n\} token/)
  })

  it('refuses to wind the counter back onto numbers that exist', async () => {
    await newQuote()
    await newQuote()
    await expect(
      call('SAVE_QUOTE_SETTINGS', { nextQuoteNumber: 1 }, ADMIN),
    ).rejects.toThrow(/can only go forward/)
  })
})

describe('SAVE_SHIPMENT_SETTINGS', () => {
  it('keeps the org shipment defaults out of the loads page', async () => {
    await expect(
      call('SAVE_SHIPMENT_SETTINGS', { shipmentPrefix: 'BC' }, DISPATCHER),
    ).rejects.toThrow('Forbidden: SAVE_SHIPMENT_SETTINGS requires owner or ADMIN')
  })

  it('saves the prefix, the default mode and the flags, and numbers the next shipment with them', async () => {
    const result = (await call('SAVE_SHIPMENT_SETTINGS', {
      shipmentPrefix: 'BC-',
      defaultMode: 'DRAYAGE',
      cancelDeleteAdminOnly: true,
      arUnbilledStage: 'Unbilled',
      apInReviewStage: 'In review',
    }, ADMIN)) as { settings: Row }

    expect(result.settings).toMatchObject({
      shipmentPrefix: 'BC-',
      defaultMode: 'DRAYAGE',
      cancelDeleteAdminOnly: true,
      arUnbilledStage: 'Unbilled',
      apInReviewStage: 'In review',
    })

    const { shipmentId } = await createDraft()
    expect(table(TABLES.shipment).get(shipmentId)!.number).toBe('BC-000001')
  })

  it('refuses to wind the shipment counter back onto numbers that exist', async () => {
    seedSettings({ nextShipmentNumber: 7 })
    await expect(
      call('SAVE_SHIPMENT_SETTINGS', { nextShipmentNumber: 3 }, ADMIN),
    ).rejects.toThrow('The shipment counter is at 7 and can only go forward')
  })

  it('refuses a prefix a shipment number could not be built from', async () => {
    await expect(
      call('SAVE_SHIPMENT_SETTINGS', { shipmentPrefix: 'BC 1' }, ADMIN),
    ).rejects.toThrow('A shipment prefix is up to 8 letters, numbers or dashes')
    await expect(
      call('SAVE_SHIPMENT_SETTINGS', { shipmentPrefix: 'BCATCORP1' }, ADMIN),
    ).rejects.toThrow('A shipment prefix is up to 8 letters, numbers or dashes')
  })
})

describe('unknown action', () => {
  it('is refused by name', async () => {
    await expect(call('NOT_AN_ACTION', {})).rejects.toThrow(/Unknown action/)
  })
})
