import { useAuth } from '@/hooks/useAuth'

/**
 * Anyone who can open the Intake pages may look; only the owner, ADMIN or a user holding the
 * `intakeReview` page grant may edit, move or dismiss. The server enforces the same rule.
 */
export function useIntakePermissions(): { canReview: boolean; isOwnerOrAdmin: boolean } {
  const { isOwner, isAdmin, hasPageAccess } = useAuth()
  const isOwnerOrAdmin = Boolean(isOwner || isAdmin)
  return { isOwnerOrAdmin, canReview: isOwnerOrAdmin || hasPageAccess('intakeReview') }
}
