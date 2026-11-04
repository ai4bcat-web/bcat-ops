/**
 * Independent API reads for devVerifyPerf: the expected row counts a page must show (so "ready" is never an empty-state false
 * positive) and the full-scan reference model G1 compares the windowed loaders against. Raw GraphQL against the DEV API only
 * (scripts/lib/devIdentity.gql), read-only, no app code: the numbers cannot share a bug with the code under test.
 *
 * Rules mirrored from src/lib/shipmentLists.ts (isReleasedToInvoicing / inShipmentList) and PERF-plan.md §4.3.
 */
import { gql } from './devIdentity.mjs'

export const OPEN_STATUSES = ['DRAFT', 'TENDER_PENDING', 'TENDER_REJECTED', 'OPEN', 'ON_HOLD', 'BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One list/index query paged to exhaustion. `name` = root field; `argsDecl`/`args` build the variable list. */
export async function pageAll(token, name, { decls = '', args = '', variables = {}, fields, limit = 1000 }) {
  const rows = []
  let nextToken = null
  let trips = 0
  do {
    const query = `query($nextToken: String${decls ? `, ${decls}` : ''}) { ${name}(${args ? `${args}, ` : ''}limit: ${limit}, nextToken: $nextToken) { items { ${fields} } nextToken } }`
    let data
    for (let attempt = 0; ; attempt += 1) {
      try { data = await gql(token, query, { ...variables, nextToken }); break } catch (e) {
        if (attempt >= 3) throw e
        await sleep(500 * (attempt + 1))
      }
    }
    trips += 1
    rows.push(...(data[name].items ?? []))
    nextToken = data[name].nextToken ?? null
  } while (nextToken)
  return { rows, trips }
}

/** N getShipment lookups in aliased requests of 50 ids. */
export async function getShipments(token, ids, fields) {
  const out = new Map()
  const list = [...new Set(ids)]
  for (let i = 0; i < list.length; i += 50 * 4) {
    const groups = []
    for (let j = i; j < Math.min(list.length, i + 200); j += 50) groups.push(list.slice(j, j + 50))
    await Promise.all(groups.map(async (group) => {
      const query = `query { ${group.map((id, n) => `a${n}: getShipment(id: ${JSON.stringify(id)}) { ${fields} }`).join(' ')} }`
      const data = await gql(token, query, {})
      for (let n = 0; n < group.length; n += 1) if (data[`a${n}`]) out.set(group[n], data[`a${n}`])
    }))
  }
  return out
}

export const isReleased = (order) => order.readyToInvoiceAt != null || order.invoiceId != null || (order.arStatus != null && order.arStatus !== 'DOCS_NEEDED')

/** Non-voided, non-deleted shipments of one open status (server-side void filter as the plan's loader does). */
async function openByStatus(token, status) {
  const { rows } = await pageAll(token, 'listShipmentByStatusAndPickupAppt', {
    decls: '$status: ShipmentStatus!, $filter: ModelShipmentFilterInput', args: 'status: $status, filter: $filter',
    variables: { status, filter: { voidedAt: { attributeExists: false } } }, fields: 'id status voidedAt deletedAt',
  })
  return rows.filter((r) => !r.voidedAt && !r.deletedAt)
}

/** The open (non-terminal, non-voided) shipments: a lower bound for the Active list and the shell's working set. */
export async function openShipments(token) {
  const sets = await Promise.all(OPEN_STATUSES.map((s) => openByStatus(token, s)))
  return sets.flat()
}

/** Full-table reference read (raw, one time): every shipment and order, the narrow fields the Active rule and the month rule need. */
export async function fullScan(token) {
  const [{ rows: shipments }, { rows: orders }] = await Promise.all([
    pageAll(token, 'listShipments', { fields: 'id status pickupMonth voidedAt deletedAt' }),
    pageAll(token, 'listOrders', { fields: 'id shipmentId arStatus readyToInvoiceAt invoiceId' }),
  ])
  return { shipments, orders }
}

/** Ids of every shipment the Active list shows today (unreleased, not canceled, not voided/deleted), from a fullScan(). */
export function activeIdsOf({ shipments, orders }) {
  const orderOf = new Map(orders.map((o) => [o.shipmentId, o]))
  return new Set(shipments
    .filter((s) => !s.voidedAt && !s.deletedAt && s.status !== 'CANCELED' && !(orderOf.has(s.id) && isReleased(orderOf.get(s.id))))
    .map((s) => s.id))
}

/** Ids of the non-voided, non-deleted shipments whose pickupMonth is `month`, from a fullScan(). */
export function monthIdsOf({ shipments }, month) {
  return new Set(shipments.filter((s) => s.pickupMonth === month && !s.voidedAt && !s.deletedAt).map((s) => s.id))
}

/** Tracking rows: ACTIVE legs with a sent/opened/signed rate con whose shipment is not delivered, canceled or voided. */
export async function trackingRows(token) {
  const { rows } = await pageAll(token, 'listLoadCarriers', {
    decls: '$filter: ModelLoadCarrierFilterInput', args: 'filter: $filter',
    variables: { filter: { and: [{ status: { eq: 'ACTIVE' } }, { or: [{ rateConStatus: { eq: 'SENT' } }, { rateConStatus: { eq: 'OPENED' } }, { rateConStatus: { eq: 'SIGNED' } }] }] } },
    fields: 'id shipmentId',
  })
  const shipments = await getShipments(token, rows.map((r) => r.shipmentId).filter(Boolean), 'id status voidedAt deletedAt')
  const live = [...shipments.values()].filter((s) => !s.voidedAt && !s.deletedAt && s.status !== 'DELIVERED' && s.status !== 'CANCELED')
  return live.map((s) => s.id)
}

const chicagoMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)

/**
 * What each budgeted page should show, from independent reads. Numbers are counts of ROWS the page must be able to render
 * (callers cap them at the page size).
 */
export async function expectedCounts(token) {
  const month = chicagoMonth()
  const [open, customers, carriers, unbilled, openBills, tracking, monthRows] = await Promise.all([
    openShipments(token),
    pageAll(token, 'listCustomers', { fields: 'id' }),
    pageAll(token, 'listCarriers', { fields: 'id' }),
    pageAll(token, 'listOrderByArStatusAndArStatusChangedAt', { decls: '$arStatus: OrderArStatus!', args: 'arStatus: $arStatus', variables: { arStatus: 'UNBILLED' }, fields: 'id' }),
    pageAll(token, 'listCarrierBillByApOpenAndDueAt', { decls: '$apOpen: String!', args: 'apOpen: $apOpen', variables: { apOpen: 'OPEN' }, fields: 'id' }),
    trackingRows(token),
    pageAll(token, 'listShipmentByPickupMonthAndPickupAppt', {
      decls: '$pickupMonth: String!, $filter: ModelShipmentFilterInput', args: 'pickupMonth: $pickupMonth, filter: $filter',
      variables: { pickupMonth: month, filter: { voidedAt: { attributeExists: false } } }, fields: 'id deletedAt',
    }),
  ])
  return {
    month,
    activeLowerBound: open.length,
    customers: customers.rows.length,
    carriers: carriers.rows.length,
    unbilledOrders: unbilled.rows.length,
    openBills: openBills.rows.length,
    trackingRows: tracking.length,
    monthShipments: monthRows.rows.filter((r) => !r.deletedAt).length,
  }
}
