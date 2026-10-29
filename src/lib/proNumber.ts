/**
 * Normalize a PRO for comparison. The live table stores them padded ("14452  "), and
 * a driver may type "PRO 13364" or "pro#13364" for the same load, so strip to
 * alphanumerics and upper-case. Returns null for anything too short to be a real PRO.
 *
 * This is the app's single definition of PRO identity. ProClaim rows are keyed by its
 * output, so two spellings of one PRO always normalize to the same key and can never
 * both be issued as separate claims.
 */
export function normalizePro(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (raw.toUpperCase() === 'N/A') return null
  // Drop a leading "PRO" label if the person typed one, then keep alphanumerics.
  const stripped = raw.replace(/^\s*pro\s*#?\s*/i, '')
  const key = stripped.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return key.length >= 3 ? key : null
}
