/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import {
  seedDemoData,
  resetDemoData,
  getDemoState,
  SEED_VERSION,
  updateTx,
  type DemoDeps,
} from './demo'
import type { Caller } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'
import { DEMO_STEPS } from '../../../src/lib/demoFlow'

type TableName = string

interface SeedResult {
  counts: Record<string, number>
  created: number
  skipped: number
  seedVersion: string
}

interface DemoStateResult {
  devStack: boolean
  seedVersion: string | null
  seededAt: string | null
  facts: import('../../../src/lib/demoFlow').DemoChecklistFacts
}

// ── In-memory store ──────────────────────────────────────────────────────────

const TABLES: Record<string, TableName> = {
  demo: 'DemoRecord-test',
  shipment: 'Shipment-test',
  order: 'Order-test',
  load: 'Load-test',
  loadCarrier: 'LoadCarrier-test',
  customer: 'Customer-test',
  carrier: 'Carrier-test',
  carrierDocument: 'CarrierDocument-test',
  quote: 'Quote-test',
  posting: 'ShipmentPosting-test',
  message: 'ShipmentMessage-test',
  document: 'ShipmentDocument-test',
  checkCall: 'LoadCheckCall-test',
  settings: 'TmsSettings-test',
}

const store = new Map<TableName, Map<string, Row>>()

function table(name: TableName): Map<string, Row> {
  let t = store.get(name)
  if (!t) {
    t = new Map<string, Row>()
    store.set(name, t)
  }
  return t
}

function clearStore(): void {
  store.clear()
}

function parseUpdateExpression(expr: string, names: Record<string, string>, values: Record<string, unknown>): { sets: Record<string, unknown>; removes: string[] } {
  const sets: Record<string, unknown> = {}
  const removes: string[] = []
  const setMatch = expr.match(/SET\s+(.+?)(?:\s+REMOVE\s+|$)/)
  const removeMatch = expr.match(/REMOVE\s+(.+)$/)

  if (setMatch) {
    for (const pair of setMatch[1].split(',')) {
      const m = pair.trim().match(/^#(\w+)\s*=\s*:(\w+)$/)
      if (m) {
        const key = names[`#${m[1]}`]
        if (key) sets[key] = values[`:${m[2]}`]
      }
    }
  }

  if (removeMatch) {
    for (const name of removeMatch[1].split(',')) {
      const key = names[name.trim()]
      if (key) removes.push(key)
    }
  }

  return { sets, removes }
}

function applyUpdate(row: Row, item: NonNullable<DemoTxItem['Update']>): Row {
  const names = item.ExpressionAttributeNames as Record<string, string> | undefined
  const values = item.ExpressionAttributeValues as Record<string, unknown> | undefined
  const expr = item.UpdateExpression as string
  if (!names || !expr) return row

  const { sets, removes } = parseUpdateExpression(expr, names, values ?? {})
  const next = { ...row }
  for (const [key, value] of Object.entries(sets)) {
    if (value === undefined) continue
    next[key] = value
  }
  for (const key of removes) {
    delete next[key]
  }
  return next
}

interface DemoTxItem {
  Put?: { TableName: string; Item: Record<string, unknown> }
  Update?: {
    TableName: string
    Key: Record<string, unknown>
    UpdateExpression: string
    ExpressionAttributeNames: Record<string, string>
    ExpressionAttributeValues?: Record<string, unknown>
    ConditionExpression?: string
  }
  Delete?: { TableName: string; Key: Record<string, unknown> }
}

const ATTR_KEYS = new Set(['S', 'N', 'B', 'SS', 'NS', 'BS', 'M', 'L', 'NULL', 'BOOL'])

function isAttributeValue(v: unknown): boolean {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.keys(v).some((k) => ATTR_KEYS.has(k))
}

function denormalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(denormalize)
  if (v === null || typeof v !== 'object') return v
  if (isAttributeValue(v)) return unmarshall({ x: v as never }).x
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = denormalize(val)
  }
  return out
}

