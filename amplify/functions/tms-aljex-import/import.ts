/**
 * Aljex import dry-run / apply engine.
 *
 * Owns customer/location resolution, PRO idempotency checks, shipment creation,
 * AR invoice creation, and AP carrier-bill creation. All writes go through the
 * DynamoDB SDK; the caller supplies table names and clients so tests can inject
 * in-memory stores.
 */
import type { AttributeValue, DynamoDBClient, TransactWriteItem } from '@aws-sdk/client-dynamodb'
import type { S3Client } from '@aws-sdk/client-s3'
import type { AljexColumnMapping, AljexRow } from '@/lib/aljexImport'
import type { AljexImportCounts } from '../../../src/types/tms'

export type Row = Record<string, unknown>

export interface ImportStore {
  db: DynamoDBClient
  s3: S3Client
  bucketName: string
  now: () => string
  uuid: () => string
  tables: {
    aljexImportJob: string
    shipment: string
    order: string
    load: string
    loadFinancials: string
    loadCharge: string
    loadCarrier: string
    customer: string
    location: string
    division: string
    settings: string
    invoice: string
    carrierBill: string
    proClaim: string
    auditLog: string
  }
}

export interface ImportCaller {
  email: string
  sub: string
  groups: string[]
  isAdmin: boolean
}

export interface ImportInput {
  s3Key: string
  fileName: string
  fileHash: string
  mapping?: AljexColumnMapping | null
}

export interface RowResult {
  rowIndex: number
  ok: boolean
  message?: string
}

export interface ImportResult {
  jobId: string
  status: 'DRY_RUN' | 'APPLIED' | 'FAILED'
  counts: AljexImportCounts
  errorKey?: string
  note?: string
  rowResults: RowResult[]
}

export interface ImportDeps {
  store: ImportStore
  caller: ImportCaller
  marshallRow(item: Row): Record<string, AttributeValue>
  readS3Text(key: string): Promise<string>
  getById(tableName: string, id: string): Promise<Row | null>
  scanTable(tableName: string): Promise<Row[]>
  putItem(tableName: string, item: Row): Promise<void>
  transactItems(items: TransactWriteItem[], label: string): Promise<void>
  uploadErrorCsv(key: string, body: string): Promise<void>
  nextShipmentNumber(): Promise<string>
}

// ── Normalization ───────────────────────────────────────────────────────────

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(llc|inc|ltd|llp|corp|co|company|enterprises)\b/g, '')
    .trim()
}

interface AddressShape {
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
}

