import type { Address, CustomerRecord, LocationRecord } from '../types/tms'

/** Normalization proposes candidates; it never establishes identity on its own. */
export function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/(?:\s+(?:incorporated|inc|llc|ltd|limited|corporation|corp))+$/, '').trim()
}

export function normalizeAddress(value: Address | string): string {
  const text = typeof value === 'string' ? value : [value.street, value.city, value.state, value.zip, value.country].filter(Boolean).join(' ')
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function isActiveDirectoryRecord(record: { active?: boolean | null; mergedIntoId?: string | null; mergeJobId?: string | null }): boolean {
  return record.active !== false && !record.mergedIntoId && !record.mergeJobId
}

/** Decimal input only. No floating-point dollar multiplication or rounding. */
export function parseCents(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a nonnegative amount with at most two decimal places')
  const [whole, fraction = ''] = text.split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents > 2147483647n) throw new Error('Amount exceeds the supported integer-cent limit')
  return Number(cents)
}

export function formatCents(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error('Money must be integer cents')
  const amount = BigInt(value)
  const absolute = amount < 0n ? -amount : amount
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`
}

export function locationAddress(location: LocationRecord): Address {
  return { street: location.street ?? undefined, city: location.city ?? undefined, state: location.state ?? undefined, zip: location.zip ?? undefined, country: location.country ?? undefined }
}

export function dwellMinutes(stop: { arrivedAt?: string | null; departedAt?: string | null }): number | null {
  if (!stop.arrivedAt || !stop.departedAt) return null
  const arrived = Date.parse(stop.arrivedAt)
  const departed = Date.parse(stop.departedAt)
  return Number.isFinite(arrived) && Number.isFinite(departed) && departed >= arrived ? (departed - arrived) / 60_000 : null
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radians = Math.PI / 180
  const latitude = (b.lat - a.lat) * radians
  const longitude = (b.lng - a.lng) * radians
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(longitude / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = new Set(a.split(' '))
  const right = new Set(b.split(' '))
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  const jaccard = shared / (left.size + right.size - shared)
  // Pickers are typed incrementally: "smoke" must find "smoke test shipper" even though
  // it shares 1 of 3 words. If every typed word is a prefix of some candidate word, the
  // candidate is a live suggestion (0.6 — above the 0.4 floor, below any word-overlap tie).
  const rightWords = [...right]
  const allPrefix = [...left].every((w) => rightWords.some((c) => c.startsWith(w)))
  return allPrefix ? Math.max(jaccard, 0.6) : jaccard
}

export interface DirectoryMatch<T> { record: T; score: number; reason: string }

export function findCustomerMatches(name: string, customers: CustomerRecord[]): DirectoryMatch<CustomerRecord>[] {
  const needle = normalizeName(name)
  if (!needle) return []
  return customers.filter(isActiveDirectoryRecord).map(record => {
    const names = [record.name, ...(record.aliases ?? [])]
    const score = Math.max(...names.map(candidate => similarity(needle, normalizeName(candidate))))
    return { record, score, reason: score === 1 ? 'Exact name or alias' : 'Similar name — review before selecting' }
  }).filter(match => match.score >= 0.4).sort((a, b) => b.score - a.score)
}

export interface LocationQuery { name?: string; city?: string; lat?: number; lng?: number }

export function findLocationMatches(query: LocationQuery, locations: LocationRecord[]): DirectoryMatch<LocationRecord>[] {
  const name = normalizeName(query.name ?? '')
  const city = normalizeName(query.city ?? '')
  return locations.filter(isActiveDirectoryRecord).flatMap(record => {
    const nameScore = Math.max(...[record.name, ...(record.aliases ?? [])].map(candidate => similarity(name, normalizeName(candidate))))
    const cityMatches = !city || normalizeName(record.city ?? '') === city
    const fresh = !!record.geocodeExpiresAt && Date.parse(record.geocodeExpiresAt) > Date.now()
    const distance = fresh && Number.isFinite(query.lat) && Number.isFinite(query.lng) && Number.isFinite(record.lat) && Number.isFinite(record.lng)
      ? distanceMeters({ lat: query.lat!, lng: query.lng! }, { lat: record.lat!, lng: record.lng! }) : null
    if (distance !== null && distance <= 150) return [{ record, score: Math.max(0.9, nameScore), reason: `Within ${Math.round(distance)} m — review facility identity` }]
    if (nameScore >= 0.4 && cityMatches) return [{ record, score: nameScore, reason: nameScore === 1 ? 'Exact name or alias; review address' : 'Similar name and city — review address' }]
    return []
  }).sort((a, b) => b.score - a.score)
}

export function locationMatches(query: LocationQuery, record: LocationRecord): boolean {
  return findLocationMatches(query, [record]).length > 0
}

