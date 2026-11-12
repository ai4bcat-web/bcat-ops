/**
 * The Intake "already built" check for the rows on screen: collects each open row's reference candidates, asks the shipment table once for
 * the shipments whose search key holds any of them (cached for five minutes per value), and matches whole words in memory (`intakeBuilt`).
 * A row that arrived already flagged (staging stored its matches, and its references still hold them) is answered from that, with no read.
 * Everything else is checked here: older rows, edited rows, and rows the server found nothing for (a shipment may be built later).
 * A failed read leaves the rows unflagged: the check is advice, never a gate that blocks the queue.
 */
import { useEffect, useMemo, useState } from 'react'
import { listShipmentsBySearchKeys, type ShipmentKeyRow } from '@/lib/apiClient'
import { builtMatchesFor, needsBuiltCheck, refCandidates, storedBuiltMatches, type BuiltMatch } from '@/lib/intakeBuilt'
import type { IntakeLoadRecord } from '@/types/intake'

const TTL_MS = 5 * 60 * 1000
/** value (lower case) -> when it was read and the shipments that held it. */
const cache = new Map<string, { at: number; rows: ShipmentKeyRow[] }>()
const inflight = new Map<string, Promise<void>>()

async function ensure(values: string[]): Promise<void> {
  const now = Date.now()
  const stale = values.filter((v) => { const c = cache.get(v); return !c || now - c.at > TTL_MS })
  if (stale.length === 0) return
  const key = stale.join('|')
  let p = inflight.get(key)
  if (!p) {
    p = listShipmentsBySearchKeys(stale)
      .then((rows) => {
        const at = Date.now()
        for (const v of stale) cache.set(v, { at, rows: rows.filter((r) => (r.searchKey ?? '').toLowerCase().includes(v)) })
      })
      .finally(() => { inflight.delete(key) })
    inflight.set(key, p)
  }
  await p
}

/** Test hook: forget what was read. */
export function resetBuiltMatchCache(): void {
  cache.clear()
  inflight.clear()
}

export function useBuiltMatches(rows: readonly IntakeLoadRecord[]): { matches: Map<string, BuiltMatch[]>; error: string | null } {
  const stored = useMemo(() => {
    const out = new Map<string, BuiltMatch[]>()
    for (const r of rows) { const m = storedBuiltMatches(r); if (m && m.length > 0) out.set(r.id, m) }
    return out
  }, [rows])
  const checked = useMemo(() => rows.filter((r) => needsBuiltCheck(r) && !stored.has(r.id)), [rows, stored])
  const values = useMemo(
    () => [...new Set(checked.flatMap((r) => refCandidates(r).map((c) => c.value.toLowerCase())))].sort(),
    [checked],
  )
  const sig = values.join('|')
  const [done, setDone] = useState<{ sig: string; error: string | null } | null>(null)

  useEffect(() => {
    if (values.length === 0) return undefined
    let live = true
    ensure(values)
      .then(() => { if (live) setDone({ sig, error: null }) })
      .catch((err: unknown) => {
        console.warn('[intake] already-built check failed', err)
        if (live) setDone({ sig, error: err instanceof Error ? err.message : 'The already-built check could not run' })
      })
    return () => { live = false }
    // `values` is derived from `sig`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  const ready = done?.sig === sig && done.error == null
  const matches = useMemo(() => {
    const out = new Map<string, BuiltMatch[]>(stored)
    if (!ready) return out
    const byId = new Map<string, ShipmentKeyRow>()
    for (const v of values) for (const s of cache.get(v)?.rows ?? []) byId.set(s.id, s)
    const shipments = [...byId.values()]
    const tokens = new Map<string, Set<string>>()
    for (const r of checked) {
      const m = builtMatchesFor(r, shipments, tokens)
      if (m.length) out.set(r.id, m)
    }
    return out
  }, [ready, values, checked, stored])

  return { matches, error: done?.sig === sig ? done.error : null }
}
