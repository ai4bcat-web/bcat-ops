/**
 * What goes on the load summary the broker generates for a shipment (the bill of
 * lading lives in `bolModel.ts`).
 *
 * The assembly lives here, away from jsPDF, for two reasons. The Lambdas have to be
 * able to describe a document without rendering one (so imports stay relative and
 * type-only — a `@/` alias would break the function bundle), and the audience rules
 * are the whole point of these shapes rather than an afterthought of the layout.
 *
 *   `LoadSummaryInput` — internal by construction: both sides' charges, the margin,
 *                 every reference whatever its visibility, the bounced and TONU
 *                 assignments, the open incidents and the internal notes. It is
 *                 never the attachment on a customer or carrier e-mail.
 *
 * Money is integer cents; the renderers divide by 100, nothing here does.
 */
import type {
  Address,
  ChargeCodeDef,
  CustomerRecord,
  IncidentType,
  LoadCarrierKind,
  LoadCarrierStatus,
  LoadChargeRecord,
  LoadCheckCallRecord,
  LoadWorkflowStatus,
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
