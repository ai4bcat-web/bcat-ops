/**
 * "Was this load already built?" for the Intake queue. An intake row's reference numbers (the parsed Reference, the pickup and delivery
 * numbers, and number-looking words in the subject) are compared with the shipments that already have a PRO. A shipment's `searchKey` is its
 * lower-cased PRO, customer, cities and every reference value joined by spaces, so the match is on whole words of that key, never a
 * substring ("12345" does not match inside "512345"). Punctuation is ignored ("FR-113188-3" = "fr1131883"). When both sides know the
 * customer and they differ, it is not the same load. Read-time only: nothing is stored on the intake row.
 */
import { NOT_DUPLICATE_TOKEN, isDeletedIntake } from './intakeDup'
import type { IntakeLoadRecord } from '../types/intake'

/** What the match needs of a shipment: the narrow read of the Shipment table. */
export interface BuiltShipment {
  id: string
  number: string | null
  customerId: string | null
  customerName?: string | null
  searchKey: string | null
  voidedAt?: string | null
  deletedAt?: string | null
}

export interface RefCandidate {
  /** As written (trimmed). */
  value: string
  /** Lower case, letters and digits only. */
  norm: string
  /** `reference`: a field the e-mail was parsed into. `subject`: a number-looking word of the subject line (weaker). */
  source: 'reference' | 'subject'
}

export interface BuiltMatch {
  shipmentId: string
  number: string
  customerName: string | null
  value: string
  source: RefCandidate['source']
}

const MIN_NORM_LENGTH = 5

export const normRef = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** A date such as 20261111 or a bare year-month-day is not a reference. */
function looksLikeDate(norm: string): boolean {
  if (!/^\d{8}$/.test(norm)) return false
  const y = Number(norm.slice(0, 4)); const m = Number(norm.slice(4, 6)); const d = Number(norm.slice(6, 8))
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31
}

function usable(norm: string): boolean {
  return norm.length >= MIN_NORM_LENGTH && /\d/.test(norm) && !looksLikeDate(norm)
}

/** Reference-looking words of a subject: 5+ letters/digits with at least one digit ("23022601LN", "69902922"). */
export function subjectTokens(subject: string | null | undefined): string[] {
  const words = String(subject ?? '').match(/[A-Za-z0-9][A-Za-z0-9\-_/.]*[A-Za-z0-9]/g) ?? []
  return words.filter((w) => usable(normRef(w)))
}

export function refCandidates(row: Pick<IntakeLoadRecord, 'fields' | 'subject'>): RefCandidate[] {
  const out = new Map<string, RefCandidate>()
  const add = (value: string | null | undefined, source: RefCandidate['source']) => {
    const v = String(value ?? '').trim()
    const norm = normRef(v)
    if (!v || !usable(norm)) return
    const have = out.get(norm)
    // The same number from a parsed field and the subject counts as the stronger source.
    if (!have || (have.source === 'subject' && source === 'reference')) out.set(norm, { value: v, norm, source })
  }
  add(row.fields?.reference, 'reference')
  add(row.fields?.pickupNumber, 'reference')
  add(row.fields?.deliveryNumber, 'reference')
  for (const t of subjectTokens(row.subject)) add(t, 'subject')
  return [...out.values()]
}

/** Whole-word tokens of a shipment's search key, normalised; the leading PRO is left out (a reference equal to a PRO is not a reference). */
export function keyTokens(searchKey: string | null | undefined, number: string | null | undefined): Set<string> {
  const words = String(searchKey ?? '').split(/\s+/).filter(Boolean)
  const pro = normRef(number)
  const out = new Set<string>()
  let skippedPro = false
  for (const w of words) {
    const n = normRef(w)
    if (!n) continue
    if (!skippedPro && pro && n === pro) { skippedPro = true; continue }
    out.add(n)
  }
  return out
}

/** The rows worth checking: open, not yet a shipment, not deleted, not marked "not a duplicate". */
export function needsBuiltCheck(row: IntakeLoadRecord): boolean {
  return row.status === 'OPEN' && !row.shipmentId && !isDeletedIntake(row) && !(row.confirmed ?? []).includes(NOT_DUPLICATE_TOKEN)
}

/** Matches of one row among shipments. Live shipments only (a voided one is not "already built"). */
export function builtMatchesFor(row: IntakeLoadRecord, shipments: readonly BuiltShipment[], tokenCache?: Map<string, Set<string>>): BuiltMatch[] {
  if (!needsBuiltCheck(row)) return []
  const cands = refCandidates(row)
  if (cands.length === 0) return []
  const customerId = row.fields?.customerId ?? null
  const found = new Map<string, BuiltMatch>()
  for (const s of shipments) {
    if (!s.number || s.voidedAt || s.deletedAt || s.id === row.shipmentId) continue
    if (customerId && s.customerId && customerId !== s.customerId) continue
    let tokens = tokenCache?.get(s.id)
    if (!tokens) { tokens = keyTokens(s.searchKey, s.number); tokenCache?.set(s.id, tokens) }
    for (const c of cands) {
      if (!tokens.has(c.norm)) continue
      const prev = found.get(s.id)
      if (!prev || (prev.source === 'subject' && c.source === 'reference')) {
        found.set(s.id, { shipmentId: s.id, number: s.number, customerName: s.customerName ?? null, value: c.value, source: c.source })
      }
    }
  }
  // A parsed reference outranks a subject word; then newest PRO first.
  return [...found.values()].sort((a, b) => (a.source === b.source ? 0 : a.source === 'reference' ? -1 : 1) || b.number.localeCompare(a.number, undefined, { numeric: true }))
}
