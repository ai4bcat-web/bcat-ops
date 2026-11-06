/**
 * What a bill of lading prints, assembled away from jsPDF.
 *
 * Pure and Lambda-safe: imports are relative and type-only (plus two pure libs), so
 * the function bundle can describe a BOL without rendering one.
 *
 * "No money" is by construction. `BolInput` has no rate field; the one optional
 * `rates` member exists only when the caller asks for `includeRates`, and the builder
 * fills it from CUSTOMER-side charge lines alone — never a carrier line, a margin or
 * the financials. A rated BOL is a customer copy (stored with audience CUSTOMER).
 *
 * References on a BOL are the ones that may leave the building: visibility CUSTOMER
 * or ALL. INTERNAL and CARRIER-only never print, because a BOL can reach the customer.
 */
import type { Stop } from '../types'
import type {
  Address,
  CustomerRecord,
  Division,
  FreightItem,
  LoadCarrierRecord,
  LocationRecord,
  OrderRecord,
  OrderReference,
  ShipmentBundle,
  ShipmentLoad,
} from '../types/tms'
import { legStopsOf } from './carrierLegs'
import { generatedFilename } from './shipmentDocuments'

// ── Contract ─────────────────────────────────────────────────────────────────

export type BolScope =
  /** One BOL listing every stop. */
  | { kind: 'MASTER' }
  /** One delivery stop. `n` is its 1-based delivery ordinal (labels the filename); the builder ignores it. */
  | { kind: 'STOP'; stopId: string; n?: number }
  /** One carrier's leg (multi-carrier). Reserved: the builder refuses it until that step lands. */
  | { kind: 'CARRIER'; loadCarrierId: string }

export interface BolBuildOptions {
  scope: BolScope
  includeRates: boolean
  language: 'EN' | 'EN_ES'
  /** settings.trackingContact.phone; used when the division carries no phone. */
  brokerPhone?: string | null
  /** settings.bolTerms */
  terms?: string | null
  /** ISO day printed as the BOL date; defaults to today (UTC). */
  date?: string
}

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
  apptEnd: string | null
  apptType: string | null
  /** This stop's own CUSTOMER/ALL references. */
  refs: BolReference[]
  /** STOP/MASTER shipper only: the other pickups of the shipment. */
  alsoPickedUp: string[]
}

export interface BolStopRow {
  seq: number
  kind: 'PICKUP' | 'DELIVERY'
  name: string
  cityState: string
  appt: string | null
  refs: BolReference[]
}

export interface BolCarrier {
  name: string
  mc: string | null
  driverName: string | null
  driverPhone: string | null
  truckNumber: string | null
  trailerNumber: string | null
  sealNumber: string | null
  /** The stops this carrier covers, when it covers fewer than all; null = the whole route. */
  covers: string | null
}

export interface BolLine {
  qty: number | null
  unit: string
  description: string
  weightLbs: number | null
  freightClass: string | null
  nmfc: string | null
  hazmat: string | null
}

/** Only ever present on a customer copy, and only CUSTOMER-side lines. */
export interface BolRates {
  lines: { label: string; amountCents: number }[]
  totalCents: number
}

