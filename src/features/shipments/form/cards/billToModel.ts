/** Pure Bill To card logic (formatting, requirement chips, credit warning). */
import { REVIEW_REQUIREMENT_LABELS, resolveReviewRequirements } from '@/lib/reviewRequirements'
import { requiredDocTypesFor } from '@/lib/shipmentDocuments'
import type { Address, CustomerRecord, TmsSettings } from '@/types/tms'

const DASH = '—'

export function formatAddress(a: Address | null | undefined): string {
  if (!a) return ''
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return [a.street, cityLine].filter(Boolean).join(', ')
}

export function termsText(days: number | null): string {
  return days === null ? DASH : days === 0 ? 'Due on receipt' : `Net ${days}`
}

/** Plain-language invoicing requirements: POD / PO-ref flags first, then the Step AP review list. */
export function requirementChips(customer: CustomerRecord, settings: TmsSettings | null): string[] {
  const chips: string[] = []
  const docs = requiredDocTypesFor(customer, settings).types
  if (docs.includes('POD')) chips.push('POD required')
  const review = resolveReviewRequirements(customer.reviewRequirements, settings?.reviewRequirements)
  const refRequired = review.includes('referenceNumber') || (customer.requiredReferences ?? []).length > 0
  if (refRequired) chips.push('PO / ref required')
  for (const r of review) {
    if (r === 'referenceNumber' || r === 'podReceived') continue
    chips.push(`${REVIEW_REQUIREMENT_LABELS[r]} required`)
  }
  return chips
}

export type CreditWarning = { kind: 'hold' } | { kind: 'over'; totalCents: number; availableCents: number } | null

/** Hold flag wins; otherwise this shipment's customer total against what is still available. */
export function creditWarning(onHold: boolean, availableCents: number | null, totalCents: number): CreditWarning {
  if (onHold) return { kind: 'hold' }
  if (availableCents !== null && totalCents > availableCents) return { kind: 'over', totalCents, availableCents }
  return null
}

