/**
 * Which document is on file for which shipment, from the driver's side.
 *
 * The settlement already knows a POD is "in" — the server computes that from the POD store
 * and from the driver's own submissions. What it did not know is WHICH document that is, so
 * the app could tell a driver their POD had arrived and still not show it to them. That is
 * the gap a driver notices first: they photographed something at a dock, the row went green,
 * and they have no way to check they photographed the right thing.
 *
 * Matching is the same rule the office uses (src/lib/podPresence.ts): by load id where the
 * submission carries one, otherwise by the PRO the driver typed. Shared rule, shared answer —
 * a document the office sees on a load must be the one the driver sees on that row.
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchSubmissions, type SubmissionKind, type SubmissionSummary, type SubmissionDocument } from '../driverApi'
import { normalizePro } from '@/lib/podPresence'

export interface TripDoc {
  submissionId: string
  document: SubmissionDocument
  /** Where a photo was taken, when the driver sent it from a stop. */
  stopId?: string | null
  stopLabel?: string | null
  note?: string | null
}

export interface TripDocIndex {
  /** The finished document of this kind for a shipment, or null if none is on file here. */
  find: (kind: SubmissionKind, loadId: string | null | undefined, pro: string | null | undefined) => TripDoc | null
  /** Every document of a kind on a shipment — photos are many, a POD is one. */
  findAll: (kind: SubmissionKind, loadId: string | null | undefined, pro: string | null | undefined) => TripDoc[]
  loading: boolean
  refresh: () => void
}

function matches(
  sub: SubmissionSummary,
  loadId: string | null | undefined,
  pro: string | null | undefined,
): boolean {
  if (loadId && (sub.loadId ?? '').trim() === loadId) return true
  const want = normalizePro(pro)
  if (!want) return false
  return normalizePro(sub.referenceNumber) === want
}

export function useTripDocs(): TripDocIndex {
  const [subs, setSubs] = useState<SubmissionSummary[] | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const refresh = useCallback(() => setReloadKey((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    fetchSubmissions()
      .then((rows) => { if (!cancelled) setSubs(rows) })
      // A failure here only costs the preview button; the settlement itself still reads.
      .catch(() => { if (!cancelled) setSubs([]) })
    return () => { cancelled = true }
  }, [reloadKey])

  const find = useCallback(
    (kind: SubmissionKind, loadId: string | null | undefined, pro: string | null | undefined): TripDoc | null => {
      for (const sub of subs ?? []) {
        if (!matches(sub, loadId, pro)) continue
        const document = (sub.documents ?? []).find((d) => d.kind === kind)
        if (document) return { submissionId: sub.id, document }
      }
      return null
    },
    [subs],
  )

  const findAll = useCallback(
    (kind: SubmissionKind, loadId: string | null | undefined, pro: string | null | undefined): TripDoc[] => {
      const out: TripDoc[] = []
      for (const sub of subs ?? []) {
        if (!matches(sub, loadId, pro)) continue
        for (const document of (sub.documents ?? []).filter((d) => d.kind === kind)) {
          out.push({ submissionId: sub.id, document, stopId: sub.stopId ?? null, stopLabel: sub.stopLabel ?? null, note: sub.note ?? null })
        }
      }
      return out
    },
    [subs],
  )

  return { find, findAll, loading: subs === null, refresh }
}
