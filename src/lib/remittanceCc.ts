/**
 * Who is copied on every remittance e-mail (Ryne 2026-11-18: billing@bcatcorp.com on every one,
 * automatic or sent by hand). The list lives on `TmsSettings.remittanceCcEmails`; when nobody has
 * ever saved one it is the default below, so the copy works the moment this ships. An explicitly
 * saved empty list means "copy nobody".
 */
export const DEFAULT_REMITTANCE_CC: readonly string[] = ['billing@bcatcorp.com']

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function isCcEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_SHAPE.test(value)
}

/** Lower-case, trimmed, valid, de-duplicated, in the order given. */
export function normalizeCcList(list: readonly string[] | null | undefined): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    const email = String(raw ?? '').trim().toLowerCase()
    if (email && isCcEmail(email) && !out.includes(email)) out.push(email)
  }
  return out
}

/**
 * The copy list for one remittance: the saved list (or the default when none was ever saved),
 * minus anyone already on the To line so nobody gets the same e-mail twice.
 */
export function remittanceCcFor(
  saved: readonly string[] | null | undefined,
  to: readonly string[],
): string[] {
  const base = saved == null ? DEFAULT_REMITTANCE_CC : saved
  const toSet = new Set(to.map((email) => email.trim().toLowerCase()))
  return normalizeCcList(base).filter((email) => !toSet.has(email))
}
