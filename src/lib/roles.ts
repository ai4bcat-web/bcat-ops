/**
 * Roles, claims and the Cognito groups a staff profile implies.
 *
 * A role is **data on `UserProfile`**, projected onto Cognito groups: nothing
 * authorizes off a table read. One profile implies exactly one set of groups
 * (`groupsForProfile`), and `reconcileGroups` turns that set plus whatever the user
 * is in today into the add/remove calls the Lambda makes.
 *
 * Three rules shape this file:
 *
 * 1. **Unknown is ignored, never emitted.** A role, claim or page key this build does
 *    not know about yields no group, so a typo in stored data can never mint a
 *    `page-whatever` group that nothing guards.
 * 2. **Only managed groups are ever removed.** `DISPATCHER`, and anything else a human
 *    or another feature put on a user, survives every reconcile. We remove only the
 *    `ADMIN`, `role-*`, `claim-*` and `page-*` groups this file produces.
 * 3. **Deterministic output.** Every returned list is deduped and sorted, so a
 *    reconcile is reproducible and diffable.
 *
 * Pure: no store, no clock (callers pass what they know), no network. Imports are
 * relative because the Lambdas bundle this file by path.
 */
import type { ClaimKey, RoleKey, UserProfileRecord } from '../types/tms'
import { OWNER_EMAIL } from './auth/admin'

/** The Cognito group that opens every page. ADMIN is the role; this is its group. */
const ADMIN_GROUP = 'ADMIN'

export const ROLES: readonly RoleKey[] = [
  'ADMIN',
  'MANAGER',
  'CUSTOMER_REP',
  'CARRIER_REP',
  'AR_AP',
  'COMPLIANCE',
  'NONE',
]

export const ROLE_LABELS: Record<RoleKey, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  CUSTOMER_REP: 'Customer rep',
  CARRIER_REP: 'Carrier rep',
  AR_AP: 'AR/AP',
  COMPLIANCE: 'Compliance',
  NONE: 'No role',
}

/** Spec §6.7 "Roles", one sentence each — what the role is for, in the role picker. */
export const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  ADMIN: 'Everything, including brokerage settings, users and commissions.',
  MANAGER: 'Runs the teams and sees every board — but not the brokerage settings.',
  CUSTOMER_REP: 'Customers, shipments and the money the customer owes.',
  CARRIER_REP: 'Carriers, booking and the money the carrier is owed.',
  AR_AP: 'Invoices, carrier bills and payments on both sides.',
  COMPLIANCE: 'Carrier, customer and location profiles.',
  NONE: 'No TMS pages — own-fleet work only, granted page by page.',
}

/**
 * The pages a role grants. ADMIN is deliberately empty: an ADMIN gets the `ADMIN`
 * group, which opens every page, so listing pages for it would be a second,
 * drift-prone copy of the nav.
 */
export const ROLE_PAGES: Record<RoleKey, readonly string[]> = {
  ADMIN: [],
  MANAGER: [
    'loads', 'customers', 'carriers', 'locations', 'quotes',
    'invoicing', 'carrierPay', 'reports', 'commissions', 'audit',
  ],
  CUSTOMER_REP: ['loads', 'customers', 'locations', 'quotes', 'invoicing', 'reports', 'commissions'],
  CARRIER_REP: ['loads', 'carriers', 'locations', 'quotes', 'carrierPay', 'reports', 'commissions'],
  AR_AP: ['invoicing', 'carrierPay', 'vendorAp', 'factoring', 'reports'],
  COMPLIANCE: ['carriers', 'customers', 'locations'],
  NONE: [],
}

export const CLAIMS: readonly ClaimKey[] = [
  'CREDIT_LIMIT_EDIT',
  'AR_POSTING',
  'AP_POSTING',
  'AP_APPROVAL',
  'CARRIER_STATUS_EDIT',
  'AR_CHARGES',
  'AP_CHARGES',
  'CARRIER_INSURANCE_EDIT',
  'NO_AR_INVOICE',
]

export const CLAIM_LABELS: Record<ClaimKey, string> = {
  CREDIT_LIMIT_EDIT: 'Edit credit limits',
  AR_POSTING: 'Post customer payments',
  AP_POSTING: 'Post carrier payments',
  AP_APPROVAL: 'Approve carrier bills to pay',
  CARRIER_STATUS_EDIT: 'Change a carrier status',
  AR_CHARGES: 'Edit customer charges',
  AP_CHARGES: 'Edit carrier charges',
  CARRIER_INSURANCE_EDIT: 'Edit carrier insurance',
  NO_AR_INVOICE: 'Mark an order as not invoiced',
}

/**
 * The claims a Lambda actually refuses on. The rest are recorded and shown, so the
 * UI can hide a control, but no server action depends on them yet.
 */
export const ENFORCED_CLAIMS: readonly ClaimKey[] = [
  'CREDIT_LIMIT_EDIT',
  'AR_POSTING',
  'AP_POSTING',
  'AP_APPROVAL',
  'CARRIER_STATUS_EDIT',
]

export function isEnforcedClaim(key: string): boolean {
  return (ENFORCED_CLAIMS as readonly string[]).includes(key)
}

export function isRoleKey(key: string | null | undefined): key is RoleKey {
  return !!key && (ROLES as readonly string[]).includes(key)
}

export function isClaimKey(key: string | null | undefined): key is ClaimKey {
  return !!key && (CLAIMS as readonly string[]).includes(key)
}

export function roleGroup(role: RoleKey): string {
  return `role-${role}`
}

export function claimGroup(claim: ClaimKey): string {
  return `claim-${claim}`
}

export function pageGroup(key: string): string {
  return `page-${key}`
}

