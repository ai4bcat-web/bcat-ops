import { useAuthUser } from '@/hooks/useAuth'
import { canCreateDirectoryRecords } from '@/lib/profileAccess'

/** False for someone limited to the fleet profiles: they use the customers, locations and carriers that exist, and the office adds a new one. */
export function useCanCreateDirectoryRecords(): boolean {
  const user = useAuthUser()
  return canCreateDirectoryRecords(user?.email, user?.groups)
}
