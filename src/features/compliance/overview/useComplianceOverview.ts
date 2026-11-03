import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAllComplianceDocuments } from '@/hooks/useAllComplianceDocuments'
import { useCarriers } from '@/hooks/useCarriers'
import { useReviewQueue } from '@/hooks/useReviewQueue'
import { useAppStore } from '@/store/useAppStore'
import { applyDoc } from '@/lib/complianceDocStore'
import { getComplianceDocUrl } from '@/lib/complianceClient'
import { getCarrierDocumentUrl, getTmsSettings, listCarrierDocuments } from '@/lib/apiClient'
import { buildOverviewRows, overviewCounts } from '@/lib/complianceOverview'
import type { OverviewRow } from '@/lib/complianceOverview'
import { errorText } from '@/lib/errorText'
import type { CarrierDocumentRecord } from '@/types/tms'

const todayLocalIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Everything the Document overview shows, assembled from data the app already loads.
 * Approve/Reject go through `useReviewQueue` — the one implementation that also settles
 * the onboarding task, writes the audit row and e-mails the driver.
 */
export function useComplianceOverview() {
  const { isAdmin, isOwner, hasPageAccess } = useAuth()
  const all = useAllComplianceDocuments()
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const carriers = useCarriers({ kind: 'all' })
  const review = useReviewQueue()
  const [carrierDocs, setCarrierDocs] = useState<CarrierDocumentRecord[]>([])
  const [carrierDocsError, setCarrierDocsError] = useState<string | null>(null)
  const [insuranceWarnDays, setInsuranceWarnDays] = useState<number | null>(null)
  const [todayIso] = useState(todayLocalIso)

  // Settings are optional garnish (the warning window); a failure falls back to the default.
  useEffect(() => {
    let alive = true
    listCarrierDocuments()
      .then((rows) => { if (alive) { setCarrierDocs(rows); setCarrierDocsError(null) } })
      .catch((err: unknown) => { if (alive) setCarrierDocsError(errorText(err)) })
    getTmsSettings()
      .then((s) => { if (alive) setInsuranceWarnDays(s?.insuranceWarnDays ?? null) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  const canReview = isAdmin || isOwner || hasPageAccess('compliance') || hasPageAccess('files')

  const rows = useMemo(
    () => buildOverviewRows({
      docs: all.docs, drivers, equipment, carriers: carriers.carriers, carrierDocs,
      insuranceWarnDays, canSeePrivate: isAdmin, todayIso,
    }),
    [all.docs, drivers, equipment, carriers.carriers, carrierDocs, insuranceWarnDays, isAdmin, todayIso],
  )
  const counts = useMemo(() => overviewCounts(rows), [rows])

  /** Only a driver/truck document that is awaiting review, and only for a permitted user. */
  const canActOn = useCallback(
    (row: OverviewRow) => canReview && row.kind === 'cd' && row.state === 'PENDING_REVIEW' && !!row.doc,
    [canReview],
  )

  const approve = useCallback(async (row: OverviewRow) => {
    if (!row.doc || !canActOn(row)) return
    applyDoc(await review.approveDocument(row.doc))
  }, [canActOn, review])

  const reject = useCallback(async (row: OverviewRow, reason: string) => {
    const trimmed = reason.trim()
    if (!row.doc || !trimmed || !canActOn(row)) return
    applyDoc(await review.rejectDocument(row.doc, trimmed))
  }, [canActOn, review])

  const urlFor = useCallback(
    (row: OverviewRow, s3Key: string) => (row.kind === 'carrier' ? getCarrierDocumentUrl(s3Key) : getComplianceDocUrl(s3Key)),
    [],
  )

  const refresh = useCallback(() => {
    void all.refresh()
    void carriers.refresh()
    void review.refresh()
    listCarrierDocuments()
      .then((r) => { setCarrierDocs(r); setCarrierDocsError(null) })
      .catch((err: unknown) => setCarrierDocsError(errorText(err)))
  }, [all, carriers, review])

  return {
    rows, counts, canActOn, approve, reject, urlFor, refresh,
    loading: all.loading && !all.loaded,
    error: all.error,
    carrierError: carriers.error ?? carrierDocsError,
  }
}
