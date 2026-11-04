import { useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { dashboardAccess } from '@/lib/dashboards/access'
import type { DashboardAccess } from '@/lib/dashboards/types'

/** What the signed-in user may do with dashboards. Mirrors the server; the Lambda is the boundary. */
export function useDashboardAccess(): DashboardAccess {
  const { user } = useAuth()
  const email = user?.email ?? ''
  const groups = user?.groups
  return useMemo(() => dashboardAccess({ email, groups }), [email, groups])
}
