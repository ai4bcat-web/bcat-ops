/**
 * Accepting a payment as paid in full (Ryne 2026-11-16): when a customer pays a little short or over,
 * the amount received can be accepted as the whole settlement so no open balance or customer credit is left.
 * The difference is not hidden: a short pay is closed as a write-off with the reason below, and an overpay is
 * recorded on the payment (`overageAcceptedCents`), so both can be found and reported.
 */

/** Reasons written on the adjustments an accepted difference leaves, so reports can find them. */
export const SHORT_PAY_REASON = 'Short pay accepted as paid in full'
export const OVERPAY_REASON = 'Overpay accepted as paid in full'

/** A write-off note that marks an accepted short pay. */
export const isShortPayNote = (note: string | null | undefined): boolean => /^Short pay accepted/i.test((note ?? '').trim())

/** The full reason: the standard text, with the person's own words after it. */
export const differenceReason = (base: string, note: string | null | undefined): string => {
  const extra = (note ?? '').trim()
  return extra ? `${base}: ${extra}` : base
}
