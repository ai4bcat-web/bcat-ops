/**
 * Step U — the pure core of Intake: how a parsed tender e-mail becomes a partially built load
 * (`buildIntakeDraft`), what is auto-filled / missing / worth checking (`fieldStatusOf`), when the
 * load may become an Active shipment (`canMoveToActive`), and the exact `createShipment` input it
 * becomes (`toCreateShipmentInput`).
 *
 * Relative imports only: bundled by `workflow-agent` and `tms-shipment-actions` as well as the
 * Intake pages, so the Lambda that stages a row, the one that promotes it and the review page can
 * never disagree about what "ready" means. (`src/lib/intake.ts` is the unrelated legacy IntakePage helper.)
 */
import type {
  IntakeCustomerCandidate,
  IntakeFieldMeta,
  IntakeFieldStatus,
  IntakeFields,
  IntakeLoadRecord,
  IntakeMeta,
  IntakeSource,
  IntakeStop,
} from '../types/intake'
import { isDemoText } from './demoFlow'
import type { TenderPrefill, TenderStopPrefill } from './intakeTender'
import {
  REQUIRED_FIELD_CATALOG,
  missingRequiredFields,
  requiredFieldLabel,
  resolveRequiredFields,
  type RequiredFieldSubject,
} from './flowDefaults'
import { fromDateInput, fromDateTimeInput } from './date'
import { isShipmentTypeKey } from './shipmentTypes'

type Row = Record<string, unknown>

export const INTAKE_NOT_READY_PREFIX = 'Not ready to move to active'
/** Catalog keys that only exist after booking / delivery, so intake cannot collect them. */
export const INTAKE_COLLECTABLE_EXCLUDED: readonly string[] = ['carrierRep', 'bolNumber']

export const INTAKE_STOP_KEYS = ['name', 'street', 'city', 'state', 'zip', 'date', 'time', 'instructions'] as const
export type IntakeStopKey = (typeof INTAKE_STOP_KEYS)[number]

const SCALAR_KEYS = [
  'customerId', 'customerName', 'billToId', 'salesRepId', 'divisionCode',
  'reference', 'pickupNumber', 'deliveryNumber', 'shipmentType', 'equipmentType', 'commodity',
  'weightLb', 'customerRateCents', 'driverId',
] as const
type ScalarKey = (typeof SCALAR_KEYS)[number]

const SCALAR_LABELS: Record<ScalarKey, string> = {
  customerId: 'Customer', customerName: 'Customer name', billToId: 'Bill-to party', salesRepId: 'Sales rep',
  divisionCode: 'Revenue division', reference: 'Reference (PO / TMS ID)', pickupNumber: 'Pickup number',
  deliveryNumber: 'Delivery number', shipmentType: 'Shipment type', equipmentType: 'Equipment type', commodity: 'Commodity',
  weightLb: 'Weight', customerRateCents: 'Customer rate', driverId: 'Driver',
}
const STOP_LABELS: Record<IntakeStopKey, string> = {
  name: 'name', street: 'street', city: 'city', state: 'state', zip: 'zip', date: 'date', time: 'time', instructions: 'instructions',
}

/** Human label for a meta/confirm key: `weightLb` → "Weight", `stops.1.city` → "Stop 2 city". */
export function intakeFieldLabel(key: string): string {
  const m = /^stops\.(\d+)\.(\w+)$/.exec(key)
  if (m) return `Stop ${Number(m[1]) + 1} ${STOP_LABELS[m[2] as IntakeStopKey] ?? m[2]}`
  return SCALAR_LABELS[key as ScalarKey] ?? key
}

export function emptyIntakeFields(): IntakeFields {
  return {
    customerId: null, customerName: null, billToId: null, salesRepId: null, divisionCode: null,
    reference: null, pickupNumber: null, deliveryNumber: null, shipmentType: null, equipmentType: null, commodity: null,
    weightLb: null, customerRateCents: null, driverId: null, stops: [],
  }
}