class DemoConflict extends Error {
  constructor(message: string) {
    super(`ConditionalCheckFailedException: ${message}`)
  }
}

function checkCas(condition: string | undefined, values: Record<string, unknown>, existing: Row | null): void {
  if (!condition) return
  if (!condition.includes('casExpectedUpdatedAt')) return
  const expected = String(values[':casExpectedUpdatedAt'] ?? '')
  const actual = String(existing?.updatedAt ?? '')
  if (actual === '' && expected === '') return
  if (actual !== expected) throw new DemoConflict(`CAS on updatedAt: expected ${expected}, found ${actual}`)
}

async function transact(items: DemoTxItem[]): Promise<void> {
  if (items.length > 100) {
    throw new Error(`Transaction exceeds DynamoDB limit: ${items.length} items (max 100)`)
  }
  for (const item of items) {
    if (item.Put) {
      const row = denormalize(item.Put.Item) as Row
      table(item.Put.TableName as TableName).set(String(row.id), { ...row })
    } else if (item.Update) {
      const key = (denormalize(item.Update.Key) as Row).id as string
      const existing = table(item.Update.TableName as TableName).get(key) ?? null
      const values = (denormalize(item.Update.ExpressionAttributeValues ?? {}) as Record<string, unknown>) ?? {}
      checkCas(item.Update.ConditionExpression, values, existing)
      const next = applyUpdate(existing ?? { id: key }, { ...item.Update, ExpressionAttributeValues: values })
      table(item.Update.TableName as TableName).set(key, next)
    } else if (item.Delete) {
      const key = (denormalize(item.Delete.Key) as Row).id as string
      table(item.Delete.TableName as TableName).delete(key)
    }
  }
}

async function getById(tableName: TableName, id: string): Promise<Row | null> {
  return table(tableName).get(id) ?? null
}

async function queryIndex(tableName: TableName, _indexName: string, keyName: string, keyValue: string): Promise<Row[]> {
  const out: Row[] = []
  for (const row of table(tableName).values()) {
    if (row[keyName] === keyValue) out.push(row)
  }
  return out
}

async function scanTable(tableName: TableName): Promise<Row[]> {
  return [...table(tableName).values()]
}

async function getSettings(): Promise<Row> {
  return table(TABLES.settings).get('default') ?? { id: 'default' }
}

const audits: Row[] = []
async function writeAudit(entityType: string, entityId: string, action: string, caller: Caller, changes: Row): Promise<void> {
  audits.push({ entityType, entityId, action, caller: caller.email, changes })
}

let idCounter = 0
function randomId(): string {
  idCounter += 1
  return `id-${idCounter}-${Date.now().toString(36)}`
}

let nowCounter = 0
function now(): string {
  nowCounter += 1
  const d = new Date('2026-10-29T12:00:00.000Z')
  d.setSeconds(d.getSeconds() + nowCounter)
  return d.toISOString()
}

const caller: Caller = { email: 'ryne@bcatcorp.com', sub: 'user-ryne', groups: ['ADMIN'], isAdmin: true }

// ── Fake actions (just enough state to exercise the seed) ────────────────────

function stopsFrom(loadInput: Row): Row[] {
  const raw = loadInput.stops ?? []
  return Array.isArray(raw) ? raw : []
}

function deriveMirrors(stops: Row[]): Row {
  const pickup = stops.find((s) => s.type === 'pickup')
  const delivery = stops.find((s) => s.type === 'delivery')
  return {
    pickupAppt: pickup?.appt ?? null,
    deliveryAppt: delivery?.appt ?? null,
    originCity: pickup?.city ?? null,
    destinationCity: delivery?.city ?? null,
  }
}

