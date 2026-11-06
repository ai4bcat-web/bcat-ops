/** The remembered open/closed state of the rail's Rate history block, per user. */
export const railOpenKey = (user: string) => `tms:ship-form:rail-rate-history:${user || 'anon'}`

/** Saved choice, else open at >= 1280 px and closed below (the bottom sheet). */
export function readRailOpen(user: string, wide: boolean): boolean {
  try {
    const v = localStorage.getItem(railOpenKey(user))
    if (v === 'open') return true
    if (v === 'closed') return false
  } catch { /* private mode: default */ }
  return wide
}
