/**
 * The form's field model and the bundle → form direction (AH-plan §3.3, §4, §8.4).
 *
 * `ShipmentFormValues` is one plain object; every numeric/money input is a string (empty ≠ 0),
 * money inputs are dollars. `mapping.ts` goes the other way (form → wire). Everything here is
 * pure and synchronous.
 */
import { defaultBillToIdOf, customerDefaultsOf } from '@/lib/intakeLoad'
import { formatDateTimeInput } from '@/lib/date'
import type { Stop } from '@/types'
import type {
  AljexCustomerRateKind, AljexFormExtras, ChargeCalc, CustomerRecord, FreightItem, LoadCarrierRecord,
  LoadChargeRecord, OrderRecord, OrderReference, ShipmentBundle, ShipmentDocumentType, ShipmentMode,
  ShipmentStatus, SpecialRequirements,
} from '@/types/tms'
import type { CheckCallDraft } from './sectionProps'

export type TriState = boolean | null

/** Aljex's Shipping Requirements flag grid, in `FLAG_COLUMNS` order. */
export type FlagKey =
  | 'permits' | 'fsma' | 'oversized' | 'hazmat' | 'escorts' | 'seal' | 'blind' | 'customsBonded' | 'osd'
  | 'strapsChains' | 'noBroker' | 'team' | 'hot' | 'labor' | 'highRisk' | 'massRelease' | 'tonu'

export const FLAG_KEYS: readonly FlagKey[] = [
  'permits', 'fsma', 'oversized', 'hazmat', 'escorts', 'seal', 'blind', 'customsBonded', 'osd',
  'strapsChains', 'noBroker', 'team', 'hot', 'labor', 'highRisk', 'massRelease', 'tonu',
] as const

export type FormMode = ShipmentMode
export type FormRateKind = AljexCustomerRateKind
export type CarrierRateKind = FormRateKind | 'PCT_OF_CUSTOMER'

/** The managed order-reference codes: Customer Ref #, Pick Up Ref #, Consignee Ref #. */
export const REF_PO = 'PO'
export const REF_PICKUP = 'pickup'
export const REF_DELIVERY = 'delivery'
export const MAIN_FREIGHT_ID = 'frt-main'
/** Charge codes the form owns as the Rate rows. */
export const CODE_LINEHAUL = 'LINEHAUL'
export const CODE_FSC = 'FSC'
/** Codes the accessorial editor must never rewrite (money written by other flows). */
export const RESERVED_CHARGE_CODES: readonly string[] = ['QUICKPAY_FEE', 'ADVANCE_FEE']

export interface FormStop {
  /** `stp-<uuid>`, client-assigned and kept, so the edit diff is by id. */
  id: string
  type: 'pickup' | 'delivery'
  name: string
  locationId: string
  address1: string
  address2: string
  city: string
  state: string
  zip: string
  country: string
  contact: string
  phone: string
  hours: string
  email: string
  refNo: string
  /** `YYYY-MM-DDTHH:mm` (Chicago), the datetime-local value. */
  ready: string
  appt: string
  mustDeliver: string
  note: string
  pieces: string
  weightLbs: string
  /** Read-only stamps once the truck has been here. */
  arrivedAt: string
  departedAt: string
  /** lat/lng/timezone of the booked address; never typed, kept so the snapshot survives a save. */
  geo: { lat?: number | null; lng?: number | null; timezone?: string | null; geocodeExpiresAt?: string | null } | null
  /** Stop keys the form does not own (driverId, apptStatus, documentContact…), kept verbatim. Null when none. */
  extra: Partial<Stop> | null
}

export interface ContactBits { name: string; phone: string; email: string }

export interface RateRow<K extends string = FormRateKind> {
  rateType: K
  hours: string
  /** Dollars. */
  lhRate: string
  /** The LoadCharge id this row edits ('' = none yet). */
  lineId: string
}

