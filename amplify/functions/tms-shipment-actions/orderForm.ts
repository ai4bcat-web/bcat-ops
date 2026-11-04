/**
 * Step AH: the validators behind the Aljex-parity shipment form.
 *
 * Pure and dependency-free (no client, no table, no env) so every rule is testable
 * without the Lambda harness, and so `handler.ts` only carries call sites. Three
 * groups live here:
 *
 *  - `Order.specialRequirements` v2 — the typed allowlist, the namespaced `form`
 *    extras, and the *patch* merge that stops a save from erasing a key the caller
 *    did not send (the order editor's five-key payload used to wipe every flag the
 *    Aljex import had written);
 *  - `loadFields` and the `UPDATE_ORDER_DETAILS` input, the post-draft edit surface;
 *  - `UPDATE_LOAD_CARRIER_DETAILS` and `UPDATE_STOP:SET_DETAILS` patches.
 *
 * Convention for every patch below: an ABSENT key means "leave it", an explicit
 * `null` (or an empty string) means "clear it".
 */
import {
  assertRecord,
  optionalBoolean,
  optionalFloat,
  optionalInteger,
} from '../_shared/actionInputs'
import { dedupeEmails, emailKey, isEmailAddress } from '../../../src/lib/emailAddress'

type Row = Record<string, unknown>

const SR = 'order.specialRequirements'

// ── small, path-aware field checks ──────────────────────────────────────────

function present(source: Row, key: string): boolean {
  return source[key] !== undefined
}

/** A trimmed string, '' / null → null; over `max` is an error that names the field. */
function text(value: unknown, max: number, label: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) throw new Error(`${label} must be at most ${max} characters`)
  return trimmed
}

function count(value: unknown, label: string): number | null {
  return optionalInteger(value, { min: 0, label })
}

function bool(value: unknown, label: string): boolean | null {
  try {
    return optionalBoolean(value)
  } catch {
    throw new Error(`${label} must be a boolean`)
  }
}

