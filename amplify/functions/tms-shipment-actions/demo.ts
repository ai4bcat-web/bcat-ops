/**
 * Step P1 + P11 — the dev-only demo seed, reset and state reader.
 *
 * The seed is a script that runs through the normal freight actions, so every
 * shipment it leaves behind is a state the app itself could reach. Directory rows
 * (Customer, Carrier) and the flat fixtures that other Lambdas own (Quote,
 * ShipmentPosting, ShipmentMessage, LoadCheckCall, ShipmentDocument) are written
 * directly, with a comment on each block explaining why. Nothing here invents a
 * production write: both seed and reset throw unless `deps.isDevStack` is true.
 */

import type { Caller } from '../_shared/actionInputs'
import { marshallRow, updateItemTx, type Row } from '../_shared/shipmentStore'
import { isVoided } from '../_shared/voided'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { DEFAULT_CHECK_CALL_PLAN } from '../../../src/lib/checkCallPlan'
import { DEFAULT_MARGIN_TARGET_BPS, DEFAULT_REQUIRED_LOAD_FIELDS } from '../../../src/lib/flowDefaults'

export const SEED_VERSION = 'p8.1'

export interface DemoDeps {
  tables: {
    demo: string
    shipment: string
    order: string
    load: string
    loadCarrier: string
    customer: string
    carrier: string
    carrierDocument: string
    quote: string
    posting: string
    message: string
    document: string
    checkCall: string
    settings: string
  }
  getById(table: string, id: string): Promise<Row | null>
  queryIndex(table: string, indexName: string, keyName: string, keyValue: string): Promise<Row[]>
  scanTable(table: string): Promise<Row[]>
  transact(items: TransactWriteItem[]): Promise<void>
  getSettings(): Promise<Row>
  writeAudit(entityType: string, entityId: string, action: string, caller: Caller, changes: Row): Promise<void>
  /** True only on the long-lived dev stack (BCAT_DEV_STACK). Injected, never read from env here. */
  isDevStack: boolean
  /** The normal actions. The seed mints freight through these and nothing else. */
  actions: {
    createShipment(input: Row, caller: Caller): Promise<Row>
    saveOrderForm(input: Row, caller: Caller): Promise<{ bundle: Row }>
    submitOrder(input: Row, caller: Caller): Promise<Row>
    setShipmentStatus(input: Row, caller: Caller): Promise<Row>
    assignCarrierRep(input: Row, caller: Caller): Promise<Row>
    bookCarrier(input: Row, caller: Caller): Promise<Row>
    voidShipment(input: Row, caller: Caller): Promise<Row>
  }
  now(): string
  randomId(): string
}

// ── Demo page keys ───────────────────────────────────────────────────────────

const DEMO_KEYS = {
  OPEN_ASSIGNED: 'shipment.open.assigned',
  CUSTOMER_AUTO: 'customer.auto',
  QUOTE_INBOUND: 'quote.inbound',
  BUILDING: 'shipment.building',
  POSTED: 'shipment.posted',
  IN_TRANSIT: 'shipment.intransit',
  IN_TRANSIT_1: 'shipment.intransit.1',
  IN_TRANSIT_2: 'shipment.intransit.2',
  IN_TRANSIT_3: 'shipment.intransit.3',
  IN_TRANSIT_4: 'shipment.intransit.4',
  POD_FLAGGED: 'shipment.podflagged',
  READY_TO_BILL: 'shipment.readytobill',
} as const

const STAFF_ROLES = [
  'carrier-rep',
  'carrier-rep',
  'carrier-team-lead',
  'sales-rep',
  'tracker',
  'accounting',
] as const

// ── Seeded data vocabulary ───────────────────────────────────────────────────

interface DemoLane {
  originCity: string
  originState: string
  originLat: number
  originLng: number
  destinationCity: string
  destinationState: string
  destinationLat: number
  destinationLng: number
  miles: number
}

const LANES: DemoLane[] = [
  { originCity: 'Chicago', originState: 'IL', originLat: 41.8781, originLng: -87.6298, destinationCity: 'Indianapolis', destinationState: 'IN', destinationLat: 39.7684, destinationLng: -86.1581, miles: 185 },
  { originCity: 'Dallas', originState: 'TX', originLat: 32.7767, originLng: -96.797, destinationCity: 'Houston', destinationState: 'TX', destinationLat: 29.7604, destinationLng: -95.3698, miles: 240 },
  { originCity: 'Atlanta', originState: 'GA', originLat: 33.749, originLng: -84.388, destinationCity: 'Charlotte', destinationState: 'NC', destinationLat: 35.2271, destinationLng: -80.8431, miles: 245 },
  { originCity: 'Los Angeles', originState: 'CA', originLat: 34.0522, originLng: -118.2437, destinationCity: 'Phoenix', destinationState: 'AZ', destinationLat: 33.4484, destinationLng: -112.074, miles: 375 },
  { originCity: 'Denver', originState: 'CO', originLat: 39.7392, originLng: -104.9903, destinationCity: 'Salt Lake City', destinationState: 'UT', destinationLat: 40.7608, destinationLng: -111.891, miles: 525 },
  { originCity: 'Seattle', originState: 'WA', originLat: 47.6062, originLng: -122.3321, destinationCity: 'Portland', destinationState: 'OR', destinationLat: 45.5152, destinationLng: -122.6784, miles: 175 },
  { originCity: 'Detroit', originState: 'MI', originLat: 42.3314, originLng: -83.0458, destinationCity: 'Cleveland', destinationState: 'OH', destinationLat: 41.4993, destinationLng: -81.6944, miles: 170 },
  { originCity: 'Memphis', originState: 'TN', originLat: 35.1495, originLng: -90.049, destinationCity: 'Nashville', destinationState: 'TN', destinationLat: 36.1627, destinationLng: -86.7816, miles: 210 },
  { originCity: 'Miami', originState: 'FL', originLat: 25.7617, originLng: -80.1918, destinationCity: 'Orlando', destinationState: 'FL', destinationLat: 28.5383, destinationLng: -81.3792, miles: 235 },
  { originCity: 'Philadelphia', originState: 'PA', originLat: 39.9526, originLng: -75.1652, destinationCity: 'Baltimore', destinationState: 'MD', destinationLat: 39.2904, destinationLng: -76.6122, miles: 105 },
  { originCity: 'Kansas City', originState: 'MO', originLat: 39.0997, originLng: -94.5786, destinationCity: 'St. Louis', destinationState: 'MO', destinationLat: 38.627, destinationLng: -90.1994, miles: 250 },
  { originCity: 'Boston', originState: 'MA', originLat: 42.3601, originLng: -71.0589, destinationCity: 'New York', destinationState: 'NY', destinationLat: 40.7128, destinationLng: -74.006, miles: 215 },
]

const CUSTOMER_NAMES = [
  'Acme Distribution',
  'Best Buy Logistics',
  'Cardinal Freight',
  'Delta Supply Co',
  'Evergreen Foods',
  'Fastener Plus',
  'Gulf Coast Materials',
  'Hawthorne Auto',
]

const DIVISIONS = ['BROKERAGE', 'CAR_SHIPPING', 'ASSETS'] as const

// ── Validation ───────────────────────────────────────────────────────────────

function assertDevStack(isDevStack: boolean): void {
  if (!isDevStack) {
    throw new Error('The demo seed only runs on the dev stack')
  }
}

// ── Id helpers ───────────────────────────────────────────────────────────────

function demoRecordId(kind: string, demoKey: string): string {
  return `demo:${kind}:${demoKey}`
}

function postingId(shipmentId: string, provider: string): string {
  return `post:${shipmentId}:${provider}`
}

function threadKey(shipmentId: string): string {
  return `tracking+${shipmentId}`
}

// ── DynamoDB-shaped transaction helpers ──────────────────────────────────────

function putTx(table: string, item: Row): TransactWriteItem {
  return { Put: { TableName: table, Item: marshallRow(item) } }
}

function deleteTx(table: string, id: string): TransactWriteItem {
  return { Delete: { TableName: table, Key: marshallRow({ id }) } }
}

/** Stamp a patch with the audit columns the demo's raw updates must keep current. */
function stampedPatch(
  deps: DemoDeps,
  caller: Caller,
  patch: Row,
): Row {
  return { ...patch, updatedAt: deps.now(), updatedBy: caller.email }
}

