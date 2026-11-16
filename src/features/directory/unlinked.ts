/**
 * Unlinked loads (Ryne 2026-11-16: "i'll do the customer links manually … can i do it in the customer profiles?").
 * Pure helpers shared by the customer profile, the Directory view and Needs review: which unlinked shipments look like a
 * customer (the same fuzzy match the shipment's "Link customer…" picker uses), the search, and the sweep's questions.
 */
import { findCustomerMatches } from '@/lib/tmsDirectory'
import type { UnlinkedShipment } from '@/lib/apiClient'
import type { CustomerRecord } from '@/types/tms'

/** A candidate below this is not offered on a customer's own profile (the Search box still finds it). */
export const CANDIDATE_MIN_SCORE = 0.5

export interface UnlinkedCandidate {
  shipment: UnlinkedShipment
  /** 0–1, how closely the typed name matches this customer's name or aliases. */
  score: number
}

/** The shipments whose typed name looks like `customer`, best match first. */
export function candidatesFor(customer: CustomerRecord, rows: readonly UnlinkedShipment[]): UnlinkedCandidate[] {
  const out: UnlinkedCandidate[] = []
  // A profile can be open on an inactive customer; its own loads are still worth linking.
  const self = { ...customer, active: true } as CustomerRecord
  for (const shipment of rows) {
    const match = findCustomerMatches(shipment.customerName, [self])[0]
    if (match && match.score >= CANDIDATE_MIN_SCORE) out.push({ shipment, score: match.score })
  }
  return out.sort((a, b) => b.score - a.score || String(b.shipment.number ?? '').localeCompare(String(a.shipment.number ?? ''), undefined, { numeric: true }))
}

/** Free-text search over PRO, typed name and lane. */
export function searchUnlinked(rows: readonly UnlinkedShipment[], query: string): UnlinkedShipment[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter((r) => [r.number, r.customerName, r.originCity, r.destinationCity, r.status]
    .some((v) => v != null && String(v).toLowerCase().includes(q)))
}

/** "High / Medium / Low" for a score, shown beside the percentage. */
export function confidenceLabel(score: number): string {
  if (score >= 0.85) return 'High'
  if (score >= 0.65) return 'Medium'
  return 'Low'
}

/** The best directory customer for a typed name, or null when nothing is close enough to suggest. */
export function bestCustomerFor(name: string, customers: readonly CustomerRecord[]): { customer: CustomerRecord; score: number } | null {
  const top = findCustomerMatches(name, customers as CustomerRecord[])[0]
  return top && top.score >= CANDIDATE_MIN_SCORE ? { customer: top.record, score: top.score } : null
}

/** The sweep's questions ("13894: link … to …?") are seeded with this id prefix and the shipment in refs[0]. */
export const LINK_QUESTION_PREFIX = 'oq-link-customer-'

export function isLinkCustomerQuestion(q: { id: string; details: { source?: string | null } }): boolean {
  return q.id.startsWith(LINK_QUESTION_PREFIX) || (q.details.source ?? '').startsWith('Unlinked-customer sweep')
}

/** An unlinked-customer question names exactly one shipment; its id when it does. */
export function linkQuestionShipment(q: { details: { refs: { pro: string; shipmentId?: string | null; party?: string | null }[] } }): { shipmentId: string; pro: string; typedName: string } | null {
  const ref = q.details.refs[0]
  if (!ref?.shipmentId) return null
  return { shipmentId: ref.shipmentId, pro: ref.pro, typedName: ref.party ?? '' }
}
