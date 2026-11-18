/**
 * The leg numbers of the loads the AP page is showing (14598-1, 14598-2). Only loads that already show
 * up with two or more carriers are read, so this is a handful of ids, not the whole board. A failed
 * read leaves the PROs plain; nothing on this screen depends on the numbers.
 */
import { useEffect, useMemo, useState } from 'react'
import { listLoadCarriersByLoads } from '@/lib/apiClient'
import type { LoadCarrierRecord } from '@/types/tms'
import { legIndex, type LegIndex } from './apViews'

export function useLegIndex(loadIds: readonly string[], billedLegIds: ReadonlySet<string>): LegIndex {
  const [legsByLoad, setLegsByLoad] = useState<ReadonlyMap<string, readonly LoadCarrierRecord[]>>(new Map())
  // A stable key: the same ids in any order are one read.
  const key = useMemo(() => [...new Set(loadIds)].sort().join('|'), [loadIds])

  useEffect(() => {
    const wanted = key ? key.split('|') : []
    const missing = wanted.filter((id) => !legsByLoad.has(id))
    if (missing.length === 0) return
    let alive = true
    listLoadCarriersByLoads(missing)
      .then((fetched) => {
        if (!alive) return
        setLegsByLoad((prev) => {
          const next = new Map(prev)
          for (const id of missing) next.set(id, fetched.get(id) ?? [])
          return next
        })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [key, legsByLoad])

  return useMemo(() => legIndex(legsByLoad, billedLegIds), [legsByLoad, billedLegIds])
}
