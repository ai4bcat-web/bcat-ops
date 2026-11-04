/**
 * Step AG §4 — who may call which `tmsApInboxActions` action. "AP user" is the same predicate
 * `tms-finance-actions` uses for its AP actions: owner / ADMIN, `page-carrierPay` or `page-tms`.
 * Settings, connect and the simulated mailbox are owner / ADMIN; the simulated mailbox is dev only.
 */
import { AP_INBOX_ACTIONS, type ApInboxAction } from '../../../src/lib/apInbox/actions'

export const OWNER_EMAIL = 'ryne@bcatcorp.com'
export const ADMIN_GROUP = 'ADMIN'
export const AP_PAGE_GROUPS = ['page-carrierPay', 'page-tms']

export interface AppSyncIdentity {
  sub?: string
  username?: string
  claims?: Record<string, unknown>
}

export interface ApCaller {
  userId: string
  email: string
  groups: string[]
  isAdmin: boolean
}

function claimString(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = claims?.[key]
  return typeof value === 'string' ? value : undefined
}

function groupsOf(identity: AppSyncIdentity): string[] {
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export function isApInboxAction(action: string): action is ApInboxAction {
  return Object.prototype.hasOwnProperty.call(AP_INBOX_ACTIONS, action)
}

export function authorize(action: ApInboxAction, identity: AppSyncIdentity | null | undefined, devStack: boolean): ApCaller {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const candidates = [claimString(identity.claims, 'email'), identity.username]
  const email = (candidates.find((v): v is string => typeof v === 'string' && v.includes('@')) ?? '').toLowerCase().trim()
  const userId = identity.username ?? claimString(identity.claims, 'cognito:username') ?? identity.sub ?? ''
  if (!email || !userId) throw new Error('Unauthorized: could not resolve caller')
  const groups = groupsOf(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  const who = AP_INBOX_ACTIONS[action].who
  if (who === 'AP_USER') {
    if (!isAdmin && !groups.some((g) => AP_PAGE_GROUPS.includes(g))) {
      throw new Error(`Forbidden: ${action} requires owner, ADMIN, or one of ${AP_PAGE_GROUPS.join(', ')}`)
    }
  } else {
    if (!isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
    if (who === 'ADMIN_DEV' && !devStack) throw new Error(`${action} is only available on the dev stack`)
  }
  return { userId, email, groups, isAdmin }
}
