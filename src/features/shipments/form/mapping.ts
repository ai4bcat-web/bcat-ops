/**
 * Form → wire (AH-plan §4, §8). Pure. The reverse direction is `valuesFromBundle` in model.ts;
 * the two are held together by the round-trip tests in mapping.test.ts.
 */
import { fromDateTimeInput } from '@/lib/date'
import { distanceMeters } from '@/lib/tmsDirectory'
import {
  chargeAmount, computeFinancials, isRateCode, type ChargeLineInput, type FinancialTotals,
} from '@/lib/shipmentCharges'
import type {
  BookCarrierInput, CreateShipmentInput, SaveOrderFormInput, UpdateOrderDetailsInput,
} from '@/lib/apiClient'
import type { Stop } from '@/types'
import type {
  AljexFormExtras, ChargeCalc, CustomerRecord, FreightItem, LoadChargeInput, LoadChargeRecord,
  OrderReference, ShipmentBundle, SpecialRequirements, TmsSettings,
} from '@/types/tms'
import {
  CODE_FSC, CODE_LINEHAUL, MAIN_FREIGHT_ID, REF_DELIVERY, REF_PICKUP, REF_PO,
  activeLoadCarrier, centsToDollars, dollarsToCents, parseCount, parseInteger, readExtras,
  type FormRateKind, type FormStop, type ShipmentFormValues,
} from './model'

const blank = (s: string | null | undefined): boolean => !(s ?? '').trim()
const orUndef = (s: string): string | undefined => (s.trim() ? s.trim() : undefined)
const toIso = (local: string): string | undefined => (local ? fromDateTimeInput(local) || undefined : undefined)
const numOrUndef = parseCount

// ── stops ────────────────────────────────────────────────────────────────────

export function firstPickupIndex(stops: readonly FormStop[]): number {
  return stops.findIndex((s) => s.type === 'pickup')
}
export function lastDeliveryIndex(stops: readonly FormStop[]): number {
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i].type === 'delivery') return i
  return -1
}

export interface StopMapOpts {
  /** Batory-style appointment ladder (`requiresApptProofs`): pickup need_request, delivery need_book. */
  ladder?: boolean
}

export function toStop(s: FormStop, index: number, role: 'first-pickup' | 'last-delivery' | 'other', opts: StopMapOpts = {}): Stop {
  const out: Record<string, unknown> = { ...(s.extra ?? {}) }
  const cityLine = [s.city.trim(), s.state.trim()].filter(Boolean).join(', ')
  const hasAddr = [s.address1, s.address2, s.city, s.state, s.zip].some((v) => v.trim())
  const apptIso = toIso(s.appt)
  const readyIso = toIso(s.ready)
  const mustIso = toIso(s.mustDeliver)
  const apptValue = apptIso ?? readyIso ?? (s.type === 'delivery' ? mustIso : undefined) ?? ''
  const contact = { name: orUndef(s.contact), phone: orUndef(s.phone), email: orUndef(s.email), hours: orUndef(s.hours) }
  const hasContact = Object.values(contact).some((v) => v !== undefined)
  out.id = s.id
  out.type = s.type
  out.sequence = index
  if (s.name.trim()) out.name = s.name.trim()
  if (cityLine) out.city = cityLine
  if (s.locationId) out.locationId = s.locationId
  out.address = hasAddr
    ? {
      ...(s.geo ?? {}),
      street: orUndef(s.address1), street2: orUndef(s.address2), city: orUndef(s.city),
      state: orUndef(s.state), zip: orUndef(s.zip), country: orUndef(s.country),
    }
    : null
  out.appt = apptValue
  out.apptType = apptIso ? 'exact' : 'tbd'
  if (readyIso) out.requestedStart = readyIso
  if (mustIso) out.requestedEnd = mustIso
  if (hasContact) out.contact = contact
  if (s.note.trim()) out.instructions = s.note.trim()
  const pieces = numOrUndef(s.pieces)
  const weight = numOrUndef(s.weightLbs)
  if (pieces !== undefined) out.pieces = pieces
  if (weight !== undefined) out.weightLbs = weight
  if (s.arrivedAt) out.arrivedAt = s.arrivedAt
  if (s.departedAt) out.departedAt = s.departedAt
  const refs: OrderReference[] = [...(((s.extra as Partial<Stop> | null)?.refs ?? []) as OrderReference[])]
  if (role === 'other' && s.refNo.trim()) {
    refs.unshift({
      code: s.type === 'pickup' ? 'PICKUP' : 'DELIVERY',
      label: s.type === 'pickup' ? 'Pickup #' : 'Delivery #',
      value: s.refNo.trim(), level: 'STOP', stopId: s.id, visibility: 'INTERNAL',
    })
  }
  if (refs.length > 0) out.refs = refs
  else delete out.refs
  if (opts.ladder) {
    out.apptStatus = s.type === 'pickup' ? 'need_request' : 'need_book'
    if (!apptIso) out.apptType = 'tbd'
  }
  return out as unknown as Stop
}

