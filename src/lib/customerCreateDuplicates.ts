/**
 * The one rule for "this customer already exists" (Ryne 2026-11-12: never let us create a
 * duplicate). Shared by the New Customer dialog, which checks as you type, and the
 * UPSERT_CUSTOMER action, which refuses the create — so the screen and the server cannot
 * disagree about what a duplicate is.
 *
 * A match is any one of:
 *  - the same MC number (digits only: "MC-123456" == "123456"),
 *  - the same DOT number (digits only),
 *  - the same name once case, punctuation and legal suffixes are ignored
 *    ("ADDISON TRANSPORTATION" == "Addison Transportation, Inc.").
 *
 * Inactive customers count: re-creating a customer we stopped working with is still a
 * duplicate. Merged-away rows do not (their survivor is the record).
 */
import { normalizeCustomerName } from './customerDuplicates'

export interface ExistingCustomerLike {
  id: string
  name?: string | null
  aliases?: readonly string[] | null
  mcNumber?: string | null
  dotNumber?: string | null
  mergedIntoId?: string | null
}

export interface CustomerCandidate {
  name?: string | null
  mcNumber?: string | null
  dotNumber?: string | null
}

export type DuplicateReason = 'MC' | 'DOT' | 'NAME'

export interface CustomerDuplicate {
  id: string
  name: string
  mcNumber: string | null
  reason: DuplicateReason
}

/** Digits only; null when nothing is left. */
export function authorityDigits(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '')
  return digits ? digits : null
}

/** The first existing customer the candidate collides with (MC, then DOT, then name). */
export function findDuplicateCustomer(
  candidate: CustomerCandidate,
  existing: readonly ExistingCustomerLike[],
  opts: { excludeId?: string } = {},
): CustomerDuplicate | null {
  const mc = authorityDigits(candidate.mcNumber)
  const dot = authorityDigits(candidate.dotNumber)
  const name = candidate.name ? normalizeCustomerName(candidate.name) : ''
  const live = existing.filter((c) => c.id !== opts.excludeId && !c.mergedIntoId)
  const hit = (c: ExistingCustomerLike, reason: DuplicateReason): CustomerDuplicate => ({
    id: c.id,
    name: String(c.name ?? ''),
    mcNumber: authorityDigits(c.mcNumber),
    reason,
  })
  if (mc) {
    const c = live.find((x) => authorityDigits(x.mcNumber) === mc)
    if (c) return hit(c, 'MC')
  }
  if (dot) {
    const c = live.find((x) => authorityDigits(x.dotNumber) === dot)
    if (c) return hit(c, 'DOT')
  }
  if (name) {
    const c = live.find((x) =>
      normalizeCustomerName(String(x.name ?? '')) === name ||
      (x.aliases ?? []).some((a) => normalizeCustomerName(a) === name),
    )
    if (c) return hit(c, 'NAME')
  }
  return null
}

const MARKER = 'This customer already exists:'

/** The refusal text. It carries the id so the dialog can offer "Open existing". */
export function duplicateCustomerMessage(d: CustomerDuplicate): string {
  const mc = d.mcNumber ? ` (MC ${d.mcNumber})` : ''
  const why = d.reason === 'MC' ? 'same MC number' : d.reason === 'DOT' ? 'same DOT number' : 'same name'
  return `${MARKER} ${d.name}${mc} — ${why} [id ${d.id}]`
}

/** Reads a refusal back into its parts; null for any other error. */
export function parseDuplicateCustomerError(message: string | null | undefined): { id: string; name: string; text: string } | null {
  const text = String(message ?? '')
  const at = text.indexOf(MARKER)
  if (at < 0) return null
  const m = /\[id ([^\]]+)\]/.exec(text)
  if (!m) return null
  const body = text.slice(at)
  const name = body.slice(MARKER.length).replace(/\s*\(MC [^)]*\).*$/, '').replace(/\s+—.*$/, '').trim()
  return { id: m[1], name, text: body.replace(/\s*\[id [^\]]+\]/, '') }
}
