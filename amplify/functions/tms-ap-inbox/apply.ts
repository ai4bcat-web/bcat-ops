/**
 * Step AG §6 / D8 — every write an e-mail may cause on an AP row, and the queue transitions that
 * go with it. The ONLY ways this Lambda changes an AP row are `store.updateCarrierBill` /
 * `updateVendorPayable` (field allow-lists inside the store) fed by `planBillUpdate` /
 * `planVendorUpdate`; nothing here approves, pays, records, voids or changes a status.
 *
 * Audit rows carry ids, field names, before/after of the allowed columns, the message URL and the
 * match signals — never body text.
 */
import {
  BILL_WRITABLE_COLUMNS,
  planBillUpdate,
  planVendorUpdate,
  snapshotColumns,
  type BillField,
  type BillPlan,
  type VendorField,
  type VendorPlan,
} from '../../../src/lib/apInbox/applyPlan'
import { AP_INBOX_ACTOR } from '../../../src/lib/apInbox/constants'
import type { Decision } from '../../../src/lib/apInbox/match'
import { isPlaceholderBill } from '../../../src/lib/apInbox/refs'
import type {
  ApAppliedRecord,
  ApInboxConfig,
  ApInboxItemRecord,
  ApInboxStatus,
  ApInboxTarget,
  Candidate,
  LedgerBill,
} from '../../../src/lib/apInbox/types'
import { attachToTarget } from './attach'
import type { ApInboxDeps } from './contract'

type TargetKind = ApInboxTarget['kind']

const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** Epoch seconds for the DynamoDB TTL; open items never expire. */
export function ttlEpochFor(status: ApInboxStatus, cfg: Pick<ApInboxConfig, 'dismissedRetentionDays' | 'resolvedRetentionDays'>, now: Date): number | null {
  if (status === 'NEEDS_REVIEW') return null
  const days = status === 'DISMISSED' ? cfg.dismissedRetentionDays : cfg.resolvedRetentionDays
  return Math.floor(now.getTime() / 1000) + days * 86_400
}

export function targetFromCandidate(c: Candidate): ApInboxTarget {
  if (c.targetKind === 'CARRIER_BILL') {
    return compact({ kind: 'CARRIER_BILL' as const, id: c.targetId, billId: c.targetId, loadCarrierId: c.loadCarrierId, shipmentId: c.shipmentId })
  }
  if (c.targetKind === 'LOAD_CARRIER') {
    return compact({ kind: 'LOAD_CARRIER' as const, id: c.targetId, loadCarrierId: c.targetId, shipmentId: c.shipmentId })
  }
  return { kind: 'VENDOR_PAYABLE', id: c.targetId, vendorPayableId: c.targetId }
}

export function targetFromRef(kind: TargetKind, id: string): ApInboxTarget {
  if (kind === 'CARRIER_BILL') return { kind, id, billId: id }
  if (kind === 'LOAD_CARRIER') return { kind, id, loadCarrierId: id }
  return { kind, id, vendorPayableId: id }
}

type PlanPick<F extends string> = Partial<Record<F, boolean>>

function emptyBillPlan(bill: LedgerBill, mode: 'AUTO' | 'HUMAN'): BillPlan {
  return { kind: 'CARRIER_BILL', mode, placeholder: isPlaceholderBill(bill), set: {}, fields: [], changes: [], conflicts: [], skipped: [] }
}

const isInvoice = (item: ApInboxItemRecord): boolean => item.kind === 'INVOICE' && item.extraction.kind === 'INVOICE'

function signalsOf(item: ApInboxItemRecord): { key: string; points: number }[] {
  return (item.match?.top?.signals ?? []).map((s) => ({ key: s.key, points: s.points }))
}

type WriteOutcome =
  | { kind: 'OK'; fields: string[]; applied: ApAppliedRecord; wrote: boolean }
  | { kind: 'CHANGED'; why: string }

interface WriteOptions {
  mode: 'AUTO' | 'HUMAN'
  picks?: PlanPick<string>
  expectedVersion?: number
  actor: string
  now: Date
}

