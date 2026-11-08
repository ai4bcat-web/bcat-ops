/**
 * Step AG §6.5 / D8 — what an AP-inbox mail may write onto an AP row. Pure.
 *
 * The allow-lists below are the contract: the store's `updateCarrierBill` / `updateVendorPayable`
 * drop every key outside them, and the tests assert the plan's `set` is always a subset.
 * AG never touches status, money columns (other than billed/variance on a placeholder
 * IN_REVIEW bill), payee data, approval or payment.
 */
import { billDueDate } from '../carrierBill'
import { amountRelation, isPlaceholderBill, normalizeRef, sameName } from './refs'
import type { ApExtraction, LedgerBill, LedgerVendorPayable } from './types'

export const BILL_WRITABLE_COLUMNS = ['billNumber', 'billDate', 'billMonth', 'dueAt', 'billedCents', 'varianceCents'] as const
/** Provenance and bookkeeping the store adds itself. */
export const BILL_AUDIT_COLUMNS = ['apInboxItemId', 'apInboxSourceUrl', 'apInboxAppliedAt', 'version', 'updatedAt', 'updatedBy'] as const
export const VENDOR_WRITABLE_COLUMNS = ['vendor', 'invoiceNumber', 'invoiceDate', 'dueDate', 'amount'] as const
export const VENDOR_AUDIT_COLUMNS = ['apInboxItemId', 'apInboxSourceUrl', 'apInboxAppliedAt'] as const

export type BillColumn = (typeof BILL_WRITABLE_COLUMNS)[number]
export type VendorColumn = (typeof VENDOR_WRITABLE_COLUMNS)[number]
/** The fields a reviewer sees and picks (billMonth/variance follow their parents). */
export type BillField = 'billNumber' | 'billDate' | 'dueAt' | 'billedCents'
export type VendorField = VendorColumn

export type PlanSkipReason = 'STATUS' | 'LOW_CONFIDENCE' | 'AMOUNT_FAR' | 'DUE_BEFORE_BILL_DATE' | 'NOT_STATED'

export interface FieldChange<F extends string> {
  field: F
  current: string | number | null
  incoming: string | number
}

export interface BillPlan {
  kind: 'CARRIER_BILL'
  mode: 'AUTO' | 'HUMAN'
  placeholder: boolean
  /** The columns to write — always a subset of BILL_WRITABLE_COLUMNS. Empty = nothing to write. */
  set: Partial<Record<BillColumn, string | number>>
  /** Reviewer-facing fields the write changes. */
  fields: BillField[]
  /** Fields that fill a blank / placeholder (ticked by default in the link dialog). */
  changes: FieldChange<BillField>[]
  /** Fields that would overwrite a real value (unticked by default; AUTO writes nothing when any exist). */
  conflicts: FieldChange<BillField>[]
  skipped: { field: BillField; reason: PlanSkipReason }[]
}

export interface VendorPlan {
  kind: 'VENDOR_PAYABLE'
  mode: 'AUTO' | 'HUMAN'
  set: Partial<Record<VendorColumn, string | number>>
  fields: VendorField[]
  changes: FieldChange<VendorField>[]
  conflicts: FieldChange<VendorField>[]
  skipped: { field: VendorField; reason: PlanSkipReason }[]
}

export interface PlanOptions<F extends string> {
  mode: 'AUTO' | 'HUMAN'
  /** HUMAN only: field → ticked. A pick can select a conflict; it can never select a forbidden column. */
  picks?: Partial<Record<F, boolean>>
}

const BILL_FIELD_ORDER: BillField[] = ['billNumber', 'billDate', 'dueAt', 'billedCents']

