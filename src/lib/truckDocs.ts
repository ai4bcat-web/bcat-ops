import type { Equipment } from '@/types/equipment'
import type { ComplianceDocument } from '@/types'
import type { DefaultExpirationRule } from './complianceRequirements'

// ── The documents every truck must carry ────────────────────────────────────────
// documentType keys mirror TRUCK_REQUIREMENTS so this shares the compliance backend.
// DOT inspection is special: its date comes from the truck's own `dotInspectionDate`
// field (edited on the Fleet tab), and cadence depends on the fleet.

export interface TruckDocSpec {
  key: string
  label: string
  sub: string
  rule: DefaultExpirationRule
  months?: number
  /** DOT inspection — date sourced from Equipment.dotInspectionDate, cadence by fleet. */
  dot?: boolean
}

export const TRUCK_DOC_SPECS: TruckDocSpec[] = [
  { key: 'insurance_cert',        label: 'Insurance',      sub: 'Cab card / certificate',  rule: 'PLUS_N_MONTHS', months: 12 },
  { key: 'ifta_decals',           label: 'IFTA',           sub: 'License / decals',        rule: 'DEC_31' },
  { key: 'irp_cab_card',          label: 'IRP',            sub: 'Registration / cab card', rule: 'PLUS_N_MONTHS', months: 12 },
  { key: 'annual_dot_inspection', label: 'DOT Inspection', sub: 'Amazon every 2 mo · Ivan yearly', rule: 'PLUS_N_MONTHS', months: 12, dot: true },
]

// ── Date helpers ────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** DOT cadence: Amazon trucks every 2 months, everyone else (Ivan/LOCAL) yearly. */
export function dotMonths(fleetGroup?: string | null): number {
  return fleetGroup === 'AMAZON' ? 2 : 12
}

export function addMonthsStr(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return iso(new Date(y, (m - 1) + months, d))
}

export function defaultExpiration(spec: TruckDocSpec): string {
  const n = new Date()
  if (spec.rule === 'DEC_31') return `${n.getFullYear()}-12-31`
  if (spec.rule === 'AUG_31') return `${n.getFullYear()}-08-31`
  return iso(new Date(n.getFullYear(), n.getMonth() + (spec.months ?? 12), n.getDate()))
}

export type DocState = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'MISSING' | 'WAIVED'

export function statusFromExpiration(exp?: string | null): DocState {
  if (!exp) return 'VALID'
  const today = iso(new Date())
  if (exp < today) return 'EXPIRED'
  const soon = new Date(); soon.setDate(soon.getDate() + 30)
  return exp <= iso(soon) ? 'EXPIRING_SOON' : 'VALID'
}

export interface DocEval {
  state: DocState
  expiration: string | null   // for DOT this is the computed next-due date
  lastDot?: string | null     // DOT only — the last inspection date from the truck
  doc?: ComplianceDocument    // backing compliance record, if any (upload or waive marker)
}

/**
 * Single source of truth for a truck+document's status, used by both the page and the
 * sidebar alert badge. `doc` is the latest ComplianceDocument for that truck+type, if any.
 */
export function evaluateTruckDoc(truck: Equipment, spec: TruckDocSpec, doc?: ComplianceDocument): DocEval {
  if (doc?.status === 'WAIVED') return { state: 'WAIVED', expiration: null, doc }

  if (spec.dot) {
    const last = truck.dotInspectionDate || null
    if (!last) return { state: 'MISSING', expiration: null, lastDot: null }
    const nextDue = addMonthsStr(last, dotMonths(truck.fleetGroup))
    return { state: statusFromExpiration(nextDue), expiration: nextDue, lastDot: last, doc }
  }

  if (!doc?.s3Key) return { state: 'MISSING', expiration: null, doc }
  return { state: statusFromExpiration(doc.expirationDate), expiration: doc.expirationDate ?? null, doc }
}

/** True when this doc counts against the fleet (needs a file/date and isn't waived). */
export function isOutstanding(state: DocState): boolean {
  return state === 'MISSING' || state === 'EXPIRED'
}