function assertKnownKeys(source: Row, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not a recognised field`)
  }
}

/** Drop null / undefined keys so a stored JSON object stays compact. */
function compact(row: Row): Row {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

// ── Order.specialRequirements v2 ────────────────────────────────────────────

/** Typed booleans. `inside` is tri-state: true / false / null (cleared = N/A). */
const SR_BOOLEAN_KEYS = [
  'team', 'tarps', 'straps', 'liftgate', 'hazmat',
  // Imported by the Aljex backfill and round-tripped from now on.
  'escort', 'oversize', 'permit', 'blind', 'sealRequired', 'tempControl',
  // Step AH.
  'fsma', 'noBroker', 'labor', 'highRisk', 'massRelease', 'palletExchange', 'inside',
] as const

const FORM_TEMP_UNITS = ['F', 'C'] as const
const CUSTOMER_RATE_TYPES = ['FLAT', 'PER_MILE', 'PER_HOUR', 'PER_CWT'] as const
const MAX_FORM_EMAILS = 6

function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function section(source: Row, key: string, allowed: readonly string[], label: string): Row | null {
  const raw = source[key]
  if (raw == null) return null
  const node = assertRecord(raw, `${label}.${key}`)
  assertKnownKeys(node, allowed, `${label}.${key}`)
  return node
}

/**
 * `Order.specialRequirements.form` — the namespaced extras Aljex has and we have no
 * column for (§4.0 of the AH plan). Unknown keys are refused with their path so a
 * typo cannot silently drop a value; null / empty values are omitted.
 */
export function validateFormExtras(value: unknown, label = `${SR}.form`): Row {
  const f = assertRecord(value, label)
  assertKnownKeys(f, ['v', 'ship', 'customer', 'roles', 'instructions', 'rates', 'carrier'], label)
  if (f.v != null && f.v !== 1) throw new Error(`${label}.v must be 1`)
  const out: Row = { v: 1 }

  const ship = section(f, 'ship', [
    'truckMiles', 'footage', 'billableWeightLbs', 'disableMileage', 'freightClass', 'tarpSize', 'temp',
  ], label)
  if (ship) {
    const temp = section(ship, 'temp', ['unit', 'min', 'max', 'preCool'], `${label}.ship`)
    const tempOut = temp == null ? null : compact({
      unit: choice(temp.unit, FORM_TEMP_UNITS, `${label}.ship.temp.unit`) ?? 'F',
      min: optionalInteger(temp.min, { label: `${label}.ship.temp.min` }),
      max: optionalInteger(temp.max, { label: `${label}.ship.temp.max` }),
      preCool: optionalInteger(temp.preCool, { label: `${label}.ship.temp.preCool` }),
    })
    const shipOut = compact({
      truckMiles: count(ship.truckMiles, `${label}.ship.truckMiles`),
      footage: count(ship.footage, `${label}.ship.footage`),
      billableWeightLbs: count(ship.billableWeightLbs, `${label}.ship.billableWeightLbs`),
      disableMileage: bool(ship.disableMileage, `${label}.ship.disableMileage`),
      freightClass: text(ship.freightClass, 16, `${label}.ship.freightClass`),
      tarpSize: text(ship.tarpSize, 40, `${label}.ship.tarpSize`),
      temp: tempOut,
    })
    if (Object.keys(shipOut).length > 0) out.ship = shipOut
  }

  const customer = section(f, 'customer', ['hours', 'emails'], label)
  if (customer) {
    let emails: string[] | null = null
    if (customer.emails != null) {
      if (!Array.isArray(customer.emails)) throw new Error(`${label}.customer.emails must be an array`)
      // The cap is on what was sent, not on what survives the de-duplication, so a
      // seventh box is refused even when it repeats an earlier address.
      const sent = customer.emails.filter((e) => !(typeof e === 'string' && !e.trim()))
      if (sent.length > MAX_FORM_EMAILS) {
        throw new Error(`${label}.customer.emails allows at most ${MAX_FORM_EMAILS} addresses`)
      }
      const cleaned = sent.map((e, i) => {
        const v = typeof e === 'string' ? emailKey(e) : ''
        if (!isEmailAddress(v)) throw new Error(`${label}.customer.emails[${i}] is not a valid email address`)
        return v
      })
      emails = dedupeEmails(cleaned)
    }
    const customerOut = compact({
      hours: text(customer.hours, 120, `${label}.customer.hours`),
      emails: emails && emails.length > 0 ? emails : null,
    })
    if (Object.keys(customerOut).length > 0) out.customer = customerOut
  }

  const roles = section(f, 'roles', ['serviceRepId', 'tariff'], label)
  if (roles) {
    const rolesOut = compact({
      serviceRepId: text(roles.serviceRepId, 100, `${label}.roles.serviceRepId`),
      tariff: text(roles.tariff, 120, `${label}.roles.tariff`),
    })
    if (Object.keys(rolesOut).length > 0) out.roles = rolesOut
  }

  const instructions = section(f, 'instructions', ['special', 'rateCon'], label)
  if (instructions) {
    const instructionsOut = compact({
      special: text(instructions.special, 420, `${label}.instructions.special`),
      rateCon: text(instructions.rateCon, 2000, `${label}.instructions.rateCon`),
    })
    if (Object.keys(instructionsOut).length > 0) out.instructions = instructionsOut
  }

  const rates = section(f, 'rates', [
    'customerRateType', 'customerHours', 'smrCents', 'maxRateCents', 'carrierDraft',
  ], label)
  if (rates) {
    const draft = section(rates, 'carrierDraft', ['rateType', 'hours', 'lhRateCents', 'payPct', 'maxRateCents'], `${label}.rates`)
    const draftOut = draft == null ? null : compact({
      rateType: text(draft.rateType, 32, `${label}.rates.carrierDraft.rateType`),
      hours: count(draft.hours, `${label}.rates.carrierDraft.hours`),
      lhRateCents: count(draft.lhRateCents, `${label}.rates.carrierDraft.lhRateCents`),
      payPct: optionalFloat(draft.payPct, { min: 0, max: 1000, label: `${label}.rates.carrierDraft.payPct` }),
      maxRateCents: count(draft.maxRateCents, `${label}.rates.carrierDraft.maxRateCents`),
    })
    const ratesOut = compact({
      customerRateType: choice(rates.customerRateType, CUSTOMER_RATE_TYPES, `${label}.rates.customerRateType`),
      customerHours: count(rates.customerHours, `${label}.rates.customerHours`),
      smrCents: count(rates.smrCents, `${label}.rates.smrCents`),
      maxRateCents: count(rates.maxRateCents, `${label}.rates.maxRateCents`),
      carrierDraft: draftOut && Object.keys(draftOut).length > 0 ? draftOut : null,
    })
    if (Object.keys(ratesOut).length > 0) out.rates = ratesOut
  }

  const carrier = section(f, 'carrier', [
    'loadCarrierId', 'originCity', 'originState', 'emptyMiles', 'driverEmail1', 'driverEmail2',
  ], label)
  if (carrier) {
    const email = (key: 'driverEmail1' | 'driverEmail2'): string | null => {
      const v = text(carrier[key], 200, `${label}.carrier.${key}`)
      if (v == null) return null
      if (!isEmailAddress(v)) throw new Error(`${label}.carrier.${key} is not a valid email address`)
      return v.toLowerCase()
    }
    const carrierOut = compact({
      loadCarrierId: text(carrier.loadCarrierId, 100, `${label}.carrier.loadCarrierId`),
      originCity: text(carrier.originCity, 120, `${label}.carrier.originCity`),
      originState: text(carrier.originState, 40, `${label}.carrier.originState`),
      emptyMiles: count(carrier.emptyMiles, `${label}.carrier.emptyMiles`),
      driverEmail1: email('driverEmail1'),
      driverEmail2: email('driverEmail2'),
    })
    if (Object.keys(carrierOut).length > 0) out.carrier = carrierOut
  }
  return out
}

/**
 * Validate a `specialRequirements` payload as a PATCH: only the keys the payload
 * carries come back. `null` (the whole value) means "no requirements" and clears
 * everything; a key set to `null` clears just that key. Keys outside the allowlist
 * are dropped, as they always were; the `tempF` object and the `form` extras are
 * replaced as units.
 */
export function validateSpecialRequirementsV2(value: unknown): Row | null {
  if (value == null) return null
  const s = assertRecord(value, SR)
  const patch: Row = {}
  for (const key of SR_BOOLEAN_KEYS) {
    if (present(s, key)) patch[key] = bool(s[key], `${SR}.${key}`)
  }
  if (present(s, 'customsBond')) patch.customsBond = text(s.customsBond, 120, `${SR}.customsBond`)
  for (const key of ['palletsIn', 'palletsOut'] as const) {
    if (present(s, key)) patch[key] = count(s[key], `${SR}.${key}`)
  }
  if (present(s, 'tempF')) {
    if (s.tempF == null) patch.tempF = null
    else {
      const t = assertRecord(s.tempF, `${SR}.tempF`)
      patch.tempF = {
        target: optionalInteger(t.target, { label: `${SR}.tempF.target` }),
        min: optionalInteger(t.min, { label: `${SR}.tempF.min` }),
        max: optionalInteger(t.max, { label: `${SR}.tempF.max` }),
      }
    }
  }
  if (present(s, 'other')) {
    if (s.other == null) patch.other = null
    else {
      if (!Array.isArray(s.other)) throw new Error(`${SR}.other must be an array`)
      patch.other = s.other.map((v, i) => {
        if (typeof v !== 'string' || !v.trim()) throw new Error(`${SR}.other[${i}] must be a non-empty string`)
        return v.trim()
      })
    }
  }
  if (present(s, 'form')) patch.form = s.form == null ? null : validateFormExtras(s.form)
  return patch
}

/** What a stored JSON column may hold: an object, or (written through AppSync) its string. */
function storedRecord(stored: unknown): Row {
  let v = stored
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return {} }
  }
  return v != null && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Row) } : {}
}

/**
 * Apply a validated patch over the stored object. `patch === null` is the explicit
 * "no requirements" and clears everything; otherwise a key absent from the patch
 * keeps its stored value and a key set to `null` is removed. An empty result is
 * stored as `null`, the same as an order that never had requirements.
 */
export function mergeSpecialRequirements(stored: unknown, patch: Row | null): Row | null {
  if (patch === null) return null
  const merged = storedRecord(stored)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  return Object.keys(merged).length > 0 ? merged : null
}

// ── loadFields ──────────────────────────────────────────────────────────────

export const LOAD_FIELD_KEYS = [
  'miles', 'weight', 'commodity', 'pieces', 'piecesUnit', 'cargoValueCents', 'hot', 'notes',
] as const

/**
 * `loadFields` as a patch: present keys only, `null` clears. Callers that keep the
 * legacy "null leaves miles / weight / commodity alone" rule (SAVE_ORDER_FORM) apply
 * it themselves; UPDATE_ORDER_DETAILS honours the clear.
 */
export function validateLoadFieldsV2(value: unknown, label = 'loadFields'): Row {
  const lf = assertRecord(value ?? {}, label)
  assertKnownKeys(lf, LOAD_FIELD_KEYS, label)
  const patch: Row = {}
  if (present(lf, 'miles')) patch.miles = count(lf.miles, `${label}.miles`)
  if (present(lf, 'weight')) patch.weight = count(lf.weight, `${label}.weight`)
  if (present(lf, 'commodity')) patch.commodity = text(lf.commodity, 200, `${label}.commodity`)
  if (present(lf, 'pieces')) patch.pieces = count(lf.pieces, `${label}.pieces`)
  if (present(lf, 'piecesUnit')) patch.piecesUnit = text(lf.piecesUnit, 40, `${label}.piecesUnit`)
  if (present(lf, 'cargoValueCents')) patch.cargoValueCents = count(lf.cargoValueCents, `${label}.cargoValueCents`)
  if (present(lf, 'hot')) patch.hot = bool(lf.hot, `${label}.hot`)
  if (present(lf, 'notes')) patch.notes = text(lf.notes, 8000, `${label}.notes`)
  return patch
}

/** `shipmentFlags` — the client-read-only Shipment columns the form may set. */
export function validateShipmentFlags(value: unknown, label = 'shipmentFlags'): Row {
  const sf = assertRecord(value ?? {}, label)
  assertKnownKeys(sf, ['osd'], label)
  const patch: Row = {}
  if (present(sf, 'osd')) patch.osd = bool(sf.osd, `${label}.osd`) ?? false
  return patch
}

// ── UPDATE_ORDER_DETAILS ────────────────────────────────────────────────────

/** Keys this action never takes, with the action that owns them. */
const OWNED_ELSEWHERE: Record<string, string> = {
  mode: 'Mode cannot change after the order is submitted',
  rateType: 'Rate type cannot change after the order is submitted',
  customerId: 'Use SET_SHIPMENT_CUSTOMER',
  customerName: 'Use SET_SHIPMENT_CUSTOMER',
  stops: 'Use UPDATE_STOP',
  charges: 'Use RECALC_CHARGES',
}

export const UPDATE_ORDER_KEYS = [
  'references', 'equipmentType', 'equipmentLengthFt', 'specialRequirements', 'freight',
  'customerNotes', 'internalNotes', 'customerContactId', 'costCenter', 'billToId', 'quoteId',
] as const

/** Order keys the invoice snapshot owns once the order is invoiced. */
export const INVOICE_LOCKED_ORDER_KEYS = [
  'references', 'equipmentType', 'freight', 'billToId', 'customerContactId', 'quoteId',
] as const

/** Load fields the frozen financials own (they are what PER_MILE / PER_CWT multiply). */
export const FROZEN_LOCKED_LOAD_KEYS = ['miles', 'weight'] as const

export interface UpdateOrderDetailsInput {
  /** Present keys only. `specialRequirements` is the validated patch (null = clear all). */
  order: Row
  loadFields: Row
  shipmentFlags: Row
}

export interface OrderRowValidators {
  reference: (item: unknown, index: number) => Row
  freight: (item: unknown, index: number) => Row
}

function refuseOwnedElsewhere(source: Row, label: string): void {
  for (const key of Object.keys(source)) {
    const why = OWNED_ELSEWHERE[key]
    if (why) throw new Error(`${label}${key} cannot be changed here: ${why}`)
  }
}

/**
 * The shape check for UPDATE_ORDER_DETAILS. State rules (draft, voided, invoiced,
 * frozen, CAS) need the bundle and stay in the handler; this refuses what no state
 * could allow and returns the validated patches.
 */
export function validateUpdateOrderDetails(input: Row, rows: OrderRowValidators): UpdateOrderDetailsInput {
  refuseOwnedElsewhere(input, '')
  const orderInput = assertRecord(input.order ?? {}, 'order')
  refuseOwnedElsewhere(orderInput, 'order.')
  assertKnownKeys(orderInput, UPDATE_ORDER_KEYS, 'order')

  const order: Row = {}
  const arrayField = (key: 'references' | 'freight', validate: (item: unknown, index: number) => Row): void => {
    if (!present(orderInput, key)) return
    const raw = orderInput[key]
    if (raw == null) {
      order[key] = []
      return
    }
    if (!Array.isArray(raw)) throw new Error(`order.${key} must be an array`)
    if (raw.length > 100) throw new Error(`order.${key} must have at most 100 entries`)
    order[key] = raw.map(validate)
  }
  arrayField('references', rows.reference)
  arrayField('freight', rows.freight)
  if (present(orderInput, 'equipmentType')) order.equipmentType = text(orderInput.equipmentType, 80, 'order.equipmentType')
  if (present(orderInput, 'equipmentLengthFt')) order.equipmentLengthFt = count(orderInput.equipmentLengthFt, 'order.equipmentLengthFt')
  if (present(orderInput, 'specialRequirements')) order.specialRequirements = validateSpecialRequirementsV2(orderInput.specialRequirements)
  if (present(orderInput, 'customerNotes')) order.customerNotes = text(orderInput.customerNotes, 8000, 'order.customerNotes')
  if (present(orderInput, 'internalNotes')) order.internalNotes = text(orderInput.internalNotes, 8000, 'order.internalNotes')
  if (present(orderInput, 'customerContactId')) order.customerContactId = text(orderInput.customerContactId, 100, 'order.customerContactId')
  if (present(orderInput, 'costCenter')) order.costCenter = text(orderInput.costCenter, 120, 'order.costCenter')
  if (present(orderInput, 'billToId')) order.billToId = text(orderInput.billToId, 100, 'order.billToId')
  if (present(orderInput, 'quoteId')) order.quoteId = text(orderInput.quoteId, 100, 'order.quoteId')

  return {
    order,
    loadFields: validateLoadFieldsV2(input.loadFields),
    shipmentFlags: validateShipmentFlags(input.shipmentFlags),
  }
}

// ── UPDATE_LOAD_CARRIER_DETAILS ─────────────────────────────────────────────

const CARRIER_DETAIL_CAPS = {
  dispatcherName: 120,
  dispatcherPhone: 40,
  dispatcherEmail: 200,
  driverName: 120,
  driverPhone: 40,
  driver2Name: 120,
  driver2Phone: 40,
  truckNumber: 40,
  trailerNumber: 40,
  plates: 40,
  vin: 40,
  sealNumber: 40,
  tripNumber: 40,
} as const

export const CARRIER_DETAIL_KEYS = Object.keys(CARRIER_DETAIL_CAPS) as (keyof typeof CARRIER_DETAIL_CAPS)[]

/** Money, rate-con and lifecycle keys: each has its own action and its own rules. */
const CARRIER_MONEY_OR_STATE_KEYS = [
  'carrierRateCents', 'costCents', 'charges', 'status', 'rateConStatus', 'rateConSentAt', 'rateConSignedAt',
  'dispatchedAt', 'bookedAt', 'apStatus', 'quickPay', 'quickPayFeeBps', 'quickPayFeeCents',
  'chargesFinalizedAt', 'carrierId', 'carrierName', 'carrierMc', 'kind', 'driverId', 'truckId', 'trailerId',
  'pickupEtaAt', 'deliveryEtaAt',
] as const

/** Everything the action's own envelope carries; not part of the patch. */
const CARRIER_ENVELOPE_KEYS = ['loadCarrierId', 'expectedUpdatedAt'] as const

/**
 * The assignment fields a dispatcher may correct in place after Cover. Money, rate-con
 * and status keys are refused by name; any other unknown key is refused too, so a
 * typo is an error rather than a silent no-op. At least one key is required.
 */
export function validateCarrierDetails(input: Row): Row {
  const patch: Row = {}
  for (const key of Object.keys(input)) {
    if ((CARRIER_ENVELOPE_KEYS as readonly string[]).includes(key)) continue
    if ((CARRIER_MONEY_OR_STATE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${key} cannot be changed here: money, rate confirmation and status have their own actions`)
    }
    if (!(CARRIER_DETAIL_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${key} is not a recognised assignment detail`)
    }
  }
  for (const key of CARRIER_DETAIL_KEYS) {
    if (present(input, key)) patch[key] = text(input[key], CARRIER_DETAIL_CAPS[key], key)
  }
  if (Object.keys(patch).length === 0) throw new Error('Nothing to change: send at least one assignment detail')
  return patch
}

// ── UPDATE_STOP: SET_DETAILS ────────────────────────────────────────────────

/**
 * `patch` of the SET_DETAILS op: the three stop fields no other op sets. Present key
 * written, `null` clears; unknown keys are refused.
 */
export function validateStopDetailsPatch(patch: Row): Row {
  assertKnownKeys(patch, ['instructions', 'pieces', 'weightLbs'], 'patch')
  const out: Row = {}
  if (present(patch, 'instructions')) out.instructions = text(patch.instructions, 2000, 'patch.instructions')
  if (present(patch, 'pieces')) out.pieces = count(patch.pieces, 'patch.pieces')
  if (present(patch, 'weightLbs')) out.weightLbs = count(patch.weightLbs, 'patch.weightLbs')
  if (Object.keys(out).length === 0) throw new Error('Nothing to change: patch needs instructions, pieces or weightLbs')
  return out
}
