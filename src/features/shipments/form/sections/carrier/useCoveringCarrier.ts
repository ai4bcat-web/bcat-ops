/**
 * The Carrier row the carrier block shows. The form's own pick wins; once the load is covered the
 * assignment's carrier is used even when the form value was never set (Cover from the dialog books the
 * load without touching the form). A carrier missing from the loaded directory (just added, or a stale
 * cached list) is read by id. A covered carrier MyCarrierPackets has never synced (an Aljex import has
 * no insurance until it is pulled) is pulled once, so the card fills in instead of showing blanks.
 */
import { useEffect, useRef, useState } from 'react'
import { getCarrier, pullMcpCarrier } from '@/lib/apiClient'
import type { CarrierRecord } from '@/types/tms'

export function coveringCarrierId(formCarrierId: string, activeCarrierId: string | null | undefined): string {
  return formCarrierId || activeCarrierId || ''
}

/** A covered carrier with an MC or DOT that MyCarrierPackets has never synced. */
export function needsMcpPull(c: Pick<CarrierRecord, 'mcpSyncedAt' | 'mcpStatus' | 'mcNumber' | 'dotNumber'>): boolean {
  return !c.mcpSyncedAt && !c.mcpStatus && !!(c.mcNumber || c.dotNumber)
}

export function useCoveringCarrier(id: string, directory: CarrierRecord[], covered: boolean): CarrierRecord | null {
  const listed = id ? directory.find((c) => c.id === id) ?? null : null
  const [fetched, setFetched] = useState<CarrierRecord | null>(null)
  const pulled = useRef(new Set<string>())

  // Not in the loaded directory: read the row itself.
  useEffect(() => {
    if (!id || listed) return
    let live = true
    getCarrier(id).then((c) => { if (live) setFetched(c) }).catch(() => { /* the block shows what the form has */ })
    return () => { live = false }
  }, [id, listed])

  const base = listed ?? (fetched?.id === id ? fetched : null)

  // Covered but never synced from MyCarrierPackets: pull it once, then show the filled-in row.
  useEffect(() => {
    if (!covered || !base || !needsMcpPull(base) || pulled.current.has(base.id)) return
    pulled.current.add(base.id)
    let live = true
    pullMcpCarrier(base.id)
      .then(() => getCarrier(base.id))
      .then((c) => { if (live && c) setFetched(c) })
      .catch(() => { /* MCP not live or no packet: the card says it is not synced */ })
    return () => { live = false }
  }, [covered, base])

  // A fresher row read after a pull beats the cached directory copy.
  if (fetched?.id === id && base && fetched !== base && (fetched.updatedAt ?? '') > (base.updatedAt ?? '')) return fetched
  return base
}
