import { listShipmentsByNumber } from '@/lib/apiClient'
import { getShipmentsByIds } from '@/lib/boardData'
import type { ShipmentRecord } from '@/types/tms'

/**
 * One shipment by the PRO number somebody typed (case-insensitive), or by id when
 * `matchId` is set. The number index is exact-case, so the typed spelling, upper case
 * and lower case are each tried; a match is confirmed against the typed text ignoring
 * case, the rule the full-board scan used.
 */
export async function findShipment(typed: string, matchId = false): Promise<ShipmentRecord | null> {
  const wanted = typed.trim().toLowerCase()
  if (wanted === '') return null
  if (matchId) {
    const byId = (await getShipmentsByIds([typed.trim()])).get(typed.trim())
    if (byId) return byId
  }
  for (const spelling of new Set([typed.trim(), typed.trim().toUpperCase(), wanted])) {
    const found = (await listShipmentsByNumber(spelling)).find((s) => (s.number ?? '').toLowerCase() === wanted)
    if (found) return found
  }
  return null
}
