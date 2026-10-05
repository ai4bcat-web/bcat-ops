/**
 * Which Motive account belongs to which BCAT Ops driver.
 *
 * This decides whose hours-of-service log a driver is shown, so it is deliberately
 * conservative. Duty status is a federal record; putting driver B's log in front of driver
 * A is not a cosmetic bug, and the live data gives two concrete ways to get it wrong:
 *
 *   - Motive carries "Chuck Best" where BCAT Ops carries "Charles Best". A fuzzy match
 *     would be needed to join those, and a fuzzy match is exactly what must not decide this.
 *   - Motive carries TWO users called "Jason Smith", one active and one deactivated. Even
 *     an exact-name match has to pick, and picking is guessing.
 *
 * So: an explicit motiveDriverId on the Driver record is the only thing that MATCHES. Name
 * comparison exists only to SUGGEST a link for a human to confirm, and it suggests nothing
 * at all unless exactly one active Motive driver has that name.
 */

export interface MotiveUser {
  id: number
  first_name?: string | null
  last_name?: string | null
  status?: string | null
  role?: string | null
}

export interface MatchableDriver {
  id: string
  name?: string | null
  /** Set by staff. The only thing that establishes the link. */
  motiveDriverId?: number | string | null
}

export type MotiveLinkState =
  /** motiveDriverId is set and names a Motive account we can see. */
  | 'LINKED'
  /** motiveDriverId is set but no such account came back from Motive. */
  | 'STALE'
  /** Not linked, and exactly one active Motive driver shares the name — offer it. */
  | 'SUGGESTED'
  /** Not linked, and nothing can be suggested safely. */
  | 'UNLINKED'

export interface MotiveLink {
  state: MotiveLinkState
  /** The account to read logs from. Only ever set when state is LINKED. */
  motiveUserId: number | null
  /** A single safe candidate for a human to confirm. Only set when state is SUGGESTED. */
  suggestion: MotiveUser | null
  /** Why nothing was matched, for the staff screen. */
  reason: string
}

function fullName(u: MotiveUser): string {
  return `${u.first_name ?? ''} ${u.last_name ?? ''}`.replace(/\s+/g, ' ').trim().toUpperCase()
}

function isActiveDriver(u: MotiveUser): boolean {
  // Motive keeps deactivated accounts in the list; they are history, not people to link to.
  return (u.status ?? 'active').toLowerCase() === 'active' && (u.role ?? 'driver') === 'driver'
}

/**
 * Resolve one driver against the Motive user list.
 *
 * Never returns a motiveUserId it inferred. A suggestion is a suggestion: the caller shows
 * it, a human accepts it, and only then does it become a motiveDriverId that matches.
 */
export function matchMotiveDriver(driver: MatchableDriver, users: MotiveUser[]): MotiveLink {
  const explicit = driver.motiveDriverId
  if (explicit != null && String(explicit).trim() !== '') {
    const id = Number(explicit)
    const found = users.find((u) => Number(u.id) === id)
    if (found) {
      return { state: 'LINKED', motiveUserId: id, suggestion: null, reason: '' }
    }
    return {
      state: 'STALE',
      motiveUserId: null,
      suggestion: null,
      reason: `Motive account ${id} is no longer visible on this Motive org`,
    }
  }

  const name = (driver.name ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
  if (!name) {
    return { state: 'UNLINKED', motiveUserId: null, suggestion: null, reason: 'Driver has no name to match on' }
  }

  const sameName = users.filter((u) => isActiveDriver(u) && fullName(u) === name)
  if (sameName.length === 1) {
    return {
      state: 'SUGGESTED',
      motiveUserId: null,
      suggestion: sameName[0],
      reason: 'Matched by name — confirm before using it',
    }
  }
  if (sameName.length > 1) {
    return {
      state: 'UNLINKED',
      motiveUserId: null,
      suggestion: null,
      // The live Jason Smith case. Two accounts, no way to tell which from here.
      reason: `${sameName.length} active Motive drivers are called "${driver.name}" — link one by hand`,
    }
  }
  return {
    state: 'UNLINKED',
    motiveUserId: null,
    suggestion: null,
    // The live Chuck/Charles case.
    reason: 'No active Motive driver has this exact name — link one by hand',
  }
}
