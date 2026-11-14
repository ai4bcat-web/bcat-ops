/**
 * "Move to manual invoice" for a load OTR rejected (Ryne 2026-11-14): the wording the customer
 * record keeps, shared by the Lambda (which writes it) and the page (which previews it).
 *
 * Relative imports only: the finance Lambda bundles this file by path.
 */

/** YYYY-MM-DD → MM/DD/YYYY, the office's date. */
function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}

/** "Changed to manual invoice on 11/14/2026 by ryne@…: OTR rejected PRO 14538 — OTR marked this invoice Dead…" */
export function manualInvoiceChangeNote(input: { at: string; by: string; pro: string; reason: string }): string {
  return `Changed to manual invoice on ${usDate(input.at)} by ${input.by}: OTR rejected PRO ${input.pro} — ${input.reason}`
}

/** The customer's notes with the change line added on top; the earlier notes are kept below it. */
export function notesWithChange(notes: string | null | undefined, line: string): string {
  const prior = (notes ?? '').trim()
  return prior ? `${line}\n${prior}` : line
}
