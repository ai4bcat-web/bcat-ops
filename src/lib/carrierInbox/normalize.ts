/**
 * Step AL §4.1 — post-processing of the model's output. The model is never trusted for a
 * value that has a format: MC/DOT become digits, states two letters, equipment an AB code,
 * the rate a validated integer, flags are computed here. Pure.
 */
import type { SpotEquipmentCode } from '../../types/tms'
import { isFreemail } from '../crm/domains'
import { normalizeState } from '../laneMatch'
import { normalizePro } from '../proNumber'
import { normalizeEquipment, normalizeIsoDate, stripUrls } from '../spot/normalize'
import type {
  InboundCarrier, InboundConfidence, InboundExtraction, InboundFlag, InboundKind, InboundPlace,
} from './types'

/**
 * The model's answer after `fromSentinels()` (`''` / `-1` -> null). The normalizer also
 * tolerates the sentinels and missing keys, so a lazy caller cannot leak them downstream.
 */
export interface RawInboundModelOutput {
  kind?: string | null
  confidence?: string | null
  reason?: string | null
  loadRefs?: string[] | null
  postingRef?: string | null
  originCity?: string | null
  originState?: string | null
  destCity?: string | null
  destState?: string | null
  pickupDate?: string | null
  equipment?: string | null
  /** TOTAL dollars the carrier will haul it for. */
  rateDollars?: number | null
  /** Dollars per mile; never multiplied into a total. */
  ratePerMileDollars?: number | null
  availableAt?: string | null
  trucks?: number | null
  carrierName?: string | null
  mcNumber?: string | null
  dotNumber?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  notes?: string | null
  lowConfidence?: string[] | null
}

export interface NormalizeContext {
  receivedAt: string
  senderEmail: string | null
  authOk: boolean
  boardProvider: string | null
  postingRateCents?: number | null
}

export const MIN_RATE_DOLLARS = 50
export const MAX_RATE_DOLLARS = 25_000

const KINDS: readonly InboundKind[] = ['OFFER', 'INTEREST', 'WITHDRAW', 'NOT_RELEVANT']
const CONFIDENCES: readonly InboundConfidence[] = ['high', 'medium', 'low']

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

/** A number, or null for null/undefined/NaN/the `-1` sentinel. Numeric strings are accepted. */
function amount(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') n = Number(value.replace(/[$,\s]/g, ''))
  else return null
  return Number.isFinite(n) && n !== -1 ? n : null
}