/**
 * The page always shows a pickup and a delivery (Ryne 2026-11-11): a draft with none of one kind gets an empty stop of that kind
 * appended, so a reviewer fills it in instead of having to add it. Existing stops keep their index (provenance is keyed by it).
 */
export function ensureRequiredStops(fields: IntakeFields): IntakeFields {
  const stops = fields.stops.map((s) => ({ ...s }))
  if (!stops.some((s) => s.type === 'pickup')) stops.push(emptyStop('pickup'))
  if (!stops.some((s) => s.type === 'delivery')) stops.push(emptyStop('delivery'))
  return stops.length === fields.stops.length ? fields : { ...fields, stops }
}

function emptyStop(type: IntakeStop['type']): IntakeStop {
  return { type, name: null, street: null, city: null, state: null, zip: null, date: null, time: null, instructions: null }
}

// ── value access and format checks ───────────────────────────────────────────

function present(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'number') return Number.isFinite(value)
  return String(value).trim() !== ''
}

function valueOf(fields: IntakeFields, key: string): unknown {
  const m = /^stops\.(\d+)\.(\w+)$/.exec(key)
  if (m) return (fields.stops[Number(m[1])] as unknown as Row | undefined)?.[m[2]] ?? null
  return (fields as unknown as Row)[key] ?? null
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** True when a PRESENT value is well formed for its field. Absent values and free-text fields pass. */
function formatOk(key: string, value: unknown): boolean {
  if (!present(value)) return true
  const stopKey = /^stops\.\d+\.(\w+)$/.exec(key)?.[1] ?? null
  const k = stopKey ?? key
  const s = String(value).trim()
  if (stopKey) {
    if (k === 'state') return /^[A-Za-z]{2}$/.test(s)
    if (k === 'zip') return /^\d{5}(-\d{4})?$/.test(s)
    if (k === 'date') return validDate(s)
    if (k === 'time') return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
    return true
  }
  if (k === 'weightLb') return typeof value === 'number' && value > 0 && value <= 80_000
  if (k === 'customerRateCents') return typeof value === 'number' && value >= 0
  if (k === 'shipmentType') return isShipmentTypeKey(s)
  return true
}

/** Every key a draft can carry provenance for, in display order. */
export function intakeFieldKeys(fields: IntakeFields): string[] {
  const keys: string[] = [...SCALAR_KEYS]
  fields.stops.forEach((_, i) => { for (const k of INTAKE_STOP_KEYS) keys.push(`stops.${i}.${k}`) })
  return keys
}

// ── building the draft from the parse ────────────────────────────────────────

const clean = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s || null
}

/**
 * The customer's bill-to for a new load: its default party (`billToParties[].isDefault`),
 * or null when it has none marked default.
 */
export function defaultBillToIdOf(customer: { billToParties?: unknown } | null | undefined): string | null {
  let raw = customer?.billToParties
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = null } }
  if (!Array.isArray(raw)) return null
  const parties = raw.filter((p) => p && typeof p === 'object' && clean((p as Row).id))
  const flagged = parties.find((p) => (p as Row).isDefault === true)
  // No party flagged default: a customer with a single bill-to party bills that one (Ryne 2026-11-10: picking a customer left Bill to empty).
  const hit = flagged ?? (parties.length === 1 ? parties[0] : null)
  return hit ? clean((hit as Row).id) : null
}

/** The sales rep a new load defaults to: `defaultSalesRepId`, else the primary account owner. */
export function defaultSalesRepIdOf(customer: { defaultSalesRepId?: unknown; accountOwnerIds?: unknown } | null | undefined): string | null {
  const owners = Array.isArray(customer?.accountOwnerIds) ? customer.accountOwnerIds : []
  return clean(customer?.defaultSalesRepId) ?? clean(owners[0])
}

/**
 * What a new intake load or shipment starts with from its customer. Only a starting
 * value: both stay required, and the load still needs its review before it moves.
 */
export function customerDefaultsOf(customer: {
  defaultSalesRepId?: unknown; accountOwnerIds?: unknown; defaultBillToId?: unknown; billToParties?: unknown
} | null | undefined): { salesRepId: string | null; billToId: string | null } {
  return {
    salesRepId: defaultSalesRepIdOf(customer),
    billToId: clean(customer?.defaultBillToId) ?? defaultBillToIdOf(customer),
  }
}

