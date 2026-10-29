/**
 * tms-finance-actions handler tests.
 *
 * Like the shipment router's suite, the DynamoDB mock is a small in-memory engine
 * rather than scripted responses — but this one also evaluates CONDITION expressions,
 * because conditions are the whole safety argument here. "A payment was applied" is
 * not the assertion that matters; "a payment was refused because the invoice had moved
 * under it" is. Every concurrency test below works by mutating a row between the read
 * and the write and watching the transaction lose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

type Row = Record<string, unknown>

// ── Cognito ─────────────────────────────────────────────────────────────────
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

// ── DynamoDB ────────────────────────────────────────────────────────────────
const TABLES = {
  invoice: 'Invoice-test',
  arPayment: 'ArPayment-test',
  order: 'Order-test',
  shipment: 'Shipment-test',
  load: 'Load-test',
  loadCarrier: 'LoadCarrier-test',
  financials: 'LoadFinancials-test',
  charge: 'LoadCharge-test',
  customer: 'Customer-test',
  division: 'Division-test',
  settings: 'TmsSettings-test',
  audit: 'AuditLog-test',
  factoring: 'FactoringItem-test',
  document: 'ShipmentDocument-test',
  notice: 'ShipmentNotice-test',
  carrierBill: 'CarrierBill-test',
  apPayment: 'ApPayment-test',
  carrier: 'Carrier-test',
  carrierMethod: 'CarrierPaymentMethod-test',
  carrierContact: 'CarrierContact-test',
  commission: 'Commission-test',
  payPeriod: 'CommissionPayPeriod-test',
  userProfile: 'UserProfile-test',
}

const store = vi.hoisted(() => {
  process.env.INVOICE_TABLE_NAME = 'Invoice-test'
  process.env.AR_PAYMENT_TABLE_NAME = 'ArPayment-test'
  process.env.ORDER_TABLE_NAME = 'Order-test'
  process.env.SHIPMENT_TABLE_NAME = 'Shipment-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.LOAD_CARRIER_TABLE_NAME = 'LoadCarrier-test'
  process.env.LOAD_FINANCIALS_TABLE_NAME = 'LoadFinancials-test'
  process.env.LOAD_CHARGE_TABLE_NAME = 'LoadCharge-test'
  process.env.CUSTOMER_TABLE_NAME = 'Customer-test'
  process.env.DIVISION_TABLE_NAME = 'Division-test'
  process.env.SETTINGS_TABLE_NAME = 'TmsSettings-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
  process.env.FACTORING_ITEM_TABLE_NAME = 'FactoringItem-test'
  process.env.SHIPMENT_DOCUMENT_TABLE_NAME = 'ShipmentDocument-test'
  process.env.SHIPMENT_NOTICE_TABLE_NAME = 'ShipmentNotice-test'
  process.env.CARRIER_BILL_TABLE_NAME = 'CarrierBill-test'
  process.env.AP_PAYMENT_TABLE_NAME = 'ApPayment-test'
  process.env.CARRIER_TABLE_NAME = 'Carrier-test'
  process.env.CARRIER_PAYMENT_METHOD_TABLE_NAME = 'CarrierPaymentMethod-test'
  process.env.CARRIER_CONTACT_TABLE_NAME = 'CarrierContact-test'
  process.env.COMMISSION_TABLE_NAME = 'Commission-test'
  process.env.COMMISSION_PAY_PERIOD_TABLE_NAME = 'CommissionPayPeriod-test'
  process.env.USER_PROFILE_TABLE_NAME = 'UserProfile-test'
  process.env.BUCKET_NAME = 'bcat-test-bucket'
  process.env.FROM_ADDRESS = 'ai4bcat@gmail.com'
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
 * Division is the one table this router reads that is not keyed on `id`
 * (`amplify/data/resource.ts`, `.identifier(['key'])`). The real table answers a
 * GetItem whose `Key` names the wrong attribute with a ValidationException, not an
 * empty read, so the engine does the same: an id-keyed read of a division has to
 * fail here exactly as it fails in AWS.
 */
const KEY_ATTRIBUTE: Record<string, string> = { [TABLES.division]: 'key' }

