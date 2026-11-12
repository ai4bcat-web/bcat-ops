import { useAuthUser } from '@/hooks/useAuth'
import { canReleaseToBilling } from '@/lib/navItems'

/** Shown wherever Release to billing / Send invoice is hidden or disabled. */
export const BILLING_GRANT_MESSAGE = 'Only admins and users granted "Release to billing / Send invoice" (Settings > Users) can do this.'

/**
 * Whether the signed-in user may release to billing and send invoices: the owner, the
 * ADMIN group, or the per-user grant. Same rule as the finance Lambda, which decides either way.
 */
export function useBillingGrant(): boolean {
  const user = useAuthUser()
  return canReleaseToBilling(user?.groups, user?.email)
}