export function updateTx(
  table: string,
  id: string,
  patch: Row,
  expectedUpdatedAt: string,
  remove?: string[],
): TransactWriteItem {
  return updateItemTx(table, id, patch, expectedUpdatedAt, { remove })
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function seedSettings(deps: DemoDeps, caller: Caller): Promise<Row> {
  let settings = await deps.getSettings()
  const now = deps.now()
  const patch: Row = {
    demoSeedVersion: SEED_VERSION,
    demoSeededAt: now,
    marginTargetBps: DEFAULT_MARGIN_TARGET_BPS,
    marginTargetBpsByMode: { FTL: DEFAULT_MARGIN_TARGET_BPS, LTL: 2500 },
    quoteAutoReplyDefault: false,
    defaultRequiredLoadFields: [...DEFAULT_REQUIRED_LOAD_FIELDS],
    defaultCheckCallPlan: DEFAULT_CHECK_CALL_PLAN,
  }

  if (!settings) {
    settings = {
      id: 'default',
      __typename: 'TmsSettings',
      ...patch,
      createdBy: caller.email,
      updatedBy: caller.email,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    await deps.transact([putTx(deps.tables.settings, settings)])
  } else {
    await deps.transact([
      updateTx(deps.tables.settings, String(settings.id), stampedPatch(deps, caller, patch), String(settings.updatedAt ?? '')),
    ])
    settings = { ...settings, ...patch, updatedAt: now }
  }
  return settings
}

// ── Directory rows (written directly because their routers live elsewhere) ───

async function seedCustomers(deps: DemoDeps, caller: Caller, counts: Record<string, number>): Promise<Row[]> {
  const now = deps.now()
  const customers: Row[] = []
  const writes: TransactWriteItem[] = []

  for (let i = 0; i < CUSTOMER_NAMES.length; i++) {
    const name = CUSTOMER_NAMES[i]
    const id = `cust-demo-${i + 1}`
    const isAuto = i === 0
    const row: Row = {
      id,
      __typename: 'Customer',
      name,
      normalizedName: name.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim(),
      status: 'ACTIVE',
      ...(isAuto
        ? {
            defaultCarrierTeamKey: 'coverage-dallas',
            marginTargetBps: 2200,
            marginFloorBps: 800,
            quoteAutoReply: true,
            requiredLoadFields: ['poNumber', 'commodity'],
            checkCallPlan: DEFAULT_CHECK_CALL_PLAN,
          }
        : {}),
      createdBy: caller.email,
      updatedBy: caller.email,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    customers.push(row)
    writes.push(putTx(deps.tables.customer, row))
  }

  await deps.transact(writes)
  for (const c of customers) {
    await recordDemo(deps, 'CUSTOMER', `customer:${String(c.id)}`, String(c.id), caller, { label: String(c.name) })
  }
  counts.CUSTOMER = customers.length
  return customers
}

async function seedCarriers(deps: DemoDeps, caller: Caller, counts: Record<string, number>): Promise<Row[]> {
  const now = deps.now()
  const carriers: Row[] = [
    {
      id: 'carr-demo-vetted',
      __typename: 'Carrier',
      name: 'Vetted Transport LLC',
      status: 'ACTIVE',
      authorityStatus: 'ACTIVE',
      mcNumber: 'MC-123456',
      dotNumber: '2345678',
      dispatcherName: 'Dispatch',
      dispatcherEmail: 'dispatch@vetted.example',
      dispatcherPhone: '555-0101',
      insurancePolicies: [
        { type: 'AUTO_LIABILITY', expiresAt: '2099-12-31T23:59:59.000Z' },
        { type: 'CARGO', expiresAt: '2099-12-31T23:59:59.000Z', limitCents: 1_000_000_00 },
      ],
      createdBy: caller.email,
      updatedBy: caller.email,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    {
      id: 'carr-demo-lapsed',
      __typename: 'Carrier',
      name: 'Lapsed Insurance Trucking',
      status: 'ACTIVE',
      mcNumber: 'MC-234567',
      insurancePolicies: [{ type: 'CARGO', expiresAt: '2020-01-01T00:00:00.000Z' }],
      createdBy: caller.email,
      updatedBy: caller.email,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    {
      id: 'carr-demo-nobuy',
      __typename: 'Carrier',
      name: 'Double Brokering Inc',
      status: 'DO_NOT_USE',
      statusReason: 'DOUBLE_BROKERING',
      mcNumber: 'MC-345678',
      createdBy: caller.email,
      updatedBy: caller.email,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
  ]

  await deps.transact(carriers.map((c) => putTx(deps.tables.carrier, c)))

  const vetted = carriers[0]
  const docTypes = ['COI_CARGO', 'COI_AUTO', 'W9', 'CARRIER_AGREEMENT']
  const carrierDocs: Row[] = docTypes.map((type) => ({
    id: `cdoc-${String(vetted.id)}-${type}`,
    __typename: 'CarrierDocument',
    carrierId: vetted.id,
    type,
    name: `${type}.pdf`,
    s3Key: `carrier-docs/${vetted.id}/${type}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 1024,
    source: 'UPLOAD',
    uploadedBy: caller.email,
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }))
  await deps.transact(carrierDocs.map((d) => putTx(deps.tables.carrierDocument, d)))

  for (const c of carriers) {
    await recordDemo(deps, 'CARRIER', `carrier:${String(c.id)}`, String(c.id), caller, { label: String(c.name) })
  }
  counts.CARRIER = carriers.length
  return carriers
}

async function seedStaff(
  deps: DemoDeps,
  input: Row,
  caller: Caller,
  counts: Record<string, number>,
): Promise<Array<{ id: string; name: string; role: string }>> {
  const provided = Array.isArray(input.staff)
    ? input.staff.filter((s: unknown) => s && typeof s === 'object')
    : []

  const staff: Array<{ id: string; name: string; role: string }> = []
  for (let i = 0; i < STAFF_ROLES.length; i++) {
    const providedRow = provided[i] as Row | undefined
    staff.push({
      id: typeof providedRow?.id === 'string' ? providedRow.id : caller.sub,
      name: typeof providedRow?.name === 'string' ? providedRow.name : caller.email,
      role: String(STAFF_ROLES[i]),
    })
  }

  const writes: TransactWriteItem[] = []
  for (let i = 0; i < staff.length; i++) {
    const person = staff[i]
    const demoKey = `staff:${i}:${person.role}`
    if (await deps.getById(deps.tables.demo, demoRecordId('STAFF', demoKey))) {
      continue
    }
    writes.push(putTx(deps.tables.demo, {
      id: demoRecordId('STAFF', demoKey),
      kind: 'STAFF',
      demoKey,
      recordId: person.id,
      seedVersion: SEED_VERSION,
      label: person.name,
      detail: { role: person.role },
      createdBy: caller.email,
    }))
  }
  if (writes.length) await deps.transact(writes)
  counts.STAFF = (await queryByKind(deps, 'STAFF')).length
  return staff
}

// ── Demo-record bookkeeping ──────────────────────────────────────────────────

async function recordDemo(
  deps: DemoDeps,
  kind: string,
  demoKey: string,
  recordId: string,
  caller: Caller,
  opts: { step?: string; label?: string; detail?: Row } = {},
): Promise<void> {
  await deps.transact([
    putTx(deps.tables.demo, {
      id: demoRecordId(kind, demoKey),
      kind,
      demoKey,
      recordId,
      seedVersion: SEED_VERSION,
      step: opts.step ?? null,
      label: opts.label ?? demoKey,
      detail: opts.detail ?? null,
      createdBy: caller.email,
    }),
  ])
}

async function queryByKind(deps: DemoDeps, kind: string): Promise<Row[]> {
  return deps.queryIndex(deps.tables.demo, 'demoRecordsByKindAndDemoKey', 'kind', kind)
}

async function allDemoRecords(deps: DemoDeps): Promise<Row[]> {
  return deps.scanTable(deps.tables.demo)
}

async function recordRows(deps: DemoDeps, kind: string, prefix: string, rows: Row[], caller: Caller): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    await recordDemo(deps, kind, `${prefix}:${i}`, String(rows[i].id), caller, { label: `${kind} ${i}` })
  }
}

// ── Freight generation ───────────────────────────────────────────────────────

interface ShipmentPlan {
  customerIndex: number
  laneIndex: number
  division: string
  status: string
  loadStatus: string
  rateCents: number
  equipmentType: string
  mode: string
}

function buildShipmentPlans(count: number): ShipmentPlan[] {
  const plans: ShipmentPlan[] = []
  const statuses: Array<{ status: string; loadStatus: string }> = [
    { status: 'OPEN', loadStatus: 'SOURCING' },
    { status: 'OPEN', loadStatus: 'BOOKED' },
    { status: 'OPEN', loadStatus: 'SOURCING' },
    { status: 'OPEN', loadStatus: 'SOURCING' },
    { status: 'OPEN', loadStatus: 'SOURCING' },
    { status: 'OPEN', loadStatus: 'SOURCING' },
    { status: 'OPEN', loadStatus: 'SOURCING' },
    { status: 'OPEN', loadStatus: 'SOURCING' },
    { status: 'ON_HOLD', loadStatus: 'SOURCING' },
    { status: 'TENDER_PENDING', loadStatus: 'SOURCING' },
    { status: 'CANCELED', loadStatus: 'CANCELED' },
  ]

  for (let i = 0; i < count; i++) {
    const lane = LANES[i % LANES.length]
    const statusSpec = statuses[i % statuses.length]
    const baseRate = 2200 + lane.miles * 22
    plans.push({
      customerIndex: i % CUSTOMER_NAMES.length,
      laneIndex: i % LANES.length,
      division: DIVISIONS[i % DIVISIONS.length],
      status: statusSpec.status,
      loadStatus: statusSpec.loadStatus,
      rateCents: Math.round(baseRate + (i % 5) * 150),
      equipmentType: i % 3 === 0 ? 'VAN' : i % 3 === 1 ? 'REEFER' : 'FLATBED',
      mode: 'FTL',
    })
  }
  return plans
}

function makeStops(lane: DemoLane, now: string): Row[] {
  const pickupAppt = new Date(now)
  pickupAppt.setDate(pickupAppt.getDate() + 2)
  const deliveryAppt = new Date(pickupAppt)
  deliveryAppt.setDate(deliveryAppt.getDate() + 1)
  return [
    {
      id: `stp-${lane.originCity.toLowerCase()}`,
      type: 'pickup',
      sequence: 0,
      name: `${lane.originCity} Shipper`,
      city: lane.originCity,
      state: lane.originState,
      address: {
        street: '100 Industrial Blvd',
        city: lane.originCity,
        state: lane.originState,
        zip: '00000',
        lat: lane.originLat,
        lng: lane.originLng,
      },
      appt: pickupAppt.toISOString(),
      arrivedAt: null,
      departedAt: null,
    },
    {
      id: `stp-${lane.destinationCity.toLowerCase()}`,
      type: 'delivery',
      sequence: 1,
      name: `${lane.destinationCity} Receiver`,
      city: lane.destinationCity,
      state: lane.destinationState,
      address: {
        street: '200 Commerce Pkwy',
        city: lane.destinationCity,
        state: lane.destinationState,
        zip: '00000',
        lat: lane.destinationLat,
        lng: lane.destinationLng,
      },
      appt: deliveryAppt.toISOString(),
      arrivedAt: null,
      departedAt: null,
    },
  ]
}

async function createBaseShipment(
  deps: DemoDeps,
  caller: Caller,
  customer: Row,
  plan: ShipmentPlan,
  source: string,
): Promise<{ shipment: Row; order: Row; load: Row }> {
  const lane = LANES[plan.laneIndex]
  const stops = makeStops(lane, deps.now())
  const result = await deps.actions.createShipment(
    {
      customerId: customer.id,
      mode: plan.mode,
      source,
      load: {
        stops,
        rateCents: plan.rateCents,
        equipmentType: plan.equipmentType,
        miles: lane.miles,
        weight: 20000 + (plan.laneIndex * 1000),
      },
    },
    caller,
  )

  const bundle = ((result as Row).bundle as Row | undefined) ?? (result as Row)
  const shipment = bundle.shipment as Row
  const order = (bundle.orders as Row[])[0]
  const load = (bundle.loads as Row[])[0]
  if (!shipment || !shipment.id) {
    throw new Error(`createBaseShipment: missing shipment. result keys=${Object.keys(result as Row).join(',')} bundle keys=${Object.keys(bundle).join(',')} shipment=${JSON.stringify(shipment)}`)
  }
  return { shipment, order, load }
}

// ── The main seed ────────────────────────────────────────────────────────────

export async function seedDemoData(deps: DemoDeps, input: Row, caller: Caller): Promise<Row> {
  assertDevStack(deps.isDevStack)
  const existing = await allDemoRecords(deps)
  if (existing.length > 0) {
    // Idempotent: once the demo fingerprint exists, a second run is a no-op.
    return {
      counts: countByKind(existing),
      seedVersion: SEED_VERSION,
      created: 0,
      skipped: existing.length,
    }
  }

  const counts: Record<string, number> = {}
  const createdIds: Record<string, string[]> = {}

  await seedSettings(deps, caller)
  counts.SETTING = 1

  const customers = await seedCustomers(deps, caller, counts)
  const carriers = await seedCarriers(deps, caller, counts)
  const staff = await seedStaff(deps, input, caller, counts)

  const autoCustomer = customers[0]
  const vettedCarrier = carriers.find((c) => String(c.id) === 'carr-demo-vetted')!

  const repId = staff.find((s) => s.role === 'carrier-rep')?.id ?? caller.sub
  const salesRepId = staff.find((s) => s.role === 'sales-rep')?.id ?? caller.sub

  const plans = buildShipmentPlans(16)
  let bookedDemoCarrier = false
  const createdShipments: Array<{ shipment: Row; order: Row; load: Row }> = []
  const tagTxs: TransactWriteItem[] = []
  const demoRows: Row[] = []

  for (const plan of plans) {
    const customer = customers[plan.customerIndex]
    const source = plan.status === 'TENDER_PENDING' ? 'TENDER' : 'MANUAL'
    const { shipment, order, load } = await createBaseShipment(deps, caller, customer, plan, source)
    createdShipments.push({ shipment, order, load })

    // Division and rep tagging is written directly after creation because the
    // ownership rules are admin data this Lambda does not own.
    const divisionPatch = {
      revDivision: plan.division,
      revSubdivision: null,
      revTagSource: 'HAND',
      revTaggedBy: caller.email,
      salesRepId,
    }
    tagTxs.push(
      updateTx(deps.tables.shipment, String(shipment.id), stampedPatch(deps, caller, divisionPatch), String(shipment.updatedAt ?? '')),
      updateTx(deps.tables.load, String(load.id), stampedPatch(deps, caller, divisionPatch), String(load.updatedAt ?? '')),
      updateTx(deps.tables.order, String(order.id), stampedPatch(deps, caller, { customerRepId: salesRepId }), String(order.updatedAt ?? '')),
    )
    const recordNow = deps.now()
    demoRows.push({
      id: demoRecordId('SHIPMENT', `shipment:${createdShipments.length - 1}`),
      kind: 'SHIPMENT',
      demoKey: `shipment:${createdShipments.length - 1}`,
      recordId: String(shipment.id),
      seedVersion: SEED_VERSION,
      step: null,
      label: `Demo shipment ${String(shipment.number)}`,
      detail: null,
      createdBy: caller.email,
      createdAt: recordNow,
      updatedAt: recordNow,
    })
  }

  // One transaction for all ownership tags and one for all demo index rows.
  await deps.transact(tagTxs)
  await deps.transact(demoRows.map((row) => putTx(deps.tables.demo, row)))

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    const { shipment, load } = createdShipments[i]

    // Move the shipment through the states the plan asks for. TENDER_PENDING is
    // the one state createShipment already produces; do not submit it.
    if (plan.status !== 'DRAFT' && plan.status !== 'TENDER_PENDING') {
      await deps.actions.submitOrder({ shipmentId: shipment.id }, caller)
    }

    const currentShipment = await deps.getById(deps.tables.shipment, String(shipment.id))
    const currentLoad = await deps.getById(deps.tables.load, String(load.id))
    const shipmentUpdatedAt = String(currentShipment?.updatedAt ?? '')
    const loadUpdatedAt = String(currentLoad?.updatedAt ?? '')

    if (plan.status === 'ON_HOLD') {
      await deps.actions.setShipmentStatus(
        { shipmentId: shipment.id, status: 'ON_HOLD', reason: 'demo hold', expectedUpdatedAt: shipmentUpdatedAt },
        caller,
      )
    } else if (plan.status === 'CANCELED') {
      await deps.actions.setShipmentStatus(
        { shipmentId: shipment.id, status: 'CANCELED', reason: 'demo cancel', expectedUpdatedAt: shipmentUpdatedAt },
        caller,
      )
      if (currentLoad) {
        await deps.transact([
          updateTx(deps.tables.load, String(load.id), stampedPatch(deps, caller, { status: 'CANCELED' }), String(currentLoad.updatedAt ?? '')),
        ])
      }
    }

    if (plan.loadStatus === 'BOOKED' && plan.status !== 'TENDER_PENDING' && plan.status !== 'CANCELED' && currentLoad && !bookedDemoCarrier) {
      bookedDemoCarrier = true
      await deps.actions.bookCarrier(
        {
          loadId: load.id,
          carrierId: vettedCarrier.id,
          carrierRateCents: Math.round(plan.rateCents * 0.75),
          expectedUpdatedAt: loadUpdatedAt,
        },
        caller,
      )
      const bookedLoad = await deps.getById(deps.tables.load, String(load.id))
      if (bookedLoad?.activeLoadCarrierId) {
        await recordDemo(deps, 'LOAD_CARRIER', `loadcarrier:booked`, String(bookedLoad.activeLoadCarrierId), caller, {
          step: 'P2',
          label: 'Booked demo carrier leg',
        })
      }
    }
  }

  // Refresh shipment rows after actions moved them forward.
  let seededShipments: Row[] = (await Promise.all(
    createdShipments.map(({ shipment }) => deps.getById(deps.tables.shipment, String(shipment.id))),
  )).filter((r): r is Row => Boolean(r))
  counts.SHIPMENT = seededShipments.length

  // Stage a subset of shipments into the later rungs of the tracking ladder so
  // the demo has 5 real in-transit rows plus 2 delivered rows for POD/billing fixtures.
  await stageTrackingStates(deps, [...seededShipments.slice(11, 16), ...seededShipments.slice(2, 6)], caller)

  // Re-read so the named fixtures pick up the staged statuses.
  seededShipments = (await Promise.all(
    createdShipments.map(({ shipment }) => deps.getById(deps.tables.shipment, String(shipment.id))),
  )).filter((r): r is Row => Boolean(r))

  const openShipment = seededShipments.find((s) => String(s.status) === 'OPEN' && !s.voidedAt)
  if (openShipment) {
    await deps.actions.assignCarrierRep({ shipmentId: openShipment.id, repId }, caller)
    await recordDemo(deps, 'SHIPMENT', DEMO_KEYS.OPEN_ASSIGNED, String(openShipment.id), caller, {
      step: 'P2',
      label: 'Open shipment assigned to rep',
    })
  }

  await recordDemo(deps, 'CUSTOMER', DEMO_KEYS.CUSTOMER_AUTO, String(autoCustomer.id), caller, {
    step: 'P3',
    label: 'Customer with flow defaults',
  })

  // assignCarrierRep touched the shipment it assigned, so the named fixtures
  // below need a fresh read before their own CAS updates.
  seededShipments = (await Promise.all(
    createdShipments.map(({ shipment }) => deps.getById(deps.tables.shipment, String(shipment.id))),
  )).filter((r): r is Row => Boolean(r))

  const buildingShipment = seededShipments[0]
  if (buildingShipment) {
    const buildingLoad = await loadOfShipment(deps, String(buildingShipment.id))
    await deps.transact([
      updateTx(deps.tables.shipment, String(buildingShipment.id), stampedPatch(deps, caller, {
        status: 'DRAFT',
        buildState: 'BUILDING',
        missingFields: ['salesRep', 'billTo', 'poNumber'],
      }), String(buildingShipment.updatedAt ?? '')),
      ...(buildingLoad
        ? [updateTx(deps.tables.load, String(buildingLoad.id), stampedPatch(deps, caller, { status: 'SOURCING' }), String(buildingLoad.updatedAt ?? ''))]
        : []),
    ])
    await recordDemo(deps, 'SHIPMENT', DEMO_KEYS.BUILDING, String(buildingShipment.id), caller, {
      step: 'P5',
      label: 'Building shipment with missing fields',
    })
  }

  const postedShipment = seededShipments.find((s) => String(s.status) === 'OPEN' && s.id !== openShipment?.id && s.id !== buildingShipment?.id)
  if (postedShipment) {
    const now = deps.now()
    const postings: Row[] = [
      {
        id: postingId(String(postedShipment.id), 'DAT'),
        __typename: 'ShipmentPosting',
        shipmentId: postedShipment.id,
        provider: 'DAT',
        status: 'POSTED',
        mode: 'STUB',
        boardPostingId: `stub:${postedShipment.id}:dat`,
        message: 'STUB — posted to DAT (demo)',
        postedAt: now,
        postedBy: caller.email,
        offerCount: 3,
        createdBy: caller.email,
        updatedBy: caller.email,
        version: 1,
      },
      {
        id: postingId(String(postedShipment.id), 'TRUCKSTOP'),
        __typename: 'ShipmentPosting',
        shipmentId: postedShipment.id,
        provider: 'TRUCKSTOP',
        status: 'POSTED',
        mode: 'STUB',
        boardPostingId: `stub:${postedShipment.id}:truckstop`,
        message: 'STUB — posted to Truckstop (demo)',
        postedAt: now,
        postedBy: caller.email,
        offerCount: 0,
        createdBy: caller.email,
        updatedBy: caller.email,
        version: 1,
      },
    ]
    const loadForPosted = await loadOfShipment(deps, String(postedShipment.id))
    const offers: Row[] = [
      makeOffer(deps, caller, postedShipment, loadForPosted, 'Vetted Transport LLC', 'MC-123456', 'carr-demo-vetted'),
      makeOffer(deps, caller, postedShipment, loadForPosted, 'Lapsed Insurance Trucking', 'MC-234567', 'carr-demo-lapsed'),
      makeOffer(deps, caller, postedShipment, loadForPosted, 'Unknown Carrier', 'MC-UNKNOWN', undefined),
    ]

    await deps.transact([
      updateTx(deps.tables.shipment, String(postedShipment.id), stampedPatch(deps, caller, { postedBoards: ['DAT', 'TRUCKSTOP'], carrierOfferOpen: 'OPEN' }), String(postedShipment.updatedAt ?? '')),
      ...postings.map((p) => putTx(deps.tables.posting, p)),
      ...offers.map((q) => putTx(deps.tables.quote, q)),
    ])
    await recordDemo(deps, 'SHIPMENT', DEMO_KEYS.POSTED, String(postedShipment.id), caller, {
      step: 'P6',
      label: 'Posted shipment with carrier offers',
    })
    await recordRows(deps, 'POSTING', 'posting', postings, caller)
    await recordRows(deps, 'QUOTE', 'quote:offer', offers, caller)
    createdIds.POSTING = postings.map((p) => String(p.id))
    createdIds.QUOTE = offers.map((q) => String(q.id))
  }

  const inTransitShipments = seededShipments.filter((s) => String(s.status) === 'IN_TRANSIT')
  const inTransitKeys = [DEMO_KEYS.IN_TRANSIT, DEMO_KEYS.IN_TRANSIT_1, DEMO_KEYS.IN_TRANSIT_2, DEMO_KEYS.IN_TRANSIT_3, DEMO_KEYS.IN_TRANSIT_4]
  for (let i = 0; i < inTransitShipments.length && i < inTransitKeys.length; i++) {
    const inTransitShipment = inTransitShipments[i]
    const tKey = threadKey(String(inTransitShipment.id))
    const now = deps.now()
    const loadRow = await loadOfShipment(deps, String(inTransitShipment.id))
    if (!loadRow) continue

    const contacts = trackingFixtureContacts(i)
    const carrierLeg = makeDemoCarrierLeg(deps, caller, inTransitShipment, loadRow, vettedCarrier)
    const currentCity = String(loadRow.lastKnownCity ?? '')
    const currentState = String(loadRow.lastKnownState ?? '')
    const prevCity = String(loadRow.lastKnownPreviousCity ?? '')
    const prevState = String(loadRow.lastKnownPreviousState ?? '')
    const currentPlace = [currentCity, currentState].filter(Boolean).join(', ') || 'en route'
    const prevPlace = [prevCity, prevState].filter(Boolean).join(', ') || 'origin'
    const previousAt = String(loadRow.lastKnownPreviousAt ?? now)
    const currentAt = String(loadRow.lastKnownAt ?? now)

    const messages: Row[] = [
      makeMessage(deps, caller, inTransitShipment, loadRow, {
        channel: 'EMAIL', kind: 'RATE_CON', direction: 'OUT', subject: 'Rate confirmation', body: 'Rate con attached. Please confirm pickup window.',
        authorKind: 'AGENT', authorName: 'BCAT Tracking Assistant', status: 'SENT',
      }),
      makeMessage(deps, caller, inTransitShipment, loadRow, {
        channel: 'SMS', kind: 'CHECK_CALL', direction: 'OUT', body: `Hi ${contacts.driverName}, can you share your current city?`,
        authorKind: 'AGENT', authorName: 'BCAT Tracking Assistant', status: 'SENT',
      }),
      makeMessage(deps, caller, inTransitShipment, loadRow, {
        channel: 'SMS', kind: 'CHECK_CALL_REPLY', direction: 'IN', body: `In ${prevPlace}`, party: 'DRIVER',
        authorKind: 'PERSON', authorName: contacts.driverName,
      }),
      makeMessage(deps, caller, inTransitShipment, loadRow, {
        channel: 'SMS', kind: 'CHECK_CALL_REPLY', direction: 'IN', body: `Just passed ${currentPlace}`, party: 'DRIVER',
        authorKind: 'PERSON', authorName: contacts.driverName,
      }),
      makeMessage(deps, caller, inTransitShipment, loadRow, {
        channel: 'SMS', kind: 'POD_REQUEST', direction: 'OUT', body: 'Please send POD photos at delivery.',
        authorKind: 'AGENT', authorName: 'BCAT Tracking Assistant', status: 'SENT',
      }),
      makeMessage(deps, caller, inTransitShipment, loadRow, {
        channel: 'SMS', kind: 'ESCALATION', direction: 'OUT', body: 'No reply in 30 min — repeat check call.',
        authorKind: 'AGENT', authorName: 'BCAT Tracking Assistant', status: 'SENT',
      }),
    ]
    const checkCalls: Row[] = [
      makeCheckCall(deps, caller, inTransitShipment, loadRow, { type: 'DISPATCH', at: now }),
      makeCheckCall(deps, caller, inTransitShipment, loadRow, {
        type: 'LOCATION_UPDATE', at: previousAt, city: prevCity, state: prevState,
        lat: Number(loadRow.lastKnownPreviousLat ?? 0) || null,
        lng: Number(loadRow.lastKnownPreviousLng ?? 0) || null,
      }),
      makeCheckCall(deps, caller, inTransitShipment, loadRow, {
        type: 'LOCATION_UPDATE', at: currentAt, city: currentCity, state: currentState,
        lat: Number(loadRow.lastKnownLat ?? 0) || null,
        lng: Number(loadRow.lastKnownLng ?? 0) || null,
      }),
    ]

    // Patch the seeded carrier leg with varied, realistic contacts.
    carrierLeg.driverName = contacts.driverName
    carrierLeg.driverPhone = contacts.driverPhone
    carrierLeg.dispatcherName = contacts.dispatcherName
    carrierLeg.dispatcherEmail = contacts.dispatcherEmail
    carrierLeg.dispatcherPhone = contacts.dispatcherPhone

    await deps.transact([
      updateTx(deps.tables.shipment, String(inTransitShipment.id), stampedPatch(deps, caller, { threadKey: tKey, threadOpenedAt: now }), String(inTransitShipment.updatedAt ?? '')),
      putTx(deps.tables.loadCarrier, carrierLeg),
      updateTx(deps.tables.load, String(loadRow.id), stampedPatch(deps, caller, {
        activeLoadCarrierId: carrierLeg.id, carrierName: vettedCarrier.name, assignmentType: 'CARRIER',
        carrierRepId: repId, trackingProvider: 'MANUAL', checkCallPlan: DEFAULT_CHECK_CALL_PLAN,
        checkCallPlanStartedAt: previousAt,
      }), String(loadRow.updatedAt ?? '')),
      ...messages.map((m) => putTx(deps.tables.message, m)),
      ...checkCalls.map((c) => putTx(deps.tables.checkCall, c)),
    ])
    await recordDemo(deps, 'SHIPMENT', inTransitKeys[i], String(inTransitShipment.id), caller, {
      step: 'P8',
      label: `In-transit shipment ${i + 1} with thread`,
    })
    await recordRows(deps, 'MESSAGE', `message:intransit:${i}`, messages, caller)
    await recordRows(deps, 'CHECK_CALL', `checkcall:intransit:${i}`, checkCalls, caller)
    await recordRows(deps, 'LOAD_CARRIER', `loadcarrier:intransit:${i}`, [carrierLeg], caller)
    createdIds.MESSAGE = [...(createdIds.MESSAGE ?? []), ...messages.map((m) => String(m.id))]
    createdIds.CHECK_CALL = [...(createdIds.CHECK_CALL ?? []), ...checkCalls.map((c) => String(c.id))]
    createdIds.LOAD_CARRIER = [...(createdIds.LOAD_CARRIER ?? []), String(carrierLeg.id)]
  }

  const deliveredForPod = seededShipments.filter((s) => String(s.status) === 'DELIVERED')
  const podFlaggedShipment = deliveredForPod[0]
  const readyToBillShipment = deliveredForPod[1]

  if (podFlaggedShipment) {
    const now = deps.now()
    const rejectedDocs: Row[] = [
      makePodDocument(deps, caller, podFlaggedShipment, { name: 'POD page 1 of 2', pages: 1, reviewStatus: 'REJECTED', reviewNote: 'page count mismatch' }),
      makePodDocument(deps, caller, podFlaggedShipment, { name: 'POD blurry', pages: 2, reviewStatus: 'REJECTED', reviewNote: 'illegible' }),
    ]
    await deps.transact([
      updateTx(deps.tables.shipment, String(podFlaggedShipment.id), stampedPatch(deps, caller, { podFlaggedAt: now, podFlagReason: 'POD rejected twice' }), String(podFlaggedShipment.updatedAt ?? '')),
      ...rejectedDocs.map((d) => putTx(deps.tables.document, d)),
    ])
    await recordDemo(deps, 'SHIPMENT', DEMO_KEYS.POD_FLAGGED, String(podFlaggedShipment.id), caller, {
      step: 'P9',
      label: 'Delivered shipment with rejected PODs',
    })
    await recordRows(deps, 'DOCUMENT', 'document', rejectedDocs, caller)
    createdIds.DOCUMENT = rejectedDocs.map((d) => String(d.id))
  }

  if (readyToBillShipment) {
    const order = await orderOfShipment(deps, String(readyToBillShipment.id))
    const readyToBillLoad = await loadOfShipment(deps, String(readyToBillShipment.id))
    const readyToBillOrder = order ?? { updatedAt: '' }
    const cleanPod = makePodDocument(deps, caller, readyToBillShipment, {
      name: 'POD clean',
      pages: 3,
      reviewStatus: 'ACCEPTED',
      reviewNote: 'clean',
      orderId: readyToBillOrder.id as string | undefined,
    })
    const bolDoc = makeBolDocument(deps, caller, readyToBillShipment, { orderId: readyToBillOrder.id as string | undefined })
    const carrierLeg = readyToBillLoad
      ? makeDemoCarrierLeg(deps, caller, readyToBillShipment, readyToBillLoad, vettedCarrier)
      : null
    const references = Array.isArray(order?.references) ? (order.references as Row[]) : []
    const hasPo = references.some((r) => String(r.code ?? '').toUpperCase() === 'PO')
    const patchedReferences = hasPo
      ? references
      : [...references, { code: 'PO', label: 'PO number', value: 'PO-P-DEMO-002', level: 'ORDER', visibility: 'INTERNAL' }]
    await deps.transact([
      putTx(deps.tables.document, cleanPod),
      putTx(deps.tables.document, bolDoc),
      ...(readyToBillOrder.id
        ? [updateTx(deps.tables.order, String(readyToBillOrder.id), stampedPatch(deps, caller, {
            arStatus: 'DOCS_NEEDED',
            docsMissing: [],
            docsRequired: ['POD'],
            references: patchedReferences,
          }), String(readyToBillOrder.updatedAt ?? ''))]
        : []),
      ...(carrierLeg ? [putTx(deps.tables.loadCarrier, carrierLeg)] : []),
    ])
    await recordDemo(deps, 'SHIPMENT', DEMO_KEYS.READY_TO_BILL, String(readyToBillShipment.id), caller, {
      step: 'P10',
      label: 'Ready-to-bill shipment with clean POD',
    })
    await recordRows(deps, 'DOCUMENT', 'document', [cleanPod, bolDoc], caller)
    if (carrierLeg) await recordRows(deps, 'LOAD_CARRIER', 'loadcarrier', [carrierLeg], caller)
    createdIds.DOCUMENT = [...(createdIds.DOCUMENT ?? []), String(cleanPod.id), String(bolDoc.id)]
  }

  // ── P4: the inbound quote priced from a (stub) market rate ─────────────────
  const inboundQuote = makeSellQuote(deps, caller, autoCustomer, { status: 'QUOTED', amountCents: 320000 })
  await deps.transact([putTx(deps.tables.quote, inboundQuote)])
  await recordDemo(deps, 'QUOTE', DEMO_KEYS.QUOTE_INBOUND, String(inboundQuote.id), caller, {
    step: 'P4',
    label: 'Inbound SELL quote from market rate',
  })
  createdIds.QUOTE = [...(createdIds.QUOTE ?? []), String(inboundQuote.id)]

  // ── Extra quotes in every state (SELL side) ────────────────────────────────

  const quoteStates = ['DRAFT', 'QUOTED', 'SENT_COUNTER', 'RECEIVED_REPLY', 'WON', 'LOST', 'PASS', 'CANCELED']
  const extraQuotes: Row[] = quoteStates.map((status, i) =>
    makeSellQuote(deps, caller, autoCustomer, { status, amountCents: 300000 + i * 10000 })
  )
  await deps.transact(extraQuotes.map((q) => putTx(deps.tables.quote, q)))
  await recordRows(deps, 'QUOTE', 'quote:extra', extraQuotes, caller)
  createdIds.QUOTE = [...(createdIds.QUOTE ?? []), ...extraQuotes.map((q) => String(q.id))]

  // ── AR bucket coverage ─────────────────────────────────────────────────────
  // DOCS_NEEDED is the default on every submitted order. UNBILLED is reachable
  // through the release gate; UNPAID and PAID are finance-router states, so the
  // seed writes a couple of representative Order rows directly. Pick from OPEN
  // shipments so the named fixtures that rely on DOCS_NEEDED are not overwritten.
  const openShipmentIds = seededShipments
    .filter((s) => String(s.status) === 'OPEN' && !s.voidedAt)
    .slice(0, 4)
    .map((s) => String(s.id))
  const arOrders = await ordersOfShipments(deps, openShipmentIds)
  const arWrites: TransactWriteItem[] = []
  if (arOrders[0]) {
    arWrites.push(updateTx(deps.tables.order, String(arOrders[0].id), stampedPatch(deps, caller, { arStatus: 'UNBILLED', readyToInvoiceAt: deps.now() }), String(arOrders[0].updatedAt ?? '')))
  }
  if (arOrders[1]) {
    arWrites.push(updateTx(deps.tables.order, String(arOrders[1].id), stampedPatch(deps, caller, { arStatus: 'UNPAID', invoiceNumber: 'INV-DEMO-001' }), String(arOrders[1].updatedAt ?? '')))
  }
  if (arOrders[2]) {
    arWrites.push(updateTx(deps.tables.order, String(arOrders[2].id), stampedPatch(deps, caller, { arStatus: 'PAID', invoiceNumber: 'INV-DEMO-002', paidAt: deps.now() }), String(arOrders[2].updatedAt ?? '')))
  }
  if (arWrites.length) await deps.transact(arWrites)

  // ── Final counts ───────────────────────────────────────────────────────────

  counts.QUOTE = (await deps.scanTable(deps.tables.quote)).length
  counts.POSTING = (await deps.scanTable(deps.tables.posting)).length
  counts.MESSAGE = (await deps.scanTable(deps.tables.message)).length
  counts.CHECK_CALL = (await deps.scanTable(deps.tables.checkCall)).length
  counts.DOCUMENT = (await deps.scanTable(deps.tables.document)).length

  const demoRecords = await allDemoRecords(deps)
  counts.DEMO_RECORD = demoRecords.length

  return {
    counts,
    seedVersion: SEED_VERSION,
    created: demoRecords.length,
    skipped: 0,
  }
}

// ── Reset ────────────────────────────────────────────────────────────────────

export async function resetDemoData(deps: DemoDeps, input: Row, caller: Caller): Promise<Row> {
  assertDevStack(deps.isDevStack)
  console.log('[RESET] start', { caller: caller.email, staffCount: Array.isArray(input.staff) ? input.staff.length : 0 })

  const allRecords = await allDemoRecords(deps)
  console.log('[RESET] records', { count: allRecords.length, kinds: countByKind(allRecords) })
  const shipmentRecordIds = allRecords
    .filter((r) => r.kind === 'SHIPMENT')
    .map((r) => String(r.recordId))
  const shipmentIds = [...new Set(shipmentRecordIds)]
  console.log('[RESET] shipments', { count: shipmentIds.length })
  const orders = await ordersOfShipments(deps, shipmentIds)
  console.log('[RESET] orders', { count: orders.length })

  // Seeding writes representative UNPAID/PAID orders directly for the AR bucket
  // demo; the real void action refuses to void a shipment with an invoice. On the
  // dev stack reset scrubs those markers before voiding so the seed can be fully
  // replayed from a blank index.
  const invoicedOrders = orders.filter(
    (o) => typeof o.invoiceNumber === 'string' || ['UNPAID', 'PAID'].includes(String(o.arStatus ?? '')),
  )
  if (invoicedOrders.length) {
    console.log('[RESET] invoicedOrders', { count: invoicedOrders.length, ids: invoicedOrders.map((o) => o.id) })
    const freshOrders = (await Promise.all(
      invoicedOrders.map((o) => deps.getById(deps.tables.order, String(o.id))),
    )).filter((o): o is Row => Boolean(o))
    console.log('[RESET] freshOrders', { count: freshOrders.length })
    await deps.transact(
      freshOrders.filter(Boolean).map((o) =>
        updateTx(
          deps.tables.order,
          String(o.id),
          stampedPatch(deps, caller, { arStatus: 'DOCS_NEEDED' }),
          String(o.updatedAt ?? ''),
          ['invoiceNumber', 'paidAt'],
        ),
      ),
    )
  }

  // Void every seeded shipment through the normal action, never by deleting it.
  // Skip shipments that are already voided so an interrupted reset can be retried.
  // Demo shipments can be touched by background sweeps between the read and the
  // void, so retry a few times on a conditional-check failure.
  console.log('[RESET] voiding', { count: shipmentIds.length })
  for (const shipmentId of shipmentIds) {
    let attempts = 0
    while (attempts < 5) {
      attempts++
      const shipment = await deps.getById(deps.tables.shipment, shipmentId)
      if (!shipment || isVoided(shipment)) break
      console.log('[RESET] void', { shipmentId, status: shipment.status, attempt: attempts })
      try {
        await deps.actions.voidShipment(
          {
            shipmentId,
            reason: 'demo reset',
            expectedUpdatedAt: String(shipment.updatedAt ?? ''),
          },
          caller,
        )
        break
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('changed by someone else') && attempts < 5) {
          console.log('[RESET] void conflict, retrying', { shipmentId, message })
          continue
        }
        throw err
      }
    }
  }

  // The real void keeps LoadCarrier legs readable, so their status stays ACTIVE.
  // Reset retires the demo carrier's active assignments so the next seed can book
  // the same demo carrier without a DOUBLE_BOOKED warning.
  const demoCarrierIds = [...new Set(allRecords.filter((r) => r.kind === 'CARRIER').map((r) => String(r.recordId)))]
  console.log('[RESET] retireCarriers', { count: demoCarrierIds.length })
  const retireAssignments: TransactWriteItem[] = []
  for (const carrierId of demoCarrierIds) {
    const active = await deps.queryIndex(deps.tables.loadCarrier, 'loadCarriersByCarrierId', 'carrierId', carrierId)
    for (const lc of active) {
      retireAssignments.push(
        updateTx(deps.tables.loadCarrier, String(lc.id), stampedPatch(deps, caller, { status: 'BOUNCED' }), String(lc.updatedAt ?? '')),
      )
    }
  }
  console.log('[RESET] retireAssignments', { count: retireAssignments.length })
  const BATCH_SIZE = 50
  for (let i = 0; i < retireAssignments.length; i += BATCH_SIZE) {
    await deps.transact(retireAssignments.slice(i, i + BATCH_SIZE))
  }

  // Delete only the seed's own flat fixtures; anything not tagged with a DemoRecord
  // (including non-demo shipments) is left untouched.
  const deletes: TransactWriteItem[] = []
  const seen = new Set<string>()
  for (const rec of allRecords) {
    const table = tableForKind(deps, String(rec.kind))
    // PRO rule: never delete a Shipment row. DemoRecords themselves are always
    // deleted so the next seed starts from an empty index.
    if (table && rec.kind !== 'SHIPMENT') {
      const key = `${table}#${String(rec.recordId)}`
      if (!seen.has(key)) {
        seen.add(key)
        deletes.push(deleteTx(table, String(rec.recordId)))
      }
    }
    deletes.push(deleteTx(deps.tables.demo, String(rec.id)))
  }
  // DynamoDB accepts at most 100 items in one TransactWriteItems request, and
  // never two operations on one item. The dedup guard above prevents duplicate
  // deletes from the same recordId; this batches the rest.
  console.log('[RESET] deletes', { count: deletes.length })
  const MAX_TX = 100
  for (let i = 0; i < deletes.length; i += MAX_TX) {
    const chunk = deletes.slice(i, i + MAX_TX)
    await deps.transact(chunk)
  }

  // Re-seed from a blank demo index.
  console.log('[RESET] seeding')
  return seedDemoData(deps, input, caller)
}

function tableForKind(deps: DemoDeps, kind: string): string | null {
  switch (kind) {
    case 'CUSTOMER': return deps.tables.customer
    case 'CARRIER': return deps.tables.carrier
    case 'QUOTE': return deps.tables.quote
    case 'POSTING': return deps.tables.posting
    case 'MESSAGE': return deps.tables.message
    case 'CHECK_CALL': return deps.tables.checkCall
    case 'DOCUMENT': return deps.tables.document
    case 'STAFF': return '' // Staff are Cognito users; only the DemoRecord lives here.
    default: return null
  }
}

// ── Demo state reader ────────────────────────────────────────────────────────

export async function getDemoState(deps: DemoDeps): Promise<Row> {
  const settings = await deps.getSettings().catch(() => null)
  const records = await allDemoRecords(deps)
  const shipments = await deps.scanTable(deps.tables.shipment)
  const orders = await deps.scanTable(deps.tables.order)
  const quotes = await deps.scanTable(deps.tables.quote)
  const postings = await deps.scanTable(deps.tables.posting)
  const messages = await deps.scanTable(deps.tables.message)
  const documents = await deps.scanTable(deps.tables.document)

  const staffRecords = records.filter((r) => r.kind === 'STAFF')
  const assignedCount = shipments.filter((s) => s.carrierRepId || s.carrierTeamKey).length
  const customers = await deps.scanTable(deps.tables.customer)
  const customersWithFlowDefaults = customers.filter(
    (c) =>
      c.defaultCarrierTeamKey ||
      typeof c.marginTargetBps === 'number' ||
      c.quoteAutoReply === true ||
      (Array.isArray(c.requiredLoadFields) && c.requiredLoadFields.length > 0) ||
      c.checkCallPlan,
  ).length

  const facts = {
    shipmentCount: shipments.length,
    staffCount: staffRecords.length,
    assignedCount,
    customersWithFlowDefaults,
    quotesWithMarketRate: quotes.filter((q) => typeof q.marketRateCents === 'number').length,
    buildingShipments: shipments.filter((s) => s.buildState === 'BUILDING').length,
    activePostings: postings.filter((p) => p.status === 'POSTED').length,
    carrierOffers: quotes.filter((q) => q.side === 'BUY').length,
    shipmentsWithThread: shipments.filter((s) => typeof s.threadKey === 'string').length,
    checkCallMessages: messages.filter((m) =>
      ['CHECK_CALL', 'CHECK_CALL_REPLY', 'ESCALATION'].includes(String(m.kind))
    ).length,
    podReviews: documents.filter((d) => d.type === 'POD' && (d.reviewStatus === 'ACCEPTED' || d.reviewStatus === 'REJECTED')).length,
    readyForBilling: orders.filter(
      (o) =>
        o.arStatus === 'DOCS_NEEDED' &&
        Array.isArray(o.docsMissing) &&
        o.docsMissing.length === 0,
    ).length,
    releasedToBilling: orders.filter((o) => o.arStatus === 'UNBILLED').length,
    seedVersion: settings?.demoSeedVersion ?? null,
  }

  return {
    seedVersion: settings?.demoSeedVersion ?? null,
    seededAt: settings?.demoSeededAt ?? null,
    devStack: deps.isDevStack,
    records,
    facts,
  }
}

async function stageTrackingStates(deps: DemoDeps, shipments: Row[], caller: Caller): Promise<void> {
  const now = deps.now()
  const writes: TransactWriteItem[] = []
  // Stage 5 in-transit rows (board status DEPARTED) plus 2 delivered rows for the
  // POD / billing fixtures. Order matters: delivered rows must land at the end so
  // the DELIVERED filter below picks them consistently.
  const transitions = ['IN_TRANSIT', 'IN_TRANSIT', 'IN_TRANSIT', 'IN_TRANSIT', 'IN_TRANSIT', 'DELIVERED', 'DELIVERED', 'DISPATCHED', 'LOADING']

  for (let i = 0; i < shipments.length; i++) {
    const seedShipment = shipments[i]
    const shipment = (await deps.getById(deps.tables.shipment, String(seedShipment.id))) ?? seedShipment
    const load = await loadOfShipment(deps, String(shipment.id))
    const order = await orderOfShipment(deps, String(shipment.id))
    if (!load) continue

    const transition = transitions[i % transitions.length]
    const stops = parseStops(load)
    const pickup = stops.find((s) => s.type === 'pickup')
    const delivery = stops.find((s) => s.type === 'delivery')
    // Stagger timestamps so the board has a clear newest-first ordering.
    const stopAt = new Date(now)
    stopAt.setMinutes(stopAt.getMinutes() - (shipments.length - i) * 10)

    if (transition === 'IN_TRANSIT' && pickup && delivery) {
      stopAt.setTime(Date.parse(now) - (5 + i * 2) * 60_000)
      const prevAt = new Date(stopAt.getTime() - 90 * 60_000)
      const [previous, current] = TRACKING_FIXES[i]
      pickup.appt = new Date(Date.parse(now) - 4 * 3_600_000).toISOString()
      pickup.arrivedAt = pickup.appt
      pickup.departedAt = new Date(Date.parse(now) - 3 * 3_600_000).toISOString()
      delivery.appt = new Date(Date.parse(now) + (3 + i) * 3_600_000).toISOString()
      writes.push(updateTx(deps.tables.shipment, String(shipment.id), stampedPatch(deps, caller, {
        status: 'IN_TRANSIT', pickupAppt: pickup.appt, deliveryAppt: delivery.appt,
      }), String(shipment.updatedAt ?? '')))
      writes.push(updateTx(deps.tables.load, String(load.id), stampedPatch(deps, caller, {
        status: 'IN_TRANSIT', pickupAppt: pickup.appt, deliveryAppt: delivery.appt,
        stops: JSON.stringify(stops),
        lastKnownAt: stopAt.toISOString(),
        lastKnownCity: current.city,
        lastKnownState: current.state,
        lastKnownLat: current.lat,
        lastKnownLng: current.lng,
        lastKnownPreviousAt: prevAt.toISOString(),
        lastKnownPreviousCity: previous.city,
        lastKnownPreviousState: previous.state,
        lastKnownPreviousLat: previous.lat,
        lastKnownPreviousLng: previous.lng,
        lastKnownSource: 'MANUAL',
      }), String(load.updatedAt ?? '')))
    } else if (transition === 'DELIVERED' && pickup && delivery) {
      stopAt.setTime(Date.parse(now) - 4 * 3_600_000)
      pickup.departedAt = stopAt.toISOString()
      delivery.arrivedAt = new Date(stopAt.getTime() + 60 * 60 * 1000).toISOString()
      delivery.departedAt = new Date(stopAt.getTime() + 2 * 60 * 60 * 1000).toISOString()
      writes.push(updateTx(deps.tables.shipment, String(shipment.id), stampedPatch(deps, caller, { status: 'DELIVERED', deliveredAt: delivery.departedAt }), String(shipment.updatedAt ?? '')))
      writes.push(updateTx(deps.tables.load, String(load.id), stampedPatch(deps, caller, { status: 'DELIVERED', stops: JSON.stringify(stops) }), String(load.updatedAt ?? '')))
      if (order) {
        writes.push(updateTx(deps.tables.order, String(order.id), stampedPatch(deps, caller, { readyToInvoiceAt: delivery.departedAt }), String(order.updatedAt ?? '')))
      }
    } else if (transition === 'DISPATCHED') {
      writes.push(updateTx(deps.tables.shipment, String(shipment.id), stampedPatch(deps, caller, { status: 'DISPATCHED' }), String(shipment.updatedAt ?? '')))
      writes.push(updateTx(deps.tables.load, String(load.id), stampedPatch(deps, caller, { status: 'DISPATCHED' }), String(load.updatedAt ?? '')))
    } else if (transition === 'LOADING' && pickup && delivery) {
      pickup.departedAt = stopAt.toISOString()
      delivery.arrivedAt = new Date(stopAt.getTime() + 60 * 60 * 1000).toISOString()
      writes.push(updateTx(deps.tables.shipment, String(shipment.id), stampedPatch(deps, caller, { status: 'DISPATCHED' }), String(shipment.updatedAt ?? '')))
      writes.push(updateTx(deps.tables.load, String(load.id), stampedPatch(deps, caller, { status: 'LOADING', stops: JSON.stringify(stops) }), String(load.updatedAt ?? '')))
    }
  }

  if (writes.length) await deps.transact(writes)
}

// Named fixes on the five seeded routes; city labels and map coordinates agree.
const TRACKING_FIXES = [
  [{ city: 'Hartford', state: 'CT', lat: 41.7658, lng: -72.6734 }, { city: 'New Haven', state: 'CT', lat: 41.3083, lng: -72.9279 }],
  [{ city: 'Lafayette', state: 'IN', lat: 40.4167, lng: -86.8753 }, { city: 'Lebanon', state: 'IN', lat: 40.0484, lng: -86.4692 }],
  [{ city: 'Huntsville', state: 'TX', lat: 30.7235, lng: -95.5508 }, { city: 'Conroe', state: 'TX', lat: 30.3119, lng: -95.4561 }],
  [{ city: 'Greenville', state: 'SC', lat: 34.8526, lng: -82.394 }, { city: 'Spartanburg', state: 'SC', lat: 34.9496, lng: -81.932 }],
  [{ city: 'Blythe', state: 'CA', lat: 33.6178, lng: -114.5883 }, { city: 'Buckeye', state: 'AZ', lat: 33.3703, lng: -112.5838 }],
] as const

function parseStops(load: Row): Row[] {
  const raw = load.stops ?? '[]'
  if (Array.isArray(raw)) return raw as Row[]
  try {
    return JSON.parse(String(raw)) as Row[]
  } catch {
    return []
  }
}

// ── Fixture builders ─────────────────────────────────────────────────────────

function makeOffer(
  deps: DemoDeps,
  caller: Caller,
  shipment: Row,
  load: Row | null,
  carrierName: string,
  carrierMc: string,
  carrierId?: string,
): Row {
  const now = deps.now()
  return {
    id: deps.randomId(),
    __typename: 'Quote',
    side: 'BUY',
    status: 'QUOTED',
    quoteDate: now.slice(0, 10),
    quoteMonth: now.slice(0, 7),
    carrierId: carrierId ?? null,
    carrierName,
    carrierMc,
    shipmentId: shipment.id,
    loadId: load?.id ?? null,
    mode: 'FTL',
    amountCents: 180000,
    rounds: 1,
    offerSource: 'EMAIL',
    offerContactName: 'Dispatcher',
    offerAvailableAt: now,
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
  }
}

function makeSellQuote(deps: DemoDeps, caller: Caller, customer: Row, opts: { status: string; amountCents: number }): Row {
  const now = deps.now()
  const marketCents = opts.amountCents
  return {
    id: deps.randomId(),
    __typename: 'Quote',
    side: 'SELL',
    status: opts.status,
    quoteDate: now.slice(0, 10),
    quoteMonth: now.slice(0, 7),
    customerId: customer.id,
    customerName: customer.name,
    mode: 'FTL',
    amountCents: opts.amountCents,
    marketRateCents: marketCents,
    marketSource: 'DAT_RATEVIEW',
    marketStub: true,
    marketAt: now,
    marketDetail: { low: marketCents - 5000, high: marketCents + 5000, average: marketCents },
    marginTargetBps: DEFAULT_MARGIN_TARGET_BPS,
    rounds: 1,
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
  }
}

function makeMessage(
  deps: DemoDeps,
  caller: Caller,
  shipment: Row,
  load: Row | null,
  opts: {
    channel: string
    kind: string
    direction: string
    subject?: string
    body: string
    party?: string
    authorKind?: string
    authorName?: string
    status?: string
  },
): Row {
  return {
    id: deps.randomId(),
    __typename: 'ShipmentMessage',
    shipmentId: shipment.id,
    threadKey: threadKey(String(shipment.id)),
    loadId: load?.id ?? null,
    direction: opts.direction,
    channel: opts.channel,
    kind: opts.kind,
    party: opts.party ?? 'DISPATCHER',
    subject: opts.subject ?? null,
    body: opts.body,
    status: opts.status ?? (opts.direction === 'OUT' ? 'NOT_SENT' : 'RECEIVED'),
    authorKind: opts.authorKind ?? (opts.direction === 'OUT' ? 'AGENT' : 'PERSON'),
    authorName: opts.authorName ?? null,
    at: deps.now(),
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: deps.now(),
    updatedAt: deps.now(),
  }
}

function makeCheckCall(
  deps: DemoDeps,
  caller: Caller,
  shipment: Row,
  load: Row | null,
  opts: { type: string; at: string; city?: string; state?: string; lat?: number | null; lng?: number | null },
): Row {
  return {
    id: deps.randomId(),
    __typename: 'LoadCheckCall',
    loadId: load?.id ?? null,
    shipmentId: shipment.id,
    at: opts.at,
    type: opts.type,
    source: 'SYSTEM',
    city: opts.city ?? null,
    state: opts.state ?? null,
    lat: opts.lat ?? null,
    lng: opts.lng ?? null,
    createdBy: caller.email,
  }
}

function makePodDocument(
  deps: DemoDeps,
  caller: Caller,
  shipment: Row,
  opts: { name: string; pages: number; reviewStatus: string; reviewNote: string; orderId?: string; loadId?: string },
): Row {
  const now = deps.now()
  return {
    id: deps.randomId(),
    __typename: 'ShipmentDocument',
    shipmentId: shipment.id,
    orderId: opts.orderId ?? null,
    loadId: opts.loadId ?? null,
    type: 'POD',
    name: opts.name,
    s3Key: `shipment-docs/${shipment.id}/${opts.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 1024,
    pages: opts.pages,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    reviewStatus: opts.reviewStatus,
    reviewedAt: now,
    reviewedBy: caller.email,
    reviewNote: opts.reviewNote,
    uploadedBy: caller.email,
    uploadedAt: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }
}

function makeBolDocument(deps: DemoDeps, caller: Caller, shipment: Row, opts?: { orderId?: string; loadId?: string }): Row {
  const now = deps.now()
  return {
    id: deps.randomId(),
    __typename: 'ShipmentDocument',
    shipmentId: shipment.id,
    orderId: opts?.orderId ?? null,
    loadId: opts?.loadId ?? null,
    type: 'BOL',
    name: 'BOL clean',
    s3Key: `shipment-docs/${shipment.id}/bol-clean.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 1024,
    pages: 2,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    reviewStatus: 'ACCEPTED',
    reviewedAt: now,
    reviewedBy: caller.email,
    reviewNote: 'clean',
    uploadedBy: caller.email,
    uploadedAt: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }
}

function trackingFixtureContacts(index: number) {
  const drivers = ['Michael Torres', 'Sarah Chen', 'James Wilson', 'Maria Garcia', 'Robert Lee']
  return {
    driverName: drivers[index], driverPhone: '+1224555010' + index,
    dispatcherName: 'Rachel Brooks', dispatcherPhone: '+12245550120',
    dispatcherEmail: 'dispatch@vetted.example',
  }
}

function makeDemoCarrierLeg(
  deps: DemoDeps,
  caller: Caller,
  shipment: Row,
  load: Row,
  carrier: Row,
): Row {
  const now = deps.now()
  return {
    id: `lcr-demo-${String(shipment.id).slice(-8)}`,
    __typename: 'LoadCarrier',
    loadId: load.id,
    shipmentId: shipment.id,
    kind: 'CARRIER',
    status: 'ACTIVE',
    sequence: 1,
    carrierId: carrier.id,
    carrierName: carrier.name,
    carrierMc: carrier.mcNumber ?? 'MC-DEMO',
    dispatcherName: 'Demo Dispatcher',
    dispatcherPhone: '+12245550137',
    dispatcherEmail: 'dispatch@vetted.example',
    driverName: 'Demo Driver',
    driverPhone: '+12245550137',
    truckNumber: 'DEMO123',
    rateConStatus: 'SIGNED',
    rateConSignedAt: now,
    chargesFinalizedAt: now,
    carrierRateCents: Math.round((Number(load.rate) || 0) * 0.75),
    costCents: Math.round((Number(load.rate) || 0) * 0.75),
    createdBy: caller.email,
    createdAt: now,
    updatedBy: caller.email,
    updatedAt: now,
    version: 1,
  }
}

// ── Small store helpers ──────────────────────────────────────────────────────

async function loadOfShipment(deps: DemoDeps, shipmentId: string): Promise<Row | null> {
  const loads = await deps.queryIndex(deps.tables.load, 'loadsByShipmentId', 'shipmentId', shipmentId)
  return loads[0] ?? null
}

async function orderOfShipment(deps: DemoDeps, shipmentId: string): Promise<Row | null> {
  const orders = await deps.queryIndex(deps.tables.order, 'ordersByShipmentId', 'shipmentId', shipmentId)
  return orders[0] ?? null
}

async function ordersOfShipments(deps: DemoDeps, shipmentIds: string[]): Promise<Row[]> {
  const out: Row[] = []
  for (const id of shipmentIds) {
    const order = await orderOfShipment(deps, id)
    if (order) out.push(order)
  }
  return out
}

function countByKind(records: Row[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of records) {
    const kind = String(r.kind ?? 'UNKNOWN')
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}
