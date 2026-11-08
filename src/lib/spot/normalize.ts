/**
 * Step AB §3.3 — post-processing of the model's output. The model is never trusted for a
 * value that has a format: states, ZIPs, dates, weights and equipment are validated here,
 * and every field carries `{source, confidence}` (Intake's vocabulary).
 *
 * Also holds the field-presence rules (`missingRequired`, `requestStatusFor`) that
 * `fields.ts` re-exports. Pure; relative imports only.
 */
import type {
  SpotClassification,
  SpotEquipmentCode,
  SpotExtraction,
  SpotFieldMeta,
  SpotFieldMetaEntry,
  SpotRequestMode,
  SpotStop,
} from '../../types/tms'
import { mapAccessorials } from './accessorials'
import { stripControl } from './text'

// ── Field keys (the fieldMeta keys) ──────────────────────────────────────────
export const SPOT_FIELD_KEYS = [
  'origin', 'destination', 'equipment', 'pickupDate', 'deliveryDate',
  'weightLbs', 'commodity', 'accessorials', 'lengthFt', 'mode',
] as const
export type SpotFieldKey = (typeof SPOT_FIELD_KEYS)[number]

/** A suggestion needs all of these; otherwise the request is NEEDS_INFO. */
export const REQUIRED_SPOT_FIELDS: readonly SpotFieldKey[] = ['origin', 'destination', 'equipment', 'pickupDate']

// ── Raw model output ─────────────────────────────────────────────────────────
export interface RawSpotModelOutput {
  kind: 'QUOTE_REQUEST' | 'FOLLOW_UP' | 'NOT_A_REQUEST'
  confidence: 'high' | 'medium' | 'low'
  reason: string
  customerName?: string | null
  contactName?: string | null
  contactPhone?: string | null
  stops?: Array<{
    type?: string | null
    name?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    dateStr?: string | null
    time?: string | null
  }> | null
  pickupDate?: string | null
  deliveryDate?: string | null
  equipment?: string | null
  lengthFt?: number | null
  mode?: string | null
  weightLbs?: number | string | null
  pieces?: number | null
  commodity?: string | null
  temperatureF?: string | null
  hazmat?: string | null
  accessorials?: string[] | null
  targetRateDollars?: number | null
  notes?: string | null
  lowConfidence?: string[] | null
}

// ── States ───────────────────────────────────────────────────────────────────
const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY',
  LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
  ALBERTA: 'AB', 'BRITISH COLUMBIA': 'BC', MANITOBA: 'MB', 'NEW BRUNSWICK': 'NB',
  'NEWFOUNDLAND AND LABRADOR': 'NL', 'NOVA SCOTIA': 'NS', ONTARIO: 'ON', 'PRINCE EDWARD ISLAND': 'PE',
  QUEBEC: 'QC', SASKATCHEWAN: 'SK',
}
const STATE_CODES = new Set(Object.values(STATE_NAMES))

/** A 2-letter US/CA code, or null. Full state names are mapped. */
export function normalizeState(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/\./g, '').toUpperCase()
  if (STATE_CODES.has(text)) return text
  return STATE_NAMES[text] ?? null
}

/** `12345` or `12345-6789`; anything else is null. */
export function normalizeZip(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const digits = String(value).trim().replace(/[\s-]/g, '')
  if (/^\d{5}$/.test(digits)) return digits
  if (/^\d{9}$/.test(digits)) return `${digits.slice(0, 5)}-${digits.slice(5)}`
  return null
}

// ── Dates ────────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000

/**
 * `YYYY-MM-DD`, a real calendar date, not before (mail date − 1 day) and not more than
 * 120 days after it. Returns null when it fails either test.
 */
