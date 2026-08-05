import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listAllComplianceDocuments, createComplianceDocument, updateComplianceDocument,
  uploadComplianceDocument, getComplianceDocUrl, isAcceptedDoc,
} from '@/lib/complianceClient'
import { slotState, type SlotState } from '@/lib/fileHub'
import type { ComplianceDocument, ComplianceEntityType } from '@/types'

/** The newest document per (entityId, documentType) — older uploads stay in S3 for audit. */
function indexLatest(docs: ComplianceDocument[]): Map<string, ComplianceDocument> {
  const map = new Map<string, ComplianceDocument>()
  for (const d of docs) {
    const key = `${d.entityType}::${d.entityId}::${d.documentType}`
    const prev = map.get(key)
    if (!prev || (d.updatedAt ?? d.createdAt) > (prev.updatedAt ?? prev.createdAt)) map.set(key, d)
  }
  return map
}

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
  const [docs, setDocs] = useState<ComplianceDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setDocs(await listAllComplianceDocuments())
    } catch (err) {
      console.error('[useFileHub] load', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const latest = useMemo(() => indexLatest(docs), [docs])

  const byEntity = useMemo(() => {
    const map = new Map<string, ComplianceDocument[]>()
    for (const d of latest.values()) {
      const k = `${d.entityType}::${d.entityId}`
      const list = map.get(k)
      if (list) list.push(d)
      else map.set(k, [d])
    }
    return map
  }, [latest])

  const docFor = useCallback(
    (entityType: ComplianceEntityType, entityId: string, documentType: string) =>
      latest.get(`${entityType}::${entityId}::${documentType}`),
    [latest],
  )

  const docsForEntity = useCallback(
    (entityType: ComplianceEntityType, entityId: string) => byEntity.get(`${entityType}::${entityId}`) ?? [],
    [byEntity],
  )

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

    // Replacing an existing slot updates that record so history stays on one row;
    // otherwise create it. Either way it lands in the store every other page reads.
    const existing = docFor(params.entityType, params.entityId, params.documentType)
    const saved = existing
      ? await updateComplianceDocument(existing.id, {
          s3Key,
          title: params.title,
          expirationDate: params.expirationDate ?? null,
          status: 'VALID',
          uploadedBy: 'INTERNAL',
          verifiedBy: params.uploadedByUser ?? undefined,
        })
      : await createComplianceDocument({
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

    setDocs((prev) => {
      const without = prev.filter((d) => d.id !== saved.id)
      return [...without, saved]
    })
    return saved
  }, [docFor])

  return {
    loading, error, docFor, docsForEntity, stateFor, upload,
    urlFor: getComplianceDocUrl,
    refresh: load,
  }
}
