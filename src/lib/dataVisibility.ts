/**
 * Step AI §2.1 — the hard data-visibility rule behind every dashboard widget. Pure.
 *
 * A non-viewAll viewer sees a row only when (a) a rep field on the row names them, or
 * (b) they own the row's customer (accountOwnerIds ∪ defaultSalesRepId), or (c) the
 * customer's teamKey is one of their ACTIVE teams. A customer nobody owns and no team
 * covers is invisible (stricter than CRM `canSeeAccount`, decision D3). Carrier-side reps
 * grant nothing (D4). `viewAll` sees everything.
 *
 * Relative imports only: the Lambda bundles this file.
 */
import type { CrmViewer } from './crm/types'
import { OWNER_EMAIL, viewerFromGroups } from './crm/visibility'
import { ownerIdsOf, type OwnedCustomer } from './crm/owner'
import type { Team } from '../types/tms'

export { OWNER_EMAIL, viewerFromGroups }

/** Roles that see all data. The single flip point for decision D2 (add 'MANAGER' to widen). */
export const VIEW_ALL_ROLES: readonly string[] = ['AR_AP']
export const VIEW_ALL_CLAIM_GROUP = 'claim-VIEW_ALL'

export interface DataViewer extends CrmViewer {
  /** Lower-cased, trimmed. */
  email: string
  /** UPPER-CASED keys of ACTIVE teams whose memberIds contain the viewer's id or e-mail. */
  teamKeys: ReadonlySet<string>
  viewAll: boolean
}

export interface RowRef {
  customerId?: string | null
  /** Shipment / Load / LaneRateSample. */
  salesRepId?: string | null
  /** Order / Quote / LaneRateSample. */
  customerRepId?: string | null
}

export type VisCustomer = OwnedCustomer & { id: string; teamKey?: string | null }

const norm = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim().toLowerCase() : '')

/** viewAll = owner || ADMIN || a VIEW_ALL_ROLES role group || claim-VIEW_ALL. */
export function hasViewAll(viewer: CrmViewer, groups: readonly string[] | null | undefined): boolean {
  if (viewer.isOwnerOrAdmin) return true
  const gs = groups ?? []
  if (gs.includes(VIEW_ALL_CLAIM_GROUP)) return true
  if (viewer.role && VIEW_ALL_ROLES.includes(viewer.role)) return true
  return VIEW_ALL_ROLES.some((r) => gs.includes(`role-${r}`))
}

/** Groups + the authoritative `TmsSettings.teams` -> viewer. Team membership is never read from the token. */
export function dataViewer(input: {
  id: string
  email?: string | null
  groups?: readonly string[] | null
  teams?: readonly Team[] | null
}): DataViewer {
  const base = viewerFromGroups(input)
  const email = norm(input.email)
  const id = norm(input.id)
  const teamKeys = new Set<string>()
  for (const t of input.teams ?? []) {
    if (!t || t.active === false || typeof t.key !== 'string' || !t.key.trim()) continue
    const member = (t.memberIds ?? []).some((m) => {
      const n = norm(m)
      return n !== '' && (n === id || n === email)
    })
    if (member) teamKeys.add(t.key.trim().toUpperCase())
  }
  return { ...base, email, teamKeys, viewAll: hasViewAll(base, input.groups) }
}

/** True when `ref` (a rep field value) names this viewer: by id or e-mail, case-insensitive. */
export function namesViewer(v: DataViewer, ref: string | null | undefined): boolean {
  const n = norm(ref)
  return n !== '' && (n === norm(v.id) || n === v.email)
}

/** Customer-level test: owned by the viewer, or on one of the viewer's teams. */
export function canSeeCustomer(v: DataViewer, c: VisCustomer | null | undefined): boolean {
  if (v.viewAll) return true
  if (!c) return false
  if (ownerIdsOf(c).some((o) => namesViewer(v, o))) return true
  const team = norm(c.teamKey).toUpperCase()
  return team !== '' && v.teamKeys.has(team)
}

/** Row-level: viewAll, or a rep field names the viewer, or the row's customer passes `canSeeCustomer`. */
export function canSeeRow(
  v: DataViewer,
  row: RowRef,
  customerById: ReadonlyMap<string, VisCustomer>,
): boolean {
  if (v.viewAll) return true
  if (namesViewer(v, row.salesRepId) || namesViewer(v, row.customerRepId)) return true
  if (!row.customerId) return false
  return canSeeCustomer(v, customerById.get(row.customerId))
}

// Per-entity names the executors/readers use; all are the one row predicate.
export const canSeeShipment = canSeeRow
export const canSeeQuote = canSeeRow

/**
 * AR: an Invoice carries no rep field, so it is judged through its shipment's rep fields
 * (when the shipment resolved) and its customer.
 */
export function canSeeAR(
  v: DataViewer,
  invoice: { customerId?: string | null },
  shipment: RowRef | null | undefined,
  customerById: ReadonlyMap<string, VisCustomer>,
): boolean {
  return canSeeRow(
    v,
    {
      customerId: invoice.customerId ?? shipment?.customerId ?? null,
      salesRepId: shipment?.salesRepId ?? null,
      customerRepId: shipment?.customerRepId ?? null,
    },
    customerById,
  )
}
