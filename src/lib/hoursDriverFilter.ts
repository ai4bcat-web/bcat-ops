/**
 * Which drivers the Employee Hours page shows. Everyone who clocks in is listed in the
 * filter; the page starts with a couple of names hidden (Ryne's test driver and Dan
 * Palmer, per Ryne) and remembers whatever the viewer picks in this browser.
 */
export const HOURS_HIDDEN_KEY = 'bcat-hours-hidden-drivers'

/** Lower-cased names hidden by default until the viewer changes the filter. */
export const DEFAULT_HIDDEN_HOURS_NAMES = ['ryne test', 'dan palmer', 'daniel palmer']

interface NamedDriver { id: string; name: string }

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function isHiddenByDefault(name: string): boolean {
  return DEFAULT_HIDDEN_HOURS_NAMES.includes(norm(name))
}

export function defaultHiddenDriverIds(drivers: NamedDriver[]): string[] {
  return drivers.filter((d) => isHiddenByDefault(d.name)).map((d) => d.id)
}

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The viewer's saved choice, or null when none is saved. Never throws (private windows). */
export function readSavedHiddenIds(storage?: StorageLike | null): string[] | null {
  try {
    const raw = storage?.getItem(HOURS_HIDDEN_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch { /* fall through */ }
  return null
}

/** The saved choice when there is one, else the default. */
export function loadHiddenDriverIds(drivers: NamedDriver[], storage?: StorageLike | null): string[] {
  return readSavedHiddenIds(storage) ?? defaultHiddenDriverIds(drivers)
}

export function saveHiddenDriverIds(ids: string[], storage?: StorageLike | null): void {
  try { storage?.setItem(HOURS_HIDDEN_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}

export function toggleHidden(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
}
