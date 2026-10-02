/**
 * Readiness helpers for a factoring row. Separate from the components so the queue and
 * its tests can use them without pulling React in.
 */
import { OTR_REQUIRED_FIELDS, type OtrReadiness, type OtrRequiredField } from '@/lib/otrInvoice'

/** "9 of 11" — the summary a human reads before the chips. */
export function fieldsReadyLabel(readiness: OtrReadiness | null): string {
  if (!readiness) return '—'
  const total = OTR_REQUIRED_FIELDS.length
  return `${total - readiness.missingFields.length} of ${total}`
}

/**
 * Whether this row may be submitted to OTR.
 *
 * Computed from the missing-field and missing-document lists — the very things the row
 * draws red — rather than from the cached `ready` boolean beside them. Those are two
 * separate stored values, so they can disagree: a `ready: true` written by an earlier
 * version of the required-field list would enable Submit while the chips still showed
 * red, which is exactly the contradiction a person reports as "it let me submit".
 *
 * The server re-assembles and refuses independently. This keeps the button honest.
 */
export function isReadyToSubmit(readiness: OtrReadiness | null): boolean {
  if (!readiness) return false
  return readiness.missingFields.length === 0 && readiness.missingDocuments.length === 0
}

/** What is still missing, in words, for a tooltip or a refusal. */
export function whatIsMissing(readiness: OtrReadiness | null, label: (f: OtrRequiredField) => string): string {
  if (!readiness) return 'this row has not been prepared yet'
  const gaps = [...readiness.missingFields.map(label), ...readiness.missingDocuments]
  return gaps.join(', ')
}
