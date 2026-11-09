/**
 * DELETE_SHIPMENTS / RESTORE_DELETED_SHIPMENTS — the owner-only hard delete and its way back.
 *
 * Void (voidShipment in handler.ts) is the normal exit, subject to cancelDeleteAdminOnly: the
 * shipment, its PRO and everything under it stay readable behind the Voided tab. Delete is Ryne's alone (the owner, by
 * email, from the verified token — never "any ADMIN") and exists for freight that should never have
 * been on the books. The rules, in the order they are applied:
 *
 *   1. Owner only, enforced here AND in `authorize` (defence in depth; the UI hiding the button is
 *      not a control).
 *   2. A typed confirmation: `confirm` must be DELETE. `force` additionally needs `forceConfirm` FORCE.
 *   3. Only loads WITHOUT billing. A shipment that carries an Invoice, a CarrierBill, a payment
 *      application, a Commission or a factoring row is REFUSED unless `force` is set; a settlement
 *      (BoxTruckTrip) is never forceable — take the load off the settlement first.
 *   4. EXPORT FIRST, fail closed: every row that will go is written to the DataSafety bucket as JSONL
 *      per table under `deletes/<stamp>/` plus a manifest (counts and sha256), read back and verified.
 *      If any of that fails nothing is deleted.
 *   5. Children before parents, Shipment last, so an interrupted delete leaves a shipment that can be
 *      deleted again. One AuditLog row per deleted shipment. Batch results are per shipment.
 *
 * ProClaim remains reserved; AuditLog, unrelated records and S3 bytes remain untouched.
 * Exclusive payment rows are removed only with force. Shared payments refuse even force,
 * since deleting another shipment's money cannot be undone by put-if-absent restoration.
 *
 * RESTORE puts the exported rows back, put-if-absent, from the manifest.
 */
import { createHash } from 'node:crypto'

import { assertArrayOf, assertString, optionalBoolean, type Caller } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'

export const DELETE_CONFIRM_WORD = 'DELETE'
export const FORCE_CONFIRM_WORD = 'FORCE'
/**
 * AppSync stops waiting at 30 s, before this Lambda's 120 s limit. A normal shipment needs
 * 10 parallel GSI Queries, up to 12 consistent BatchGets, and one final transaction plus a
 * conditional delete per child. Ten (rather than fifty) caps that discovery at 100 Queries /
 * 120 BatchGets before pagination, leaving headroom for export verification and deletes.
 * Unindexed billing scans and high child counts remain variable: recovery is mandatory,
 * not a claim that any batch size can guarantee an AppSync response deadline.
 */
export const MAX_DELETE_BATCH = 10
export const EXPORT_PREFIX_ROOT = 'deletes/'

/** Tables whose rows hang off a shipment through a `shipmentId` GSI. */
export const SHIPMENT_INDEXED_MODELS = [
  'Order', 'Load', 'LoadCarrier', 'LoadCharge', 'LoadCheckCall', 'TrackingLink',
  'ShipmentDocument', 'ShipmentNotice', 'ShipmentPosting', 'ShipmentMessage',
] as const
export type ShipmentIndexedModel = typeof SHIPMENT_INDEXED_MODELS[number]

/** Billing-class rows: their presence refuses the delete unless the owner forces it. */
export const BILLING_MODELS = ['Commission', 'FactoringItem', 'Invoice', 'CarrierBill'] as const
export type BillingModel = typeof BILLING_MODELS[number]

/** Every model this action deletes, children first, Shipment last (the order rows are removed in). */
export const DELETE_ORDER = [
  'ArPayment', 'ApPayment', 'LegacyAljexRow',
  ...BILLING_MODELS,
  'LaneRateSample', 'LoadFinancials', 'LoadCharge', 'LoadCheckCall', 'TrackingLink', 'ShipmentDocument',
  'ShipmentNotice', 'ShipmentPosting', 'ShipmentMessage', 'LoadCarrier', 'Load', 'Order', 'Shipment',
] as const
export type DeletedModel = typeof DELETE_ORDER[number]

/** Payment tables inspected for exclusive versus shared applications. */
export const REFERENCED_MODELS = ['ArPayment', 'ApPayment'] as const
export type ReferencedModel = typeof REFERENCED_MODELS[number]

export type StoreModel = DeletedModel | ReferencedModel | 'BoxTruckTrip'

