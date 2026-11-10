import type { ShipmentDocumentRecord } from '@/types/tms'

/** The newest active POD among a shipment's documents, or null. */
export function newestPod(docs: readonly ShipmentDocumentRecord[]): ShipmentDocumentRecord | null {
  return docs
    .filter((d) => d.type === 'POD' && (d.status ?? 'ACTIVE') === 'ACTIVE' && !d.voidedAt)
    .sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')))[0] ?? null
}

/** Every active POD document (all pages, driver-filed ones waiting for review included), oldest first. */
export function activePods(docs: readonly ShipmentDocumentRecord[]): ShipmentDocumentRecord[] {
  return docs
    .filter((d) => d.type === 'POD' && (d.status ?? 'ACTIVE') === 'ACTIVE' && !d.voidedAt && d.reviewStatus !== 'REJECTED')
    .sort((a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')))
}