/** The "Demo" chip: an intake load carrying the ZZ DEMO marker in its customer, sender, subject or division. */
export function isDemoIntake(row: Pick<IntakeLoadRecord, 'fields' | 'fromName' | 'subject' | 'divisionCode'>): boolean {
  return isDemoText(row.fields.customerName, row.fields.reference, row.fromName, row.subject, row.divisionCode)
}

const MERGE_SCALARS = ['customerName', 'reference', 'pickupNumber', 'deliveryNumber', 'shipmentType', 'equipmentType', 'commodity', 'weightLb', 'customerRateCents'] as const
const MERGE_STOP_KEYS = ['name', 'street', 'city', 'state', 'zip', 'date', 'time', 'instructions'] as const

/**
 * What a later e-mail about the same tender (the original, with its rate confirmation) adds to an intake row that is already there
 * (typed from a Slack forward, say): only values the row has NOT got. Nothing a person or the first read put on the row is ever
 * overwritten. Returns the merged fields and the keys that were filled (`stops.<i>.<key>` for stop fields).
 */
export function mergeIntakeFields(existing: IntakeFields, incoming: IntakeFields): { fields: IntakeFields; filled: string[] } {
  const fields: IntakeFields = { ...existing, stops: existing.stops.map((s) => ({ ...s })) }
  const filled: string[] = []
  for (const key of MERGE_SCALARS) {
    if (!present(existing[key]) && present(incoming[key])) {
      ;(fields as unknown as Record<string, unknown>)[key] = incoming[key]
      filled.push(key)
    }
  }
  if (existing.stops.length === 0) {
    incoming.stops.forEach((stop, i) => {
      fields.stops.push({ ...stop })
      for (const k of MERGE_STOP_KEYS) if (present(stop[k])) filled.push(`stops.${i}.${k}`)
    })
  } else if (existing.stops.length === incoming.stops.length) {
    incoming.stops.forEach((stop, i) => {
      if (stop.type !== existing.stops[i]!.type) return
      for (const k of MERGE_STOP_KEYS) {
        if (!present(existing.stops[i]![k]) && present(stop[k])) {
          ;(fields.stops[i] as unknown as Record<string, unknown>)[k] = stop[k]
          filled.push(`stops.${i}.${k}`)
        }
      }
    })
  }
  return { fields, filled }
}