/**
 * The cascade decision for every model keyed by shipmentId / orderId / loadId / loadCarrierId in
 * amplify/data/resource.ts. DELETE = removed (and exported); BILLING = removed only when forced
 * (and exported); REFERENCED = exported when it references a deleted billing row, never removed;
 * REFUSE = refuses the delete outright; LEAVE = untouched.
 */
export const CASCADE_POLICY: Record<string, 'DELETE' | 'BILLING' | 'REFERENCED' | 'REFUSE' | 'LEAVE'> = {
  Shipment: 'DELETE', Order: 'DELETE', Load: 'DELETE', LoadCarrier: 'DELETE', LoadFinancials: 'DELETE', LoadCharge: 'DELETE',
  LoadCheckCall: 'DELETE', TrackingLink: 'DELETE', ShipmentDocument: 'DELETE', ShipmentNotice: 'DELETE',
  ShipmentPosting: 'DELETE', ShipmentMessage: 'DELETE', LaneRateSample: 'DELETE',
  Invoice: 'BILLING', CarrierBill: 'BILLING', Commission: 'BILLING', FactoringItem: 'BILLING',
  ArPayment: 'BILLING', ApPayment: 'BILLING',
  BoxTruckTrip: 'REFUSE',
  ProClaim: 'LEAVE', LegacyAljexRow: 'DELETE', Quote: 'LEAVE', IntakeLoad: 'LEAVE', SpotRequest: 'LEAVE', WorkflowRun: 'LEAVE',
  AmazonTrip: 'LEAVE', DriverSubmission: 'LEAVE', DriverLoadTime: 'LEAVE', PodDocument: 'LEAVE', TruckLocationHistory: 'LEAVE',
  CarrierDocument: 'LEAVE',
  AuditLog: 'LEAVE',
}

export interface DeleteStore {
  isOwner: (caller: Caller) => boolean
  getRow: (model: 'Shipment', id: string) => Promise<Row | null>
  queryByShipment: (model: ShipmentIndexedModel, shipmentId: string) => Promise<Row[]>
  getRows: (model: StoreModel, ids: string[]) => Promise<Row[]>
  /** Project candidate ids/link fields; only tables without a usable relationship index scan. */
  scanProjected: (model: BillingModel | ReferencedModel | 'BoxTruckTrip' | 'LegacyAljexRow', fields: string[], matches?: Record<string, string[]>) => Promise<Row[]>
  /** Compare-and-delete against the exported snapshot; a changed/missing row refuses deletion. */
  deleteRows: (model: DeletedModel, ids: string[]) => Promise<void>
  finishDelete: (shipment: Row, caller: Caller, changes: Row) => Promise<void>
  putIfAbsent: (model: DeletedModel, row: Row) => Promise<'put' | 'exists'>
  putObject: (key: string, body: string) => Promise<void>
  getObject: (key: string) => Promise<string>
  writeAudit: (entityType: string, entityId: string, action: string, caller: Caller, changes: Row) => Promise<void>
  /** The caller's newest verified export marker, published before the first delete. */
  latestExportMarker: (userEmail: string) => Promise<Row | null>
  now: () => string
  randomId: () => string
}

// ── plan ─────────────────────────────────────────────────────────────────────

export interface BillingSummary {
  invoices: Array<{ id: string; number: string | null; status: string | null; totalCents: number | null; balanceCents: number | null }>
  carrierBills: Array<{ id: string; billNumber: string | null; status: string | null; netCents: number | null; paidCents: number | null }>
  commissions: Array<{ id: string; repName: string | null; status: string | null; netCents: number | null }>
  factoringItems: Array<{ id: string; proNumber: string | null; status: string | null }>
  /** Exclusive payment rows removed with force; shared payments block deletion. */
  payments: Array<{ id: string; model: ReferencedModel; kind: string | null; amountCents: number | null }>
  /** Order/leg fields that say money exists even if no row was found (invoiceId, arStatus UNPAID/PAID, leg invoiceId). */
  markers: string[]
}

export interface ShipmentPlan {
  shipmentId: string
  number: string | null
  rows: Partial<Record<DeletedModel, Row[]>>
  referenced: Partial<Record<ReferencedModel, Row[]>>
  billing: BillingSummary
  hasBilling: boolean
  /** Reasons no flag can override (a box-truck settlement). */
  blocks: string[]
}

export type DeleteOutcome = 'DELETED' | 'PREVIEW' | 'REFUSED_BILLING' | 'REFUSED_SETTLEMENT' | 'NOT_FOUND' | 'FAILED'

