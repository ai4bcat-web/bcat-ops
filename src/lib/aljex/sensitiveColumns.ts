/**
 * Aljex columns that must never reach a staged chunk, a report, a log or the browser wizard's file
 * (AW_TAXID_DESIGN.md section 4.7): carrier tax ID, bank account and routing number. Matching is on the
 * normalised header (case, spacing and punctuation ignored) so `Fed/SS #`, `fed ss` and `FED_SS_#` all hit.
 * Only header NAMES are ever reported; no cell is read.
 */
const SENSITIVE = ['fedss', 'bankaccount', 'routing']

const norm = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Headers (as given) that name a sensitive column. Empty = the file is clean. */
export function findSensitiveHeaders(headers: readonly string[]): string[] {
  return headers.filter((h) => {
    const n = norm(h)
    return SENSITIVE.some((s) => n === s || n === `${s}number`)
  })
}

export const SENSITIVE_COLUMNS_MESSAGE = 'The file still contains sensitive column(s): remove them before upload. Tax ID, bank account and routing numbers are never imported through this path.'