/** Plan against the FRESH row, write under CAS, audit. Never writes when the plan has nothing. */
async function writeTarget(deps: Pick<ApInboxDeps, 'store'>, item: ApInboxItemRecord, target: ApInboxTarget, o: WriteOptions): Promise<WriteOutcome> {
  const { store } = deps
  const at = o.now.toISOString()
  const audit = { itemId: item.id, sourceUrl: item.sourceUrl ?? '', at }
  const ok = (fields: string[], before: ApAppliedRecord['before'], after: ApAppliedRecord['after'], wrote: boolean): WriteOutcome =>
    ({ kind: 'OK', fields, wrote, applied: { at, by: o.actor, mode: o.mode, before, after, fields } })
  const auditChanges = (fields: string[], before: object, after: object) => ({
    itemId: item.id,
    messageUrl: item.sourceUrl ?? null,
    score: item.match?.score ?? null,
    signals: signalsOf(item),
    fields,
    before,
    after,
  })
  const action = o.mode === 'AUTO' ? 'AP_INBOX_APPLIED' : 'AP_INBOX_LINKED'

  if (target.kind === 'CARRIER_BILL') {
    const bill = await store.getBill(target.billId ?? target.id)
    if (!bill) return { kind: 'CHANGED', why: 'The bill is no longer open.' }
    if (o.mode === 'AUTO' && bill.apInboxItemId === item.id) return ok([], {}, {}, false) // crash repair: the write already landed
    if (o.expectedVersion != null && bill.version !== o.expectedVersion) return { kind: 'CHANGED', why: 'The bill changed since you opened it.' }
    const plan = isInvoice(item)
      ? planBillUpdate(bill, item.extraction, { mode: o.mode, picks: o.picks as PlanPick<BillField> | undefined })
      : emptyBillPlan(bill, o.mode)
    if (o.mode === 'AUTO' && plan.conflicts.length > 0) return { kind: 'CHANGED', why: 'The bill now holds values that differ from the e-mail.' }
    const keys = Object.keys(plan.set)
    if (keys.length === 0) {
      if (o.mode === 'HUMAN') await store.writeAudit({ entityType: 'CarrierBill', entityId: bill.id, action, actor: o.actor, changes: auditChanges([], {}, {}) })
      return ok([], {}, {}, false)
    }
    const res = await store.updateCarrierBill(bill.id, plan.set, { expectedVersion: bill.version, expectedStatus: bill.status, audit })
    if (!res) return { kind: 'CHANGED', why: 'The bill changed while the update was being applied.' }
    const row = { ...bill, varianceCents: bill.billedCents - bill.grossCents }
    const before = { ...snapshotColumns(row, keys), version: bill.version }
    const after = { ...snapshotColumns(plan.set, keys), version: res.version }
    await store.writeAudit({ entityType: 'CarrierBill', entityId: bill.id, action, actor: o.actor, changes: auditChanges(plan.fields, before, after) })
    return ok(plan.fields, before, after, true)
  }

  if (target.kind === 'VENDOR_PAYABLE') {
    const id = target.vendorPayableId ?? target.id
    const vendor = await store.getVendorPayable(id)
    if (!vendor || vendor.status !== 'NEED_TO_PAY') return { kind: 'CHANGED', why: 'The vendor bill is no longer waiting to be paid.' }
    const plan: VendorPlan = isInvoice(item)
      ? planVendorUpdate(vendor, item.extraction, { mode: o.mode, picks: o.picks as PlanPick<VendorField> | undefined })
      : { kind: 'VENDOR_PAYABLE', mode: o.mode, set: {}, fields: [], changes: [], conflicts: [], skipped: [] }
    if (o.mode === 'AUTO' && plan.conflicts.length > 0) return { kind: 'CHANGED', why: 'The vendor bill now holds values that differ from the e-mail.' }
    const keys = Object.keys(plan.set)
    if (keys.length === 0) {
      if (o.mode === 'HUMAN') await store.writeAudit({ entityType: 'VendorPayable', entityId: id, action, actor: o.actor, changes: auditChanges([], {}, {}) })
      return ok([], {}, {}, false)
    }
    if (!(await store.updateVendorPayable(id, plan.set, audit))) return { kind: 'CHANGED', why: 'The vendor bill changed while the update was being applied.' }
    const before = snapshotColumns(vendor, keys)
    const after = snapshotColumns(plan.set, keys)
    await store.writeAudit({ entityType: 'VendorPayable', entityId: id, action, actor: o.actor, changes: auditChanges(plan.fields, before, after) })
    return ok(plan.fields, before, after, true)
  }

  // LOAD_CARRIER: no bill yet. Nothing is written; the e-mail is only filed.
  const assignment = await store.getAssignment(target.loadCarrierId ?? target.id)
  if (!assignment) return { kind: 'CHANGED', why: 'That assignment is no longer waiting for an invoice.' }
  if (o.mode === 'HUMAN') {
    await store.writeAudit({ entityType: 'ApInboxItem', entityId: item.id, action, actor: o.actor, changes: { ...auditChanges([], {}, {}), loadCarrierId: assignment.loadCarrierId } })
  }
  return ok([], {}, {}, false)
}

