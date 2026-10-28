/**
 * Everything the carriers board decides without React: which statuses sit under which
 * tab, how a row is matched by the search box and the filter rail, which columns exist
 * and what a CSV export of the current view looks like. Pure functions so the board
 * stays a thin renderer and the rules are testable.
 *
 * The tab grouping is the operational one MVMNT uses (spec §3.3) — what still needs
 * onboarding (Pending/Review), what may be booked today (Active), and what may not
 * (Inactive/Do not use). A carrier lands in a tab by its *effective* status, so a
 * carrier whose cargo insurance lapsed drops out of Active without anyone editing it.
 */
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { insuranceState, type InsuranceState } from '@/lib/carrierEligibility'
import type {
  CarrierDocumentRecord,
  CarrierRecord,
  CarrierStatus,
  CarrierType,
} from '@/types/tms'

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

export const INSURANCE_STATE_STYLES: Record<InsuranceState, string> = {
  UPCOMING: 'bg-slate-100 text-slate-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  EXPIRING: 'bg-amber-100 text-amber-700',
  EXPIRED: 'bg-red-100 text-red-700',
}

/**
 * What the board needs besides the rows to decide: the clock, the expiring-soon window
 * and — only once the user asks for the missing-docs filter — every carrier's documents.
 * `documentsByCarrier` is null until that fetch lands, and the filter passes everything
 * while it is, rather than pretending an unloaded carrier has no paperwork.
 */
