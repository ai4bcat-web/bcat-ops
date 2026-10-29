/**
 * Everything `evaluateReleaseGate` needs about one order, read from DynamoDB.
 *
 * Two routers release money — `tmsShipmentActions` (READY_TO_INVOICE) and
 * `tmsFinanceActions` (preview, generate, batch, factor) — and both have to judge
 * the same facts the same way, from rows they read themselves rather than from
 * anything the client sent. This is that read, once, with the table names and the
 * client injected the way the rest of `_shared` takes them.
 *
 * Rows the caller already holds are passed in and are not read again: the
 * document router has the whole bundle in hand, and the finance router has its
 * `OrderContext`. Nothing here writes.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'

import {
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  getById,
  numberOrNull,
  queryIndex,
  queryShipmentDocuments,
  type Row,
} from './shipmentStore'
import { gateLoadIds, requiredDocTypesFor } from '../../../src/lib/shipmentDocuments'
import type {
  ReleaseGateDocument,
  ReleaseGateInput,
  ReleaseGateLeg,
  ReleaseGateOrderReference,
} from '../../../src/lib/releaseGate'
import type { CustomerRecord, RequiredReference, TmsSettings } from '../../../src/types/tms'

const SETTINGS_ID = 'default'
/** `LoadCheckCall` by load, for the fallback count. Amplify's derived index name. */
const IDX_CHECK_CALLS_BY_LOAD = 'loadCheckCallsByLoadIdAndAt'

export interface ReleaseGateTables {
  shipment: string
  order: string
  load: string
  loadCarrier: string
  shipmentDocument: string
  customer: string
  settings: string
  /**
   * Optional: only the shipment router holds this grant. Where it is missing the
   * open-exception count is the one cached on the Load, which the tracking router
   * keeps honest on every incident write.
   */
  loadCheckCall?: string
}

export interface ReleaseGateDeps {
  db: DynamoDBClient
  tables: ReleaseGateTables
}

/** The order to judge, plus whatever the caller has already read of its bundle. */
export interface ReleaseGateQuery {
  shipmentId: string
  orderId: string
  shipment?: Row | null
  order?: Row | null
  orders?: Row[] | null
  loads?: Row[] | null
  loadCarriers?: Row[] | null
  documents?: Row[] | null
  customer?: Row | null
  settings?: Row | null
}

function referenceList(value: unknown): RequiredReference[] {
  return Array.isArray(value) ? (value as RequiredReference[]) : []
}

/**
 * The references this customer will not pay without, as the order form and the
 * invoice readiness both read them: a code asking for none is not a requirement.
 */
function requiredReferences(
  customer: Row | null,
  settings: Row | null,
): { codes: string[]; labels: Record<string, string> } {
  const own = referenceList(customer?.requiredReferences)
  const configured = own.length > 0 ? own : referenceList(settings?.defaultRequiredReferences)
  const codes: string[] = []
  const labels: Record<string, string> = {}
  for (const entry of configured) {
    const code = typeof entry?.code === 'string' ? entry.code.trim() : ''
    if (!code) continue
    const need = typeof entry.countOnNewOrder === 'number' ? entry.countOnNewOrder : 0
    if (need <= 0) continue
    if (!codes.includes(code)) codes.push(code)
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (label) labels[code] = label
  }
  return { codes, labels }
}

/**
 * How many exceptions are still open on the loads this order bills for.
 *
 * `Load.openIncidentCount` is the cached count the tracking router rewrites on
 * every incident and resolution. A load that has never carried the field at all
 * (anything written before step D) is counted from the check calls themselves,
 * where the router holds that grant.
 */
async function openIncidents(deps: ReleaseGateDeps, loads: Row[]): Promise<number> {
  let total = 0
  for (const load of loads) {
    const cached = numberOrNull(load.openIncidentCount)
    if (cached != null) {
      total += Math.max(0, cached)
      continue
    }
    if (!deps.tables.loadCheckCall) continue
    const calls = await queryIndex(
      deps.db,
      deps.tables.loadCheckCall,
      IDX_CHECK_CALLS_BY_LOAD,
      'loadId',
      String(load.id),
    )
    total += calls.filter((call) => call.incidentOpen === 'OPEN').length
  }
  return total
}