export function buildIntakeDraft(input: {
  tender: TenderPrefill | null
  parserTender: TenderPrefill | null
  fillKind: 'RATECON' | 'EMAIL' | 'NONE'
  lowConfidence: readonly string[]
  party: { kind: string | null; id: string | null; name: string | null; how: string | null; candidates: IntakeCustomerCandidate[] }
  customer: { defaultSalesRepId?: string | null; accountOwnerIds?: string[] | null; defaultBillToId?: string | null; billToParties?: unknown } | null
  divisionCode: string | null
  stopFacilityHits: readonly boolean[]
}): { fields: IntakeFields; meta: IntakeMeta; customerCandidates: IntakeCustomerCandidate[] } {
  const fields = emptyIntakeFields()
  const meta: IntakeMeta = {}
  const low = new Set(input.lowConfidence.map((k) => k.replace(/\.dateStr$/, '.date')))
  const tender = input.tender
  const parser = input.parserTender

  const mark = (key: string, source: IntakeSource, confidence: 'high' | 'low' = 'high') => {
    const value = valueOf(fields, key)
    if (!present(value)) return
    meta[key] = { source, confidence: confidence === 'low' || !formatOk(key, value) ? 'low' : 'high' }
  }
  /** Where a value that is in the merged tender came from. */
  const sourceOfTender = (key: string, parserHas: boolean): { source: IntakeSource; confidence: 'high' | 'low' } => {
    if (parserHas) return { source: 'PARSER', confidence: 'high' }
    if (input.fillKind === 'RATECON') return { source: 'RATECON', confidence: 'high' }
    return { source: 'MODEL', confidence: low.has(key) ? 'low' : 'high' }
  }

  // Customer.
  const matched = input.party.kind === 'CUSTOMER' && input.party.id
  if (matched) {
    fields.customerId = input.party.id
    fields.customerName = clean(input.party.name)
    const confidence = input.party.how === 'EMAIL' ? 'high' : 'low'
    mark('customerId', 'DIRECTORY', confidence)
    mark('customerName', 'DIRECTORY', confidence)
  } else {
    fields.customerName = clean(tender?.customer)
    if (fields.customerName) {
      const s = sourceOfTender('customerName', !!clean(parser?.customer))
      mark('customerName', s.source, s.confidence)
    }
  }
  fields.divisionCode = clean(input.divisionCode)
  mark('divisionCode', 'ADDRESS')

  const defaults = customerDefaultsOf(input.customer)
  fields.salesRepId = defaults.salesRepId
  mark('salesRepId', 'DEFAULT')
  fields.billToId = defaults.billToId
  mark('billToId', 'DEFAULT')

  // Scalars the tender carries.
  const t = tender
  fields.reference = clean(t?.reference)
  fields.pickupNumber = clean(t?.pickupNumber)
  fields.shipmentType = isShipmentTypeKey(t?.shipmentType) ? t.shipmentType : null
  fields.weightLb = typeof t?.weightLb === 'number' && Number.isFinite(t.weightLb) ? t.weightLb : null
  fields.deliveryNumber = clean(t?.deliveryNumber)
  fields.equipmentType = clean(t?.equipmentType)
  fields.commodity = clean(t?.commodity)
  fields.customerRateCents = typeof t?.customerRateCents === 'number' && Number.isFinite(t.customerRateCents) && t.customerRateCents >= 0 ? Math.round(t.customerRateCents) : null
  for (const [key, parserHas] of [
    ['reference', !!clean(parser?.reference)],
    ['pickupNumber', !!clean(parser?.pickupNumber)],
    ['deliveryNumber', false],
    ['shipmentType', false],
    ['equipmentType', false],
    ['commodity', false],
    ['customerRateCents', false],
    ['weightLb', typeof parser?.weightLb === 'number'],
  ] as const) {
    const s = sourceOfTender(key, parserHas)
    mark(key, s.source, s.confidence)
  }

  // Stops, in the tender's order (pickups first, as `tenderStopForms` orders them).
  const merged: TenderStopPrefill[] = [
    ...(t?.stops ?? []).filter((s) => s.type === 'pickup'),
    ...(t?.stops ?? []).filter((s) => s.type === 'delivery'),
  ]
  const mergedRaw = t?.stops ?? []
  merged.forEach((stop, i) => {
    const row = emptyStop(stop.type)
    row.name = clean(stop.name); row.street = clean(stop.street); row.city = clean(stop.city)
    row.state = clean(stop.state)?.toUpperCase() ?? null
    row.zip = clean(stop.zip); row.date = clean(stop.dateStr); row.time = clean(stop.time)
    row.instructions = clean(stop.instructions)
    fields.stops.push(row)
    const rawIndex = mergedRaw.indexOf(stop)
    const parserStop = parserStopFor(parser?.stops ?? [], stop.type, mergedRaw, rawIndex >= 0 ? rawIndex : i)
    const pairs: [IntakeStopKey, string | undefined][] = [
      ['name', parserStop?.name], ['street', parserStop?.street], ['city', parserStop?.city],
      ['state', parserStop?.state], ['zip', parserStop?.zip], ['date', parserStop?.dateStr],
      ['time', parserStop?.time], ['instructions', parserStop?.instructions],
    ]
    for (const [k, parserValue] of pairs) {
      const key = `stops.${i}.${k}`
      if (!present(valueOf(fields, key))) continue
      if (k === 'name' && !clean(parserValue) && input.stopFacilityHits[rawIndex >= 0 ? rawIndex : i]) { mark(key, 'DIRECTORY'); continue }
      const s = sourceOfTender(key, !!clean(parserValue))
      mark(key, s.source, s.confidence)
    }
  })

  return { fields, meta, customerCandidates: input.party.candidates.slice(0, 3) }
}

