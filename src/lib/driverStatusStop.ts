/**
 * Which stop a driver's link tap is about (Ryne 2026-11-10): "on site at pickup" is the arrival at the first pickup not yet arrived at,
 * "departed pickup" the departure from the pickup the truck is at, and the same for delivery. Pure; no imports so the Lambda can bundle it.
 */
export interface DriverStop { id?: string | null; type?: string | null; arrivedAt?: string | null; departedAt?: string | null }
export type DriverStatusKey = 'EN_ROUTE' | 'ON_SITE_PICKUP' | 'DEPARTED_PICKUP' | 'ON_SITE_DELIVERY' | 'DELIVERED'

export function stopForDriverStatus(stops: readonly DriverStop[], status: DriverStatusKey): { stopId: string; event: 'ARRIVED' | 'DEPARTED' } | null {
  const type = status === 'ON_SITE_PICKUP' || status === 'DEPARTED_PICKUP' ? 'pickup' : status === 'ON_SITE_DELIVERY' || status === 'DELIVERED' ? 'delivery' : null
  if (!type) return null
  const mine = stops.filter((s) => s.type === type && s.id)
  const arriving = status === 'ON_SITE_PICKUP' || status === 'ON_SITE_DELIVERY'
  const stop = arriving
    ? mine.find((s) => !s.arrivedAt)
    : mine.find((s) => s.arrivedAt && !s.departedAt) ?? mine.find((s) => !s.departedAt)
  return stop?.id ? { stopId: stop.id, event: arriving ? 'ARRIVED' : 'DEPARTED' } : null
}
