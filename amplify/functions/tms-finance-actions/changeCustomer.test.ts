/**
 * CHANGE_INVOICE_CUSTOMER end to end through the same in-memory DynamoDB engine repoint.test.ts uses:
 * the invoice moves in place (same number and amount), terms/due date/remit-to/factored follow the new
 * customer, and the refusals hold. Nothing is e-mailed (SES is asserted untouched).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

type Row = Record<string, unknown>

// ── Cognito ─────────────────────────────────────────────────────────────────
const cognitoSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class CognitoIdentityProviderClient { send = cognitoSend }
  class AdminGetUserCommand { input: unknown; constructor(input: unknown) { this.input = input } }
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
  return new Map<string, Map<string, Row>>()
})

function table(name: string): Map<string, Row> {
  let t = store.get(name)
  if (!t) { t = new Map(); store.set(name, t) }
  return t
}

const KEY_ATTRIBUTE: Record<string, string> = { [TABLES.division]: 'key' }

function keyOf(tableName: string, key: Row): string {
  const attribute = KEY_ATTRIBUTE[tableName] ?? 'id'
  const value = key[attribute]
  if (typeof value !== 'string') throw new Error(`ValidationException: key mismatch — ${tableName}/${attribute}`)
  return value
}

class ConditionalCheckFailed extends Error {
  constructor(message: string) { super(`ConditionalCheckFailedException: ${message}`) }
}
class TransactionCanceled extends Error {
  constructor(message: string) { super(`TransactionCanceledException: ${message}`) }
}

interface UpdateSpec {
  TableName: string; Key: Record<string, unknown>; UpdateExpression: string
  ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown>
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

function conditionHolds(condition: string, row: Row | null, values: Row, names: Record<string, string>): boolean {
  const resolve = (token: string): string => (token.startsWith('#') ? names[token] ?? token : token)
  const term = (raw: string): boolean => {
    let text = raw.trim()
    while (text.startsWith('(') && matchingClose(text, 0) === text.length - 1) text = text.slice(1, -1).trim()
    const ors = splitTop(text, 'OR'); if (ors.length > 1) return ors.some(term)
    const ands = splitTop(text, 'AND'); if (ands.length > 1) return ands.every(term)
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
      const actual = row[resolve(m[1])], expected = values[m[3]]
      switch (m[2]) {
        case '=': return String(actual) === String(expected)
        case '<>': return String(actual) !== String(expected)
        case '>=': return Number(actual ?? 0) >= Number(expected)
        case '<=': return Number(actual ?? 0) <= Number(expected)
        case '>': return Number(actual ?? 0) > Number(expected)
        default: return Number(actual ?? 0) < Number(expected)
      }
    }
    throw new Error(`test engine cannot evaluate condition: ${text}`)
  }
  return term(condition)
}

function matchingClose(expression: string, from: number): number {
  let depth = 0
  for (let i = from; i < expression.length; i++) {
    if (expression[i] === '(') depth++
    else if (expression[i] === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

function splitTop(expression: string, keyword: string): string[] {
  const parts: string[] = []
  const needle = ` ${keyword} `
  let depth = 0, start = 0
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && expression.startsWith(needle, i)) {
      parts.push(expression.slice(start, i)); start = i + needle.length; i = start - 1
    }
  }
  parts.push(expression.slice(start))
  return parts.map(p => p.trim()).filter(Boolean)
}

function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const key = unmarshall(spec.Key as never) as { id: string }
  const existing = t.get(key.id) ?? null
  const values = spec.ExpressionAttributeValues ? (unmarshall(spec.ExpressionAttributeValues as never) as Row) : {}
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
      if (m) next[resolve(m[1])] = Number(next[resolve(m[1])] ?? 0) + Number(values[m[2]] ?? 0)
    }
  }
  if (clauses.SET) {
    for (const assignment of clauses.SET.split(/,\s*(?![^(]*\))/)) {
      const m = /^\s*([#\w]+)\s*=\s*(.+?)\s*$/.exec(assignment)
      if (!m) continue
      const field = resolve(m[1]), rhs = m[2]
      const ifNotExists = /^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)$/.exec(rhs)
      if (ifNotExists) { if (next[resolve(ifNotExists[1])] === undefined) next[resolve(ifNotExists[1])] = values[ifNotExists[2]]; continue }
      next[field] = values[rhs]
    }
  }
  if (clauses.REMOVE) for (const token of clauses.REMOVE.split(/,\s*/)) delete next[resolve(token.trim())]
  t.set(key.id, next)
  return next
}

