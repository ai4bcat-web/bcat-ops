/**
 * Does this customer demand a PO / reference number on the order (Step AP + the customer's required
 * references)? True when the customer's `requiredReferences` list a PO, or when a review-requirement
 * list that somebody actually SET (the customer's own, else the org's) includes `referenceNumber`.
 * The built-in default list is not a demand: it would make every customer's PO mandatory at Create.
 */
import { normalizeReviewRequirements } from '@/lib/reviewRequirements'
import type { CustomerRecord, TmsSettings } from '@/types/tms'

export function poReferenceRequired(
  customer: Pick<CustomerRecord, 'requiredReferences' | 'reviewRequirements'> | null | undefined,
  settings: Pick<TmsSettings, 'reviewRequirements'> | null | undefined,
): boolean {
  if (!customer) return false
  if ((customer.requiredReferences ?? []).some((r) => r.code.trim().toLowerCase() === 'po' && r.countOnNewOrder >= 1)) return true
  const set = Array.isArray(customer.reviewRequirements) ? customer.reviewRequirements : settings?.reviewRequirements
  return Array.isArray(set) && normalizeReviewRequirements(set).includes('referenceNumber')
}
