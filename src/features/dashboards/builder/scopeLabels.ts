import type { DashboardScope, DashOptions, ScopeKind } from '@/lib/dashboards/types'

export const PUBLISH_TOOLTIP = 'Needs the Publish company dashboards permission'

export const SCOPE_LABEL: Record<ScopeKind, string> = {
  COMPANY: 'Whole company',
  USERS: 'Specific users',
  TEAM: 'Specific teams',
  ME: 'Just me',
}

export function scopeSummary(scope: DashboardScope | null, options: DashOptions | null): string {
  if (!scope) return 'Not chosen yet'
  if (scope.kind === 'USERS') {
    const names = scope.userIds.map((id) => options?.staff.find((s) => s.id === id)?.name ?? id)
    return `Users: ${names.join(', ')}`
  }
  if (scope.kind === 'TEAM') {
    const names = scope.teamKeys.map((k) => options?.teams.find((t) => t.key === k)?.name ?? k)
    return `Teams: ${names.join(', ')}`
  }
  return SCOPE_LABEL[scope.kind]
}
