import type { ShipmentDocumentRecord } from '@/types/tms'

/** The newest active POD among a shipment's documents, or null. */
export function newestPod(docs: readonly ShipmentDocumentRecord[]): ShipmentDocumentRecord | null {
  return docs
    .filter((d) => d.type === 'POD' && (d.status ?? 'ACTIVE') === 'ACTIVE' && !d.voidedAt)
    .sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')))[0] ?? null
}
