/**
 * Offline US ZIP -> city / state. The table (`usZipCities.json`, GeoNames postal codes, CC BY 4.0)
 * is run-length encoded and loaded on first lookup only, so it never weighs on first paint and the
 * autofill needs no network, key or Lambda.
 *
 * `cities[i]` is "City|ST"; `runs` is flat triples [firstZip, count, cityIndex] sorted by zip.
 */
export interface ZipPlace { city: string; state: string }

interface ZipTable { cities: string[]; runs: number[] }

let table: Promise<ZipTable> | null = null
const loadTable = () => (table ??= import('./usZipCities.json').then((m) => m.default as ZipTable))

/** A complete US ZIP5 (a ZIP+4 suffix is tolerated); anything shorter or non-numeric is not looked up. */
export function usZip5(raw: string | null | undefined): string | null {
  const m = /^(\d{5})(?:-\d{4})?$/.exec((raw ?? '').trim())
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

/** What to write for a found place: only the blank fields, never text the person typed. */
export function zipFill(current: { city?: string | null; state?: string | null }, found: ZipPlace): Partial<ZipPlace> {
  const fill: Partial<ZipPlace> = {}
  if (!(current.city ?? '').trim()) fill.city = found.city
  if (!(current.state ?? '').trim()) fill.state = found.state
  return fill
}
