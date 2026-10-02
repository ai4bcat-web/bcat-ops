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
        setError(err instanceof Error ? err.message : 'Could not load driver documents')
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
        .flatMap((sub) =>
          sub.docs.map((d) => {
            // Prefer the cleaned copy; fall back to the raw upload until it exists.
            const key = d.scanStatus === 'READY' && d.enhancedKey ? d.enhancedKey : d.s3Key
            return {
              ...d,
              driverName: sub.driverName,
              source: sub.source,
              submittedByEmail: sub.submittedByEmail,
              url: urls[key] ?? null,
              enhanced: key !== d.s3Key,
            }
          }),
        )
        // Newest first, and a multi-page document keeps its page order within a day.
        .sort((a, b) =>
          String(b.uploadedAt).localeCompare(String(a.uploadedAt)) ||
          (a.pageNumber ?? 0) - (b.pageNumber ?? 0),
        ),
    [mine, urls],
  )

  // Presign only what is actually on screen, once each.
  useEffect(() => {
    const wanted = docs.map((d) =>
      d.scanStatus === 'READY' && d.enhancedKey ? d.enhancedKey : d.s3Key,
    )
    const missing = wanted.filter((key) => !urls[key])
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