/** The parser's stop that corresponds to the nth stop of `mergedRaw` (same type, same ordinal within the type). */
function parserStopFor(
  parserStops: readonly TenderStopPrefill[],
  type: TenderStopPrefill['type'],
  mergedRaw: readonly TenderStopPrefill[],
  rawIndex: number,
): TenderStopPrefill | undefined {
  // `tenderFromParse` merges by position, so the parser stop at the same raw index is the base —
  // but only when it is the same type; otherwise fall back to the same ordinal within the type.
  const direct = parserStops[rawIndex]
  if (direct && direct.type === type) return direct
  const ordinal = mergedRaw.slice(0, rawIndex).filter((s) => s.type === type).length
  return parserStops.filter((s) => s.type === type)[ordinal]
}

// ── per-field status ─────────────────────────────────────────────────────────

export function fieldStatusOf(key: string, fields: IntakeFields, meta: IntakeMeta, confirmed: readonly string[]): IntakeFieldStatus {
  const value = valueOf(fields, key)
  if (!present(value)) return 'MISSING'
  const m: IntakeFieldMeta | undefined = meta[key]
  if (m?.source === 'REVIEWER' && !formatOk(key, value)) return 'INVALID'
  if (m?.source === 'REVIEWER' || confirmed.includes(key)) return 'CONFIRMED'
  if (m?.confidence === 'low' || !formatOk(key, value)) return 'LOW'
  return 'AUTO'
}

// ── required-field gate ──────────────────────────────────────────────────────

export function intakeSubject(fields: IntakeFields): RequiredFieldSubject {
  return {
    stops: fields.stops.map((s) => ({
      type: s.type,
      city: s.city,
      state: s.state,
      appt: s.date ? (s.time ? `${s.date}T${s.time}` : s.date) : '',
    })),
    billToId: fields.billToId,
    salesRepId: fields.salesRepId,
    revDivision: fields.divisionCode,
    customerRateCents: fields.customerRateCents,
    equipmentType: fields.equipmentType,
    references: { po: fields.reference, pickup: fields.pickupNumber, delivery: fields.deliveryNumber },
    freight: { commodity: fields.commodity, weightLbs: fields.weightLb },
  }
}

const CATALOG_KEYS = new Set(REQUIRED_FIELD_CATALOG.map((f) => f.key))

/** Whatever the company's required-field list says, a load cannot become a shipment without these (Ryne 2026-11-11). */
export const INTAKE_ALWAYS_REQUIRED: readonly string[] = ['pickupAddress', 'pickupAppt', 'deliveryAddress', 'deliveryAppt', 'pickupNumber', 'deliveryNumber']

export function intakeRequired(settings: unknown, customer: unknown): { gated: string[]; deferred: string[] } {
  const all = [...new Set([...resolveRequiredFields(
    settings as Parameters<typeof resolveRequiredFields>[0],
    customer as Parameters<typeof resolveRequiredFields>[1],
  ), ...INTAKE_ALWAYS_REQUIRED])]
  const gated: string[] = []
  const deferred: string[] = []
  for (const key of all) {
    if (CATALOG_KEYS.has(key) && !INTAKE_COLLECTABLE_EXCLUDED.includes(key)) gated.push(key)
    else deferred.push(key)
  }
  return { gated, deferred }
}

export function intakeMissing(fields: IntakeFields, required: readonly string[]): string[] {
  return missingRequiredFields(intakeSubject(fields), required)
}

