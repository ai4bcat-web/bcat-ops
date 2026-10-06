/**
 * Which loads have a rate confirmation and a POD on file — for the loads grid.
 *
 * Built ONCE for the page, not once per row. Paperwork lives in three stores and the grid
 * shows hundreds of loads; asking per row is how a list ends up making hundreds of
 * requests. The whole answer is a few hundred rows, so it is fetched once and answered
 * from memory.
 *
 * The three stores, all of which count:
 *   - `Load.rateConfirmKey`  — uploaded in the drawer, or attached from a Slack tender.
 *   - `PodDocument`          — a POD that reached JobsDone and a human linked.
 *   - `DriverSubmissionDoc`  — what an owner operator or an Ivan driver sent from the app,
 *                              and what staff uploaded on their behalf.
 *
 * Reading only the first two is what made a driver's POD invisible on the load while they
 * could see it in their own app.
 */
import { useCallback, useEffect, useState } from 'react'
import { listPods } from '@/lib/podsClient'
import { listDriverSubmissions } from '@/lib/driverSubmissionsClient'
import {
  buildPodIndex, loadHasPod, loadHasRatecon, type PodIndex, type PodSubmissionLike,
} from '@/lib/podPresence'
import type { Load } from '@/types'

export interface LoadPaperwork {
  index: PodIndex | null
  /**
   * False when a store could not be read.
   *
   * The columns show "unknown" rather than red in that case: a red cross means "no
   * paperwork", and saying that because a query failed would send somebody chasing a driver
   * who already sent it.
   */
  known: boolean
  loading: boolean
  refresh: () => void
}

export function useLoadPaperwork(loads: Load[]): LoadPaperwork {
  const [index, setIndex] = useState<PodIndex | null>(null)
  const [known, setKnown] = useState(true)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  const refresh = useCallback(() => setReloadKey((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false

    const build = async () => {
      let ok = true

      const jobsdoneLoadIds: string[] = []
      try {
        let nextToken: string | undefined
        for (let page = 0; page < 100; page++) {
          const res = await listPods({ nextToken })
          for (const doc of res.items) if (doc.loadId) jobsdoneLoadIds.push(doc.loadId)
          nextToken = res.nextToken ?? undefined
          if (!nextToken) break
        }
      } catch (err) {
        console.warn('[useLoadPaperwork] could not read JobsDone PODs', err)
        ok = false
      }

      let submissions: PodSubmissionLike[] = []
      try {
        submissions = (await listDriverSubmissions()).map((s) => ({
          loadId: s.loadId,
          referenceNumber: s.referenceNumber,
          hasPodDoc: s.docs.some((d) => d.kind === 'POD'),
          hasRateconDoc: s.docs.some((d) => d.kind === 'RATECON'),
        }))
      } catch (err) {
        console.warn('[useLoadPaperwork] could not read driver submissions', err)
        ok = false
      }

      // A rate con on the Load itself — the drawer upload and the Slack tender attachment.
      const rateconLoadIds = loads
        .filter((l) => ((l as Load & { rateConfirmKey?: string }).rateConfirmKey ?? '').trim())
        .map((l) => l.id)

      if (cancelled) return
      setIndex(buildPodIndex({ jobsdoneLoadIds, submissions, rateconLoadIds }))
      setKnown(ok)
      setLoading(false)
    }

    void build()
    return () => { cancelled = true }
    // `loads` only contributes rateConfirmKey; rebuilding on every grid edit would refetch
    // both stores for nothing, so this keys on the count rather than the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads.length, reloadKey])

  return { index, known, loading, refresh }
}

/** Convenience so the grid cells read as a question rather than an index lookup. */
export function paperworkFor(
  index: PodIndex | null,
  load: Load,
): { pod: boolean | null; ratecon: boolean | null } {
  if (!index) return { pod: null, ratecon: null }
  return { pod: loadHasPod(index, load), ratecon: loadHasRatecon(index, load) }
}
