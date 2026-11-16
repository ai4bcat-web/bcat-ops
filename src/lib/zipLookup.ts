/**
 * Offline US ZIP -> city / state. The table (`usZipCities.json`, GeoNames postal codes, CC BY 4.0)
 * is run-length encoded and loaded on first lookup only, so it never weighs on first paint and the
 * autofill needs no network, key or Lambda.
 *
 * `cities[i]` is "City|ST"; `runs` is flat triples [firstZip, count, cityIndex] sorted by zip.
 */
import { parsePlaceText } from './stopPlace'

export interface ZipPlace { city: string; state: string }

interface ZipTable { cities: string[]; runs: number[] }

let table: Promise<ZipTable> | null = null
const loadTable = () => (table ??= import('./usZipCities.json').then((m) => m.default as ZipTable))

/** A complete US ZIP5 (a ZIP+4 suffix is tolerated, with or without its dash); anything shorter or non-numeric is not looked up. */
export function usZip5(raw: string | null | undefined): string | null {
  const m = /^(\d{5})(?:-?\d{4})?$/.exec((raw ?? '').trim())
  return m ? m[1] : null
}

/** The place for a ZIP, or null when it is not a US ZIP5 or not in the table. Never rejects. */
export async function lookupZip(raw: string | null | undefined): Promise<ZipPlace | null> {
  const zip = usZip5(raw)
  if (!zip) return null
  try {
    const { cities, runs } = await loadTable()
    const n = Number(zip)
    let lo = 0
    let hi = runs.length / 3 - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const start = runs[mid * 3]
      if (n < start) hi = mid - 1
      else if (n >= start + runs[mid * 3 + 1]) lo = mid + 1
      else {
        const [city, state] = cities[runs[mid * 3 + 2]].split('|')
        return { city, state }
      }
    }
    return null
  } catch {
    return null
  }
}

/** One place a typed city can mean: the city, its state, and a ZIP (the lowest of its ZIPs, or the one asked for). */
export interface CityOption { city: string; state: string; zip: string; zipCount: number }

interface CityEntry { city: string; state: string; key: string; ranges: Array<[number, number]>; zipCount: number }

let cityIndex: Promise<CityEntry[]> | null = null

/** "St. Charles" / "Saint Charles", "Ft Wayne" / "Fort Wayne": one spelling to compare, lower case, no punctuation. */
export function cityKey(raw: string): string {
  return raw.toLowerCase()
    .replace(/[.,'`’]/g, ' ')
    .replace(/\bst\b/g, 'saint').replace(/\bft\b/g, 'fort').replace(/\bmt\b/g, 'mount')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The reverse of the ZIP table, built once on the first city search from the same run-length data. */
const loadCityIndex = () => (cityIndex ??= loadTable().then(({ cities, runs }) => {
  const entries: CityEntry[] = cities.map((c) => {
    const [city, state] = c.split('|')
    return { city, state, key: cityKey(city), ranges: [], zipCount: 0 }
  })
  for (let i = 0; i < runs.length; i += 3) {
    const entry = entries[runs[i + 2]]
    entry.ranges.push([runs[i], runs[i + 1]])
    entry.zipCount += runs[i + 1]
  }
  return entries.filter((e) => e.ranges.length > 0)
}))

const zipText = (n: number): string => String(n).padStart(5, '0')

/** The first `limit` ZIPs of a city, lowest first. */
function zipsOf(entry: CityEntry, limit: number): string[] {
  const out: string[] = []
  for (const [start, count] of [...entry.ranges].sort((a, b) => a[0] - b[0])) {
    for (let n = start; n < start + count && out.length < limit; n++) out.push(zipText(n))
    if (out.length >= limit) break
  }
  return out
}

/**
 * Places for a typed city, best first: the exact city, then cities that start with it, then cities with a word that does.
 * "Cochrane, WI" (a state typed after the city) narrows to that state, and so does `opts.state`. Typing a city that has
 * several ZIPs and matches exactly lists its ZIPs, so the person picks the one they mean. Never rejects: no table, no
 * options.
 */
export async function searchCities(raw: string | null | undefined, opts: { state?: string | null; limit?: number } = {}): Promise<CityOption[]> {
  const limit = opts.limit ?? 8
  const typed = parsePlaceText(raw)
  const q = cityKey(typed.city ?? '')
  if (q.length < 2) return []
  const state = (opts.state ?? '').trim().toUpperCase() || typed.state || ''
  try {
    const entries = await loadCityIndex()
    const scored: Array<{ e: CityEntry; rank: number }> = []
    for (const e of entries) {
      if (state && e.state !== state) continue
      if (e.key === q) scored.push({ e, rank: 0 })
      else if (e.key.startsWith(q)) scored.push({ e, rank: 1 })
      else if (q.length >= 3 && e.key.split(' ').some((w) => w.startsWith(q))) scored.push({ e, rank: 2 })
    }
    scored.sort((a, b) => a.rank - b.rank || b.e.zipCount - a.e.zipCount || a.e.city.localeCompare(b.e.city))
    const exact = scored.filter((x) => x.rank === 0)
    if (exact.length === 1 && exact[0].e.zipCount > 1) {
      const e = exact[0].e
      return zipsOf(e, limit).map((zip) => ({ city: e.city, state: e.state, zip, zipCount: e.zipCount }))
    }
    return scored.slice(0, limit).map(({ e }) => ({ city: e.city, state: e.state, zip: zipsOf(e, 1)[0], zipCount: e.zipCount }))
  } catch {
    return []
  }
}

/** What to write for a found place: only the blank fields, never text the person typed. */
export function zipFill(current: { city?: string | null; state?: string | null }, found: ZipPlace): Partial<ZipPlace> {
  const fill: Partial<ZipPlace> = {}
  if (!(current.city ?? '').trim()) fill.city = found.city
  if (!(current.state ?? '').trim()) fill.state = found.state
  return fill
}