export interface BolInput {
  /** `BILL OF LADING — <scopeLabel>` */
  title: string
  scope: BolScope
  scopeLabel: string
  broker: {
    legalName: string
    address: string
    phone: string | null
    mc: string | null
    dot: string | null
    logoKey: string | null
  }
  shipmentNumber: string
  /** The PRO. A customer's own BOL number prints as a reference, not here. */
  bolNumber: string
  /** ISO day of generation. */
  date: string
  customer: { name: string; billTo: string | null; poRef: string | null }
  shipper: BolParty
  consignee: BolParty
  /** MASTER only; empty on a delivery-scoped BOL. */
  stops: BolStopRow[]
  /** Order-level references, PO first, de-duplicated. */
  references: BolReference[]
  /** Active carriers; empty until somebody is assigned (a BOL can print before that). */
  carriers: BolCarrier[]
  lines: BolLine[]
  /** Set when the lines are the whole shipment rather than this stop's share. */
  linesNote: string | null
  totals: { pieces: number | null; weightLbs: number | null }
  declaredValue: string | null
  chips: string[]
  bolNotes: string | null
  specialInstructions: string | null
  terms: string
  /** Fixed Spanish receipt line, only for the `EN_ES` language option. */
  receiptLineEs: string | null
  rates?: BolRates
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

/** Pending Ryne's approval of the wording (AU-plan D13); a constant, never machine-translated. */
export const BOL_RECEIPT_LINE_ES =
  'Recibido en buen estado aparente, salvo lo indicado. El contenido y la condición del contenido '
  + 'de los bultos se desconocen.'

/** The form's pinned main freight line (`frt-main`); its unit is the form default, not a choice. */
const MAIN_FREIGHT_ID = 'frt-main'

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function cityState(address: Address | null | undefined, fallback?: string | null): string {
  const line = [address?.city, address?.state].filter(Boolean).join(' ')
  return line || (fallback ?? '')
}

function customerVisible(reference: OrderReference): boolean {
  return reference.visibility === 'CUSTOMER' || reference.visibility === 'ALL'
}

function referenceLabel(reference: OrderReference): string {
  const code = reference.code.toUpperCase()
  if (code === 'PO') return 'Customer ref (PO)'
  if (code === 'BOL') return 'Customer BOL #'
  return reference.label || reference.code
}

function toBolReference(reference: OrderReference): BolReference {
  return { label: referenceLabel(reference), value: reference.value }
}

function dedupeReferences(refs: BolReference[]): BolReference[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.label}\u0000${ref.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function billToName(customer: CustomerRecord | null, orders: OrderRecord[]): string | null {
  const parties = customer?.billToParties ?? []
  if (parties.length === 0) return null
  const billToId = orders.find((order) => order.billToId)?.billToId ?? null
  const named = billToId ? parties.find((party) => party.id === billToId) : null
  const party = named ?? parties.find((p) => p.isDefault) ?? null
  return party ? party.name : null
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

interface FlatStop {
  load: ShipmentLoad
  stop: Stop
  /** Position across the whole route, 1-based. */
  seq: number
}

function routeOf(bundle: ShipmentBundle): FlatStop[] {
  const loads = [...bundle.loads].sort((a, b) => (a.leg ?? 0) - (b.leg ?? 0))
  const flat: FlatStop[] = []
  for (const load of loads) {
    for (const stop of [...(load.stops ?? [])].sort((a, b) => a.sequence - b.sequence)) {
      flat.push({ load, stop, seq: flat.length + 1 })
    }
  }
  return flat
}

const stopLabel = (stop: Stop): string =>
  [text(stop.name), cityState(stop.address, stop.city)].filter(Boolean).join(', ')

// ── Scope ────────────────────────────────────────────────────────────────────

/** The scopes the dialog offers. One delivery means only the master BOL exists. */
export function bolScopeOptions(bundle: ShipmentBundle): { scope: BolScope; label: string }[] {
  const route = routeOf(bundle)
  const deliveries = route.filter((s) => s.stop.type === 'delivery')
  const options: { scope: BolScope; label: string }[] = [
    { scope: { kind: 'MASTER' }, label: route.length > 0 ? `Master BOL (all ${route.length} stops)` : 'Master BOL' },
  ]
  if (deliveries.length < 2) return options
  deliveries.forEach(({ stop }, i) => {
    options.push({
      scope: { kind: 'STOP', stopId: stop.id, n: i + 1 },
      label: `Delivery ${i + 1} of ${deliveries.length}: ${stopLabel(stop)}`,
    })
  })
  return options
}

/** The versioning slot a BOL of this scope lives in (see `nextVersion`/`supersede`). */
export function bolSlot(
  scope: BolScope,
  includeRates: boolean,
): { stopId: string | null; loadCarrierId: string | null; rated: boolean } {
  return {
    stopId: scope.kind === 'STOP' ? scope.stopId : null,
    loadCarrierId: scope.kind === 'CARRIER' ? scope.loadCarrierId : null,
    rated: includeRates,
  }
}

/** The `referenceSuffix` of a BOL: `d2`, `rated`, `d2-rated`, or '' for the plain master. */
export function bolReferenceSuffix(scope: BolScope, rated: boolean): string {
  const part = scope.kind === 'STOP'
    ? (scope.n != null ? `d${scope.n}` : `s${scope.stopId.replace(/[^A-Za-z0-9]/g, '').slice(-6)}`)
    : scope.kind === 'CARRIER'
      ? `c${scope.loadCarrierId.replace(/[^A-Za-z0-9]/g, '').slice(-6)}`
      : ''
  return [part, rated ? 'rated' : ''].filter(Boolean).join('-')
}

/** `bol-14913-v1.pdf`, `bol-14913-d2-v1.pdf`, `bol-14913-rated-v1.pdf`. */
export function bolFilename(pro: string, version: number, scope: BolScope, rated: boolean): string {
  const suffix = bolReferenceSuffix(scope, rated)
  return generatedFilename('BOL', suffix ? `${pro}-${suffix}` : pro, version)
}

// ── Chips ────────────────────────────────────────────────────────────────────

/**
 * The requirement chips, allow-listed and in print order. Never printed: No broker,
 * Hot, TONU, OSD, notes, roles — those are the office's, not the dock's.
 */
export function bolChips(order: Pick<OrderRecord, 'specialRequirements'> | null | undefined): string[] {
  const sr = order?.specialRequirements
  if (!sr) return []
  const chips: string[] = []
  if (sr.hazmat) chips.push('Hazmat')
  if (sr.team) chips.push('Team')
  if (sr.tarps) chips.push(text(sr.form?.ship?.tarpSize) ? `Tarps ${text(sr.form?.ship?.tarpSize)}` : 'Tarps')
  if (sr.straps) chips.push('Straps/Chains')
  if (sr.liftgate) chips.push('Liftgate')
  if (sr.inside) chips.push('Inside delivery')
  if (sr.tempControl || sr.tempF) {
    const formTemp = sr.form?.ship?.temp
    const min = formTemp?.min ?? sr.tempF?.min
    const max = formTemp?.max ?? sr.tempF?.max
    const unit = formTemp?.unit ?? 'F'
    chips.push(min != null && max != null ? `Temp control ${min}–${max}°${unit}` : 'Temp control')
  }
  if (sr.palletExchange) {
    const counts = [
      sr.palletsIn != null ? `in ${sr.palletsIn}` : '',
      sr.palletsOut != null ? `out ${sr.palletsOut}` : '',
    ].filter(Boolean).join(' / ')
    chips.push(counts ? `Pallet exchange ${counts}` : 'Pallet exchange')
  }
  if (sr.permit) chips.push('Permits')
  if (sr.fsma) chips.push('FSMA')
  if (sr.oversize) chips.push('Oversize')
  if (sr.escort) chips.push('Escorts')
  if (sr.sealRequired) chips.push('Seal required')
  if (sr.blind) chips.push('Blind')
  if (text(sr.customsBond)) chips.push('Customs bonded')
  if (sr.labor) chips.push('Labor')
  if (sr.highRisk) chips.push('High risk')
  if (sr.massRelease) chips.push('Mass release')
  return chips
}

// ── Freight ──────────────────────────────────────────────────────────────────

function hazmatText(item: FreightItem): string | null {
  return item.hazmat ? `UN${item.hazmat.un} · ${item.hazmat.hazClass}` : null
}

function freightLines(bundle: ShipmentBundle): BolLine[] {
  const loads = [...bundle.loads].sort((a, b) => (a.leg ?? 0) - (b.leg ?? 0))
  const pieceLoad = loads.find((l) => l.pieces != null) ?? null
  const items = bundle.orders.flatMap((order) => order.freight ?? [])
  if (items.length > 0) {
    return items.map((item) => ({
      qty: item.qty,
      // The form defaults `handlingUnit` to PALLET whatever was typed; the load's own unit wins there.
      unit: item.id === MAIN_FREIGHT_ID && item.handlingUnit === 'PALLET' && text(pieceLoad?.piecesUnit)
        ? text(pieceLoad?.piecesUnit) as string
        : item.handlingUnit,
      description: text(item.description) ?? '',
      weightLbs: item.weightLbs ?? null,
      freightClass: text(item.freightClass),
      nmfc: text(item.nmfc),
      hazmat: hazmatText(item),
    }))
  }
  // Legacy or imported: nothing itemised, so one line from the load and the form's fields.
  const described = loads.find((l) => text(l.commodity) ?? text(l.freightDescription))
  const weighted = loads.find((l) => l.weight != null)
  const hazmat = bundle.orders.some((order) => order.specialRequirements?.hazmat)
  const freightClass = bundle.orders
    .map((order) => text(order.specialRequirements?.form?.ship?.freightClass))
    .find(Boolean) ?? null
  return [{
    qty: pieceLoad?.pieces ?? null,
    unit: text(pieceLoad?.piecesUnit) ?? '',
    description: text(described?.commodity) ?? text(described?.freightDescription) ?? 'Freight as tendered',
    weightLbs: weighted?.weight ?? null,
    freightClass,
    nmfc: null,
    hazmat: hazmat ? 'Hazmat — see shipper paperwork' : null,
  }]
}

/** A delivery's own pieces/weight as one line; the other lines cannot be split honestly. */
function stopLines(all: BolLine[], stop: Stop): { lines: BolLine[]; note: string | null } {
  if (stop.pieces == null && stop.weightLbs == null) {
    return { lines: all, note: 'Shipment total — see master BOL' }
  }
  const main = all[0]
  return {
    lines: [{
      qty: stop.pieces ?? null,
      unit: main?.unit ?? '',
      description: main?.description || 'Freight as tendered',
      weightLbs: stop.weightLbs ?? null,
      freightClass: main?.freightClass ?? null,
      nmfc: main?.nmfc ?? null,
      hazmat: main?.hazmat ?? null,
    }],
    note: null,
  }
}

function sum(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null)
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null
}

// ── Parties and carriers ─────────────────────────────────────────────────────

function partyOf(
  stop: Stop | null,
  location: LocationRecord | null,
  orderRefs: OrderReference[],
  alsoPickedUp: string[] = [],
): BolParty {
  if (!stop) return { name: '', address: '', contact: null, appt: null, apptEnd: null, apptType: null, refs: [], alsoPickedUp }
  const contactName = text(stop.documentContact?.name) ?? text(stop.contact?.name) ?? text(location?.apptContactName)
  const contactPhone = text(stop.documentContact?.phone) ?? text(stop.contact?.phone) ?? text(location?.apptContactPhone)
  return {
    name: text(stop.name) ?? text(location?.name) ?? '',
    address: stop.address ? addressBlock(stop.address) : addressBlock(location) || text(stop.city) || '',
    contact: [contactName, contactPhone].filter(Boolean).join(' · ') || null,
    appt: text(stop.appt),
    apptEnd: text(stop.apptEnd),
    apptType: text(stop.apptType),
    refs: dedupeReferences(stopRefs(stop, orderRefs)),
    alsoPickedUp,
  }
}

function stopRefs(stop: Stop, orderRefs: OrderReference[]): BolReference[] {
  return [
    ...orderRefs.filter((reference) => reference.stopId === stop.id),
    ...(stop.refs ?? []).filter(customerVisible),
  ].map(toBolReference)
}

function carrierOf(lc: LoadCarrierRecord, bundle: ShipmentBundle): BolCarrier {
  const stops = bundle.loads.find((l) => l.id === lc.loadId)?.stops ?? []
  const covered = lc.legStopIds && lc.legStopIds.length > 0 ? legStopsOf(lc, stops) : []
  return {
    name: lc.carrierName ?? '',
    mc: text(lc.carrierMc),
    driverName: text(lc.driverName),
    driverPhone: text(lc.driverPhone),
    truckNumber: text(lc.truckNumber),
    trailerNumber: text(lc.trailerNumber),
    sealNumber: text(lc.sealNumber),
    covers: covered.length > 0 ? covered.map(stopLabel).join(' · ') : null,
  }
}

// ── The builder ──────────────────────────────────────────────────────────────

/**
 * The bill of lading for one shipment and scope. `locations` fills in what a stop
 * snapshot left out (the facility's appointment contact and, on a legacy stop, its
 * address); `customer`, `division` and the rest may be missing while a shipment is
 * still being built — nothing here throws on absent context.
 *
 * Throws only for a scope that cannot be built: a stop that is not a delivery of this
 * shipment, or the reserved per-carrier scope.
 */
export function buildBolModel(
  bundle: ShipmentBundle,
  customer: CustomerRecord | null,
  division: Division | null,
  locations: readonly LocationRecord[],
  opts: BolBuildOptions,
): BolInput {
  const { scope } = opts
  if (scope.kind === 'CARRIER') throw new Error('A per-carrier bill of lading is not available yet.')

  const route = routeOf(bundle)
  const byLocation = new Map(locations.map((location) => [location.id, location]))
  const locationOf = (stop: Stop | null) => byLocation.get(stop?.locationId ?? '') ?? null
  const pickups = route.filter((s) => s.stop.type === 'pickup')
  const deliveries = route.filter((s) => s.stop.type !== 'pickup')
  const first = pickups[0] ?? null

  let consigneeStop: FlatStop | null
  let deliveryNumber = 0
  if (scope.kind === 'STOP') {
    const index = deliveries.findIndex((s) => s.stop.id === scope.stopId)
    if (index < 0) throw new Error('That stop is not a delivery of this shipment.')
    consigneeStop = deliveries[index]
    deliveryNumber = index + 1
  } else {
    consigneeStop = deliveries[deliveries.length - 1] ?? null
  }

  const orderRefs = bundle.orders.flatMap((order) => order.references ?? []).filter(customerVisible)
  const shipmentLevel = orderRefs.filter((reference) => !reference.stopId)
  const po = shipmentLevel.find((reference) => reference.code.toUpperCase() === 'PO')
  const references = dedupeReferences([
    ...(po ? [po] : []),
    ...shipmentLevel.filter((reference) => reference !== po),
  ].map(toBolReference))

  const allLines = freightLines(bundle)
  const { lines, note } = scope.kind === 'STOP' && consigneeStop
    ? stopLines(allLines, consigneeStop.stop)
    : { lines: allLines, note: null }

  const others = pickups.slice(1).map((p) => stopLabel(p.stop)).filter(Boolean)
  const scopeLabel = scope.kind === 'STOP' && consigneeStop
    ? `Delivery ${deliveryNumber} of ${deliveries.length}: ${stopLabel(consigneeStop.stop)}`
    : `Master — ${route.length} ${route.length === 1 ? 'stop' : 'stops'}`

  const phone = text(division?.phone) ?? text(opts.brokerPhone)
  const model: BolInput = {
    title: `BILL OF LADING — ${scopeLabel}`,
    scope,
    scopeLabel,
    broker: {
      legalName: division?.legalName || division?.name || 'Broker',
      address: addressBlock(division?.physicalAddress ?? division?.remitToAddress),
      phone,
      mc: text(division?.mcNumber),
      dot: text(division?.dotNumber),
      logoKey: text(division?.logoKey),
    },
    shipmentNumber: bundle.shipment.number,
    bolNumber: bundle.shipment.number,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    customer: {
      name: customer?.name ?? bundle.shipment.customerName ?? '',
      billTo: billToName(customer, bundle.orders),
      poRef: text(po?.value),
    },
    shipper: partyOf(first?.stop ?? null, locationOf(first?.stop ?? null), orderRefs, others),
    consignee: partyOf(consigneeStop?.stop ?? null, locationOf(consigneeStop?.stop ?? null), orderRefs),
    stops: scope.kind === 'MASTER'
      ? route.map(({ stop, seq }) => ({
        seq,
        kind: stop.type === 'pickup' ? 'PICKUP' as const : 'DELIVERY' as const,
        name: text(stop.name) ?? text(locationOf(stop)?.name) ?? '',
        cityState: cityState(stop.address, stop.city) || cityState(locationOf(stop)),
        appt: text(stop.appt),
        refs: dedupeReferences(stopRefs(stop, orderRefs)),
      }))
      : [],
    references,
    carriers: bundle.loadCarriers
      .filter((lc) => lc.status === 'ACTIVE')
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((lc) => carrierOf(lc, bundle)),
    lines,
    linesNote: note,
    totals: { pieces: sum(lines.map((l) => l.qty)), weightLbs: sum(lines.map((l) => l.weightLbs)) },
    declaredValue: (() => {
      const cents = bundle.loads.map((l) => l.cargoValueCents).find((c) => c != null && c > 0)
      return cents != null ? money(cents) : null
    })(),
    chips: Array.from(new Set(bundle.orders.flatMap((order) => bolChips(order)))),
    bolNotes: text(bundle.orders.map((order) => order.customerNotes ?? '').filter(Boolean).join('\n')),
    specialInstructions: text(
      bundle.orders.map((order) => order.specialRequirements?.form?.instructions?.special ?? '').filter(Boolean).join('\n'),
    ),
    terms: text(opts.terms) ?? DEFAULT_BOL_TERMS,
    receiptLineEs: opts.language === 'EN_ES' ? BOL_RECEIPT_LINE_ES : null,
  }

  if (opts.includeRates) {
    const charged = bundle.charges.filter((charge) => charge.side === 'CUSTOMER')
    model.rates = {
      lines: charged.map((charge) => ({ label: charge.label || charge.code, amountCents: charge.amountCents })),
      totalCents: charged.reduce((total, charge) => total + charge.amountCents, 0),
    }
  }
  return model
}
