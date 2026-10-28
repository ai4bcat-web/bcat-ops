/**
 * What goes on the two documents the broker generates for a shipment: the bill of
 * lading the driver carries, and the load summary the office reads.
 *
 * The assembly lives here, away from jsPDF, for two reasons. The Lambdas have to be
 * able to describe a document without rendering one (so imports stay relative and
 * type-only — a `@/` alias would break the function bundle), and the audience rules
 * are the whole point of these shapes rather than an afterthought of the layout.
 *
 * The audience split is enforced by the types, not by discipline:
 *
 *   `BolInput`  — a bill of lading is a receipt for freight. It has no field for
 *                 money, margin or an internal note, so no caller and no future
 *                 layout change can leak one onto a page a carrier hands to a dock.
 *                 Its references are filtered to CUSTOMER and ALL.
 *   `LoadSummaryInput` — internal by construction: both sides' charges, the margin,
 *                 every reference whatever its visibility, the bounced and TONU
 *                 assignments, the open incidents and the internal notes. It is
 *                 never the attachment on a customer or carrier e-mail.
 *
 * Money is integer cents; the renderers divide by 100, nothing here does.
 */
import type { Stop } from '../types'
import type {
  Address,
  ChargeCodeDef,
  CustomerRecord,
  Division,
  FreightItem,
  IncidentType,
  LoadCarrierKind,
  LoadCarrierStatus,
  LoadChargeRecord,
  LoadCheckCallRecord,
  LoadWorkflowStatus,
  LocationRecord,
  OrderRecord,
  OrderReference,
  RateConStatus,
  ReferenceLevel,
  ReferenceVisibility,
  ShipmentBundle,
  ShipmentLoad,
  ShipmentMode,
  ShipmentStatus,
  SpecialRequirements,
} from '../types/tms'

// ── Bill of lading ───────────────────────────────────────────────────────────

/** A reference as it prints on a BOL: no level, no visibility, nothing to filter twice. */
export interface BolReference {
  label: string
  value: string
}

/** One end of the move. The same shape serves the shipper and the consignee. */
export interface BolParty {
  name: string
  /** Street and city line, newline-joined, ready to print as a block. */
  address: string
  /** Who takes the paperwork here — `Name · phone`, or null when nobody is named. */
  contact: string | null
  /** ISO 8601, or null when the stop is still TBD. */
  appt: string | null
  refs: BolReference[]
}

export interface BolCarrier {
  name: string
  mc: string | null
  driverName: string | null
  truckNumber: string | null
  trailerNumber: string | null
}

/**
 * Everything a bill of lading prints. There is deliberately nowhere to put a rate,
 * a margin or an internal note.
 */
export interface BolInput {
  broker: { name: string; address: string; phone: string | null; mc: string | null }
  shipmentNumber: string
  bolNumber: string
  customer: { name: string; billTo: string | null }
  shipper: BolParty
  consignee: BolParty
  /** Null until somebody is assigned; a BOL can be printed before a carrier exists. */
  carrier: BolCarrier | null
  freight: FreightItem[]
  /** Team, tarps, hazmat, temperature… as printable labels. */
  specialRequirements: string[]
  customerNotes: string | null
  terms: string
}

export interface BolOptions {
  /** The broker's phone. `Division` carries none, so the caller supplies it. */
  brokerPhone?: string | null
  /** Overrides the number when the customer dictates their own BOL number. */
  bolNumber?: string | null
  /** Replaces `DEFAULT_BOL_TERMS` when the org has its own wording. */
  terms?: string | null
}

/**
 * The straight bill of lading conditions. Short on purpose: this page is a receipt
 * for freight, and the commercial terms live on the rate confirmation the carrier
 * signed and in the customer's agreement.
 */
export const DEFAULT_BOL_TERMS =
  'Received, subject to the classifications and lawfully filed tariffs in effect on the date of issue, '
  + 'the property described above in apparent good order except as noted (contents and condition of '
  + 'contents of packages unknown), marked, consigned and destined as shown. The carrier certifies that '
  + 'it is in possession of the property described, that the property is properly described by name and '
  + 'is in proper condition for transportation according to the applicable regulations of the DOT, and '
  + 'agrees to deliver it to the consignee named above. Shipper hereby certifies that it is familiar with '
  + 'all the terms and conditions of this bill of lading and that those terms and conditions are agreed to '
  + 'by the shipper and accepted for itself and its assigns.'

