import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listLoadCarriers, listLoadSummaries, listOrders, listQuotes, listShipments, listShipmentsByCustomer,
  listShipmentsByMonth, listShipmentsByStatus,
} from '@/lib/apiClient'
import type { LoadBoardSummary } from '@/lib/apiClient'
import type {
  ApStatus, ArStatus, AssignmentType, LoadCarrierRecord, LoadWorkflowStatus, OrderRecord, QuoteRecord,
  ShipmentRecord, ShipmentStatus,
} from '@/types/tms'

export type { ShipmentRecord }

/**
 * Which slice of the board to load. The status, customer and month views ride their
 * GSIs; `all` scans, which is what the "everything" tab needs and what the ~890
 * backfilled rows cost today.
 */
export type ShipmentsView =
  | { kind: 'all' }
  | { kind: 'status'; status: ShipmentStatus }
  | { kind: 'customer'; customerId: string }
  | { kind: 'month'; month: string }

/**
 * A board row: the shipment, plus the facets that live on its order, its loads and the
 * active assignment on those loads. Null means not known — either the row has no
 * order/load yet, or the backend predates the fields — and the board shows such a row
 * under every filter rather than hiding it.
 */
export interface ShipmentListRow extends ShipmentRecord {
  arStatus: ArStatus | null
  /** Step G — the active assignment's AP rung, for the board's AP column. */
  apStatus: ApStatus | null
  assignmentType: AssignmentType | null
  loadStatus: LoadWorkflowStatus | null
  /** Step D — the load's tracking clock, for the board's Last update / Next check call / Exceptions. */
  lastUpdateAt: string | null
  lastUpdatePlace: string | null
  nextCheckCallAt: string | null
  lastCheckCallAt: string | null
  checkCallOpen: 'OPEN' | null
  openIncidentCount: number | null
  trackingProvider: string | null
  /** Step E — the order's cached gate verdict. `[]` is complete; null is never computed. */
  docsMissing: string[] | null
  /** Step R — MVMNT's columns: the first reference, the route length, who is hauling it. */
  reference: string | null
  stopCount: number | null
  carrierName: string | null
  driverName: string | null
  truckNumber: string | null
  /** The order's rep, behind the shipment's own `salesRepId`. */
  customerRepId: string | null
  /** The customer quote this shipment was sold off, when it came from one. */
  quoteId: string | null
  /**
   * Step R merged the old /loads page into this board on the rule that a load IS a
   * shipment, but a Load whose customer never matched a customer record never got a
   * Shipment and so belonged to no list at all. Such a load rides the board as its own
   * row, and this is the load id that row opens. Null on every row that really is a
   * shipment, which is how every reader tells the two apart.
   */
  unlinkedLoadId: string | null
  /**
   * The legacy `Load.rate`, in cents. Only an unlinked load carries money on the row
   * itself; a shipment's revenue lives on its order, which this list does not read.
   */
  loadRateCents: number | null
}

const DEFAULT_VIEW: ShipmentsView = { kind: 'all' }

/** The view's one variable, flattened so the effect can depend on a primitive. */
function viewArg(view: ShipmentsView): string {
  if (view.kind === 'status') return view.status
  if (view.kind === 'customer') return view.customerId
  if (view.kind === 'month') return view.month
  return ''
}

function fetchShipments(kind: ShipmentsView['kind'], arg: string): Promise<ShipmentRecord[]> {
  if (kind === 'status') return listShipmentsByStatus(arg as ShipmentStatus)
  if (kind === 'customer') return listShipmentsByCustomer(arg)
  if (kind === 'month') return listShipmentsByMonth(arg)
  return listShipments()
}

/**
 * A Load that no Shipment ever claimed, as a board row.
 *
 * The new-load form, the scheduler's duplicate and "create load from factoring item"
 * all still mint a Load with no customer match and therefore no Shipment, so this is a
 * live hole and not only the two rows the backfill left behind. The row says what the
 * load is and nothing more: its own PRO, the customer text somebody typed, its own
 * appointments, cities and rate. No shipment number, no division, no customer record
 * link and no AR rung are invented for it.
 */
