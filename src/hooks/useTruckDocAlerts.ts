import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useAllComplianceDocuments } from './useAllComplianceDocuments'
import { TRUCK_DOC_SPECS, evaluateTruckDoc } from '@/lib/truckDocs'

/**
 * Counts out-of-date truck documents (expired or missing) across ACTIVE trucks, so the
 * sidebar can flag when attention is needed. Shares status logic with TruckDocumentsPage.
 */
export function useTruckDocAlerts() {
  const equipment = useAppStore((s) => s.equipment)
  // Shared dataset + shared "current document" rule — this used to run its own scan
  // and its own index, which could disagree with the Files hub about the same truck.
  const { docFor, docs } = useAllComplianceDocuments()

  return useMemo(() => {
    let expired = 0, missing = 0, expiring = 0
    for (const t of equipment) {
      if (t.type !== 'truck' || t.active === false) continue
      // Photos are part of the truck's file but are NOT a DOT compliance item —
      // a missing photo must not inflate the sidebar's out-of-date badge.
      for (const spec of TRUCK_DOC_SPECS) {
        if (spec.photo) continue
        const { state } = evaluateTruckDoc(t, spec, docFor('TRUCK', t.id, spec.key))
        if (state === 'EXPIRED') expired++
        else if (state === 'MISSING') missing++
        else if (state === 'EXPIRING_SOON') expiring++
      }
    }
    return { expired, missing, expiring, outOfDateCount: expired + missing }
  }, [docFor, docs, equipment])
}
