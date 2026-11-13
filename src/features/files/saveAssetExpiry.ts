import { assetExpiryPatch } from '@/lib/fileHub'
import { useAppStore } from '@/store/useAppStore'
import type { ComplianceDocument } from '@/types'

/**
 * Save a truck's or trailer's insurance / IFTA / IRP expiry from any screen. The date is
 * kept in two places (the Equipment record and the uploaded certificate) and the app judges
 * the unit on the certificate when one is on file, so both are written: an edit that only
 * reached the record used to save and then change nothing on screen. `null` clears.
 */
export async function saveAssetExpiry({ assetId, documentType, date, doc, setExpiration }: {
  assetId: string
  documentType: string
  date: string | null
  /** The uploaded certificate for this slot, if any. */
  doc: ComplianceDocument | undefined
  setExpiration: (doc: ComplianceDocument, date: string | null) => Promise<unknown>
}): Promise<void> {
  const patch = assetExpiryPatch(documentType, date)
  if (!patch) throw new Error(`${documentType} has no expiry on the unit record`)
  await useAppStore.getState().saveEquipmentDates(assetId, patch)
  if (doc && doc.status !== 'WAIVED' && doc.s3Key) await setExpiration(doc, date)
}
