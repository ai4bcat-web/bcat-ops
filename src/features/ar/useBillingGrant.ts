import { useAuthUser } from '@/hooks/useAuth'
import { accountingAccessMessage, hasAccountingPage } from '@/lib/accountingAccess'

/** Shown wherever an Invoicing action is hidden or disabled. */
export const BILLING_GRANT_MESSAGE = accountingAccessMessage('invoicing')
/** Shown wherever Move to billing is disabled. */
export const LOAD_REVIEW_GRANT_MESSAGE = accountingAccessMessage('loadReview')

/**
 * Whether the signed-in user may act on an accounting page: the owner, the ADMIN group, or
 * that page's grant, which opens every action on it (Ryne 2026-11-12). Moving a load to
 * billing is Load review's act and Invoicing's, as in the finance Lambda, which decides
 * either way.
 */
export function useBillingGrant(page: 'invoicing' | 'loadReview' = 'invoicing'): boolean {
  const user = useAuthUser()
  if (page === 'loadReview') {
    return hasAccountingPage(user?.groups, user?.email, 'loadReview') || hasAccountingPage(user?.groups, user?.email, 'invoicing')
  }
  return hasAccountingPage(user?.groups, user?.email, page)
}