/** Close the item under CAS. A concurrent identical close is accepted; anything else is an error. */
async function settle(
  deps: Pick<ApInboxDeps, 'store'>,
  item: ApInboxItemRecord,
  status: 'APPLIED' | 'LINKED' | 'CREATED',
  target: ApInboxTarget,
  applied: ApAppliedRecord | null,
  actor: string,
  now: Date,
): Promise<ApInboxItemRecord> {
  const cfg = await deps.store.getConfig()
  const next = await deps.store.updateItem(
    item.id,
    { status, target, applied, reviewReason: null, resolvedAt: now.toISOString(), resolvedBy: actor, ttlEpoch: ttlEpochFor(status, cfg, now) },
    { expectedVersion: item.version, statusIn: ['NEEDS_REVIEW'] },
  )
  if (next) return next
  const fresh = await deps.store.getItem(item.id)
  if (fresh && fresh.status === status) return fresh
  throw new Error('This e-mail changed while it was being handled — reload the queue and try again.')
}

// ── AUTO (called by the pipeline) ────────────────────────────────────────────

export async function applyAuto(
  deps: ApInboxDeps,
  item: ApInboxItemRecord,
  decision: Decision,
  now: Date,
): Promise<{ status: 'APPLIED' | 'CHANGED_UNDERFOOT'; item: ApInboxItemRecord; wroteFields: boolean }> {
  const top = decision.top
  if (!top || top.targetKind === 'LOAD_CARRIER') throw new Error('applyAuto needs a bill or vendor payable target')
  const target = targetFromCandidate(top)
  const out = await writeTarget(deps, item, target, { mode: 'AUTO', actor: AP_INBOX_ACTOR, now })
  if (out.kind === 'CHANGED') {
    const next = await deps.store.updateItem(item.id, { reviewReason: 'CHANGED_UNDERFOOT' }, { expectedVersion: item.version, statusIn: ['NEEDS_REVIEW'] })
    return { status: 'CHANGED_UNDERFOOT', item: next ?? item, wroteFields: false }
  }
  const attached = await attachToTarget(deps, item, target)
  const closed = await settle(deps, attached, 'APPLIED', target, out.applied, AP_INBOX_ACTOR, now)
  return { status: 'APPLIED', item: closed, wroteFields: out.wrote }
}

// ── HUMAN link + its preview ────────────────────────────────────────────────

export interface LinkInput {
  target: { kind: TargetKind; id: string }
  picks?: PlanPick<string>
  expectedVersion?: number
}

export async function applyHuman(
  deps: ApInboxDeps,
  item: ApInboxItemRecord,
  input: LinkInput,
  actor: string,
): Promise<{ item: ApInboxItemRecord; fields: string[] }> {
  if (item.status !== 'NEEDS_REVIEW') throw new Error('This e-mail was already handled.')
  const target = targetFromRef(input.target.kind, input.target.id)
  const now = deps.now()
  const out = await writeTarget(deps, item, target, { mode: 'HUMAN', picks: input.picks, expectedVersion: input.expectedVersion, actor, now })
  if (out.kind === 'CHANGED') throw new Error(`${out.why} Reload and try again.`)
  const attached = await attachToTarget(deps, item, target)
  const closed = await settle(deps, attached, 'LINKED', target, out.applied, actor, now)
  return { item: closed, fields: out.fields }
}

