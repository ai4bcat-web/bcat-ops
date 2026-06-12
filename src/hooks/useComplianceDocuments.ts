import { useState, useEffect, useCallback } from 'react'
import {
  listComplianceDocuments,
  createComplianceDocument,
  updateComplianceDocument,
} from '@/lib/complianceClient'
import type { ComplianceDocument, ComplianceEntityType } from '@/types'

/** ComplianceDocuments for a single driver or truck. */
export function useComplianceDocuments(entityType: ComplianceEntityType, entityId: string | null) {
  const [documents, setDocuments] = useState<ComplianceDocument[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!entityId) {
      setDocuments([])
      setLoading(false)
      return
    }
    try {
      setDocuments(await listComplianceDocuments(entityType, entityId))
    } catch (err) {
      console.error('[useComplianceDocuments] fetch error', err)
    } finally {
      setLoading(false)
    }
  }, [entityType, entityId])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

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

  return { documents, loading, refresh: load, addDocument, patchDocument }
}
