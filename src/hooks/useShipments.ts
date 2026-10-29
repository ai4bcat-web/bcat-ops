import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listCarriers, listCustomers, listDrivers, listLoadCarriers, listLoadFinancials, listLoadSummaries, listOrders, listQuotes,
  listShipments, listShipmentsByCustomer, listShipmentsByMonth, listShipmentsByStatus, listUserProfiles,
} from '@/lib/apiClient'
import type { LoadBoardSummary } from '@/lib/apiClient'
import type { Driver, Stop } from '@/types'
import type { PaperworkLocation } from '@/lib/paperworkLocation'
import type {
  ApStatus, ArStatus, AssignmentType, AuthorityStatus, CarrierRecord, CarrierStatus, ComplianceCheckStatus, CustomerRecord,
  CustomerStatus, InvoiceFrequency, LoadCarrierRecord, LoadFinancialsRecord, LoadWorkflowStatus, OrderRecord, QuoteRecord,
  RateConStatus, RateType, SafetyRating, ShipmentRecord, ShipmentStatus, SpecialRequirements, UserProfileRecord,
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
  // ── R2 column catalog — everything the picker's columns read, null when unknown ──
  /** Rep and audit ids resolved to profile names; null when no profile matches. */
  salesRepName: string | null
  customerRepName: string | null
  dispatcherAssignedName: string | null
  dispatcherActualName: string | null
  statusChangedByName: string | null
  voidedByName: string | null
  createdByName: string | null
  updatedByName: string | null
  // Order — the customer side.
  refPo: string | null
  refPu: string | null
  refDelivery: string | null
  refBol: string | null
  billToName: string | null
  costCenter: string | null
  rateType: RateType | null
  equipmentLengthFt: number | null
  specialRequirements: SpecialRequirements | null
  orderCommodity: string | null
  freightWeightLbs: number | null
  freightPieces: number | null
  freightPallets: number | null
  customerNotes: string | null
  internalNotes: string | null
  customerRateCents: number | null
  orderRevenueCents: number | null
  arStatusChangedAt: string | null
  invoiceNumber: string | null
  invoicedAt: string | null
  paidAt: string | null
  arBalanceCents: number | null
  factoringItemId: string | null
  docsRequired: string[] | null
  docsCheckedAt: string | null
  docsOverrideAt: string | null
  docsOverrideBy: string | null
  docsOverrideNote: string | null
  quoteNumber: string | null
  quoteAmountCents: number | null
  // Load — folded across the shipment's legs.
  loadAljexId: string | null
  loadTmsId: string | null
  pickupNumber: string | null
  pickupApptEnd: string | null
  pickupApptType: string | null
  deliveryApptEnd: string | null
  deliveryApptType: string | null
  pickupDriverName: string | null
  deliveryDriverName: string | null
  loadTrailerNumber: string | null
  loadRateCents: number | null
  miles: number | null
  hot: boolean | null
  weightLbs: number | null
  pieces: number | null
  piecesUnit: string | null
  paperworkLocation: PaperworkLocation | null
  eldLogsReviewedAt: string | null
  eldLogsReviewedBy: string | null
  eldLogsReviewedByName: string | null
  readyToInvoice: boolean | null
  rateConOnFile: boolean | null
  divisionKey: string | null
  nextCheckCallNote: string | null
  lastCheckCallType: string | null
  lastKnownAt: string | null
  lastKnownCity: string | null
  lastKnownState: string | null
  lastKnownSource: string | null
  loadDeliveredAt: string | null
  cargoValueCents: number | null
  loadNotes: string | null
  podNotes: string | null
  // Carrier leg — the ACTIVE LoadCarrier.
  carrierMc: string | null
  carrierDispatcherName: string | null
  carrierDispatcherPhone: string | null
  carrierDispatcherEmail: string | null
  driverPhone: string | null
  driver2Name: string | null
  driver2Phone: string | null
  trailerNumber: string | null
  plates: string | null
  vin: string | null
  sealNumber: string | null
  tripNumber: string | null
  pickupEtaAt: string | null
  deliveryEtaAt: string | null
  rateConStatus: RateConStatus | null
  rateConSentAt: string | null
  rateConSignedAt: string | null
  carrierRateCents: number | null
  legCostCents: number | null
  apBalanceCents: number | null
  apPaidAt: string | null
  quickPay: boolean | null
  quickPayDays: number | null
  quickPayFeeBps: number | null
  paymentTermsDays: number | null
  bookedAt: string | null
  dispatchedAt: string | null
  trackingStartedAt: string | null
  trackingStoppedAt: string | null
  podRequestedAt: string | null
  legDocsMissing: string[] | null
  ratingStars: number | null
  // Customer directory.
  customerMc: string | null
  customerDot: string | null
  customerFactored: boolean | null
  customerPaymentTermsDays: number | null
  creditLimitCents: number | null
  creditHold: boolean | null
  customerStatus: CustomerStatus | null
  serviceTier: string | null
  customerTeamKey: string | null
  customerOwnerNames: string | null
  defaultSalesRepName: string | null
  invoiceFrequency: InvoiceFrequency | null
  // Carrier directory.
  carrierDot: string | null
  carrierScac: string | null
  carrierStatus: CarrierStatus | null
  authorityStatus: AuthorityStatus | null
  safetyRating: SafetyRating | null
  cargoInsuranceExpiresAt: string | null
  liabilityInsuranceExpiresAt: string | null
  mcpStatus: string | null
  highwayStatus: ComplianceCheckStatus | null
  rmisStatus: ComplianceCheckStatus | null
  quickPayEligible: boolean | null
  carrierTeamKey: string | null
  carrierOwnerNames: string | null
  carrierLoadCount: number | null
  carrierLastLoadAt: string | null
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

/** The first non-blank value of one reference code on an order; null when absent. */
function referenceValue(order: OrderRecord | undefined, code: string): string | null {
  const ref = order?.references?.find((r) => r.code === code && (r.value ?? '').trim() !== '')
  return ref ? ref.value : null
}

/** Sum the values that exist; null when none do — "not sent" is not "zero". */
function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null)
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null
}