export interface DeleteResult {
  shipmentId: string
  number: string | null
  ok: boolean
  outcome: DeleteOutcome
  message?: string
  /** Rows per model that were (or, on a preview, would be) removed. */
  counts: Partial<Record<DeletedModel, number>>
  billing?: BillingSummary
}

export interface DeleteResponse {
  dryRun: boolean
  force: boolean
  exportPrefix: string | null
  results: DeleteResult[]
  deleted: number
  failed: number
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function ids(rows: Row[]): string[] {
  return rows.map((r) => String(r.id))
}

/** Every id an `applications` / `creditApplications` JSON (string or already parsed) names under `keys`. */
export function appliedIds(value: unknown, keys: string[]): string[] {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { throw new Error('Malformed payment applications; refusing deletion') }
  }
  if (parsed == null) return []
  if (!Array.isArray(parsed)) throw new Error('Malformed payment applications; refusing deletion')
  const out: string[] = []
  for (const entry of parsed) {
    if (entry == null || typeof entry !== 'object') continue
    for (const k of keys) {
      const v = (entry as Row)[k]
      if (typeof v === 'string') out.push(v)
    }
  }
  return out
}

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

function emptyBilling(): BillingSummary {
  return { invoices: [], carrierBills: [], commissions: [], factoringItems: [], payments: [], markers: [] }
}

/**
 * Read everything that hangs off the requested shipments, and sort the billing rows onto the shipment
 * that owns them. Read-only. The shipment-keyed child tables are read through their `shipmentId` GSI
 * (store.queryByShipment). The billing tables (Invoice, CarrierBill, Commission, FactoringItem,
 * LegacyAljexRow, ArPayment, ApPayment, BoxTruckTrip) have no shipmentId/orderId index in the data
 * model, so each is scanned ONCE for the whole request with a projection of the key fields (full rows
 * are fetched only for the matches).
 */