export const ROLE_GROUP_RE = /^role-[A-Z_]+$/
export const CLAIM_GROUP_RE = /^claim-[A-Z_]+$/
/** Must stay identical to the userManagement Lambda's own page-group test. */
export const PAGE_GROUP_RE = /^page-[A-Za-z0-9_-]+$/

/*
 * A page grant is judged by shape, not by a list: the userManagement Lambda has
 * always minted `page-<key>` for any well-formed key, which is what lets a new
 * page in `navItems.ts` become grantable without redeploying a Lambda. Keeping
 * that rule here also keeps this file free of the nav table — and of the icon
 * library behind it, which has no business inside a Lambda bundle.
 */

/** The role's page keys — the row the UI's role matrix renders. */
export function rolePagesFor(role: RoleKey): readonly string[] {
  return ROLE_PAGES[role] ?? ROLE_PAGES.NONE
}

/**
 * Exactly the groups a profile implies: `ADMIN` for an admin, `role-<ROLE>` for any
 * assigned role, `page-<key>` for every role page and every extra page grant, and
 * `claim-<CLAIM>` for every known claim. Sorted, deduped; unknown values are dropped.
 */
export function groupsForProfile(
  profile: Pick<UserProfileRecord, 'role' | 'claims' | 'extraPages'>,
): string[] {
  const groups = new Set<string>()
  const role = profile.role
  if (isRoleKey(role)) {
    if (role === 'ADMIN') groups.add(ADMIN_GROUP)
    if (role !== 'NONE') groups.add(roleGroup(role))
    for (const page of ROLE_PAGES[role]) groups.add(pageGroup(page))
  }
  for (const page of profile.extraPages ?? []) {
    if (PAGE_GROUP_RE.test(pageGroup(page))) groups.add(pageGroup(page))
  }
  for (const claim of profile.claims ?? []) {
    if (isClaimKey(claim)) groups.add(claimGroup(claim))
  }
  return [...groups].sort()
}

/** A group this file is allowed to take away. Everything else is somebody else's. */
function isManagedGroup(group: string): boolean {
  return group === ADMIN_GROUP
    || ROLE_GROUP_RE.test(group)
    || CLAIM_GROUP_RE.test(group)
    || PAGE_GROUP_RE.test(group)
}

/**
 * What to add and what to take away to get from `current` to `desired`.
 *
 * A group is removed only when it is present, unwanted, managed here and not named in
 * `keep` — so `DISPATCHER`, an off-role page somebody granted by hand (pass it in
 * `keep`) and any group another feature owns all survive.
 */
export function reconcileGroups(
  current: string[],
  desired: string[],
  keep: string[] = [],
): { add: string[]; remove: string[] } {
  const have = new Set(current)
  const want = new Set(desired)
  const kept = new Set(keep)
  const add: string[] = []
  const remove: string[] = []
  for (const group of want) if (!have.has(group)) add.push(group)
  for (const group of have) {
    if (!want.has(group) && !kept.has(group) && isManagedGroup(group)) remove.push(group)
  }
  return { add: add.sort(), remove: remove.sort() }
}

export type UserChangeAction = 'setRole' | 'setAdmin' | 'disable' | 'delete'

/**
 * One pending change to one user, as the Users page asks for it. `nextRole` is the
 * role after the change — `setAdmin` passes `'ADMIN'` to grant and the replacement
 * role (or nothing) to revoke.
 */
export interface UserChange {
  actorEmail: string
  actorIsOwner: boolean
  targetId: string
  targetEmail: string
  nextRole?: RoleKey
  nextEnabled?: boolean
  action: UserChangeAction
}

function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase().trim() === b.toLowerCase().trim()
}

/**
 * The reason to refuse a user change, or null to go ahead.
 *
 * Three ways to lock everybody out, all refused here: demoting, disabling or deleting
 * the owner; an admin demoting or disabling themselves; and taking the last enabled
 * admin away. Everything else is allowed.
 */
export function lockoutCheck(profiles: UserProfileRecord[], change: UserChange): string | null {
  const demoting = (change.action === 'setRole' || change.action === 'setAdmin')
    && change.nextRole !== 'ADMIN'
  const disabling = change.action === 'disable' || change.nextEnabled === false
  const deleting = change.action === 'delete'

  if (sameEmail(change.targetEmail, OWNER_EMAIL)) {
    if (demoting) return "The owner's role cannot be changed."
    if (disabling) return 'The owner account cannot be disabled.'
    if (deleting) return 'The owner account cannot be deleted.'
  }

  if (sameEmail(change.actorEmail, change.targetEmail)) {
    if (demoting) return 'You cannot change your own role.'
    if (disabling) return 'You cannot disable your own account.'
  }

  if (demoting || disabling || deleting) {
    const admins = profiles.filter((p) => p.role === 'ADMIN' && p.status !== 'INACTIVE')
    const targetIsAdmin = admins.some(
      (p) => p.id === change.targetId || sameEmail(p.email, change.targetEmail),
    )
    if (targetIsAdmin && admins.length <= 1) {
      return `${change.targetEmail} is the last admin — promote somebody else first.`
    }
  }

  return null
}

/**
 * The one name every picker, board and audit line prints for a person: the name they
 * typed, else the e-mail local part title-cased (`first.last@x.com` → `First Last`).
 */
export function displayName(
  input: { email?: string | null; name?: string | null; username?: string | null } | string,
): string {
  const source = typeof input === 'string' ? { email: input } : input
  const name = (source.name ?? '').trim()
  if (name) return name
  const username = (source.username ?? '').trim()
  const local = ((source.email ?? '').trim() || username).split('@')[0]
  if (!local) return username || '—'
  const words = local
    .split(/[._-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.join(' ') || username || '—'
}

