/**
 * Step AI §3 — what a signed-in user may do with dashboards. Pure; the server checks each
 * flag independently and the UI mirrors it.
 *
 * Implied grants (flip points): owner e-mail and the ADMIN group hold all three; role AR_AP
 * holds viewAll (via `VIEW_ALL_ROLES`); MANAGER holds none by default. Everyone else needs
 * the explicit `claim-*` group.
 */
import { OWNER_EMAIL, hasViewAll, viewerFromGroups } from '../dataVisibility'
import type { DashboardAccess } from './types'

export const CLAIM_DASHBOARDS_CREATE = 'claim-DASHBOARDS_CREATE'
export const CLAIM_DASHBOARDS_PUBLISH_COMPANY = 'claim-DASHBOARDS_PUBLISH_COMPANY'

export function dashboardAccess(input: {
  email?: string | null
  groups?: readonly string[] | null
}): DashboardAccess {
  const groups = input.groups ?? []
  const viewer = viewerFromGroups({ id: '', email: input.email, groups })
  const all = viewer.isOwnerOrAdmin || (input.email ?? '').trim().toLowerCase() === OWNER_EMAIL
  return {
    create: all || groups.includes(CLAIM_DASHBOARDS_CREATE),
    publishCompany: all || groups.includes(CLAIM_DASHBOARDS_PUBLISH_COMPANY),
    viewAll: all || hasViewAll(viewer, groups),
  }
}
