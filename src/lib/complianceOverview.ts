/**
 * The Compliance → Document overview, as pure functions over already-loaded data.
 *
 * One flat list of "things that carry a state and maybe an expiry": driver/truck
 * documents (state from the SAME functions the Files hub and the rail badge use, so the
 * three can never disagree), record-date rows for fields with no document (CDL, med card,
 * DOT inspection), carrier paperwork and one row per carrier insurance policy.
 *
 * Nothing here fetches or reads the clock — `todayIso` is a parameter.
 */
import { indexLatest } from './complianceDocStore'
import { DRIVER_EXPIRY_FIELDS, EXPIRING_SOON_DAYS, daysUntil, driverExpiry, slotState, truckSlotState, visibleDocs } from './fileHub'
import type { SlotState } from './fileHub'
import { insuranceState } from './carrierEligibility'
import { TRUCK_DOC_SPECS, evaluateTruckDoc } from './truckDocs'
import { DRIVER_REQUIREMENTS } from './complianceRequirements'
import type { ComplianceDocument, Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { CarrierDocumentRecord, CarrierRecord, InsurancePolicyType } from '@/types/tms'

export type OverviewKind = 'cd' | 'carrier' | 'policy' | 'rec'
export type OverviewEntityType = 'DRIVER' | 'TRUCK' | 'CARRIER'
export type OverviewState = 'PENDING_REVIEW' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'REJECTED' | 'WAIVED'
export type OverviewSource = 'DRIVER_APP' | 'OFFICE' | 'CARRIER_UPLOAD' | 'MCP' | 'ENTERED'

export interface OverviewRow {
  /** Deep-link key: `cd:<id>` · `carrier:<id>` · `policy:<carrierId>:<policyId>` · `rec:<entityType>:<entityId>:<docType>`. */
  key: string
  kind: OverviewKind
  entityType: OverviewEntityType
  entityId: string
  entityName: string
  docType: string
  title: string
  expiry: string | null
  daysLeft: number | null
  state: OverviewState
  source: OverviewSource
  createdAt: string | null
  verifiedBy: string | null
  verifiedAt: string | null
  rejectionReason: string | null
  doc?: ComplianceDocument
  carrierDoc?: CarrierDocumentRecord
}

export interface OverviewInput {
  /** Every ComplianceDocument, all versions — the latest per slot is picked here. */
  docs: ComplianceDocument[]
  drivers: Driver[]
  equipment: Equipment[]
  carriers: CarrierRecord[]
  carrierDocs: CarrierDocumentRecord[]
  insuranceWarnDays?: number | null
  canSeePrivate: boolean
  /** `YYYY-MM-DD`. */
  todayIso: string
}

export interface OverviewCounts {
  total: number
  needsReview: number
  expiring: number
  expired: number
  drivers: number
  trucks: number
  carriers: number
}

const DEFAULT_INSURANCE_WARN_DAYS = 30

const POLICY_LABELS: Record<InsurancePolicyType, string> = {
  AUTO_LIABILITY: 'Auto liability insurance',
  CARGO: 'Cargo insurance',
  GENERAL_LIABILITY: 'General liability insurance',
  WORKERS_COMP: "Workers' comp insurance",
  OTHER: 'Other insurance',
}

const DOT_SPEC = TRUCK_DOC_SPECS.find((s) => s.dot)

/** Local-midnight Date for a `YYYY-MM-DD` — `daysUntil` reads local calendar fields. */
function localDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

const dayOf = (v: string | null | undefined): string | null => (v ? v.slice(0, 10) : null)

/** Carrier files carry only an end date: same 30-day window as every other document. */
function dateState(expiry: string | null, today: Date): { state: OverviewState; daysLeft: number | null } {
  if (!expiry) return { state: 'VALID', daysLeft: null }
  const daysLeft = daysUntil(expiry, today)
  if (daysLeft < 0) return { state: 'EXPIRED', daysLeft }
  if (daysLeft <= EXPIRING_SOON_DAYS) return { state: 'EXPIRING_SOON', daysLeft }
  return { state: 'VALID', daysLeft }
}

const slotToOverview = (s: SlotState): OverviewState | null => (s === 'MISSING' ? null : s)

const driverDocTitle = (documentType: string, fallback: string): string =>
  DRIVER_REQUIREMENTS.find((r) => r.key === documentType)?.label ?? fallback

export function buildOverviewRows(input: OverviewInput): OverviewRow[] {
  const today = localDate(input.todayIso)
  const rows: OverviewRow[] = []
  const driverById = new Map(input.drivers.map((d) => [d.id, d]))
  const truckById = new Map(input.equipment.map((t) => [t.id, t]))
  const carrierById = new Map(input.carriers.map((c) => [c.id, c]))

  const latest = [...indexLatest(visibleDocs(input.docs, input.canSeePrivate)).values()]
  const hasDoc = new Set<string>()

  for (const doc of latest) {
    if (doc.entityType === 'DRIVER') {
      const driver = driverById.get(doc.entityId)
      if (!driver || driver.active === false) continue
      hasDoc.add(`DRIVER::${doc.entityId}::${doc.documentType}`)
      let state: OverviewState | null
      let expiry = dayOf(doc.expirationDate)
      if (doc.status === 'REJECTED') {
        state = 'REJECTED'
      } else if (DRIVER_EXPIRY_FIELDS.some((f) => f.key === doc.documentType) && doc.status !== 'PENDING_REVIEW' && doc.status !== 'WAIVED') {
        const field = DRIVER_EXPIRY_FIELDS.find((f) => f.key === doc.documentType)!
        const info = driverExpiry(driver[field.recordField], doc, today)
        expiry = info.date
        state = slotToOverview(info.state === 'MISSING' ? 'VALID' : info.state)
      } else {
        state = slotToOverview(slotState(doc, today))
      }
      if (!state || doc.status === 'MISSING') continue
      rows.push(makeDocRow(doc, 'DRIVER', driver.name, expiry, state, today))
    } else if (doc.entityType === 'TRUCK') {
      const truck = truckById.get(doc.entityId)
      if (!truck || truck.active === false) continue
      const spec = TRUCK_DOC_SPECS.find((s) => s.key === doc.documentType)
      if (spec?.photo) continue // photos are evidence, not dated paperwork
      hasDoc.add(`TRUCK::${doc.entityId}::${doc.documentType}`)
      let state: OverviewState | null
      let expiry = dayOf(doc.expirationDate)
      if (doc.status === 'REJECTED') {
        state = 'REJECTED'
      } else if (doc.status === 'PENDING_REVIEW') {
        state = 'PENDING_REVIEW'
      } else {
        state = slotToOverview(truckSlotState(truck, doc.documentType, doc))
        if (spec) expiry = dayOf(evaluateTruckDoc(truck, spec, doc).expiration)
      }
      if (!state || doc.status === 'MISSING') continue
      rows.push(makeDocRow(doc, 'TRUCK', truck.unitNumber, expiry, state, today))
    }
  }

  // Dates held on the record with no document behind them still queue.
  for (const driver of input.drivers) {
    if (driver.active === false) continue
    for (const f of DRIVER_EXPIRY_FIELDS) {
      const date = dayOf(driver[f.recordField])
      if (!date || hasDoc.has(`DRIVER::${driver.id}::${f.key}`)) continue
      const { state, daysLeft } = dateState(date, today)
      rows.push({
        key: `rec:DRIVER:${driver.id}:${f.key}`, kind: 'rec', entityType: 'DRIVER', entityId: driver.id, entityName: driver.name,
        docType: f.key, title: driverDocTitle(f.key, f.label.replace(/ expires$/, '')), expiry: date, daysLeft, state, source: 'ENTERED',
        createdAt: null, verifiedBy: null, verifiedAt: null, rejectionReason: null,
      })
    }
  }
  if (DOT_SPEC) {
    for (const truck of input.equipment) {
      if (truck.active === false || !truck.dotInspectionDate || hasDoc.has(`TRUCK::${truck.id}::${DOT_SPEC.key}`)) continue
      const ev = evaluateTruckDoc(truck, DOT_SPEC)
      const expiry = dayOf(ev.expiration)
      const state = slotToOverview(ev.state as SlotState)
      if (!state || !expiry) continue
      rows.push({
        key: `rec:TRUCK:${truck.id}:${DOT_SPEC.key}`, kind: 'rec', entityType: 'TRUCK', entityId: truck.id, entityName: truck.unitNumber,
        docType: DOT_SPEC.key, title: DOT_SPEC.label, expiry, daysLeft: daysUntil(expiry, today), state, source: 'ENTERED',
        createdAt: null, verifiedBy: null, verifiedAt: null, rejectionReason: null,
      })
    }
  }

  // Carrier paperwork: read-only, never Approve/Reject.
  for (const cd of input.carrierDocs) {
    const carrier = carrierById.get(cd.carrierId)
    if (!carrier) continue
    const expiry = dayOf(cd.expiresAt)
    const { state, daysLeft } = dateState(expiry, today)
    rows.push({
      key: `carrier:${cd.id}`, kind: 'carrier', entityType: 'CARRIER', entityId: carrier.id, entityName: carrier.name,
      docType: cd.type, title: cd.name, expiry, daysLeft, state, source: 'CARRIER_UPLOAD',
      createdAt: cd.createdAt, verifiedBy: null, verifiedAt: null, rejectionReason: null, carrierDoc: cd,
    })
  }
  const warnDays = input.insuranceWarnDays ?? DEFAULT_INSURANCE_WARN_DAYS
  for (const carrier of input.carriers) {
    for (const policy of carrier.insurancePolicies ?? []) {
      const expiry = dayOf(policy.expiresAt)
      const standing = insuranceState(policy, input.todayIso, warnDays)
      const state: OverviewState = standing === 'EXPIRED' ? 'EXPIRED' : standing === 'EXPIRING' ? 'EXPIRING_SOON' : 'VALID'
      rows.push({
        key: `policy:${carrier.id}:${policy.id}`, kind: 'policy', entityType: 'CARRIER', entityId: carrier.id, entityName: carrier.name,
        docType: policy.type, title: POLICY_LABELS[policy.type] ?? 'Insurance', expiry,
        daysLeft: expiry ? daysUntil(expiry, today) : null, state, source: carrier.mcpStatus ? 'MCP' : 'ENTERED',
        createdAt: null, verifiedBy: null, verifiedAt: null, rejectionReason: null,
      })
    }
  }
  return rows
}

function makeDocRow(
  doc: ComplianceDocument, entityType: 'DRIVER' | 'TRUCK', entityName: string,
  expiry: string | null, state: OverviewState, today: Date,
): OverviewRow {
  return {
    key: `cd:${doc.id}`, kind: 'cd', entityType, entityId: doc.entityId, entityName, docType: doc.documentType, title: doc.title,
    expiry, daysLeft: expiry ? daysUntil(expiry, today) : null, state,
    source: doc.uploadedBy === 'DRIVER_PORTAL' ? 'DRIVER_APP' : 'OFFICE',
    createdAt: doc.createdAt, verifiedBy: doc.verifiedBy ?? null, verifiedAt: doc.verifiedAt ?? null,
    rejectionReason: doc.rejectionReason ?? null, doc,
  }
}

/** Expired first (most overdue), then soonest. Excludes anything not expiring or expired. */
export function expiringQueue(rows: OverviewRow[], opts: { windowDays?: number } = {}): OverviewRow[] {
  const windowDays = opts.windowDays ?? EXPIRING_SOON_DAYS
  return rows
    .filter((r) => r.daysLeft !== null && (r.state === 'EXPIRED' || (r.state === 'EXPIRING_SOON' && r.daysLeft <= windowDays)))
    .sort((a, b) => (a.daysLeft as number) - (b.daysLeft as number))
}

export function overviewCounts(rows: OverviewRow[]): OverviewCounts {
  const c: OverviewCounts = { total: rows.length, needsReview: 0, expiring: 0, expired: 0, drivers: 0, trucks: 0, carriers: 0 }
  for (const r of rows) {
    if (r.state === 'PENDING_REVIEW') c.needsReview++
    else if (r.state === 'EXPIRING_SOON') c.expiring++
    else if (r.state === 'EXPIRED') c.expired++
    if (r.entityType === 'DRIVER') c.drivers++
    else if (r.entityType === 'TRUCK') c.trucks++
    else c.carriers++
  }
  return c
}

/** Human "in 12 d" / "3 d ago" / "today". */
export function relativeDays(daysLeft: number | null): string | null {
  if (daysLeft === null) return null
  if (daysLeft === 0) return 'today'
  return daysLeft > 0 ? `in ${daysLeft} d` : `${-daysLeft} d ago`
}

export type OverviewTab = 'all' | 'review' | 'expiring' | 'expired'
export type OverviewEntityFilter = 'all' | OverviewEntityType

const TAB_STATE: Record<Exclude<OverviewTab, 'all'>, OverviewState> = {
  review: 'PENDING_REVIEW',
  expiring: 'EXPIRING_SOON',
  expired: 'EXPIRED',
}

const ATTENTION: Record<OverviewState, number> = {
  PENDING_REVIEW: 0, EXPIRED: 1, EXPIRING_SOON: 2, REJECTED: 3, VALID: 4, WAIVED: 5,
}

/** Rows needing action first (review, expired, expiring), then by soonest expiry, then name. */
export function sortForReview(rows: OverviewRow[]): OverviewRow[] {
  return [...rows].sort((a, b) =>
    ATTENTION[a.state] - ATTENTION[b.state]
    || (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY)
    || a.entityName.localeCompare(b.entityName))
}

export function filterRows(
  rows: OverviewRow[],
  f: { tab: OverviewTab; entity: OverviewEntityFilter; query: string },
): OverviewRow[] {
  const q = f.query.trim().toLowerCase()
  return rows.filter((r) =>
    (f.tab === 'all' || r.state === TAB_STATE[f.tab])
    && (f.entity === 'all' || r.entityType === f.entity)
    && (!q || `${r.entityName} ${r.title} ${r.docType}`.toLowerCase().includes(q)))
}

export function tabCounts(rows: OverviewRow[]): Record<OverviewTab, number> {
  return {
    all: rows.length,
    review: rows.filter((r) => r.state === 'PENDING_REVIEW').length,
    expiring: rows.filter((r) => r.state === 'EXPIRING_SOON').length,
    expired: rows.filter((r) => r.state === 'EXPIRED').length,
  }
}
