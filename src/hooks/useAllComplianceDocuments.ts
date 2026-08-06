import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  subscribe, getSnapshot, ensureLoaded, indexLatest, groupByEntity, docKey,
} from '@/lib/complianceDocStore'
import type { ComplianceDocument, ComplianceEntityType } from '@/types'

export interface AllComplianceDocumentsState {
  docs:    ComplianceDocument[]
  loading: boolean
  error:   string | null
  loaded:  boolean
  /** The current document for one slot, or undefined when nothing is on file. */
  docFor:  (entityType: ComplianceEntityType, entityId: string, documentType: string) => ComplianceDocument | undefined
  /** Every current document for one entity. */
  docsForEntity: (entityType: ComplianceEntityType, entityId: string) => ComplianceDocument[]
  refresh: () => Promise<void>
}

/**
 * Shared read access to EVERY compliance document, for the views that need the whole
 * set (Files hub, Asset Documents, sidebar badge, expiring-docs widget).
 *
 * Not to be confused with useComplianceDocuments, which loads one entity's documents
 * for the Compliance pages — that stays entity-scoped and cheap.
 *
 * Each of those views used to run its own limit-5000 scan AND its own "which document
 * is current" rule, with different tie-breaks, so they could disagree about the same
 * truck. This hook gives them one dataset and one rule; mounting it N times still
 * causes ONE request.
 */
export function useAllComplianceDocuments(): AllComplianceDocumentsState {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => { void ensureLoaded() }, [])

  const latest = useMemo(() => indexLatest(state.docs), [state.docs])
  const byEntity = useMemo(() => groupByEntity(latest), [latest])

  const docFor = useCallback(
    (entityType: ComplianceEntityType, entityId: string, documentType: string) =>
      latest.get(docKey(entityType, entityId, documentType)),
    [latest],
  )

  const docsForEntity = useCallback(
    (entityType: ComplianceEntityType, entityId: string) => byEntity.get(`${entityType}::${entityId}`) ?? [],
    [byEntity],
  )

  const refresh = useCallback(() => ensureLoaded(true), [])

  return {
    docs: state.docs,
    loading: state.loading,
    error: state.error,
    loaded: state.loaded,
    docFor,
    docsForEntity,
    refresh,
  }
}