/** One accessorial row = up to two LoadCharge rows (CUSTOMER `$Customer`, CARRIER `$Carrier`). */
export interface AccessorialLine {
  /** Customer-side LoadCharge id ('' when none). */
  id: string
  carrierLineId: string
  release: string
  /** The active carrier's name, or blank. Display only. */
  carrierKey: string
  code: string
  label: string
  /** Dollars. */
  carrierAmount: string
  customerAmount: string
  note: string
}

export interface QueuedFile { file: File; audience: 'ALL' | 'INTERNAL'; type: ShipmentDocumentType }

export interface ShipmentFormValues {
  mode: FormMode
  /** Create only; blank = derived `<shipmentNumber>-1`. */
  pro: string
  ship: {
    equipmentType: string
    revDivision: string
    revSubdivision: string
    /** Derived, read-only. */
    officeLabel: string
    customerMiles: string
    truckMiles: string
    footage: string
    pieces: string
    weightLbs: string
    billableWeightLbs: string
    disableMileage: boolean
    freightClass: string
    description: string
    declaredValue: string
    liftgate: TriState
    inside: TriState
    temp: { on: boolean; unit: 'F' | 'C'; min: string; max: string; preCool: string }
    palletExchange: { on: boolean; palletsIn: string; palletsOut: string }
    tarps: { on: boolean; size: string }
    flags: Record<FlagKey, boolean>
    /** The stored `frt-main` line when it carries more than the form edits (unit, dims, NMFC…). */
    mainItem: FreightItem | null
  }
  customer: {
    id: string
    typedName: string
    useTyped: boolean
    billToId: string
    contactId: string
    hours: string
    /** Exactly 6 slots. */
    emails: string[]
    refNo: string
  }
  /** [0] = Pick Up, [last] = Consignee, in between = Insert Pick / Insert Stop. */
  stops: FormStop[]
  roles: { salesRepId: string; serviceRepId: string; dispatcherAssignedId: string; tariff: string; quoteId: string }
  more: {
    specialInstructions: string
    bolNotes: string
    rateConNotes: string
    notes: string
    /** Every reference except the three the sections own (PO, pickup, delivery). */
    references: OrderReference[]
    /** Freight lines after the pinned `frt-main`. */
    items: FreightItem[]
  }
  rates: {
    customer: RateRow<FormRateKind>
    carrier: RateRow<CarrierRateKind> & { payPct: string; maxRate: string }
    fscPercent: string
    fscPerMile: string
    fscLineId: string
    smr: string
    lines: AccessorialLine[]
    /** Charge rows the form does not represent; re-sent verbatim in every charge write. */
    passthrough: LoadChargeRecord[]
  }
  carrier: {
    /** The ACTIVE LoadCarrier this block shows ('' before Cover). */
    loadCarrierId: string
    carrierId: string
    typedName: string
    useTyped: boolean
    isOwnFleet: boolean
    dispatcher: ContactBits
    driver1: ContactBits
    driver2: ContactBits
    truckNo: string
    trailerNo: string
    seal: string
    carrierRef: string
    originCity: string
    originState: string
    emptyMiles: string
    puEta: string
  }
  checkCall: CheckCallDraft
  docs: { queued: QueuedFile[] }
}

// ── small parsers shared by mapping/validation ───────────────────────────────

/** `'12'` → 12; blank/invalid/negative → undefined. */
export function parseCount(text: string | null | undefined): number | undefined {
  const t = (text ?? '').trim()
  if (!t) return undefined
  const n = Number(t.replace(/,/g, ''))
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}
/** Signed integer (temperatures). */
export function parseInteger(text: string | null | undefined): number | undefined {
  const t = (text ?? '').trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n) : undefined
}
/** `'1,234.56'` → 123456; blank/invalid/negative → undefined. */
export function dollarsToCents(text: string | null | undefined): number | undefined {
  const t = (text ?? '').replace(/[$,\s]/g, '')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined
}
/** 123456 → `'1234.56'`; 120000 → `'1200'`; null → `''`. */
export function centsToDollars(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return ''
  const d = (cents / 100).toFixed(2)
  return d.endsWith('.00') ? d.slice(0, -3) : d
}
const str = (v: unknown): string => (v == null ? '' : String(v))
const numStr = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '' : String(n))
export function newStopId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return `stp-${c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`
}
const isoToInput = (iso: string | null | undefined): string => (iso ? formatDateTimeInput(iso) : '')

