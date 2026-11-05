/**
 * What the carriers board decides without React: which statuses sit under which tab and how
 * the search box matches a row. Columns, header filters and the CSV live in
 * `carrierGridColumns.ts`.
 *
 * The tab grouping is the operational one MVMNT uses (spec §3.3) — what still needs
 * onboarding (Pending/Review), what may be booked today (Active), and what may not
 * (Inactive/Do not use). A carrier lands in a tab by its *effective* status, so a
 * carrier whose cargo insurance lapsed drops out of Active without anyone editing it.
 */
import { effectiveCarrierStatus } from '@/lib/carrierStatus'
import type { InsuranceState } from '@/lib/carrierEligibility'
import type { TmsTone } from '@/features/tms/kit'
import type { CarrierRecord, CarrierStatus } from '@/types/tms'

/** A board row is the carrier record itself; nothing is projected onto it. */
export type CarrierRow = CarrierRecord

export type CarrierTabKey = 'pending' | 'active' | 'inactive'

export interface CarrierTab {
  key: CarrierTabKey
  label: string
  statuses: CarrierStatus[]
}

export const CARRIER_TABS: CarrierTab[] = [
  { key: 'pending', label: 'Pending/Review', statuses: ['PENDING', 'REVIEW'] },
  { key: 'active', label: 'Active', statuses: ['ACTIVE'] },
  { key: 'inactive', label: 'Inactive/Do not use', statuses: ['INACTIVE', 'DO_NOT_USE'] },
]

/** The documents the booking gate asks for when settings say nothing. */
export const DEFAULT_REQUIRED_CARRIER_DOCS = ['COI_CARGO', 'COI_AUTO', 'W9', 'CARRIER_AGREEMENT']

export const DEFAULT_INSURANCE_WARN_DAYS = 30

/** Insurance states onto the kit's badge colours. */
export const INSURANCE_STATE_TONE: Record<InsuranceState, TmsTone> = {
  UPCOMING: 'gray',
  ACTIVE: 'green',
  EXPIRING: 'orange',
  EXPIRED: 'red',
}

export function carrierTab(row: CarrierRow, now: string): CarrierTabKey {
  const status = effectiveCarrierStatus(row, now).status
  return CARRIER_TABS.find((t) => t.statuses.includes(status))?.key ?? 'pending'
}

/** Per-tab counts for the tab strip, computed once over every carrier. */
export function carrierTabCounts(rows: readonly CarrierRow[], now: string): Record<CarrierTabKey, number> {
  const counts: Record<CarrierTabKey, number> = { pending: 0, active: 0, inactive: 0 }
  for (const row of rows) counts[carrierTab(row, now)] += 1
  return counts
}

/** Name, DBA, MC and DOT — the four things anyone has in front of them on a call. */
export function matchesCarrierQuery(row: CarrierRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [row.name, row.dbaName, row.mcNumber, row.dotNumber, row.scac]
    .some((v) => (v ?? '').toLowerCase().includes(q))
}
