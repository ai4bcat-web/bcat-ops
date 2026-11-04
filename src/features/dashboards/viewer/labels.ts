import type { ScopeKind } from '@/lib/dashboards/types'

export const SCOPE_LABELS: Record<ScopeKind, string> = { ME: 'Just me', COMPANY: 'Company', USERS: 'Shared', TEAM: 'Team' }
export const SCOPED_BANNER = 'Showing only the customers you own or your team covers.'
