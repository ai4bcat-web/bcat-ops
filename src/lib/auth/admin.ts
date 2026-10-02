/**
 * Legacy feature-level administrators (for example, private-document controls).
 * These addresses do NOT grant page access. Only the owner and the Cognito ADMIN
 * group bypass page grants; everyone else needs explicit page groups.
 */
export const ADMIN_EMAILS = ['ryne@bcatcorp.com', 'dennis@bcatcorp.com'] as const

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return (ADMIN_EMAILS as readonly string[]).includes(email.toLowerCase().trim())
}

/**
 * The single owner permitted to view and manage users / user permissions.
 * Only the owner may manage user permissions. Enforced client-side (UsersPage +
 * NavBar) and server-side (userManagement Lambda).
 */
export const OWNER_EMAIL = 'ryne@bcatcorp.com'

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return email.toLowerCase().trim() === OWNER_EMAIL
}

/**
 * Who may delete a factoring queue row.
 *
 * Deliberately narrower than ADMIN_EMAILS and not the ADMIN group: deleting a row drops
 * the record that a PRO was ever sent for factoring, and the only way back is to forward
 * the original email again. Ryne and Jenny run factoring, so it is theirs.
 */
export const FACTORING_DELETE_EMAILS = ['ryne@bcatcorp.com', 'jenny@bcatcorp.com'] as const

export function canDeleteFactoringItem(email: string | null | undefined): boolean {
  if (!email) return false
  return (FACTORING_DELETE_EMAILS as readonly string[]).includes(email.toLowerCase().trim())
}
