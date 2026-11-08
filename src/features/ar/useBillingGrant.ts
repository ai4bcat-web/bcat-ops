import { useAuthUser } from '@/hooks/useAuth'
import { BILLING_RELEASE_PAGE, holdsPerUserGrant } from '@/lib/navItems'

/** Shown wherever Release to billing / Send invoice is hidden or disabled. */
export const BILLING_GRANT_MESSAGE = 'Only a user granted "Release to billing / Send invoice" (Settings > Users) can do this. Admins are not exempt.'

/**
 * Whether the signed-in user holds the per-user billing release grant. Judged from the
 * Cognito groups alone, like the Lambda does: `hasPageAccess` lets ADMIN and the owner
 * through, which is exactly what this grant must not. The server decides either way.
 */
export function useBillingGrant(): boolean {
  return holdsPerUserGrant(useAuthUser()?.groups, BILLING_RELEASE_PAGE)
}
