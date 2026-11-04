import { useEffect, useRef } from 'react'
import { getLoads, listLoadsByShipmentIds, listShipmentsByNumber } from '@/lib/apiClient'
import { normalizePro } from '@/lib/proNumber'
import { mergeLoads, useAppStore } from '@/store/useAppStore'

/**
 * Put the loads a queue points at into the store, whatever age. The store only holds a
 * window of the Load table, but a queue row (factoring item, POD submission, intake item)
 * can outlive that window by months. Ids not already held are read in one `getLoads`
 * batch; a PRO no held load carries is resolved through the shipment number index (voided
 * included) and those shipments' loads. Each id/PRO is asked for once.
 */
export function useResolveLoads(
  loadIds: ReadonlyArray<string | null | undefined>,
  pros: ReadonlyArray<string | null | undefined> = [],
): void {
  const held = useAppStore((s) => s.loads)
  const askedIds = useRef<Set<string>>(new Set())
  const askedPros = useRef<Set<string>>(new Set())
  const idKey = [...new Set(loadIds.filter((id): id is string => !!id))].sort().join('|')
  const proKey = [...new Set(pros.map((p) => (p ?? '').trim()).filter(Boolean))].sort().join('|')

  useEffect(() => {
    if (!idKey && !proKey) return
    const heldIds = new Set(held.map((l) => l.id))
    const missingIds = idKey.split('|').filter((id) => id && !heldIds.has(id) && !askedIds.current.has(id))
    const heldPros = new Set(held.map((l) => normalizePro(l.aljexId)))
    const missingPros = proKey.split('|').filter((p) => {
      const n = normalizePro(p)
      return p && n && !heldPros.has(n) && !askedPros.current.has(p)
    })
    if (missingIds.length === 0 && missingPros.length === 0) return
    for (const id of missingIds) askedIds.current.add(id)
    for (const p of missingPros) askedPros.current.add(p)

    const merge = (rows: Awaited<ReturnType<typeof getLoads>>) =>
      useAppStore.setState((s) => ({ loads: mergeLoads(s.loads, rows) }))
    const forget = (err: unknown) => {
      for (const id of missingIds) askedIds.current.delete(id)
      for (const p of missingPros) askedPros.current.delete(p)
      console.warn('[useResolveLoads] could not read the queue loads', err)
    }
    if (missingIds.length > 0) getLoads(missingIds).then(merge).catch(forget)
    for (const p of missingPros) {
      listShipmentsByNumber(p)
        .then((shipments) => (shipments.length > 0 ? listLoadsByShipmentIds(shipments.map((s) => s.id)) : []))
        .then(merge)
        .catch(forget)
    }
  }, [idKey, proKey, held])
}