const IDENTITY_LABEL = /^\s*(?:us\s*)?(?:mc|dot|usdot|mx|ff)\s*(?:#|no\.?|number)?\s*[-:#]?\s*/i

/** "MC-0123456" / "MC# 0123456" -> "123456"; fewer than 3 or more than 8 digits -> null. */
export function normalizeIdentityNumber(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const rest = String(value).replace(IDENTITY_LABEL, '')
  const run = /^\d[\d\s,.-]*/.exec(rest)
  if (!run) return null
  const digits = run[0].replace(/\D/g, '').replace(/^0+/, '')
  return digits.length >= 3 && digits.length <= 8 ? digits : null
}

/** E.164 when it parses (10 digits -> +1, 11 starting with 1 -> +1, "+<8..15 digits>"); else null. */
export function normalizePhoneE164(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '')
  if (value.trim().startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

function emailOf(value: unknown): string | null {
  const t = text(value, 320)?.toLowerCase() ?? null
  return t && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(t) ? t : null
}

function placeOf(city: unknown, state: unknown): InboundPlace | null {
  const c = text(city, 80)
  const s = normalizeState(typeof state === 'string' ? state : null) || null
  return c || s ? { city: c, state: s } : null
}

export function normalizeInboundExtraction(raw: RawInboundModelOutput, ctx: NormalizeContext): InboundExtraction {
  const flags: InboundFlag[] = []
  const kindIn = String(raw.kind ?? '').trim().toUpperCase() as InboundKind
  let kind: InboundKind = KINDS.includes(kindIn) ? kindIn : 'NOT_RELEVANT'
  const confidenceIn = String(raw.confidence ?? '').trim().toLowerCase() as InboundConfidence
  const confidence: InboundConfidence = CONFIDENCES.includes(confidenceIn) ? confidenceIn : 'low'

  // Rate: a stated total outside 50..25 000 dollars is invalid, never clamped.
  const dollars = amount(raw.rateDollars)
  let rateCents: number | null = null
  if (dollars != null) {
    if (dollars >= MIN_RATE_DOLLARS && dollars <= MAX_RATE_DOLLARS) rateCents = Math.round(dollars * 100)
    else flags.push('RATE_INVALID')
  }
  const perMile = amount(raw.ratePerMileDollars)
  const ratePerMileCents = perMile != null && perMile >= 0.1 && perMile <= 20 ? Math.round(perMile * 100) : null
  // An offer states a price; without a usable total it is an inquiry (a rep can still Log offer).
  if (kind === 'OFFER' && rateCents == null) kind = 'INTEREST'
  const postingRate = ctx.postingRateCents ?? null
  if (rateCents != null && postingRate != null && postingRate > 0 && (rateCents < postingRate * 0.2 || rateCents > postingRate * 3)) {
    flags.push('RATE_OUTLIER')
  }

  const loadRefs: string[] = []
  for (const ref of raw.loadRefs ?? []) {
    const key = typeof ref === 'string' ? normalizePro(ref) : null
    if (key && !loadRefs.includes(key) && loadRefs.length < 5) loadRefs.push(key)
  }
  const postingRef = text(raw.postingRef, 60)

  const equipmentText = text(raw.equipment, 80)
  const equipment: SpotEquipmentCode | null = equipmentText ? normalizeEquipment(equipmentText)?.code ?? null : null
  const trucksN = amount(raw.trucks)
  const sender = ctx.senderEmail?.trim().toLowerCase() || null

  const carrier: InboundCarrier = {
    name: text(raw.carrierName, 120),
    mc: normalizeIdentityNumber(raw.mcNumber),
    dot: normalizeIdentityNumber(raw.dotNumber),
    contactName: text(raw.contactName, 80),
    // A board relay's sender address is the board's, not the carrier's.
    email: emailOf(raw.contactEmail) ?? (ctx.boardProvider ? null : emailOf(sender)),
    phone: normalizePhoneE164(raw.contactPhone),
  }

  if (!carrier.mc) flags.push('NO_MC')
  if (sender && !ctx.authOk) flags.push('SENDER_UNVERIFIED')
  const senderDomain = sender ? sender.slice(sender.lastIndexOf('@') + 1) : ''
  if (senderDomain && isFreemail(senderDomain)) flags.push('FREEMAIL_SENDER')
  if (ctx.boardProvider) flags.push('BOARD_RELAY')
  if (loadRefs.length === 0 && !postingRef) flags.push('NO_LOAD_REF')

  const lowConfidence: string[] = []
  for (const key of raw.lowConfidence ?? []) {
    const k = text(key, 40)
    if (k && !lowConfidence.includes(k) && lowConfidence.length < 20) lowConfidence.push(k)
  }
  const notes = text(raw.notes, 600)

  return {
    kind,
    confidence,
    reason: text(raw.reason, 200) ?? '',
    loadRefs,
    postingRef,
    origin: placeOf(raw.originCity, raw.originState),
    destination: placeOf(raw.destCity, raw.destState),
    pickupDate: normalizeIsoDate(raw.pickupDate ?? undefined, ctx.receivedAt),
    equipment,
    rateCents,
    ratePerMileCents,
    availableAt: text(raw.availableAt, 80),
    trucks: trucksN != null && Number.isInteger(trucksN) && trucksN >= 1 && trucksN <= 999 ? trucksN : null,
    carrier,
    notes: notes ? text(stripUrls(notes), 300) : null,
    lowConfidence,
    flags,
  }
}
