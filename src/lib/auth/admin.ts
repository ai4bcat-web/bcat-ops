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

/**
 * The single owner permitted to view and manage users / user permissions.
 * Stricter than isAdminEmail — admins still get full page access, but only the
 * owner can open the Users page and change other users' access. Enforced both
 * client-side (UsersPage + NavBar) and server-side (userManagement Lambda).
 */
export const OWNER_EMAIL = 'ryne@bcatcorp.com'

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return email.toLowerCase().trim() === OWNER_EMAIL
}