export interface CarrierBoardContext {
  now: string
  warnDays: number
  requiredDocs: readonly string[]
  documentsByCarrier: Record<string, CarrierDocumentRecord[]> | null
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

export type InsuranceFilter = 'EXPIRING' | 'EXPIRED'

export interface CarrierFilters {
  type: CarrierType | null
  equipment: string | null
  ownerId: string | null
  insurance: InsuranceFilter | null
  missingDocs: boolean
}

export const EMPTY_CARRIER_FILTERS: CarrierFilters = {
  type: null, equipment: null, ownerId: null, insurance: null, missingDocs: false,
}

export function activeCarrierFilterCount(f: CarrierFilters): number {
  let count = 0
  if (f.type) count += 1
  if (f.equipment) count += 1
  if (f.ownerId) count += 1
  if (f.insurance) count += 1
  if (f.missingDocs) count += 1
  return count
}

/** Name, DBA, MC and DOT — the four things anyone has in front of them on a call. */
export function matchesCarrierQuery(row: CarrierRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [row.name, row.dbaName, row.mcNumber, row.dotNumber, row.scac]
    .some((v) => (v ?? '').toLowerCase().includes(q))
}

/**
 * Missing paperwork means either no document of a required type at all, or the newest
 * one of that type has already expired — both are a `MISSING_DOC`/`DOC_EXPIRED` warning
 * at booking time, so the board surfaces them together.
 */
export function carrierMissingDocs(
  documents: readonly CarrierDocumentRecord[],
  ctx: CarrierBoardContext,
): string[] {
  const now = Date.parse(ctx.now)
  return ctx.requiredDocs.filter((type) => {
    const matching = documents.filter((d) => d.type === type)
    if (matching.length === 0) return true
    return matching.every((d) => {
      const expires = d.expiresAt ? Date.parse(d.expiresAt) : NaN
      return Number.isFinite(expires) && expires < now
    })
  })
}

export function matchesCarrierFilters(row: CarrierRow, f: CarrierFilters, ctx: CarrierBoardContext): boolean {
  if (f.type && row.type !== f.type) return false
  if (f.equipment && !(row.equipment ?? []).includes(f.equipment)) return false
  if (f.ownerId && !(row.accountOwnerIds ?? []).includes(f.ownerId)) return false
  if (
    f.insurance &&
    !(row.insurancePolicies ?? []).some((p) => insuranceState(p, ctx.now, ctx.warnDays) === f.insurance)
  ) return false
  if (f.missingDocs && ctx.documentsByCarrier) {
    if (carrierMissingDocs(ctx.documentsByCarrier[row.id] ?? [], ctx).length === 0) return false
  }
  return true
}

export type CarrierSortKey = 'name' | 'status' | 'type' | 'loadCount' | 'lastLoadAt'
export type CarrierSortDir = 'asc' | 'desc'

function sortValue(row: CarrierRow, key: CarrierSortKey, now: string): string {
  switch (key) {
    case 'status': return effectiveCarrierStatus(row, now).status
    case 'type': return row.type
    // Padded so a plain string compare orders 9 before 10.
    case 'loadCount': return String(row.loadCount ?? 0).padStart(9, '0')
    case 'lastLoadAt': return row.lastLoadAt ?? ''
    default: return row.name.toLowerCase()
  }
}

export function applyCarrierBoard(
  rows: readonly CarrierRow[],
  opts: {
    tab: CarrierTabKey
    query: string
    filters: CarrierFilters
    sortKey: CarrierSortKey
    sortDir: CarrierSortDir
    ctx: CarrierBoardContext
  },
): CarrierRow[] {
  const out = rows.filter(
    (row) =>
      carrierTab(row, opts.ctx.now) === opts.tab &&
      matchesCarrierQuery(row, opts.query) &&
      matchesCarrierFilters(row, opts.filters, opts.ctx),
  )
  const dir = opts.sortDir === 'asc' ? 1 : -1
  return out.sort((a, b) =>
    dir * sortValue(a, opts.sortKey, opts.ctx.now).localeCompare(sortValue(b, opts.sortKey, opts.ctx.now)))
}

export interface CarrierColumn {
  key: string
  label: string
  value: (row: CarrierRow, ctx: CarrierBoardContext) => string
}

/** Dates render in the viewer's zone; the CSV gets the same text the screen shows. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export const CARRIER_COLUMNS: CarrierColumn[] = [
  { key: 'name', label: 'Carrier', value: (r) => r.name },
  { key: 'status', label: 'Status', value: (r, ctx) => CARRIER_STATUS_LABELS[effectiveCarrierStatus(r, ctx.now).status] },
  { key: 'type', label: 'Type', value: (r) => r.type },
  { key: 'mcNumber', label: 'MC #', value: (r) => r.mcNumber ?? '' },
  { key: 'dotNumber', label: 'DOT #', value: (r) => r.dotNumber ?? '' },
  { key: 'authority', label: 'Authority', value: (r) => r.authorityStatus ?? '' },
  { key: 'safety', label: 'Safety', value: (r) => r.safetyRating ?? '' },
  { key: 'equipment', label: 'Equipment', value: (r) => (r.equipment ?? []).join(' ') },
  { key: 'phone', label: 'Phone', value: (r) => r.phone ?? '' },
  { key: 'email', label: 'Email', value: (r) => r.email ?? '' },
  { key: 'dispatcher', label: 'Dispatcher', value: (r) => r.dispatcherName ?? '' },
  { key: 'terms', label: 'Terms', value: (r) => (r.paymentTermsDays == null ? '' : `${r.paymentTermsDays}d`) },
  { key: 'loadCount', label: 'Loads', value: (r) => String(r.loadCount ?? 0) },
  { key: 'lastLoadAt', label: 'Last load', value: (r) => shortDate(r.lastLoadAt) },
]

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** CSV of exactly what is on screen — same columns, same order, same rows. */
export function carriersToCsv(rows: readonly CarrierRow[], ctx: CarrierBoardContext): string {
  const header = CARRIER_COLUMNS.map((c) => csvCell(c.label)).join(',')
  const body = rows.map((row) => CARRIER_COLUMNS.map((c) => csvCell(c.value(row, ctx))).join(','))
  return [header, ...body].join('\n')
}

/** Every account owner that appears on a carrier, for the owner filter's option list. */
export function carrierOwnerOptions(rows: readonly CarrierRow[]): string[] {
  const owners = new Set<string>()
  for (const row of rows) for (const owner of row.accountOwnerIds ?? []) owners.add(owner)
  return [...owners].sort()
}

/** Every equipment code that appears on a carrier, for the equipment filter. */
export function carrierEquipmentOptions(rows: readonly CarrierRow[]): string[] {
  const equipment = new Set<string>()
  for (const row of rows) for (const code of row.equipment ?? []) equipment.add(code)
  return [...equipment].sort()
}
