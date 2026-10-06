import { getStops } from '@/lib/stops'
import type { Load, Stop } from '@/types'

// Batory's ladder needs three screenshots per stop: the REQUEST email (→ REQUESTED),
// then the CONFIRMED email + E2Open update (→ CONFIRMED). Non-Batory loads don't use
// screenshots at all — their confirmation is the RATECON on the load.
export const PROOFS_PER_STOP = 3

export function stopProofCount(s: Stop): number {
  return (s.apptProofs?.request ? 1 : 0) + (s.apptProofs?.e2open ? 1 : 0) + (s.apptProofs?.email ? 1 : 0)
}

/**
 * Completeness across EVERY stop on the shipment — "n/9" on a three-stop load.
 *
 * It used to count only the first pickup and the last delivery, which meant a three-stop
 * Batory load could show a green, complete 6/6 while the middle stop had no screenshots on
 * it at all. A badge that says finished while a stop is unproven is worse than no badge:
 * it is the one place somebody checks before they stop chasing.
 */
export function loadProofCount(load: Load): { have: number; want: number } {
  const stops = getStops(load) as Stop[]
  return { have: stops.reduce((n, s) => n + stopProofCount(s), 0), want: stops.length * PROOFS_PER_STOP }
}