export async function planDeletes(store: DeleteStore, shipmentIds: string[]): Promise<ShipmentPlan[]> {
  const base = await inChunks(shipmentIds, 8, async (shipmentId) => {
    const shipment = await store.getRow('Shipment', shipmentId)
    if (!shipment) return { shipmentId, shipment: null as Row | null, rows: {} as Partial<Record<DeletedModel, Row[]>> }
    const rows: Partial<Record<DeletedModel, Row[]>> = { Shipment: [shipment] }
    const fetched = await Promise.all(SHIPMENT_INDEXED_MODELS.map((m) => store.queryByShipment(m, shipmentId)))
    SHIPMENT_INDEXED_MODELS.forEach((m, i) => { rows[m] = fetched[i] })
    const loadIds = [...new Set([...ids(rows.Load ?? []), ...(Array.isArray(shipment.loadIds) ? (shipment.loadIds as unknown[]).map(String) : [])])]
    rows.LoadFinancials = await store.getRows('LoadFinancials', loadIds)
    rows.LaneRateSample = await store.getRows('LaneRateSample', loadIds.map((id) => `lrs:${id}`))
    return { shipmentId, shipment, rows }
  })

  const live = base.filter((b) => b.shipment != null)
  const wanted = new Set(live.map((b) => b.shipmentId))
  const shipmentOf = new Map<string, string>() // orderId / loadId / loadCarrierId -> shipmentId
  for (const b of live) {
    for (const m of ['Order', 'Load', 'LoadCarrier'] as const) for (const r of b.rows[m] ?? []) shipmentOf.set(String(r.id), b.shipmentId)
  }
  const ownerOf = (row: Row, keys: string[]): string | null => {
    const direct = str(row.shipmentId)
    if (direct && wanted.has(direct)) return direct
    for (const k of keys) {
      const via = str(row[k])
      if (via && shipmentOf.has(via)) return shipmentOf.get(via) as string
    }
    return null
  }

  const matchedIds = async (model: BillingModel | 'BoxTruckTrip' | 'LegacyAljexRow', fields: string[], keys: string[]) => {
    const matches = Object.fromEntries(fields.map((field) => [field, field === 'shipmentId' ? [...wanted] : [...shipmentOf.keys()]]))
    const scanned = live.length === 0 ? [] : await store.scanProjected(model, fields, matches)
    const byShipment = new Map<string, string[]>()
    for (const r of scanned) {
      const owner = ownerOf(r, keys)
      if (owner) byShipment.set(owner, [...(byShipment.get(owner) ?? []), String(r.id)])
    }
    return byShipment
  }
  const [invoices, bills, commissions, factoring, trips, legacy] = await Promise.all([
    matchedIds('Invoice', ['shipmentId', 'orderId'], ['orderId']),
    matchedIds('CarrierBill', ['shipmentId', 'loadId', 'loadCarrierId'], ['loadCarrierId', 'loadId']),
    matchedIds('Commission', ['shipmentId', 'orderId'], ['orderId']),
    matchedIds('FactoringItem', ['shipmentId', 'loadId', 'orderId'], ['loadId', 'orderId']),
    matchedIds('BoxTruckTrip', ['loadId'], ['loadId']),
    matchedIds('LegacyAljexRow', ['shipmentId'], []),
  ])
  const full = async (model: BillingModel | 'LegacyAljexRow', byShipment: Map<string, string[]>) => {
    const all = [...byShipment.values()].flat()
    const rows = await store.getRows(model, all)
    const byId = new Map(rows.map((r) => [String(r.id), r]))
    return (shipmentId: string) => (byShipment.get(shipmentId) ?? []).map((id) => byId.get(id)).filter((r): r is Row => r != null)
  }
  const [invOf, billOf, comOf, facOf, legacyOf] = await Promise.all([
    full('Invoice', invoices), full('CarrierBill', bills), full('Commission', commissions), full('FactoringItem', factoring),
    full('LegacyAljexRow', legacy),
  ])

  // Payments are keyed by customer/carrier, so they are found through the invoices and bills they apply to.
  const invoiceOwner = new Map<string, string>()
  const billOwner = new Map<string, string>()
  for (const b of live) {
    for (const r of invOf(b.shipmentId)) invoiceOwner.set(String(r.id), b.shipmentId)
    for (const r of billOf(b.shipmentId)) billOwner.set(String(r.id), b.shipmentId)
  }
  const paymentsOf = new Map<string, { ArPayment: Set<string>; ApPayment: Set<string> }>()
  const slot = (shipmentId: string) => {
    const cur = paymentsOf.get(shipmentId) ?? { ArPayment: new Set<string>(), ApPayment: new Set<string>() }
    paymentsOf.set(shipmentId, cur)
    return cur
  }
  const linkedPayments = new Set<string>()
  if (invoiceOwner.size > 0) {
    for (const p of await store.scanProjected('ArPayment', ['invoiceId', 'applications', 'creditApplications'])) {
      for (const id of appliedIds(p.creditApplications, ['paymentId'])) linkedPayments.add(`ArPayment:${id}`)
      const named = [str(p.invoiceId), ...appliedIds(p.applications, ['invoiceId'])].filter((x): x is string => x != null)
      for (const invoiceId of named) {
        const owner = invoiceOwner.get(invoiceId)
        if (owner) slot(owner).ArPayment.add(String(p.id))
      }
    }
  }
  if (live.length > 0) {
    for (const p of await store.scanProjected('ApPayment', ['loadCarrierId', 'applications', 'creditApplications'])) {
      for (const id of appliedIds(p.creditApplications, ['paymentId'])) linkedPayments.add(`ApPayment:${id}`)
      const directOwner = str(p.loadCarrierId) ? shipmentOf.get(String(p.loadCarrierId)) : null
      if (directOwner) slot(directOwner).ApPayment.add(String(p.id))
      for (const billId of appliedIds(p.applications, ['billId'])) {
        const owner = billOwner.get(billId)
        if (owner) slot(owner).ApPayment.add(String(p.id))
      }
    }
  }
  const paymentRows = new Map<string, Row>()
  for (const model of REFERENCED_MODELS) {
    const want = [...paymentsOf.values()].flatMap((s) => [...s[model]])
    for (const r of await store.getRows(model, want)) paymentRows.set(`${model}:${r.id}`, r)
  }

  return base.map((b): ShipmentPlan => {
    if (!b.shipment) {
      return { shipmentId: b.shipmentId, number: null, rows: {}, referenced: {}, billing: emptyBilling(), hasBilling: false, blocks: [] }
    }
    const rows = b.rows
    rows.Invoice = invOf(b.shipmentId)
    rows.CarrierBill = billOf(b.shipmentId)
    rows.Commission = comOf(b.shipmentId)
    rows.FactoringItem = facOf(b.shipmentId)
    rows.LegacyAljexRow = legacyOf(b.shipmentId)
    const referenced: Partial<Record<ReferencedModel, Row[]>> = {}
    const pay = paymentsOf.get(b.shipmentId)
    for (const model of REFERENCED_MODELS) {
      referenced[model] = [...(pay?.[model] ?? [])].map((id) => paymentRows.get(`${model}:${id}`)).filter((r): r is Row => r != null)
    }
    const billing: BillingSummary = {
      invoices: (rows.Invoice ?? []).map((r) => ({ id: String(r.id), number: str(r.number), status: str(r.status), totalCents: num(r.totalCents), balanceCents: num(r.balanceCents) })),
      carrierBills: (rows.CarrierBill ?? []).map((r) => ({ id: String(r.id), billNumber: str(r.billNumber), status: str(r.status), netCents: num(r.netCents), paidCents: num(r.paidCents) })),
      commissions: (rows.Commission ?? []).map((r) => ({ id: String(r.id), repName: str(r.repName), status: str(r.status), netCents: num(r.netCents) })),
      factoringItems: (rows.FactoringItem ?? []).map((r) => ({ id: String(r.id), proNumber: str(r.proNumber), status: str(r.status) })),
      payments: REFERENCED_MODELS.flatMap((model) => (referenced[model] ?? []).map((r) => ({ id: String(r.id), model, kind: str(r.kind), amountCents: num(r.amountCents) }))),
      markers: [],
    }
    for (const o of rows.Order ?? []) {
      if (str(o.invoiceId) || str(o.invoiceNumber)) billing.markers.push(`Order ${String(o.id)} names invoice ${str(o.invoiceNumber) ?? str(o.invoiceId)}`)
      else if (o.arStatus === 'UNPAID' || o.arStatus === 'PAID') billing.markers.push(`Order ${String(o.id)} is ${String(o.arStatus)}`)
    }
    for (const c of rows.LoadCarrier ?? []) {
      if (str(c.invoiceId)) billing.markers.push(`Carrier leg ${String(c.id)} names carrier bill ${String(c.invoiceId)}`)
    }
    const hasBilling = billing.invoices.length + billing.carrierBills.length + billing.commissions.length
      + billing.factoringItems.length + billing.payments.length + billing.markers.length > 0
    const blocks = (trips.get(b.shipmentId) ?? []).length > 0
      ? [`It is on box-truck settlement ${(trips.get(b.shipmentId) ?? []).join(', ')}; take it off the settlement first`]
      : []
    for (const model of REFERENCED_MODELS) {
      const owner = model === 'ArPayment' ? invoiceOwner : billOwner
      for (const payment of referenced[model] ?? []) {
        const targets = appliedIds(payment.applications, [model === 'ArPayment' ? 'invoiceId' : 'billId'])
        if (model === 'ArPayment' && str(payment.invoiceId)) targets.push(String(payment.invoiceId))
        const shared = targets.some((id) => owner.get(id) !== b.shipmentId) || Number(payment.unappliedCents ?? 0) !== 0
          || appliedIds(payment.creditApplications, ['paymentId']).length > 0 || payment.reversesPaymentId != null || payment.reversedByPaymentId != null
          || linkedPayments.has(`${model}:${String(payment.id)}`)
        if (shared) blocks.push(`${model} ${String(payment.id)} is shared or has credit/reversal links. Force cannot remove unrelated money; use the offline awPreDelete-style split after review.`)
        else (rows[model] ??= []).push(payment)
      }
    }
    return { shipmentId: b.shipmentId, number: str(b.shipment.number), rows, referenced, billing, hasBilling, blocks }
  })
}

