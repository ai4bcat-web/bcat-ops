/**
 * Lane identity: the string every rate sample, quote and history panel keys on.
 *
 * A lane is the FIRST pickup and the LAST delivery of a load — what is in between is
 * the route, not the lane. The key is `'CHICAGO|IL>DANVILLE|IL'`: upper-cased, stripped
 * of punctuation, whitespace collapsed, so "St. Louis, MO" and "ST LOUIS MO" are the
 * same lane rather than two. A key with no state is refused outright — "SPRINGFIELD" is
 * nine cities and averaging their rates together is worse than having no history at all.
 *
 * `laneKey3For` is the fallback key, the ZIP3 pair (`'606>618'`): wide enough that a
 * first-time lane still has neighbours to look at, narrow enough to mean something.
 *
 * `laneSampleFor` turns one delivered, priced load into the row the Historical Rates
 * panel reads. Money comes off the `LoadFinancials` row and nowhere else — never the
 * legacy `Load.rate`, which is dollars-ish, stale, and not what we invoiced.
 *
 * Pure: no store, no clock (callers pass `nowIso`), no network. Imports are relative
 * because the tmsShipmentActions Lambda bundles this file by path, so a `@/` alias
 * would break the function build.
 */
import type { Stop } from '../types'
import type {
  CustomerRecord,
  LaneRateSampleRecord,
  LoadCarrierRecord,
  LoadFinancialsRecord,
  LoadWorkflowStatus,
  OrderRecord,
  ShipmentLoad,
  ShipmentRecord,
} from '../types/tms'
import { splitCityState } from './locationAutoSave'
import { MOVEMENT_RANK } from './shipmentStatus'