function unlinkedLoadRow(l: LoadBoardSummary): ShipmentListRow {
  // The live table stores Aljex PROs with trailing spaces, hence the trim.
  const pro = (l.aljexId ?? '').trim() || (l.loadNumber ?? '').trim()
  const update = l.lastKnownAt ?? l.lastCheckCallAt ?? null
  return {
    id: l.id,
    unlinkedLoadId: l.id,
    number: pro || `Load ${l.id.slice(0, 8)}`,
    /*
     * `ShipmentRecord` requires a status and a mode this load does not have. The two
     * values here are placeholders no screen reads: the quick tabs, the status chip,
     * the Mode column and the status and mode filters all branch on `unlinkedLoadId`
     * before they look at either field.
     */
    status: 'DRAFT',
    mode: 'FTL',
    // Empty rather than invented: no customer record matched is the whole reason this
    // load never became a shipment, and the Customer filter must not claim otherwise.
    customerId: '',
    customerName: (l.customer ?? '').trim() || null,
    source: 'MANUAL',
    pickupAppt: l.pickupAppt ?? null,
    deliveryAppt: l.deliveryAppt ?? null,
    originCity: l.originCity ?? null,
    destinationCity: l.destinationCity ?? null,
    // A voided load leaves the working set exactly like a voided shipment does.
    voidedAt: l.voidedAt ?? null,
    loadRateCents: l.rate ?? null,
    createdBy: '',
    updatedBy: '',
    createdAt: l.createdAt ?? '',
    // The summary read does not carry `updatedAt`, and nothing may compare-and-swap
    // against an unlinked row anyway — the row menu is not offered on one.
    updatedAt: '',
    arStatus: null,
    apStatus: null,
    docsMissing: null,
    assignmentType: l.assignmentType ?? null,
    loadStatus: l.status ?? null,
    lastUpdateAt: update,
    lastUpdatePlace: update ? [l.lastKnownCity, l.lastKnownState].filter(Boolean).join(', ') || null : null,
    nextCheckCallAt: l.nextCheckCallAt ?? null,
    lastCheckCallAt: l.lastCheckCallAt ?? null,
    checkCallOpen: l.checkCallOpen ?? null,
    openIncidentCount: l.openIncidentCount ?? null,
    trackingProvider: l.trackingProvider ?? null,
    stopCount: l.stops ? l.stops.length : null,
    reference: null,
    carrierName: l.carrierName ?? null,
    driverName: null,
    truckNumber: null,
    customerRepId: null,
    quoteId: null,
  }
}

/**
 * The shipments board.
 *
 * Reads the chosen slice of shipments and projects each row's AR status and
 * assignment from the order and load that belong to it. A failed read is reported
 * through `error`, never rendered as an empty board — "no shipments" and "the board
 * did not load" are different answers.
 */