function normalizeAddress(value: AddressShape | string): string {
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
  }
  const parts = [value.street, value.city, value.state, value.zip, value.country]
  return parts
    .map((p) => (typeof p === 'string' ? p.toLowerCase().replace(/[^a-z0-9]/g, ' ') : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizePro(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const key = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return key.length >= 3 ? key : null
}

function proClaimKey(pro: string): string {
  const key = normalizePro(pro)
  if (!key) throw new Error(`“${pro.trim()}” is not a valid PRO number`)
  return key
}

// ── Customer / Location resolution ──────────────────────────────────────────

export function resolveCustomer(
  row: AljexRow,
  existing: Row[],
): { customerId?: string; created: boolean; normalizedName: string } {
  const normalizedName = normalizeName(row.customer ?? '')
  if (!normalizedName) return { created: false, normalizedName }

  if (row.customerMc) {
    const byMc = existing.find((c) => String(c.mcNumber ?? '').trim().toUpperCase() === row.customerMc!.trim().toUpperCase())
    if (byMc) return { customerId: String(byMc.id), created: false, normalizedName }
  }

  const byName = existing.find((c) => normalizeName(String(c.name ?? '')) === normalizedName)
  if (byName) return { customerId: String(byName.id), created: false, normalizedName }

  return { created: true, normalizedName }
}

export interface LocationMatch {
  locationId?: string
  created: boolean
  key: string
}

export function resolveLocation(
  name: string | undefined,
  city: string | undefined,
  state: string | undefined,
  zip: string | undefined,
  existing: Row[],
): LocationMatch {
  const n = (name ?? '').trim()
  const c = (city ?? '').trim()
  if (!n && !c) return { created: false, key: '' }
  const key = normalizeName(`${n} ${c}`)

  const byNameCity = existing.find((loc) => {
    const locName = normalizeName(String(loc.name ?? ''))
    const locCity = normalizeName(String(loc.city ?? ''))
    return locName === normalizeName(n) && locCity === normalizeName(c)
  })
  if (byNameCity) return { locationId: String(byNameCity.id), created: false, key }

  const addr: AddressShape = {
    street: n,
    city: c,
    state: state ?? null,
    zip: zip ?? null,
  }
  const normAddr = normalizeAddress(addr)
  if (normAddr) {
    const byAddr = existing.find((loc) => normalizeAddress(loc as AddressShape) === normAddr)
    if (byAddr) return { locationId: String(byAddr.id), created: false, key }
  }

  return { created: true, key }
}

// ── Money / date helpers ────────────────────────────────────────────────────

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toISOString().slice(0, 10)
}

/** Map a Shipment status onto the narrower Load status enum. */
function mapLoadStatus(shipmentStatus: string | undefined): string {
  switch (shipmentStatus) {
    case 'OPEN':
    case 'ON_HOLD':
      return 'SOURCING'
    case 'BOOKED':
      return 'BOOKED'
    case 'DISPATCHED':
      return 'DISPATCHED'
    case 'LOADING':
      return 'LOADING'
    case 'PICKED_UP':
      return 'PICKED_UP'
    case 'IN_TRANSIT':
      return 'IN_TRANSIT'
    case 'OUT_FOR_DELIVERY':
      return 'OUT_FOR_DELIVERY'
    case 'UNLOADING':
      return 'UNLOADING'
    case 'DELIVERED':
      return 'DELIVERED'
    case 'CANCELED':
      return 'CANCELED'
    default:
      return 'SOURCING'
  }
}

// ── Row processing ──────────────────────────────────────────────────────────

function buildStops(row: AljexRow, originId?: string, destinationId?: string): Row[] {
  const stops: Row[] = []
  const now = new Date().toISOString()
  if (row.originName || row.originCity) {
    stops.push({
      id: `stp-${Math.random().toString(36).slice(2)}`,
      type: 'pickup',
      sequence: 0,
      name: row.originName ?? null,
      city: row.originCity ?? null,
      state: row.originState ?? null,
      zip: row.originZip ?? null,
      locationId: originId ?? null,
      appt: row.pickupDate ? `${row.pickupDate}T00:00:00.000Z` : '',
      arrivedAt: null,
      departedAt: null,
      address: null,
      apptType: null,
      apptEnd: null,
      requestedStart: null,
      requestedEnd: null,
      refs: [],
      driverId: null,
      createdAt: now,
      updatedAt: now,
    })
  }
  if (row.destinationName || row.destinationCity) {
    stops.push({
      id: `stp-${Math.random().toString(36).slice(2)}`,
      type: 'delivery',
      sequence: 1,
      name: row.destinationName ?? null,
      city: row.destinationCity ?? null,
      state: row.destinationState ?? null,
      zip: row.destinationZip ?? null,
      locationId: destinationId ?? null,
      appt: row.deliveryDate ? `${row.deliveryDate}T00:00:00.000Z` : '',
      arrivedAt: null,
      departedAt: null,
      address: null,
      apptType: null,
      apptEnd: null,
      requestedStart: null,
      requestedEnd: null,
      refs: [],
      driverId: null,
      createdAt: now,
      updatedAt: now,
    })
  }
  return stops
}

function deriveLegacyFields(stops: Row[]): Row {
  if (stops.length === 0) return {}
  const ordered = [...stops].sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))
  const firstPickup = ordered.find((s) => s.type === 'pickup') ?? ordered[0]
  const lastDelivery = ordered.find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1]
  return {
    pickupAppt: firstPickup.appt ?? '',
    pickupApptEnd: firstPickup.apptEnd ?? null,
    pickupApptType: firstPickup.apptType ?? null,
    deliveryAppt: lastDelivery.appt ?? '',
    deliveryApptEnd: lastDelivery.apptEnd ?? null,
    deliveryApptType: lastDelivery.apptType ?? null,
    originName: firstPickup.name ?? null,
    originCity: firstPickup.city ?? null,
    destinationName: lastDelivery.name ?? null,
    destinationCity: lastDelivery.city ?? null,
    pickupDriverId: firstPickup.driverId ?? null,
    deliveryDriverId: lastDelivery.driverId ?? null,
  }
}

