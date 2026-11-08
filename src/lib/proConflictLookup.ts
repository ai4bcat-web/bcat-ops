import { listLoadsByShipmentIds, listShipmentsByNumber } from '@/lib/apiClient'
import { proConflict } from '@/lib/proConflict'
import type { ProConflict, ProConflictLoad } from '@/lib/proConflict'

/**
 * `proConflict` over ALL history, not just the loads the store has windowed in.
 *
 * The store holds a window of the Load table, but a voided load keeps its Pro # forever,
 * so the check also reads the shipments carrying this number (voided included) and their
 * loads. Awaited at the moment of the check, never on render. The server's atomic claim
 * (SET_LOAD_PRO) stays the authority; if this extra read fails the windowed answer stands.
 */
export async function proConflictAllHistory(
  held: readonly ProConflictLoad[],
  pro: string | null | undefined,
  current?: ProConflictLoad | null,
): Promise<ProConflict> {
  const number = (pro ?? '').trim()
  if (!number) return { kind: 'none' }
  let extra: ProConflictLoad[] = []
  try {
    const shipments = await listShipmentsByNumber(number)
    if (shipments.length > 0) extra = await listLoadsByShipmentIds(shipments.map((s) => s.id))
  } catch (err) {
    console.warn('[proConflict] history lookup failed; using the windowed loads', err)
  }
  const byId = new Map<string, ProConflictLoad>()
  for (const l of [...held, ...extra]) if (!byId.has(l.id)) byId.set(l.id, l)
  return proConflict([...byId.values()], number, current)
}
