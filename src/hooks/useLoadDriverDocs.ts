/**
 * Documents a driver or staff member submitted for one load.
 *
 * Paperwork for a load lives in three stores and no screen used to read all of them:
 *
 *  - `Load.rateConfirmKey` — a rate confirmation uploaded from the Loads drawer.
 *  - `PodDocument` — a POD that reached JobsDone by text and was linked to the load.
 *  - `DriverSubmissionDoc` — what a driver scanned in the PWA, and what staff uploaded on
 *    a driver's behalf. Either kind, POD or rate confirmation.
 *
 * The Loads drawer only read the first two, so a driver could send a rate confirmation or
 * a POD from their phone, see it in their own app, and the office would see an empty slot
 * and chase them for it. This hook is the third store, keyed to a load the way everything
 * else now keys to it: by `loadId` when the submission carries one, otherwise by the PRO
 * the driver typed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listDriverSubmissions,
  getDriverDocUrl,
  type DriverSubmissionDocRecord,
  type SubmissionWithDocs,
} from '@/lib/driverSubmissionsClient'
import { normalizePro } from '@/lib/podPresence'

export interface LoadDriverDoc extends DriverSubmissionDocRecord {
  /** Who sent it, for the office to see at a glance. */
  driverName: string
  source: SubmissionWithDocs['source']
  submittedByEmail: SubmissionWithDocs['submittedByEmail']
  /**
   * Presigned, resolved lazily; null until it loads or if it fails. Points at the CLEANED
   * copy once the scan pipeline has produced one, since that is the copy anyone should
   * open or send on. The original stays in S3 as the record of what arrived.
   */
  url: string | null
  /** True when the url above is the cleaned scan rather than the raw upload. */
  enhanced: boolean
  /** How many pages the document carries. 1 for a loose page awaiting its merge. */
  pageCount: number
  /** True while the cleanup is still running on at least one page of this document. */
  cleaning: boolean
}

export interface LoadDriverDocs {
  pods: LoadDriverDoc[]
  ratecons: LoadDriverDoc[]
  loading: boolean
  error: string | null
  refresh: () => void
}

/** True when this submission belongs to the load, by id or by the PRO on it. */
function belongsToLoad(
  sub: SubmissionWithDocs,
  loadId: string | null | undefined,
  proNumber: string | null | undefined,
): boolean {
  if (loadId && (sub.loadId ?? '').trim() === loadId) return true
  const want = normalizePro(proNumber)
  if (!want) return false
  return normalizePro(sub.referenceNumber) === want
}