export function intakeProblems(fields: IntakeFields, ctx: { customerActive: boolean; divisionActive: boolean }): string[] {
  const out: string[] = []
  if (!present(fields.customerId)) out.push('Choose the customer from the directory')
  else if (!ctx.customerActive) out.push('The customer is not active')
  if (!present(fields.divisionCode)) out.push('Choose the revenue division')
  else if (!ctx.divisionActive) out.push('The revenue division is not active')
  if (!fields.stops.some((s) => s.type === 'pickup')) out.push('Add at least one pickup stop')
  if (!fields.stops.some((s) => s.type === 'delivery')) out.push('Add at least one delivery stop')
  fields.stops.forEach((s, i) => {
    const n = i + 1
    if (!present(s.street)) out.push(`Stop ${n} needs a street address`)
    if (!present(s.city)) out.push(`Stop ${n} needs a city`)
    if (!present(s.state) || !formatOk(`stops.${i}.state`, s.state)) out.push(`Stop ${n} needs a two-letter state`)
    if (!present(s.zip)) out.push(`Stop ${n} needs a zip code`)
    else if (!formatOk(`stops.${i}.zip`, s.zip)) out.push(`Stop ${n} zip must be 5 or 9 digits`)
    if (!present(s.date)) out.push(`Stop ${n} needs a ${s.type === 'delivery' ? 'delivery' : 'pickup'} date`)
    else if (!formatOk(`stops.${i}.date`, s.date)) out.push(`Stop ${n} date must be a valid YYYY-MM-DD`)
    if (!present(s.time)) out.push(`Stop ${n} needs a ${s.type === 'delivery' ? 'delivery' : 'pickup'} time`)
    if (present(s.time) && !formatOk(`stops.${i}.time`, s.time)) out.push(`Stop ${n} time must be HH:mm`)
  })
  if (fields.weightLb != null && !(typeof fields.weightLb === 'number' && fields.weightLb >= 0)) out.push('Weight must be a number')
  if (fields.customerRateCents != null && !(typeof fields.customerRateCents === 'number' && fields.customerRateCents >= 0)) out.push('Rate must be a number')
  return out
}

type IntakeReadinessCtx = { settings: unknown; customer: unknown; customerActive: boolean; divisionActive: boolean }
export interface IntakeVerdict {
  ok: boolean
  missing: string[]
  problems: string[]
  unconfirmed: string[]
  needsReview: boolean
}

/** Every required field populated and valid, ignoring whether a reviewer has signed the load off. */
export function canMarkReviewed(
  row: Pick<IntakeLoadRecord, 'fields' | 'meta' | 'confirmed'>,
  ctx: IntakeReadinessCtx,
): Omit<IntakeVerdict, 'needsReview'> {
  const { fields, meta, confirmed } = row
  const problems = intakeProblems(fields, ctx)
  const missing = intakeMissing(fields, intakeRequired(ctx.settings, ctx.customer).gated).map(requiredFieldLabel)
  const unconfirmed: string[] = []
  for (const key of intakeFieldKeys(fields)) {
    const status = fieldStatusOf(key, fields, meta, confirmed)
    if (status === 'LOW') unconfirmed.push(key)
    else if (status === 'INVALID') problems.push(`${intakeFieldLabel(key)} is not valid`)
  }
  return { ok: !problems.length && !missing.length && !unconfirmed.length, missing, problems, unconfirmed }
}

/**
 * A load becomes an Active shipment when it is complete. There is no separate review step any more (Ryne 2026-11-10): the person who
 * presses Create shipment has looked at it. `needsReview` stays on the verdict (always false) so older callers keep compiling.
 */
export function canMoveToActive(
  row: Pick<IntakeLoadRecord, 'fields' | 'meta' | 'confirmed' | 'reviewedAt' | 'reviewedBy'>,
  ctx: IntakeReadinessCtx,
): IntakeVerdict {
  const base = canMarkReviewed(row, ctx)
  return { ...base, needsReview: false }
}

// ── reviewer edits ───────────────────────────────────────────────────────────

/** Scalar keys set the field; `stops`, when present, is the FULL replacement array. */
export type IntakeFieldsPatch = Partial<Omit<IntakeFields, 'stops'>> & { stops?: IntakeStop[] }

function normalizeValue(key: string, value: unknown): unknown {
  if (value == null) return null
  if (key === 'weightLb' || key === 'customerRateCents') {
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    return String(value).trim() === '' || !Number.isFinite(n) ? null : n
  }
  return clean(value)
}