export function toStops(values: ShipmentFormValues, opts: StopMapOpts = {}): Stop[] {
  const fp = firstPickupIndex(values.stops)
  const ld = lastDeliveryIndex(values.stops)
  return values.stops.map((s, i) => toStop(s, i, i === fp ? 'first-pickup' : i === ld ? 'last-delivery' : 'other', opts))
}

/** Calculate Totals from Picks: sums the pickup stops' Pieces and Weight. */
export function calculateTotalsFromPicks(stops: readonly FormStop[]): { pieces: number | null; weightLbs: number | null; picks: number } {
  let pieces = 0
  let weight = 0
  let picks = 0
  let anyPieces = false
  let anyWeight = false
  for (const s of stops) {
    if (s.type !== 'pickup') continue
    const p = numOrUndef(s.pieces)
    const w = numOrUndef(s.weightLbs)
    if (p === undefined && w === undefined) continue
    picks++
    if (p !== undefined) { pieces += p; anyPieces = true }
    if (w !== undefined) { weight += w; anyWeight = true }
  }
  return { pieces: anyPieces ? pieces : null, weightLbs: anyWeight ? weight : null, picks }
}

/** Great-circle miles x 1.2 between the first pickup and last delivery; null without coordinates. */
export function suggestMiles(stops: readonly FormStop[]): number | null {
  const a = stops[firstPickupIndex(stops)]?.geo
  const b = stops[lastDeliveryIndex(stops)]?.geo
  if (a?.lat == null || a.lng == null || b?.lat == null || b.lng == null) return null
  const meters = distanceMeters({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng })
  return Math.round((meters / 1609.344) * 1.2)
}

// ── references / freight ─────────────────────────────────────────────────────

export function toReferences(values: ShipmentFormValues): OrderReference[] {
  const fp = values.stops[firstPickupIndex(values.stops)]
  const ld = values.stops[lastDeliveryIndex(values.stops)]
  const out: OrderReference[] = []
  if (values.customer.refNo.trim()) out.push({ code: REF_PO, label: 'Ref #', value: values.customer.refNo.trim(), level: 'ORDER', visibility: 'CUSTOMER' })
  if (fp?.refNo.trim()) out.push({ code: REF_PICKUP, label: 'Pickup #', value: fp.refNo.trim(), level: 'ORDER', visibility: 'ALL' })
  if (ld?.refNo.trim()) out.push({ code: REF_DELIVERY, label: 'Delivery #', value: ld.refNo.trim(), level: 'ORDER', visibility: 'ALL' })
  return [...out, ...values.more.references]
}