// ── extras accessor: the one seam to specialRequirements.form (AH-plan §4.0) ──

export type ExtrasPatch = { [G in keyof Omit<AljexFormExtras, 'v'>]?: Partial<NonNullable<AljexFormExtras[G]>> | null }

export function readExtras(order: Pick<OrderRecord, 'specialRequirements'> | null | undefined): AljexFormExtras | undefined {
  const f = order?.specialRequirements?.form
  return f && typeof f === 'object' ? f : undefined
}

/**
 * `specialRequirements` with `form` patched: each group is merged key by key, an `undefined`
 * value deletes the key, a `null` group deletes the group. Everything else is left alone.
 */
export function withExtras(
  sr: SpecialRequirements | null | undefined,
  patch: ExtrasPatch,
): SpecialRequirements {
  const prior: AljexFormExtras = { v: 1, ...(sr?.form ?? {}) }
  const next: Record<string, unknown> = { ...prior }
  for (const group of Object.keys(patch) as (keyof ExtrasPatch)[]) {
    const p = patch[group]
    if (p === null) { delete next[group]; continue }
    if (!p) continue
    const merged: Record<string, unknown> = { ...((prior[group] as Record<string, unknown> | undefined) ?? {}) }
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) delete merged[k]
      else merged[k] = v
    }
    if (Object.keys(merged).length === 0) delete next[group]
    else next[group] = merged
  }
  next.v = 1
  return { ...(sr ?? {}), form: next as unknown as AljexFormExtras }
}

// ── lock set (§8.4) ──────────────────────────────────────────────────────────

export type LockKey =
  | 'all' | 'mode' | 'customer' | 'pro' | 'references' | 'items' | 'equipment' | 'billTo' | 'contact' | 'quote'
  | 'rates' | 'customerMiles' | 'weight' | 'carrierRates' | 'carrierPicker' | 'checkCalls' | 'cover'

export interface LockSet {
  /** Why each field group is read-only now (shown as the control's tooltip). */
  fields: Partial<Record<LockKey, string>>
  /** Per stop id: that stop's type / removal / location are read-only (it has been arrived at or departed). */
  stops: Record<string, string>
  voided: boolean
}

export const NO_LOCKS: LockSet = { fields: {}, stops: {}, voided: false }

export function isLocked(locks: LockSet, key: LockKey): boolean {
  return Boolean(locks.fields.all || locks.fields[key])
}
export function lockReason(locks: LockSet, key: LockKey): string | undefined {
  return locks.fields.all ?? locks.fields[key]
}

export function activeLoadCarrier(bundle: ShipmentBundle | null | undefined): LoadCarrierRecord | null {
  return bundle?.loadCarriers.find((lc) => lc.status === 'ACTIVE') ?? null
}

export function lockedFields(bundle: ShipmentBundle | null): LockSet {
  if (!bundle) return NO_LOCKS
  const { shipment } = bundle
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  const fin = bundle.financials.find((f) => f.loadId === load?.id) ?? bundle.financials[0]
  const active = activeLoadCarrier(bundle)
  const fields: LockSet['fields'] = {}
  if (shipment.voidedAt) {
    fields.all = 'This shipment is voided.'
    return { fields, stops: {}, voided: true }
  }
  if (shipment.status !== 'DRAFT') {
    fields.mode = 'Mode is fixed once the order is submitted.'
    fields.customer = 'Change the customer from the shipment page.'
    fields.pro = 'The PRO is permanent.'
  }
  if (order?.invoiceId) {
    const why = 'The invoice snapshot owns this.'
    for (const k of ['references', 'items', 'equipment', 'billTo', 'contact', 'quote'] as const) fields[k] = why
  }
  if (fin?.frozenAt) {
    const why = 'Invoiced: the numbers are frozen.'
    for (const k of ['rates', 'customerMiles', 'weight'] as const) fields[k] = why
  }
  if (active?.chargesFinalizedAt) fields.carrierRates = 'AP recorded a carrier bill; carrier charges are final.'
  if (active) fields.carrierPicker = 'Remove, bounce or TONU the booked carrier first.'
  if (load?.status === 'CANCELED' || shipment.status === 'TENDER_REJECTED') {
    fields.checkCalls = 'This shipment is canceled.'
    fields.cover = 'This shipment is canceled.'
  }
  const stops: Record<string, string> = {}
  for (const s of load?.stops ?? []) {
    if (s.arrivedAt || s.departedAt) stops[s.id] = 'The truck has been here: type, location and removal are fixed.'
  }
  return { fields, stops, voided: false }
}