// ── Load summary ─────────────────────────────────────────────────────────────

/** A reference with the visibility that decided where else it may appear. */
export interface LoadSummaryReference {
  label: string
  value: string
  level: ReferenceLevel
  visibility: ReferenceVisibility
  stopId: string | null
}

export interface LoadSummaryLoad {
  loadNumber: string
  leg: number
  status: LoadWorkflowStatus | null
  equipmentType: string | null
  carrierName: string | null
  miles: number | null
}

export interface LoadSummaryStop {
  loadNumber: string
  leg: number
  kind: 'PICKUP' | 'DELIVERY'
  name: string
  address: string
  appt: string | null
  apptEnd: string | null
  apptType: string | null
  /** The facility clocks, as they were actually stamped. Null means it has not happened. */
  arrivedAt: string | null
  departedAt: string | null
  refs: LoadSummaryReference[]
  notes: string | null
}

export interface LoadSummaryCharge {
  code: string
  label: string
  amountCents: number
  loadNumber: string | null
  note: string | null
}

/** One attempt at covering a load — including the ones that fell through. */
export interface LoadSummaryAssignment {
  loadNumber: string
  sequence: number
  kind: LoadCarrierKind
  status: LoadCarrierStatus
  carrierName: string | null
  carrierMc: string | null
  driverName: string | null
  truckNumber: string | null
  trailerNumber: string | null
  bookedAt: string | null
  /** What this attempt cost, cached on the assignment. A BOUNCED row usually costs nothing. */
  costCents: number | null
  removalReason: string | null
  removalNote: string | null
  rateConStatus: RateConStatus | null
}

export interface LoadSummaryIncident {
  at: string
  loadNumber: string | null
  type: IncidentType | null
  city: string | null
  state: string | null
  note: string | null
}

/**
 * The internal picture of one shipment. Both sides' money, the margin, every
 * reference whatever its visibility, the failed assignments and the unresolved
 * incidents — this shape is for the office and nobody else.
 */
export interface LoadSummaryInput {
  shipmentNumber: string
  status: ShipmentStatus
  mode: ShipmentMode
  customer: {
    name: string
    billTo: string | null
    contact: string | null
    paymentTermsDays: number | null
  }
  loads: LoadSummaryLoad[]
  stops: LoadSummaryStop[]
  /** Order-level references; stop-level ones travel on their stop. */
  references: LoadSummaryReference[]
  equipment: {
    type: string | null
    lengthFt: number | null
    commodity: string | null
    weightLbs: number | null
    specialRequirements: string[]
  }
  customerCharges: LoadSummaryCharge[]
  carrierCharges: LoadSummaryCharge[]
  /** The cached totals, summed across the shipment's loads. */
  revenueCents: number
  costCents: number
  profitCents: number
  marginBps: number
  assignments: LoadSummaryAssignment[]
  incidents: LoadSummaryIncident[]
  internalNotes: string | null
}

// ── Shared assembly ──────────────────────────────────────────────────────────

const text = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed || null
}

