/**
 * Step AG — reference and name normalisers shared by the matcher and the planner. Pure.
 */
import { normalizeName } from '../tmsDirectory'
import { normalizePro } from '../proNumber'
import type { LedgerAssignment, LedgerBill } from './types'

/** Alphanumerics, upper-case. `INV-0042` ≡ `inv 0042`. Null for blank / too short (< 2). */
export function normalizeRef(value: string | null | undefined): string | null {
  const key = (value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return key.length >= 2 ? key : null
}

/** Digits only (`MC-123456` → `123456`); leading zeros dropped; null when empty. */
export function digitsOf(value: string | null | undefined): string | null {
  const d = (value ?? '').replace(/\D+/g, '').replace(/^0+/, '')
  return d.length > 0 ? d : null
}

const NAME_NOISE = new Set(['llc', 'inc', 'corp', 'co', 'transport', 'trucking', 'logistics', 'freight', 'lines', 'express', 'the', 'and'])

function tokensOf(name: string): string[] {
  return normalizeName(name).split(' ').filter((t) => t && !NAME_NOISE.has(t))
}

/** Token-set Dice coefficient after dropping company-form noise words. 0 when either is empty. */
export function nameDice(a: string, b: string): number {
  const ta = new Set(tokensOf(a))
  const tb = new Set(tokensOf(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared += 1
  return (2 * shared) / (ta.size + tb.size)
}

/** Exact match after `normalizeName`. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const x = normalizeName(a)
  return x !== '' && x === normalizeName(b)
}

/** One name contains the other after `normalizeName` (remit-to comparison). */
export function namesOverlap(a: string, b: string): boolean {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}

export type AmountRelation = 'EXACT' | 'NEAR' | 'FAR' | 'UNKNOWN'

/** |email − ref| <= max(100¢, 0.5 %) exact; beyond 25 % far; else near. */
export function amountRelation(emailCents: number | null, refCents: number | null): AmountRelation {
  if (emailCents == null || refCents == null) return 'UNKNOWN'
  const diff = Math.abs(emailCents - refCents)
  if (diff <= Math.max(100, Math.round(refCents * 0.005))) return 'EXACT'
  if (refCents > 0 && diff / refCents > 0.25) return 'FAR'
  if (refCents === 0) return 'FAR'
  return 'NEAR'
}

/** Strong PRO keys of a bill's load: shipment number, load number, Aljex id (all `normalizePro`ed). */
export function billStrongPros(bill: Pick<LedgerBill, 'shipmentNumber' | 'loadNumber' | 'aljexId'>): string[] {
  const out: string[] = []
  for (const v of [bill.shipmentNumber, bill.loadNumber, bill.aljexId]) {
    const k = normalizePro(v)
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

export function assignmentStrongPros(a: Pick<LedgerAssignment, 'shipmentNumber' | 'aljexId'>): string[] {
  return billStrongPros({ shipmentNumber: a.shipmentNumber, aljexId: a.aljexId })
}

/**
 * "The bill had none": a blank invoice number, or the load's own PRO (Aljex imports carry the PRO as
 * the bill number). A real, differing number is never a placeholder — a person's entry wins.
 */
export function isPlaceholderBill(bill: Pick<LedgerBill, 'billNumber' | 'shipmentNumber' | 'loadNumber' | 'aljexId'>): boolean {
  const n = (bill.billNumber ?? '').trim()
  if (n === '') return true
  const pro = normalizePro(n)
  return pro != null && billStrongPros(bill).includes(pro)
}
