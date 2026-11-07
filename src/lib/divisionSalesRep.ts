/**
 * Sales rep by revenue division (AW-CDE-plan C.5). The map lives in
 * `TmsSettings.divisionSalesReps` (json): `{ BROKERAGE, ASSETS, CAR_SHIPPING, OWNER_OPERATOR } -> salesRepId`.
 * No identity is hard-coded anywhere: the seed script writes the values, the Divisions page edits them.
 * Pure and import-free so the Lambdas can share it.
 */

export const DIVISION_REP_KEYS = ['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'OWNER_OPERATOR'] as const

/** Accepts the AWSJSON string or the parsed object; keeps only non-blank string values. */
export function parseDivisionSalesReps(raw: unknown): Record<string, string> {
  let value: unknown = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, rep] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rep === 'string' && rep.trim() !== '') out[key] = rep.trim()
  }
  return out
}

export function repForDivision(raw: unknown, divisionKey: string | null | undefined): string | null {
  if (!divisionKey) return null
  return parseDivisionSalesReps(raw)[divisionKey] ?? null
}

/**
 * The rep to assign to a shipment, or null when none applies. A shipment that already has a rep
 * keeps it: this never overwrites.
 */
export function salesRepForDivision(
  settings: { divisionSalesReps?: unknown } | null | undefined,
  shipment: { revDivision?: string | null; salesRepId?: string | null },
): string | null {
  if (typeof shipment.salesRepId === 'string' && shipment.salesRepId.trim() !== '') return null
  return repForDivision(settings?.divisionSalesReps, shipment.revDivision)
}

/** Rev Type letter -> division key (Aljex Rev Type column). */
export const REV_TYPE_DIVISION: Readonly<Record<string, (typeof DIVISION_REP_KEYS)[number]>> = {
  B: 'BROKERAGE',
  I: 'ASSETS',
  A: 'CAR_SHIPPING',
  O: 'OWNER_OPERATOR',
}

export function divisionForRevType(revType: string | null | undefined): (typeof DIVISION_REP_KEYS)[number] | null {
  if (typeof revType !== 'string') return null
  return REV_TYPE_DIVISION[revType.trim().toUpperCase()] ?? null
}