/** Distinct non-blank values joined, so a two-leg shipment keeps both legs' numbers. */
function joinUnique(values: Array<string | null | undefined>, separator = ', '): string | null {
  const unique = [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))]
  return unique.length > 0 ? unique.join(separator) : null
}

/** a.json fields come back as objects through the unwrapped read and as strings otherwise. */
function parsePaperworkLocation(raw: unknown): PaperworkLocation | null {
  if (!raw) return null
  const value = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw) as unknown } catch { return null } })()
    : raw
  if (!value || typeof value !== 'object') return null
  const o = value as Partial<PaperworkLocation>
  if (o.kind !== 'TRUCK' && o.kind !== 'SHED' && o.kind !== 'TRAILER') return null
  return { kind: o.kind, unit: o.unit ?? null, at: String(o.at ?? ''), byDriverId: o.byDriverId ?? null, byName: o.byName ?? null }
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
  // R2 — the two directory lists and the driver roster the column catalog joins in
  // memory: customer and carrier facts, and names for the load's driver ids.
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [carriers, setCarriers] = useState<CarrierRecord[]>([])
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Callers rebuild the view object every render; depending on its identity would
  // refetch forever. Its two values are what decide the query.
  const kind = view.kind
  const arg = viewArg(view)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() =>
    Promise.all([
      fetchShipments(kind, arg), listOrders(), listLoadSummaries(), listLoadCarriers(), listQuotes(),
      listLoadFinancials(), listUserProfiles(), listCustomers(), listCarriers(), listDrivers(),
    ])
      .then(([s, o, l, lc, q, lf, up, cu, ca, dr]) => {
        setShipments(s); setOrders(o); setLoads(l); setLoadCarriers(lc); setQuotes(q); setLoadFinancials(lf)
        setUserProfiles(up); setCustomers(cu); setCarriers(ca); setDrivers(dr); setError(null)
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
      nextCheckCallNote: string | null
      lastCheckCallAt: string | null
      lastCheckCallType: string | null
      checkCallOpen: 'OPEN' | null
      openIncidentCount: number
      trackingProvider: string | null
      lastKnownAt: string | null
      lastKnownCity: string | null
      lastKnownState: string | null
      lastKnownSource: string | null
      /** Null until a load answers with a stop list: "not sent" is not "no stops". */
      stopCount: number | null
    }> = {}
    for (const l of loads) {
      if (!l.shipmentId) continue
      if (l.assignmentType) assignmentByShipment[l.shipmentId] = l.assignmentType
      if (l.status) statusByShipment[l.shipmentId] = l.status
      const t = trackingByShipment[l.shipmentId] ??= {
        lastUpdateAt: null, lastUpdatePlace: null, nextCheckCallAt: null, nextCheckCallNote: null,
        lastCheckCallAt: null, lastCheckCallType: null, checkCallOpen: null, openIncidentCount: 0,
        trackingProvider: null, lastKnownAt: null, lastKnownCity: null, lastKnownState: null,
        lastKnownSource: null, stopCount: null,
      }
      const update = l.lastKnownAt ?? l.lastCheckCallAt ?? null
      if (update && (!t.lastUpdateAt || update > t.lastUpdateAt)) {
        t.lastUpdateAt = update
        t.lastUpdatePlace = [l.lastKnownCity, l.lastKnownState].filter(Boolean).join(', ') || null
      }
      // The newest "last known" across the legs keeps its place and its source together.
      if (l.lastKnownAt && (!t.lastKnownAt || l.lastKnownAt > t.lastKnownAt)) {
        t.lastKnownAt = l.lastKnownAt
        t.lastKnownCity = l.lastKnownCity ?? null
        t.lastKnownState = l.lastKnownState ?? null
        t.lastKnownSource = l.lastKnownSource ?? null
      }
      if (l.lastCheckCallAt && (!t.lastCheckCallAt || l.lastCheckCallAt > t.lastCheckCallAt)) {
        t.lastCheckCallAt = l.lastCheckCallAt
        t.lastCheckCallType = l.lastCheckCallType ?? null
      }
      // The soonest reminder wins, and its note rides with it.
      if (l.nextCheckCallAt && (!t.nextCheckCallAt || l.nextCheckCallAt < t.nextCheckCallAt)) {
        t.nextCheckCallAt = l.nextCheckCallAt
        t.nextCheckCallNote = l.nextCheckCallNote ?? null
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

    // R2 — the order itself, first-wins like the per-field maps above: a multi-order
    // shipment reads its primary order's references, freight and AR facts.
    const orderByShipment: Record<string, OrderRecord> = {}
    for (const o of orders) orderByShipment[o.shipmentId] ??= o

    // The sell-side quote record, so the catalog can show its number and amount.
    const quoteRecByShipment: Record<string, QuoteRecord> = {}
    for (const q of quotes) if (q.side === 'SELL' && q.shipmentId) quoteRecByShipment[q.shipmentId] ??= q

    // R2 — id → directory row, and id → display name. A profile name is the person;
    // the e-mail/username is the honest fallback when no profile claims the id.
    const customerById: Record<string, CustomerRecord> = {}
    for (const c of customers) customerById[c.id] = c
    const carrierById: Record<string, CarrierRecord> = {}
    for (const c of carriers) carrierById[c.id] = c
    const driverById: Record<string, Driver> = {}
    for (const d of drivers) driverById[d.id] = d
    const profileById: Record<string, UserProfileRecord> = {}
    for (const p of userProfiles) {
      if (p.email) profileById[p.email] ??= p
      if (p.id) profileById[p.id] ??= p
    }
    const nameOf = (id: string | null | undefined): string | null => {
      if (!id) return null
      const p = profileById[id]
      return p ? (p.name ?? p.email ?? id) : null
    }
    const ownerNamesOf = (ids: string[] | null | undefined): string | null => {
      if (!ids || ids.length === 0) return null
      return ids.map((id) => nameOf(id) ?? id).join(', ')
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

      // ── R2 catalog: the order, the legs, the ACTIVE assignment, the directories ──
      const order = orderByShipment[s.id]
      const freightItems = order?.freight ?? null
      const freightWeights = freightItems?.map((i) => i.weightLbs).filter((w): w is number => w != null) ?? []
      const freightPalletItems = freightItems?.filter((i) => i.handlingUnit === 'PALLET' || i.handlingUnit === 'SKID') ?? []
      const billToParty = order?.billToId && order.customerId
        ? customerById[order.customerId]?.billToParties?.find((p) => p.id === order.billToId)
        : undefined
      const quote = quoteRecByShipment[s.id]

      // Money and counts add across legs; identifiers join; flags fold to one answer.
      const eldReviewed = shipmentLoads
        .filter((l) => l.eldLogsReviewedAt)
        .sort((a, b) => (a.eldLogsReviewedAt ?? '').localeCompare(b.eldLogsReviewedAt ?? ''))
        .pop()

      const dispatcherAssignedId = active?.carrierRepId ?? firstLoad?.carrierRepId ?? null
      const dispatcherActualId = activeLoad?.statusChangedBy ?? lastLoad?.statusChangedBy ?? null
      const customerRepId = repByShipment[s.id] ?? null

      const customer = s.customerId ? customerById[s.customerId] : undefined
      const carrier = active?.carrierId ? carrierById[active.carrierId] : undefined
      // The latest expiry per policy type is the one that still covers the load.
      const insuranceExpiry = (types: Array<'CARGO' | 'AUTO_LIABILITY' | 'GENERAL_LIABILITY'>): string | null => {
        const dates = carrier?.insurancePolicies
          ?.filter((p) => types.includes(p.type as 'CARGO') && p.expiresAt)
          .map((p) => p.expiresAt as string)
          .sort() ?? []
        return dates.length > 0 ? dates[dates.length - 1] : null
      }

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
        customerRepId,
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
        dispatcherAssignedId,
        dispatcherActualId,
        officeTeamKeys: s.salesRepId ? (teamKeysByRepId[s.salesRepId] ?? null) : null,
        shipDate: firstLoad?.pickupAppt ?? null,
        stops,
        // Resolved names.
        salesRepName: nameOf(s.salesRepId),
        customerRepName: nameOf(customerRepId),
        dispatcherAssignedName: nameOf(dispatcherAssignedId),
        dispatcherActualName: nameOf(dispatcherActualId),
        statusChangedByName: nameOf(s.statusChangedBy),
        voidedByName: nameOf(s.voidedBy ?? s.deletedBy),
        createdByName: nameOf(s.createdBy),
        updatedByName: nameOf(s.updatedBy),
        // Order.
        refPo: referenceValue(order, 'PO'),
        refPu: referenceValue(order, 'PU'),
        refDelivery: referenceValue(order, 'DEL'),
        refBol: referenceValue(order, 'BOL'),
        billToName: billToParty?.name ?? null,
        costCenter: order?.costCenter ?? null,
        rateType: order?.rateType ?? null,
        equipmentLengthFt: order?.equipmentLengthFt ?? null,
        specialRequirements: order?.specialRequirements ?? null,
        orderCommodity: freightItems
          ? joinUnique(freightItems.map((i) => i.description))
          : null,
        freightWeightLbs: freightWeights.length > 0 ? freightWeights.reduce((a, b) => a + b, 0) : null,
        freightPieces: freightItems ? freightItems.reduce((a, i) => a + (i.qty ?? 0), 0) : null,
        freightPallets: freightPalletItems.length > 0 ? freightPalletItems.reduce((a, i) => a + (i.qty ?? 0), 0) : null,
        customerNotes: order?.customerNotes ?? null,
        internalNotes: order?.internalNotes ?? null,
        customerRateCents: order?.customerRateCents ?? null,
        orderRevenueCents: order?.revenueCents ?? null,
        arStatusChangedAt: order?.arStatusChangedAt ?? null,
        invoiceNumber: order?.invoiceNumber ?? null,
        invoicedAt: order?.invoicedAt ?? null,
        paidAt: order?.paidAt ?? null,
        arBalanceCents: order?.arBalanceCents ?? null,
        factoringItemId: order?.factoringItemId ?? null,
        docsRequired: order?.docsRequired ?? null,
        docsCheckedAt: order?.docsCheckedAt ?? null,
        docsOverrideAt: order?.docsOverrideAt ?? null,
        docsOverrideBy: order?.docsOverrideBy ?? null,
        docsOverrideNote: order?.docsOverrideNote ?? null,
        quoteNumber: quote?.id ?? null,
        quoteAmountCents: quote?.amountCents ?? null,
        // Load.
        loadAljexId: joinUnique(shipmentLoads.map((l) => l.aljexId)),
        loadTmsId: joinUnique(shipmentLoads.map((l) => l.tmsId)),
        pickupNumber: joinUnique(shipmentLoads.map((l) => l.pickupNumber)),
        pickupApptEnd: firstLoad?.pickupApptEnd ?? null,
        pickupApptType: firstLoad?.pickupApptType ?? null,
        deliveryApptEnd: lastLoad?.deliveryApptEnd ?? null,
        deliveryApptType: lastLoad?.deliveryApptType ?? null,
        pickupDriverName: driverById[firstLoad?.pickupDriverId ?? '']?.name ?? null,
        deliveryDriverName: driverById[lastLoad?.deliveryDriverId ?? '']?.name ?? null,
        loadTrailerNumber: joinUnique(shipmentLoads.map((l) => l.trailerNumber)),
        loadRateCents: sumOrNull(shipmentLoads.map((l) => l.rate)),
        miles: sumOrNull(shipmentLoads.map((l) => l.miles)),
        hot: shipmentLoads.length === 0 ? null : shipmentLoads.some((l) => l.hot === true),
        weightLbs: sumOrNull(shipmentLoads.map((l) => l.weight)),
        pieces: sumOrNull(shipmentLoads.map((l) => l.pieces)),
        piecesUnit: joinUnique(shipmentLoads.map((l) => l.piecesUnit)),
        paperworkLocation: shipmentLoads.map((l) => parsePaperworkLocation(l.paperworkLocation)).find((p) => p != null) ?? null,
        eldLogsReviewedAt: eldReviewed?.eldLogsReviewedAt ?? null,
        eldLogsReviewedBy: eldReviewed?.eldLogsReviewedBy ?? null,
        eldLogsReviewedByName: nameOf(eldReviewed?.eldLogsReviewedBy),
        readyToInvoice: shipmentLoads.length === 0 ? null : shipmentLoads.every((l) => l.readyToInvoice === true),
        rateConOnFile: shipmentLoads.length === 0 ? null : shipmentLoads.some((l) => !!l.rateConfirmKey),
        divisionKey: shipmentLoads.map((l) => l.divisionKey).find(Boolean) ?? null,
        nextCheckCallNote: tracking?.nextCheckCallNote ?? null,
        lastCheckCallType: tracking?.lastCheckCallType ?? null,
        lastKnownAt: tracking?.lastKnownAt ?? null,
        lastKnownCity: tracking?.lastKnownCity ?? null,
        lastKnownState: tracking?.lastKnownState ?? null,
        lastKnownSource: tracking?.lastKnownSource ?? null,
        loadDeliveredAt: shipmentLoads.map((l) => l.deliveredAt).filter((d): d is string => !!d).sort().pop() ?? null,
        cargoValueCents: sumOrNull(shipmentLoads.map((l) => l.cargoValueCents)),
        loadNotes: joinUnique(shipmentLoads.map((l) => l.notes), ' · '),
        podNotes: joinUnique(shipmentLoads.map((l) => l.podNotes), ' · '),
        // Carrier leg.
        carrierMc: active?.carrierMc ?? carrier?.mcNumber ?? null,
        carrierDispatcherName: active?.dispatcherName ?? null,
        carrierDispatcherPhone: active?.dispatcherPhone ?? null,
        carrierDispatcherEmail: active?.dispatcherEmail ?? null,
        driverPhone: active?.driverPhone ?? null,
        driver2Name: active?.driver2Name ?? null,
        driver2Phone: active?.driver2Phone ?? null,
        trailerNumber: active?.trailerNumber ?? null,
        plates: active?.plates ?? null,
        vin: active?.vin ?? null,
        sealNumber: active?.sealNumber ?? null,
        tripNumber: active?.tripNumber ?? null,
        pickupEtaAt: active?.pickupEtaAt ?? null,
        deliveryEtaAt: active?.deliveryEtaAt ?? null,
        rateConStatus: active?.rateConStatus ?? null,
        rateConSentAt: active?.rateConSentAt ?? null,
        rateConSignedAt: active?.rateConSignedAt ?? null,
        carrierRateCents: active?.carrierRateCents ?? null,
        legCostCents: active?.costCents ?? null,
        apBalanceCents: active?.apBalanceCents ?? null,
        apPaidAt: active?.apPaidAt ?? null,
        quickPay: active?.quickPay ?? null,
        quickPayDays: active?.quickPayDays ?? null,
        quickPayFeeBps: active?.quickPayFeeBps ?? null,
        paymentTermsDays: active?.paymentTermsDays ?? null,
        bookedAt: active?.bookedAt ?? null,
        dispatchedAt: active?.dispatchedAt ?? null,
        trackingStartedAt: active?.trackingStartedAt ?? null,
        trackingStoppedAt: active?.trackingStoppedAt ?? null,
        podRequestedAt: active?.podRequestedAt ?? null,
        legDocsMissing: active?.docsMissing ?? null,
        ratingStars: active?.ratingStars ?? null,
        // Customer directory.
        customerMc: customer?.mcNumber ?? null,
        customerDot: customer?.dotNumber ?? null,
        customerFactored: customer?.factored ?? null,
        customerPaymentTermsDays: customer?.paymentTermsDays ?? null,
        creditLimitCents: customer?.creditLimitCents ?? null,
        creditHold: customer?.creditHoldFlag ?? null,
        customerStatus: customer?.status ?? null,
        serviceTier: customer?.serviceTier ?? null,
        customerTeamKey: customer?.teamKey ?? null,
        customerOwnerNames: ownerNamesOf(customer?.accountOwnerIds),
        defaultSalesRepName: nameOf(customer?.defaultSalesRepId),
        invoiceFrequency: customer?.invoiceFrequency ?? null,
        // Carrier directory.
        carrierDot: carrier?.dotNumber ?? null,
        carrierScac: carrier?.scac ?? null,
        carrierStatus: carrier?.status ?? null,
        authorityStatus: carrier?.authorityStatus ?? null,
        safetyRating: carrier?.safetyRating ?? null,
        cargoInsuranceExpiresAt: insuranceExpiry(['CARGO']),
        liabilityInsuranceExpiresAt: insuranceExpiry(['AUTO_LIABILITY', 'GENERAL_LIABILITY']),
        mcpStatus: carrier?.mcpStatus ?? null,
        highwayStatus: carrier?.highwayStatus ?? null,
        rmisStatus: carrier?.rmisStatus ?? null,
        quickPayEligible: carrier?.quickPayEligible ?? null,
        carrierTeamKey: carrier?.teamKey ?? null,
        carrierOwnerNames: ownerNamesOf(carrier?.accountOwnerIds),
        carrierLoadCount: carrier?.loadCount ?? null,
        carrierLastLoadAt: carrier?.lastLoadAt ?? null,
      }
    })
  }, [shipments, orders, loads, loadCarriers, quotes, loadFinancials, userProfiles, customers, carriers, drivers])

  return { shipments: rows, loading, error, refresh }
}