function countsOf(plan: ShipmentPlan): Partial<Record<DeletedModel, number>> {
  const out: Partial<Record<DeletedModel, number>> = {}
  for (const m of DELETE_ORDER) {
    const n = plan.rows[m]?.length ?? 0
    if (n > 0) out[m] = n
  }
  return out
}

export function billingMessage(plan: ShipmentPlan): string {
  const b = plan.billing
  const parts: string[] = []
  if (b.invoices.length) parts.push(`${b.invoices.length} invoice${b.invoices.length === 1 ? '' : 's'} (${b.invoices.map((i) => i.number ?? i.id).join(', ')})`)
  if (b.carrierBills.length) parts.push(`${b.carrierBills.length} carrier bill${b.carrierBills.length === 1 ? '' : 's'}`)
  if (b.payments.length) parts.push(`${b.payments.length} payment${b.payments.length === 1 ? '' : 's'} applied`)
  if (b.commissions.length) parts.push(`${b.commissions.length} commission row${b.commissions.length === 1 ? '' : 's'}`)
  if (b.factoringItems.length) parts.push(`${b.factoringItems.length} factoring row${b.factoringItems.length === 1 ? '' : 's'}`)
  if (parts.length === 0) parts.push(...b.markers)
  return `${plan.number ?? plan.shipmentId} has billing: ${parts.join('; ')}. Void it instead, or force the delete`
}