// ── construction ─────────────────────────────────────────────────────────────

export function emptyStop(type: 'pickup' | 'delivery'): FormStop {
  return {
    id: newStopId(), type, name: '', locationId: '', address1: '', address2: '', city: '', state: '', zip: '',
    country: 'US', contact: '', phone: '', hours: '', email: '', refNo: '', ready: '', appt: '', mustDeliver: '',
    note: '', pieces: '', weightLbs: '', arrivedAt: '', departedAt: '', geo: null, extra: null,
  }
}

export function emptyFlags(): Record<FlagKey, boolean> {
  return Object.fromEntries(FLAG_KEYS.map((k) => [k, false])) as Record<FlagKey, boolean>
}

export function emptyCheckCall(): CheckCallDraft {
  return { city: '', state: '', at: '', temperature: '', note: '', message: '', ediReason: '', nextAt: '', nextNote: '' }
}

const emptyBits = (): ContactBits => ({ name: '', phone: '', email: '' })

export function emptyValues(opts: { mode?: FormMode } = {}): ShipmentFormValues {
  return {
    mode: opts.mode ?? 'FTL',
    pro: '',
    ship: {
      equipmentType: '', revDivision: '', revSubdivision: '', officeLabel: '', customerMiles: '', truckMiles: '',
      footage: '', pieces: '', weightLbs: '', billableWeightLbs: '', disableMileage: false, freightClass: '',
      description: '', declaredValue: '', liftgate: null, inside: null,
      temp: { on: false, unit: 'F', min: '', max: '', preCool: '' },
      palletExchange: { on: false, palletsIn: '', palletsOut: '' },
      tarps: { on: false, size: '' },
      flags: emptyFlags(),
      mainItem: null,
    },
    customer: { id: '', typedName: '', useTyped: false, billToId: '', contactId: '', hours: '', emails: ['', '', '', '', '', ''], refNo: '' },
    stops: [emptyStop('pickup'), emptyStop('delivery')],
    roles: { salesRepId: '', serviceRepId: '', dispatcherAssignedId: '', tariff: '', quoteId: '' },
    more: { specialInstructions: '', bolNotes: '', rateConNotes: '', notes: '', references: [], items: [] },
    rates: {
      customer: { rateType: 'FLAT', hours: '', lhRate: '', lineId: '' },
      carrier: { rateType: 'FLAT', hours: '', lhRate: '', lineId: '', payPct: '', maxRate: '' },
      fscPercent: '', fscPerMile: '', fscLineId: '', smr: '', lines: [], passthrough: [],
    },
    carrier: {
      loadCarrierId: '', carrierId: '', typedName: '', useTyped: false, isOwnFleet: false,
      dispatcher: emptyBits(), driver1: emptyBits(), driver2: emptyBits(),
      truckNo: '', trailerNo: '', seal: '', carrierRef: '', originCity: '', originState: '', emptyMiles: '', puEta: '',
    },
    checkCall: emptyCheckCall(),
    docs: { queued: [] },
  }
}

