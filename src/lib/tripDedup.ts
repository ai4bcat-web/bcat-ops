/** A subset of an Amazon trip containing only the fields used for deduplication. */
export interface TripIdentityInput {
  driverId: string
  periodStart: string
  loadId?: string | null
  freightAmount?: number | null
  miles?: number | null
  origin?: string | null
  destination?: string | null
}

/** True when the trip carries the Load ID that uniquely identifies it within a week. */
function hasLoadId(trip: TripIdentityInput): boolean {
  return !!trip.loadId?.trim()
}

/** Build a stable identity key for an Amazon trip for duplicate detection. */
export function tripIdentity(trip: TripIdentityInput): string {
  const base = `${trip.driverId}|${trip.periodStart}`
  const loadId = trip.loadId?.trim()
  if (loadId) {
    return `${base}|load:${loadId.toUpperCase()}`
  }
  const fallback = [
    trip.freightAmount ?? '',
    trip.miles ?? '',
    (trip.origin ?? '').trim().toUpperCase(),
    (trip.destination ?? '').trim().toUpperCase(),
  ].join('|')
  return `${base}|fallback:${fallback}`
}

/**
 * Split incoming trips into those that are new vs. already on the statement.
 *
 * A repeated Load ID within one pay week is always the same trip. Rows without a Load ID
 * (screenshot and paste imports) are only identified by lane and money, and a driver can
 * legitimately run one lane several times in a week — so those are matched by COUNT: the
 * first N repeats are treated as already-filed, and any beyond that are real extra runs.
 */
export function partitionNewTrips<T extends TripIdentityInput>(
  incoming: T[],
  existing: TripIdentityInput[],
): { fresh: T[]; duplicates: T[] } {
  const loadIdKeys = new Set<string>()
  const remaining = new Map<string, number>()
  for (const trip of existing) {
    const key = tripIdentity(trip)
    if (hasLoadId(trip)) loadIdKeys.add(key)
    else remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }

  const fresh: T[] = []
  const duplicates: T[] = []

  for (const trip of incoming) {
    const key = tripIdentity(trip)
    if (hasLoadId(trip)) {
      if (loadIdKeys.has(key)) { duplicates.push(trip); continue }
      loadIdKeys.add(key)
      fresh.push(trip)
      continue
    }
    const left = remaining.get(key) ?? 0
    if (left > 0) {
      remaining.set(key, left - 1)
      duplicates.push(trip)
    } else {
      fresh.push(trip)
    }
  }

  return { fresh, duplicates }
}

/** A filed trip as the duplicate check sees it: its row id and the Load ID it carries. */
export interface WeekTrip {
  id: string
  loadId?: string | null
}

const normalizedLoadId = (trip: WeekTrip): string | null => {
  const v = (trip.loadId ?? '').trim().toUpperCase()
  return v && v !== 'N/A' ? v : null
}

/**
 * Ids of trips that look like the same run paid twice: a Load ID already settled the
 * week before, or repeated within this week (the shape a load entered twice takes).
 * The first occurrence in the week is left clean so only the extra copy is called out.
 * Flagging only; nothing is removed, because a genuine repeat of the same reference
 * does happen and only a human can tell the two apart.
 */
export function duplicateTripIds(current: WeekTrip[], previousWeek: WeekTrip[]): Set<string> {
  const seen = new Set<string>()
  for (const trip of previousWeek) {
    const key = normalizedLoadId(trip)
    if (key) seen.add(key)
  }
  const out = new Set<string>()
  for (const trip of current) {
    const key = normalizedLoadId(trip)
    if (!key) continue
    if (seen.has(key)) out.add(trip.id)
    else seen.add(key)
  }
  return out
}