/** Upper case, punctuation to spaces, whitespace collapsed. `'St. Louis'` → `'ST LOUIS'`. */
function normalizeText(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

/** A two-letter state, or null — a spelled-out state is not a key, it is a guess. */
function stateCode(value: string | null | undefined): string | null {
  const text = normalizeText(value)
  return /^[A-Z]{2}$/.test(text) ? text : null
}

/**
 * Where a stop is, as the lane key spells it. The booked address snapshot wins; the
 * `city` display string ("Chicago, IL") is parsed only for what the snapshot lacks.
 */
function placeOf(stop: Stop): { city: string; state: string } | null {
  const parsed = splitCityState(stop.city)
  const city = normalizeText(stop.address?.city) || normalizeText(parsed.city)
  const state = stateCode(stop.address?.state) ?? stateCode(parsed.state)
  if (!city || !state) return null
  return { city, state }
}

function stopKind(stop: Stop): string {
  return String(stop.type ?? '').trim().toLowerCase()
}

/** The two ends of the route: first pickup, last delivery, in `sequence` order. */
function endpointsOf(stops: Stop[] | null | undefined): { pickup: Stop; delivery: Stop } | null {
  const list = (stops ?? []).filter((s): s is Stop => s != null)
  if (list.length < 2) return null
  const ordered = list
    .map((stop, index) => ({ stop, order: typeof stop.sequence === 'number' ? stop.sequence : index, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((e) => e.stop)

  const pickup = ordered.find((s) => stopKind(s) === 'pickup') ?? ordered[0]
  let delivery = ordered[ordered.length - 1]
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (stopKind(ordered[i]) === 'delivery') { delivery = ordered[i]; break }
  }
  if (pickup === delivery) return null
  return { pickup, delivery }
}

/**
 * `'CHICAGO|IL>DANVILLE|IL'`, or null when either end has no city and two-letter state.
 * Intermediate stops are ignored: a Chicago → Joliet → Danville run is a Chicago lane.
 */
export function laneKeyFor(stops: Stop[] | null | undefined): string | null {
  const ends = endpointsOf(stops)
  if (!ends) return null
  const from = placeOf(ends.pickup)
  const to = placeOf(ends.delivery)
  if (!from || !to) return null
  return `${from.city}|${from.state}>${to.city}|${to.state}`
}

/** The first three digits of a five-digit ZIP; ZIP+4 is accepted, anything else is not. */
function zip3Of(stop: Stop): string | null {
  const raw = (stop.address?.zip ?? '').trim()
  const match = raw.match(/^(\d{5})(?:-?\d{4})?$/)
  return match ? match[1].slice(0, 3) : null
}

/** `'606>618'` from the two ends' ZIPs; null when either ZIP is missing or malformed. */
export function laneKey3For(stops: Stop[] | null | undefined): string | null {
  const ends = endpointsOf(stops)
  if (!ends) return null
  const from = zip3Of(ends.pickup)
  const to = zip3Of(ends.delivery)
  if (!from || !to) return null
  return `${from}>${to}`
}

/** `'CHICAGO|IL>DANVILLE|IL'` → `'Chicago, IL → Danville, IL'`. `''` for nothing. */
export function laneLabelFor(laneKey: string | null | undefined): string {
  if (!laneKey) return ''
  const sides = laneKey.split('>')
  if (sides.length !== 2) return ''
  const ends = sides.map((side) => {
    const [city, state] = side.split('|')
    if (!city || !state) return ''
    const pretty = city
      .split(' ')
      .filter(Boolean)
      .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ')
    return `${pretty}, ${state.toUpperCase()}`
  })
  if (!ends[0] || !ends[1]) return ''
  return `${ends[0]} → ${ends[1]}`
}

/**
 * The rows a sample is built from. Loosely typed on purpose: the Lambda hands over
 * unmarshalled DynamoDB items, so every field is treated as possibly absent. Absent
 * money stays absent — nothing here invents a number.
 */
export interface LaneSampleInput {
  load: Partial<ShipmentLoad> & { id: string }
  financials?: Partial<LoadFinancialsRecord> | null
  order?: Partial<OrderRecord> | null
  /** The ACTIVE assignment, if there is one. */
  loadCarrier?: Partial<LoadCarrierRecord> | null
  shipment?: Partial<ShipmentRecord> | null
  /** The billed account, for the team the revenue belongs to. */
  customer?: Partial<CustomerRecord> | null
}

function cents(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed || null
}

/** `'2026-02-14T15:00:00.000Z'` → `'2026-02-14'`; anything unparseable → null. */
function dayOf(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null
}

/**
 * One delivered, priced load as a lane rate sample — or null when it is not one yet.
 *
 * Null when: there is no financials row (nothing to learn from an unpriced load), the
 * lane key cannot be built, or the load has not reached DELIVERED. A load that was
 * canceled or TONU'd after the fact still produces a row, marked `excluded`: the
 * history keeps what happened and refuses to count it.
 */
export function laneSampleFor(
  input: LaneSampleInput,
  nowIso: string,
): Omit<LaneRateSampleRecord, 'version'> | null {
  const { load, financials, order, loadCarrier, shipment, customer } = input
  if (!financials) return null

  const stops = load.stops ?? null
  const laneKey = laneKeyFor(stops)
  if (!laneKey) return null

  const rawStatus = (load.status ?? '').trim()
  const status = rawStatus && rawStatus in MOVEMENT_RANK ? (rawStatus as LoadWorkflowStatus) : null
  const rank = status ? MOVEMENT_RANK[status] : (load.deliveredAt ? MOVEMENT_RANK.DELIVERED : -1)
  if (rank < MOVEMENT_RANK.DELIVERED) return null

  const ends = endpointsOf(stops)
  const date = dayOf(ends?.delivery.appt) ?? dayOf(load.deliveredAt) ?? dayOf(nowIso) ?? nowIso.slice(0, 10)
  const miles = typeof load.miles === 'number' && Number.isFinite(load.miles) ? Math.round(load.miles) : null
  const kind = loadCarrier?.kind
  const invoicedOn = dayOf(order?.invoicedAt)

  return {
    id: `lrs:${load.id}`,
    laneKey,
    laneKey3: laneKey3For(stops),
    date,
    loadId: load.id,
    shipmentId: text(load.shipmentId) ?? text(shipment?.id) ?? '',
    shipmentNumber: text(shipment?.number),
    orderId: text(load.orderId) ?? text(order?.id),
    customerId: text(order?.customerId) ?? text(shipment?.customerId),
    customerName: text(order?.customerName) ?? text(shipment?.customerName) ?? text(load.customer),
    carrierId: text(loadCarrier?.carrierId),
    carrierName: text(loadCarrier?.carrierName) ?? text(load.carrierName),
    assignmentKind: kind === 'OWN_ASSET' || kind === 'CARRIER' ? kind : null,
    divisionKey: text(load.divisionKey),
    mode: shipment?.mode ?? order?.mode ?? null,
    rateType: order?.rateType ?? null,
    equipmentType: text(load.equipmentType) ?? text(order?.equipmentType),
    miles: miles != null && miles > 0 ? miles : null,
    customerRateCents: cents(financials.customerRateCents),
    revenueCents: cents(financials.revenueCents),
    carrierRateCents: cents(financials.carrierRateCents),
    costCents: cents(financials.costCents),
    profitCents: cents(financials.profitCents),
    marginBps: cents(financials.marginBps),
    loadStatus: status,
    excluded: shipment?.status === 'CANCELED' || loadCarrier?.status === 'TONU',
    source: 'LOAD',
    sampledAt: nowIso,
    // Step I — the reporting fact table's keys. `sampleMonth` is a GSI hash key, so it
    // is always written; everything else is dropped by `compact()` when it is null.
    sampleMonth: date.slice(0, 7),
    customerRepId: text(order?.customerRepId),
    carrierRepId: text(loadCarrier?.carrierRepId) ?? text(load.carrierRepId),
    teamKey: text(customer?.teamKey),
    invoiceId: text(order?.invoiceId),
    invoiceMonth: invoicedOn ? invoicedOn.slice(0, 7) : null,
  }
}