async function fakeCreateShipment(input: Row, caller: Caller): Promise<Row> {
  const customer = input.customerId ? await getById(TABLES.customer, String(input.customerId)) : null
  if (!customer && !input.customerName) {
    throw new Error('A shipment needs exactly one of customerId or customerName')
  }
  const settings = await getSettings()
  const next = (typeof settings.nextShipmentNumber === 'number' ? settings.nextShipmentNumber : 1)
  const number = `S${String(next).padStart(6, '0')}`
  table(TABLES.settings).set('default', { ...settings, nextShipmentNumber: next + 1 })

  const shipmentId = `shp-${randomId()}`
  const orderId = `ord-${randomId()}`
  const loadId = `lod-${randomId()}`
  const t = now()
  const loadInput = (input.load ?? {}) as Row
  const stops = stopsFrom(loadInput)
  const mirrors = deriveMirrors(stops)
  const revenueCents = (loadInput.rateCents as number | undefined) ?? 0

  const shipment: Row = {
    id: shipmentId,
    __typename: 'Shipment',
    number,
    status: input.source === 'TENDER' ? 'TENDER_PENDING' : 'DRAFT',
    previousStatus: null,
    customerId: customer?.id,
    customerName: customer?.name ?? input.customerName,
    mode: input.mode ?? 'FTL',
    source: input.source ?? 'MANUAL',
    orderIds: [orderId],
    loadIds: [loadId],
    ...mirrors,
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: t,
    updatedAt: t,
    version: 1,
  }

  const order: Row = {
    id: orderId,
    __typename: 'Order',
    shipmentId,
    customerId: customer?.id,
    customerName: customer?.name ?? input.customerName,
    mode: input.mode ?? 'FTL',
    rateType: 'SPOT',
    references: [],
    freight: [],
    revenueCents,
    customerRateCents: revenueCents,
    arStatus: 'DOCS_NEEDED',
    pickupAppt: mirrors.pickupAppt,
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: t,
    updatedAt: t,
    version: 1,
  }

  const load: Row = {
    id: loadId,
    __typename: 'Load',
    aljexId: `${number}-1`,
    tmsId: `${number}-1`,
    pickupNumber: `${number}-1`,
    shipmentId,
    orderId,
    loadNumber: `${number}-1`,
    leg: 1,
    status: 'DRAFT',
    assignmentType: 'NEED_TO_COVER',
    stops: JSON.stringify(stops),
    ...mirrors,
    equipmentType: loadInput.equipmentType ?? null,
    miles: loadInput.miles ?? null,
    weight: loadInput.weight ?? null,
    rate: revenueCents,
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: t,
    updatedAt: t,
  }

  const financials: Row = {
    id: loadId,
    __typename: 'LoadFinancials',
    loadId,
    shipmentId,
    orderId,
    customerRateCents: revenueCents,
    revenueCents: revenueCents,
    carrierRateCents: 0,
    costCents: 0,
    profitCents: revenueCents,
    marginBps: revenueCents > 0 ? 10000 : 0,
    updatedBy: caller.email,
    version: 1,
    createdAt: t,
    updatedAt: t,
  }

  const charge: Row = {
    id: `chg-${randomId()}`,
    __typename: 'LoadCharge',
    shipmentId,
    orderId,
    loadId,
    side: 'CUSTOMER',
    code: 'LINEHAUL',
    label: 'Linehaul',
    calculatedBy: 'FLAT',
    rateCents: revenueCents,
    count: 1,
    amountCents: revenueCents,
    isRate: true,
    sortOrder: 0,
    createdBy: caller.email,
  }

  await transact([
    { Put: { TableName: TABLES.shipment, Item: shipment } },
    { Put: { TableName: TABLES.order, Item: order } },
    { Put: { TableName: TABLES.load, Item: load } },
    { Put: { TableName: 'LoadFinancials-test', Item: financials } },
    { Put: { TableName: 'LoadCharge-test', Item: charge } },
  ])

  return { bundle: { shipment, orders: [order], loads: [load] } }
}

