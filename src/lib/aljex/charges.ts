/**
 * Charge-line classification. The Aljex `Code` carries no catalogue information (only `F`/`2`),
 * the Description does, so classification is by description through the profile's map
 * (ALJEX_MAPPING.md §4.4). Invariant: Σ customer charge extensions = Invoice Amount on every row.
 */
import type { CanonicalCharge, CanonicalProjectedExpense, CanonicalRow } from './canonical'
import { normalizeLabel, type AljexProfile } from './profile'

export interface ClassifiedCharge {
  /** CHARGE = a priced line; NOTE = a description-only line printed on the invoice; SKIP = empty. */
  kind: 'CHARGE' | 'NOTE' | 'SKIP'
  code: string
  label: string
  isRate: boolean
  amountCents: number
  /** Set only when units x rate multiplies out to the extension exactly. */
  rateCents: number | null
  count: number
}

export const LINEHAUL = 'LINEHAUL'

/** Digits-with-optional-decimals units -> number (0 when not numeric). */
function numericUnits(units: string): number {
  const s = units.replace(/,/g, '').trim()
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : 0
}

export function classifyCharge(c: CanonicalCharge, profile: AljexProfile): ClassifiedCharge {
  const description = c.description.trim()
  const amountCents = c.extensionCents
  if (amountCents === 0) {
    return {
      kind: description && c.line !== 1 ? 'NOTE' : 'SKIP',
      code: '',
      label: description,
      isRate: false,
      amountCents: 0,
      rateCents: null,
      count: 1,
    }
  }
  let code: string
  let label: string
  let isRate = false
  if (c.line === 1) {
    code = LINEHAUL
    label = 'Line haul'
    isRate = true
  } else {
    const mapped = profile.chargeDescriptionMap[normalizeLabel(description)]
    if (mapped) {
      code = mapped.code
      label = mapped.label ?? description
      isRate = mapped.isRate
    } else if (description && new RegExp(profile.fuelPattern, 'i').test(description)) {
      code = 'FSC'
      label = 'Fuel surcharge'
      isRate = true
    } else {
      code = 'ACCESSORIAL'
      label = description || 'Aljex charge'
    }
  }
  const units = numericUnits(c.units)
  let rateCents: number | null = null
  let count = 1
  if (c.line !== 1 && units > 0 && units !== 1 && c.rateCents != null && Math.round(units * c.rateCents) === amountCents) {
    rateCents = c.rateCents
    count = units
  }
  return { kind: 'CHARGE', code, label, isRate, amountCents, rateCents, count }
}

/** Σ of all 21 charge-line extensions: equals `Invoice Amount` on every row of the export. */
export function customerChargeTotal(row: Pick<CanonicalRow, 'charges'>): number {
  return row.charges.reduce((sum, c) => sum + c.extensionCents, 0)
}

/** Carrier-side projected expense line -> charge code via `Type n` (line 1 is `LINE` = line haul). */
export function classifyProjected(p: CanonicalProjectedExpense, profile: AljexProfile): { code: string; label: string; isRate: boolean } {
  const type = p.type.trim().toUpperCase()
  const mapped = profile.projectedTypeMap[type] ?? (p.n === 1 && !type ? profile.projectedTypeMap.LINE : undefined)
  if (mapped) return { code: mapped.code, label: mapped.label ?? (type || mapped.code), isRate: mapped.isRate }
  return { code: 'ACCESSORIAL', label: type || p.payee || 'Aljex expense', isRate: false }
}
