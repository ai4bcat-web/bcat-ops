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
      const key = unmarshall(input.Key as never) as { id: string }
      const item = table(String(input.TableName)).get(key.id)
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
  table(TABLES.division).set('BCAT_LOGISTICS', {
    id: 'BCAT_LOGISTICS',
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
}

async function generate(identity: unknown = ADMIN): Promise<{ invoiceId: string; number: string }> {
  const result = (await call('GENERATE_INVOICE', { orderId: ORDER_ID }, identity)) as { invoice: Row }
  return { invoiceId: String(result.invoice.id), number: String(result.invoice.number) }
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
    table(TABLES.order).set('ord-2', {
      ...table(TABLES.order).get(ORDER_ID)!,
      id: 'ord-2', arStatus: 'UNBILLED', invoiceId: null, invoiceNumber: null, factoringItemId: null,
    })
    table(TABLES.charge).set('chg-3', { ...table(TABLES.charge).get('chg-1')!, id: 'chg-3', orderId: 'ord-2' })
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