export interface LinkPreview {
  plan: BillPlan | VendorPlan
  target: { kind: TargetKind; id: string; label: string }
  /** Bill version to pass back as `expectedVersion` so the diff the reviewer saw is what is written. */
  version?: number
  blocked?: string
  note?: string
}

export async function previewLink(deps: Pick<ApInboxDeps, 'store'>, item: ApInboxItemRecord, ref: { kind: TargetKind; id: string }): Promise<LinkPreview> {
  const { store } = deps
  const creditNote = isInvoice(item) ? undefined : 'Credit memos are never applied to a bill; the e-mail is only attached.'
  if (ref.kind === 'CARRIER_BILL') {
    const bill = await store.getBill(ref.id)
    if (!bill) {
      return { plan: { kind: 'CARRIER_BILL', mode: 'HUMAN', placeholder: false, set: {}, fields: [], changes: [], conflicts: [], skipped: [] }, target: { ...ref, label: ref.id }, blocked: 'That bill is no longer open.' }
    }
    const label = [bill.carrierName, bill.shipmentNumber, bill.billNumber].filter(Boolean).join(' · ') || bill.id
    const plan = isInvoice(item) ? planBillUpdate(bill, item.extraction, { mode: 'HUMAN' }) : emptyBillPlan(bill, 'HUMAN')
    return { plan, target: { ...ref, label }, version: bill.version, ...(creditNote ? { note: creditNote } : {}) }
  }
  if (ref.kind === 'VENDOR_PAYABLE') {
    const vendor = await store.getVendorPayable(ref.id)
    const empty: VendorPlan = { kind: 'VENDOR_PAYABLE', mode: 'HUMAN', set: {}, fields: [], changes: [], conflicts: [], skipped: [] }
    if (!vendor || vendor.status !== 'NEED_TO_PAY') return { plan: empty, target: { ...ref, label: ref.id }, blocked: 'That vendor bill is no longer waiting to be paid.' }
    const label = [vendor.vendor, vendor.invoiceNumber].filter(Boolean).join(' · ') || vendor.id
    const plan = isInvoice(item) ? planVendorUpdate(vendor, item.extraction, { mode: 'HUMAN' }) : empty
    return { plan, target: { ...ref, label }, ...(creditNote ? { note: creditNote } : {}) }
  }
  const a = await store.getAssignment(ref.id)
  const plan: BillPlan = { kind: 'CARRIER_BILL', mode: 'HUMAN', placeholder: false, set: {}, fields: [], changes: [], conflicts: [], skipped: [] }
  if (!a) return { plan, target: { ...ref, label: ref.id }, blocked: 'That assignment is no longer waiting for an invoice.' }
  const label = [a.carrierName, a.shipmentNumber, 'awaiting invoice'].filter(Boolean).join(' · ')
  return { plan, target: { ...ref, label }, note: 'No bill exists yet: the e-mail is filed on the shipment. Record the bill from the queue.' }
}

// ── REVERT ──────────────────────────────────────────────────────────────────

