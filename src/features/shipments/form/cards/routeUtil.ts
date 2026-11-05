/** Pure helpers for the Route card: lane label, transit estimate, and the stop-order rule. */
import type { FormStop } from '../model'

const place = (s: FormStop | undefined): string => {
  if (!s) return ''
  const cityState = [s.city.trim(), s.state.trim().toUpperCase()].filter(Boolean).join(', ')
  return cityState || s.name.trim()
}

/** "Chicago, IL → Dallas, TX"; blank halves read "…" until the stop has a place. */
export function laneLabel(stops: readonly FormStop[]): string {
  const origin = place(stops[0])
  const dest = stops.length > 1 ? place(stops[stops.length - 1]) : ''
  if (!origin && !dest) return ''
  return `${origin || '…'} → ${dest || '…'}`
}

/** One truckload day = 500 road miles; at least one day. Null until there are miles. */
export function transitEstimate(miles: string | number): string | null {
  const n = typeof miles === 'number' ? miles : Number(miles)
  if (!Number.isFinite(n) || n <= 0) return null
  const days = Math.max(1, Math.ceil(n / 500))
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/** The route must start at a pickup and end at a delivery (Pick Up / Consignee roles in the mapping). */
export function validOrder(stops: readonly FormStop[]): boolean {
  return stops.length >= 2 && stops[0].type === 'pickup' && stops[stops.length - 1].type === 'delivery'
}

/** May a new stop of `type` go in at gap `at` (0..n) without breaking {@link validOrder}? */
export function canInsert(stops: readonly FormStop[], at: number, type: FormStop['type']): boolean {
  return type === 'pickup' ? at < stops.length : at > 0
}

export function moveStop(stops: readonly FormStop[], from: number, to: number): FormStop[] {
  if (from === to || from < 0 || to < 0 || from >= stops.length || to >= stops.length) return [...stops]
  const next = [...stops]
  const [s] = next.splice(from, 1)
  next.splice(to, 0, s)
  return validOrder(next) ? next : [...stops]
}

export function removeStop(stops: readonly FormStop[], at: number): FormStop[] {
  const next = stops.filter((_, i) => i !== at)
  return validOrder(next) ? next : [...stops]
}

/** Test-id infix, as the sections used: first = pickup, last = consignee, others `stop-<i>`. */
export function stopPrefix(index: number, count: number): string {
  return index === 0 ? 'pickup' : index === count - 1 ? 'consignee' : `stop-${index}`
}