export function planBillUpdate(
  bill: Pick<LedgerBill, 'status' | 'billNumber' | 'billDate' | 'dueAt' | 'termsDays' | 'billedCents' | 'grossCents' | 'shipmentNumber' | 'loadNumber' | 'aljexId'>,
  ext: ApExtraction,
  opts: PlanOptions<BillField>,
): BillPlan {
  const placeholder = isPlaceholderBill(bill)
  const plan: BillPlan = { kind: 'CARRIER_BILL', mode: opts.mode, placeholder, set: {}, fields: [], changes: [], conflicts: [], skipped: [] }
  const writable = bill.status === 'IN_REVIEW' || bill.status === 'TO_BE_PAID'
  if (!writable) {
    for (const f of BILL_FIELD_ORDER) plan.skipped.push({ field: f, reason: 'STATUS' })
    return plan
  }
  const put = (f: BillField, current: string | number | null, incoming: string | number, direct: boolean) => {
    ;(direct ? plan.changes : plan.conflicts).push({ field: f, current, incoming })
  }

  // billNumber
  if (ext.invoiceNumber) {
    const same = normalizeRef(ext.invoiceNumber) === normalizeRef(bill.billNumber)
    if (!same) put('billNumber', bill.billNumber, ext.invoiceNumber, placeholder)
  } else plan.skipped.push({ field: 'billNumber', reason: 'NOT_STATED' })

  // billDate (billMonth follows)
  if (ext.invoiceDate) {
    if (ext.invoiceDate !== bill.billDate) put('billDate', bill.billDate, ext.invoiceDate, placeholder)
  } else plan.skipped.push({ field: 'billDate', reason: 'NOT_STATED' })

  // dueAt — stated, else invoice date + terms (only ever filled on a placeholder)
  const stated = ext.dueDate
  const computed = ext.invoiceDate ? billDueDate(ext.invoiceDate, ext.termsDays ?? bill.termsDays) : null
  const due = stated ?? (placeholder ? computed : null)
  if (due) {
    if (due !== bill.dueAt) put('dueAt', bill.dueAt, due, placeholder)
  } else plan.skipped.push({ field: 'dueAt', reason: 'NOT_STATED' })

  // billedCents (varianceCents follows) — IN_REVIEW only
  if (ext.amountCents != null) {
    if (bill.status !== 'IN_REVIEW') plan.skipped.push({ field: 'billedCents', reason: 'STATUS' })
    else if (ext.amountCents !== bill.billedCents) {
      const nobodyEntered = bill.billedCents === bill.grossCents
      if (placeholder && nobodyEntered) {
        if (amountRelation(ext.amountCents, bill.grossCents) === 'FAR') plan.skipped.push({ field: 'billedCents', reason: 'AMOUNT_FAR' })
        else put('billedCents', bill.billedCents, ext.amountCents, true)
      } else put('billedCents', bill.billedCents, ext.amountCents, false)
    }
  } else plan.skipped.push({ field: 'billedCents', reason: 'NOT_STATED' })

  // Selection
  const picked = (f: BillField): boolean => {
    if (opts.mode === 'AUTO') return plan.conflicts.length === 0 && plan.changes.some((c) => c.field === f)
    const pick = opts.picks?.[f]
    if (pick === undefined) return plan.changes.some((c) => c.field === f)
    return pick === true && (plan.changes.some((c) => c.field === f) || plan.conflicts.some((c) => c.field === f))
  }
  const incomingOf = (f: BillField): string | number | undefined =>
    [...plan.changes, ...plan.conflicts].find((c) => c.field === f)?.incoming

  for (const f of BILL_FIELD_ORDER) {
    if (!picked(f)) continue
    const v = incomingOf(f)
    if (v === undefined) continue
    if (f === 'billNumber') plan.set.billNumber = String(v).slice(0, 64)
    else if (f === 'billDate') {
      plan.set.billDate = String(v)
      plan.set.billMonth = String(v).slice(0, 7)
    } else if (f === 'dueAt') plan.set.dueAt = String(v)
    else {
      plan.set.billedCents = Number(v)
      plan.set.varianceCents = Number(v) - bill.grossCents
    }
    plan.fields.push(f)
  }
  // A due date may never precede the bill date it will sit beside.
  if (plan.set.dueAt !== undefined) {
    const effectiveBillDate = plan.set.billDate ?? bill.billDate
    if (plan.set.dueAt < effectiveBillDate) {
      delete plan.set.dueAt
      plan.fields = plan.fields.filter((f) => f !== 'dueAt')
      plan.skipped.push({ field: 'dueAt', reason: 'DUE_BEFORE_BILL_DATE' })
    }
  }
  return plan
}

