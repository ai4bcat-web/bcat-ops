import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { listAllComplianceDocuments } from '@/lib/complianceClient'
import { TRUCK_DOC_SPECS, evaluateTruckDoc } from '@/lib/truckDocs'
import type { ComplianceDocument } from '@/types'

/**
 * Counts out-of-date truck documents (expired or missing) across ACTIVE trucks, so the
 * sidebar can flag when attention is needed. Shares status logic with TruckDocumentsPage.
 */
export function useTruckDocAlerts() {
  const equipment = useAppStore((s) => s.equipment)
  const [docs, setDocs] = useState<ComplianceDocument[]>([])

  useEffect(() => {
    let alive = true
    listAllComplianceDocuments()
      .then((all) => { if (alive) setDocs(all.filter((d) => d.entityType === 'TRUCK')) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  return useMemo(() => {
    // latest doc per truck+type
    const latest = new Map<string, ComplianceDocument>()
    for (const d of docs) {
      const k = `${d.entityId}::${d.documentType}`
      const cur = latest.get(k)
      if (!cur || d.createdAt > cur.createdAt) latest.set(k, d)
    }

    let expired = 0, missing = 0, expiring = 0
    for (const t of equipment) {
      if (t.type !== 'truck' || t.active === false) continue
      for (const spec of TRUCK_DOC_SPECS) {
        const { state } = evaluateTruckDoc(t, spec, latest.get(`${t.id}::${spec.key}`))
        if (state === 'EXPIRED') expired++
        else if (state === 'MISSING') missing++
        else if (state === 'EXPIRING_SOON') expiring++
      }
    }
    return { expired, missing, expiring, outOfDateCount: expired + missing }
  }, [docs, equipment])
}
