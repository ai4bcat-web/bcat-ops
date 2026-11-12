import type { ShipmentBundle } from '@/types/tms'

/**
 * Ryne 2026-11-12: only a delivered load goes to Load Review. The shipment status rolls up the least-advanced
 * load, so DELIVERED means every load delivered; the server refuses a push on that status alone (never a
 * timestamp: imported history can be DELIVERED with no stamps). Returns the sentence to show while it has not
 * (stops counted as "left the stop" so a multi-stop load reads 1 of 2), or null once it has.
 */
export function notDeliveredBlock(bundle: Pick<ShipmentBundle, 'shipment' | 'loads'>): string | null {
  if (bundle.shipment.status === 'DELIVERED') return null
  const stops = bundle.loads.flatMap((load) => (Array.isArray(load.stops) ? load.stops : []))
  const progress = stops.length > 1 ? ` — ${stops.filter((s) => s.departedAt != null).length} of ${stops.length} stops delivered` : ''
  return `Only delivered loads can go to Load review${progress}`
}