// ── export ───────────────────────────────────────────────────────────────────

/** JSON with DynamoDB sets preserved, so a restore puts back exactly what was read. */
export function toJsonLine(row: Row): string {
  return JSON.stringify(row, (_k, v) => (v instanceof Set ? { $set: [...v] } : v))
}
export function fromJsonLine(line: string): Row {
  return JSON.parse(line, (_k, v) => (v != null && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as Row).$set) && Object.keys(v as Row).length === 1
    ? new Set((v as { $set: unknown[] }).$set as string[])
    : v)) as Row
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface ExportManifest {
  version: 1
  kind: 'SHIPMENT_DELETE'
  createdAt: string
  actor: string
  forced: boolean
  shipments: Array<{ id: string; number: string | null }>
  /** `deleted: false` tables are copies of ledger rows that stay in the live table; a restore skips them. */
  tables: Record<string, { file: string; count: number; sha256: string; deleted: boolean }>
}

export function exportPrefixFor(now: string, random: string): string {
  const stamp = now.replace(/[:.]/g, '-')
  return `${EXPORT_PREFIX_ROOT}${stamp}-${random.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}/`
}

/** Writes the JSONL files then the manifest, reads every object back and checks its hash. Throws on any miss. */
export async function writeExport(
  store: DeleteStore,
  caller: Caller,
  plans: ShipmentPlan[],
  forced: boolean,
): Promise<{ prefix: string; manifest: ExportManifest }> {
  const prefix = exportPrefixFor(store.now(), store.randomId())
  const files = new Map<string, { body: string; count: number; deleted: boolean }>()
  const add = (model: string, rows: Row[], deleted: boolean) => {
    if (rows.length === 0) return
    const cur = files.get(model)
    const lines = rows.map(toJsonLine).join('\n') + '\n'
    files.set(model, { body: (cur?.body ?? '') + lines, count: (cur?.count ?? 0) + rows.length, deleted })
  }
  for (const m of DELETE_ORDER) add(m, plans.flatMap((p) => p.rows[m] ?? []), true)
  const manifest: ExportManifest = {
    version: 1,
    kind: 'SHIPMENT_DELETE',
    createdAt: store.now(),
    actor: caller.email,
    forced,
    shipments: plans.map((p) => ({ id: p.shipmentId, number: p.number })),
    tables: {},
  }
  for (const [model, f] of files) {
    manifest.tables[model] = { file: `${model}.jsonl`, count: f.count, sha256: sha256(f.body), deleted: f.deleted }
    await store.putObject(`${prefix}${model}.jsonl`, f.body)
  }
  const manifestBody = JSON.stringify(manifest, null, 2)
  await store.putObject(`${prefix}manifest.json`, manifestBody)
  // Verify: the manifest and every table file read back byte-identical.
  if (sha256(await store.getObject(`${prefix}manifest.json`)) !== sha256(manifestBody)) throw new Error('export verification failed: manifest differs')
  for (const model of files.keys()) {
    if (sha256(await store.getObject(`${prefix}${model}.jsonl`)) !== manifest.tables[model]!.sha256) {
      throw new Error(`export verification failed: ${model}.jsonl differs`)
    }
  }
  return { prefix, manifest }
}

// ── delete ───────────────────────────────────────────────────────────────────

export function assertOwner(store: DeleteStore, caller: Caller, action: string): void {
  if (!store.isOwner(caller)) throw new Error(`Forbidden: ${action} requires the owner`)
}