export async function loadReleaseGateInput(
  deps: ReleaseGateDeps,
  query: ReleaseGateQuery,
): Promise<ReleaseGateInput> {
  const { shipmentId, orderId } = query

  const shipment = query.shipment ?? (await getById(deps.db, deps.tables.shipment, shipmentId))
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  const order = query.order ?? (await getById(deps.db, deps.tables.order, orderId))
  if (!order) throw new Error(`Order not found: ${orderId}`)

  const [orders, loads, loadCarriers, documents] = await Promise.all([
    query.orders ?? queryIndex(deps.db, deps.tables.order, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    query.loads ?? queryIndex(deps.db, deps.tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId),
    query.loadCarriers
      ?? queryIndex(deps.db, deps.tables.loadCarrier, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    query.documents ?? queryShipmentDocuments(deps.db, deps.tables.shipmentDocument, shipmentId),
  ])

  const customerId = String(order.customerId ?? '')
  const customer = query.customer !== undefined
    ? query.customer
    : customerId && deps.tables.customer
      ? await getById(deps.db, deps.tables.customer, customerId)
      : null
  const settings = query.settings !== undefined
    ? query.settings
    : deps.tables.settings
      ? await getById(deps.db, deps.tables.settings, SETTINGS_ID)
      : null

  // Which loads count towards this order is step E's rule, shared so the gate, the
  // Documents tab and the cached `docsMissing` can never reach different answers.
  const loadIds = gateLoadIds(
    loads as unknown as { id: string; orderId?: string | null }[],
    orders as unknown as { id: string }[],
    orderId,
  )
  const orderLoads = loads.filter((load) => loadIds.includes(String(load.id)))
  const legRows = loadCarriers.filter((leg) => loadIds.includes(String(leg.loadId ?? '')))
  const activeLegIds = legRows
    .filter((leg) => leg.status === 'ACTIVE')
    .map((leg) => String(leg.id))

  // Customer scope, as `presentDocTypes` defines it: the order's own paperwork,
  // its loads' paperwork, and what an ACTIVE assignment sent. A file on a bounced
  // assignment is paperwork about a trip that did not happen.
  const scoped: ReleaseGateDocument[] = []
  for (const doc of documents) {
    const legId = doc.loadCarrierId == null ? null : String(doc.loadCarrierId)
    if (legId != null && !activeLegIds.includes(legId)) continue
    const onOrder = doc.orderId != null && String(doc.orderId) === orderId
    const onLoad = doc.loadId != null && loadIds.includes(String(doc.loadId))
    if (!onOrder && !onLoad && legId == null) continue
    scoped.push({
      type: String(doc.type ?? ''),
      status: doc.status == null ? null : String(doc.status),
      voidedAt: doc.voidedAt == null ? null : String(doc.voidedAt),
      reviewStatus: doc.reviewStatus == null ? null : String(doc.reviewStatus),
      audience: doc.audience == null ? null : String(doc.audience),
    })
  }

  const legs: ReleaseGateLeg[] = legRows.map((leg) => ({
    kind: leg.kind === 'OWN_ASSET' ? 'OWN_ASSET' : 'CARRIER',
    status: leg.status == null ? null : String(leg.status),
    carrierName: leg.carrierName == null ? null : String(leg.carrierName),
    chargesFinalizedAt: leg.chargesFinalizedAt == null ? null : String(leg.chargesFinalizedAt),
    rateConStatus: leg.rateConStatus == null ? null : String(leg.rateConStatus),
  }))

  const references: ReleaseGateOrderReference[] = Array.isArray(order.references)
    ? (order.references as Row[]).map((ref) => ({
        code: String(ref?.code ?? ''),
        value: typeof ref?.value === 'string' ? ref.value : null,
      }))
    : []

  const { codes, labels } = requiredReferences(customer, settings)

  return {
    shipment: {
      status: shipment.status == null ? null : String(shipment.status),
      voidedAt: shipment.voidedAt == null ? null : String(shipment.voidedAt),
      deletedAt: shipment.deletedAt == null ? null : String(shipment.deletedAt),
    },
    order: {
      arStatus: order.arStatus == null ? null : String(order.arStatus),
      references,
      invoiceId: order.invoiceId == null ? null : String(order.invoiceId),
    },
    requiredDocTypes: requiredDocTypesFor(
      customer as Pick<CustomerRecord, 'requiredDocsForInvoice'> | null,
      settings as Pick<TmsSettings, 'defaultRequiredDocs'> | null,
    ).types,
    requiredReferenceCodes: codes,
    referenceLabels: labels,
    documents: scoped,
    legs,
    openIncidentCount: await openIncidents(deps, orderLoads),
  }
}
