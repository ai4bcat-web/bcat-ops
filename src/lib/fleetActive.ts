/**
 * Which fleet units are on the road. One definition for trucks AND trailers, so the
 * pickers, counts, lists and insurance all agree on what "inactive" means.
 *
 * A unit is inactive when `active === false` (set together with `inactiveSince` by the
 * Mark inactive dialog). A missing flag counts as active — older records predate it.
 */
import type { Equipment } from '@/types/equipment'

type UnitLike = { type: Equipment['type']; active?: boolean | null }

export const isUnitActive = (e: { active?: boolean | null }): boolean => e.active !== false

/** Active units, optionally of one type — what every assignment picker and fleet count uses. */
export function activeUnits<T extends UnitLike>(equipment: readonly T[], type?: Equipment['type']): T[] {
  return equipment.filter((e) => isUnitActive(e) && (!type || e.type === type))
}

export function inactiveUnits<T extends UnitLike>(equipment: readonly T[]): T[] {
  return equipment.filter((e) => !isUnitActive(e))
}

export type FleetTab = 'all' | 'truck' | 'trailer' | 'inactive'

/** The Fleet list tabs: All/Trucks/Trailers show active units; Inactive shows every parked unit. */
export function unitsInTab<T extends UnitLike>(equipment: readonly T[], tab: FleetTab): T[] {
  if (tab === 'inactive') return inactiveUnits(equipment)
  return activeUnits(equipment, tab === 'all' ? undefined : tab)
}

export function fleetCounts(equipment: readonly UnitLike[]): { total: number; trucks: number; trailers: number; inactive: number } {
  const active = activeUnits(equipment)
  return {
    total: active.length,
    trucks: active.filter((e) => e.type === 'truck').length,
    trailers: active.filter((e) => e.type === 'trailer').length,
    inactive: equipment.length - active.length,
  }
}

/** Drivers who still have this trailer as their assigned trailer. */
export function driversHoldingTrailer<D extends { assignedTrailerId?: string | null }>(trailerId: string, drivers: readonly D[]): D[] {
  return drivers.filter((d) => d.assignedTrailerId === trailerId)
}

export const reactivatePatch = { active: true, inactiveSince: null } as const

/** The audit diff for a patch's inactive fields; empty when the patch changes neither. */
export function inactiveChanges(
  before: Pick<Equipment, 'active' | 'inactiveSince'>,
  patch: Partial<Pick<Equipment, 'active' | 'inactiveSince'>>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  if (patch.active !== undefined && (before.active !== false) !== (patch.active !== false)) {
    out.active = { from: before.active !== false, to: patch.active !== false }
  }
  if (patch.inactiveSince !== undefined && (before.inactiveSince ?? null) !== (patch.inactiveSince ?? null)) {
    out.inactiveSince = { from: before.inactiveSince ?? null, to: patch.inactiveSince ?? null }
  }
  return out
}

const COMPLIANCE_DATE_FIELDS = ['dotInspectionDate', 'insuranceExpirationDate', 'iftaExpirationDate', 'irpExpirationDate', 'bobtailInsuranceDate'] as const
type ComplianceDateField = (typeof COMPLIANCE_DATE_FIELDS)[number]

/** The audit diff for a patch's compliance dates (DOT, insurance, IFTA, IRP, bobtail); empty when none change. */
export function complianceDateChanges(
  before: Partial<Record<ComplianceDateField, string | null | undefined>>,
  patch: Partial<Record<ComplianceDateField, string | null | undefined>>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const f of COMPLIANCE_DATE_FIELDS) {
    if (patch[f] === undefined) continue
    const from = before[f]?.slice(0, 10) || null
    const to = patch[f]?.slice(0, 10) || null
    if (from !== to) out[f] = { from, to }
  }
  return out
}
