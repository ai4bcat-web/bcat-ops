// Pure rules behind the Users overview (S4 §3.2): which blocked sign-ups are still open,
// how many registrations wait, and the roles table. No fetching and no clock reads here —
// registrationsClient.ts loads the rows, the components render what this returns.
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_PAGES } from '@/lib/roles'
import type { RoleKey, UserStatus } from '@/types/tms'

export const SIGNUP_ENTITY_TYPE = 'DRIVER_SIGNUP'
export const SIGNUP_REFUSED = 'refused'
export const SIGNUP_DISMISSED = 'driver_signup_dismissed'

/** An `AuditLog` row as the client reads it; `changes` is a JSON string (X7). */
export interface SignupAuditEntry {
  id: string
  entityType: string
  entityId: string
  action: string
  user?: string | null
  changes?: unknown
  createdAt?: string | null
}

export interface OpenSignupRefusal {
  email: string
  /** When the most recent attempt was refused. */
  at: string
  reason: string | null
}

/** `changes` arrives as a JSON string; tolerate an already-parsed object and garbage. */
export function parseChanges(raw: unknown): { reason?: string; at?: string } {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (value === null || typeof value !== 'object') return {}
  const { reason, at } = value as Record<string, unknown>
  return {
    reason: typeof reason === 'string' ? reason : undefined,
    at: typeof at === 'string' ? at : undefined,
  }
}

function stampOf(entry: SignupAuditEntry): string {
  return parseChanges(entry.changes).at ?? entry.createdAt ?? ''
}

/**
 * One entry per e-mail: the latest refusal, hidden when a dismissal for the same e-mail is
 * newer than it (a fresh attempt after a dismissal re-opens the card). Newest first.
 */
export function openSignupRefusals(
  entries: readonly SignupAuditEntry[],
  { limit = 50 }: { limit?: number } = {},
): OpenSignupRefusal[] {
  const refused = new Map<string, OpenSignupRefusal>()
  const dismissedAt = new Map<string, string>()
  for (const entry of entries) {
    if (entry.entityType !== SIGNUP_ENTITY_TYPE) continue
    const email = entry.entityId.toLowerCase().trim()
    if (!email) continue
    const at = stampOf(entry)
    if (entry.action === SIGNUP_REFUSED) {
      const current = refused.get(email)
      if (!current || at > current.at) {
        refused.set(email, { email, at, reason: parseChanges(entry.changes).reason ?? null })
      }
    } else if (entry.action === SIGNUP_DISMISSED) {
      const current = dismissedAt.get(email)
      if (current === undefined || at > current) dismissedAt.set(email, at)
    }
  }
  return [...refused.values()]
    .filter((r) => {
      const dismissed = dismissedAt.get(r.email)
      return dismissed === undefined || dismissed < r.at
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}

const REFUSAL_TEXT: Record<string, string> = {
  NO_DRIVER_RECORD: 'not on the roster',
  DRIVER_INACTIVE: 'driver record is inactive',
  INELIGIBLE_PAY_GROUP: 'pay group is not on the driver app',
}

export function refusalReasonText(code: string | null | undefined): string {
  return (code ? REFUSAL_TEXT[code] : undefined) ?? 'not on the roster'
}

export interface PendingRegistrationCounts {
  applications: number
  blocked: number
  awaitingVerification: number
  staffInvites: number
  total: number
}

export function pendingRegistrationCounts(input: {
  applications: number
  blocked: number
  awaitingVerification: number
  staffInvites: number
}): PendingRegistrationCounts {
  return {
    ...input,
    total: input.applications + input.blocked + input.awaitingVerification + input.staffInvites,
  }
}

/** The driver-pool login facts the overview may use (`listDriverPool` whitelist). */
export interface DriverPoolLogin {
  email: string
  status: string
  enabled: boolean
  emailVerified: boolean
  createdAt?: string | null
}

export interface AwaitingVerification {
  email: string
  driverId: string
  driverName: string
  since: string | null
}

/**
 * Driver-pool logins the gate admitted whose e-mail is not yet verified (UNCONFIRMED),
 * matched to an active Driver by e-mail. A login with no matching driver is not a
 * registration staff can act on, so it is left out.
 */
export function awaitingVerification(
  pool: readonly DriverPoolLogin[],
  drivers: readonly { id: string; name: string; email?: string | null; active: boolean }[],
): AwaitingVerification[] {
  const byEmail: Record<string, { id: string; name: string }> = {}
  for (const d of drivers) {
    const email = d.email?.toLowerCase().trim()
    if (email && d.active) byEmail[email] = d
  }
  return pool
    .filter((u) => u.status === 'UNCONFIRMED' && u.enabled)
    .flatMap((u) => {
      const email = u.email.toLowerCase().trim()
      const driver = byEmail[email]
      return driver
        ? [{ email, driverId: driver.id, driverName: driver.name, since: u.createdAt ?? null }]
        : []
    })
    .sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''))
}

/** Active drivers whose driver-app login is CONFIRMED with a verified, enabled e-mail. */
export function verifiedDriverCount(
  activeDriverEmails: readonly (string | null | undefined)[],
  pool: readonly DriverPoolLogin[],
): number {
  const verified = new Set(
    pool
      .filter((u) => u.status === 'CONFIRMED' && u.emailVerified && u.enabled)
      .map((u) => u.email.toLowerCase().trim()),
  )
  const seen = new Set<string>()
  for (const raw of activeDriverEmails) {
    const email = raw?.toLowerCase().trim()
    if (email && verified.has(email)) seen.add(email)
  }
  return seen.size
}

export interface RoleSummaryRow {
  role: RoleKey
  label: string
  description: string
  total: number
  active: number
  pending: number
  inactive: number
  /** `null` = every page (ADMIN). */
  pages: number | null
}

/** A lens over profiles the Users page already loaded, one row per role. */
export function roleRows(
  users: readonly { role: RoleKey; status: UserStatus }[],
): RoleSummaryRow[] {
  return ROLES.map((role) => {
    const inRole = users.filter((u) => u.role === role)
    const count = (status: UserStatus) => inRole.filter((u) => u.status === status).length
    return {
      role,
      label: ROLE_LABELS[role],
      description: ROLE_DESCRIPTIONS[role],
      total: inRole.length,
      active: count('ACTIVE'),
      pending: count('PENDING'),
      inactive: count('INACTIVE'),
      pages: role === 'ADMIN' ? null : ROLE_PAGES[role].length,
    }
  })
}
