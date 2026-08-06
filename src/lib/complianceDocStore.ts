/**
 * One shared copy of every ComplianceDocument, for every consumer.
 *
 * WHY: the Files hub, Asset Documents, the sidebar alert badge and the expiring-docs
 * widget each ran their own `listAllComplianceDocuments()` (limit 5000) and each built
 * its own "latest document per entity+type" index — with DIFFERENT tie-breaks. That
 * meant they could disagree about which document is current for the same truck: one
 * showing Valid while another showed Expired.
 *
 * This module owns the fetch (deduped and cached, so N consumers cause one request) and
 * the index rule, so disagreement is structurally impossible.
 */
import { listAllComplianceDocuments } from './complianceClient'
import type { ComplianceDocument, ComplianceEntityType } from '@/types'

export interface ComplianceDocState {
  docs:    ComplianceDocument[]
  loading: boolean
  error:   string | null
  /** False until the first successful load, so consumers can tell empty from unloaded. */
  loaded:  boolean
}

let state: ComplianceDocState = { docs: [], loading: false, error: null, loaded: false }
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

const setState = (patch: Partial<ComplianceDocState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Stable reference between changes — required by useSyncExternalStore. */
export const getSnapshot = (): ComplianceDocState => state

/**
 * Load once and share. Concurrent callers join the in-flight request rather than
 * issuing their own; `force` refetches after a mutation elsewhere.
 */
export function ensureLoaded(force = false): Promise<void> {
  if (inFlight) return inFlight
  if (state.loaded && !force) return Promise.resolve()

  setState({ loading: true, error: null })
  inFlight = listAllComplianceDocuments()
    .then((docs) => { setState({ docs, loading: false, loaded: true, error: null }) })
    .catch((err) => {
      console.error('[complianceDocs] load failed', err)
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => { inFlight = null })
  return inFlight
}

/** Merge a created/updated document into the shared copy so every consumer sees it. */
export function applyDoc(saved: ComplianceDocument): void {
  setState({ docs: [...state.docs.filter((d) => d.id !== saved.id), saved] })
}

/** Drop a deleted document from the shared copy. */
export function removeDoc(id: string): void {
  setState({ docs: state.docs.filter((d) => d.id !== id) })
}

/** Test seam — resets the module between cases. */
export function __resetForTests(next: Partial<ComplianceDocState> = {}): void {
  state = { docs: [], loading: false, error: null, loaded: false, ...next }
  inFlight = null
}

// ── The one index rule ──────────────────────────────────────────────────────────

export const docKey = (entityType: string, entityId: string, documentType: string) =>
  `${entityType}::${entityId}::${documentType}`

/**
 * Is `a` the more current document than `b` for the same entity + type?
 *
 * `createdAt` — the most recently UPLOADED document wins. Uploads create a new row and
 * keep the old one for audit history (see uploadComplianceDocument), so recency of
 * upload is what "current" means. Editing an old document's expiration must NOT promote
 * it over a newer upload, which is why this is not `updatedAt`.
 *
 * `updatedAt` breaks exact ties only, so the ordering is deterministic.
 */
export function isMoreCurrent(a: ComplianceDocument, b: ComplianceDocument): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt
  return (a.updatedAt ?? '') > (b.updatedAt ?? '')
}

/** Newest document per entity+type. */
export function indexLatest(docs: ComplianceDocument[]): Map<string, ComplianceDocument> {
  const map = new Map<string, ComplianceDocument>()
  for (const d of docs) {
    const key = docKey(d.entityType, d.entityId, d.documentType)
    const cur = map.get(key)
    if (!cur || isMoreCurrent(d, cur)) map.set(key, d)
  }
  return map
}

/** Every current document for one entity, keyed for quick lookup by the callers. */
export function groupByEntity(latest: Map<string, ComplianceDocument>): Map<string, ComplianceDocument[]> {
  const byEntity = new Map<string, ComplianceDocument[]>()
  for (const d of latest.values()) {
    const k = `${d.entityType}::${d.entityId}`
    const list = byEntity.get(k)
    if (list) list.push(d); else byEntity.set(k, [d])
  }
  return byEntity
}

export type { ComplianceEntityType }
