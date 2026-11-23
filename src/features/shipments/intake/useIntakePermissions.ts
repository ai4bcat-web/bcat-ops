import { useAuth } from '@/hooks/useAuth'

/**
 * Anyone who can open the Intake pages may look; only the owner, ADMIN or a user holding the
 * `intakeReview` page grant may edit, move or dismiss. The server enforces the same rule.
 *
 * Owner-or-ADMIN here means the owner or a member of the Cognito ADMIN group, which is exactly what the server's
 * INTAKE_DELETE checks. `useAuth().isAdmin` is wider (it also counts the legacy admin e-mail list), so using it showed
 * Delete to people the server then refused ("Forbidden: INTAKE_DELETE requires owner or ADMIN").
 */
export function useIntakePermissions(): { canReview: boolean; isOwnerOrAdmin: boolean } {
  const { user, isOwner, hasPageAccess } = useAuth()
  const isOwnerOrAdmin = Boolean(isOwner || user?.groups.includes('ADMIN'))
  return { isOwnerOrAdmin, canReview: isOwnerOrAdmin || hasPageAccess('intakeReview') }
}