const send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = send }
  const make = (type: string) => class { input: Record<string, unknown>; __type = type; constructor(input: Record<string, unknown>) { this.input = input } }
  return { DynamoDBClient, GetItemCommand: make('Get'), BatchGetItemCommand: make('BatchGet'), PutItemCommand: make('Put'), UpdateItemCommand: make('Update'), QueryCommand: make('Query'), TransactWriteItemsCommand: make('Transact'), ScanCommand: make('Scan') }
})

// ── S3 / SES (minimal — never invoked by repoint) ───────────────────────────
const s3Send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send = s3Send }
  const make = (type: string) => class { input: Record<string, unknown>; __type = type; constructor(input: Record<string, unknown>) { this.input = input } }
  return { S3Client, PutObjectCommand: make('PutObject'), GetObjectCommand: make('GetObject') }
})
const getSignedUrl = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }))
const sesSend = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-sesv2', () => {
  class SESv2Client { send = sesSend }
  class SendEmailCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { SESv2Client, SendEmailCommand }
})

import { handler } from './handler'

interface MockCommand { __type: string; input: Record<string, unknown> }

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
      const token = cond.split(' ')[0], field = names[token] ?? token
      const items = [...table(String(input.TableName)).values()].filter(i => i[field] === values[':v'])
      return { Items: items.map(i => marshall(i, { removeUndefinedValues: true })) }
    }
    case 'Put': {
      const item = unmarshall(input.Item as never) as Row, t = table(String(input.TableName))
      if (input.ConditionExpression === 'attribute_not_exists(id)' && t.has(String(item.id))) throw new ConditionalCheckFailed(`${String(input.TableName)}/${String(item.id)} already exists`)
      t.set(String(item.id), item)
      return {}
    }
    case 'Update':
      return { Attributes: marshall(applyUpdate(input as unknown as UpdateSpec), { removeUndefinedValues: true }) }
    case 'Scan':
      return { Items: [...table(String(input.TableName)).values()].map(i => marshall(i, { removeUndefinedValues: true })) }
    case 'Transact': {
      const items = input.TransactItems as Record<string, Record<string, unknown>>[]
      const snapshot = new Map<string, Map<string, Row>>()
      for (const [name, t] of store) snapshot.set(name, new Map(t))
      try {
        for (const entry of items) {
          if (entry.Put) {
            const put = entry.Put as { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string }
            const item = unmarshall(put.Item as never) as Row, t = table(put.TableName)
            if (put.ConditionExpression === 'attribute_not_exists(id)' && t.has(String(item.id))) throw new ConditionalCheckFailed(`${put.TableName}/${String(item.id)} already exists`)
            t.set(String(item.id), item)
          } else if (entry.Update) applyUpdate(entry.Update as unknown as UpdateSpec)
        }
      } catch (err) { store.clear(); for (const [name, t] of snapshot) store.set(name, t); throw new TransactionCanceled(String((err as Error).message)) }
      return {}
    }
    default: throw new Error(`unsupported command: ${cmd.__type}`)
  }
}

beforeEach(() => {
  store.clear()
  send.mockImplementation((cmd: MockCommand) => runCommand(cmd))
  s3Send.mockReturnValue({})
  sesSend.mockReturnValue({})
  getSignedUrl.mockResolvedValue('https://s3.test/invoice.pdf')
  cognitoSend.mockImplementation(() => ({}))
})

// ── identities ──────────────────────────────────────────────────────────────
const ADMIN = { sub: 'sub-admin', username: 'admin', claims: { email: 'admin@bcatcorp.com', 'cognito:groups': ['ADMIN'] } }

const POSTER = { sub: 'sub-post', username: 'poster', claims: { email: 'poster@bcatcorp.com', 'cognito:groups': ['page-billingRelease'] } }

