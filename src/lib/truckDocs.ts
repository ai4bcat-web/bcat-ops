import type { Equipment, FleetGroup } from '@/types/equipment'
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
  /** A photo of the asset rather than paperwork — never expires, no date to confirm. */
  photo?: boolean
  /**
   * Which asset type this document belongs to. Omitted = both, which is how every
   * original spec behaves, so adding this field changed nothing that already existed.
   */
  appliesTo?: 'truck' | 'trailer'
  /**
   * Restrict this document to certain fleets. Omitted = every fleet. The I-PASS
   * transponder is only carried by Local and Box Truck units.
   */
  fleets?: FleetGroup[]
}

/**
 * Every document a truck carries — the SINGLE source of truth, shared by the Asset
 * Documents page, the Files hub (via src/lib/fileHub.ts) and the sidebar alert badge.
 * Add a document here once and it appears in all of them, backed by the same
 * ComplianceDocument record, so an upload on either page shows up on the other.
 *
 * Never rename a `key`: it is the stored documentType and renaming orphans every file
 * already uploaded under it.
 */
export const TRUCK_DOC_SPECS: TruckDocSpec[] = [
  { key: 'insurance_cert',        label: 'Insurance',      sub: 'Cab card / certificate',  rule: 'PLUS_N_MONTHS', months: 12 },
  { key: 'ifta_decals',           label: 'IFTA',           sub: 'License / decals',        rule: 'DEC_31',             appliesTo: 'truck' },
  { key: 'irp_cab_card',          label: 'IRP',            sub: 'Registration / cab card', rule: 'PLUS_N_MONTHS', months: 12, appliesTo: 'truck' },
  { key: 'annual_dot_inspection', label: 'DOT Inspection', sub: 'Amazon every 2 mo · Ivan yearly', rule: 'PLUS_N_MONTHS', months: 12, dot: true },
  { key: 'photo_front',           label: 'Front',          sub: 'Photo',                   rule: 'PLUS_N_MONTHS', photo: true },
  { key: 'photo_driver_side',     label: 'Driver side',    sub: 'Photo',                   rule: 'PLUS_N_MONTHS', photo: true },
  { key: 'photo_passenger_side',  label: 'Passenger side', sub: 'Photo',                   rule: 'PLUS_N_MONTHS', photo: true },
  { key: 'photo_rear',            label: 'Rear',           sub: 'Photo',                   rule: 'PLUS_N_MONTHS', photo: true },
  { key: 'photo_plate',           label: 'License plate',  sub: 'Close-up photo',          rule: 'PLUS_N_MONTHS', photo: true },
  // The VIN stamped inside the cab (door jamb / dash plate) — proves the VIN on the
  // paperwork matches the physical truck.
  { key: 'photo_vin_inside',      label: 'VIN plate',      sub: 'Photo of the VIN inside the truck', rule: 'PLUS_N_MONTHS', photo: true, appliesTo: 'truck' },
  // Trailers are identified by their own plate, so one shot showing both.
  { key: 'photo_trailer_plate',   label: 'Trailer + plate', sub: 'Full view showing the plate', rule: 'PLUS_N_MONTHS', photo: true, appliesTo: 'trailer' },
  { key: 'photo_dock_plate',      label: 'Dock plate',      sub: 'Photo of the dock plate',   rule: 'PLUS_N_MONTHS', photo: true, appliesTo: 'trailer' },
  // The I-PASS transponder that travels with the truck — Local and Box Truck only;
  // Amazon units don't carry one.
  { key: 'photo_ipass',           label: 'I-PASS',          sub: 'Photo of the transponder', rule: 'PLUS_N_MONTHS', photo: true, appliesTo: 'truck', fleets: ['LOCAL', 'BOX_TRUCK'] },
]

/** The documents that apply to one asset type (trucks or trailers). */
export const specsForAssetType = (type: 'truck' | 'trailer', fleetGroup?: FleetGroup | null): TruckDocSpec[] =>
  TRUCK_DOC_SPECS.filter((s) =>
    (!s.appliesTo || s.appliesTo === type) &&
    // A fleet-restricted document only appears for those fleets. An unassigned truck
    // shows it too, so a missing fleetGroup never silently hides a required photo.
    (!s.fleets || !fleetGroup || s.fleets.includes(fleetGroup)),
  )

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

/**
 * The expiration date an asset should be judged on for a dated document (insurance,
 * IFTA, IRP).
 *
 * These dates live in TWO places: the certificate uploaded on Asset Documents / Files
 * (a ComplianceDocument carrying its own expirationDate) and a date typed into the
 * Fleet equipment form (Equipment.insuranceExpirationDate & friends). The uploaded
 * certificate is the real record, so it wins; the typed date is only the fallback for
 * an asset with nothing on file. A WAIVED document means the requirement does not
 * apply, so there is no date to judge at all.
 *
 * Without this the Fleet page read only the typed field and kept showing "Action
 * needed" for insurance that had already been renewed and uploaded elsewhere.
 */
export function effectiveExpiration(
  doc: ComplianceDocument | undefined,
  equipmentDate?: string | null,
): { date?: string; waived: boolean; source: 'document' | 'equipment' | 'none' } {
  if (doc?.status === 'WAIVED') return { date: undefined, waived: true, source: 'none' }
  if (doc?.expirationDate) return { date: doc.expirationDate, waived: false, source: 'document' }
  return { date: equipmentDate || undefined, waived: false, source: equipmentDate ? 'equipment' : 'none' }
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

  // Photos don't expire — having one on file is the whole requirement.
  if (spec.photo) {
    return doc?.s3Key ? { state: 'VALID', expiration: null, doc } : { state: 'MISSING', expiration: null, doc }
  }

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
