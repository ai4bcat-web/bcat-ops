import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listLoadCarriers, listLoadFinancials, listLoadSummaries, listOrders, listQuotes, listShipments, listShipmentsByCustomer,
  listShipmentsByMonth, listShipmentsByStatus, listUserProfiles,
} from '@/lib/apiClient'
import type { LoadBoardSummary } from '@/lib/apiClient'
import type { Stop } from '@/types'
import type {
  ApStatus, ArStatus, AssignmentType, LoadCarrierRecord, LoadFinancialsRecord, LoadWorkflowStatus, OrderRecord, QuoteRecord,
  ShipmentRecord, ShipmentStatus, UserProfileRecord,
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
  // ── Step R2 — Aljex board facets projected from loads, orders and profiles ──
  revenueCents: number | null
  costCents: number | null
  profitCents: number | null
  marginBps: number | null
  equipmentType: string | null
  commodity: string | null
  customerReference: string | null
  pickupName: string | null
  consigneeName: string | null
  fromState: string | null
  toState: string | null
  dispatcherAssignedId: string | null
  dispatcherActualId: string | null
  officeTeamKeys: string[] | null
  shipDate: string | null
  /** Stops across the shipment's loads, null when the backend has not sent a stop list. */
  stops: Stop[] | null
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

/** 'Dallas, TX' -> 'TX'. Anything without a trailing comma-state stays null. */
function stateFromCity(city: string | null | undefined): string | null {
  if (!city) return null
  const match = city.match(/,\s*([A-Za-z]{2})\s*$/)
  return match ? match[1].toUpperCase() : null
}

function firstPickupStop(stops: Stop[]): Stop | null {
  return stops.find((s) => s.type === 'pickup') ?? null
}

function lastDeliveryStop(stops: Stop[]): Stop | null {
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i].type === 'delivery') return stops[i]
  return null
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
  const [loadFinancials, setLoadFinancials] = useState<LoadFinancialsRecord[]>([])
  const [userProfiles, setUserProfiles] = useState<UserProfileRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Callers rebuild the view object every render; depending on its identity would
  // refetch forever. Its two values are what decide the query.
  const kind = view.kind
  const arg = viewArg(view)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() =>
    Promise.all([fetchShipments(kind, arg), listOrders(), listLoadSummaries(), listLoadCarriers(), listQuotes(), listLoadFinancials(), listUserProfiles()])
      .then(([s, o, l, lc, q, lf, up]) => {
        setShipments(s); setOrders(o); setLoads(l); setLoadCarriers(lc); setQuotes(q); setLoadFinancials(lf); setUserProfiles(up); setError(null)
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
    const equipmentTypeByShipment: Record<string, string> = {}
    for (const o of orders) {
      if (o.arStatus) arByShipment[o.shipmentId] = o.arStatus
      if (o.customerRepId) repByShipment[o.shipmentId] = o.customerRepId
      const reference = o.references?.find((r) => (r.value ?? '').trim() !== '')
      if (reference) referenceByShipment[o.shipmentId] ??= reference.value
      if (o.equipmentType) equipmentTypeByShipment[o.shipmentId] ??= o.equipmentType
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

    // Step R2 — money is cached per load and aggregated to the shipment row.
    const financialsByShipment: Record<string, LoadFinancialsRecord[]> = {}
    for (const f of loadFinancials) {
      if (!f.shipmentId) continue
      const arr = financialsByShipment[f.shipmentId] ??= []
      arr.push(f)
    }

    // Step R2 — a rep's team keys are the Office column; match by e-mail/username.
    const teamKeysByRepId: Record<string, string[] | null> = {}
    for (const p of userProfiles) {
      if (p.email) teamKeysByRepId[p.email] = p.teamKeys ?? null
      if (p.id && p.id !== p.email) teamKeysByRepId[p.id] = p.teamKeys ?? null
    }

    // Step R2 — loads grouped by shipment, ordered by the shipment's own leg list.
    const loadsByShipment: Record<string, LoadBoardSummary[]> = {}
    const loadById: Record<string, LoadBoardSummary> = {}
    for (const l of loads) {
      loadById[l.id] = l
      if (!l.shipmentId) continue
      const arr = loadsByShipment[l.shipmentId] ??= []
      arr.push(l)
    }
    for (const s of shipments) {
      const list = loadsByShipment[s.id]
      if (!list || !s.loadIds || s.loadIds.length === 0) continue
      const indexById: Record<string, number> = {}
      for (let i = 0; i < s.loadIds.length; i++) indexById[s.loadIds[i]] = i
      list.sort((a, b) => (indexById[a.id] ?? Infinity) - (indexById[b.id] ?? Infinity))
    }

    return shipments.map((s) => {
      const active = activeByShipment[s.id]
      const tracking = trackingByShipment[s.id]
      const shipmentLoads = loadsByShipment[s.id] ?? []
      const firstLoad = shipmentLoads[0]
      const lastLoad = shipmentLoads[shipmentLoads.length - 1]
      const activeLoad = active ? loadById[active.loadId] : null

      const financials = financialsByShipment[s.id] ?? []
      const financialLoadIds = new Set(financials.map((f) => f.loadId))
      const hasAllFinancials = shipmentLoads.length > 0 && shipmentLoads.every((l) => financialLoadIds.has(l.id))
      const revenueCents = hasAllFinancials
        ? financials.reduce((sum, f) => sum + f.revenueCents, 0)
        : null
      const costCents = hasAllFinancials
        ? financials.reduce((sum, f) => sum + f.costCents, 0)
        : null
      const profitCents = hasAllFinancials
        ? financials.reduce((sum, f) => sum + f.profitCents, 0)
        : null
      const marginBps = revenueCents != null && revenueCents !== 0
        ? Math.round((profitCents ?? 0) / revenueCents * 10000)
        : null

      let pickupStop: Stop | null = null
      let deliveryStop: Stop | null = null
      for (const l of shipmentLoads) {
        if (pickupStop || !l.stops) continue
        pickupStop = firstPickupStop(l.stops)
      }
      for (let i = shipmentLoads.length - 1; i >= 0; i--) {
        const l = shipmentLoads[i]
        if (deliveryStop || !l.stops) continue
        deliveryStop = lastDeliveryStop(l.stops)
      }

      const stops: Stop[] | null = shipmentLoads.some((l) => Array.isArray(l.stops))
        ? shipmentLoads.flatMap((l) => l.stops ?? [])
        : null

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
        revenueCents,
        costCents,
        profitCents,
        marginBps,
        equipmentType: firstLoad?.equipmentType ?? equipmentTypeByShipment[s.id] ?? null,
        commodity: shipmentLoads.map((l) => l.commodity).find(Boolean) ?? null,
        customerReference: referenceByShipment[s.id] ?? null,
        pickupName: pickupStop?.name ?? firstLoad?.originName ?? null,
        consigneeName: deliveryStop?.name ?? lastLoad?.destinationName ?? null,
        fromState: stateFromCity(pickupStop?.city) ?? stateFromCity(firstLoad?.originCity) ?? null,
        toState: stateFromCity(deliveryStop?.city) ?? stateFromCity(lastLoad?.destinationCity) ?? null,
        dispatcherAssignedId: active?.carrierRepId ?? firstLoad?.carrierRepId ?? null,
        dispatcherActualId: activeLoad?.statusChangedBy ?? lastLoad?.statusChangedBy ?? null,
        officeTeamKeys: s.salesRepId ? (teamKeysByRepId[s.salesRepId] ?? null) : null,
        shipDate: firstLoad?.pickupAppt ?? null,
        stops,
      }
    })
  }, [shipments, orders, loads, loadCarriers, quotes, loadFinancials, userProfiles])

  return { shipments: rows, loading, error, refresh }
}