export function toFreight(values: ShipmentFormValues): FreightItem[] {
  const { ship } = values
  const pieces = numOrUndef(ship.pieces)
  const weight = numOrUndef(ship.weightLbs)
  const hasMain = ship.description.trim() || weight !== undefined || pieces !== undefined || ship.freightClass
  const out: FreightItem[] = []
  if (hasMain) {
    const main: FreightItem = {
      ...(ship.mainItem ?? {}),
      id: MAIN_FREIGHT_ID,
      handlingUnit: ship.mainItem?.handlingUnit ?? 'PALLET',
      qty: pieces || 1,
    }
    if (ship.description.trim()) main.description = ship.description.trim()
    if (weight !== undefined) main.weightLbs = weight
    if (ship.freightClass) main.freightClass = ship.freightClass
    out.push(main)
  }
  return [...out, ...values.more.items.filter((i) => i.id !== MAIN_FREIGHT_ID)]
}

// ── special requirements + extras ────────────────────────────────────────────

const toF = (value: number, unit: 'F' | 'C'): number => (unit === 'C' ? Math.round((value * 9) / 5 + 32) : value)

export function toExtras(values: ShipmentFormValues): AljexFormExtras {
  const { ship, customer, roles, more, rates, carrier } = values
  const x: AljexFormExtras = { v: 1 }
  const shipX: NonNullable<AljexFormExtras['ship']> = {}
  const truck = numOrUndef(ship.truckMiles); if (truck !== undefined) shipX.truckMiles = truck
  const foot = numOrUndef(ship.footage); if (foot !== undefined) shipX.footage = foot
  const bill = numOrUndef(ship.billableWeightLbs); if (bill !== undefined) shipX.billableWeightLbs = bill
  if (ship.disableMileage) shipX.disableMileage = true
  if (ship.freightClass) shipX.freightClass = ship.freightClass
  if (ship.tarps.on && ship.tarps.size.trim()) shipX.tarpSize = ship.tarps.size.trim()
  if (ship.temp.on) {
    const t: NonNullable<typeof shipX.temp> = { unit: ship.temp.unit }
    const min = parseInteger(ship.temp.min); if (min !== undefined) t.min = min
    const max = parseInteger(ship.temp.max); if (max !== undefined) t.max = max
    const pre = parseInteger(ship.temp.preCool); if (pre !== undefined) t.preCool = pre
    shipX.temp = t
  }
  if (Object.keys(shipX).length > 0) x.ship = shipX

  const seen = new Set<string>()
  const emails = customer.emails.map((e) => e.trim().toLowerCase()).filter((e) => e && !seen.has(e) && !!seen.add(e)).slice(0, 6)
  const custX: NonNullable<AljexFormExtras['customer']> = {}
  if (customer.hours.trim()) custX.hours = customer.hours.trim()
  if (emails.length > 0) custX.emails = emails
  if (Object.keys(custX).length > 0) x.customer = custX

  const rolesX: NonNullable<AljexFormExtras['roles']> = {}
  if (roles.serviceRepId) rolesX.serviceRepId = roles.serviceRepId
  if (roles.tariff.trim()) rolesX.tariff = roles.tariff.trim()
  if (Object.keys(rolesX).length > 0) x.roles = rolesX

  const instr: NonNullable<AljexFormExtras['instructions']> = {}
  if (more.specialInstructions.trim()) instr.special = more.specialInstructions
  if (more.rateConNotes.trim()) instr.rateCon = more.rateConNotes
  if (Object.keys(instr).length > 0) x.instructions = instr

  const rx: NonNullable<AljexFormExtras['rates']> = {}
  if (rates.customer.rateType === 'PER_HOUR') {
    rx.customerRateType = 'PER_HOUR'
    const h = parseHours(rates.customer.hours); if (h !== undefined) rx.customerHours = h
  }
  const smr = dollarsToCents(rates.smr); if (smr !== undefined) rx.smrCents = smr
  const max = dollarsToCents(rates.carrier.maxRate); if (max !== undefined) rx.maxRateCents = max
  if (!carrier.loadCarrierId) {
    const lh = dollarsToCents(rates.carrier.lhRate)
    const pct = rates.carrier.payPct.trim() ? Number(rates.carrier.payPct) : undefined
    const hours = parseHours(rates.carrier.hours)
    if (lh !== undefined || (pct !== undefined && Number.isFinite(pct))) {
      const d: NonNullable<typeof rx.carrierDraft> = { rateType: rates.carrier.rateType }
      if (hours !== undefined) d.hours = hours
      if (lh !== undefined) d.lhRateCents = lh
      if (pct !== undefined && Number.isFinite(pct)) d.payPct = pct
      rx.carrierDraft = d
    }
  }
  if (Object.keys(rx).length > 0) x.rates = rx

  const cx: NonNullable<AljexFormExtras['carrier']> = {}
  if (carrier.loadCarrierId) cx.loadCarrierId = carrier.loadCarrierId
  if (carrier.originCity.trim()) cx.originCity = carrier.originCity.trim()
  if (carrier.originState.trim()) cx.originState = carrier.originState.trim()
  const empty = numOrUndef(carrier.emptyMiles); if (empty !== undefined) cx.emptyMiles = empty
  if (carrier.driver1.email.trim()) cx.driverEmail1 = carrier.driver1.email.trim()
  if (carrier.driver2.email.trim()) cx.driverEmail2 = carrier.driver2.email.trim()
  if (Object.keys(cx).length > 0) x.carrier = cx
  return x
}