export async function deleteShipments(store: DeleteStore, input: Row, caller: Caller): Promise<DeleteResponse> {
  assertOwner(store, caller, 'DELETE_SHIPMENTS')
  const shipmentIds = [...new Set(assertArrayOf(input.shipmentIds, 'shipmentIds', (id) => assertString(id, 'shipmentId'), 100))]
  if (shipmentIds.length === 0) throw new Error('shipmentIds must have at least one entry')
  if (shipmentIds.length > MAX_DELETE_BATCH) throw new Error(`Delete at most ${MAX_DELETE_BATCH} shipments at a time`)
  const dryRun = optionalBoolean(input.dryRun) ?? false
  const force = optionalBoolean(input.force) ?? false
  if (!dryRun) {
    if (input.confirm !== DELETE_CONFIRM_WORD) throw new Error(`Type ${DELETE_CONFIRM_WORD} to confirm the delete`)
    if (force && input.forceConfirm !== FORCE_CONFIRM_WORD) throw new Error(`Type ${FORCE_CONFIRM_WORD} to confirm deleting billing rows`)
  }

  const plans = await planDeletes(store, shipmentIds)
  const results: DeleteResult[] = []
  const eligible: ShipmentPlan[] = []
  for (const plan of plans) {
    const counts = countsOf(plan)
    if (plan.number == null && Object.keys(counts).length === 0) {
      results.push({ shipmentId: plan.shipmentId, number: null, ok: false, outcome: 'NOT_FOUND', message: 'Shipment not found', counts })
    } else if (plan.blocks.length > 0) {
      results.push({ shipmentId: plan.shipmentId, number: plan.number, ok: false, outcome: 'REFUSED_SETTLEMENT', message: plan.blocks[0], counts, billing: plan.billing })
    } else if (plan.hasBilling && !force) {
      results.push({ shipmentId: plan.shipmentId, number: plan.number, ok: false, outcome: 'REFUSED_BILLING', message: billingMessage(plan), counts, billing: plan.billing })
    } else if (dryRun) {
      results.push({ shipmentId: plan.shipmentId, number: plan.number, ok: true, outcome: 'PREVIEW', counts, billing: plan.billing })
    } else {
      eligible.push(plan)
    }
  }

  let prefix: string | null = null
  if (!dryRun && eligible.length > 0) {
    let exported: { prefix: string; manifest: ExportManifest } | null = null
    try {
      const verified = await writeExport(store, caller, eligible, force)
      // Publish recovery before any destructive write. A failed marker also fails closed.
      await store.writeAudit(
        'DELETE_SHIPMENTS', `${verified.manifest.createdAt}#${verified.prefix}`,
        'DELETE_EXPORT_WRITTEN', caller, { exportPrefix: verified.prefix, shipmentIds },
      )
      exported = verified
    } catch (err) {
      // Fail closed: nothing was deleted, and nothing will be.
      const message = `Nothing deleted: the export could not be written (${err instanceof Error ? err.message : String(err)})`
      for (const plan of eligible) results.push({ shipmentId: plan.shipmentId, number: plan.number, ok: false, outcome: 'FAILED', message, counts: countsOf(plan) })
    }
    if (exported) {
      prefix = exported.prefix
      for (const plan of eligible) {
        const counts = countsOf(plan)
        try {
          for (const model of DELETE_ORDER) {
            if (model === 'Shipment') continue
            const rows = plan.rows[model] ?? []
            if (rows.length > 0) await store.deleteRows(model, ids(rows))
          }
          await store.finishDelete(plan.rows.Shipment![0], caller, {
            number: plan.number,
            forced: force,
            exportPrefix: prefix,
            counts,
            removedBilling: force ? plan.billing : null,
            leftInPlace: ['ProClaim', 'S3 objects', 'AuditLog'],
          })
          results.push({ shipmentId: plan.shipmentId, number: plan.number, ok: true, outcome: 'DELETED', counts, billing: plan.billing })
        } catch (err) {
          results.push({
            shipmentId: plan.shipmentId, number: plan.number, ok: false, outcome: 'FAILED', counts,
            message: `${err instanceof Error ? err.message : String(err)}. The rows are in ${prefix}; run the delete again to finish`,
          })
        }
      }
    }
  }

  const order = new Map(shipmentIds.map((id, i) => [id, i]))
  results.sort((a, b) => (order.get(a.shipmentId) ?? 0) - (order.get(b.shipmentId) ?? 0))
  const deleted = results.filter((r) => r.outcome === 'DELETED').length
  if (!dryRun) {
    await store.writeAudit('SHIPMENT', 'BATCH', 'DELETE_SHIPMENTS', caller, {
      requested: shipmentIds.length, deleted, failed: results.length - deleted, forced: force, exportPrefix: prefix,
    })
  }
  return { dryRun, force, exportPrefix: prefix, results, deleted, failed: dryRun ? 0 : results.length - deleted }
}