function addressBlock(address: Address | null | undefined): string {
  if (!address) return ''
  const cityLine = [address.city, [address.state, address.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ')
  return [address.street, cityLine].filter(Boolean).join('\n')
}

/** Legs in the order they are hauled; a load with no leg number sorts first and stably. */
function orderedLoads(bundle: ShipmentBundle): ShipmentLoad[] {
  return [...bundle.loads].sort((a, b) => (a.leg ?? 0) - (b.leg ?? 0))
}

function loadNumberOf(load: ShipmentLoad): string {
  return load.loadNumber ?? load.id
}

/** The labels a human reads instead of five booleans and a temperature range. */
function requirementLabels(requirements: SpecialRequirements | null | undefined): string[] {
  if (!requirements) return []
  const labels: string[] = []
  if (requirements.team) labels.push('Team')
  if (requirements.tarps) labels.push('Tarps')
  if (requirements.straps) labels.push('Straps')
  if (requirements.liftgate) labels.push('Liftgate')
  if (requirements.hazmat) labels.push('Hazmat')
  const temp = requirements.tempF
  if (temp) labels.push(`Temp ${temp.target}°F (${temp.min}–${temp.max})`)
  for (const other of requirements.other ?? []) {
    const label = text(other)
    if (label) labels.push(label)
  }
  return labels
}

function billToName(customer: CustomerRecord | null, orders: OrderRecord[]): string | null {
  const parties = customer?.billToParties ?? []
  if (parties.length === 0) return null
  const billToId = orders.find((order) => order.billToId)?.billToId ?? null
  const named = billToId ? parties.find((party) => party.id === billToId) : null
  const party = named ?? parties.find((p) => p.isDefault) ?? null
  return party ? party.name : null
}

function referenceLabel(reference: OrderReference): string {
  return reference.label || reference.code
}

// ── bolData ──────────────────────────────────────────────────────────────────

/** Only what the customer's own paperwork may show. INTERNAL and CARRIER never print. */
function customerVisible(reference: OrderReference): boolean {
  return reference.visibility === 'CUSTOMER' || reference.visibility === 'ALL'
}

function partyContact(stop: Stop, location: LocationRecord | null): string | null {
  const name = text(stop.documentContact?.name) ?? text(location?.apptContactName)
  const phone = text(stop.documentContact?.phone) ?? text(location?.apptContactPhone)
  return [name, phone].filter(Boolean).join(' · ') || null
}

function bolParty(stop: Stop | null, location: LocationRecord | null, refs: BolReference[]): BolParty {
  if (!stop) return { name: '', address: '', contact: null, appt: null, refs }
  const address = stop.address
    ? addressBlock(stop.address)
    : addressBlock(location) || text(stop.city) || ''
  return {
    name: text(stop.name) ?? text(location?.name) ?? '',
    address,
    contact: partyContact(stop, location),
    appt: text(stop.appt),
    refs,
  }
}

/**
 * The bill of lading for a shipment: the first pickup is the shipper, the last
 * delivery the consignee, and everything in between is the carrier's problem rather
 * than the dock's.
 *
 * `locations` fills in what the stop snapshot left out — the facility's appointment
 * contact and, on a legacy stop with no address block, its address. `customer`
 * supplies the bill-to party and `division` the broker letterhead; both may be null
 * while a shipment is still being built.
 *
 * Nothing on the returned shape is money, margin or an internal note, and the
 * references are filtered to CUSTOMER and ALL before they get here.
 */
export function bolData(
  bundle: ShipmentBundle,
  customer: CustomerRecord | null,
  division: Division | null,
  locations: readonly LocationRecord[],
  options: BolOptions = {},
): BolInput {
  const loads = orderedLoads(bundle)
  const byLocation = new Map(locations.map((location) => [location.id, location]))

  const pickups: { load: ShipmentLoad; stop: Stop }[] = []
  const deliveries: { load: ShipmentLoad; stop: Stop }[] = []
  for (const load of loads) {
    for (const stop of [...(load.stops ?? [])].sort((a, b) => a.sequence - b.sequence)) {
      (stop.type === 'pickup' ? pickups : deliveries).push({ load, stop })
    }
  }
  const first = pickups[0] ?? null
  const last = deliveries[deliveries.length - 1] ?? null

  const orderRefs = bundle.orders.flatMap((order) => order.references ?? []).filter(customerVisible)
  const refsForStop = (stop: Stop | null): BolReference[] => {
    if (!stop) return []
    const stopLevel = [
      ...orderRefs.filter((reference) => reference.stopId === stop.id),
      ...(stop.refs ?? []).filter(customerVisible),
    ]
    return stopLevel.map((reference) => ({ label: referenceLabel(reference), value: reference.value }))
  }

  // An order-level reference (the PO) identifies the whole shipment, so it prints once,
  // at the shipper, which is where a dock hand looks for it.
  const shipperRefs = [
    ...orderRefs.filter((reference) => !reference.stopId)
      .map((reference) => ({ label: referenceLabel(reference), value: reference.value })),
    ...refsForStop(first?.stop ?? null),
  ]

  // The carrier on the leg that picks up is the one whose driver signs this page.
  const active = bundle.loadCarriers.filter((assignment) => assignment.status === 'ACTIVE')
  const assignment = active.find((row) => row.loadId === first?.load.id) ?? active[0] ?? null

  const bolReference = orderRefs.find((reference) => reference.code.toUpperCase() === 'BOL')

  return {
    broker: {
      name: division?.legalName || division?.name || 'Broker',
      address: addressBlock(division?.remitToAddress),
      phone: text(options.brokerPhone),
      mc: text(division?.mcNumber),
    },
    shipmentNumber: bundle.shipment.number,
    bolNumber: text(options.bolNumber) ?? text(bolReference?.value) ?? bundle.shipment.number,
    customer: {
      name: customer?.name ?? bundle.shipment.customerName ?? '',
      billTo: billToName(customer, bundle.orders),
    },
    shipper: bolParty(first?.stop ?? null, byLocation.get(first?.stop.locationId ?? '') ?? null, shipperRefs),
    consignee: bolParty(last?.stop ?? null, byLocation.get(last?.stop.locationId ?? '') ?? null, refsForStop(last?.stop ?? null)),
    carrier: assignment
      ? {
        name: assignment.carrierName ?? '',
        mc: text(assignment.carrierMc),
        driverName: text(assignment.driverName),
        truckNumber: text(assignment.truckNumber),
        trailerNumber: text(assignment.trailerNumber),
      }
      : null,
    freight: bundle.orders.flatMap((order) => order.freight ?? []),
    specialRequirements: Array.from(new Set(
      bundle.orders.flatMap((order) => requirementLabels(order.specialRequirements)),
    )),
    customerNotes: text(bundle.orders.map((order) => order.customerNotes ?? '').filter(Boolean).join('\n')),
    terms: text(options.terms) ?? DEFAULT_BOL_TERMS,
  }
}

function summaryReference(reference: OrderReference): LoadSummaryReference {
  return {
    label: referenceLabel(reference),
    value: reference.value,
    level: reference.level,
    visibility: reference.visibility,
    stopId: reference.stopId ?? null,
  }
}

/**
 * The internal summary of one shipment: who, where, when, what it sold and bought,
 * and what went wrong on the way.
 *
 * INTERNAL by construction — both sides of the money, the margin, the references a
 * customer never sees, the assignments that bounced and the incidents still open all
 * appear here. It is the office's working picture of a shipment and must never be
 * attached to a customer or carrier e-mail.
 *
 * The totals are the **cached** ones on `bundle.financials`, summed across the
 * shipment's loads, not a re-add of the charge lines: this document reports what the
 * system believes a shipment is worth, so a stale cache shows up as the discrepancy
 * it is instead of being papered over. The margin follows the same definition the
 * rest of the TMS uses (profit ÷ revenue in basis points, zero revenue yielding 0).
 */
export function loadSummaryData(
  bundle: ShipmentBundle,
  customer: CustomerRecord | null,
  catalog: readonly ChargeCodeDef[] | null | undefined,
  checkCalls: readonly LoadCheckCallRecord[],
): LoadSummaryInput {
  const loads = orderedLoads(bundle)
  const codes = catalog ?? []
  const loadNumbers = new Map(loads.map((load) => [load.id, loadNumberOf(load)]))

  const stops: LoadSummaryStop[] = []
  for (const load of loads) {
    for (const stop of [...(load.stops ?? [])].sort((a, b) => a.sequence - b.sequence)) {
      stops.push({
        loadNumber: loadNumberOf(load),
        leg: load.leg ?? 0,
        kind: stop.type === 'pickup' ? 'PICKUP' : 'DELIVERY',
        name: text(stop.name) ?? '',
        address: addressBlock(stop.address) || text(stop.city) || '',
        appt: text(stop.appt),
        apptEnd: text(stop.apptEnd),
        apptType: text(stop.apptType),
        arrivedAt: text(stop.arrivedAt),
        departedAt: text(stop.departedAt),
        refs: (stop.refs ?? []).map(summaryReference),
        notes: text(stop.stopNotes),
      })
    }
  }

  const charges = [...bundle.charges].sort((a, b) => a.sortOrder - b.sortOrder)
  const chargeRow = (charge: LoadChargeRecord): LoadSummaryCharge => ({
    code: charge.code,
    label: charge.label || codes.find((entry) => entry.code === charge.code)?.label || charge.code,
    amountCents: charge.amountCents,
    loadNumber: charge.loadId ? loadNumbers.get(charge.loadId) ?? null : null,
    note: text(charge.note),
  })

  let revenueCents = 0
  let costCents = 0
  for (const financials of bundle.financials) {
    revenueCents += financials.revenueCents
    costCents += financials.costCents
  }
  const profitCents = revenueCents - costCents

  const assignments = [...bundle.loadCarriers]
    .sort((a, b) => (a.loadId === b.loadId ? (a.sequence ?? 0) - (b.sequence ?? 0) : a.loadId.localeCompare(b.loadId)))
    .map<LoadSummaryAssignment>((row) => ({
      loadNumber: loadNumbers.get(row.loadId) ?? row.loadId,
      sequence: row.sequence ?? 1,
      kind: row.kind,
      status: row.status,
      carrierName: text(row.carrierName),
      carrierMc: text(row.carrierMc),
      driverName: text(row.driverName),
      truckNumber: text(row.truckNumber),
      trailerNumber: text(row.trailerNumber),
      bookedAt: text(row.bookedAt),
      costCents: row.costCents ?? null,
      removalReason: text(row.removalReason),
      removalNote: text(row.removalNote),
      rateConStatus: row.rateConStatus ?? null,
    }))

  // Only what is still open: a resolved incident is history the timeline keeps, not
  // something the summary has to put in front of whoever picks this shipment up.
  const incidents = checkCalls
    .filter((call) => call.type === 'INCIDENT' && !call.resolvedAt)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map<LoadSummaryIncident>((call) => ({
      at: call.at,
      loadNumber: loadNumbers.get(call.loadId) ?? null,
      type: call.incidentType ?? null,
      city: text(call.city),
      state: text(call.state),
      note: text(call.note),
    }))

  const firstOrder = bundle.orders[0] ?? null
  const firstLoad = loads[0] ?? null

  return {
    shipmentNumber: bundle.shipment.number,
    status: bundle.shipment.status,
    mode: bundle.shipment.mode,
    customer: {
      name: customer?.name ?? bundle.shipment.customerName ?? '',
      billTo: billToName(customer, bundle.orders),
      contact: text(customer?.contactName),
      paymentTermsDays: customer?.paymentTermsDays ?? null,
    },
    loads: loads.map<LoadSummaryLoad>((load) => ({
      loadNumber: loadNumberOf(load),
      leg: load.leg ?? 0,
      status: load.status ?? null,
      equipmentType: text(load.equipmentType),
      carrierName: text(load.carrierName),
      miles: load.miles ?? null,
    })),
    stops,
    references: bundle.orders
      .flatMap((order) => order.references ?? [])
      .filter((reference) => !reference.stopId)
      .map(summaryReference),
    equipment: {
      type: text(firstOrder?.equipmentType) ?? text(firstLoad?.equipmentType),
      lengthFt: firstOrder?.equipmentLengthFt ?? null,
      commodity: text(firstLoad?.commodity),
      weightLbs: firstLoad?.weight ?? null,
      specialRequirements: Array.from(new Set(
        bundle.orders.flatMap((order) => requirementLabels(order.specialRequirements)),
      )),
    },
    customerCharges: charges.filter((charge) => charge.side === 'CUSTOMER').map(chargeRow),
    carrierCharges: charges.filter((charge) => charge.side === 'CARRIER').map(chargeRow),
    revenueCents,
    costCents,
    profitCents,
    marginBps: revenueCents === 0 ? 0 : Math.round((profitCents * 10000) / revenueCents),
    assignments,
    incidents,
    internalNotes: text(bundle.orders.map((order) => order.internalNotes ?? '').filter(Boolean).join('\n')),
  }
}
