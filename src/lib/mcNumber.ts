/**
 * Customer MC numbers typed by hand (Ryne 2026-11-16: fix a missing MC from Ready to Invoice). "MC 123456", "mc#123456" and
 * "123-456" all store as the digits, so OTR and the factoring checks always read the same shape.
 */
export interface MoreMc {
  /** What to store: digits only, or null when the field was left empty. */
  value: string | null
  /** False when the text cannot be an MC number at all (letters or symbols left after the prefix is removed). */
  ok: boolean
  /** A soft warning: it is all digits but not a length MC numbers usually are. */
  warning: string | null
}

export function normalizeMc(raw: string | null | undefined): MoreMc {
  const text = (raw ?? '').trim()
  if (text === '') return { value: null, ok: true, warning: null }
  const stripped = text.replace(/^mc\b[\s#:.-]*/i, '').replace(/^mc(?=\d)/i, '').replace(/[\s-]/g, '').replace(/^#/, '')
  if (!/^\d+$/.test(stripped)) return { value: null, ok: false, warning: null }
  // MC numbers run from a few digits (old authorities) up to 7; eight or more, or fewer than four, is almost always a typo.
  const warning = stripped.length < 4 || stripped.length > 8 ? 'That does not look like an MC number (usually 5 to 7 digits). Check it before saving.' : null
  return { value: stripped, ok: true, warning }
}