export function normalizeIsoDate(value: unknown, mailDate: string): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null
  const text = value.trim()
  const at = Date.parse(`${text}T00:00:00Z`)
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== text) return null
  const base = Date.parse(`${(mailDate ?? '').slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(base)) return text
  if (at < base - DAY_MS || at > base + 120 * DAY_MS) return null
  return text
}

// ── Weight ───────────────────────────────────────────────────────────────────
/** 1–80 000 lb. Accepts numbers and strings like `42k`, `42,000 lbs`. */
export function normalizeWeight(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') {
    const m = value.trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*(k)?\s*(lbs?|pounds?)?$/)
    if (!m) return null
    n = Number(m[1]) * (m[2] ? 1000 : 1)
  } else return null
  if (!Number.isFinite(n)) return null
  n = Math.round(n)
  return n >= 1 && n <= 80_000 ? n : null
}

// ── Equipment ────────────────────────────────────────────────────────────────
const EQUIPMENT_ALIASES: Array<[SpotEquipmentCode, RegExp]> = [
  ['POWER_ONLY', /power\s*-?\s*only/],
  ['STEPDECK', /step\s*-?\s*deck|drop\s*-?\s*deck/],
  ['CONESTOGA', /conestoga|\bconestoga\b/],
  ['FLATBED', /flat\s*-?\s*bed|\bflat\b/],
  ['REEFER', /reefer|refrigerat|temp(erature)?\s*-?\s*controlled/],
  ['BOX_TRUCK', /box\s*truck|straight\s*truck|\b26\s*'?\s*(ft|foot)?\s*box/],
  ['SPRINTER', /sprinter|cargo\s*van/],
  ['VAN', /dry\s*-?\s*van|\bvan\b|\b53\s*'|\b48\s*'|53\s*(ft|foot)|dry\s+box|\btruckload\b/],
]

export interface NormalizedEquipment {
  code: SpotEquipmentCode
  lengthFt: number | null
}

export function normalizeEquipment(value: unknown): NormalizedEquipment | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const lower = value.trim().toLowerCase()
  const lengthMatch = lower.match(/\b(48|53)\s*(?:'|ft|foot|feet)?/)
  let code: SpotEquipmentCode = 'OTHER'
  for (const [c, re] of EQUIPMENT_ALIASES) {
    if (re.test(lower)) { code = c; break }
  }
  return { code, lengthFt: lengthMatch ? Number(lengthMatch[1]) : null }
}

// ── Text ─────────────────────────────────────────────────────────────────────
export function stripUrls(text: string): string {
  return text.replace(/(?:https?:\/\/|www\.)\S+/gi, '').replace(/\s{2,}/g, ' ').trim()
}

function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = stripUrls(stripControl(value)).slice(0, max).trim()
  return text || null
}

export function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
}

function cleanCity(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = stripControl(value).replace(/\s+/g, ' ').trim().slice(0, 60)
  return text ? titleCase(text) : null
}

// ── Presence rules (re-exported by fields.ts) ────────────────────────────────
function cityStateOf(stop: SpotStop | undefined): boolean {
  return Boolean(stop?.city && stop?.state)
}

export function originStop(e: SpotExtraction): SpotStop | undefined {
  return e.stops.find((s) => s.type === 'PICKUP') ?? e.stops[0]
}

export function destinationStop(e: SpotExtraction): SpotStop | undefined {
  if (e.stops.length < 2) return undefined
  for (let i = e.stops.length - 1; i >= 0; i -= 1) {
    if (e.stops[i].type === 'DELIVERY') return e.stops[i]
  }
  return e.stops[e.stops.length - 1]
}

export function fieldValuePresent(key: string, e: SpotExtraction): boolean {
  switch (key) {
    case 'origin': return cityStateOf(originStop(e))
    case 'destination': return cityStateOf(destinationStop(e))
    case 'equipment': return e.equipmentType != null
    case 'pickupDate': return Boolean(e.pickupDate)
    case 'deliveryDate': return Boolean(e.deliveryDate)
    case 'weightLbs': return e.weightLbs != null
    case 'commodity': return Boolean(e.commodity)
    case 'accessorials': return (e.accessorials ?? []).length > 0
    case 'lengthFt': return e.lengthFt != null
    case 'mode': return e.mode != null
    default: return false
  }
}

/** Required fields that are absent or INVALID (the "Needs:" line). */
export function missingRequired(e: SpotExtraction, meta: SpotFieldMeta): string[] {
  return REQUIRED_SPOT_FIELDS.filter((key) => !fieldValuePresent(key, e) || meta[key]?.invalid)
}

export function requestStatusFor(missing: readonly string[]): 'NEW' | 'NEEDS_INFO' {
  return missing.length > 0 ? 'NEEDS_INFO' : 'NEW'
}

// ── The main entry ───────────────────────────────────────────────────────────
const LOW_CONFIDENCE_ALIASES: Record<string, SpotFieldKey[]> = {
  stops: ['origin', 'destination'],
  origin: ['origin'], pickup: ['origin'], origincity: ['origin'], originstate: ['origin'], originzip: ['origin'],
  destination: ['destination'], delivery: ['destination'], destinationcity: ['destination'],
  destinationstate: ['destination'], destinationzip: ['destination'],
  equipment: ['equipment'], equipmenttype: ['equipment'], lengthft: ['lengthFt'],
  pickupdate: ['pickupDate'], deliverydate: ['deliveryDate'], weightlbs: ['weightLbs'], weight: ['weightLbs'],
  commodity: ['commodity'], accessorials: ['accessorials'], mode: ['mode'],
}

const MODES: SpotRequestMode[] = ['FTL', 'LTL', 'PARTIAL', 'DRAYAGE', 'OTHER']

export interface NormalizedSpot {
  extraction: SpotExtraction
  fieldMeta: SpotFieldMeta
  missingFields: string[]
  status: 'NEW' | 'NEEDS_INFO'
  classification: SpotClassification
}

export function normalizeExtraction(raw: RawSpotModelOutput, ctx: { mailDate: string }): NormalizedSpot {
  const meta: SpotFieldMeta = {}
  const modelLow = new Set<SpotFieldKey>()
  for (const item of raw.lowConfidence ?? []) {
    for (const key of LOW_CONFIDENCE_ALIASES[String(item).replace(/[^A-Za-z]/g, '').toLowerCase()] ?? []) modelLow.add(key)
  }
  const overallHigh = raw.confidence === 'high'
  const setMeta = (key: SpotFieldKey, source: SpotFieldMetaEntry['source'], invalid = false) => {
    const required = (REQUIRED_SPOT_FIELDS as readonly string[]).includes(key)
    const low = invalid || modelLow.has(key) || source === 'DEFAULT' || (required && !overallHigh)
    meta[key] = { source, confidence: low ? 'low' : 'high', ...(invalid ? { invalid: true } : {}) }
  }

  // Stops
  let originInvalid = false
  let destInvalid = false
  const stops: SpotStop[] = []
  for (const s of (raw.stops ?? []).slice(0, 12)) {
    if (!s || typeof s !== 'object') continue
    const type: SpotStop['type'] = String(s.type ?? '').toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'
    const stateRaw = typeof s.state === 'string' && s.state.trim() ? s.state : null
    const zipRaw = typeof s.zip === 'string' && s.zip.trim() ? s.zip : null
    const state = normalizeState(stateRaw)
    const zip = normalizeZip(zipRaw)
    stops.push({
      type,
      name: cleanLine(s.name, 80),
      city: cleanCity(s.city),
      state,
      zip,
      dateStr: normalizeIsoDate(s.dateStr, ctx.mailDate),
      time: cleanLine(s.time, 20),
    })
    const bad = (stateRaw != null && state == null) || (zipRaw != null && zip == null)
    if (bad) {
      if (type === 'DELIVERY') destInvalid = true
      else originInvalid = true
    }
  }
  setMeta('origin', 'MODEL', originInvalid)
  setMeta('destination', 'MODEL', destInvalid)

  // Dates
  const pickupRaw = raw.pickupDate ?? stops.find((s) => s.type === 'PICKUP' && s.dateStr)?.dateStr ?? null
  const pickupDate = normalizeIsoDate(pickupRaw, ctx.mailDate)
  setMeta('pickupDate', 'MODEL', pickupRaw != null && pickupDate == null)
  const deliveryRaw = raw.deliveryDate ?? [...stops].reverse().find((s) => s.type === 'DELIVERY' && s.dateStr)?.dateStr ?? null
  const deliveryDate = normalizeIsoDate(deliveryRaw, ctx.mailDate)
  setMeta('deliveryDate', 'MODEL', deliveryRaw != null && deliveryDate == null)

  // Equipment (+ length)
  const eq = normalizeEquipment(raw.equipment)
  let lengthFt: number | null = typeof raw.lengthFt === 'number' && (raw.lengthFt === 48 || raw.lengthFt === 53) ? raw.lengthFt : eq?.lengthFt ?? null
  let lengthDefaulted = false
  if (lengthFt == null && eq && (eq.code === 'VAN' || eq.code === 'REEFER')) {
    lengthFt = 53
    lengthDefaulted = true
  }
  setMeta('equipment', 'MODEL')
  if (eq?.code === 'OTHER') meta.equipment = { ...meta.equipment, confidence: 'low' }
  setMeta('lengthFt', lengthDefaulted ? 'DEFAULT' : 'MODEL')

  // Weight
  const weightLbs = normalizeWeight(raw.weightLbs)
  const weightGiven = raw.weightLbs != null && raw.weightLbs !== ''
  setMeta('weightLbs', 'MODEL', weightGiven && weightLbs == null)

  // Mode
  const modeText = String(raw.mode ?? '').toUpperCase()
  const modeGiven = (MODES as string[]).includes(modeText) ? (modeText as SpotRequestMode) : null
  const mode: SpotRequestMode | null = modeGiven ?? 'FTL'
  setMeta('mode', modeGiven ? 'MODEL' : 'DEFAULT')

  // Accessorials, hazmat, commodity
  const accessorials = mapAccessorials(raw.accessorials)
  const hazmat: SpotExtraction['hazmat'] =
    String(raw.hazmat ?? '').toUpperCase() === 'YES' || accessorials.includes('HAZMAT')
      ? 'YES'
      : String(raw.hazmat ?? '').toUpperCase() === 'NO' ? 'NO' : null
  setMeta('accessorials', 'MODEL')
  const commodity = cleanLine(raw.commodity, 60)
  setMeta('commodity', 'MODEL')

  const target = typeof raw.targetRateDollars === 'number' && Number.isFinite(raw.targetRateDollars) && raw.targetRateDollars > 0
    ? raw.targetRateDollars : null
  const phone = typeof raw.contactPhone === 'string' ? raw.contactPhone.replace(/[^\d+()\-.\sx]/gi, '').trim().slice(0, 30) || null : null
  const pieces = typeof raw.pieces === 'number' && Number.isFinite(raw.pieces) && raw.pieces > 0 ? Math.round(raw.pieces) : null

  const extraction: SpotExtraction = {
    customerName: cleanLine(raw.customerName, 120),
    contactName: cleanLine(raw.contactName, 80),
    contactPhone: phone,
    stops,
    pickupDate,
    deliveryDate,
    equipment: cleanLine(raw.equipment, 60),
    equipmentType: eq?.code ?? null,
    lengthFt,
    mode,
    weightLbs,
    pieces,
    commodity,
    temperatureF: cleanLine(raw.temperatureF, 30),
    hazmat,
    accessorials,
    targetRateDollars: target,
    notes: cleanLine(raw.notes, 400),
  }

  const missingFields = missingRequired(extraction, meta)
  return {
    extraction,
    fieldMeta: meta,
    missingFields,
    status: requestStatusFor(missingFields),
    classification: {
      kind: raw.kind,
      confidence: raw.confidence,
      reason: cleanLine(raw.reason, 200) ?? '',
    },
  }
}