function parseHours(text: string): number | undefined {
  const t = text.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * The `specialRequirements` PATCH the form sends. Every key the form owns is present
 * (`null` clears), every other stored key (`other`, anything imported later) is absent so the
 * server's patch-merge keeps it.
 */
export function toSpecialRequirements(values: ShipmentFormValues, prior?: SpecialRequirements | null): SpecialRequirements {
  const { ship } = values
  const f = ship.flags
  const on = (b: boolean): true | null => (b ? true : null)
  let tempF: SpecialRequirements['tempF'] = null
  if (ship.temp.on) {
    const min = parseInteger(ship.temp.min)
    const max = parseInteger(ship.temp.max)
    if (min !== undefined || max !== undefined) {
      const lo = toF(min ?? max as number, ship.temp.unit)
      const hi = toF(max ?? min as number, ship.temp.unit)
      tempF = { target: Math.round((lo + hi) / 2), min: lo, max: hi }
    }
  }
  const pallets = ship.palletExchange.on
  const bond = (prior?.customsBond ?? '').trim()
  return {
    team: on(f.team), tarps: on(ship.tarps.on), straps: on(f.strapsChains),
    liftgate: ship.liftgate, inside: ship.inside, hazmat: on(f.hazmat),
    tempControl: on(ship.temp.on), tempF,
    escort: on(f.escorts), oversize: on(f.oversized), permit: on(f.permits), blind: on(f.blind),
    sealRequired: on(f.seal), customsBond: f.customsBonded ? (bond || 'Y') : null,
    palletExchange: on(pallets),
    palletsIn: pallets ? numOrUndef(ship.palletExchange.palletsIn) ?? null : null,
    palletsOut: pallets ? numOrUndef(ship.palletExchange.palletsOut) ?? null : null,
    fsma: on(f.fsma), noBroker: on(f.noBroker), labor: on(f.labor), highRisk: on(f.highRisk), massRelease: on(f.massRelease),
    form: toExtras(values),
  }
}

// ── charges ──────────────────────────────────────────────────────────────────

function rateCalc(kind: FormRateKind): ChargeCalc {
  return kind === 'PER_MILE' ? 'PER_MILE' : kind === 'PER_CWT' ? 'PER_CWT' : 'FLAT'
}

export function customerLinehaulLine(values: ShipmentFormValues): LoadChargeInput | null {
  const r = values.rates.customer
  const rate = dollarsToCents(r.lhRate)
  if (rate === undefined) return null
  const hours = r.rateType === 'PER_HOUR' ? parseHours(r.hours) ?? 1 : undefined
  return {
    id: r.lineId || undefined, side: 'CUSTOMER', code: CODE_LINEHAUL, label: 'Linehaul',
    calculatedBy: rateCalc(r.rateType), rateCents: rate,
    count: r.rateType === 'FLAT' ? 1 : hours ?? null, isRate: true, sortOrder: 0,
  }
}

export function fscLine(values: ShipmentFormValues): LoadChargeInput | null {
  const { rates } = values
  const perMile = dollarsToCents(rates.fscPerMile)
  if (perMile !== undefined) {
    return { id: rates.fscLineId || undefined, side: 'CUSTOMER', code: CODE_FSC, label: 'Fuel surcharge', calculatedBy: 'PER_MILE', rateCents: perMile, count: null, isRate: true, sortOrder: 1 }
  }
  const pct = rates.fscPercent.trim() ? Number(rates.fscPercent) : NaN
  if (Number.isFinite(pct) && pct >= 0) {
    return { id: rates.fscLineId || undefined, side: 'CUSTOMER', code: CODE_FSC, label: 'Fuel surcharge', calculatedBy: 'PERCENT', rateCents: Math.round(pct * 100), count: null, isRate: true, sortOrder: 1 }
  }
  return null
}

function ctxOf(values: ShipmentFormValues): { miles: number; weightLbs: number } {
  return { miles: numOrUndef(values.ship.customerMiles) ?? 0, weightLbs: numOrUndef(values.ship.weightLbs) ?? 0 }
}

export function customerTotalLhCents(values: ShipmentFormValues): number {
  const line = customerLinehaulLine(values)
  return line ? chargeAmount(asLine(line), ctxOf(values)) : 0
}

/** Carrier linehaul as a CARRIER charge line (no ids, no loadCarrierId); % of Customer is flattened to the total. */
export function carrierLinehaulLine(values: ShipmentFormValues): LoadChargeInput | null {
  const r = values.rates.carrier
  let line: LoadChargeInput
  if (r.rateType === 'PCT_OF_CUSTOMER') {
    const pct = r.payPct.trim() ? Number(r.payPct) : NaN
    if (!Number.isFinite(pct) || pct < 0) return null
    line = { side: 'CARRIER', code: CODE_LINEHAUL, label: 'Linehaul', calculatedBy: 'FLAT', rateCents: Math.round((customerTotalLhCents(values) * pct) / 100), count: 1, isRate: true, sortOrder: 0 }
  } else {
    const rate = dollarsToCents(r.lhRate)
    if (rate === undefined) return null
    const hours = r.rateType === 'PER_HOUR' ? parseHours(r.hours) ?? 1 : undefined
    line = {
      side: 'CARRIER', code: CODE_LINEHAUL, label: 'Linehaul', calculatedBy: rateCalc(r.rateType), rateCents: rate,
      count: r.rateType === 'FLAT' ? 1 : hours ?? null, isRate: true, sortOrder: 0,
    }
  }
  if (r.lineId) line.id = r.lineId
  return line
}

function asLine(l: LoadChargeInput): ChargeLineInput {
  return { side: l.side, code: l.code, calculatedBy: l.calculatedBy, rateCents: l.rateCents, count: l.count, isRate: l.isRate }
}

export function passthroughInput(c: LoadChargeRecord): LoadChargeInput {
  return {
    id: c.id, side: c.side, orderId: c.orderId ?? null, loadId: c.loadId ?? null, loadCarrierId: c.loadCarrierId ?? null,
    code: c.code, label: c.label ?? null, calculatedBy: c.calculatedBy, rateCents: c.rateCents, count: c.count ?? null,
    isRate: c.isRate, release: c.release ?? null, sortOrder: c.sortOrder, note: c.note ?? null,
  }
}

export interface ChargeBuildCtx {
  orderId: string | null
  loadId: string | null
  /** The ACTIVE assignment. Carrier lines are emitted only when this is set (F7), unless `includeCarrier`. */
  activeLoadCarrierId?: string | null
  /** Preview only: price the carrier lines even before Cover. Never send this output. */
  includeCarrier?: boolean
}

/** Every charge row the form would write (customer + passthrough, carrier only after Cover). */
export function toCharges(values: ShipmentFormValues, ctx: ChargeBuildCtx): LoadChargeInput[] {
  const out: LoadChargeInput[] = []
  const carrierId = ctx.activeLoadCarrierId ?? null
  const withCarrier = Boolean(carrierId) || Boolean(ctx.includeCarrier)
  const cust = (l: LoadChargeInput): LoadChargeInput => ({ ...l, orderId: ctx.orderId, loadId: ctx.loadId })
  const car = (l: LoadChargeInput): LoadChargeInput => ({ ...l, orderId: null, loadId: ctx.loadId, loadCarrierId: carrierId })
  const lh = customerLinehaulLine(values); if (lh) out.push(cust(lh))
  const fsc = fscLine(values); if (fsc) out.push(cust(fsc))
  values.rates.lines.forEach((row, i) => {
    const code = row.code.trim()
    if (!code) return
    const base = { code, label: row.label.trim() || null, calculatedBy: 'FLAT' as const, count: 1, isRate: isRateCode(code), release: row.release.trim() || null, note: row.note.trim() || null, sortOrder: 10 + i }
    const c = dollarsToCents(row.customerAmount)
    if (c !== undefined) out.push(cust({ ...base, id: row.id || undefined, side: 'CUSTOMER', rateCents: c }))
    const k = dollarsToCents(row.carrierAmount)
    if (withCarrier && k !== undefined) out.push(car({ ...base, id: row.carrierLineId || undefined, side: 'CARRIER', rateCents: k }))
  })
  if (withCarrier) {
    const clh = carrierLinehaulLine(values)
    if (clh) out.push(car(clh))
  }
  for (const p of values.rates.passthrough) out.push(passthroughInput(p))
  return out
}

export interface FinancialPreview {
  customerTotalLhCents: number
  carrierTotalLhCents: number
  customerTotalCents: number
  carrierTotalCents: number
  netCents: number
  /** Percent with one decimal. */
  profitPct: number
  totals: FinancialTotals
}

/** Same function the shipment detail and the server price with; SMR is excluded (D7). */
export function financialPreview(
  values: ShipmentFormValues, customer: CustomerRecord | null, settings: TmsSettings | null,
): FinancialPreview {
  const lines = toCharges(values, { orderId: null, loadId: null, includeCarrier: true })
  const ctx = ctxOf(values)
  const totals = computeFinancials(lines.map(asLine), ctx, customer?.pricingDefaults ?? null, settings?.marginFloorBps ?? null)
  const carrierLH = carrierLinehaulLine(values)
  return {
    customerTotalLhCents: customerTotalLhCents(values),
    carrierTotalLhCents: carrierLH ? chargeAmount(asLine(carrierLH), ctx) : 0,
    customerTotalCents: totals.revenueCents,
    carrierTotalCents: totals.costCents,
    netCents: totals.profitCents,
    profitPct: Math.round(totals.marginBps / 10) / 10,
    totals,
  }
}

/**
 * After CREATE_SHIPMENT: adopt the server's charge ids and keep every line it seeded
 * (customer default charges) instead of letting the replace-all of SAVE_ORDER_FORM drop them.
 */
export function rebaseCharges(values: ShipmentFormValues, bundle: ShipmentBundle): ShipmentFormValues {
  const server = bundle.charges.filter((c) => c.side === 'CUSTOMER')
  const claimed = new Set<string>()
  const claim = (pred: (c: LoadChargeRecord) => boolean): LoadChargeRecord | undefined => {
    const hit = server.find((c) => !claimed.has(c.id) && pred(c))
    if (hit) claimed.add(hit.id)
    return hit
  }
  const lines = values.rates.lines.map((l) => {
    if (l.id) { claimed.add(l.id); return l }
    const hit = claim((c) => c.code === l.code && c.calculatedBy === 'FLAT' && (c.count ?? 1) === 1)
    return hit ? { ...l, id: hit.id } : l
  })
  const passthrough = [...values.rates.passthrough]
  const known = new Set(passthrough.map((p) => p.id))
  for (const c of server) {
    if (claimed.has(c.id) || known.has(c.id)) continue
    if (c.code === CODE_LINEHAUL || c.code === CODE_FSC) {
      if (c.code === CODE_LINEHAUL && !values.rates.customer.lineId) values = { ...values, rates: { ...values.rates, customer: { ...values.rates.customer, lineId: c.id } } }
      if (c.code === CODE_FSC && !values.rates.fscLineId) values = { ...values, rates: { ...values.rates, fscLineId: c.id } }
      continue
    }
    if (c.calculatedBy === 'FLAT' && (c.count ?? 1) === 1 && !['QUICKPAY_FEE', 'ADVANCE_FEE'].includes(c.code)) {
      lines.push({ id: c.id, carrierLineId: '', release: c.release ?? '', carrierKey: '', code: c.code, label: c.label ?? '', carrierAmount: '', customerAmount: centsToDollars(c.amountCents), note: c.note ?? '' })
    } else passthrough.push(c)
  }
  return { ...values, rates: { ...values.rates, lines, passthrough } }
}

// ── wire inputs ──────────────────────────────────────────────────────────────

type LoadFieldsWire = NonNullable<SaveOrderFormInput['loadFields']>

export function toLoadFields(values: ShipmentFormValues): LoadFieldsWire {
  const { ship } = values
  const pieces = numOrUndef(ship.pieces)
  const wire = {
    miles: numOrUndef(ship.customerMiles) ?? null,
    weight: numOrUndef(ship.weightLbs) ?? null,
    commodity: ship.description.trim() || null,
    pieces: pieces ?? null,
    piecesUnit: pieces !== undefined ? 'pieces' : null,
    cargoValueCents: dollarsToCents(ship.declaredValue) ?? null,
    hot: ship.flags.hot,
  }
  return wire as unknown as LoadFieldsWire
}

export function toCreateInput(values: ShipmentFormValues, opts: StopMapOpts = {}): CreateShipmentInput {
  const stops = toStops(values, opts)
  const fp = values.stops[firstPickupIndex(values.stops)]
  const { ship } = values
  const pieces = numOrUndef(ship.pieces)
  const bag: NonNullable<CreateShipmentInput['load']> = { stops }
  if (values.customer.refNo.trim()) bag.tmsId = values.customer.refNo.trim()
  if (fp?.refNo.trim()) bag.pickupNumber = fp.refNo.trim()
  if (ship.equipmentType.trim()) bag.equipmentType = ship.equipmentType.trim()
  if (ship.description.trim()) bag.commodity = ship.description.trim()
  const weight = numOrUndef(ship.weightLbs); if (weight !== undefined) bag.weight = weight
  if (pieces !== undefined) { bag.pieces = pieces; bag.piecesUnit = 'pieces' }
  const cargo = dollarsToCents(ship.declaredValue); if (cargo !== undefined) bag.cargoValueCents = cargo
  const miles = numOrUndef(ship.customerMiles); if (miles !== undefined) bag.miles = miles
  if (ship.flags.hot) bag.hot = true
  const input: CreateShipmentInput = { mode: values.mode, source: 'MANUAL', load: bag }
  if (values.customer.useTyped || !values.customer.id) input.customerName = values.customer.typedName.trim()
  else input.customerId = values.customer.id
  if (values.pro.trim()) input.pro = values.pro.trim()
  return input
}

export interface SaveMapOpts extends StopMapOpts { draftSave: boolean }

function orderPatch(values: ShipmentFormValues, bundle: ShipmentBundle, includeMode: boolean) {
  const order = bundle.orders[0]
  const patch: Record<string, unknown> = {
    customerContactId: values.customer.contactId || null,
    billToId: values.customer.billToId || null,
    references: toReferences(values),
    equipmentType: values.ship.equipmentType.trim() || null,
    specialRequirements: toSpecialRequirements(values, order?.specialRequirements),
    freight: toFreight(values),
    customerNotes: values.more.bolNotes || null,
    internalNotes: values.more.notes || null,
  }
  if (includeMode) patch.mode = values.mode
  const quote = values.roles.quoteId || null
  if ((order?.quoteId ?? null) !== quote) patch.quoteId = quote
  return patch
}

export function toSaveOrderFormInput(values: ShipmentFormValues, bundle: ShipmentBundle, opts: SaveMapOpts): SaveOrderFormInput {
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  const active = activeLoadCarrier(bundle)
  const input: SaveOrderFormInput = {
    shipmentId: bundle.shipment.id,
    expectedUpdatedAt: bundle.shipment.updatedAt,
    order: orderPatch(values, bundle, true) as SaveOrderFormInput['order'],
    stops: toStops(values, opts),
    charges: toCharges(values, { orderId: order?.id ?? null, loadId: load?.id ?? null, activeLoadCarrierId: active?.id }),
    loadFields: toLoadFields(values),
    shipmentFlags: { osd: values.ship.flags.osd },
  }
  if (opts.draftSave) input.draftSave = true
  return input
}

export function toUpdateOrderDetailsInput(values: ShipmentFormValues, bundle: ShipmentBundle): UpdateOrderDetailsInput {
  const order = orderPatch(values, bundle, false) as NonNullable<UpdateOrderDetailsInput['order']>
  const invoiced = Boolean(bundle.orders[0]?.invoiceId)
  if (invoiced) {
    for (const k of ['references', 'equipmentType', 'freight', 'billToId', 'customerContactId', 'quoteId'] as const) delete order[k]
  }
  return {
    shipmentId: bundle.shipment.id,
    expectedUpdatedAt: bundle.shipment.updatedAt,
    order,
    loadFields: toLoadFields(values) as UpdateOrderDetailsInput['loadFields'],
    shipmentFlags: { osd: values.ship.flags.osd },
  }
}

/** What Cover pre-fills BookCarrierDialog with (and what BOOK_CARRIER receives). Carrier money lives here until booked. */
export interface BookCarrierDraft extends Pick<BookCarrierInput,
  'carrierId' | 'carrierRateCents' | 'charges' | 'dispatcherName' | 'dispatcherPhone' | 'dispatcherEmail' | 'driverName'
  | 'driverPhone' | 'driver2Name' | 'driver2Phone' | 'truckNumber' | 'trailerNumber'> {
  carrierName: string
  maxRateCents: number | null
}
export function toBookCarrierDraft(values: ShipmentFormValues): BookCarrierDraft {
  const c = values.carrier
  const lh = carrierLinehaulLine(values)
  const ctx = ctxOf(values)
  const extra: LoadChargeInput[] = []
  values.rates.lines.forEach((row, i) => {
    const k = dollarsToCents(row.carrierAmount)
    if (!row.code.trim() || k === undefined) return
    extra.push({
      side: 'CARRIER', code: row.code.trim(), label: row.label.trim() || null, calculatedBy: 'FLAT', rateCents: k, count: 1,
      isRate: isRateCode(row.code), release: row.release.trim() || null, note: row.note.trim() || null, sortOrder: 10 + i,
    })
  })
  return {
    carrierId: c.carrierId,
    carrierName: c.typedName,
    carrierRateCents: lh ? chargeAmount(asLine(lh), ctx) : 0,
    charges: extra,
    dispatcherName: orUndef(c.dispatcher.name) ?? null,
    dispatcherPhone: orUndef(c.dispatcher.phone) ?? null,
    dispatcherEmail: orUndef(c.dispatcher.email) ?? null,
    driverName: orUndef(c.driver1.name) ?? null,
    driverPhone: orUndef(c.driver1.phone) ?? null,
    driver2Name: orUndef(c.driver2.name) ?? null,
    driver2Phone: orUndef(c.driver2.phone) ?? null,
    truckNumber: orUndef(c.truckNo) ?? null,
    trailerNumber: orUndef(c.trailerNo) ?? null,
    maxRateCents: dollarsToCents(values.rates.carrier.maxRate) ?? null,
  }
}

export { blank, readExtras }
