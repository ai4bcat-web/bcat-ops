/**
 * Readiness helpers for a factoring row. Separate from the components so the queue and
 * its tests can use them without pulling React in.
 */
import { OTR_REQUIRED_FIELDS, type OtrReadiness } from '@/lib/otrInvoice'

/** "9 of 11" — the summary a human reads before the chips. */
export function fieldsReadyLabel(readiness: OtrReadiness | null): string {
  if (!readiness) return '—'
  const total = OTR_REQUIRED_FIELDS.length
  return `${total - readiness.missingFields.length} of ${total}`
}