export async function revert(deps: ApInboxDeps, item: ApInboxItemRecord, actor: string): Promise<ApInboxItemRecord> {
  const applied = item.applied
  if ((item.status !== 'APPLIED' && item.status !== 'LINKED') || !applied) throw new Error('Nothing to undo for this e-mail.')
  if (item.target?.kind === 'VENDOR_PAYABLE') throw new Error('Vendor bill updates cannot be undone automatically; edit the vendor bill instead.')
  if (item.target?.kind !== 'CARRIER_BILL' || applied.fields.length === 0) throw new Error('Nothing to undo: this e-mail did not change a bill.')
  const billId = item.target.billId ?? item.target.id
  const stale = 'The bill changed since this update, so it cannot be undone automatically.'
  const bill = await deps.store.getBill(billId)
  if (!bill || bill.version !== applied.after.version) throw new Error(stale)

  const set: Partial<Record<(typeof BILL_WRITABLE_COLUMNS)[number], string | number>> = {}
  for (const col of BILL_WRITABLE_COLUMNS) {
    if (!(col in applied.before)) continue
    const v = applied.before[col]
    // A blank invoice number is restored as '' (the store treats it as blank / removes it).
    if (v != null) set[col] = v
    else if (col === 'billNumber') set[col] = ''
  }
  const res = await deps.store.revertCarrierBill(billId, set, { expectedVersion: bill.version })
  if (!res) throw new Error(stale)
  await deps.store.writeAudit({
    entityType: 'CarrierBill',
    entityId: billId,
    action: 'AP_INBOX_REVERTED',
    actor,
    changes: { itemId: item.id, messageUrl: item.sourceUrl ?? null, fields: applied.fields, restored: applied.before, replaced: applied.after },
  })
  const next = await deps.store.updateItem(
    item.id,
    { status: 'NEEDS_REVIEW', applied: null, target: null, reviewReason: null, resolvedAt: null, resolvedBy: null, ttlEpoch: null },
    { expectedVersion: item.version, statusIn: ['APPLIED', 'LINKED'] },
  )
  if (!next) throw new Error('The bill was restored, but the queue item changed meanwhile — reload the queue.')
  return next
}

// ── DISMISS / MARK_CREATED ──────────────────────────────────────────────────

export const DISMISS_REASONS = ['NOT_INVOICE', 'DUPLICATE', 'ALREADY_HANDLED', 'OTHER'] as const
export type DismissReason = (typeof DISMISS_REASONS)[number]

export async function dismiss(deps: ApInboxDeps, item: ApInboxItemRecord, reason: DismissReason, note: string | undefined, actor: string): Promise<ApInboxItemRecord> {
  if (item.status !== 'NEEDS_REVIEW') throw new Error('This e-mail was already handled.')
  const now = deps.now()
  // Files already filed on a shipment / payable are bill documents now: only unfiled objects are deleted.
  const kept: NonNullable<ApInboxItemRecord['attachments']> = []
  for (const a of item.attachments ?? []) {
    if (a.documentId) {
      kept.push(a)
      continue
    }
    try {
      await deps.objects.delete(a.key)
    } catch {
      kept.push(a)
    }
  }
  const cfg = await deps.store.getConfig()
  const next = await deps.store.updateItem(
    item.id,
    {
      status: 'DISMISSED',
      dismissReason: note ? `${reason}: ${note}` : reason,
      attachments: kept,
      resolvedAt: now.toISOString(),
      resolvedBy: actor,
      ttlEpoch: ttlEpochFor('DISMISSED', cfg, now),
    },
    { expectedVersion: item.version, statusIn: ['NEEDS_REVIEW'] },
  )
  if (!next) throw new Error('This e-mail changed while it was being dismissed — reload the queue.')
  await deps.store.writeAudit({ entityType: 'ApInboxItem', entityId: item.id, action: 'AP_INBOX_DISMISSED', actor, changes: { itemId: item.id, reason, messageUrl: item.sourceUrl ?? null } })
  return next
}

/** After the browser's `RecordBillDialog` succeeded: file the e-mail with the new bill and close the item. */
export async function markCreated(deps: ApInboxDeps, item: ApInboxItemRecord, billId: string, actor: string): Promise<ApInboxItemRecord> {
  if (item.status !== 'NEEDS_REVIEW') throw new Error('This e-mail was already handled.')
  const bill = await deps.store.getBill(billId)
  if (!bill) throw new Error('That bill was not found among the open bills.')
  const now = deps.now()
  const target = compact({ kind: 'CARRIER_BILL' as const, id: bill.id, billId: bill.id, loadCarrierId: bill.loadCarrierId, shipmentId: bill.shipmentId })
  await deps.store.writeAudit({
    entityType: 'CarrierBill',
    entityId: bill.id,
    action: 'AP_INBOX_LINKED',
    actor,
    changes: { itemId: item.id, messageUrl: item.sourceUrl ?? null, via: 'RECORD_BILL', fields: [] },
  })
  const attached = await attachToTarget(deps, item, target)
  return settle(deps, attached, 'CREATED', target, null, actor, now)
}