export function useShipments(view: ShipmentsView = DEFAULT_VIEW) {
  const [shipments, setShipments] = useState<ShipmentRecord[]>([])
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [loads, setLoads] = useState<LoadBoardSummary[]>([])
  const [loadCarriers, setLoadCarriers] = useState<LoadCarrierRecord[]>([])
  const [quotes, setQuotes] = useState<QuoteRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Callers rebuild the view object every render; depending on its identity would
  // refetch forever. Its two values are what decide the query.
  const kind = view.kind
  const arg = viewArg(view)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() =>
    Promise.all([fetchShipments(kind, arg), listOrders(), listLoadSummaries(), listLoadCarriers(), listQuotes()])
      .then(([s, o, l, lc, q]) => {
        setShipments(s); setOrders(o); setLoads(l); setLoadCarriers(lc); setQuotes(q); setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Shipments failed to load') })
      .finally(() => setLoading(false)),
  [kind, arg])

  useEffect(() => { void load() }, [load])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  const rows = useMemo<ShipmentListRow[]>(() => {
    const arByShipment: Record<string, ArStatus> = {}
    const repByShipment: Record<string, string> = {}
    // MVMNT's REFERENCE column is the first reference the order carries — the number
    // the customer calls the load by, which is why it sits beside the PRO.
    const referenceByShipment: Record<string, string> = {}
    for (const o of orders) {
      if (o.arStatus) arByShipment[o.shipmentId] = o.arStatus
      if (o.customerRepId) repByShipment[o.shipmentId] = o.customerRepId
      const reference = o.references?.find((r) => (r.value ?? '').trim() !== '')
      if (reference) referenceByShipment[o.shipmentId] ??= reference.value
    }

    // `[]` means the gate ran and found nothing outstanding (the column ticks); absent
    // means it has never run (the column stays blank), so the empty array has to survive
    // the map. A shipment with two orders shows everything either of them still owes.
    const docsByShipment: Record<string, string[]> = {}
    for (const o of orders) {
      if (o.docsMissing == null) continue
      const missing = docsByShipment[o.shipmentId] ??= []
      for (const type of o.docsMissing) if (!missing.includes(type)) missing.push(type)
    }

    // The quote a shipment was sold off. Carrier offers (BUY) are a different story and
    // are not what "this shipment came from a quote" means.
    const quoteByShipment: Record<string, string> = {}
    for (const q of quotes) if (q.side === 'SELL' && q.shipmentId) quoteByShipment[q.shipmentId] ??= q.id

    // One ACTIVE assignment per load; the newest one wins when a shipment has several
    // legs, because that is the truck the list is talking about.
    const activeByShipment: Record<string, LoadCarrierRecord> = {}
    for (const lc of loadCarriers) {
      if (lc.status !== 'ACTIVE' || !lc.shipmentId) continue
      const held = activeByShipment[lc.shipmentId]
      if (!held || (lc.createdAt ?? '') > (held.createdAt ?? '')) activeByShipment[lc.shipmentId] = lc
    }

    const assignmentByShipment: Record<string, AssignmentType> = {}
    const statusByShipment: Record<string, LoadWorkflowStatus> = {}
    // A multi-leg shipment is tracked as one line: the newest update across its legs, the
    // soonest reminder, every open exception added up, and every stop on the route.
    const trackingByShipment: Record<string, {
      lastUpdateAt: string | null
      lastUpdatePlace: string | null
      nextCheckCallAt: string | null
      lastCheckCallAt: string | null
      checkCallOpen: 'OPEN' | null
      openIncidentCount: number
      trackingProvider: string | null
      /** Null until a load answers with a stop list: "not sent" is not "no stops". */
      stopCount: number | null
    }> = {}
    for (const l of loads) {
      if (!l.shipmentId) continue
      if (l.assignmentType) assignmentByShipment[l.shipmentId] = l.assignmentType
      if (l.status) statusByShipment[l.shipmentId] = l.status
      const t = trackingByShipment[l.shipmentId] ??= {
        lastUpdateAt: null, lastUpdatePlace: null, nextCheckCallAt: null, lastCheckCallAt: null,
        checkCallOpen: null, openIncidentCount: 0, trackingProvider: null, stopCount: null,
      }
      const update = l.lastKnownAt ?? l.lastCheckCallAt ?? null
      if (update && (!t.lastUpdateAt || update > t.lastUpdateAt)) {
        t.lastUpdateAt = update
        t.lastUpdatePlace = [l.lastKnownCity, l.lastKnownState].filter(Boolean).join(', ') || null
      }
      if (l.lastCheckCallAt && (!t.lastCheckCallAt || l.lastCheckCallAt > t.lastCheckCallAt)) {
        t.lastCheckCallAt = l.lastCheckCallAt
      }
      if (l.nextCheckCallAt && (!t.nextCheckCallAt || l.nextCheckCallAt < t.nextCheckCallAt)) {
        t.nextCheckCallAt = l.nextCheckCallAt
      }
      if (l.checkCallOpen === 'OPEN') t.checkCallOpen = 'OPEN'
      if (l.trackingProvider) t.trackingProvider ??= l.trackingProvider
      if (l.stops) t.stopCount = (t.stopCount ?? 0) + l.stops.length
      t.openIncidentCount += l.openIncidentCount ?? 0
    }

    const linked = shipments.map((s) => {
      const active = activeByShipment[s.id]
      const tracking = trackingByShipment[s.id]
      return {
        ...s,
        arStatus: arByShipment[s.id] ?? null,
        apStatus: active?.apStatus ?? null,
        docsMissing: docsByShipment[s.id] ?? null,
        assignmentType: assignmentByShipment[s.id] ?? null,
        loadStatus: statusByShipment[s.id] ?? null,
        lastUpdateAt: tracking?.lastUpdateAt ?? null,
        lastUpdatePlace: tracking?.lastUpdatePlace ?? null,
        nextCheckCallAt: tracking?.nextCheckCallAt ?? null,
        lastCheckCallAt: tracking?.lastCheckCallAt ?? null,
        checkCallOpen: tracking?.checkCallOpen ?? null,
        openIncidentCount: tracking?.openIncidentCount ?? null,
        trackingProvider: tracking?.trackingProvider ?? null,
        stopCount: tracking?.stopCount ?? null,
        reference: referenceByShipment[s.id] ?? null,
        carrierName: active?.carrierName ?? null,
        driverName: active?.driverName ?? null,
        truckNumber: active?.truckNumber ?? null,
        customerRepId: repByShipment[s.id] ?? null,
        quoteId: quoteByShipment[s.id] ?? null,
        unlinkedLoadId: null,
        loadRateCents: null,
      }
    })

    // The loads nothing claimed. Only the `all` slice carries them: the status, customer
    // and month slices are GSI cuts of Shipment, and a load that is not a shipment yet
    // answers none of those three questions.
    if (kind !== 'all') return linked
    return [...linked, ...loads.filter((l) => !l.shipmentId).map(unlinkedLoadRow)]
  }, [shipments, orders, loads, loadCarriers, quotes, kind])

  return { shipments: rows, loading, error, refresh }
}
