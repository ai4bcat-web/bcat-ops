import { useAuthUser } from '@/hooks/useAuth'
import { OWNER_EMAIL } from '@/lib/auth/admin'
import { canCreateDirectoryRecords } from '@/lib/profileAccess'

/** Same door as the directory's create action: owner, ADMIN, or the Shipments / Loads / Locations / Customers page grants. */
export function useCanCreateCustomer(): boolean {
  const user = useAuthUser()
  const groups = user?.groups ?? []
  if (!canCreateDirectoryRecords(user?.email, groups)) return false
  if ((user?.email ?? '').toLowerCase() === OWNER_EMAIL || groups.includes('ADMIN')) return true
  return ['tms', 'loads', 'locations', 'customers'].some((page) => groups.includes(`page-${page}`))
}