function call(action: string, input: Row, identity: unknown = ADMIN): Promise<Row> {
  return handler({ arguments: { action, input: JSON.stringify(input) }, identity } as never)
}

// ── fixtures ────────────────────────────────────────────────────────────────
const ORDER_ID = 'ord-1'
const SHIPMENT_ID = 'shp-1'
const LOAD_ID = 'lod-1'
const CUSTOMER_ID = 'cus-1'
const CARRIER_ID = 'car-1'
const LOAD_CARRIER_ID = 'lc-1'

function seed(orderOver: Row = {}): void {
  table('TmsSettings-test').set('default', { id: 'default', __typename: 'TmsSettings', defaultPaymentTermsDays: 30, nextInvoiceNumber: 0 })
  table('Customer-test').set(CUSTOMER_ID, { id: CUSTOMER_ID, name: 'Acme Freight', mcNumber: '123456', billingEmail: 'ap@acme.test', contacts: [], billToParties: [] })
  table('Division-test').set('BCAT_LOGISTICS', { key: 'BCAT_LOGISTICS', name: 'BCAT Logistics', remitToName: 'BCAT Logistics LLC', invoicePrefix: 'INV-' })
  table('Shipment-test').set(SHIPMENT_ID, { id: SHIPMENT_ID, number: 'S000001', status: 'DELIVERED', customerId: CUSTOMER_ID, deliveredAt: '2026-10-20T10:00:00.000Z' })
  table('Order-test').set(ORDER_ID, { id: ORDER_ID, shipmentId: SHIPMENT_ID, customerId: CUSTOMER_ID, customerName: 'Acme Freight', arStatus: 'UNBILLED', invoiceId: null, invoiceNumber: null, revenueCents: 250_000, references: [], version: 3, createdBy: 'a@b.c', updatedBy: 'a@b.c', ...orderOver })
  table('Load-test').set(LOAD_ID, { id: LOAD_ID, shipmentId: SHIPMENT_ID, orderId: ORDER_ID, aljexId: 'S000001-1', loadNumber: 'S000001-1', divisionKey: 'BCAT_LOGISTICS', stops: [{ id: 's1', sequence: 1, type: 'pickup', name: 'Shipper', city: 'Chicago, IL', appt: '2026-10-18T13:00:00.000Z' }, { id: 's2', sequence: 2, type: 'delivery', name: 'Receiver', city: 'Dallas, TX', appt: '2026-10-20T09:00:00.000Z' }] })
  table('LoadFinancials-test').set(LOAD_ID, { id: LOAD_ID, loadId: LOAD_ID, shipmentId: SHIPMENT_ID, orderId: ORDER_ID, revenueCents: 250_000, costCents: 180_000, version: 1 })
  table('LoadCharge-test').set('chg-1', { id: 'chg-1', shipmentId: SHIPMENT_ID, orderId: ORDER_ID, loadId: LOAD_ID, side: 'CUSTOMER', code: 'LINEHAUL', label: 'Linehaul', rateCents: 250_000, count: 1, amountCents: 250_000, isRate: true, sortOrder: 1, createdBy: 'a@b.c' })
  table('LoadCharge-test').set('chg-2', { id: 'chg-2', shipmentId: SHIPMENT_ID, loadId: LOAD_ID, side: 'CARRIER', code: 'LINEHAUL', rateCents: 180_000, count: 1, amountCents: 180_000, isRate: true, sortOrder: 1, createdBy: 'a@b.c' })
  table('LoadCarrier-test').set(LOAD_CARRIER_ID, { id: LOAD_CARRIER_ID, loadId: LOAD_ID, shipmentId: SHIPMENT_ID, kind: 'CARRIER', status: 'ACTIVE', carrierId: CARRIER_ID, carrierName: 'Wheeler Trucking', rateConStatus: 'SIGNED', chargesFinalizedAt: '2026-10-21T12:00:00.000Z', apStatus: 'IN_REVIEW', invoiceId: null, costCents: 180_000, createdBy: 'a@b.c', updatedBy: 'a@b.c' })
  for (const [id, type] of [['doc-seed-bol', 'BOL'], ['doc-seed-pod', 'POD']]) {
    table('ShipmentDocument-test').set(id, { id, shipmentId: SHIPMENT_ID, orderId: ORDER_ID, loadId: LOAD_ID, type, name: `${type.toLowerCase()}-seed.pdf`, s3Key: `shipment-docs/${SHIPMENT_ID}/${id}.pdf`, contentType: 'application/pdf', sizeBytes: 1024, status: 'ACTIVE', reviewStatus: 'ACCEPTED', audience: 'ALL', uploadedAt: '2026-10-21T10:00:00.000Z' })
  }
}

