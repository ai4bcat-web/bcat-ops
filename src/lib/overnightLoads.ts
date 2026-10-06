/**
 * Which Ivan loads are overnight runs rather than local work.
 *
 * The rule, as given: anything going to or coming from Iowa. Ivan's local fleet works the
 * Chicago–Milwaukee corridor, so an Iowa leg is what turns a day's work into a run the
 * driver sleeps out on.
 *
 * "Overnight" rather than "OTR" on purpose: OTR already means OTR SOLUTIONS everywhere else
 * in this codebase — otrClient, otr-actions, otrStatus, OTR_BASE_URL — and a second,
 * unrelated meaning of the same three letters would be a trap for anyone searching it.
 *
 * This is NOT the same question as the 150 air-mile ELD rule, and the two deliberately do
 * not share a definition. ELD is a federal radius measured from Pleasant Prairie; this is a
 * commercial category the office uses to pay differently. A run can be one and not the
 * other — Holmen, WI is 197 air miles and needs logs but is not an Iowa run.
 */

/** The state that makes a run over-the-road. */
export const OVERNIGHT_STATES = ['IA'] as const

/**
 * Is this city string in one of the over-the-road states?
 *
 * Accepts the shapes that actually appear on loads: "NEWTON, IA", "NEWTON IA", "NEWTON,IA"
 * and a bare state code. Matches on the state only — a city called Iowa Falls in a
 * different state must not count, and a street containing "ia" certainly must not.
 */
export function isOvernightPlace(raw: string | null | undefined): boolean {
  if (!raw) return false
  const s = raw.replace(/\s+/g, ' ').trim().toUpperCase()
  if (!s) return false
  // The trailing state code, however it was separated, or the whole string being one.
  const m = s.match(/(?:^|[\s,])([A-Z]{2})$/)
  const state = m ? m[1] : s.length === 2 ? s : null
  return !!state && (OVERNIGHT_STATES as readonly string[]).includes(state)
}

/** True when any end of the run touches an over-the-road state. */
export function isOvernightLoad(places: Array<string | null | undefined>): boolean {
  return places.some(isOvernightPlace)
}