export async function latestDeleteExport(store: DeleteStore, caller: Caller): Promise<{ exportPrefix: string | null; createdAt: string | null }> {
  assertOwner(store, caller, 'LATEST_DELETE_EXPORT')
  const marker = await store.latestExportMarker(caller.email)
  if (!marker) return { exportPrefix: null, createdAt: null }
  const changes = typeof marker.changes === 'string' ? JSON.parse(marker.changes) as Row : marker.changes as Row
  return { exportPrefix: str(changes?.exportPrefix), createdAt: str(marker.createdAt) }
}

// ── restore ──────────────────────────────────────────────────────────────────

export interface RestoreResponse {
  dryRun: boolean
  exportPrefix: string
  shipments: Array<{ id: string; number: string | null }>
  tables: Record<string, { rows: number; restored: number; alreadyPresent: number; failed: number }>
}

const PREFIX_PATTERN = /^deletes\/[A-Za-z0-9._-]+\/$/

export async function restoreDeleted(store: DeleteStore, input: Row, caller: Caller): Promise<RestoreResponse> {
  assertOwner(store, caller, 'RESTORE_DELETED_SHIPMENTS')
  const raw = assertString(input.exportPrefix, 'exportPrefix')
  const exportPrefix = raw.endsWith('/') ? raw : `${raw}/`
  if (!PREFIX_PATTERN.test(exportPrefix)) throw new Error(`exportPrefix must look like ${EXPORT_PREFIX_ROOT}<stamp>/`)
  const dryRun = optionalBoolean(input.dryRun) ?? true
  const manifest = JSON.parse(await store.getObject(`${exportPrefix}manifest.json`)) as ExportManifest
  if (manifest.kind !== 'SHIPMENT_DELETE' || manifest.version !== 1) throw new Error('Not a shipment-delete export manifest')
  if (!manifest.tables || !Array.isArray(manifest.shipments) || manifest.shipments.some((s) => !s || typeof s.id !== 'string')) throw new Error('Invalid delete manifest')

  const tables: RestoreResponse['tables'] = {}
  const loaded: Array<{ model: DeletedModel; rows: Row[] }> = []
  // Read and verify everything before the first write: a corrupt export restores nothing.
  for (const [model, meta] of Object.entries(manifest.tables)) {
    if (!meta.deleted) continue
    if (!(DELETE_ORDER as readonly string[]).includes(model)) throw new Error(`Unknown model in manifest: ${model}`)
    if (meta.file !== `${model}.jsonl` || !Number.isSafeInteger(meta.count) || meta.count < 0) throw new Error('Invalid export table metadata')
    const body = await store.getObject(`${exportPrefix}${meta.file}`)
    if (sha256(body) !== meta.sha256) throw new Error(`${meta.file} does not match its manifest hash; refusing to restore`)
    const rows = body.split('\n').filter((l) => l.trim() !== '').map(fromJsonLine)
    if (rows.length !== meta.count) throw new Error(`${meta.file} has ${rows.length} rows, the manifest says ${meta.count}`)
    if (rows.some((row) => !row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id)) throw new Error(`Invalid row in ${meta.file}`)
    loaded.push({ model: model as DeletedModel, rows })
  }
  // Shipment first (it is what makes the rest reachable), then the reverse of the delete order.
  loaded.sort((a, b) => (a.model === 'Shipment' ? -1 : b.model === 'Shipment' ? 1 : DELETE_ORDER.indexOf(b.model) - DELETE_ORDER.indexOf(a.model)))
  for (const { model, rows } of loaded) {
    const t = { rows: rows.length, restored: 0, alreadyPresent: 0, failed: 0 }
    tables[model] = t
    for (const row of rows) {
      if (dryRun) continue
      try {
        if ((await store.putIfAbsent(model, row)) === 'put') t.restored += 1
        else t.alreadyPresent += 1
      } catch {
        t.failed += 1
      }
    }
  }
  if (!dryRun) {
    const failed = Object.values(tables).reduce((n, t) => n + t.failed, 0)
    for (const s of manifest.shipments) {
      await store.writeAudit('SHIPMENT', s.id, 'RESTORE_DELETED_SHIPMENT', caller, { number: s.number, exportPrefix, failedRows: failed })
    }
  }
  return { dryRun, exportPrefix, shipments: manifest.shipments, tables }
}