export function useLoadDriverDocs(
  loadId: string | null | undefined,
  proNumber: string | null | undefined,
): LoadDriverDocs {
  const [subs, setSubs] = useState<SubmissionWithDocs[] | null>(null)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const refresh = useCallback(() => setReloadKey((n) => n + 1), [])

  // A promise chain, not an async function: every state write lands after the fetch.
  useEffect(() => {
    if (!loadId && !normalizePro(proNumber)) return
    let cancelled = false
    listDriverSubmissions(1000)
      .then((rows) => { if (!cancelled) { setSubs(rows); setError(null) } })
      .catch((err: unknown) => {
        if (cancelled) return
        setSubs([])
        /*
         * Never an empty message.
         *
         * A GraphQL failure can carry a blank `message`, and the row rendered that blank as
         * an empty paragraph — so a load whose paperwork failed to load looked identical to
         * a load with no paperwork. Silence is the one thing this must not do: the whole
         * point of the panel is to stop the office chasing a driver for a POD they sent.
         */
        const detail = err instanceof Error ? err.message.trim() : ''
        setError(detail || 'Could not load the documents this driver sent — try Refresh.')
        console.error('[useLoadDriverDocs] failed', err)
      })
    return () => { cancelled = true }
  }, [loadId, proNumber, reloadKey])

  const mine = useMemo(
    () => (subs ?? []).filter((s) => belongsToLoad(s, loadId, proNumber)),
    [subs, loadId, proNumber],
  )

const docs = useMemo<LoadDriverDoc[]>(
    () =>
      mine
        .flatMap((sub) => {
          /*
           * One row per document, not per page.
           *
           * Once the pages have been cleaned and merged there is a single finished PDF, and
           * that is the document — showing six page rows beside it would invite someone to
           * send a page instead of the whole thing.
           */
          const combined: LoadDriverDoc[] = []
          for (const [kind, key] of [
            ['POD', sub.combinedPodKey],
            ['RATECON', sub.combinedRateconKey],
          ] as const) {
            if (!key) continue
            const pages = sub.docs.filter((d) => d.kind === kind)
            const newest = [...pages].sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0]
            if (!newest) continue
            combined.push({
              ...newest,
              id: `${sub.id}:${kind}:combined`,
              kind,
              s3Key: key,
              fileName: `${kind === 'POD' ? 'POD' : 'RateCon'}-${sub.referenceNumber?.trim() || sub.id.slice(-6)}.pdf`,
              contentType: 'application/pdf',
              pageNumber: null,
              driverName: sub.driverName,
              source: sub.source,
              submittedByEmail: sub.submittedByEmail,
              url: urls[key] ?? null,
              enhanced: pages.some((d) => d.scanStatus === 'READY'),
              pageCount: pages.length,
              cleaning: pages.some((d) => d.scanStatus === 'PENDING'),
            })
          }
          // Only fall back to individual pages while the merge has not produced one yet.
          const kindsDone = new Set(combined.map((d) => d.kind))
          const loose = sub.docs
            .filter((d) => !kindsDone.has(d.kind))
            .map((d) => {
              const key = d.scanStatus === 'READY' && d.enhancedKey ? d.enhancedKey : d.s3Key
              return {
                ...d,
                driverName: sub.driverName,
                source: sub.source,
                submittedByEmail: sub.submittedByEmail,
                url: urls[key] ?? null,
                enhanced: key !== d.s3Key,
                pageCount: 1,
                cleaning: d.scanStatus === 'PENDING',
              }
            })
          return [...combined, ...loose]
        })
        // Newest first, and a multi-page document keeps its page order within a day.
        .sort((a, b) =>
          String(b.uploadedAt).localeCompare(String(a.uploadedAt)) ||
          (a.pageNumber ?? 0) - (b.pageNumber ?? 0),
        ),
    [mine, urls],
  )

  /*
   * While a page is still being cleaned, look again.
   *
   * The cleanup is queued rather than awaited now — an upload returns as soon as the pages
   * are stored — so the finished PDF appears a few seconds after the screen first draws it.
   * Without this the office would see "cleaning up" until they reloaded the page, which is
   * the kind of thing that teaches people to distrust the status.
   *
   * Stops as soon as nothing is pending, so a settled load costs nothing.
   */
  const cleaning = docs.some((d) => d.cleaning)
  useEffect(() => {
    if (!cleaning) return
    const timer = setTimeout(() => setReloadKey((n) => n + 1), 4000)
    return () => clearTimeout(timer)
  }, [cleaning, reloadKey])

  // Presign only what is actually on screen, once each.
  useEffect(() => {
    const missing = docs.map((d) => d.s3Key).filter((key) => !urls[key])
    if (missing.length === 0) return
    let cancelled = false
    void Promise.all(
      missing.map(async (key) => {
        try {
          return [key, await getDriverDocUrl(key)] as const
        } catch {
          return null
        }
      }),
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const pair of pairs) if (pair) next[pair[0]] = pair[1]
      if (Object.keys(next).length) setUrls((prev) => ({ ...prev, ...next }))
    })
    return () => { cancelled = true }
  }, [docs, urls])

  return {
    pods: docs.filter((d) => d.kind === 'POD'),
    ratecons: docs.filter((d) => d.kind === 'RATECON'),
    loading: subs === null,
    error,
    refresh,
  }
}
