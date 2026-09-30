import { getStops } from '@/lib/stops'
import type { Load, Stop } from '@/types'

// Batory's ladder needs three screenshots per stop: the REQUEST email (→ REQUESTED),
// then the CONFIRMED email + E2Open update (→ CONFIRMED). Non-Batory loads don't use
// screenshots at all — their confirmation is the RATECON on the load.
export const PROOFS_PER_STOP = 3

export function stopProofCount(s: Stop): number {
  return (s.apptProofs?.request ? 1 : 0) + (s.apptProofs?.e2open ? 1 : 0) + (s.apptProofs?.email ? 1 : 0)
}

/** "n/6" completeness across a Batory shipment's pickup + delivery. */
export function loadProofCount(load: Load): { have: number; want: number } {
  const stops = getStops(load)
  const pu = stops.find((s) => s.type === 'pickup')
  const de = [...stops].reverse().find((s) => s.type === 'delivery')
  const ends = [pu, de].filter(Boolean) as Stop[]
  return { have: ends.reduce((n, s) => n + stopProofCount(s), 0), want: ends.length * PROOFS_PER_STOP }
}
