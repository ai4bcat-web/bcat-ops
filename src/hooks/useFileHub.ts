import { useCallback } from 'react'
import {
  createComplianceDocument, updateComplianceDocument,
  uploadComplianceDocument, getComplianceDocUrl, isAcceptedDoc,
} from '@/lib/complianceClient'
import { applyDoc, removeDoc } from '@/lib/complianceDocStore'
import { findLinkedTask } from '@/lib/documentReview'
import { setTaskStatus, deleteComplianceDocument } from '@/lib/complianceClient'
import { useAllComplianceDocuments } from './useAllComplianceDocuments'
import { slotState, type SlotState } from '@/lib/fileHub'
import type { ComplianceDocument, ComplianceEntityType } from '@/types'

export interface FileHubState {
  loading: boolean
  error:   string | null
  /** Latest document for one slot, or undefined when nothing is uploaded. */
  docFor:  (entityType: ComplianceEntityType, entityId: string, documentType: string) => ComplianceDocument | undefined
  /** Every document on file for an entity, newest-per-type. */
  docsForEntity: (entityType: ComplianceEntityType, entityId: string) => ComplianceDocument[]
  stateFor: (entityType: ComplianceEntityType, entityId: string, documentType: string) => SlotState
  /** Upload (or replace) a slot's file. Writes to the shared ComplianceDocument store. */
  upload:  (params: {
    entityType: ComplianceEntityType
    entityId:   string
    documentType: string
    title:      string
    file:       File
    expirationDate?: string | null
    uploadedByUser?: string | null
  }) => Promise<ComplianceDocument>
  /** Change a document's expiration date (Asset Documents allowed this inline). */
  setExpiration: (doc: ComplianceDocument, date: string | null) => Promise<ComplianceDocument>
  /** Mark a slot not-required (or required again) — the WAIVED status. */
  setWaived: (
    entityType: ComplianceEntityType, entityId: string, documentType: string,
    title: string, doc: ComplianceDocument | undefined, waived: boolean,
  ) => Promise<ComplianceDocument>
  /** Delete a document and reopen the checklist item it was satisfying. */
  remove:  (doc: ComplianceDocument) => Promise<void>
  /** Presigned URL for viewing/downloading a stored file. */
  urlFor:  (s3Key: string) => Promise<string>
  refresh: () => void
}

/**
 * Reads the ONE document store the whole app already writes to (ComplianceDocument), so
 * anything uploaded in Compliance, Onboarding, Driver Documents or Asset Documents shows
 * up in the Files hub without being uploaded twice — and vice versa.
 */
export function useFileHub(): FileHubState {
  // One shared dataset + one "which document is current" rule, via useAllComplianceDocuments.
  const shared = useAllComplianceDocuments()
  const { docFor, docsForEntity } = shared

  const stateFor = useCallback(
    (entityType: ComplianceEntityType, entityId: string, documentType: string) =>
      slotState(docFor(entityType, entityId, documentType)),
    [docFor],
  )

  const upload = useCallback(async (params: {
    entityType: ComplianceEntityType
    entityId:   string
    documentType: string
    title:      string
    file:       File
    expirationDate?: string | null
    uploadedByUser?: string | null
  }) => {
    if (!isAcceptedDoc(params.file)) {
      throw new Error('Use a PDF, JPG, PNG or HEIC under 15MB')
    }
    const s3Key = await uploadComplianceDocument(params.entityType, params.entityId, params.documentType, params.file)

    // ALWAYS create a new row. Uploading a replacement is a new document, and the old
    // row is deliberately kept as audit history — the same thing Asset Documents does
    // (see uploadComplianceDocument). This hook used to update in place, which both
    // destroyed that history and made it disagree with every other consumer about
    // which document is current.
    const saved = await createComplianceDocument({
      entityType: params.entityType,
      entityId:   params.entityId,
      documentType: params.documentType,
      title:      params.title,
      s3Key,
      expirationDate: params.expirationDate ?? null,
      status:     'VALID',
      uploadedBy: 'INTERNAL',
      verifiedBy: params.uploadedByUser ?? undefined,
    })
    applyDoc(saved)

    // Tick the checklist item this document satisfies. Uploading the CDL and then
    // finding its box still unticked made the file and the checklist disagree, and left
    // someone chasing a document that was already on file.
    // Staff uploads count as verified — the driver portal's own uploads land
    // PENDING_REVIEW instead and are settled when they're approved.
    try {
      const task = await findLinkedTask(saved)
      if (task && task.status !== 'COMPLETE') {
        await setTaskStatus(task.id, 'COMPLETE', {
          completedBy: params.uploadedByUser ?? undefined,
          complianceDocumentId: saved.id,
        })
      }
    } catch (err) {
      // The document IS saved; a checklist that didn't tick is worth a log, not a failure.
      console.error('[useFileHub] could not settle the checklist item', err)
    }

    return saved
  }, [])

  const setExpiration = useCallback(async (doc: ComplianceDocument, date: string | null) => {
    const saved = await updateComplianceDocument(doc.id, {
      expirationDate: date,
      // Keep the stored status honest with the new date.
      status: date ? (slotState({ expirationDate: date }) as ComplianceDocument['status']) : 'VALID',
    })
    applyDoc(saved)
    return saved
  }, [])

  const setWaived = useCallback(async (
    entityType: ComplianceEntityType, entityId: string, documentType: string,
    title: string, doc: ComplianceDocument | undefined, waived: boolean,
  ) => {
    if (doc) {
      const saved = await updateComplianceDocument(doc.id, {
        status: waived ? 'WAIVED' : (doc.s3Key ? 'VALID' : 'MISSING'),
        waivedReason: waived ? 'Marked not required' : null,
      })
      applyDoc(saved)
      return saved
    }
    // Nothing uploaded yet — a waiver is recorded as a document row with no file.
    const saved = await createComplianceDocument({
      entityType, entityId, documentType, title,
      s3Key: null, status: 'WAIVED', uploadedBy: 'INTERNAL',
      waivedReason: 'Marked not required',
    })
    applyDoc(saved)
    return saved
  }, [])

  const remove = useCallback(async (doc: ComplianceDocument) => {
    await deleteComplianceDocument(doc.id)
    removeDoc(doc.id)

    // Reopen whatever this document was satisfying. Leaving the box ticked after the
    // file is gone would tell everyone a document exists that doesn't — the same
    // file/checklist disagreement that ticking-on-upload fixed, in reverse.
    try {
      const task = await findLinkedTask(doc)
      if (task && task.status === 'COMPLETE') {
        await setTaskStatus(task.id, 'PENDING')
      }
    } catch (err) {
      console.error('[useFileHub] could not reopen the checklist item', err)
    }
  }, [])

  return {
    loading: shared.loading,
    error: shared.error,
    docFor, docsForEntity, stateFor, upload,
    setExpiration, setWaived, remove,
    urlFor: getComplianceDocUrl,
    refresh: shared.refresh,
  }
}
