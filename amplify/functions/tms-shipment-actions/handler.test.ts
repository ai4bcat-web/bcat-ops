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

/** Apply the one `SET #a = :a, …` / `ADD counter :one` shape this handler emits. */
function applyUpdate(spec: UpdateSpec): Row {
  const t = table(spec.TableName)
  const key = unmarshall(spec.Key as never) as { id: string }
  const existing = t.get(key.id) ?? null
  const values = spec.ExpressionAttributeValues
    ? (unmarshall(spec.ExpressionAttributeValues as never) as Row)
    : {}
  const names = spec.ExpressionAttributeNames ?? {}

  if (spec.ConditionExpression?.includes('casExpectedUpdatedAt')) {
    const expected = values[':casExpectedUpdatedAt']
    const actual = existing?.updatedAt ?? ''
    if (String(expected ?? '') !== String(actual ?? '')) {
      throw new ConditionalCheckFailed(`CAS on ${spec.TableName}/${key.id}`)
    }
  }

  const next: Row = { ...(existing ?? { id: key.id }) }
  const addMatch = /ADD\s+(\w+)\s+(:\w+)/.exec(spec.UpdateExpression)
  if (addMatch) {
    const field = addMatch[1]
    const delta = Number(values[addMatch[2]] ?? 0)
    next[field] = Number(next[field] ?? 0) + delta
  }
  const setClause = /SET\s+(.*)$/s.exec(spec.UpdateExpression)
  if (setClause) {
    for (const assignment of setClause[1].split(/,\s*/)) {
      const m = /^\s*([#\w]+)\s*=\s*(.+?)\s*$/.exec(assignment)
      if (!m) continue
      const field = m[1].startsWith('#') ? names[m[1]] : m[1]
      const rhs = m[2]
      const ifNotExists = /^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)$/.exec(rhs)
      if (ifNotExists) {
        const target = ifNotExists[1].startsWith('#') ? names[ifNotExists[1]] : ifNotExists[1]
        if (next[target] === undefined) next[target] = values[ifNotExists[2]]
        continue
      }
      next[field] = values[rhs]
    }
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

// ── S3 / SES mocks — the rate confirmation's PDF and its email ───────────────
const s3Send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = s3Send
  }
  class PutObjectCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  return { S3Client, PutObjectCommand }
})

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
      const key = unmarshall(input.Key as never) as { id: string }
      const item = table(String(input.TableName)).get(key.id)
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
      table(String(input.TableName)).set(String(item.id), item)
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

beforeEach(() => {
  store.clear()
  send.mockReset()
  cognitoSend.mockReset()
  loadCreate.mockReset()
  loadUpdate.mockReset()
  s3Send.mockReset()
  sesSend.mockReset()
  s3Send.mockResolvedValue({})
  sesSend.mockResolvedValue({ MessageId: 'msg-1' })

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

describe('unknown action', () => {
  it('is refused by name', async () => {
    await expect(call('NOT_AN_ACTION', {})).rejects.toThrow(/Unknown action/)
  })
})
