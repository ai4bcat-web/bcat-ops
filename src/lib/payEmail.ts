/**
 * Who is copied on every settlement email (box truck, owner operator, Ivan driver pay).
 * Ryne asked for Jenny to be on all of them (2026-10-28). The Cc field in the email
 * modal is pre-filled with this and can still be edited per send.
 */
export const PAY_EMAIL_CC = 'ryne@bcatcorp.com, jenny@bcatcorp.com'

/** Split a Cc field on commas / semicolons / whitespace into clean, unique addresses. */
export function splitAddresses(raw: string | null | undefined): string[] {
  const seen = new Set<string>()
  return (raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@') && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
}