/** Customer-derived defaults for a freshly picked customer (create mode). Never overwrites what a person typed. */
export function applyCustomerDefaults(values: ShipmentFormValues, customer: CustomerRecord | null): ShipmentFormValues {
  if (!customer) return values
  const defaults = customerDefaultsOf(customer)
  const contacts = (customer.contacts ?? []).filter((c) => c.active)
  const primary = contacts.find((c) => c.types.includes('PRIMARY')) ?? contacts[0]
  const notified = contacts.filter((c) => c.email && c.notifications.length > 0).map((c) => c.email as string)
  const emails = [...values.customer.emails]
  if (emails.every((e) => !e)) {
    const seen = new Set<string>()
    const seed = [primary?.email, ...notified].filter((e): e is string => !!e && !seen.has(e.toLowerCase()) && !!seen.add(e.toLowerCase()))
    seed.slice(0, 6).forEach((e, i) => { emails[i] = e })
  }
  const lines = values.rates.lines.length > 0
    ? values.rates.lines
    : (customer.defaultCharges ?? []).map<AccessorialLine>((c) => ({
      id: '', carrierLineId: '', release: '', carrierKey: '', code: c.code, label: '',
      carrierAmount: '', customerAmount: centsToDollars(c.amountCents * (c.count ?? 1)), note: '',
    }))
  return {
    ...values,
    customer: {
      ...values.customer,
      id: customer.id,
      useTyped: false,
      billToId: values.customer.billToId || defaultBillToIdOf(customer) || '',
      contactId: values.customer.contactId || primary?.id || '',
      emails,
    },
    roles: { ...values.roles, salesRepId: values.roles.salesRepId || defaults.salesRepId || '' },
    ship: { ...values.ship, revDivision: values.ship.revDivision || customer.defaultDivisionKey || '' },
    rates: { ...values.rates, lines },
  }
}

// ── bundle → form ────────────────────────────────────────────────────────────

export interface BundleSeedCtx {
  customer?: CustomerRecord | null
  /** The sales rep's team name(s), as the board shows Office. */
  officeLabel?: string
}

/** Charge lines the form edits as accessorial rows: FLAT × 1, not a reserved code. */
export function isAccessorialShape(c: Pick<LoadChargeRecord, 'calculatedBy' | 'count' | 'code'>): boolean {
  return c.calculatedBy === 'FLAT' && (c.count ?? 1) === 1 && !RESERVED_CHARGE_CODES.includes(c.code)
}

function referenceCode(r: OrderReference): string {
  return r.code.trim().toLowerCase()
}

function stopFromRecord(s: Stop, order: OrderRecord | undefined, role: 'first-pickup' | 'last-delivery' | 'other'): FormStop {
  const { id, type, name, city, locationId, address, appt, apptType, requestedStart, requestedEnd, contact,
    instructions, pieces, weightLbs, arrivedAt, departedAt, refs, sequence: _sequence, ...rest } = s
  void _sequence
  const addr = address ?? {}
  const own = (code: string) => {
    if (role === 'first-pickup') return str(order?.references?.find((r) => referenceCode(r) === REF_PICKUP)?.value)
    if (role === 'last-delivery') return str(order?.references?.find((r) => referenceCode(r) === REF_DELIVERY)?.value)
    return str(refs?.find((r) => r.code.toUpperCase() === code)?.value)
  }
  const apptIso = appt || ''
  const tbd = apptType === 'tbd'
  const mustOnly = !!requestedEnd && requestedEnd === apptIso
  const ready = requestedStart ? isoToInput(requestedStart) : tbd && !mustOnly ? isoToInput(apptIso) : ''
  const extra: Partial<Stop> = { ...rest }
  const otherRefs = (refs ?? []).filter((r) => !(role === 'other' && r.code.toUpperCase() === (type === 'pickup' ? 'PICKUP' : 'DELIVERY')))
  if (otherRefs.length > 0) extra.refs = otherRefs
  if (apptType && apptType !== 'exact' && apptType !== 'tbd') extra.apptType = apptType
  const geo = addr.lat != null || addr.lng != null || addr.timezone || addr.geocodeExpiresAt
    ? { lat: addr.lat ?? null, lng: addr.lng ?? null, timezone: addr.timezone ?? null, geocodeExpiresAt: addr.geocodeExpiresAt ?? null }
    : null
  return {
    id,
    type,
    name: str(name),
    locationId: str(locationId),
    address1: str(addr.street),
    address2: str((addr as { street2?: string | null }).street2),
    city: str(addr.city ?? (city ? city.split(',')[0].trim() : '')),
    state: str(addr.state ?? (city?.includes(',') ? city.split(',')[1].trim() : '')),
    zip: str(addr.zip),
    country: str(addr.country) || 'US',
    contact: str(contact?.name),
    phone: str(contact?.phone),
    hours: str(contact?.hours),
    email: str(contact?.email),
    refNo: own(type === 'pickup' ? 'PICKUP' : 'DELIVERY'),
    ready,
    appt: tbd ? '' : isoToInput(apptIso),
    mustDeliver: isoToInput(requestedEnd),
    note: str(instructions),
    pieces: numStr(pieces),
    weightLbs: numStr(weightLbs),
    arrivedAt: str(arrivedAt),
    departedAt: str(departedAt),
    geo,
    extra: Object.keys(extra).length > 0 ? extra : null,
  }
}

