/**
 * Step AP — the board's batch rules without React: what a shipment row shows against the
 * Load Review requirements, the nine-row selection cap, and how a batch's per-row
 * outcomes are put together. The requirement list itself is `lib/reviewRequirements`, the
 * one file the Load Review gate and the release gate read on the server too.
 */
import { reviewFactsOfRow } from '@/lib/loadReview'
import {
  MAX_REVIEW_BATCH,
  batchCapMessage,
  evaluateReviewRequirements,
  resolveReviewRequirements,
} from '@/lib/reviewRequirements'
import type { ShipmentRow } from './shipmentViews'

export { MAX_REVIEW_BATCH, batchCapMessage, reviewFactsOfRow }

interface RequirementSources {
  customers: ReadonlyArray<{ id: string; reviewRequirements?: string[] | null }>
  /** The organisation default (TmsSettings.reviewRequirements). */
  orgDefault: readonly string[] | null | undefined
}

export function requirementsForRow(row: Pick<ShipmentRow, 'customerId'>, src: RequirementSources) {
  const customer = row.customerId ? src.customers.find((c) => c.id === row.customerId) : undefined
  return resolveReviewRequirements(customer?.reviewRequirements, src.orgDefault)
}

/** One line of a batch's outcome: either the client's refusal or the server's answer. */
export interface BatchOutcome {
  rowId: string
  rowLabel: string
  ok: boolean
  /** Why it failed, one entry per reason. Empty on success. */
  reasons: string[]
  /** A note on a success ("Already in Load Review"). */
  note?: string
}

/** Rows that cannot be pushed to Load Review, each with every reason. */
export function pushRefusals(
  rows: readonly ShipmentRow[],
  src: RequirementSources,
): BatchOutcome[] {
  const out: BatchOutcome[] = []
  for (const row of rows) {
    const facts = reviewFactsOfRow(row)
    // A POD the row cannot speak for is the server's call (it reads the documents), never a client refusal.
    const requirements = requirementsForRow(row, src).filter((key) => key !== 'podReceived' || facts.podReceived != null)
    const evaluation = evaluateReviewRequirements(requirements, facts)
    if (!evaluation.ok) {
      out.push({ rowId: row.id, rowLabel: row.number, ok: false, reasons: evaluation.failures.map((f) => f.message) })
    }
  }
  return out
}

/** The selection after a toggle, or the refusal that stopped it. Never over the cap. */
export function toggleSelection(
  selected: readonly string[],
  id: string,
): { ids: string[]; refusal: string | null } {
  if (selected.includes(id)) return { ids: selected.filter((x) => x !== id), refusal: null }
  if (selected.length >= MAX_REVIEW_BATCH) return { ids: [...selected], refusal: batchCapMessage() }
  return { ids: [...selected, id], refusal: null }
}

/** Select-all: the first nine of what is shown, and say so when that left rows out. */
export function selectAllUpToCap(
  selected: readonly string[],
  shownIds: readonly string[],
): { ids: string[]; refusal: string | null } {
  if (selected.length === shownIds.length && shownIds.every((id) => selected.includes(id))) return { ids: [], refusal: null }
  const ids = shownIds.slice(0, MAX_REVIEW_BATCH)
  return { ids, refusal: shownIds.length > MAX_REVIEW_BATCH ? batchCapMessage() : null }
}

/** Server rows → outcomes. A reason list wins over the one-line message. */
export function outcomesFromServer(
  results: ReadonlyArray<{ shipmentId: string; number: string | null; ok: boolean; message?: string | null; reasons?: string[] | null }>,
  labelOf: (shipmentId: string, fallback: string | null) => string,
): BatchOutcome[] {
  return results.map((r) => ({
    rowId: r.shipmentId,
    rowLabel: labelOf(r.shipmentId, r.number),
    ok: r.ok,
    reasons: r.ok ? [] : r.reasons && r.reasons.length > 0 ? r.reasons : [r.message ?? 'Failed'],
    ...(r.ok && r.message ? { note: r.message } : {}),
  }))
}