function normalizeStop(stop: IntakeStop): IntakeStop {
  const out = emptyStop(stop.type === 'delivery' ? 'delivery' : 'pickup')
  for (const k of INTAKE_STOP_KEYS) {
    const v = clean((stop as unknown as Row)[k])
    ;(out as unknown as Row)[k] = k === 'state' && v ? v.toUpperCase() : v
  }
  return out
}

export function patchIntakeFields(
  row: Pick<IntakeLoadRecord, 'fields' | 'meta' | 'confirmed'>,
  patch: IntakeFieldsPatch,
  confirm: { add: string[]; remove: string[] },
): { fields: IntakeFields; meta: IntakeMeta; confirmed: string[] } {
  const fields: IntakeFields = { ...row.fields, stops: row.fields.stops.map((s) => ({ ...s })) }
  const meta: IntakeMeta = { ...row.meta }
  let confirmed = [...row.confirmed]
  const edited = (key: string) => { meta[key] = { source: 'REVIEWER', confidence: 'high' } }

  for (const key of SCALAR_KEYS) {
    if (!(key in patch)) continue
    const next = normalizeValue(key, (patch as unknown as Row)[key])
    if (next !== (fields as unknown as Row)[key]) {
      ;(fields as unknown as Row)[key] = next
      if (present(next)) edited(key)
      else delete meta[key]
    }
  }

  if (patch.stops) {
    const before = row.fields.stops
    const next = patch.stops.map(normalizeStop)
    next.forEach((stop, i) => {
      for (const k of INTAKE_STOP_KEYS) {
        const key = `stops.${i}.${k}`
        if ((before[i] as unknown as Row | undefined)?.[k] !== (stop as unknown as Row)[k] || before[i]?.type !== stop.type) {
          if (present((stop as unknown as Row)[k])) edited(key)
          else delete meta[key]
        }
      }
    })
    // Provenance of stops that no longer exist must not leak onto whichever stop takes the index next.
    for (const key of Object.keys(meta)) {
      const m = /^stops\.(\d+)\./.exec(key)
      if (m && Number(m[1]) >= next.length) delete meta[key]
    }
    confirmed = confirmed.filter((key) => {
      const m = /^stops\.(\d+)\./.exec(key)
      return !m || Number(m[1]) < next.length
    })
    fields.stops = next
  }

  for (const key of confirm.add) if (!confirmed.includes(key)) confirmed.push(key)
  confirmed = confirmed.filter((key) => !confirm.remove.includes(key))
  return { fields, meta, confirmed }
}

/**
 * Choosing a customer on the review page: the bill-to belongs to the customer it was
 * picked from, so it is replaced by the new customer's (or cleared); the sales rep only
 * fills a blank. Both are marked DEFAULT, never confirmed, and stay required.
 */
export function withCustomerDefaults(
  row: { fields: IntakeFields; meta: IntakeMeta; confirmed: string[] },
  customer: Parameters<typeof customerDefaultsOf>[0],
): { fields: IntakeFields; meta: IntakeMeta; confirmed: string[] } {
  const defaults = customerDefaultsOf(customer)
  const fields: IntakeFields = { ...row.fields }
  const meta: IntakeMeta = { ...row.meta }
  const set = (key: 'billToId' | 'salesRepId', value: string | null) => {
    fields[key] = value
    if (value) meta[key] = { source: 'DEFAULT', confidence: 'high' }
    else delete meta[key]
  }
  set('billToId', defaults.billToId)
  if (!present(fields.salesRepId)) set('salesRepId', defaults.salesRepId)
  return { fields, meta, confirmed: row.confirmed.filter((key) => key !== 'billToId') }
}