async function fakeSubmitOrder(input: Row, _caller: Caller): Promise<Row> {
  const shipment = await getById(TABLES.shipment, String(input.shipmentId))
  if (!shipment) throw new Error(`Shipment not found: ${input.shipmentId}`)
  const t = now()
  const loads = await queryIndex(TABLES.load, 'loadsByShipmentId', 'shipmentId', String(input.shipmentId))
  const orders = await queryIndex(TABLES.order, 'ordersByShipmentId', 'shipmentId', String(input.shipmentId))
  const updates: DemoTxItem[] = [
    {
      Update: {
        TableName: TABLES.shipment,
        Key: { id: shipment.id },
        UpdateExpression: 'SET #status = :status, #previousStatus = :previousStatus, #updatedAt = :updatedAt, #version = :version',
        ExpressionAttributeNames: { '#status': 'status', '#previousStatus': 'previousStatus', '#updatedAt': 'updatedAt', '#version': 'version' },
        ExpressionAttributeValues: { ':status': 'OPEN', ':previousStatus': 'DRAFT', ':updatedAt': t, ':version': 2 },
      },
    },
  ]
  for (const order of orders) {
    updates.push({
      Update: {
        TableName: TABLES.order,
        Key: { id: order.id },
        UpdateExpression: 'SET #arStatus = :arStatus, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#arStatus': 'arStatus', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':arStatus': 'DOCS_NEEDED', ':updatedAt': t },
      },
    })
  }
  for (const load of loads) {
    updates.push({
      Update: {
        TableName: TABLES.load,
        Key: { id: load.id },
        UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':status': 'SOURCING', ':updatedAt': t },
      },
    })
  }
  await transact(updates)
  return { bundle: await readBundle(String(input.shipmentId)) }
}

async function fakeSetShipmentStatus(input: Row, _caller: Caller): Promise<Row> {
  const shipment = await getById(TABLES.shipment, String(input.shipmentId))
  if (!shipment) throw new Error(`Shipment not found: ${input.shipmentId}`)
  if (String(shipment.updatedAt ?? '') !== String(input.expectedUpdatedAt ?? '')) {
    throw new Error('This shipment was changed by someone else')
  }
  const t = now()
  await transact([{
    Update: {
      TableName: TABLES.shipment,
      Key: { id: shipment.id },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #version = :version',
      ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt', '#version': 'version' },
      ExpressionAttributeValues: { ':status': input.status, ':updatedAt': t, ':version': (shipment.version as number ?? 1) + 1 },
    },
  }])
  return { bundle: await readBundle(String(input.shipmentId)) }
}

async function fakeAssignCarrierRep(input: Row, _caller: Caller): Promise<Row> {
  const shipment = await getById(TABLES.shipment, String(input.shipmentId))
  if (!shipment) throw new Error(`Shipment not found: ${input.shipmentId}`)
  const t = now()
  const loads = await queryIndex(TABLES.load, 'loadsByShipmentId', 'shipmentId', String(input.shipmentId))
  const updates: DemoTxItem[] = [
    {
      Update: {
        TableName: TABLES.shipment,
        Key: { id: shipment.id },
        UpdateExpression: 'SET #carrierRepId = :carrierRepId, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#carrierRepId': 'carrierRepId', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':carrierRepId': input.repId ?? null, ':updatedAt': t },
      },
    },
  ]
  for (const load of loads) {
    updates.push({
      Update: {
        TableName: TABLES.load,
        Key: { id: load.id },
        UpdateExpression: 'SET #carrierRepId = :carrierRepId, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#carrierRepId': 'carrierRepId', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':carrierRepId': input.repId ?? null, ':updatedAt': t },
      },
    })
  }
  await transact(updates)
  return { bundle: await readBundle(String(input.shipmentId)) }
}

