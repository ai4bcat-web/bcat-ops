/**
 * Insurance → per-truck cost allocation. Pure functions (no I/O) so the profit math is
 * unit-testable. The current insurance period is the single source of truth for premiums;
 * this spreads them onto trucks the way the P&L needs:
 *   - per-truck premium  → that truck only
 *   - trailer insurance  → split evenly across active trucks (trailers aren't revenue units)
 *   - workmans comp      → per active driver, attributed to that driver's assigned truck;
 *                          any WC for drivers without an active truck is spread evenly so the
 *                          fleet total is always preserved.
 * "Active trucks" = every truck (all fleet groups) that is active, per the user's choice to
 * count all trucks.
 */

export type InsuranceKind = 'TRUCK' | 'TRAILER' | 'WORKMANS_COMP'
export interface InsItem { kind: InsuranceKind; equipmentId?: string | null; annualCents: number }
export interface TruckLite { id: string; active: boolean }
export interface DriverLite { id: string; assignedTruckId?: string | null; active: boolean }

export interface InsuranceAllocation {
  /** Annual insurance $ attributed to each active truck (premium + trailer share + WC share). */
  byTruck: Record<string, number>
  perTruckPremium: Record<string, number>
  trailerSharePerTruck: number
  wcByTruck: Record<string, number>
  truckTotal: number
  trailerTotal: number
  wcTotal: number
  fleetAnnual: number
  activeTruckCount: number
  activeDriverCount: number
}

const c2d = (cents: number) => (cents || 0) / 100

export function computeInsuranceAllocation(
  items: InsItem[],
  trucks: TruckLite[],
  drivers: DriverLite[],
): InsuranceAllocation {
  const activeTrucks = trucks.filter((t) => t.active)
  const activeTruckIds = new Set(activeTrucks.map((t) => t.id))
  const n = activeTrucks.length

  // Per-truck premium (annual $) — only trucks that are active count toward live profit.
  const perTruckPremium: Record<string, number> = {}
  let truckTotal = 0
  for (const it of items) {
    if (it.kind === 'TRUCK' && it.equipmentId && activeTruckIds.has(it.equipmentId)) {
      const d = c2d(it.annualCents)
      perTruckPremium[it.equipmentId] = (perTruckPremium[it.equipmentId] ?? 0) + d
      truckTotal += d
    }
  }

  // Trailers → even split across active trucks.
  const trailerTotal = items.filter((i) => i.kind === 'TRAILER').reduce((s, i) => s + c2d(i.annualCents), 0)
  const trailerSharePerTruck = n > 0 ? trailerTotal / n : 0

  // Workmans comp → per active driver, onto that driver's active truck; leftovers spread evenly.
  const wcTotal = items.filter((i) => i.kind === 'WORKMANS_COMP').reduce((s, i) => s + c2d(i.annualCents), 0)
  const activeDrivers = drivers.filter((d) => d.active)
  const dCount = activeDrivers.length
  const wcPerDriver = dCount > 0 ? wcTotal / dCount : 0
  const wcByTruck: Record<string, number> = {}
  let wcUnallocated = 0
  for (const d of activeDrivers) {
    if (d.assignedTruckId && activeTruckIds.has(d.assignedTruckId)) {
      wcByTruck[d.assignedTruckId] = (wcByTruck[d.assignedTruckId] ?? 0) + wcPerDriver
    } else {
      wcUnallocated += wcPerDriver
    }
  }
  const wcSpread = n > 0 ? wcUnallocated / n : 0

  const byTruck: Record<string, number> = {}
  for (const t of activeTrucks) {
    byTruck[t.id] = (perTruckPremium[t.id] ?? 0) + trailerSharePerTruck + (wcByTruck[t.id] ?? 0) + wcSpread
  }

  return {
    byTruck, perTruckPremium, trailerSharePerTruck, wcByTruck,
    truckTotal, trailerTotal, wcTotal, fleetAnnual: truckTotal + trailerTotal + wcTotal,
    activeTruckCount: n, activeDriverCount: dCount,
  }
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function inclusiveDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  return Math.max(0, Math.round(ms / 86_400_000) + 1)
}

/**
 * Prorate each truck's ANNUAL insurance to a date range (daily basis / 365) so a full
 * month ≈ annual/12 and a week ≈ annual·7/365. Returns range $ per truck.
 */
export function insuranceRangeByTruck(
  annualByTruck: Record<string, number>,
  range: { start: string; end: string },
): Record<string, number> {
  const factor = inclusiveDays(range.start, range.end) / 365
  const out: Record<string, number> = {}
  for (const [id, annual] of Object.entries(annualByTruck)) out[id] = annual * factor
  return out
}

/** Sum a subset of the per-truck annual map (e.g. one fleet group's trucks) → range $. */
export function insuranceRangeForTrucks(
  annualByTruck: Record<string, number>,
  truckIds: Iterable<string>,
  range: { start: string; end: string },
): number {
  const factor = inclusiveDays(range.start, range.end) / 365
  let sum = 0
  for (const id of truckIds) sum += (annualByTruck[id] ?? 0) * factor
  return sum
}
