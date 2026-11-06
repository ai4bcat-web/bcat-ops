/**
 * A stop booked without a directory Location still deserves a place to keep what drivers
 * learn about it (where to check in, which dock). These build and match the Location a
 * driver's first note creates, using the SAME normalisation as tms-directory-actions so a
 * place made here and one made by staff dedupe against each other.
 */
export interface StopPlace {
  name?: string | null
  city?: string | null
  address?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null
}

export interface LocationLike {
  id: string
  name?: string | null
  city?: string | null
  street?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
  normalizedAddress?: string | null
  normalizedName?: string | null
  active?: boolean | null
  mergedIntoId?: string | null
}

/** Same rule as normalizeName in tms-directory-actions. */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\b(llc|inc|ltd|llp|corp|co|company|enterprises)\b/g, '').trim()
}

/** Same rule as normalizeAddress in tms-directory-actions: parts joined, punctuation gone. */
export function normalizeAddress(a: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null }): string {
  return [a.street, a.city, a.state, a.zip, a.country]
    .map((p) => (typeof p === 'string' ? p.toLowerCase().replace(/[^a-z0-9]/g, ' ') : ''))
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

/** The postal parts of the stop; `city` on a stop is a display string, the address holds the parts. */
export function stopAddress(stop: StopPlace): { street: string | null; city: string | null; state: string | null; zip: string | null } {
  const clean = (v?: string | null) => v?.trim() || null
  return {
    street: clean(stop.address?.street),
    city: clean(stop.address?.city) ?? clean(stop.city?.split(',')[0]),
    state: clean(stop.address?.state),
    zip: clean(stop.address?.zip),
  }
}

const live = (l: LocationLike) => l.active !== false && !l.mergedIntoId

/**
 * The existing directory record for this stop: same normalised street address (the key
 * the spec dedupes on), else same facility name in the same city for a stop with no street.
 * Null when nothing matches or the stop has neither a name nor an address.
 */
export function matchLocation(stop: StopPlace, locations: readonly LocationLike[]): LocationLike | null {
  const addr = stopAddress(stop)
  if (addr.street) {
    const key = normalizeAddress({ ...addr, country: 'US' })
    const hit = locations.find((l) => live(l) && (l.normalizedAddress === key
      || (l.street && normalizeAddress({ street: l.street, city: l.city, state: l.state, zip: l.zip, country: l.country ?? 'US' }) === key)))
    if (hit) return hit
  }
  const name = normalizeName(stop.name ?? '')
  if (!name) return null
  const city = normalizeName(addr.city ?? '')
  return locations.find((l) => live(l) && normalizeName(l.name ?? '') === name && normalizeName(l.city ?? '') === city) ?? null
}

/** The new directory row. GSI keys (normalizedAddress) are omitted, never empty, when there is no street. */
export function newLocationItem(stop: StopPlace, id: string, now: string, createdBy: string): Record<string, unknown> | null {
  const name = stop.name?.trim()
  if (!name) return null
  const addr = stopAddress(stop)
  const hasAddress = !!(addr.street || addr.city || addr.state || addr.zip)
  return {
    id,
    name,
    ...(addr.city ? { city: addr.city } : {}),
    ...(addr.street ? { street: addr.street } : {}),
    ...(addr.state ? { state: addr.state } : {}),
    ...(addr.zip ? { zip: addr.zip } : {}),
    country: 'US',
    normalizedName: normalizeName(name),
    ...(hasAddress ? { normalizedAddress: normalizeAddress({ ...addr, country: 'US' }) } : {}),
    active: true,
    createdBy,
    updatedBy: createdBy,
    createdAt: now,
    updatedAt: now,
  }
}
