/**
 * Step AB §5.6 — who may see what. Pure; the Lambdas enforce it and the UI mirrors it.
 * Reps see accounts they own (or accounts nobody owns yet); managers, ADMIN and the
 * owner see everything.
 */
import type { CrmViewer } from './types'
import { ownerIdsOf, type OwnedCustomer } from './owner'

export const OWNER_EMAIL = 'ryne@bcatcorp.com'

/** Derives the viewer from `cognito:groups` exactly as the other Lambdas' authorize(). */
export function viewerFromGroups(input: {
  id: string
  email?: string | null
  groups?: readonly string[] | null
}): CrmViewer {
  const groups = input.groups ?? []
  const roleGroup = groups.find((g) => g.startsWith('role-'))
  const isAdminGroup = groups.includes('ADMIN') || groups.includes('role-ADMIN')
  const isOwner = (input.email ?? '').trim().toLowerCase() === OWNER_EMAIL
  const role = roleGroup ? roleGroup.slice('role-'.length) : isAdminGroup ? 'ADMIN' : null
  return { id: input.id, role, isOwnerOrAdmin: isOwner || isAdminGroup }
}

/** Managers see all accounts and every rep's mail-derived data. */
export function isManager(viewer: CrmViewer): boolean {
  return viewer.isOwnerOrAdmin || viewer.role === 'MANAGER' || viewer.role === 'ADMIN'
}

export function canSeeAccount(viewer: CrmViewer, customer: OwnedCustomer | null | undefined): boolean {
  if (isManager(viewer)) return true
  const owners = ownerIdsOf(customer)
  return owners.length === 0 || owners.includes(viewer.id)
}

export function canSeeSpotRequest(viewer: CrmViewer, request: { userId: string }): boolean {
  return isManager(viewer) || viewer.id === request.userId
}

/** E-mail activity subjects: the rep whose mailbox it came from, or a manager. */
export function canSeeEmailDetail(viewer: CrmViewer, activity: { ownerId: string }): boolean {
  return isManager(viewer) || viewer.id === activity.ownerId
}
