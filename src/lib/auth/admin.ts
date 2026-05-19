/**
 * Single source of truth for admin email addresses.
 *
 * To add a second admin: append their email to ADMIN_EMAILS — no other changes needed.
 * To move to Cognito-group-based admin in the future: replace isAdminEmail with a
 * hasGroup(user, 'admins') check and update the Lambda's identity check to match.
 */
export const ADMIN_EMAILS = ['ryne@bcatcorp.com', 'dennis@bcatcorp.com'] as const

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return (ADMIN_EMAILS as readonly string[]).includes(email.toLowerCase().trim())
}
