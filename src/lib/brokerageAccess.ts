/**
 * Who may see which Brokerage dashboard figures (Ryne, 2026-11-09). Pure; the tmsFinanceActions
 * `BROKERAGE_REP_ROLLUP` action enforces it where the data is served, the page only mirrors it.
 *
 *  - ALL  : owner (ryne@), the ADMIN group, or an explicit `page-dashboard` grant (Ruben holds it, Jenny is ADMIN).
 *           Sees every rep and the company month totals.
 *  - OWN  : an active staff profile with the sales-rep role (`CUSTOMER_REP`). The profile id is the Cognito
 *           username, which is exactly what `Shipment.salesRepId` stores. Sees ONLY that rep row, and every
 *           total (by month, by rep) is that rep's own figures.
 *  - NONE : everybody else, including a rep with no profile row and any other staff role. A group rep
 *           (`c:<name>`/`i:<group id>` rows) is not a person and never belongs to a caller.
 */
import { OWNER_EMAIL } from './crm/visibility'
import type { FinScope, RepKey, ScopeKey } from './dashboardRollup'

export const DASHBOARD_PAGE_GROUP = 'page-dashboard'
export const SALES_REP_ROLE = 'CUSTOMER_REP'

export type BrokerageScope = 'ALL' | 'OWN' | 'NONE'

export interface BrokerageCaller {
  email?: string | null
  /** `cognito:groups` */
  groups?: readonly string[] | null
}

/** The slice of the caller's UserProfile row the rule reads (null/undefined = no profile). */
export interface BrokerageProfile {
  id: string
  role?: string | null
  status?: string | null
}

export interface BrokerageAccess {
  scope: BrokerageScope
  /** `i:<profile id>`: the only rep key an OWN caller may read; null otherwise. */
  repKey: RepKey | null
}

export function isPrivilegedForBrokerage(caller: BrokerageCaller): boolean {
  const groups = caller.groups ?? []
  return (
    (caller.email ?? '').trim().toLowerCase() === OWNER_EMAIL ||
    groups.includes('ADMIN') ||
    groups.includes('role-ADMIN') ||
    groups.includes(DASHBOARD_PAGE_GROUP)
  )
}

export function brokerageAccessOf(caller: BrokerageCaller, profile: BrokerageProfile | null | undefined): BrokerageAccess {
  if (isPrivilegedForBrokerage(caller)) return { scope: 'ALL', repKey: null }
  const id = (profile?.id ?? '').trim()
  const active = profile?.status !== 'INACTIVE' && profile?.status !== 'PENDING'
  if (id && active && profile?.role === SALES_REP_ROLE) return { scope: 'OWN', repKey: `i:${id}` }
  return { scope: 'NONE', repKey: null }
}

/** One month's stored rep split: scope (`division|subdivision`) -> rep key -> figures. */
export type RepSplit = Record<ScopeKey, Record<RepKey, FinScope>>

export interface BrokerageRepMonth {
  month: string
  computedAt: string
  rep: RepSplit
}

/**
 * What a caller is allowed to receive of one stored month. ALL gets it as stored; OWN gets a copy holding
 * only their own rep key (scopes with no row of theirs are dropped); NONE gets nothing. Nothing about
 * other reps survives in the result, so no total in it can reveal them.
 */
export function filterRepMonth(access: BrokerageAccess, month: BrokerageRepMonth): BrokerageRepMonth | null {
  if (access.scope === 'NONE') return null
  if (access.scope === 'ALL') return month
  const own = access.repKey
  const rep: RepSplit = {}
  if (own) {
    for (const [scope, perRep] of Object.entries(month.rep ?? {})) {
      const mine = perRep?.[own]
      if (mine) rep[scope] = { [own]: { ...mine } }
    }
  }
  return { month: month.month, computedAt: month.computedAt, rep }
}