function keyOf(tableName: string, key: Row): string {
  const attribute = KEY_ATTRIBUTE[tableName] ?? 'id'
  const value = key[attribute]
  if (typeof value !== 'string') {
    throw new Error(
      `ValidationException: The provided key element does not match the schema — ${tableName} is keyed on ${attribute}`,
    )
  }
  return value
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

function updateClauses(expression: string): Record<string, string> {
  const clauses: Record<string, string> = {}
  for (const part of expression.split(/\s+(?=SET\s|ADD\s|REMOVE\s)/)) {
    const m = /^(SET|ADD|REMOVE)\s+(.*)$/s.exec(part.trim())
    if (m) clauses[m[1]] = m[2]
  }
  return clauses
}

/**
 * The conjunction (and the one disjunction) of simple predicates this router writes.
 *
 * Deliberately NOT a general expression parser: every condition in the handler is
 * simple enough to state in one line here, and a condition it could not evaluate shows
 * up as a failing test rather than a silently permissive mock.
 *
 * `attribute_not_exists` follows DynamoDB, NOT JavaScript: an attribute explicitly
 * stored as NULL EXISTS. `tms-shipment-actions` creates every order with
 * `invoiceId: null`, so a fake that treated null as absent would pass a condition the
 * real table refuses — which is exactly the bug this distinction caught.
 */
function conditionHolds(
  condition: string,
  row: Row | null,
  values: Row,
  names: Record<string, string>,
): boolean {
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] ?? token : token)
  const term = (raw: string): boolean => {
    let text = raw.trim()
    while (text.startsWith('(') && matchingClose(text, 0) === text.length - 1) {
      text = text.slice(1, -1).trim()
    }
    const ors = splitTop(text, 'OR')
    if (ors.length > 1) return ors.some(term)
    const ands = splitTop(text, 'AND')
    if (ands.length > 1) return ands.every(term)

    let m = /^attribute_not_exists\(([#\w]+)\)$/.exec(text)
    if (m) return row == null || !(resolve(m[1]) in row)
    m = /^attribute_exists\(([#\w]+)\)$/.exec(text)
    if (m) return row != null && resolve(m[1]) in row
    m = /^attribute_type\(([#\w]+),\s*(:\w+)\)$/.exec(text)
    if (m) {
      if (row == null || !(resolve(m[1]) in row)) return false
      const actual = row[resolve(m[1])]
      const wanted = String(values[m[2]])
      if (wanted === 'NULL') return actual === null
      if (wanted === 'S') return typeof actual === 'string'
      if (wanted === 'N') return typeof actual === 'number'
      return false
    }
    m = /^([#\w]+)\s*(=|<>|>=|<=|>|<)\s*(:\w+)$/.exec(text)
    if (m) {
      if (!row) return false
      const actual = row[resolve(m[1])]
      const expected = values[m[3]]
      switch (m[2]) {
        case '=': return String(actual) === String(expected)
        case '<>': return String(actual) !== String(expected)
        case '>=': return Number(actual ?? 0) >= Number(expected)
        case '<=': return Number(actual ?? 0) <= Number(expected)
        case '>': return Number(actual ?? 0) > Number(expected)
        default: return Number(actual ?? 0) < Number(expected)
      }
    }
    throw new Error(`test engine cannot evaluate condition term: ${text}`)
  }
  return term(condition)
}

/** Index of the `)` closing the `(` at `from`, or -1. */
function matchingClose(expression: string, from: number): number {
  let depth = 0
  for (let i = from; i < expression.length; i += 1) {
    if (expression[i] === '(') depth += 1
    else if (expression[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split on a keyword at paren depth zero, so `(a OR b) AND c` stays two terms. */
function splitTop(expression: string, keyword: string): string[] {
  const parts: string[] = []
  const needle = ` ${keyword} `
  let depth = 0
  let start = 0
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (depth === 0 && expression.startsWith(needle, i)) {
      parts.push(expression.slice(start, i))
      start = i + needle.length
      i = start - 1
    }
  }
  parts.push(expression.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const key = unmarshall(spec.Key as never) as { id: string }
  const existing = t.get(key.id) ?? null
  const values = spec.ExpressionAttributeValues
    ? (unmarshall(spec.ExpressionAttributeValues as never) as Row)
    : {}
  const names = spec.ExpressionAttributeNames ?? {}
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] ?? token : token)

  if (spec.ConditionExpression && !conditionHolds(spec.ConditionExpression, existing, values, names)) {
    throw new ConditionalCheckFailed(`${spec.TableName}/${key.id}: ${spec.ConditionExpression}`)
  }

  const next: Row = { ...(existing ?? { id: key.id }) }
  const clauses = updateClauses(spec.UpdateExpression)
  if (clauses.ADD) {
    for (const term of clauses.ADD.split(/,\s*/)) {
      const m = /^\s*([#\w]+)\s+(:\w+)\s*$/.exec(term)
      if (!m) continue
      const field = resolve(m[1])
      next[field] = Number(next[field] ?? 0) + Number(values[m[2]] ?? 0)
    }
  }
  if (clauses.SET) {
    for (const assignment of clauses.SET.split(/,\s*(?![^(]*\))/)) {
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
    for (const token of clauses.REMOVE.split(/,\s*/)) delete next[resolve(token.trim())]
  }
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

// ── S3 / presigner / SES ────────────────────────────────────────────────────
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
  return { S3Client, PutObjectCommand: make('PutObject'), GetObjectCommand: make('GetObject') }
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

import { handler } from './handler'

interface MockCommand {
  __type: string
  input: Record<string, unknown>
}

function runCommand(cmd: MockCommand): unknown {
  const input = cmd.input
  switch (cmd.__type) {
    case 'Get': {
      const key = unmarshall(input.Key as never) as Row
      const item = table(String(input.TableName)).get(keyOf(String(input.TableName), key))
      return { Item: item ? marshall(item, { removeUndefinedValues: true }) : undefined }
    }
    case 'Query': {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
      const values = unmarshall(input.ExpressionAttributeValues as never) as Row
      const cond = String(input.KeyConditionExpression)
      const token = cond.split(' ')[0]
      const field = names[token] ?? token
      const items = [...table(String(input.TableName)).values()].filter((i) => i[field] === values[':v'])
      return { Items: items.map((i) => marshall(i, { removeUndefinedValues: true })) }
    }
    case 'Put': {
      const item = unmarshall(input.Item as never) as Row
      const t = table(String(input.TableName))
      if (input.ConditionExpression === 'attribute_not_exists(id)' && t.has(String(item.id))) {
        throw new ConditionalCheckFailed(`${String(input.TableName)}/${String(item.id)} already exists`)
      }
      t.set(String(item.id), item)
      return {}
    }
    case 'Update':
      return { Attributes: marshall(applyUpdate(input as unknown as UpdateSpec), { removeUndefinedValues: true }) }
    case 'Scan':
      return { Items: [...table(String(input.TableName)).values()].map((i) => marshall(i, { removeUndefinedValues: true })) }
    case 'Transact': {
      const items = input.TransactItems as Record<string, Record<string, unknown>>[]
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
            t.set(String(item.id), item)
          } else if (entry.Update) {
            applyUpdate(entry.Update as unknown as UpdateSpec)
          }
        }
      } catch (err) {
        store.clear()
        for (const [name, t] of snapshot) store.set(name, t)
        throw new TransactionCanceled(String((err as Error).message))
      }
      return {}
    }
    default:
      throw new Error(`unsupported command: ${cmd.__type}`)
  }
}

function runS3(cmd: MockCommand): unknown {
  if (cmd.__type === 'PutObject') return {}
  if (cmd.__type === 'GetObject') {
    return {
      ContentType: 'application/pdf',
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    }
  }
  throw new Error(`unsupported s3 command: ${cmd.__type}`)
}

// ── identities ──────────────────────────────────────────────────────────────
const ADMIN = { sub: 'sub-admin', username: 'admin', claims: { email: 'admin@bcatcorp.com', 'cognito:groups': ['ADMIN'] } }
const BILLER = { sub: 'sub-bill', username: 'bill', claims: { email: 'bill@bcatcorp.com', 'cognito:groups': ['page-invoicing'] } }
const DISPATCHER = { sub: 'sub-dis', username: 'dis', claims: { email: 'dis@bcatcorp.com', 'cognito:groups': ['page-loads'] } }

function call(action: string, input: Row, identity: unknown = ADMIN): Promise<Row> {
  return handler({ arguments: { action, input: JSON.stringify(input) }, identity } as never)
}

// ── fixtures ────────────────────────────────────────────────────────────────
const ORDER_ID = 'ord-1'
const SHIPMENT_ID = 'shp-1'
const LOAD_ID = 'lod-1'
const CUSTOMER_ID = 'cus-1'

function seed(over: { order?: Row; customer?: Row; settings?: Row } = {}): void {
  table(TABLES.settings).set('default', {
    id: 'default',
    __typename: 'TmsSettings',
    defaultPaymentTermsDays: 30,
    nextInvoiceNumber: 0,
    ...over.settings,
  })
  table(TABLES.customer).set(CUSTOMER_ID, {
    id: CUSTOMER_ID,
    name: 'Acme Freight',
    mcNumber: '123456',
    billingEmail: 'ap@acme.test',
    contacts: [],
    billToParties: [],
    ...over.customer,
  })
  // Keyed on `key`, with no `id` attribute at all — as Amplify writes a Division row.
  table(TABLES.division).set('BCAT_LOGISTICS', {
    key: 'BCAT_LOGISTICS',
    name: 'BCAT Logistics',
    remitToName: 'BCAT Logistics LLC',
    invoicePrefix: 'INV-',
  })
  table(TABLES.shipment).set(SHIPMENT_ID, {
    id: SHIPMENT_ID,
    number: 'S000001',
    status: 'DELIVERED',
    customerId: CUSTOMER_ID,
    deliveredAt: '2026-10-20T10:00:00.000Z',
  })
  table(TABLES.order).set(ORDER_ID, {
    id: ORDER_ID,
    shipmentId: SHIPMENT_ID,
    customerId: CUSTOMER_ID,
    customerName: 'Acme Freight',
    arStatus: 'UNBILLED',
    // tms-shipment-actions writes these explicitly as null on every order it creates
    // (handler.ts:1099, 1858). A NULL attribute EXISTS as far as DynamoDB is
    // concerned, which is the whole point of seeding them here.
    invoiceId: null,
    invoiceNumber: null,
    revenueCents: 250_000,
    references: [],
    version: 3,
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    ...over.order,
  })
  table(TABLES.load).set(LOAD_ID, {
    id: LOAD_ID,
    shipmentId: SHIPMENT_ID,
    orderId: ORDER_ID,
    aljexId: 'S000001-1',
    loadNumber: 'S000001-1',
    divisionKey: 'BCAT_LOGISTICS',
    stops: [
      { id: 's1', sequence: 1, type: 'pickup', name: 'Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: '2026-10-18T13:00:00.000Z' },
      { id: 's2', sequence: 2, type: 'delivery', name: 'Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: '2026-10-20T09:00:00.000Z' },
    ],
  })
  table(TABLES.financials).set(LOAD_ID, {
    id: LOAD_ID,
    loadId: LOAD_ID,
    shipmentId: SHIPMENT_ID,
    orderId: ORDER_ID,
    revenueCents: 250_000,
    costCents: 180_000,
    version: 1,
  })
  table(TABLES.charge).set('chg-1', {
    id: 'chg-1',
    shipmentId: SHIPMENT_ID,
    orderId: ORDER_ID,
    loadId: LOAD_ID,
    side: 'CUSTOMER',
    code: 'LINEHAUL',
    label: 'Linehaul',
    rateCents: 250_000,
    count: 1,
    amountCents: 250_000,
    isRate: true,
    sortOrder: 1,
    createdBy: 'a@b.c',
  })
  table(TABLES.charge).set('chg-2', {
    id: 'chg-2',
    shipmentId: SHIPMENT_ID,
    loadId: LOAD_ID,
    side: 'CARRIER',
    code: 'LINEHAUL',
    rateCents: 180_000,
    count: 1,
    amountCents: 180_000,
    isRate: true,
    sortOrder: 1,
    createdBy: 'a@b.c',
  })
  // Step R's release gate: an order only reaches accounting when the shipment has
  // delivered, the paperwork the customer bills on is in hand and somebody's cost is
  // recorded. That is the state every billing test starts from; the gate tests bend
  // exactly one of those facts.
  table(TABLES.loadCarrier).set(LOAD_CARRIER_ID, {
    id: LOAD_CARRIER_ID,
    loadId: LOAD_ID,
    shipmentId: SHIPMENT_ID,
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: CARRIER_ID,
    carrierName: 'Wheeler Trucking',
    rateConStatus: 'SIGNED',
    chargesFinalizedAt: '2026-10-21T12:00:00.000Z',
    apStatus: 'IN_REVIEW',
    invoiceId: null,
    costCents: 180_000,
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
  })
  for (const [id, type] of [['doc-seed-bol', 'BOL'], ['doc-seed-pod', 'POD']]) {
    table(TABLES.document).set(id, {
      id,
      shipmentId: SHIPMENT_ID,
      orderId: ORDER_ID,
      loadId: LOAD_ID,
      type,
      name: `${type.toLowerCase()}-seed.pdf`,
      s3Key: `shipment-docs/${SHIPMENT_ID}/${id}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 1024,
      status: 'ACTIVE',
      reviewStatus: 'ACCEPTED',
      audience: 'ALL',
      uploadedAt: '2026-10-21T10:00:00.000Z',
    })
  }
}

async function generate(identity: unknown = ADMIN): Promise<{ invoiceId: string; number: string }> {
  const result = (await call('GENERATE_INVOICE', { orderId: ORDER_ID }, identity)) as { invoice: Row }
  return { invoiceId: String(result.invoice.id), number: String(result.invoice.number) }
}

/**
 * A second billable order on the same shipment, with the load, leg and paperwork
 * that make it releasable. The gate scopes everything by the loads an order owns,
 * so an order cloned without its own load is an order nothing was hauled for.
 */
function seedSecondOrder(orderId: string, over: Row = {}): void {
  const suffix = orderId.replace(/[^a-z0-9]/gi, '')
  const loadId = `lod-${suffix}`
  table(TABLES.order).set(orderId, {
    ...table(TABLES.order).get(ORDER_ID)!,
    id: orderId,
    arStatus: 'UNBILLED',
    invoiceId: null,
    invoiceNumber: null,
    factoringItemId: null,
    ...over,
  })
  table(TABLES.load).set(loadId, { ...table(TABLES.load).get(LOAD_ID)!, id: loadId, orderId })
  table(TABLES.financials).set(loadId, { ...table(TABLES.financials).get(LOAD_ID)!, id: loadId, loadId, orderId })
  table(TABLES.charge).set(`chg-${suffix}`, {
    ...table(TABLES.charge).get('chg-1')!,
    id: `chg-${suffix}`,
    orderId,
    loadId,
  })
  table(TABLES.loadCarrier).set(`lc-${suffix}`, {
    ...table(TABLES.loadCarrier).get(LOAD_CARRIER_ID)!,
    id: `lc-${suffix}`,
    loadId,
  })
  for (const type of ['BOL', 'POD']) {
    const id = `doc-${suffix}-${type.toLowerCase()}`
    table(TABLES.document).set(id, {
      ...table(TABLES.document).get(`doc-seed-${type.toLowerCase()}`)!,
      id,
      orderId,
      loadId,
      s3Key: `shipment-docs/${SHIPMENT_ID}/${id}.pdf`,
    })
  }
}

beforeEach(() => {
  store.clear()
  send.mockReset()
  s3Send.mockReset()
  sesSend.mockReset()
  getSignedUrl.mockReset()
  cognitoSend.mockReset()
  send.mockImplementation(runCommand)
  s3Send.mockImplementation(runS3)
  sesSend.mockResolvedValue({ MessageId: 'msg-1' })
  getSignedUrl.mockResolvedValue('https://signed.example/invoice.pdf')
  seed()
})

// ── authorization ───────────────────────────────────────────────────────────

describe('authorization', () => {
  it('refuses a request with no identity at all', async () => {
    await expect(call('PREVIEW_INVOICE', { orderId: ORDER_ID }, null)).rejects.toThrow(/Unauthorized/)
  })

  it('refuses a dispatcher who only holds page-loads', async () => {
    await expect(call('PREVIEW_INVOICE', { orderId: ORDER_ID }, DISPATCHER)).rejects.toThrow(/page-invoicing/)
  })

  it('lets a page-tms caller open AR, and keeps posting admin-only', async () => {
    // Step R: Invoicing is a BROKERAGE page, so the one TMS grant opens the AR door
    // `page-invoicing` opens — and no further: posting is still owner/ADMIN.
    const TMS_USER = { sub: 'sub-tms', username: 'tms', claims: { email: 'broker@bcatcorp.com', 'cognito:groups': ['page-tms'] } }
    await expect(call('PREVIEW_INVOICE', { orderId: ORDER_ID }, TMS_USER)).resolves.toBeDefined()
    await expect(call('SAVE_AR_SETTINGS', { invoiceTerms: 'Net 30' }, TMS_USER)).rejects.toThrow(/requires owner or ADMIN/)
  })

  it('lets page-invoicing issue a bill but not post money against it', async () => {
    const { invoiceId } = await generate(BILLER)
    await expect(
      call('RECORD_PAYMENT', { customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 1, applications: [{ invoiceId, amountCents: 1 }], creditApplications: [] }, BILLER),
    ).rejects.toThrow(/requires owner or ADMIN/)
  })

  it('lets page-invoicing post once the org turns the admin-only rule off', async () => {
    table(TABLES.settings).set('default', { ...table(TABLES.settings).get('default')!, arPostingAdminOnly: false })
    const { invoiceId } = await generate(BILLER)
    const posted = (await call(
      'RECORD_PAYMENT',
      { customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 1000, applications: [{ invoiceId, amountCents: 1000 }], creditApplications: [] },
      BILLER,
    )) as { payment: Row }
    expect(posted.payment.createdBy).toBe('bill@bcatcorp.com')
  })

  it('keeps settings admin-only whatever the posting rule says', async () => {
    table(TABLES.settings).set('default', { ...table(TABLES.settings).get('default')!, arPostingAdminOnly: false })
    await expect(call('SAVE_AR_SETTINGS', { invoiceTerms: 'Net 30' }, BILLER)).rejects.toThrow(/requires owner or ADMIN/)
  })

  it('refuses an action it does not have', async () => {
    await expect(call('DELETE_EVERYTHING', {})).rejects.toThrow(/Unknown action/)
  })
})

// ── generating ──────────────────────────────────────────────────────────────

describe('GENERATE_INVOICE', () => {
  it('writes the invoice, moves the order to UNPAID and freezes the load in one go', async () => {
    const { invoiceId, number } = await generate()
    expect(number).toBe('INV-000001')

    const invoice = table(TABLES.invoice).get(invoiceId)!
    expect(invoice).toMatchObject({
      status: 'ISSUED',
      totalCents: 250_000,
      balanceCents: 250_000,
      paidCents: 0,
      arOpen: 'OPEN',
      customerId: CUSTOMER_ID,
    })
    // The snapshot is the order's CUSTOMER lines only — the carrier's $1,800 is not on it.
    expect(invoice.lines).toEqual([expect.objectContaining({ chargeId: 'chg-1', amountCents: 250_000 })])

    expect(table(TABLES.order).get(ORDER_ID)).toMatchObject({
      arStatus: 'UNPAID',
      invoiceId,
      invoiceNumber: number,
      arBalanceCents: 250_000,
    })
    expect(table(TABLES.financials).get(LOAD_ID)!.frozenAt).toBeTruthy()
  })

  it("puts the load's division on the invoice, read by its own key", async () => {
    // Division is identified by `key`, not `id`: a read built as `Key: { id }` is
    // refused by DynamoDB with a ValidationException, so every invoice on a load
    // that names a division would fail outright rather than lose the remit-to.
    const { invoiceId } = await generate()
    const invoice = table(TABLES.invoice).get(invoiceId)!
    expect(invoice.divisionKey).toBe('BCAT_LOGISTICS')
    expect(invoice.remitTo).toMatchObject({ name: 'BCAT Logistics LLC' })
  })

  it('refuses an order that is not UNBILLED, and writes nothing', async () => {
    table(TABLES.order).set(ORDER_ID, { ...table(TABLES.order).get(ORDER_ID)!, arStatus: 'DOCS_NEEDED' })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow(/only an UNBILLED order/i)
    expect(table(TABLES.invoice).size).toBe(0)
    expect(table(TABLES.financials).get(LOAD_ID)!.frozenAt).toBeUndefined()
  })

  it('refuses an order whose charges no longer agree with its revenue', async () => {
    table(TABLES.order).set(ORDER_ID, { ...table(TABLES.order).get(ORDER_ID)!, revenueCents: 300_000 })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow(/\$3,000\.00|\$2,500\.00/)
    expect(table(TABLES.invoice).size).toBe(0)
  })

  it('refuses a second invoice for the same order', async () => {
    await generate()
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow()
    expect(table(TABLES.invoice).size).toBe(1)
  })

  it('skips a number rather than reusing one when a transaction fails', async () => {
    // Another writer takes the order between the readiness check and the transaction.
    const original = send.getMockImplementation()!
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        table(TABLES.order).set(ORDER_ID, { ...table(TABLES.order).get(ORDER_ID)!, invoiceId: 'INV-SOMEONE-ELSE' })
      }
      return original(cmd)
    })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow()
    expect(table(TABLES.invoice).size).toBe(0)

    // Repair the order and try again: the burnt number is gone for good.
    const order = table(TABLES.order).get(ORDER_ID)!
    delete order.invoiceId
    table(TABLES.order).set(ORDER_ID, order)
    const { number } = await generate()
    expect(number).toBe('INV-000002')
  })

  it('leaves pdfKey null when the upload fails, and RENDER_INVOICE_PDF repairs it', async () => {
    s3Send.mockImplementation((cmd: MockCommand) => {
      if (cmd.__type === 'PutObject') throw new Error('S3 is down')
      return runS3(cmd)
    })
    const { invoiceId } = await generate()
    expect(table(TABLES.invoice).get(invoiceId)!.pdfKey).toBeUndefined()

    s3Send.mockImplementation(runS3)
    const repaired = (await call('RENDER_INVOICE_PDF', { invoiceId })) as { invoice: Row }
    expect(String(repaired.invoice.pdfKey)).toMatch(/^invoices\/cus-1\/INV-000001-v1\.pdf$/)
    expect(table(TABLES.invoice).get(invoiceId)!.pdfSizeBytes).toBeGreaterThan(0)
  })

  it('reports each order separately in a batch instead of failing all of them', async () => {
    table(TABLES.order).set('ord-2', { ...table(TABLES.order).get(ORDER_ID)!, id: 'ord-2', arStatus: 'PAID' })
    const out = (await call('BATCH_GENERATE', { orderIds: [ORDER_ID, 'ord-2'] })) as { results: Row[] }
    expect(out.results[0]).toMatchObject({ orderId: ORDER_ID, number: 'INV-000001' })
    expect(String(out.results[1].error)).toMatch(/UNBILLED/i)
  })
})

// ── the release gate (Step R) ───────────────────────────────────────────────

/**
 * Ryne's rule: a shipment reaches accounting only when it has delivered with its
 * paperwork, its references and its cost recorded, and nothing may bypass it —
 * not a batch, not the factor, not an admin. The order's AR status is a cached
 * verdict; these tests move the facts under it and watch the server refuse.
 */
describe('release to accounting', () => {
  it('refuses an UNBILLED order whose POD was voided after it was released', async () => {
    table(TABLES.document).set('doc-seed-pod', {
      ...table(TABLES.document).get('doc-seed-pod')!,
      status: 'VOID',
      voidedAt: '2026-10-22T09:00:00.000Z',
    })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow(
      'Not ready for accounting: Missing document: POD',
    )
    expect(table(TABLES.invoice).size).toBe(0)
    expect(table(TABLES.order).get(ORDER_ID)!.arStatus).toBe('UNBILLED')
  })

  it('refuses a document the carrier sent but nobody has accepted', async () => {
    table(TABLES.document).set('doc-seed-pod', {
      ...table(TABLES.document).get('doc-seed-pod')!,
      source: 'CARRIER_PORTAL',
      reviewStatus: 'PENDING',
    })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow(/Missing document: POD/)
  })

  it('refuses an outside carrier whose bill is not recorded, and names them', async () => {
    const leg = table(TABLES.loadCarrier).get(LOAD_CARRIER_ID)!
    delete leg.chargesFinalizedAt
    table(TABLES.loadCarrier).set(LOAD_CARRIER_ID, leg)
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow(
      'Not ready for accounting: Carrier charges not settled: Wheeler Trucking — record the carrier bill first',
    )
    expect(table(TABLES.invoice).size).toBe(0)
  })

  it('refuses while an exception is still open on the load', async () => {
    table(TABLES.load).set(LOAD_ID, { ...table(TABLES.load).get(LOAD_ID)!, openIncidentCount: 2 })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow(
      'Not ready for accounting: 2 open exceptions',
    )
  })

  it('no longer lets an admin override admit a missing document', async () => {
    table(TABLES.document).delete('doc-seed-pod')
    table(TABLES.order).set(ORDER_ID, {
      ...table(TABLES.order).get(ORDER_ID)!,
      docsOverrideAt: '2026-10-22T09:00:00.000Z',
      docsOverrideBy: 'admin@bcatcorp.com',
      docsOverrideNote: 'bills on the BOL',
    })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID }, ADMIN)).rejects.toThrow(/Missing document: POD/)
    expect(table(TABLES.invoice).size).toBe(0)
  })

  it('bills the orders that pass in a batch and reports the one that does not', async () => {
    seedSecondOrder('ord-2')
    seedSecondOrder('ord-3')
    table(TABLES.document).delete('doc-ord3-pod')

    const out = (await call('BATCH_GENERATE', { orderIds: [ORDER_ID, 'ord-2', 'ord-3'] })) as { results: Row[] }
    expect(out.results.map((r) => r.orderId)).toEqual([ORDER_ID, 'ord-2', 'ord-3'])
    expect(out.results[0].number).toBe('INV-000001')
    expect(out.results[1].number).toBe('INV-000002')
    expect(String(out.results[2].error)).toBe('Not ready for accounting: Missing document: POD')
    expect(out.results[2].releaseGate).toMatchObject({
      ok: false,
      missing: [{ code: 'DOC_MISSING', detail: 'POD', message: 'Missing document: POD' }],
    })
    expect(table(TABLES.invoice).size).toBe(2)
    expect(table(TABLES.order).get('ord-3')!.arStatus).toBe('UNBILLED')
  })

  it('refuses Send to Factor once the carrier bill behind the invoice is undone', async () => {
    const { invoiceId } = await generate()
    const leg = table(TABLES.loadCarrier).get(LOAD_CARRIER_ID)!
    delete leg.chargesFinalizedAt
    table(TABLES.loadCarrier).set(LOAD_CARRIER_ID, leg)

    await expect(call('SEND_TO_FACTOR', { invoiceId })).rejects.toThrow(
      /Not ready for accounting: Carrier charges not settled: Wheeler Trucking/,
    )
    expect(table(TABLES.factoring).size).toBe(0)
    expect(table(TABLES.invoice).get(invoiceId)!.factored).toBe(false)
  })

  it('refuses Send to Factor on a voided shipment, and says so in the preview', async () => {
    const { invoiceId } = await generate()
    table(TABLES.shipment).set(SHIPMENT_ID, {
      ...table(TABLES.shipment).get(SHIPMENT_ID)!,
      voidedAt: '2026-10-23T00:00:00.000Z',
      voidedBy: 'admin@bcatcorp.com',
    })

    const preview = (await call('PREVIEW_FACTOR', { invoiceId })) as { ready: boolean; refusal: string }
    expect(preview.ready).toBe(false)
    expect(preview.refusal).toBe('Not ready for accounting: Voided shipment')
    await expect(call('SEND_TO_FACTOR', { invoiceId })).rejects.toThrow('Not ready for accounting: Voided shipment')
    expect(table(TABLES.factoring).size).toBe(0)
  })

  it('hands the preview the same list the refusal would carry', async () => {
    table(TABLES.document).delete('doc-seed-bol')
    const preview = (await call('PREVIEW_INVOICE', { orderId: ORDER_ID })) as {
      releaseGate: { ok: boolean; missing: { code: string; message: string }[] }
    }
    expect(preview.releaseGate).toEqual({
      ok: false,
      missing: [{ code: 'DOC_MISSING', detail: 'BOL', message: 'Missing document: BOL' }],
    })
    // A preview writes nothing, whatever it finds.
    expect(table(TABLES.invoice).size).toBe(0)
  })

  it('still issues exactly one invoice when two presses race', async () => {
    const results = await Promise.allSettled([
      call('GENERATE_INVOICE', { orderId: ORDER_ID }),
      call('GENERATE_INVOICE', { orderId: ORDER_ID }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(table(TABLES.invoice).size).toBe(1)
    expect(table(TABLES.order).get(ORDER_ID)).toMatchObject({ arStatus: 'UNPAID' })
  })
})

// ── e-mailing ───────────────────────────────────────────────────────────────

describe('EMAIL_INVOICE', () => {
  it('records the send and counts it', async () => {
    const { invoiceId } = await generate()
    const sent = (await call('EMAIL_INVOICE', { invoiceId })) as Row
    expect(sent.emailStatus).toBe('SENT')
    expect(table(TABLES.invoice).get(invoiceId)).toMatchObject({ sentCount: 1, sentTo: 'ap@acme.test' })
  })

  it('tells the truth when SES refuses, and hands back a download instead', async () => {
    const { invoiceId } = await generate()
    sesSend.mockRejectedValue(new Error('Access denied: ses:SendEmail'))
    const sent = (await call('EMAIL_INVOICE', { invoiceId })) as { emailStatus: string; emailError: string; downloads: Row[] }
    expect(sent.emailStatus).toBe('NOT_SENT')
    expect(sent.emailError).toMatch(/Access denied/)
    expect(sent.downloads.length).toBeGreaterThan(0)
    // Nothing claims a send that did not happen.
    expect(table(TABLES.invoice).get(invoiceId)!.sentAt).toBeUndefined()
    expect(table(TABLES.invoice).get(invoiceId)!.sentCount).toBe(0)
  })

  it('refuses to send a void invoice', async () => {
    const { invoiceId } = await generate()
    await call('VOID_INVOICE', { invoiceId, reason: 'wrong customer' })
    await expect(call('EMAIL_INVOICE', { invoiceId })).rejects.toThrow(/void/i)
  })

  it('refuses when nobody is listed to receive it', async () => {
    table(TABLES.customer).set(CUSTOMER_ID, { ...table(TABLES.customer).get(CUSTOMER_ID)!, billingEmail: null, contacts: [] })
    const { invoiceId } = await generate()
    await expect(call('EMAIL_INVOICE', { invoiceId })).rejects.toThrow(/Nobody is listed/)
  })
})

// ── voiding ─────────────────────────────────────────────────────────────────

describe('VOID_INVOICE', () => {
  it('puts the order back to UNBILLED, unfreezes the load and leaves the open book', async () => {
    const { invoiceId } = await generate()
    await call('VOID_INVOICE', { invoiceId, reason: 'duplicate' })

    const invoice = table(TABLES.invoice).get(invoiceId)!
    expect(invoice).toMatchObject({ status: 'VOID', voidReason: 'duplicate' })
    expect(invoice.arOpen).toBeUndefined()
    expect(table(TABLES.order).get(ORDER_ID)).toMatchObject({ arStatus: 'UNBILLED' })
    expect(table(TABLES.order).get(ORDER_ID)!.invoiceId).toBeUndefined()
    expect(table(TABLES.financials).get(LOAD_ID)!.frozenAt).toBeUndefined()
  })

  it('refuses once money has been applied', async () => {
    const { invoiceId } = await generate()
    await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 50_000,
      applications: [{ invoiceId, amountCents: 50_000 }], creditApplications: [],
    })
    await expect(call('VOID_INVOICE', { invoiceId, reason: 'oops' })).rejects.toThrow(/reverse the payment first/i)
  })

  it('refuses an invoice the factor already has', async () => {
    const { invoiceId } = await generate()
    await call('SEND_TO_FACTOR', { invoiceId })
    const row = table(TABLES.factoring).get('S000001-1')!
    table(TABLES.factoring).set('S000001-1', { ...row, otrInvoiceId: '99123' })
    await expect(call('VOID_INVOICE', { invoiceId, reason: 'oops' })).rejects.toThrow(/submitted to OTR as invoice 99123/)
  })

  it('archives an unsubmitted factoring row it raised', async () => {
    const { invoiceId } = await generate()
    await call('SEND_TO_FACTOR', { invoiceId })
    await call('VOID_INVOICE', { invoiceId, reason: 'rebill' })
    expect(table(TABLES.factoring).get('S000001-1')!.status).toBe('ARCHIVED')
  })
})

// ── payments ────────────────────────────────────────────────────────────────

describe('RECORD_PAYMENT', () => {
  it('part-pays without moving the order off UNPAID', async () => {
    const { invoiceId } = await generate()
    await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'ACH', reference: '778',
      amountCents: 100_000, applications: [{ invoiceId, amountCents: 100_000 }], creditApplications: [],
    })
    expect(table(TABLES.invoice).get(invoiceId)).toMatchObject({ status: 'PARTIAL', paidCents: 100_000, balanceCents: 150_000, arOpen: 'OPEN' })
    expect(table(TABLES.order).get(ORDER_ID)).toMatchObject({ arStatus: 'UNPAID', arBalanceCents: 150_000 })
  })

  it('settles the invoice and the order only at a zero balance', async () => {
    const { invoiceId } = await generate()
    await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK',
      amountCents: 250_000, applications: [{ invoiceId, amountCents: 250_000 }], creditApplications: [],
    })
    const invoice = table(TABLES.invoice).get(invoiceId)!
    expect(invoice).toMatchObject({ status: 'PAID', balanceCents: 0 })
    expect(invoice.arOpen).toBeUndefined()
    expect(invoice.paidAt).toBeTruthy()
    expect(table(TABLES.order).get(ORDER_ID)).toMatchObject({ arStatus: 'PAID', arBalanceCents: 0 })
  })

  it('keeps an overpayment on the row as customer credit', async () => {
    const { invoiceId } = await generate()
    const out = (await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'WIRE',
      amountCents: 300_000, applications: [{ invoiceId, amountCents: 250_000 }], creditApplications: [],
    })) as { payment: Row }
    expect(out.payment).toMatchObject({ appliedCents: 250_000, unappliedCents: 50_000 })
  })

  it('refuses to apply more than the invoice owes', async () => {
    const { invoiceId } = await generate()
    await expect(call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK',
      amountCents: 400_000, applications: [{ invoiceId, amountCents: 400_000 }], creditApplications: [],
    })).rejects.toThrow(/outstanding/)
    expect(table(TABLES.arPayment).size).toBe(0)
  })

  it('loses the transaction when the invoice is paid under it', async () => {
    const { invoiceId } = await generate()
    const original = send.getMockImplementation()!
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        // Somebody else's cheque lands between our read and our write.
        const invoice = table(TABLES.invoice).get(invoiceId)!
        table(TABLES.invoice).set(invoiceId, { ...invoice, paidCents: 250_000, balanceCents: 0, status: 'PAID' })
      }
      return original(cmd)
    })
    await expect(call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK',
      amountCents: 250_000, applications: [{ invoiceId, amountCents: 250_000 }], creditApplications: [],
    })).rejects.toThrow()
    expect(table(TABLES.invoice).get(invoiceId)!.paidCents).toBe(250_000)
    expect(table(TABLES.arPayment).size).toBe(0)
  })

  it('refuses to move an order that has been re-invoiced under it', async () => {
    const { invoiceId } = await generate()
    const original = send.getMockImplementation()!
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        table(TABLES.order).set(ORDER_ID, { ...table(TABLES.order).get(ORDER_ID)!, invoiceId: 'INV-000099' })
      }
      return original(cmd)
    })
    await expect(call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK',
      amountCents: 250_000, applications: [{ invoiceId, amountCents: 250_000 }], creditApplications: [],
    })).rejects.toThrow()
    expect(table(TABLES.arPayment).size).toBe(0)
    expect(table(TABLES.invoice).get(invoiceId)!.paidCents).toBe(0)
  })

  it('spends a credit with a conditional ADD, and refuses when it was spent first', async () => {
    const { invoiceId } = await generate()
    const credit = (await call('CREATE_CREDIT', {
      customerId: CUSTOMER_ID, memoDate: '2026-10-01', amountCents: 50_000, note: 'short pay settlement',
    })) as { payment: Row }
    const creditId = String(credit.payment.id)

    const original = send.getMockImplementation()!
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        table(TABLES.arPayment).set(creditId, { ...table(TABLES.arPayment).get(creditId)!, unappliedCents: 0 })
      }
      return original(cmd)
    })
    await expect(call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK',
      amountCents: 200_000,
      applications: [{ invoiceId, amountCents: 250_000 }],
      creditApplications: [{ paymentId: creditId, amountCents: 50_000 }],
    })).rejects.toThrow()
    expect(table(TABLES.invoice).get(invoiceId)!.paidCents).toBe(0)

    send.mockImplementation(original)
    table(TABLES.arPayment).set(creditId, { ...table(TABLES.arPayment).get(creditId)!, unappliedCents: 50_000 })
    await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK',
      amountCents: 200_000,
      applications: [{ invoiceId, amountCents: 250_000 }],
      creditApplications: [{ paymentId: creditId, amountCents: 50_000 }],
    })
    expect(table(TABLES.invoice).get(invoiceId)).toMatchObject({ status: 'PAID', balanceCents: 0 })
    expect(table(TABLES.arPayment).get(creditId)).toMatchObject({ unappliedCents: 0, appliedCents: 50_000 })
  })

  it('is idempotent for one client request id', async () => {
    const { invoiceId } = await generate()
    const input = {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 100_000,
      applications: [{ invoiceId, amountCents: 100_000 }], creditApplications: [], clientRequestId: 'press-1',
    }
    const first = (await call('RECORD_PAYMENT', input)) as { duplicate: boolean }
    const second = (await call('RECORD_PAYMENT', input)) as { duplicate: boolean }
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(table(TABLES.arPayment).size).toBe(1)
    expect(table(TABLES.invoice).get(invoiceId)!.paidCents).toBe(100_000)
  })

  it('answers a simultaneous duplicate with the row the winner wrote, not an error', async () => {
    const { invoiceId } = await generate()
    const input = {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 100_000,
      applications: [{ invoiceId, amountCents: 100_000 }], creditApplications: [], clientRequestId: 'press-2',
    }
    // Both copies read nothing; the other one lands between our read and our write.
    const original = send.getMockImplementation()!
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        const put = (cmd.input.TransactItems as Record<string, Record<string, unknown>>[])
          .find((entry) => entry.Put)!.Put as { Item: Record<string, unknown> }
        const row = unmarshall(put.Item as never) as Row
        table(TABLES.arPayment).set(String(row.id), row)
        table(TABLES.invoice).set(invoiceId, {
          ...table(TABLES.invoice).get(invoiceId)!,
          paidCents: 100_000, balanceCents: 150_000, status: 'PARTIAL',
        })
      }
      return original(cmd)
    })
    const out = (await call('RECORD_PAYMENT', input)) as { duplicate: boolean }
    expect(out.duplicate).toBe(true)
    expect(table(TABLES.arPayment).size).toBe(1)
    // The invoice carries exactly one application of the money, not two.
    expect(table(TABLES.invoice).get(invoiceId)!.paidCents).toBe(100_000)
  })

  it('stores the typed date at noon UTC so it cannot slide a month', async () => {
    const { invoiceId } = await generate()
    const out = (await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-31', method: 'CHECK', amountCents: 1000,
      applications: [{ invoiceId, amountCents: 1000 }], creditApplications: [],
    })) as { payment: Row }
    expect(out.payment.receivedAt).toBe('2026-10-31T12:00:00.000Z')
  })
})

describe('WRITE_OFF', () => {
  it('settles the remainder without pretending it was paid', async () => {
    const { invoiceId } = await generate()
    await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 249_000,
      applications: [{ invoiceId, amountCents: 249_000 }], creditApplications: [],
    })
    await call('WRITE_OFF', { invoiceId, amountCents: 1_000, reason: 'short pay, not worth chasing' })
    const invoice = table(TABLES.invoice).get(invoiceId)!
    expect(invoice).toMatchObject({ status: 'PAID', paidCents: 249_000, writtenOffCents: 1_000, balanceCents: 0 })
    expect(table(TABLES.order).get(ORDER_ID)!.arStatus).toBe('PAID')
  })

  it('refuses more than the balance', async () => {
    const { invoiceId } = await generate()
    await expect(call('WRITE_OFF', { invoiceId, amountCents: 300_000, reason: 'nope' })).rejects.toThrow(/outstanding/)
  })

  it('refuses without a reason', async () => {
    const { invoiceId } = await generate()
    await expect(call('WRITE_OFF', { invoiceId, amountCents: 1_000 })).rejects.toThrow(/reason/)
  })
})

describe('REVERSE_PAYMENT', () => {
  it('restores the balance, reopens the invoice and takes the order off PAID', async () => {
    const { invoiceId } = await generate()
    const posted = (await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 250_000,
      applications: [{ invoiceId, amountCents: 250_000 }], creditApplications: [],
    })) as { payment: Row }

    await call('REVERSE_PAYMENT', { paymentId: String(posted.payment.id), reason: 'cheque bounced' })

    const invoice = table(TABLES.invoice).get(invoiceId)!
    expect(invoice).toMatchObject({ status: 'ISSUED', paidCents: 0, balanceCents: 250_000, arOpen: 'OPEN' })
    expect(invoice.paidAt).toBeUndefined()
    const order = table(TABLES.order).get(ORDER_ID)!
    expect(order).toMatchObject({ arStatus: 'UNPAID', arBalanceCents: 250_000 })
    expect(order.paidAt).toBeUndefined()
    expect(table(TABLES.arPayment).get(String(posted.payment.id))!.reversedByPaymentId).toBeTruthy()
  })

  it('gives a spent credit back', async () => {
    const { invoiceId } = await generate()
    const credit = (await call('CREATE_CREDIT', { customerId: CUSTOMER_ID, memoDate: '2026-10-01', amountCents: 50_000, note: 'goodwill' })) as { payment: Row }
    const creditId = String(credit.payment.id)
    const posted = (await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 200_000,
      applications: [{ invoiceId, amountCents: 250_000 }],
      creditApplications: [{ paymentId: creditId, amountCents: 50_000 }],
    })) as { payment: Row }

    await call('REVERSE_PAYMENT', { paymentId: String(posted.payment.id), reason: 'wrong invoice' })
    expect(table(TABLES.arPayment).get(creditId)).toMatchObject({ unappliedCents: 50_000, appliedCents: 0 })
  })

  it('refuses a second reversal', async () => {
    const { invoiceId } = await generate()
    const posted = (await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 250_000,
      applications: [{ invoiceId, amountCents: 250_000 }], creditApplications: [],
    })) as { payment: Row }
    await call('REVERSE_PAYMENT', { paymentId: String(posted.payment.id), reason: 'bounced' })
    await expect(call('REVERSE_PAYMENT', { paymentId: String(posted.payment.id), reason: 'again' }))
      .rejects.toThrow(/already been reversed/)
  })
})

// ── factoring ───────────────────────────────────────────────────────────────

describe('SEND_TO_FACTOR', () => {
  it('writes the queue row the intake e-mail would have written, and stops there', async () => {
    const { invoiceId } = await generate()
    const out = (await call('SEND_TO_FACTOR', { invoiceId })) as { factoringItem: Row; reused: boolean }

    const row = table(TABLES.factoring).get('S000001-1')!
    expect(row).toMatchObject({
      id: 'S000001-1',
      proNumber: 'S000001-1',
      status: 'NEED_TO_FACTOR',
      source: 'TMS',
      invoiceId,
      orderId: ORDER_ID,
      shipmentId: SHIPMENT_ID,
      messageId: `tms:${invoiceId}`,
      fromEmail: 'admin@bcatcorp.com',
    })
    expect(row.otrManualFields).toMatchObject({
      InvoiceNo: 'INV-000001',
      InvoiceAmount: '2500.00',
      BrokerMC: '123456',
      FromCity: 'Chicago',
      FromState: 'IL',
      FromZip: '60601',
      ToCity: 'Dallas',
      ToState: 'TX',
      ToZip: '75201',
    })
    // Nothing was submitted: that is a person's job on /factoring.
    expect(row.otrInvoiceId).toBeUndefined()
    expect(out.reused).toBe(false)
    expect(table(TABLES.invoice).get(invoiceId)).toMatchObject({ factored: true, factoringItemId: 'S000001-1' })
  })

  it('is idempotent: a second press reuses the row rather than double-factoring', async () => {
    const { invoiceId } = await generate()
    await call('SEND_TO_FACTOR', { invoiceId })
    const again = (await call('SEND_TO_FACTOR', { invoiceId })) as { reused: boolean }
    expect(again.reused).toBe(true)
    expect(table(TABLES.factoring).size).toBe(1)
  })

  it('refuses a PRO the factor already holds', async () => {
    const { invoiceId } = await generate()
    table(TABLES.factoring).set('S000001-1', {
      id: 'S000001-1', proNumber: 'S000001-1', status: 'PENDING_WITH_OTR', otrInvoiceId: '55001',
      subject: 'x', fromEmail: 'y@z', messageId: 'm', receivedAt: '2026-10-01T00:00:00.000Z',
    })
    await expect(call('SEND_TO_FACTOR', { invoiceId })).rejects.toThrow(/already submitted to OTR as invoice 55001/)
  })

  it('refuses a customer with no MC number', async () => {
    table(TABLES.customer).set(CUSTOMER_ID, { ...table(TABLES.customer).get(CUSTOMER_ID)!, mcNumber: null })
    const { invoiceId } = await generate()
    await expect(call('SEND_TO_FACTOR', { invoiceId })).rejects.toThrow(/MC/i)
  })
})

// ── settings ────────────────────────────────────────────────────────────────

describe('SAVE_AR_SETTINGS', () => {
  it('refuses a number format with no counter token and a template with no number', async () => {
    await expect(call('SAVE_AR_SETTINGS', { invoiceNumberFormat: 'INV-{yyyy}' })).rejects.toThrow(/\{n\}/)
    await expect(call('SAVE_AR_SETTINGS', { invoiceEmailTemplate: 'Please pay us.' })).rejects.toThrow(/\{number\}/)
  })

  it('stores what it accepts and uses it on the next invoice', async () => {
    await call('SAVE_AR_SETTINGS', { invoiceNumberFormat: 'B{yyyy}-{n:4}' })
    const { number } = await generate()
    expect(number).toBe('B2026-0001'.replace('2026', new Date().toISOString().slice(0, 4)))
  })
})

// ── what the Fable review turned up ─────────────────────────────────────────

describe('review regressions', () => {
  it('refuses to spend a credit that has been reversed', async () => {
    const { invoiceId } = await generate()
    const credit = (await call('CREATE_CREDIT', {
      customerId: CUSTOMER_ID, memoDate: '2026-10-01', amountCents: 50_000, note: 'issued by mistake',
    })) as { payment: Row }
    const creditId = String(credit.payment.id)

    await call('REVERSE_PAYMENT', { paymentId: creditId, reason: 'issued against the wrong customer' })
    // The reversal takes the money off the row, not just the label.
    expect(table(TABLES.arPayment).get(creditId)).toMatchObject({ unappliedCents: 0 })

    await expect(call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID, receivedAt: '2026-10-25', method: 'CHECK', amountCents: 200_000,
      applications: [{ invoiceId, amountCents: 250_000 }],
      creditApplications: [{ paymentId: creditId, amountCents: 50_000 }],
    })).rejects.toThrow(/has been reversed/)
    expect(table(TABLES.invoice).get(invoiceId)!.paidCents).toBe(0)
  })

  it('loses the reversal when the credit is spent first, rather than letting both stand', async () => {
    await generate()
    const credit = (await call('CREATE_CREDIT', {
      customerId: CUSTOMER_ID, memoDate: '2026-10-01', amountCents: 50_000, note: 'goodwill',
    })) as { payment: Row }
    const creditId = String(credit.payment.id)

    const original = send.getMockImplementation()!
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        table(TABLES.arPayment).set(creditId, { ...table(TABLES.arPayment).get(creditId)!, unappliedCents: 0, appliedCents: 50_000 })
      }
      return original(cmd)
    })
    await expect(call('REVERSE_PAYMENT', { paymentId: creditId, reason: 'changed my mind' })).rejects.toThrow()
    expect(table(TABLES.arPayment).get(creditId)!.reversedByPaymentId).toBeUndefined()
  })

  it('does not claim an e-mail went out when an invoice is marked sent by hand', async () => {
    const { invoiceId } = await generate()
    await call('MARK_SENT', { invoiceId, note: 'faxed to their AP desk' })
    const invoice = table(TABLES.invoice).get(invoiceId)!
    expect(invoice.markedSentAt).toBeTruthy()
    expect(invoice.markedSentNote).toBe('faxed to their AP desk')
    // `sentAt` means SES accepted it. Nothing did.
    expect(invoice.sentAt).toBeUndefined()
    expect(invoice.sentCount).toBe(0)
  })

  it('refuses to re-render a void invoice over the document that was sent', async () => {
    const { invoiceId } = await generate()
    const before = table(TABLES.invoice).get(invoiceId)!.pdfKey
    await call('VOID_INVOICE', { invoiceId, reason: 'wrong rate' })
    await expect(call('RENDER_INVOICE_PDF', { invoiceId })).rejects.toThrow(/record of what was sent/)
    expect(table(TABLES.invoice).get(invoiceId)!.pdfKey).toBe(before)
  })

  it('refuses to bill a factored customer until the factor remit-to exists, then prints it', async () => {
    table(TABLES.customer).set(CUSTOMER_ID, { ...table(TABLES.customer).get(CUSTOMER_ID)!, factored: true })
    await expect(call('GENERATE_INVOICE', { orderId: ORDER_ID })).rejects.toThrow(/no factor remit-to is set up/)

    await call('SAVE_AR_SETTINGS', { factorRemitTo: { name: 'OTR Solutions', noticeText: 'Assigned to OTR Solutions.' } })
    const { invoiceId } = await generate()
    expect(table(TABLES.invoice).get(invoiceId)!.remitTo).toMatchObject({ name: 'OTR Solutions' })
  })

  it('refuses a factor remit-to with no name', async () => {
    await expect(call('SAVE_AR_SETTINGS', { factorRemitTo: { email: 'ap@otr.test' } })).rejects.toThrow(/factorRemitTo\.name/)
  })

  it('brings an archived queue row back when the re-issued invoice is factored again', async () => {
    const first = await generate()
    await call('SEND_TO_FACTOR', { invoiceId: first.invoiceId })
    await call('VOID_INVOICE', { invoiceId: first.invoiceId, reason: 'wrong bill-to' })
    expect(table(TABLES.factoring).get('S000001-1')!.status).toBe('ARCHIVED')
    // The void also lets go of the link, so the re-issued order starts clean.
    expect(table(TABLES.order).get(ORDER_ID)!.factoringItemId).toBeUndefined()

    const second = await generate()
    await call('SEND_TO_FACTOR', { invoiceId: second.invoiceId })
    expect(table(TABLES.factoring).get('S000001-1')).toMatchObject({
      status: 'NEED_TO_FACTOR',
      invoiceId: second.invoiceId,
    })
  })

  it('refuses to repoint a queue row that is already factoring another invoice', async () => {
    const { invoiceId } = await generate()
    await call('SEND_TO_FACTOR', { invoiceId })
    // A second order on the same shipment resolves to the same PRO.
    seedSecondOrder('ord-2')
    const second = (await call('GENERATE_INVOICE', { orderId: 'ord-2' })) as { invoice: Row }
    await expect(call('SEND_TO_FACTOR', { invoiceId: String(second.invoice.id) }))
      .rejects.toThrow(/already on the factoring queue for invoice/)
    expect(table(TABLES.factoring).get('S000001-1')!.invoiceId).toBe(invoiceId)
  })

  it('answers a retried write-off with the row it already posted', async () => {
    const { invoiceId } = await generate()
    const input = { invoiceId, amountCents: 250_000, reason: 'customer went under', clientRequestId: 'wo-1' }
    const first = (await call('WRITE_OFF', input)) as { duplicate: boolean }
    const second = (await call('WRITE_OFF', input)) as { duplicate: boolean }
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(table(TABLES.invoice).get(invoiceId)).toMatchObject({ writtenOffCents: 250_000, status: 'PAID' })
  })

  it('leaves a document voided after issue off the resend', async () => {
    table(TABLES.document).set('doc-1', {
      id: 'doc-1', shipmentId: SHIPMENT_ID, orderId: ORDER_ID, type: 'POD', name: 'POD.pdf',
      s3Key: `shipment-docs/${SHIPMENT_ID}/doc-1-pod.pdf`, contentType: 'application/pdf',
      status: 'ACTIVE', reviewStatus: 'ACCEPTED', audience: 'CUSTOMER', sizeBytes: 1024,
      uploadedAt: '2026-10-20T12:00:00.000Z',
    })
    const { invoiceId } = await generate()
    expect(table(TABLES.invoice).get(invoiceId)!.attachDocumentIds).toContain('doc-1')

    table(TABLES.document).set('doc-1', { ...table(TABLES.document).get('doc-1')!, status: 'VOID' })
    await call('EMAIL_INVOICE', { invoiceId })
    const raw = sesSend.mock.calls[0][0] as { input: { Content: { Raw: { Data: Uint8Array } } } }
    const mime = new TextDecoder().decode(raw.input.Content.Raw.Data)
    expect(mime).not.toContain('POD.pdf')
  })
})

// ── AP: carrier bills & payments (Step G) ───────────────────────────────────

const LOAD_CARRIER_ID = 'lc-1'
const CARRIER_ID = 'car-1'
const AP_USER = {
  sub: 'sub-ap',
  username: 'ap',
  claims: { email: 'ap@bcatcorp.com', 'cognito:groups': ['page-carrierPay'] },
}

/** One brokered assignment, delivered, with its CARRIER line and a payee method. */
function seedAssignment(over: { loadCarrier?: Row; carrier?: Row; method?: Row; settings?: Row } = {}): void {
  if (over.settings) {
    const settings = table(TABLES.settings).get('default') ?? {}
    table(TABLES.settings).set('default', { ...settings, ...over.settings })
  }
  table(TABLES.load).set(LOAD_ID, { ...(table(TABLES.load).get(LOAD_ID) ?? {}), status: 'DELIVERED' })
  table(TABLES.carrier).set(CARRIER_ID, {
    id: CARRIER_ID,
    name: 'Wheeler Trucking',
    mcNumber: '998877',
    status: 'ACTIVE',
    paymentTermsDays: 21,
    email: 'ap@wheeler.test',
    ...over.carrier,
  })
  table(TABLES.carrierMethod).set('cpm-1', {
    id: 'cpm-1',
    carrierId: CARRIER_ID,
    method: 'ACH',
    recipientType: 'CARRIER',
    status: 'ACTIVE',
    isPreferred: true,
    accountLast4: '4321',
    bankDetailsKey: 'carrier-docs/car-1/private/ach.pdf',
    payeeEmail: 'remit@wheeler.test',
    ...over.method,
  })
  table(TABLES.loadCarrier).set(LOAD_CARRIER_ID, {
    id: LOAD_CARRIER_ID,
    loadId: LOAD_ID,
    shipmentId: SHIPMENT_ID,
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: CARRIER_ID,
    carrierName: 'Wheeler Trucking',
    carrierMc: '998877',
    apStatus: 'AWAITING_INVOICE',
    // Every booking path writes this as NULL, not absent — the condition that stops a
    // second bill has to cope with that, so the fixture reproduces it.
    invoiceId: null,
    apOpen: 'OPEN',
    rateConStatus: 'SIGNED',
    costCents: 180_000,
    createdBy: 'a@b.c',
    updatedBy: 'a@b.c',
    ...over.loadCarrier,
  })
  // The CARRIER charge seeded by `seed()` belongs to this assignment.
  const charge = table(TABLES.charge).get('chg-2') ?? {}
  table(TABLES.charge).set('chg-2', { ...charge, loadCarrierId: LOAD_CARRIER_ID })
  // The paperwork AP wants before it pays: POD and the carrier's invoice.
  for (const [id, type] of [['doc-pod', 'POD'], ['doc-inv', 'CARRIER_INVOICE']]) {
    table(TABLES.document).set(id, {
      id,
      shipmentId: SHIPMENT_ID,
      loadId: LOAD_ID,
      loadCarrierId: LOAD_CARRIER_ID,
      type,
      name: `${type}.pdf`,
      status: 'ACTIVE',
      reviewStatus: 'ACCEPTED',
      scope: 'CARRIER',
      audience: 'ALL',
      uploadedAt: '2026-10-21T10:00:00.000Z',
    })
  }
}

async function recordBill(input: Row = {}, identity: unknown = ADMIN): Promise<Row> {
  const result = (await call('RECORD_BILL', { loadCarrierId: LOAD_CARRIER_ID, ...input }, identity)) as { bill: Row }
  return result.bill
}

describe('RECORD_BILL', () => {
  it('writes the bill, the rung and the charge freeze in one transaction', async () => {
    seedAssignment()
    const bill = await recordBill({ billNumber: 'W-5512' })

    expect(bill.id).toBe(`cb:${LOAD_CARRIER_ID}:1`)
    expect(bill.status).toBe('IN_REVIEW')
    expect(bill.grossCents).toBe(180_000)
    expect(bill.netCents).toBe(180_000)
    expect(bill.balanceCents).toBe(180_000)

    const assignment = table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row
    expect(assignment.apStatus).toBe('IN_REVIEW')
    expect(assignment.invoiceId).toBe(bill.id)
    expect(assignment.chargesFinalizedAt).toBeTruthy()
    expect(assignment.apBalanceCents).toBe(180_000)
  })

  it('refuses a second bill on an assignment that already has one', async () => {
    seedAssignment()
    await recordBill()
    await expect(recordBill()).rejects.toThrow(/already/i)
    expect(table(TABLES.carrierBill).size).toBe(1)
  })

  it('refuses an own-fleet leg and says where it is paid instead', async () => {
    seedAssignment({ loadCarrier: { kind: 'OWN_ASSET', carrierId: null } })
    await expect(recordBill()).rejects.toThrow(/settlement/i)
    expect(table(TABLES.carrierBill).size).toBe(0)
  })

  it('refuses a bill against a voided shipment, and still records the TONU', async () => {
    seedAssignment()
    table(TABLES.shipment).set(SHIPMENT_ID, {
      ...table(TABLES.shipment).get(SHIPMENT_ID)!,
      voidedAt: '2026-10-23T00:00:00.000Z',
      voidedBy: 'admin@bcatcorp.com',
      voidReason: 'Double-entered by dispatch',
    })

    await expect(recordBill()).rejects.toThrow(/Shipment S000001 is voided — only a TONU bill may be recorded/)
    expect(table(TABLES.carrierBill).size).toBe(0)

    // The carrier that showed up is still owed, so the TONU goes through.
    table(TABLES.loadCarrier).set(LOAD_CARRIER_ID, {
      ...table(TABLES.loadCarrier).get(LOAD_CARRIER_ID)!,
      status: 'TONU',
    })
    const bill = await recordBill()
    expect(bill.status).toBe('IN_REVIEW')
  })

  it('takes the quick-pay fee once, and the quick-pay days become the terms', async () => {
    seedAssignment({
      loadCarrier: { quickPay: true, quickPayDays: 2, quickPayFeeBps: 300, quickPayFeeCents: 5_400 },
    })
    const bill = await recordBill({ billDate: '2026-10-22' })
    expect(bill.grossCents).toBe(180_000)
    expect(bill.quickPayFeeCents).toBe(5_400)
    expect(bill.netCents).toBe(174_600)
    expect(bill.termsDays).toBe(2)
    expect(bill.dueAt).toBe('2026-10-24')
  })

  it('pays a factored carrier to the factor, with no quick-pay fee', async () => {
    seedAssignment({
      loadCarrier: { quickPay: true, quickPayDays: 2, quickPayFeeCents: 5_400 },
      method: { recipientType: 'FACTOR', factorName: 'Apex Capital' },
    })
    const bill = await recordBill()
    expect(bill.payeeKind).toBe('FACTOR')
    expect(bill.quickPayFeeCents).toBe(0)
    expect(bill.netCents).toBe(180_000)
    expect((bill.remitTo as Row).name).toBe('Apex Capital')
    // The account itself stays in the carrier directory, behind S3.
    expect(JSON.stringify(bill.remitTo)).not.toContain('bankDetailsKey')
  })

  it('records and approves in one press when the gate is clear', async () => {
    seedAssignment()
    const bill = await recordBill({ approve: true })
    expect(bill.status).toBe('TO_BE_PAID')
    expect(bill.approvedBy).toBe('admin@bcatcorp.com')
    expect((table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row).apStatus).toBe('TO_BE_PAID')
  })

  it('refuses to approve on the way in when the paperwork is missing', async () => {
    seedAssignment()
    table(TABLES.document).delete('doc-pod')
    await expect(recordBill({ approve: true })).rejects.toThrow(/paperwork is missing/i)
    // Nothing is written: the bill and the approval are one transaction.
    expect(table(TABLES.carrierBill).size).toBe(0)
    expect((table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row).apStatus).toBe('AWAITING_INVOICE')
  })
})

describe('APPROVE_BILL', () => {
  it('refuses a bill whose amount disagrees with its lines', async () => {
    seedAssignment()
    const bill = await recordBill({ billedCents: 185_000 })
    expect(bill.varianceCents).toBe(5_000)
    await expect(call('APPROVE_BILL', { billId: bill.id })).rejects.toThrow(/\$1,850\.00|variance|differs/i)
  })

  it('blocks an unsigned rate con for a rep and lets an admin acknowledge it', async () => {
    seedAssignment({ loadCarrier: { rateConStatus: 'SENT' } })
    const bill = await recordBill({}, AP_USER)
    await expect(call('APPROVE_BILL', { billId: bill.id }, AP_USER)).rejects.toThrow(/rate con|Forbidden/i)

    const approved = (await call('APPROVE_BILL', {
      billId: bill.id,
      acknowledgeWarnings: ['RATE_CON_UNSIGNED'],
    })) as { bill: Row }
    expect(approved.bill.status).toBe('TO_BE_PAID')
    expect(approved.bill.approvalWarnings).toContain('RATE_CON_UNSIGNED')
  })

  it('records who overrode the paperwork gate and why', async () => {
    seedAssignment()
    table(TABLES.document).delete('doc-pod')
    const bill = await recordBill()
    const approved = (await call('APPROVE_BILL', {
      billId: bill.id,
      docsOverrideNote: 'POD came by fax; filed in the carrier packet',
    })) as { bill: Row }
    expect(approved.bill.status).toBe('TO_BE_PAID')
    expect(approved.bill.docsOverrideBy).toBe('admin@bcatcorp.com')
    expect(approved.bill.docsOverrideNote).toContain('fax')
  })
})

describe('RECORD_AP_PAYMENT', () => {
  async function approvedBill(over: Row = {}): Promise<Row> {
    seedAssignment()
    return recordBill({ approve: true, ...over })
  }

  it('settles the bill and the assignment only when the balance reaches zero', async () => {
    const bill = await approvedBill()
    const partial = (await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 80_000,
      applications: [{ billId: bill.id, amountCents: 80_000 }],
    })) as { bills: Row[] }
    expect(partial.bills[0].status).toBe('PARTIAL')
    expect(partial.bills[0].balanceCents).toBe(100_000)
    expect((table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row).apStatus).toBe('TO_BE_PAID')

    const rest = (await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-26',
      method: 'ACH',
      amountCents: 100_000,
      applications: [{ billId: bill.id, amountCents: 100_000 }],
    })) as { bills: Row[] }
    expect(rest.bills[0].status).toBe('PAID')
    expect(rest.bills[0].balanceCents).toBe(0)
    expect(rest.bills[0].apOpen).toBeUndefined()

    const assignment = table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row
    expect(assignment.apStatus).toBe('PAID')
    expect(assignment.apOpen).toBeUndefined()
    expect(assignment.apPaidAt).toBeTruthy()
  })

  it('refuses cash it cannot allocate', async () => {
    const bill = await approvedBill()
    await expect(
      call('RECORD_AP_PAYMENT', {
        carrierId: CARRIER_ID,
        paidAt: '2026-10-25',
        method: 'ACH',
        amountCents: 200_000,
        applications: [{ billId: bill.id, amountCents: 180_000 }],
      }),
    ).rejects.toThrow(/allocated in full/i)
    expect(table(TABLES.apPayment).size).toBe(0)
  })

  it('refuses to pay a bill that has not been approved', async () => {
    seedAssignment()
    const bill = await recordBill()
    await expect(
      call('RECORD_AP_PAYMENT', {
        carrierId: CARRIER_ID,
        paidAt: '2026-10-25',
        method: 'ACH',
        amountCents: 180_000,
        applications: [{ billId: bill.id, amountCents: 180_000 }],
      }),
    ).rejects.toThrow(/approved/i)
  })

  it('pays part from a credit and records which part that was', async () => {
    const bill = await approvedBill()
    const credit = (await call('CREATE_AP_CREDIT', {
      carrierId: CARRIER_ID,
      memoDate: '2026-10-24',
      amountCents: 30_000,
      reason: 'Cargo claim withheld',
    })) as { payment: Row }

    const paid = (await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 150_000,
      applications: [{ billId: bill.id, amountCents: 180_000 }],
      creditApplications: [{ paymentId: credit.payment.id, amountCents: 30_000 }],
    })) as { payment: Row; bills: Row[] }

    expect(paid.bills[0].status).toBe('PAID')
    expect(paid.bills[0].paidCents).toBe(150_000)
    expect(paid.bills[0].creditedCents).toBe(30_000)
    expect((table(TABLES.apPayment).get(String(credit.payment.id)) as Row).unappliedCents).toBe(0)
  })

  it('reverses a credit-funded payment back to both columns', async () => {
    const bill = await approvedBill()
    const credit = (await call('CREATE_AP_CREDIT', {
      carrierId: CARRIER_ID,
      memoDate: '2026-10-24',
      amountCents: 30_000,
      reason: 'Cargo claim withheld',
    })) as { payment: Row }
    const paid = (await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 150_000,
      applications: [{ billId: bill.id, amountCents: 180_000 }],
      creditApplications: [{ paymentId: credit.payment.id, amountCents: 30_000 }],
    })) as { payment: Row }

    await call('REVERSE_AP_PAYMENT', { paymentId: paid.payment.id, reason: 'Paid the wrong carrier' })

    const after = table(TABLES.carrierBill).get(String(bill.id)) as Row
    expect(after.paidCents).toBe(0)
    expect(after.creditedCents).toBe(0)
    expect(after.balanceCents).toBe(180_000)
    expect(after.status).toBe('TO_BE_PAID')
    // The claim is ours to spend again.
    expect((table(TABLES.apPayment).get(String(credit.payment.id)) as Row).unappliedCents).toBe(30_000)
  })

  it('refuses a payment against a bill somebody pulled back to review', async () => {
    const bill = await approvedBill()
    const original = send.getMockImplementation()
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        const row = table(TABLES.carrierBill).get(String(bill.id)) as Row
        table(TABLES.carrierBill).set(String(bill.id), { ...row, status: 'IN_REVIEW' })
      }
      return original?.(cmd)
    })
    await expect(
      call('RECORD_AP_PAYMENT', {
        carrierId: CARRIER_ID,
        paidAt: '2026-10-25',
        method: 'ACH',
        amountCents: 180_000,
        applications: [{ billId: bill.id, amountCents: 180_000 }],
      }),
    ).rejects.toThrow(/changed by someone else/i)
    send.mockImplementation(original as never)
    expect((table(TABLES.carrierBill).get(String(bill.id)) as Row).paidCents).toBe(0)
  })

  it('posts once when the same request is sent twice', async () => {
    const bill = await approvedBill()
    const body = {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 180_000,
      applications: [{ billId: bill.id, amountCents: 180_000 }],
      clientRequestId: 'press-1',
    }
    await call('RECORD_AP_PAYMENT', body)
    const again = (await call('RECORD_AP_PAYMENT', body)) as { duplicate: boolean }
    expect(again.duplicate).toBe(true)
    expect(table(TABLES.apPayment).size).toBe(1)
    expect((table(TABLES.carrierBill).get(String(bill.id)) as Row).paidCents).toBe(180_000)
  })

  it('loses to a payment that moved the bill underneath it', async () => {
    const bill = await approvedBill()
    const body = {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 90_000,
      applications: [{ billId: bill.id, amountCents: 90_000 }],
    }
    // Somebody else's payment lands between this one's read and its write.
    const original = send.getMockImplementation()
    let armed = true
    send.mockImplementation((cmd: MockCommand) => {
      if (armed && cmd.__type === 'Transact') {
        armed = false
        const row = table(TABLES.carrierBill).get(String(bill.id)) as Row
        table(TABLES.carrierBill).set(String(bill.id), { ...row, paidCents: 90_000, balanceCents: 90_000 })
      }
      return original?.(cmd)
    })
    await expect(call('RECORD_AP_PAYMENT', body)).rejects.toThrow(/changed by someone else/i)
    send.mockImplementation(original as never)
    // The bill still carries only the other payment's money.
    expect((table(TABLES.carrierBill).get(String(bill.id)) as Row).paidCents).toBe(90_000)
  })
})

describe('REVERSE_AP_PAYMENT', () => {
  it('restores the bill and reopens the assignment', async () => {
    seedAssignment()
    const bill = await recordBill({ approve: true })
    const paid = (await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 180_000,
      applications: [{ billId: bill.id, amountCents: 180_000 }],
    })) as { payment: Row }

    await call('REVERSE_AP_PAYMENT', { paymentId: paid.payment.id, reason: 'Wrong account' })

    const after = table(TABLES.carrierBill).get(String(bill.id)) as Row
    expect(after.paidCents).toBe(0)
    expect(after.balanceCents).toBe(180_000)
    expect(after.status).toBe('TO_BE_PAID')
    expect(after.apOpen).toBe('OPEN')
    const assignment = table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row
    expect(assignment.apStatus).toBe('TO_BE_PAID')
    expect(assignment.apOpen).toBe('OPEN')
    expect(assignment.apPaidAt).toBeUndefined()
  })

  it('refuses a second reversal', async () => {
    seedAssignment()
    const bill = await recordBill({ approve: true })
    const paid = (await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 180_000,
      applications: [{ billId: bill.id, amountCents: 180_000 }],
    })) as { payment: Row }
    await call('REVERSE_AP_PAYMENT', { paymentId: paid.payment.id, reason: 'Wrong account' })
    await expect(
      call('REVERSE_AP_PAYMENT', { paymentId: paid.payment.id, reason: 'again' }),
    ).rejects.toThrow(/reversed/i)
  })
})

describe('VOID_BILL', () => {
  it('releases the assignment and unfreezes its charges', async () => {
    seedAssignment()
    const bill = await recordBill()
    await call('VOID_BILL', { billId: bill.id, reason: 'Carrier re-invoiced' })

    const voided = table(TABLES.carrierBill).get(String(bill.id)) as Row
    expect(voided.status).toBe('VOID')
    expect(voided.apOpen).toBeUndefined()
    const assignment = table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row
    expect(assignment.apStatus).toBe('AWAITING_INVOICE')
    expect(assignment.invoiceId).toBeNull()
    expect(assignment.chargesFinalizedAt).toBeUndefined()
  })

  it('refuses while money is on the bill', async () => {
    seedAssignment()
    const bill = await recordBill({ approve: true })
    await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      amountCents: 10_000,
      applications: [{ billId: bill.id, amountCents: 10_000 }],
    })
    await expect(call('VOID_BILL', { billId: bill.id, reason: 'oops' })).rejects.toThrow(/reverse the payment/i)
  })
})

describe('SEND_REMITTANCE', () => {
  it('records NOT_SENT with a download when SES refuses, and stamps nothing', async () => {
    seedAssignment()
    const bill = await recordBill({ approve: true })
    const paid = (await call('RECORD_AP_PAYMENT', {
      carrierId: CARRIER_ID,
      paidAt: '2026-10-25',
      method: 'ACH',
      reference: 'ACH-88120',
      amountCents: 180_000,
      applications: [{ billId: bill.id, amountCents: 180_000 }],
    })) as { payment: Row }

    sesSend.mockRejectedValueOnce(new Error('Email address is not verified'))
    const sent = (await call('SEND_REMITTANCE', { paymentId: paid.payment.id })) as {
      emailStatus: string
      downloads: { url: string }[]
      body: string
    }
    expect(sent.emailStatus).toBe('NOT_SENT')
    expect(sent.body).toContain('ACH-88120')
    expect(sent.downloads.length).toBe(1)
    expect((table(TABLES.apPayment).get(String(paid.payment.id)) as Row).remittanceSentAt).toBeUndefined()
  })
})

describe('AP authorization', () => {
  it('refuses every AP action to a user who may only invoice', async () => {
    seedAssignment()
    await expect(call('PREVIEW_BILL', { loadCarrierId: LOAD_CARRIER_ID }, BILLER)).rejects.toThrow(
      /page-carrierPay/,
    )
  })

  it('lets an AP rep record a bill but not pay one', async () => {
    seedAssignment()
    const bill = await recordBill({}, AP_USER)
    expect(bill.status).toBe('IN_REVIEW')
    await expect(
      call('RECORD_AP_PAYMENT', {
        carrierId: CARRIER_ID,
        paidAt: '2026-10-25',
        method: 'ACH',
        amountCents: 1,
        applications: [{ billId: bill.id, amountCents: 1 }],
      }, AP_USER),
    ).rejects.toThrow(/owner or ADMIN/)
  })

  it('refuses "Record and approve" to a rep while approval is admin-only', async () => {
    seedAssignment()
    await expect(recordBill({ approve: true }, AP_USER)).rejects.toThrow(/owner or ADMIN/)
    // The bill is not quietly recorded unapproved either: the press is one act.
    expect(table(TABLES.carrierBill).size).toBe(0)
    expect((table(TABLES.loadCarrier).get(LOAD_CARRIER_ID) as Row).apStatus).toBe('AWAITING_INVOICE')
  })

  it('lets a rep record and approve once the org turns the toggle off', async () => {
    seedAssignment({ settings: { apApprovalAdminOnly: false } })
    const bill = await recordBill({ approve: true }, AP_USER)
    expect(bill.status).toBe('TO_BE_PAID')
    expect(bill.approvedBy).toBe('ap@bcatcorp.com')
  })
})

// ── commissions (Step I) ────────────────────────────────────────────────────

const COMMISSION_REP = {
  sub: 'sub-rep',
  username: 'rep',
  claims: { email: 'owner1@bcatcorp.com', 'cognito:groups': ['page-commissions'] },
}
const COMMISSION_MANAGER = {
  sub: 'sub-mgr',
  username: 'mgr',
  claims: { email: 'boss@bcatcorp.com', 'cognito:groups': ['page-commissions', 'role-MANAGER'] },
}

/** A house plan paying the primary account owner 10 % of the gross profit. */
const HOUSE_PLAN = {
  id: 'plan-house',
  name: 'House plan',
  active: true,
  roles: [{ roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rateBps: 1000 }],
}

function seedCommissions(over: { settings?: Row; customer?: Row } = {}): void {
  seed({
    settings: { commissionsEnabled: true, commissionPlans: [HOUSE_PLAN], ...over.settings },
    customer: { accountOwnerIds: ['owner1@bcatcorp.com'], teamKey: 'EAST', ...over.customer },
  })
  table(TABLES.userProfile).set('owner1@bcatcorp.com', {
    id: 'owner1@bcatcorp.com',
    email: 'owner1@bcatcorp.com',
    name: 'Owner One',
    role: 'CUSTOMER_REP',
    managerId: 'boss@bcatcorp.com',
    version: 1,
  })
}

function commissionRows(): Row[] {
  return [...table(TABLES.commission).values()]
}

describe('commissions', () => {
  it('writes one row per role when the invoice freezes the money, and nothing the second time', async () => {
    seedCommissions()
    const { invoiceId } = await generate()

    const rows = commissionRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      repId: 'owner1@bcatcorp.com',
      roleName: 'PRIMARY_ACCOUNT_OWNER',
      revenueCents: 250_000,
      costCents: 180_000,
      profitCents: 70_000,
      amountCents: 7_000,
      netCents: 7_000,
      status: 'UN_APPROVED',
      invoiceId,
    })

    const report = (await call('RUN_COMMISSIONS', { invoiceId })) as { reports: Row[] }
    expect(report.reports[0]).toMatchObject({ puts: 0, updates: 0, adjustments: 0, untouched: 1 })
    expect(commissionRows()).toHaveLength(1)
  })

  it('writes nothing at all while commissions are switched off', async () => {
    seed({ customer: { accountOwnerIds: ['owner1@bcatcorp.com'] } })
    await generate()
    expect(commissionRows()).toHaveLength(0)
    await expect(call('RUN_COMMISSIONS', { invoiceId: 'inv-x' })).rejects.toThrow(/turned off/)
  })

  it('refuses the commission desk to a user who only holds page-invoicing', async () => {
    seedCommissions()
    await expect(call('RUN_COMMISSIONS', { month: '2026-10' }, BILLER)).rejects.toThrow(/page-commissions/)
  })

  it('refuses to compute before the invoice is paid when that is the trigger', async () => {
    seedCommissions({ settings: { commissionTrigger: 'INVOICE_PAID' } })
    await generate()
    expect(commissionRows()).toHaveLength(0)
  })

  it('pays on the invoice the plan was waiting for once the customer settles it', async () => {
    seedCommissions({ settings: { commissionTrigger: 'INVOICE_PAID' } })
    const { invoiceId } = await generate()
    await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID,
      receivedAt: '2026-10-25',
      method: 'ACH',
      amountCents: 250_000,
      applications: [{ invoiceId, amountCents: 250_000 }],
    })
    expect(commissionRows()).toHaveLength(1)
    expect(commissionRows()[0]).toMatchObject({ trigger: 'INVOICE_PAID', amountCents: 7_000 })
  })

  it('lowers the basis when revenue is written off, rewriting the unapproved row in place', async () => {
    seedCommissions()
    const { invoiceId } = await generate()
    await call('WRITE_OFF', { invoiceId, amountCents: 50_000, reason: 'short pay', clientRequestId: 'wo-1' })

    const rows = commissionRows()
    expect(rows).toHaveLength(1)
    // Revenue $2,500 − $500 written off = $2,000; profit $200; 10 % = $20.00.
    expect(rows[0]).toMatchObject({ revenueCents: 200_000, profitCents: 20_000, amountCents: 2_000, source: 'WRITE_OFF' })
  })

  it('never rewrites an approved row: the difference arrives as its own adjustment', async () => {
    seedCommissions()
    const { invoiceId } = await generate()
    const id = String(commissionRows()[0].id)

    await call('APPROVE_COMMISSION', { commissionId: id }, COMMISSION_MANAGER)
    expect((table(TABLES.commission).get(id) as Row).status).toBe('MANAGER_APPROVED')

    await call('WRITE_OFF', { invoiceId, amountCents: 50_000, reason: 'short pay', clientRequestId: 'wo-2' })

    const rows = commissionRows()
    expect(rows).toHaveLength(2)
    const earned = rows.find((r) => r.kind === 'EARNED') as Row
    const adjustment = rows.find((r) => r.kind === 'ADJUSTMENT') as Row
    expect(earned.amountCents).toBe(7_000)
    expect(earned.status).toBe('MANAGER_APPROVED')
    expect(adjustment).toMatchObject({ amountCents: -5_000, adjustsId: id, status: 'UN_APPROVED' })
  })

  it('cancels an unapproved commission and reverses an approved one when the invoice is voided', async () => {
    seedCommissions()
    const { invoiceId } = await generate()
    const openId = String(commissionRows()[0].id)
    await call('VOID_INVOICE', { invoiceId, reason: 'rebill' })
    expect((table(TABLES.commission).get(openId) as Row)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'INVOICE_VOIDED',
      netCents: 0,
    })

    // Again, this time with the row approved before the void.
    store.clear()
    seedCommissions()
    const second = await generate()
    const approvedId = String(commissionRows()[0].id)
    await call('APPROVE_COMMISSION', { commissionId: approvedId }, ADMIN)
    await call('VOID_INVOICE', { invoiceId: second.invoiceId, reason: 'rebill' })

    const after = commissionRows()
    expect((table(TABLES.commission).get(approvedId) as Row).status).toBe('FULLY_APPROVED')
    const reversal = after.find((r) => r.kind === 'REVERSAL') as Row
    expect(reversal).toMatchObject({ amountCents: -7_000, adjustsId: approvedId })
  })

  it('lets a rep counter only their own row, and the manager answer it', async () => {
    seedCommissions()
    await generate()
    const id = String(commissionRows()[0].id)

    await expect(
      call('APPROVE_COMMISSION', { commissionId: id }, COMMISSION_REP),
    ).rejects.toThrow(/cannot be approved by you/)

    await call('COUNTER_COMMISSION', { commissionId: id, amountCents: 9_000, note: 'I booked it' }, COMMISSION_REP)
    expect((table(TABLES.commission).get(id) as Row).status).toBe('REP_COUNTERED')

    await call('ACCEPT_COMMISSION_COUNTER', { commissionId: id }, COMMISSION_MANAGER)
    const row = table(TABLES.commission).get(id) as Row
    expect(row).toMatchObject({ status: 'FULLY_APPROVED', netCents: 9_000, amountCents: 7_000 })
  })

  it('keeps the computed number beside an override and demands a reason', async () => {
    seedCommissions()
    await generate()
    const id = String(commissionRows()[0].id)
    await expect(
      call('OVERRIDE_COMMISSION', { commissionId: id, amountCents: 12_500 }, COMMISSION_MANAGER),
    ).rejects.toThrow(/note/)

    await call('OVERRIDE_COMMISSION', { commissionId: id, amountCents: 12_500, note: 'agreed with Ryne' }, COMMISSION_MANAGER)
    expect(table(TABLES.commission).get(id)).toMatchObject({
      amountCents: 7_000,
      overrideCents: 12_500,
      netCents: 12_500,
    })
  })

  it('keeps a manager off the ladder entirely when approval is admin-only', async () => {
    seedCommissions({ settings: { commissionApprovalAdminOnly: true } })
    await generate()
    const id = String(commissionRows()[0].id)
    await expect(call('APPROVE_COMMISSION', { commissionId: id }, COMMISSION_MANAGER)).rejects.toThrow(/cannot be approved/)
    await call('APPROVE_COMMISSION', { commissionId: id }, ADMIN)
    expect((table(TABLES.commission).get(id) as Row).status).toBe('FULLY_APPROVED')
  })

  it('pays an own-fleet order nothing under a profit plan and says why', async () => {
    seedCommissions()
    table(TABLES.loadCarrier).set('lc-own', {
      id: 'lc-own',
      loadId: LOAD_ID,
      shipmentId: SHIPMENT_ID,
      kind: 'OWN_ASSET',
      status: 'ACTIVE',
    })
    table(TABLES.financials).set(LOAD_ID, {
      ...(table(TABLES.financials).get(LOAD_ID) as Row),
      costCents: 0,
    })
    await generate()
    expect(commissionRows()[0]).toMatchObject({
      amountCents: 0,
      basisNote: 'OWN_FLEET_NO_COST',
      needsReview: true,
    })
  })

  it('carries a period from open to paid and stamps every row exactly once', async () => {
    seedCommissions({ settings: { commissionPaySchedule: { frequency: 'MONTHLY', daysUntilPay: 5 } } })
    await generate()
    const id = String(commissionRows()[0].id)
    await call('APPROVE_COMMISSION', { commissionId: id }, ADMIN)

    const opened = (await call('OPEN_PAY_PERIOD', { periodStart: '2026-10-20' })) as { payPeriod: Row }
    const payPeriodId = String(opened.payPeriod.id)
    expect(opened.payPeriod).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', status: 'OPEN' })

    const submitted = (await call('SUBMIT_PAY_PERIOD', { payPeriodId })) as { payPeriod: Row; claimed: number }
    expect(submitted.claimed).toBe(1)
    expect(submitted.payPeriod).toMatchObject({ status: 'PENDING_APPROVAL', totalCents: 7_000, commissionCount: 1 })
    expect((table(TABLES.commission).get(id) as Row).payPeriodId).toBe(payPeriodId)

    await expect(call('PAY_PAY_PERIOD', { payPeriodId, reference: 'PR-1' })).rejects.toThrow(/only an approved period/)
    await call('APPROVE_PAY_PERIOD', { payPeriodId })
    const paid = (await call('PAY_PAY_PERIOD', { payPeriodId, paidAt: '2026-11-05', reference: 'PR-1' })) as { paid: number }
    expect(paid.paid).toBe(1)
    expect(table(TABLES.commission).get(id)).toMatchObject({ status: 'PAID', paymentRef: 'PR-1' })

    // A paid period is closed: nobody can be paid out of it a second time.
    await expect(call('PAY_PAY_PERIOD', { payPeriodId, reference: 'PR-2' })).rejects.toThrow(/only an approved period/)
    await expect(call('SUBMIT_PAY_PERIOD', { payPeriodId })).rejects.toThrow(/PAID, not open/)
    expect(table(TABLES.commission).get(id)).toMatchObject({ status: 'PAID', paymentRef: 'PR-1' })
  })

  it('refuses to pay a period without the payroll reference it was paid under', async () => {
    seedCommissions()
    const opened = (await call('OPEN_PAY_PERIOD', {})) as { payPeriod: Row }
    await expect(
      call('PAY_PAY_PERIOD', { payPeriodId: String(opened.payPeriod.id) }),
    ).rejects.toThrow(/reference/)
  })

  it('refuses a commission plan the engine could not act on', async () => {
    await expect(
      call('SAVE_COMMISSION_SETTINGS', {
        commissionPlans: [{ id: 'p', name: 'P', roles: [{ roleName: 'NOBODY', rateType: 'PERCENT_PROFIT', rateBps: 100 }] }],
      }),
    ).rejects.toThrow(/not a commission role/)
    await expect(
      call('SAVE_COMMISSION_SETTINGS', { commissionsEnabled: true }, COMMISSION_MANAGER),
    ).rejects.toThrow(/owner or ADMIN/)
  })

  it('previews what an order would pay without writing anything', async () => {
    seedCommissions()
    await generate()
    store.get(TABLES.commission)?.clear()
    const preview = (await call('PREVIEW_COMMISSIONS', { orderId: ORDER_ID })) as { rows: Row[] }
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0]).toMatchObject({ amountCents: 7_000 })
    expect(commissionRows()).toHaveLength(0)
  })
})

describe('commissions — the ladder closes and the period nets (review fixes)', () => {
  it('a manager approves, an admin closes, and the period claims it', async () => {
    seedCommissions()
    await generate()
    const id = String(commissionRows()[0].id)

    await call('APPROVE_COMMISSION', { commissionId: id }, COMMISSION_MANAGER)
    expect((table(TABLES.commission).get(id) as Row).status).toBe('MANAGER_APPROVED')

    await call('APPROVE_COMMISSION', { commissionId: id }, ADMIN)
    expect((table(TABLES.commission).get(id) as Row).status).toBe('FULLY_APPROVED')

    const opened = (await call('OPEN_PAY_PERIOD', { periodStart: '2026-10-20' })) as { payPeriod: Row }
    const submitted = (await call('SUBMIT_PAY_PERIOD', { payPeriodId: String(opened.payPeriod.id) })) as { claimed: number }
    expect(submitted.claimed).toBe(1)
  })

  it('refuses a manager who tries to approve their own commission', async () => {
    seedCommissions({ customer: { accountOwnerIds: ['boss@bcatcorp.com'] } })
    table(TABLES.userProfile).set('boss@bcatcorp.com', {
      id: 'boss@bcatcorp.com', email: 'boss@bcatcorp.com', role: 'MANAGER', version: 1,
    })
    await generate()
    const id = String(commissionRows()[0].id)
    await expect(call('APPROVE_COMMISSION', { commissionId: id }, COMMISSION_MANAGER)).rejects.toThrow(/cannot be approved by you/)
    // They may still argue their own number.
    await call('COUNTER_COMMISSION', { commissionId: id, amountCents: 9_000, note: 'mine' }, COMMISSION_MANAGER)
    expect((table(TABLES.commission).get(id) as Row).status).toBe('REP_COUNTERED')
  })

  it('nets a late adjustment into the period that is open now, not the one it was earned in', async () => {
    seedCommissions()
    const { invoiceId } = await generate()
    const id = String(commissionRows()[0].id)
    await call('APPROVE_COMMISSION', { commissionId: id }, COMMISSION_MANAGER)
    await call('APPROVE_COMMISSION', { commissionId: id }, ADMIN)
    await call('WRITE_OFF', { invoiceId, amountCents: 50_000, reason: 'short pay', clientRequestId: 'wo-late' })

    const adjustment = commissionRows().find((r) => r.kind === 'ADJUSTMENT') as Row
    expect(adjustment.amountCents).toBe(-5_000)
    const adjustmentId = String(adjustment.id)
    await call('APPROVE_COMMISSION', { commissionId: adjustmentId }, COMMISSION_MANAGER)
    await call('APPROVE_COMMISSION', { commissionId: adjustmentId }, ADMIN)

    // A period opened later still sweeps the earlier adjustment in, so the
    // overpayment is taken back instead of sitting approved forever.
    const opened = (await call('OPEN_PAY_PERIOD', { periodStart: '2026-12-05' })) as { payPeriod: Row }
    const submitted = (await call('SUBMIT_PAY_PERIOD', { payPeriodId: String(opened.payPeriod.id) })) as {
      claimed: number
      payPeriod: Row
    }
    expect(submitted.claimed).toBe(2)
    expect(submitted.payPeriod.totalCents).toBe(7_000 - 5_000)
  })
})

// ── REPOINT_INVOICED_CUSTOMER ──────────────────────────────────────────────

const TARGET_ID = 'cus-target'
const TARGET_ID2 = 'cus-target2'

describe('REPOINT_INVOICED_CUSTOMER', () => {
  beforeEach(() => {
    table(TABLES.customer).set(TARGET_ID, {
      id: TARGET_ID,
      name: 'Acme Logistics',
      billingEmail: 'ar@acmelogistics.test',
      contacts: [],
      billToParties: [],
    })
    table(TABLES.customer).set(TARGET_ID2, {
      id: TARGET_ID2,
      name: 'Acme Warehousing',
      billingEmail: 'ar@acmewarehousing.test',
      contacts: [],
      billToParties: [],
    })
  })

  async function repoint(input: Row = {}, identity: unknown = ADMIN) {
    return handler({
      arguments: { action: 'REPOINT_INVOICED_CUSTOMER', input: JSON.stringify(input) },
      identity,
    } as never)
  }

  async function invoicedShipment() {
    seed()
    const { invoiceId, number } = await generate()
    return { invoiceId, number }
  }

  it('refuses a non-admin user', async () => {
    await invoicedShipment()
    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'test', idempotencyKey: 'k1' }, DISPATCHER),
    ).rejects.toThrow('Forbidden')
  })

  it('refuses when the target customer is the same as the current one', async () => {
    await invoicedShipment()
    const err = repoint({ shipmentId: SHIPMENT_ID, customerId: CUSTOMER_ID, reason: 'test', idempotencyKey: 'k1' })
    await expect(err).rejects.toThrow('already belongs to this customer')
  })

  it('refuses a voided shipment', async () => {
    await invoicedShipment()
    const ship = table(TABLES.shipment).get(SHIPMENT_ID)!
    ship.voidedAt = '2026-10-29T12:00:00.000Z'
    table(TABLES.shipment).set(SHIPMENT_ID, ship)
    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'test', idempotencyKey: 'k1' }),
    ).rejects.toThrow('Cannot repoint a voided shipment')
  })

  it('refuses a missing or inactive target customer', async () => {
    await invoicedShipment()
    table(TABLES.customer).set('cus-dead', {
      id: 'cus-dead',
      name: 'Deactivated Inc',
      active: false,
    })
    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: 'cus-dead', reason: 'test', idempotencyKey: 'k1' }),
    ).rejects.toThrow('inactive')
    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: 'cus-ghost', reason: 'test', idempotencyKey: 'k1' }),
    ).rejects.toThrow('not found')
  })

  it('credits an ISSUED invoice for its full balance and puts the order back on the gate', async () => {
    const { invoiceId, number } = await invoicedShipment()
    const invoice = table(TABLES.invoice).get(invoiceId) as Row
    expect(invoice.status).toBe('ISSUED')
    const balance = invoice.balanceCents as number
    expect(balance).toBe(250_000)

    const result = (await repoint({
      shipmentId: SHIPMENT_ID,
      customerId: TARGET_ID,
      reason: 'billing department change',
      idempotencyKey: 'key-credit',
    })) as Row

    expect(result.duplicate).toBe(false)
    expect(result.creditedCents).toBe(250_000)

    const arPayments = [...table(TABLES.arPayment).values()]
    expect(arPayments).toHaveLength(1)
    const payment = arPayments[0]
    expect(payment.kind).toBe('CREDIT_MEMO')
    expect(payment.amountCents).toBe(250_000)
    expect(payment.appliedCents).toBe(250_000)
    expect(payment.unappliedCents).toBe(0)
    expect((payment.applications as Row[])[0].invoiceId).toBe(invoiceId)
    expect((payment.applications as Row[])[0].amountCents).toBe(250_000)

    // Invoice row: balance zero, paid, but number / total / lines untouched.
    const updated = table(TABLES.invoice).get(invoiceId) as Row
    expect(updated.status).toBe('PAID')
    expect(updated.balanceCents).toBe(0)
    expect(updated.paidCents).toBe(250_000)
    expect(updated.paidAt).toBeTruthy()
    expect(updated.arOpen).toBeUndefined()
    expect(updated.number).toBe(number)
    expect(updated.totalCents).toBe(250_000)
    expect(updated.lines).toEqual(invoice.lines)

    // Order is back on the gate.
    const order = table(TABLES.order).get(ORDER_ID) as Row
    expect(order.arStatus).toBe('UNBILLED')
    expect(order.invoiceId).toBeUndefined()
    expect(order.invoiceNumber).toBeUndefined()
    expect(order.customerId).toBe(TARGET_ID)
    expect(order.customerName).toBe('Acme Logistics')

    const shipment = table(TABLES.shipment).get(SHIPMENT_ID) as Row
    expect(shipment.customerId).toBe(TARGET_ID)
    expect(shipment.customerName).toBe('Acme Logistics')

    const load = table(TABLES.load).get(LOAD_ID) as Row
    expect(load.customerId).toBe(TARGET_ID)
    expect(load.customer).toBe('Acme Logistics')
  })

  it('a replay with the same idempotencyKey writes nothing new', async () => {
    await invoicedShipment()

    const first = (await repoint({
      shipmentId: SHIPMENT_ID,
      customerId: TARGET_ID,
      reason: 'test replay',
      idempotencyKey: 'key-replay',
    })) as Row
    expect(first.duplicate).toBe(false)

    const arPaymentCount = [...table(TABLES.arPayment).values()].length

    const second = (await repoint({
      shipmentId: SHIPMENT_ID,
      customerId: TARGET_ID,
      reason: 'test replay',
      idempotencyKey: 'key-replay',
    })) as Row
    expect(second.duplicate).toBe(true)
    expect(second.creditedCents).toBe(250_000)
    expect([...table(TABLES.arPayment).values()]).toHaveLength(arPaymentCount)
  })

  it('two different keys cannot credit the same invoice twice', async () => {
    await invoicedShipment()

    await repoint({
      shipmentId: SHIPMENT_ID,
      customerId: TARGET_ID,
      reason: 'first move',
      idempotencyKey: 'key-a',
    })

    // At this point the invoice is PAID and the order has no invoiceId, so a
    // second repoint with a new key would see no open invoices to credit.
    // Even if the caller tries, it cannot reach the old invoice.
    await repoint({
      shipmentId: SHIPMENT_ID,
      customerId: TARGET_ID2,
      reason: 'second move',
      idempotencyKey: 'key-b',
    })

    // No new ArPayment rows beyond the first.
    const payments = [...table(TABLES.arPayment).values()]
    expect(payments).toHaveLength(1)
    expect(payments[0].reference).toBe('key-a')

    // The second repoint did re-point again (different customer), but did not
    // touch the invoice.
    const shipment = table(TABLES.shipment).get(SHIPMENT_ID) as Row
    expect(shipment.customerId).toBe(TARGET_ID2)
  })

  it('refuses an invoice that already has a payment applied', async () => {
    const { invoiceId } = await invoicedShipment()
    await call('RECORD_PAYMENT', {
      customerId: CUSTOMER_ID,
      receivedAt: '2026-10-25',
      method: 'CHECK',
      amountCents: 50_000,
      applications: [{ invoiceId, amountCents: 50_000 }],
    })

    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'late move', idempotencyKey: 'k-paid' }),
    ).rejects.toThrow(/payment or write-off/)
  })

  it('refuses an invoice that has a write-off', async () => {
    const { invoiceId } = await invoicedShipment()
    await call('WRITE_OFF', { invoiceId, amountCents: 25_000, reason: 'short pay', clientRequestId: 'wo-repoint' })

    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'late move', idempotencyKey: 'k-wo' }),
    ).rejects.toThrow(/payment or write-off/)
  })

  it('refuses a biller when arPostingAdminOnly is turned off', async () => {
    seed({ settings: { arPostingAdminOnly: false } })
    await generate()

    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'test', idempotencyKey: 'k-admin' }, BILLER),
    ).rejects.toThrow(/owner or ADMIN/)
  })

  it('runs commissions for every credited invoice as a write-off', async () => {
    seedCommissions()
    await generate()
    const originalId = String(commissionRows()[0].id)

    await repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'account change', idempotencyKey: 'k-comm' })

    const row = table(TABLES.commission).get(originalId) as Row
    expect(row.status).toBe('CANCELLED')
  })

  it('refuses the target customer when credit policy requires an approved limit', async () => {
    await invoicedShipment()
    table(TABLES.customer).set(TARGET_ID, {
      ...(table(TABLES.customer).get(TARGET_ID) as Row),
      freeCreditRequired: true,
    })

    await expect(
      repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'test', idempotencyKey: 'k-limit' }),
    ).rejects.toThrow(/approved credit limit/)
  })

  it('refuses to reverse a repoint credit memo directly', async () => {
    await invoicedShipment()
    await repoint({ shipmentId: SHIPMENT_ID, customerId: TARGET_ID, reason: 'wrong dept', idempotencyKey: 'k-rev' })

    const credit = [...table(TABLES.arPayment).values()].find((p) => p.kind === 'CREDIT_MEMO')
    expect(credit).toBeTruthy()

    await expect(
      call('REVERSE_PAYMENT', { paymentId: String(credit!.id), reason: 'undo' }),
    ).rejects.toThrow(/REPOINT_INVOICED_CUSTOMER/)
  })
})