async function generate(identity: unknown = POSTER): Promise<{ invoiceId: string; number: string }> {
  const result = await call('GENERATE_INVOICE', { orderId: ORDER_ID }, identity) as { invoice: Row }
  return { invoiceId: String(result.invoice.id), number: String(result.invoice.number) }
}

// ── target customers ────────────────────────────────────────────────────────
const TARGET_ID = 'cus-target'

beforeEach(() => {
  table('Customer-test').set(TARGET_ID, { id: TARGET_ID, name: 'Acme Logistics', billingEmail: 'ar@acmelogistics.test', contacts: [], billToParties: [] })
})


async function change(input: Row, identity: unknown = POSTER): Promise<Row> {
  return call('CHANGE_INVOICE_CUSTOMER', input, identity)
}

function invoiceRow(id: string): Row { return table('Invoice-test').get(id)! }

describe('CHANGE_INVOICE_CUSTOMER', () => {
  it('moves the invoice, order, shipment and loads in place: same number and amount, new terms and due date', async () => {
    seed()
    table('Shipment-test').set(SHIPMENT_ID, { ...table('Shipment-test').get(SHIPMENT_ID)!, customerName: 'Acme Freight', searchKey: 's000001 acme freight chicago', version: 2 })
    table('Customer-test').set(TARGET_ID, { id: TARGET_ID, name: 'Acme Logistics', billingEmail: 'ar@acmelogistics.test', paymentTermsDays: 45, contacts: [], billToParties: [] })
    const { invoiceId, number } = await generate()
    table('Invoice-test').set(invoiceId, { ...invoiceRow(invoiceId), invoiceDate: '2026-10-21', sentAt: '2026-10-21T15:00:00.000Z', sentCount: 1 })
    const before = invoiceRow(invoiceId)

    await change({ invoiceId, customerId: TARGET_ID, reason: 'Billed the wrong Acme' })

    const after = invoiceRow(invoiceId)
    expect(after.number).toBe(number)
    expect(after.totalCents).toBe(before.totalCents)
    expect(after.customerId).toBe(TARGET_ID)
    expect(after.customerName).toBe('Acme Logistics')
    expect((after.billTo as Row).name).toBe('Acme Logistics')
    expect(after.termsDays).toBe(45)
    expect(after.dueAt).toBe('2026-12-05')
    expect(after.revision).toBe(2)
    expect(after.factored).toBe(false)
    expect(table('Order-test').get(ORDER_ID)!.customerId).toBe(TARGET_ID)
    const shipment = table('Shipment-test').get(SHIPMENT_ID)!
    expect(shipment.customerId).toBe(TARGET_ID)
    expect(String(shipment.searchKey)).toContain('acme logistics')
    expect(String(shipment.searchKey)).not.toContain('acme freight')
    expect(table('Load-test').get(LOAD_ID)!.customerId).toBe(TARGET_ID)
    const audit = [...table('AuditLog-test').values()].find((r) => r.action === 'CHANGE_INVOICE_CUSTOMER')
    expect(audit).toBeTruthy()
    expect(sesSend).not.toHaveBeenCalled()
  })

  it('an unsent invoice keeps its revision', async () => {
    seed()
    const { invoiceId } = await generate()
    await change({ invoiceId, customerId: TARGET_ID, reason: 'wrong customer' })
    expect(invoiceRow(invoiceId).revision ?? 1).toBe(1)
  })

  it('refuses without a reason, when money is applied, and once the invoice is with OTR', async () => {
    seed()
    const { invoiceId } = await generate()
    await expect(change({ invoiceId, customerId: TARGET_ID, reason: '' })).rejects.toThrow(/reason/)
    table('Invoice-test').set(invoiceId, { ...invoiceRow(invoiceId), paidCents: 100 })
    await expect(change({ invoiceId, customerId: TARGET_ID, reason: 'x' })).rejects.toThrow(/Money has been applied/)
    table('Invoice-test').set(invoiceId, { ...invoiceRow(invoiceId), paidCents: 0, factoringItemId: 'fi-1' })
    table('FactoringItem-test').set('fi-1', { id: 'fi-1', status: 'PENDING_WITH_OTR', otrInvoiceId: '26152964' })
    await expect(change({ invoiceId, customerId: TARGET_ID, reason: 'x' })).rejects.toThrow(/with OTR/)
    expect(invoiceRow(invoiceId).customerId).toBe(CUSTOMER_ID)
  })

  it('refuses the same customer and a void invoice', async () => {
    seed()
    const { invoiceId } = await generate()
    await expect(change({ invoiceId, customerId: CUSTOMER_ID, reason: 'x' })).rejects.toThrow(/already billed/)
    table('Invoice-test').set(invoiceId, { ...invoiceRow(invoiceId), status: 'VOID' })
    await expect(change({ invoiceId, customerId: TARGET_ID, reason: 'x' })).rejects.toThrow(/void/)
  })

  it('a factored customer with an unsubmitted queue row moved to a manual customer: row parked, invoice not factored, BCAT remit-to', async () => {
    seed()
    const { invoiceId } = await generate()
    table('Shipment-test').set(SHIPMENT_ID, { ...table('Shipment-test').get(SHIPMENT_ID)!, revDivision: 'ASSETS' })
    table('Invoice-test').set(invoiceId, { ...invoiceRow(invoiceId), factored: true, factoringItemId: 'fi-2' })
    table('Order-test').set(ORDER_ID, { ...table('Order-test').get(ORDER_ID)!, factoringItemId: 'fi-2' })
    table('FactoringItem-test').set('fi-2', { id: 'fi-2', status: 'NEED_TO_FACTOR', invoiceId, source: 'TMS' })
    table('Customer-test').set(TARGET_ID, { id: TARGET_ID, name: 'Acme Logistics', billingMethod: 'MANUAL', billingEmail: 'ar@acmelogistics.test', contacts: [], billToParties: [] })

    await change({ invoiceId, customerId: TARGET_ID, reason: 'manual customer' })

    const after = invoiceRow(invoiceId)
    expect(after.factored).toBe(false)
    expect(after.factoringItemId).toBeUndefined()
    expect((after.remitTo as Row).name).toBe('BCAT Logistics LLC')
    expect(table('FactoringItem-test').get('fi-2')!.status).toBe('ARCHIVED')
    expect(table('Order-test').get(ORDER_ID)!.factoringItemId).toBeUndefined()
  })

  it('a brokered load is never factored, even for a FACTOR customer', async () => {
    seed()
    table('Shipment-test').set(SHIPMENT_ID, { ...table('Shipment-test').get(SHIPMENT_ID)!, revDivision: 'BROKERAGE' })
    table('TmsSettings-test').set('default', { ...table('TmsSettings-test').get('default')!, factorRemitTo: { name: 'OTR Capital' } })
    table('Customer-test').set(TARGET_ID, { id: TARGET_ID, name: 'Acme Logistics', billingMethod: 'FACTOR', billingEmail: 'ar@acmelogistics.test', contacts: [], billToParties: [] })
    const { invoiceId } = await generate()
    await change({ invoiceId, customerId: TARGET_ID, reason: 'x' })
    expect(invoiceRow(invoiceId).factored).toBe(false)
    expect((invoiceRow(invoiceId).remitTo as Row).name).toBe('BCAT Logistics LLC')
  })

  it('needs Invoicing page access', async () => {
    seed()
    const { invoiceId } = await generate()
    const nobody = { sub: 'sub-n', username: 'n', claims: { email: 'n@bcatcorp.com', 'cognito:groups': [] } }
    await expect(change({ invoiceId, customerId: TARGET_ID, reason: 'x' }, nobody)).rejects.toThrow(/Forbidden/)
  })
})