async function fakeBookCarrier(input: Row, caller: Caller): Promise<Row> {
  const load = await getById(TABLES.load, String(input.loadId))
  if (!load) throw new Error(`Load not found: ${input.loadId}`)
  if (String(load.updatedAt ?? '') !== String(input.expectedUpdatedAt ?? '')) {
    throw new Error('This load was changed by someone else')
  }
  const carrier = await getById(TABLES.carrier, String(input.carrierId))
  const carrierName = carrier?.name ?? 'Unknown Carrier'
  const t = now()
  const loadCarrierId = `lcr-${randomId()}`
  const loadCarrier: Row = {
    id: loadCarrierId,
    __typename: 'LoadCarrier',
    loadId: load.id,
    shipmentId: load.shipmentId,
    kind: 'CARRIER',
    status: 'ACTIVE',
    sequence: 1,
    carrierId: input.carrierId,
    carrierName,
    carrierRateCents: input.carrierRateCents ?? 0,
    costCents: input.carrierRateCents ?? 0,
    apStatus: 'AWAITING_INVOICE',
    apOpen: 'OPEN',
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: t,
    updatedAt: t,
  }
  await transact([
    { Put: { TableName: TABLES.loadCarrier, Item: loadCarrier } },
    {
      Update: {
        TableName: TABLES.load,
        Key: { id: load.id },
        UpdateExpression: 'SET #status = :status, #activeLoadCarrierId = :activeLoadCarrierId, #assignmentType = :assignmentType, #carrierName = :carrierName, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status', '#activeLoadCarrierId': 'activeLoadCarrierId', '#assignmentType': 'assignmentType', '#carrierName': 'carrierName', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':status': 'BOOKED', ':activeLoadCarrierId': loadCarrierId, ':assignmentType': 'CARRIER', ':carrierName': carrierName, ':updatedAt': t },
      },
    },
  ])
  return { bundle: await readBundle(String(load.shipmentId)) }
}

async function fakeVoidShipment(input: Row, caller: Caller): Promise<Row> {
  const shipment = await getById(TABLES.shipment, String(input.shipmentId))
  if (!shipment) throw new Error(`Shipment not found: ${input.shipmentId}`)
  if (String(shipment.updatedAt ?? '') !== String(input.expectedUpdatedAt ?? '')) {
    throw new Error('This shipment was changed by someone else')
  }
  const t = now()
  const loads = await queryIndex(TABLES.load, 'loadsByShipmentId', 'shipmentId', String(input.shipmentId))
  const updates: DemoTxItem[] = [
    {
      Update: {
        TableName: TABLES.shipment,
        Key: { id: shipment.id },
        UpdateExpression: 'SET #voidedAt = :voidedAt, #voidedBy = :voidedBy, #voidReason = :voidReason, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#voidedAt': 'voidedAt', '#voidedBy': 'voidedBy', '#voidReason': 'voidReason', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':voidedAt': t, ':voidedBy': caller.email, ':voidReason': input.reason, ':updatedAt': t },
      },
    },
  ]
  for (const load of loads) {
    updates.push({
      Update: {
        TableName: TABLES.load,
        Key: { id: load.id },
        UpdateExpression: 'SET #status = :status, #voidedAt = :voidedAt, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status', '#voidedAt': 'voidedAt', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':status': 'CANCELED', ':voidedAt': t, ':updatedAt': t },
      },
    })
  }
  await transact(updates)
  return { bundle: await readBundle(String(input.shipmentId)) }
}

async function fakeSaveOrderForm(input: Row, _caller: Caller): Promise<{ bundle: Row }> {
  return { bundle: await readBundle(String(input.shipmentId)) }
}

async function readBundle(shipmentId: string): Promise<Row> {
  const shipment = await getById(TABLES.shipment, shipmentId)
  const orders = await queryIndex(TABLES.order, 'ordersByShipmentId', 'shipmentId', shipmentId)
  const loads = await queryIndex(TABLES.load, 'loadsByShipmentId', 'shipmentId', shipmentId)
  const loadCarriers = await queryIndex(TABLES.loadCarrier, 'loadCarriersByShipmentId', 'shipmentId', shipmentId)
  return { shipment, orders, loads, loadCarriers }
}

