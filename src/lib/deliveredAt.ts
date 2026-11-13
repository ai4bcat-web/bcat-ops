/**
 * When the freight was delivered, for every screen that prints it (Load Review, Invoicing, …).
 *
 * The shipment's own stamp wins. A shipment moved to Delivered by status or by its last stop can
 * lack it (20027, Ryne 2026-11-12), so fall back to the loads' stamp, then the latest actual time
 * recorded at a delivery stop, then when the shipment's status became DELIVERED.
 */
export interface DeliveredFacts {
  deliveredAt?: string | null
  loadDeliveredAt?: string | null
  stops?: readonly { type?: string | null; arrivedAt?: string | null; departedAt?: string | null }[] | null
  status?: string | null
  statusChangedAt?: string | null
}

/** The latest actual time at a delivery stop: departure, else arrival. */
export function lastDeliveryActual(stops: DeliveredFacts['stops']): string | null {
  const times = (stops ?? [])
    .filter((s) => String(s.type ?? '').toLowerCase() === 'delivery')
    .map((s) => s.departedAt || s.arrivedAt || null)
    .filter((t): t is string => !!t)
    .sort()
  return times.length ? times[times.length - 1] : null
}

export function deliveredTimeOf(f: DeliveredFacts | null | undefined): string | null {
  if (!f) return null
  if (f.deliveredAt) return f.deliveredAt
  if (f.loadDeliveredAt) return f.loadDeliveredAt
  const actual = lastDeliveryActual(f.stops)
  if (actual) return actual
  if (String(f.status ?? '').toUpperCase() === 'DELIVERED' && f.statusChangedAt) return f.statusChangedAt
  return null
}