/** Blanks only (`mergeExtraction` semantics); amount only when the model was sure. A differing value is a conflict. */
export function planVendorUpdate(
  vendor: Pick<LedgerVendorPayable, 'vendor' | 'invoiceNumber' | 'invoiceDate' | 'dueDate' | 'amount'>,
  ext: ApExtraction,
  opts: PlanOptions<VendorField>,
): VendorPlan {
  const plan: VendorPlan = { kind: 'VENDOR_PAYABLE', mode: opts.mode, set: {}, fields: [], changes: [], conflicts: [], skipped: [] }
  const rows: { f: VendorField; current: string | number | null; incoming: string | number | null; same: boolean; allowed: boolean }[] = [
    { f: 'vendor', current: vendor.vendor, incoming: ext.issuer.name, same: sameName(vendor.vendor, ext.issuer.name), allowed: true },
    {
      f: 'invoiceNumber',
      current: vendor.invoiceNumber,
      incoming: ext.invoiceNumber,
      same: normalizeRef(vendor.invoiceNumber) != null && normalizeRef(vendor.invoiceNumber) === normalizeRef(ext.invoiceNumber),
      allowed: true,
    },
    { f: 'invoiceDate', current: vendor.invoiceDate, incoming: ext.invoiceDate, same: vendor.invoiceDate === ext.invoiceDate, allowed: true },
    { f: 'dueDate', current: vendor.dueDate, incoming: ext.dueDate, same: vendor.dueDate === ext.dueDate, allowed: true },
    { f: 'amount', current: vendor.amount, incoming: ext.amountCents, same: vendor.amount === ext.amountCents, allowed: ext.confidence === 'high' },
  ]
  for (const r of rows) {
    if (r.incoming == null || r.incoming === '') {
      plan.skipped.push({ field: r.f, reason: 'NOT_STATED' })
      continue
    }
    if (!r.allowed) {
      plan.skipped.push({ field: r.f, reason: 'LOW_CONFIDENCE' })
      continue
    }
    if (r.same) continue
    const blank = r.current == null || r.current === ''
    ;(blank ? plan.changes : plan.conflicts).push({ field: r.f, current: r.current, incoming: r.incoming })
  }
  for (const r of rows) {
    const inChange = plan.changes.some((c) => c.field === r.f)
    const inConflict = plan.conflicts.some((c) => c.field === r.f)
    let take: boolean
    if (opts.mode === 'AUTO') take = plan.conflicts.length === 0 && inChange
    else {
      const pick = opts.picks?.[r.f]
      take = pick === undefined ? inChange : pick === true && (inChange || inConflict)
    }
    if (!take || r.incoming == null) continue
    plan.set[r.f] = r.f === 'invoiceNumber' ? String(r.incoming).slice(0, 64) : r.incoming
    plan.fields.push(r.f)
  }
  return plan
}

/** The allow-listed columns of a row, for `applied.before/after` (the revert record). */
export function snapshotColumns(row: object, keys: readonly string[]): Record<string, string | number | null> {
  const src = row as Record<string, unknown>
  const out: Record<string, string | number | null> = {}
  for (const k of keys) {
    const v = src[k]
    out[k] = typeof v === 'string' || typeof v === 'number' ? v : null
  }
  return out
}

/** Drops every key that is not on the allow-list. The store applies this to every patch it is handed. */
export function pickAllowed<T extends string>(patch: object, allowed: readonly T[]): Partial<Record<T, string | number>> {
  const src = patch as Record<string, unknown>
  const out: Partial<Record<T, string | number>> = {}
  for (const k of allowed) {
    const v = src[k]
    if (typeof v === 'string' || typeof v === 'number') out[k] = v
  }
  return out
}