/** Keys where the reviewer's draft differs from what automation produced. */
export function correctedKeys(autoFields: IntakeFields, fields: IntakeFields): string[] {
  const out: string[] = []
  for (const key of SCALAR_KEYS) {
    if (normalizeValue(key, valueOf(autoFields, key)) !== normalizeValue(key, valueOf(fields, key))) out.push(key)
  }
  const n = Math.max(autoFields.stops.length, fields.stops.length)
  for (let i = 0; i < n; i += 1) {
    const a = autoFields.stops[i]
    const b = fields.stops[i]
    if (!a || !b || a.type !== b.type) out.push(`stops.${i}.type`)
    for (const k of INTAKE_STOP_KEYS) {
      if (clean((a as unknown as Row | undefined)?.[k]) !== clean((b as unknown as Row | undefined)?.[k])) out.push(`stops.${i}.${k}`)
    }
  }
  return out
}

// ── the shipment it becomes ──────────────────────────────────────────────────

/**
 * The `createShipment` input for a reviewed load. The mapping is `NewShipmentDialog`'s tender path:
 * pickups then deliveries, appointment dates carried (a booked time makes the appointment exact),
 * and — for Batory-style customers (`requiresApptProofs`) — no appointment and no facility
 * instructions, with the request ladder started on the stops. `revDivision` is not a load-bag
 * key (`LOAD_BAG_REFUSED`); the promote action tags it afterwards.
 */
export function toCreateShipmentInput(fields: IntakeFields, ctx: { requiresApptProofs: boolean; runId: string }): Row {
  const ordered = [
    ...fields.stops.filter((s) => s.type === 'pickup'),
    ...fields.stops.filter((s) => s.type === 'delivery'),
  ]
  const stops = ordered.map((s, i) => {
    const city = [clean(s.city), clean(s.state)].filter(Boolean).join(', ')
    const date = clean(s.date)
    const time = clean(s.time)
    const appt = ctx.requiresApptProofs || !date ? '' : time ? fromDateTimeInput(`${date}T${time}`) : fromDateInput(date)
    const stop: Row = {
      id: `${ctx.runId}:stop-${i}`,
      type: s.type,
      ...(clean(s.name) ? { name: clean(s.name) } : {}),
      ...(city ? { city } : {}),
      address: { street: clean(s.street), city: clean(s.city), state: clean(s.state), zip: clean(s.zip) },
      locationId: null,
      appt,
      apptType: 'exact',
      driverId: null,
      sequence: i,
    }
    if (ctx.requiresApptProofs) stop.apptStatus = s.type === 'delivery' ? 'need_book' : 'need_request'
    return stop
  })

  const seen = new Set<string>()
  const notes = ctx.requiresApptProofs
    ? ''
    : ordered
      .filter((s) => clean(s.instructions))
      .map((s) => `${s.type === 'pickup' ? 'Pickup' : 'Delivery'}: ${clean(s.instructions)}`)
      .filter((line) => !seen.has(line) && seen.add(line))
      .join('\n')

  return {
    customerId: fields.customerId,
    source: 'TENDER',
    workflowRunId: ctx.runId,
    load: {
      stops,
      ...(clean(fields.reference) ? { tmsId: clean(fields.reference) } : {}),
      ...(clean(fields.pickupNumber) ? { pickupNumber: clean(fields.pickupNumber) } : {}),
      ...(clean(fields.commodity) ? { commodity: clean(fields.commodity) } : {}),
      ...(typeof fields.weightLb === 'number' ? { weight: Math.round(fields.weightLb) } : {}),
      ...(typeof fields.customerRateCents === 'number' ? { rateCents: Math.round(fields.customerRateCents) } : {}),
      ...(notes ? { notes } : {}),
    },
  }
}

/** "3 of 5 required · 2 to check" inputs: how many gated fields exist, how many are missing, how many are LOW. */
export function intakeCounts(row: IntakeLoadRecord): { required: number; missing: number; toCheck: number } {
  const keys = intakeFieldKeys(row.fields)
  const toCheck = keys.filter((k) => fieldStatusOf(k, row.fields, row.meta, row.confirmed) === 'LOW').length
  const total = REQUIRED_FIELD_CATALOG.filter((f) => !INTAKE_COLLECTABLE_EXCLUDED.includes(f.key)).length
  return { required: total, missing: row.missingFields.length, toCheck }
}