export function valuesFromBundle(bundle: ShipmentBundle, ctx: BundleSeedCtx = {}): ShipmentFormValues {
  const base = emptyValues()
  const { shipment } = bundle
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  const sr: SpecialRequirements = order?.specialRequirements ?? {}
  const x = readExtras(order)
  const active = activeLoadCarrier(bundle)
  const tie = !active || !x?.carrier?.loadCarrierId || x.carrier.loadCarrierId === active.id
  const refs = order?.references ?? []
  const managed = new Set<string>()
  const pick = (code: string): OrderReference | undefined => {
    const r = refs.find((ref) => referenceCode(ref) === code && !managed.has(`${code}`))
    if (r) managed.add(code)
    return r
  }
  const po = pick(REF_PO.toLowerCase())
  const pu = pick(REF_PICKUP)
  const de = pick(REF_DELIVERY)
  const consumed = new Set<OrderReference>([po, pu, de].filter((r): r is OrderReference => !!r))

  const stopsIn = load?.stops ?? []
  let lastDelivery = -1
  stopsIn.forEach((s, i) => { if (s.type === 'delivery') lastDelivery = i })
  const firstPickup = stopsIn.findIndex((s) => s.type === 'pickup')
  const stops = stopsIn.length > 0
    ? [...stopsIn].sort((a, b) => a.sequence - b.sequence).map((s, i, arr) => {
      const fp = arr.findIndex((q) => q.type === 'pickup')
      let ld = -1
      arr.forEach((q, j) => { if (q.type === 'delivery') ld = j })
      return stopFromRecord(s, order, i === fp ? 'first-pickup' : i === ld ? 'last-delivery' : 'other')
    })
    : base.stops
  void firstPickup; void lastDelivery

  const frt = (order?.freight ?? []).find((f) => f.id === MAIN_FREIGHT_ID)
  const frtRest = (order?.freight ?? []).filter((f) => f.id !== MAIN_FREIGHT_ID)
  const mainDefault = frt && frt.handlingUnit === 'PALLET' && !frt.dims && !frt.nmfc && !frt.hazmat && frt.stackable == null && frt.highValue == null
  const temp = x?.ship?.temp
  const tempF = sr.tempF
  const emails = [...(x?.customer?.emails ?? [])].slice(0, 6)
  while (emails.length < 6) emails.push('')

  // ── rates ──
  const charges = bundle.charges
  const custLH = charges.find((c) => c.side === 'CUSTOMER' && c.code === CODE_LINEHAUL && ['FLAT', 'PER_MILE', 'PER_CWT'].includes(c.calculatedBy))
  const custFSC = charges.find((c) => c.side === 'CUSTOMER' && c.code === CODE_FSC && ['PERCENT', 'PER_MILE'].includes(c.calculatedBy))
  const carLH = active
    ? charges.find((c) => c.side === 'CARRIER' && c.code === CODE_LINEHAUL && c.loadCarrierId === active.id && ['FLAT', 'PER_MILE', 'PER_CWT'].includes(c.calculatedBy))
    : undefined
  const perHour = x?.rates?.customerRateType === 'PER_HOUR' && custLH?.calculatedBy === 'FLAT'
  const draft = x?.rates?.carrierDraft
  const used = new Set<string>([custLH?.id, custFSC?.id, carLH?.id].filter((v): v is string => !!v))
  const lines: AccessorialLine[] = []
  const passthrough: LoadChargeRecord[] = []
  const sorted = [...charges].sort((a, b) => a.sortOrder - b.sortOrder)
  for (const c of sorted) {
    if (used.has(c.id)) continue
    const mine = c.side === 'CUSTOMER' || (!!active && c.loadCarrierId === active.id)
    if (!mine || !isAccessorialShape(c) || isRateTarget(c)) { passthrough.push(c); continue }
    if (c.side === 'CARRIER') {
      const host = lines.find((l) => !l.carrierLineId && l.code === c.code && l.release === str(c.release))
      if (host) { host.carrierLineId = c.id; host.carrierAmount = centsToDollars(c.amountCents); continue }
      lines.push({ id: '', carrierLineId: c.id, release: str(c.release), carrierKey: str(active?.carrierName), code: c.code, label: str(c.label), carrierAmount: centsToDollars(c.amountCents), customerAmount: '', note: str(c.note) })
    } else {
      lines.push({ id: c.id, carrierLineId: '', release: str(c.release), carrierKey: '', code: c.code, label: str(c.label), carrierAmount: '', customerAmount: centsToDollars(c.amountCents), note: str(c.note) })
    }
  }

  const rateKind = (c: LoadChargeRecord | undefined): FormRateKind =>
    c?.calculatedBy === 'PER_MILE' ? 'PER_MILE' : c?.calculatedBy === 'PER_CWT' ? 'PER_CWT' : 'FLAT'

  const flags: Record<FlagKey, boolean> = {
    permits: !!sr.permit, fsma: !!sr.fsma, oversized: !!sr.oversize, hazmat: !!sr.hazmat, escorts: !!sr.escort,
    seal: !!sr.sealRequired, blind: !!sr.blind, customsBonded: !!(sr.customsBond ?? '').trim(),
    osd: !!shipment.osd, strapsChains: !!sr.straps, noBroker: !!sr.noBroker, team: !!sr.team,
    hot: !!load?.hot, labor: !!sr.labor, highRisk: !!sr.highRisk, massRelease: !!sr.massRelease,
    tonu: bundle.loadCarriers.some((lc) => lc.status === 'TONU'),
  }

  return {
    ...base,
    mode: shipment.mode,
    ship: {
      equipmentType: str(order?.equipmentType ?? load?.equipmentType),
      revDivision: str(shipment.revDivision),
      revSubdivision: str(shipment.revSubdivision),
      officeLabel: ctx.officeLabel ?? '',
      customerMiles: numStr(load?.miles),
      truckMiles: numStr(x?.ship?.truckMiles),
      footage: numStr(x?.ship?.footage),
      pieces: numStr(load?.pieces),
      weightLbs: numStr(load?.weight),
      billableWeightLbs: numStr(x?.ship?.billableWeightLbs),
      disableMileage: !!x?.ship?.disableMileage,
      freightClass: str(x?.ship?.freightClass ?? frt?.freightClass),
      description: str(load?.commodity ?? frt?.description),
      declaredValue: centsToDollars(load?.cargoValueCents),
      liftgate: sr.liftgate ?? null,
      inside: sr.inside ?? null,
      temp: {
        on: !!sr.tempControl,
        unit: temp?.unit ?? 'F',
        min: numStr(temp ? temp.min : tempF?.min),
        max: numStr(temp ? temp.max : tempF?.max),
        preCool: numStr(temp?.preCool),
      },
      palletExchange: { on: !!sr.palletExchange, palletsIn: numStr(sr.palletsIn), palletsOut: numStr(sr.palletsOut) },
      tarps: { on: !!sr.tarps, size: str(x?.ship?.tarpSize) },
      flags,
      mainItem: frt && !mainDefault ? frt : null,
    },
    customer: {
      id: str(shipment.customerId),
      typedName: shipment.customerId ? '' : str(shipment.customerName ?? order?.customerName),
      useTyped: !shipment.customerId,
      billToId: str(order?.billToId),
      contactId: str(order?.customerContactId),
      hours: str(x?.customer?.hours),
      emails,
      refNo: str(po?.value ?? load?.tmsId),
    },
    stops,
    roles: {
      salesRepId: str(shipment.salesRepId ?? order?.customerRepId),
      serviceRepId: str(x?.roles?.serviceRepId),
      dispatcherAssignedId: str(active?.carrierRepId ?? shipment.carrierRepId ?? load?.carrierRepId),
      tariff: str(x?.roles?.tariff),
      quoteId: str(order?.quoteId),
    },
    more: {
      specialInstructions: str(x?.instructions?.special),
      bolNotes: str(order?.customerNotes),
      rateConNotes: str(x?.instructions?.rateCon),
      notes: str(order?.internalNotes),
      references: refs.filter((r) => !consumed.has(r)),
      items: frtRest,
    },
    rates: {
      customer: {
        rateType: perHour ? 'PER_HOUR' : rateKind(custLH),
        hours: perHour ? numStr(custLH?.count ?? x?.rates?.customerHours) : '',
        lhRate: centsToDollars(custLH?.rateCents),
        lineId: str(custLH?.id),
      },
      carrier: carLH
        ? { rateType: rateKind(carLH), hours: '', lhRate: centsToDollars(carLH.rateCents), lineId: carLH.id, payPct: '', maxRate: centsToDollars(x?.rates?.maxRateCents) }
        : {
          rateType: (draft?.rateType as CarrierRateKind | undefined) ?? 'FLAT',
          hours: numStr(draft?.hours), lhRate: centsToDollars(draft?.lhRateCents), lineId: '',
          payPct: numStr(draft?.payPct), maxRate: centsToDollars(x?.rates?.maxRateCents),
        },
      fscPercent: custFSC?.calculatedBy === 'PERCENT' ? trimZeros((custFSC.rateCents / 100).toFixed(2)) : '',
      fscPerMile: custFSC?.calculatedBy === 'PER_MILE' ? centsToDollars(custFSC.rateCents) : '',
      fscLineId: str(custFSC?.id),
      smr: centsToDollars(x?.rates?.smrCents),
      lines,
      passthrough,
    },
    carrier: {
      loadCarrierId: str(active?.id),
      carrierId: str(active?.carrierId),
      typedName: active && !active.carrierId ? str(active.carrierName) : '',
      useTyped: !!active && !active.carrierId && active.kind !== 'OWN_ASSET',
      isOwnFleet: active?.kind === 'OWN_ASSET',
      dispatcher: { name: str(active?.dispatcherName), phone: str(active?.dispatcherPhone), email: str(active?.dispatcherEmail) },
      driver1: { name: str(active?.driverName), phone: str(active?.driverPhone), email: tie ? str(x?.carrier?.driverEmail1) : '' },
      driver2: { name: str(active?.driver2Name), phone: str(active?.driver2Phone), email: tie ? str(x?.carrier?.driverEmail2) : '' },
      truckNo: str(active?.truckNumber),
      trailerNo: str(active?.trailerNumber),
      seal: str(active?.sealNumber),
      carrierRef: str(active?.tripNumber),
      originCity: tie ? str(x?.carrier?.originCity) : '',
      originState: tie ? str(x?.carrier?.originState) : '',
      emptyMiles: tie ? numStr(x?.carrier?.emptyMiles) : '',
      puEta: isoToInput(active?.pickupEtaAt),
    },
    checkCall: emptyCheckCall(),
    docs: { queued: [] },
  }
}

/** A charge a different flow owns by shape (rate rows are claimed first by `valuesFromBundle`). */
function isRateTarget(c: LoadChargeRecord): boolean {
  return c.code === CODE_LINEHAUL || c.code === CODE_FSC
}
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export type { ChargeCalc, ShipmentStatus }