function makeDeps(isDevStack = true): DemoDeps {
  return {
    tables: TABLES as DemoDeps['tables'],
    getById,
    queryIndex,
    scanTable,
    transact: transact as unknown as DemoDeps['transact'],
    getSettings,
    writeAudit,
    isDevStack,
    actions: {
      createShipment: fakeCreateShipment,
      saveOrderForm: fakeSaveOrderForm,
      submitOrder: fakeSubmitOrder,
      setShipmentStatus: fakeSetShipmentStatus,
      assignCarrierRep: fakeAssignCarrierRep,
      bookCarrier: fakeBookCarrier,
      voidShipment: fakeVoidShipment,
    },
    now,
    randomId,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('demo seed', () => {
  beforeEach(() => {
    clearStore()
    audits.length = 0
    idCounter = 0
    nowCounter = 0
  })

  it('refuses to seed on a non-dev stack', async () => {
    const deps = makeDeps(false)
    await expect(seedDemoData(deps, {}, caller)).rejects.toThrow('The demo seed only runs on the dev stack')
  })

  it('refuses to reset on a non-dev stack', async () => {
    const deps = makeDeps(false)
    await expect(resetDemoData(deps, {}, caller)).rejects.toThrow('The demo seed only runs on the dev stack')
  })

  it('creates at least 40 shipments and every named demo key on first seed', async () => {
    const deps = makeDeps(true)
    const result = (await seedDemoData(deps, {}, caller)) as unknown as SeedResult

    expect(result.seedVersion).toBe(SEED_VERSION)
    expect(result.created).toBeGreaterThan(0)
    expect(result.skipped).toBe(0)
    expect(result.counts.SHIPMENT).toBeGreaterThanOrEqual(40)

    const demos = await scanTable(TABLES.demo)
    const demoKeys = new Set(demos.map((d) => d.demoKey))
    const required = DEMO_STEPS.filter((s) => s.opensOn).map((s) => s.opensOn as string)
    for (const key of required) {
      expect(demoKeys.has(key)).toBe(true)
    }
  })

  it('creates nothing on a second seed', async () => {
    const deps = makeDeps(true)
    const first = await seedDemoData(deps, {}, caller)
    const second = await seedDemoData(deps, {}, caller)

    expect(second.created).toBe(0)
    expect(second.skipped).toBe(first.created)
  })

  it('voids seeded shipments on reset instead of deleting them', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)
    const beforeIds = (await scanTable(TABLES.shipment)).map((s) => String(s.id))

    await resetDemoData(deps, {}, caller)

    const after = await scanTable(TABLES.shipment)
    for (const id of beforeIds) {
      const s = after.find((row) => String(row.id) === id)
      expect(s?.voidedAt).toBeTruthy()
    }
    // Reset re-seeds, so there are also fresh non-voided shipments.
    expect(after.some((s) => !s.voidedAt)).toBe(true)
  })

  it('leaves non-demo records untouched during reset', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)

    const outsider = { id: 'cust-outsider', __typename: 'Customer', name: 'Outsider', status: 'ACTIVE', createdBy: 'x', updatedBy: 'x', createdAt: now(), updatedAt: now(), version: 1 }
    await transact([{ Put: { TableName: TABLES.customer, Item: outsider } }])

    await resetDemoData(deps, {}, caller)

    const remaining = await getById(TABLES.customer, 'cust-outsider')
    expect(remaining).not.toBeNull()
  })

  it('getDemoState facts match the seeded rows', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)

    const state = (await getDemoState(deps)) as unknown as DemoStateResult
    expect(state.devStack).toBe(true)
    expect(state.seedVersion).toBe(SEED_VERSION)
    expect(state.facts.shipmentCount).toBeGreaterThanOrEqual(40)
    expect(state.facts.staffCount).toBe(6)
    expect(state.facts.assignedCount).toBeGreaterThan(0)
    expect(state.facts.customersWithFlowDefaults).toBeGreaterThan(0)
    expect(state.facts.quotesWithMarketRate).toBeGreaterThan(0)
    expect(state.facts.buildingShipments).toBeGreaterThan(0)
    expect(state.facts.activePostings).toBeGreaterThan(0)
    expect(state.facts.carrierOffers).toBeGreaterThan(0)
    expect(state.facts.shipmentsWithThread).toBeGreaterThan(0)
    expect(state.facts.checkCallMessages).toBeGreaterThan(0)
    expect(state.facts.podReviews).toBeGreaterThan(0)
    expect(state.facts.readyForBilling + state.facts.releasedToBilling).toBeGreaterThan(0)
  })

  it('covers every shipment status and all three divisions', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)
    const shipments = await scanTable(TABLES.shipment)
    const loads = await scanTable(TABLES.load)

    const shipmentStatuses = new Set(shipments.map((s) => String(s.status)))
    const loadStatuses = new Set(loads.map((l) => String(l.status)))
    const divisions = new Set(shipments.map((s) => String(s.revDivision)))

    expect(shipmentStatuses.has('OPEN')).toBe(true)
    expect(shipmentStatuses.has('ON_HOLD')).toBe(true)
    expect(shipmentStatuses.has('DISPATCHED')).toBe(true)
    expect(shipmentStatuses.has('DELIVERED')).toBe(true)
    expect(shipmentStatuses.has('TENDER_PENDING')).toBe(true)
    expect(shipmentStatuses.has('CANCELED')).toBe(true)

    expect(loadStatuses.has('SOURCING')).toBe(true)
    expect(loadStatuses.has('BOOKED')).toBe(true)
    expect(loadStatuses.has('DISPATCHED')).toBe(true)
    expect(loadStatuses.has('LOADING')).toBe(true)
    expect(loadStatuses.has('IN_TRANSIT')).toBe(true)
    expect(loadStatuses.has('DELIVERED')).toBe(true)
    expect(loadStatuses.has('CANCELED')).toBe(true)

    expect(divisions.has('BROKERAGE')).toBe(true)
    expect(divisions.has('CAR_SHIPPING')).toBe(true)
    expect(divisions.has('ASSETS')).toBe(true)
  })

  it('covers every AR bucket', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)
    const orders = await scanTable(TABLES.order)

    const buckets = new Set(orders.map((o) => String(o.arStatus)))
    expect(buckets.has('DOCS_NEEDED')).toBe(true)
    expect(buckets.has('UNBILLED')).toBe(true)
    expect(buckets.has('UNPAID')).toBe(true)
    expect(buckets.has('PAID')).toBe(true)
  })

  it('creates quotes in every state and buy-side carrier offers', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)
    const quotes = await scanTable(TABLES.quote)

    const sellStatuses = new Set(quotes.filter((q) => q.side === 'SELL').map((q) => String(q.status)))
    const states = ['DRAFT', 'QUOTED', 'SENT_COUNTER', 'RECEIVED_REPLY', 'WON', 'LOST', 'PASS', 'CANCELED']
    for (const status of states) {
      expect(sellStatuses.has(status)).toBe(true)
    }

    const buyOffers = quotes.filter((q) => q.side === 'BUY')
    expect(buyOffers.length).toBeGreaterThanOrEqual(3)
  })

  it('creates POD documents with clean, rejected and reviewed states', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)
    const docs = await scanTable(TABLES.document)

    const pods = docs.filter((d) => d.type === 'POD')
    expect(pods.some((d) => d.reviewStatus === 'ACCEPTED')).toBe(true)
    expect(pods.some((d) => d.reviewStatus === 'REJECTED')).toBe(true)
  })

  it('records demo staff from input or caller fallback', async () => {
    const deps = makeDeps(true)
    const staff = [
      { id: 'rep-a', name: 'Alice', role: 'carrier-rep' },
      { id: 'rep-b', name: 'Bob', role: 'carrier-rep' },
      { id: 'lead-c', name: 'Carol', role: 'carrier-team-lead' },
      { id: 'sales-d', name: 'Dan', role: 'sales-rep' },
      { id: 'track-e', name: 'Eve', role: 'tracker' },
      { id: 'acct-f', name: 'Frank', role: 'accounting' },
    ]
    await seedDemoData(deps, { staff }, caller)

    const records = await scanTable(TABLES.demo)
    const staffRecords = records.filter((r) => r.kind === 'STAFF')
    expect(staffRecords.length).toBe(6)
    expect(staffRecords.some((r) => r.recordId === 'rep-a')).toBe(true)
  })

  it('stamps TmsSettings with the seed version and org defaults', async () => {
    const deps = makeDeps(true)
    await seedDemoData(deps, {}, caller)
    const settings = await getSettings()

    expect(settings.demoSeedVersion).toBe(SEED_VERSION)
    expect(settings.demoSeededAt).toBeTruthy()
    expect(settings.marginTargetBps).toBe(2000)
    expect(settings.quoteAutoReplyDefault).toBe(false)
    expect(Array.isArray(settings.defaultRequiredLoadFields)).toBe(true)
    expect(settings.defaultCheckCallPlan).toBeDefined()
  })

  it('deduplicates duplicate demo record targets during reset', async () => {
    const deps = makeDeps(true)
    await transact([
      {
        Put: {
          TableName: TABLES.customer,
          Item: { id: 'cust-dup', __typename: 'Customer', name: 'Dup', status: 'ACTIVE', createdBy: 'x', updatedBy: 'x', createdAt: now(), updatedAt: now() },
        },
      },
      {
        Put: {
          TableName: TABLES.demo,
          Item: { id: 'demo:cust:a', kind: 'CUSTOMER', demoKey: 'a', recordId: 'cust-dup', seedVersion: SEED_VERSION, createdBy: caller.email },
        },
      },
      {
        Put: {
          TableName: TABLES.demo,
          Item: { id: 'demo:cust:b', kind: 'CUSTOMER', demoKey: 'b', recordId: 'cust-dup', seedVersion: SEED_VERSION, createdBy: caller.email },
        },
      },
    ] as DemoTxItem[])

    await expect(resetDemoData(deps, {}, caller)).resolves.not.toThrow()
  })

  it('batches reset deletes at 100 items per transaction', async () => {
    const deps = makeDeps(true)
    const demoTable = table(TABLES.demo)
    for (let i = 0; i < 110; i++) {
      demoTable.set(`demo:q:${i}`, { id: `demo:q:${i}`, kind: 'QUOTE', demoKey: `q:${i}`, recordId: `quote-${i}`, seedVersion: SEED_VERSION, createdBy: caller.email })
    }

    const batchSizes: number[] = []
    const baseTransact = (deps as unknown as { transact: (items: unknown[]) => Promise<void> }).transact
    ;(deps as unknown as { transact: (items: unknown[]) => Promise<void> }).transact = async (items) => {
      batchSizes.push(items.length)
      if (items.length > 100) throw new Error('Transaction would exceed 100 items')
      return baseTransact(items)
    }

    await expect(resetDemoData(deps, {}, caller)).resolves.not.toThrow()
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(100)
  })

  it('stamps direct updates with updatedAt, updatedBy and CAS', async () => {
    const tableName = 'Shipment-test'
    table(tableName).set('shp-1', { id: 'shp-1', status: 'DRAFT', updatedAt: '2026-01-01T00:00:00.000Z' })

    const patch = { status: 'OPEN', updatedAt: '2026-02-01T00:00:00.000Z', updatedBy: caller.email }
    const tx = updateTx(tableName, 'shp-1', patch, '2026-01-01T00:00:00.000Z')

    expect(tx.Update).toBeDefined()
    expect(tx.Update!.ExpressionAttributeValues?.[':updatedAt']).toBeDefined()
    expect(tx.Update!.ExpressionAttributeValues?.[':updatedBy']).toBeDefined()
    expect(tx.Update!.ConditionExpression).toContain(':casExpectedUpdatedAt')

    await transact([tx as unknown as DemoTxItem])
    expect(table(tableName).get('shp-1')?.status).toBe('OPEN')

    await expect(
      transact([updateTx(tableName, 'shp-1', patch, 'stale') as unknown as DemoTxItem]),
    ).rejects.toThrow(/CAS/)
  })
})
