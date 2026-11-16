/**
 * Sales rep by revenue division (AW-CDE-plan C.5). The map lives in
 * `TmsSettings.divisionSalesReps` (json): `{ BROKERAGE, ASSETS, CAR_SHIPPING, OWNER_OPERATOR } -> salesRepId | { default, allowed[] }`.
 * Standing rule (Ryne 2026-11-16): whenever a division is set or changes, the rep becomes the division's default
 * unless a person explicitly chose another rep (see salesRepAfterDivisionChange).
 * No identity is hard-coded anywhere: the seed script writes the values, the Divisions page edits them.
 * Pure and import-free so the Lambdas can share it.
 */

export const DIVISION_REP_KEYS = ['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'OWNER_OPERATOR'] as const

export interface DivisionRepConfig {
  /** The rep a division takes when nobody chose one. */
  default: string
  /** Every rep the division may have; always contains `default`. More than one lets a person pick another without it being "corrected". */
  allowed: string[]
}

function parsedMap(raw: unknown): Record<string, unknown> {
  let value: unknown = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const nonBlank = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/**
 * `TmsSettings.divisionSalesReps` per division: either a rep id (the default, the original shape) or
 * `{ default, allowed: [repId…] }` once a division has several reps. Blank or malformed entries are dropped.
 */
export function parseDivisionRepConfigs(raw: unknown): Record<string, DivisionRepConfig> {
  const out: Record<string, DivisionRepConfig> = {}
  for (const [key, entry] of Object.entries(parsedMap(raw))) {
    const plain = nonBlank(entry)
    if (plain) {
      out[key] = { default: plain, allowed: [plain] }
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const def = nonBlank((entry as { default?: unknown }).default)
    if (!def) continue
    const listed = Array.isArray((entry as { allowed?: unknown }).allowed)
      ? ((entry as { allowed: unknown[] }).allowed.map(nonBlank).filter((v): v is string => v != null))
      : []
    out[key] = { default: def, allowed: [def, ...listed.filter((v) => v !== def)] }
  }
  return out
}

/** The default rep per division (what the Divisions page edits). */
export function parseDivisionSalesReps(raw: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(parseDivisionRepConfigs(raw)).map(([k, c]) => [k, c.default]))
}

/**
 * The stored shape after the default of one or more divisions changed: a division with only its default
 * stays a plain string, one with extra reps keeps its list (the new default is always in it).
 */
export function mergeDivisionRepDefaults(raw: unknown, defaults: Record<string, string>): Record<string, string | { default: string; allowed: string[] }> {
  const current = parseDivisionRepConfigs(raw)
  const out: Record<string, string | { default: string; allowed: string[] }> = {}
  for (const [key, def] of Object.entries(defaults)) {
    const kept = (current[key]?.allowed ?? []).filter((v) => v !== def)
    out[key] = kept.length > 0 ? { default: def, allowed: [def, ...kept] } : def
  }
  return out
}

export function repForDivision(raw: unknown, divisionKey: string | null | undefined): string | null {
  if (!divisionKey) return null
  return parseDivisionRepConfigs(raw)[divisionKey]?.default ?? null
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

/**
 * The rep a shipment should carry once its division is SET or CHANGED, or null to leave it alone.
 * The division's default applies when the shipment has no rep or still carries another division's
 * default (a rep nobody chose). A rep that is allowed in the new division, or that is not any division's
 * default (a person picked it), is kept.
 */
export function salesRepAfterDivisionChange(
  settings: { divisionSalesReps?: unknown } | null | undefined,
  shipment: { revDivision?: string | null; salesRepId?: string | null },
): string | null {
  const configs = parseDivisionRepConfigs(settings?.divisionSalesReps)
  const target = shipment.revDivision ? configs[shipment.revDivision] : undefined
  if (!target) return null
  const current = nonBlank(shipment.salesRepId)
  if (current === target.default) return null
  if (current && target.allowed.includes(current)) return null
  if (current && !Object.values(configs).some((c) => c.default === current)) return null
  return target.default
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
