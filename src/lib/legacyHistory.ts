/**
 * Imported Aljex history is exempt from the document, reference, driver and customer checks: its paperwork
 * stays in the Aljex archive. That exemption ends once the load is pushed into Load Review. A pushed import is
 * live freight finishing in BCAT Ops, so it is checked like any other load (14860, 2026-11-16: an imported load
 * went through review and out to billing with no POD because the gate skipped every document check).
 *
 * One definition, used by the release gate, the review checks, the doc cache and the Load Review screens.
 */
export interface LegacyHistoryFacts {
  legacyImported?: boolean | null
  loadReviewPushedAt?: string | null
}

export function wentThroughLoadReview(facts: Pick<LegacyHistoryFacts, 'loadReviewPushedAt'> | null | undefined): boolean {
  return typeof facts?.loadReviewPushedAt === 'string' && facts.loadReviewPushedAt.trim() !== ''
}

/** True only for imported history that has not been through Load Review. */
export function isLegacyHistory(facts: LegacyHistoryFacts | null | undefined): boolean {
  return facts?.legacyImported === true && !wentThroughLoadReview(facts)
}
