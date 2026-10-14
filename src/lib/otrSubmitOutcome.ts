/**
 * What a submit to OTR leaves behind when the invoice was created but the paperwork did
 * not all reach it.
 *
 * Documents used to be best-effort: the row moved to Pending with OTR with a note in the
 * corner, and an invoice sat at OTR with no POD or rate con on it until someone noticed.
 * Now a document that does not land keeps the row in Need to factor, in red, until it is
 * uploaded again and resent — OTR will not pay an invoice without its paperwork, so a
 * row without it is not pending anything.
 */
import type { FactoringItem } from '@/types'

/** The invoice exists at OTR, but a document is still missing there. Derived, not stored. */
export function otrDocsIncomplete(item: Pick<FactoringItem, 'otrInvoiceId' | 'status'>): boolean {
  return !!item.otrInvoiceId && item.status === 'NEED_TO_FACTOR'
}

/** Which documents the errors are about, in the order the row shows them. */
export function failedDocuments(errors: readonly string[]): Array<'POD' | 'Rate confirmation'> {
  const out: Array<'POD' | 'Rate confirmation'> = []
  if (errors.some((e) => /^POD\b/i.test(e))) out.push('POD')
  if (errors.some((e) => /^Rate confirmation\b/i.test(e))) out.push('Rate confirmation')
  return out
}

/** The sentence on the row: what did not arrive, and what to do about it. */
export function otrDocsErrorMessage(errors: readonly string[]): string {
  const which = failedDocuments(errors)
  const names = which.length ? which.join(' and ') : 'The documents'
  const detail = errors.map((e) => e.replace(/\s+/g, ' ').trim()).join('; ')
  return `${names} did not reach OTR. Upload ${which.length === 1 ? 'it' : 'them'} again on this row, then press Resend documents. (${detail})`
}

/** The row after a submit or a resend: pending only once every document is at OTR. */
export function afterOtrDocuments(errors: readonly string[]): { status: 'PENDING_WITH_OTR' | 'NEED_TO_FACTOR'; otrError: string | null } {
  return errors.length
    ? { status: 'NEED_TO_FACTOR', otrError: otrDocsErrorMessage(errors) }
    : { status: 'PENDING_WITH_OTR', otrError: null }
}