function monthOf(appt: string | null | undefined): string | null {
  if (!appt) return null
  const m = /^(\d{4}-\d{2})/.exec(appt)
  return m ? m[1] : null
}

function computeTotals(customerRateCents: number, carrierRateCents: number): Row {
  const revenueCents = customerRateCents
  const costCents = carrierRateCents
  const profitCents = revenueCents - costCents
  const marginBps = revenueCents > 0 ? Math.round((profitCents / revenueCents) * 10000) : 0
  return {
    customerRateCents,
    revenueCents,
    carrierRateCents,
    costCents,
    profitCents,
    marginBps,
    topSpendCents: null,
    targetBuyCents: null,
  }
}

// ── Apply logic ─────────────────────────────────────────────────────────────

interface ProcessRowState {
  customers: Row[]
  locations: Row[]
  claims: Set<string>
  counts: AljexImportCounts
  rowResults: RowResult[]
  errors: { rowIndex: number; message: string }[]
}

async function processRow(
  deps: ImportDeps,
  row: AljexRow,
  rowIndex: number,
  state: ProcessRowState,
  dryRun: boolean,
): Promise<void> {
  if (!row.pro) {
    state.counts.errored++
    const message = 'Missing PRO number'
    state.rowResults.push({ rowIndex, ok: false, message })
    state.errors.push({ rowIndex, message })
    return
  }

  let proKey: string
  try {
    proKey = proClaimKey(row.pro)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    state.counts.errored++
    state.rowResults.push({ rowIndex, ok: false, message })
    state.errors.push({ rowIndex, message })
    return
  }

  // Idempotency: if this run already claimed the PRO (duplicate row in same file), skip.
  if (state.claims.has(proKey)) {
    state.counts.skipped++
    state.rowResults.push({ rowIndex, ok: true, message: 'Duplicate PRO within file' })
    return
  }

  // Check ProClaim table for cross-origin conflict.
  const existingClaim = await deps.getById(deps.store.tables.proClaim, proKey)
  if (existingClaim) {
    const origin = String(existingClaim.origin ?? 'unknown')
    const existingLoadId = String(existingClaim.loadId ?? '')
    if (origin !== 'ALJEX_IMPORT') {
      state.counts.conflicts++
      const message = `PRO ${row.pro} already claimed by ${origin} (load ${existingLoadId})`
      state.rowResults.push({ rowIndex, ok: false, message })
      state.errors.push({ rowIndex, message })
      return
    }
    // Same origin re-run: treat as skipped/idempotent.
    state.counts.skipped++
    state.rowResults.push({ rowIndex, ok: true, message: 'PRO already imported from Aljex' })
    return
  }

  if (!row.customer || !row.customer.trim()) {
    state.counts.errored++
    const message = 'Missing customer'
    state.rowResults.push({ rowIndex, ok: false, message })
    state.errors.push({ rowIndex, message })
    return
  }

  const customerResolution = resolveCustomer(row, state.customers)
  const originResolution = resolveLocation(
    row.originName,
    row.originCity,
    row.originState,
    row.originZip,
    state.locations,
  )
  const destinationResolution = resolveLocation(
    row.destinationName,
    row.destinationCity,
    row.destinationState,
    row.destinationZip,
    state.locations,
  )

  if (dryRun) {
    state.claims.add(proKey)
    if (customerResolution.created) state.counts.customersCreated++
    if (originResolution.created) state.counts.locationsCreated++
    if (destinationResolution.created) state.counts.locationsCreated++
    state.counts.shipmentsCreated++
    if (row.invoiceNumber && row.invoiceAmountCents != null) state.counts.invoicesCreated++
    if (row.carrierBillNumber && row.carrierBillAmountCents != null) state.counts.billsCreated++
    state.rowResults.push({ rowIndex, ok: true })
    return
  }

  const now = deps.store.now()
  const callerEmail = deps.caller.email
  const shipmentId = `shp-${deps.store.uuid()}`
  const orderId = `ord-${deps.store.uuid()}`
  const loadId = `lod-${deps.store.uuid()}`

  let customerId: string | undefined
  if (customerResolution.created) {
    customerId = `cus-${deps.store.uuid()}`
    const customerRow: Row = {
      id: customerId,
      __typename: 'Customer',
      name: row.customer!.trim(),
      mcNumber: row.customerMc?.trim() ?? null,
      status: 'ACTIVE',
      active: true,
      createdBy: callerEmail,
      updatedBy: callerEmail,
      createdAt: now,
      updatedAt: now,
    }
    await deps.putItem(deps.store.tables.customer, customerRow)
    state.customers.push(customerRow)
    state.counts.customersCreated++
  } else {
    customerId = customerResolution.customerId
  }

  const originId = await ensureLocation(deps, originResolution, row.originName, row.originCity, row.originState, row.originZip, state, now)
  const destinationId = await ensureLocation(deps, destinationResolution, row.destinationName, row.destinationCity, row.destinationState, row.destinationZip, state, now)

  const stops = buildStops(row, originId, destinationId)
  const legacy = deriveLegacyFields(stops)
  const shipmentNumber = await deps.nextShipmentNumber()
  const pro = row.pro.trim()
  const customerName = row.customer!.trim()

  const customerRateCents = row.customerRateCents ?? 0
  const carrierRateCents = row.carrierRateCents ?? 0
  const totals = computeTotals(customerRateCents, carrierRateCents)

  const shipment: Row = {
    id: shipmentId,
    __typename: 'Shipment',
    number: shipmentNumber,
    status: 'DRAFT',
    previousStatus: null,
    statusChangedAt: now,
    statusChangedBy: callerEmail,
    customerId,
    customerName,
    mode: 'FTL',
    parentShipmentId: null,
    orderIds: [orderId],
    loadIds: [loadId],
    pickupAppt: legacy.pickupAppt,
    deliveryAppt: legacy.deliveryAppt,
    pickupMonth: monthOf(legacy.pickupAppt as string),
    originCity: legacy.originCity,
    destinationCity: legacy.destinationCity,
    source: 'BACKFILL',
    salesRepId: null,
    createdBy: callerEmail,
    updatedBy: callerEmail,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  const order: Row = {
    id: orderId,
    __typename: 'Order',
    shipmentId,
    customerId,
    customerName,
    customerContactId: null,
    customerRepId: null,
    billToId: null,
    costCenter: null,
    mode: 'FTL',
    rateType: 'SPOT',
    references: JSON.stringify([]),
    equipmentType: row.equipment ?? null,
    equipmentLengthFt: null,
    specialRequirements: null,
    freight: JSON.stringify([]),
    customerNotes: null,
    internalNotes: null,
    customerRateCents: totals.customerRateCents,
    revenueCents: totals.revenueCents,
    arStatus: 'LEGACY',
    arStatusChangedAt: now,
    invoiceId: null,
    invoiceEarly: false,
    readyToInvoiceAt: null,
    pickupAppt: legacy.pickupAppt,
    createdBy: callerEmail,
    updatedBy: callerEmail,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  const loadNumber = `${shipmentNumber}-1`
  const load: Row = {
    id: loadId,
    __typename: 'Load',
    aljexId: pro,
    tmsId: (row.po ?? '').trim() || pro,
    pickupNumber: (row.pickupNumber ?? '').trim() || pro,
    readyToInvoice: false,
    customer: customerName,
    ...(customerId ? { customerId } : {}),
    rate: totals.revenueCents,
    stops: JSON.stringify(stops),
    pickupAppt: (legacy.pickupAppt as string) ?? '',
    deliveryAppt: (legacy.deliveryAppt as string) ?? '',
    pickupApptEnd: legacy.pickupApptEnd ?? null,
    pickupApptType: legacy.pickupApptType ?? null,
    deliveryApptEnd: legacy.deliveryApptEnd ?? null,
    deliveryApptType: legacy.deliveryApptType ?? null,
    originName: legacy.originName ?? null,
    originCity: legacy.originCity ?? null,
    destinationName: legacy.destinationName ?? null,
    destinationCity: legacy.destinationCity ?? null,
    pickupDriverId: legacy.pickupDriverId ?? null,
    deliveryDriverId: legacy.deliveryDriverId ?? null,
    shipmentId,
    orderId,
    loadNumber,
    leg: 1,
    status: mapLoadStatus(row.status),
    statusChangedAt: now,
    statusChangedBy: callerEmail,
    statusSource: 'BACKFILL',
    assignmentType: 'NEED_TO_COVER',
    carrierRepId: null,
    equipmentType: row.equipment ?? null,
    divisionKey: null,
    trackingProvider: 'NONE',
    pickupMonth: monthOf(legacy.pickupAppt as string),
    commodity: row.commodity ?? null,
    weight: row.weight ?? null,
    pieces: row.pieces ?? null,
    miles: row.miles ?? null,
    createdBy: callerEmail,
    updatedBy: callerEmail,
    createdAt: now,
    updatedAt: now,
  }

  const financials: Row = {
    id: loadId,
    __typename: 'LoadFinancials',
    loadId,
    shipmentId,
    orderId,
    ...totals,
    frozenAt: null,
    frozenBy: null,
    updatedBy: callerEmail,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  const customerCharge: Row = {
    id: `chg-${deps.store.uuid()}`,
    __typename: 'LoadCharge',
    shipmentId,
    side: 'CUSTOMER',
    orderId,
    loadId,
    loadCarrierId: null,
    code: 'LINEHAUL',
    label: 'Linehaul',
    calculatedBy: 'FLAT',
    rateCents: customerRateCents,
    count: 1,
    amountCents: customerRateCents,
    isRate: true,
    release: null,
    sortOrder: 0,
    note: null,
    createdBy: callerEmail,
    createdAt: now,
    updatedAt: now,
  }

  const carrierCharge: Row = {
    id: `chg-${deps.store.uuid()}`,
    __typename: 'LoadCharge',
    shipmentId,
    side: 'CARRIER',
    orderId: null,
    loadId,
    loadCarrierId: null,
    code: 'LINEHAUL',
    label: 'Linehaul',
    calculatedBy: 'FLAT',
    rateCents: carrierRateCents,
    count: 1,
    amountCents: carrierRateCents,
    isRate: true,
    release: null,
    sortOrder: 1,
    note: null,
    createdBy: callerEmail,
    createdAt: now,
    updatedAt: now,
  }

  const claim: Row = {
    id: proKey,
    __typename: 'ProClaim',
    loadId,
    shipmentId,
    claimedAt: now,
    claimedBy: callerEmail,
    origin: 'ALJEX_IMPORT',
    createdAt: now,
    updatedAt: now,
  }

  const writes: TransactWriteItem[] = []
  // ProClaim conditional put
  writes.push({
    Put: {
      TableName: deps.store.tables.proClaim,
      Item: deps.marshallRow(claim),
      ConditionExpression: 'attribute_not_exists(id)',
    },
  })
  writes.push({ Put: { TableName: deps.store.tables.shipment, Item: deps.marshallRow(shipment) } })
  writes.push({ Put: { TableName: deps.store.tables.load, Item: deps.marshallRow(load) } })
  writes.push({ Put: { TableName: deps.store.tables.loadFinancials, Item: deps.marshallRow(financials) } })
  writes.push({ Put: { TableName: deps.store.tables.loadCharge, Item: deps.marshallRow(customerCharge) } })
  writes.push({ Put: { TableName: deps.store.tables.loadCharge, Item: deps.marshallRow(carrierCharge) } })

  // AR: create Invoice + InvoiceLine snapshotting the customer linehaul charge.
  if (row.invoiceNumber && row.invoiceAmountCents != null) {
    const invoiceDate = formatDate(row.invoiceDate) ?? now.slice(0, 10)
    const invoice: Row = {
      id: row.invoiceNumber.trim(),
      __typename: 'Invoice',
      number: row.invoiceNumber.trim(),
      orderId,
      shipmentId,
      shipmentNumber,
      customerId: customerId ?? null,
      customerName,
      billToId: null,
      billTo: JSON.stringify({ name: customerName, address: null, email: null }),
      divisionKey: null,
      status: row.invoicePaidDate ? 'PAID' : 'ISSUED',
      invoiceDate,
      issuedAt: now,
      issuedBy: callerEmail,
      dueAt: invoiceDate,
      termsDays: 0,
      termsText: 'Net 0',
      invoiceMonth: invoiceDate.slice(0, 7),
      lines: JSON.stringify([
        {
          description: row.commodity ?? 'Linehaul',
          quantity: 1,
          rateCents: row.invoiceAmountCents,
          amountCents: row.invoiceAmountCents,
        },
      ]),
      references: JSON.stringify([]),
      subtotalCents: row.invoiceAmountCents,
      totalCents: row.invoiceAmountCents,
      paidCents: row.invoicePaidDate ? row.invoiceAmountCents : 0,
      writtenOffCents: 0,
      balanceCents: row.invoicePaidDate ? 0 : row.invoiceAmountCents,
      arOpen: row.invoicePaidDate ? undefined : 'OPEN',
      remitTo: null,
      factored: false,
      attachDocumentIds: [],
      sentCount: 0,
      note: null,
      createdBy: callerEmail,
      updatedBy: callerEmail,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    writes.push({
      Put: {
        TableName: deps.store.tables.invoice,
        Item: deps.marshallRow(invoice),
        ConditionExpression: 'attribute_not_exists(id)',
      },
    })
    if (row.invoicePaidDate) {
      order.arStatus = 'PAID'
      order.paidAt = `${row.invoicePaidDate}T00:00:00.000Z`
    } else {
      order.arStatus = 'UNPAID'
      order.invoicedAt = now
      order.invoiceNumber = row.invoiceNumber.trim()
    }
    order.invoiceId = row.invoiceNumber.trim()
    state.counts.invoicesCreated++
  }

  // Order is pushed after AR so its paid/invoiced state is reflected.
  writes.push({ Put: { TableName: deps.store.tables.order, Item: deps.marshallRow(order) } })

  // AP: create CarrierBill for the imported carrier. Because there is no existing
  // LoadCarrier for a BACKFILL load, mint a minimal assignment row so the bill has
  // a valid loadCarrierId.
  if (row.carrierBillNumber && row.carrierBillAmountCents != null) {
    const loadCarrierId = `lca-${deps.store.uuid()}`
    const billDate = now.slice(0, 10)
    const carrierBill: Row = {
      id: `cb:${loadCarrierId}:1`,
      __typename: 'CarrierBill',
      loadCarrierId,
      loadId,
      shipmentId,
      shipmentNumber,
      loadNumber,
      carrierId: `imported-${(row.carrierMc ?? row.carrierName ?? 'unknown').trim() || 'unknown'}`,
      carrierName: row.carrierName ?? null,
      carrierMc: row.carrierMc ?? null,
      payeeKind: 'CARRIER',
      paymentMethodId: null,
      remitTo: null,
      divisionKey: null,
      status: 'IN_REVIEW',
      billNumber: row.carrierBillNumber.trim(),
      billDate,
      billMonth: billDate.slice(0, 7),
      recordedAt: now,
      recordedBy: callerEmail,
      recordedEarly: false,
      dueAt: billDate,
      termsDays: 0,
      quickPay: false,
      quickPayDays: null,
      quickPayFeeBps: null,
      lines: JSON.stringify([
        {
          description: row.commodity ?? 'Linehaul',
          quantity: 1,
          rateCents: row.carrierBillAmountCents,
          amountCents: row.carrierBillAmountCents,
        },
      ]),
      grossCents: row.carrierBillAmountCents,
      quickPayFeeCents: 0,
      netCents: row.carrierBillAmountCents,
      billedCents: row.carrierBillAmountCents,
      varianceCents: 0,
      paidCents: 0,
      creditedCents: 0,
      balanceCents: row.carrierBillAmountCents,
      apOpen: 'OPEN',
      documentId: null,
      approvedAt: null,
      approvedBy: null,
      approvalWarnings: [],
      note: null,
      createdBy: callerEmail,
      updatedBy: callerEmail,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    const loadCarrier: Row = {
      id: loadCarrierId,
      __typename: 'LoadCarrier',
      loadId,
      shipmentId,
      kind: 'CARRIER',
      status: 'ACTIVE',
      removalReason: null,
      removedAt: null,
      removedBy: null,
      sequence: 1,
      carrierId: undefined,
      carrierName: row.carrierName ?? null,
      carrierMc: row.carrierMc ?? null,
      carrierRepId: null,
      dispatcherName: null,
      dispatcherPhone: null,
      dispatcherEmail: null,
      driverId: null,
      driverName: null,
      driverPhone: null,
      driver2Name: null,
      driver2Phone: null,
      truckId: null,
      truckNumber: null,
      trailerId: null,
      trailerNumber: null,
      plates: null,
      vin: null,
      sealNumber: null,
      tripNumber: null,
      pickupEtaAt: null,
      deliveryEtaAt: null,
      priorDeliveryAt: null,
      priorDeliveryNote: null,
      rateConSignedAt: null,
      rateConKey: null,
      chargesFinalizedAt: null,
      carrierRateCents: row.carrierBillAmountCents,
      costCents: row.carrierBillAmountCents,
      apStatus: 'IN_REVIEW',
      invoiceId: carrierBill.id,
      apOpen: 'OPEN',
      apStatusChangedAt: now,
      apBalanceCents: row.carrierBillAmountCents,
      apPaidAt: null,
      removalNote: null,
      quickPay: false,
      quickPayDays: null,
      quickPayFeeBps: null,
      quickPayFeeCents: 0,
      paymentTermsDays: null,
      rateConStatus: 'NOT_SENT',
      rateConToken: null,
      rateConSentAt: null,
      rateConSentTo: null,
      rateConExpiresAt: null,
      rateConDocumentId: null,
      rateConSignerName: null,
      rateConSignerIp: null,
      rateConVersion: 1,
      bookedAt: now,
      bookingWarnings: [],
      dispatchedAt: null,
      dispatchNote: null,
      trackingLinkId: null,
      trackingStartedAt: null,
      trackingStoppedAt: null,
      uploadLinkId: null,
      podRequestedAt: null,
      docsMissing: [],
      ratingStars: null,
      ratingNote: null,
      ratedAt: null,
      ratedBy: null,
      createdBy: callerEmail,
      updatedBy: callerEmail,
      createdAt: now,
      updatedAt: now,
    }
    writes.push({ Put: { TableName: deps.store.tables.loadCarrier, Item: deps.marshallRow(loadCarrier) } })
    writes.push({ Put: { TableName: deps.store.tables.carrierBill, Item: deps.marshallRow(carrierBill) } })
    state.counts.billsCreated++
  }

  await deps.transactItems(writes, `aljex row ${rowIndex}`)
  state.claims.add(proKey)
  state.counts.shipmentsCreated++
  state.rowResults.push({ rowIndex, ok: true, message: row.note })
}

async function ensureLocation(
  deps: ImportDeps,
  resolution: LocationMatch,
  name: string | undefined,
  city: string | undefined,
  state: string | undefined,
  zip: string | undefined,
  state2: ProcessRowState,
  now: string,
): Promise<string | undefined> {
  if (!resolution.created) return resolution.locationId
  if (!name?.trim() && !city?.trim()) return undefined
  const locationId = `loc-${deps.store.uuid()}`
  const locationRow: Row = {
    id: locationId,
    __typename: 'Location',
    name: name?.trim() ?? null,
    city: city?.trim() ?? null,
    state: state?.trim() ?? null,
    zip: zip?.trim() ?? null,
    active: true,
    createdBy: deps.caller.email,
    updatedBy: deps.caller.email,
    createdAt: now,
    updatedAt: now,
  }
  await deps.putItem(deps.store.tables.location, locationRow)
  state2.locations.push(locationRow)
  state2.counts.locationsCreated++
  return locationId
}

// ── Entry points ────────────────────────────────────────────────────────────

export function emptyCounts(): AljexImportCounts {
  return {
    shipmentsCreated: 0,
    customersCreated: 0,
    locationsCreated: 0,
    invoicesCreated: 0,
    billsCreated: 0,
    skipped: 0,
    conflicts: 0,
    errored: 0,
  }
}

export async function previewImport(
  deps: ImportDeps,
  input: ImportInput,
  rows: AljexRow[],
): Promise<ImportResult> {
  const jobId = `aljex:${input.fileHash}`
  const state: ProcessRowState = {
    customers: await deps.scanTable(deps.store.tables.customer),
    locations: await deps.scanTable(deps.store.tables.location),
    claims: new Set(),
    counts: emptyCounts(),
    rowResults: [],
    errors: [],
  }

  for (let i = 0; i < rows.length; i++) {
    try {
      await processRow(deps, rows[i], i, state, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      state.counts.errored++
      state.rowResults.push({ rowIndex: i, ok: false, message })
      state.errors.push({ rowIndex: i, message })
    }
  }

  const errorKey = await writeErrorCsv(deps, jobId, state.errors)
  return {
    jobId,
    status: 'DRY_RUN',
    counts: state.counts,
    errorKey,
    rowResults: state.rowResults,
  }
}

export async function applyImport(
  deps: ImportDeps,
  input: ImportInput,
  rows: AljexRow[],
): Promise<ImportResult> {
  const jobId = `aljex:${input.fileHash}`
  const state: ProcessRowState = {
    customers: await deps.scanTable(deps.store.tables.customer),
    locations: await deps.scanTable(deps.store.tables.location),
    claims: new Set(),
    counts: emptyCounts(),
    rowResults: [],
    errors: [],
  }

  for (let i = 0; i < rows.length; i++) {
    try {
      await processRow(deps, rows[i], i, state, false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      state.counts.errored++
      state.rowResults.push({ rowIndex: i, ok: false, message })
      state.errors.push({ rowIndex: i, message })
    }
  }

  const errorKey = await writeErrorCsv(deps, jobId, state.errors)
  return {
    jobId,
    status: 'APPLIED',
    counts: state.counts,
    errorKey,
    rowResults: state.rowResults,
  }
}

async function writeErrorCsv(deps: ImportDeps, jobId: string, errors: { rowIndex: number; message: string }[]): Promise<string | undefined> {
  if (errors.length === 0) return undefined
  const lines = ['rowIndex,message', ...errors.map((e) => `${e.rowIndex},"${String(e.message).replace(/"/g, '""')}"`)]
  const body = lines.join('\n')
  const key = `imports/errors/${jobId}.csv`
  await deps.uploadErrorCsv(key, body)
  return key
}
