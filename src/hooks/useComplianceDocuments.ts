import { useState, useEffect, useCallback } from 'react'
import {
  listComplianceDocuments,
  createComplianceDocument,
  updateComplianceDocument,
} from '@/lib/complianceClient'
import type { ComplianceDocument, ComplianceEntityType } from '@/types'

const NO_DOCUMENTS: ComplianceDocument[] = []

/** ComplianceDocuments for a single driver or truck. */
export function useComplianceDocuments(entityType: ComplianceEntityType, entityId: string | null) {
  const key = `${entityType}|${entityId ?? ''}`
  const [documents, setDocuments] = useState<ComplianceDocument[]>([])
  // Derived: true until a fetch for the CURRENT entity has settled.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!entityId) return Promise.resolve()
    return listComplianceDocuments(entityType, entityId)
      .then((next) => { setDocuments(next) })
      .catch((err: unknown) => { console.error('[useComplianceDocuments] fetch error', err) })
      .finally(() => setLoadedKey(key))
  }, [entityType, entityId, key])

  useEffect(() => { void load() }, [load])

  const loading = entityId != null && loadedKey !== key

  const addDocument = useCallback(
    async (input: Omit<ComplianceDocument, 'id' | 'createdAt' | 'updatedAt'>) => {
      const created = await createComplianceDocument(input)
      setDocuments((prev) => [created, ...prev])
      return created
    },
    [],
  )

  const patchDocument = useCallback(
    async (id: string, patch: Partial<Omit<ComplianceDocument, 'id' | 'createdAt' | 'updatedAt'>>) => {
      const updated = await updateComplianceDocument(id, patch)
      setDocuments((prev) => prev.map((d) => (d.id === id ? updated : d)))
      return updated
    },
    [],
  )

  return { documents: entityId ? documents : NO_DOCUMENTS, loading, refresh: load, addDocument, patchDocument }
}
