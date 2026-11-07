/**
 * Step AW D.4: the post-invoice change rule (R18). Pure helpers; the handler owns the I/O.
 *
 * A shipment that already has an invoice (order.arStatus UNPAID / PAID / PARTIAL, or an
 * invoiceId) may still be edited, but only with a reason; the change is audited on the
 * Shipment, the Order and the Invoice as `POST_INVOICE_CHANGE {reason, before, after,
 * user, at}`, which the "What happened" timeline reads.
 */

type Row = Record<string, unknown>

export const POST_INVOICE_ACTION = 'POST_INVOICE_CHANGE'
export const CHANGE_REASON_MIN = 5
export const CHANGE_REASON_MAX = 500

/** Edit actions the rule gates. */
export const POST_INVOICE_GUARDED_ACTIONS = [
  'SAVE_ORDER_FORM',
  'UPDATE_ORDER_DETAILS',
  'UPDATE_STOP',
  'UPDATE_LOAD_CARRIER_DETAILS',
  'RECALC_CHARGES',
  'UPDATE_CARRIER_CHARGES',
] as const
export type PostInvoiceGuardedAction = (typeof POST_INVOICE_GUARDED_ACTIONS)[number]

export function isPostInvoiceGuarded(action: string): action is PostInvoiceGuardedAction {
  return (POST_INVOICE_GUARDED_ACTIONS as readonly string[]).includes(action)
}

const INVOICED_AR = new Set(['UNPAID', 'PAID', 'PARTIAL'])

/** True once the order carries an invoice or has been billed / paid. */
export function isInvoicedOrder(order: Row | null | undefined): boolean {
  if (!order) return false
  if (typeof order.invoiceId === 'string' && order.invoiceId.trim() !== '') return true
  return typeof order.arStatus === 'string' && INVOICED_AR.has(order.arStatus)
}

export interface ReasonVerdict { ok: boolean; reason: string }

/** The reason a caller gave, trimmed; `ok` only when it is long enough to mean something. */
export function readChangeReason(input: Row): ReasonVerdict {
  const raw = typeof input.changeReason === 'string' ? input.changeReason.trim() : ''
  const reason = raw.slice(0, CHANGE_REASON_MAX)
  return { ok: reason.length >= CHANGE_REASON_MIN, reason }
}

export const REASON_REQUIRED_MESSAGE =
  `REASON_REQUIRED: this shipment already has an invoice; say why it is being changed (at least ${CHANGE_REASON_MIN} characters, changeReason).`

/** The input the action itself sees: the gate's own keys never come from the wire. */
export function cleanGuardedInput(input: Row, invoiced: boolean): Row {
  const { changeReason: _reason, postInvoiceChange: _flag, ...rest } = input
  return invoiced ? { ...rest, postInvoiceChange: true } : rest
}

/** The actions' frozen/locked guards step aside only when the gate vouched for the change. */
export function postInvoiceCleared(input: Row): boolean {
  return input.postInvoiceChange === true
}

const NOISE_KEYS = new Set([
  'updatedAt', 'updatedBy', 'createdAt', 'createdBy', 'version', 'searchKey', '__typename',
  'statusChangedAt', 'statusChangedBy', 'arStatusChangedAt',
])
const MAX_VALUE_CHARS = 2000

/** A comparable, size-capped form of one field value. */
function shown(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value ?? null
  if (typeof value === 'string') return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value
  const json = JSON.stringify(value)
  return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : JSON.parse(json)
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export interface FieldDiff { before: Record<string, unknown>; after: Record<string, unknown> }

/** The fields that differ between two rows, each side holding only the changed keys. */
export function diffRow(before: Row | null | undefined, after: Row | null | undefined): FieldDiff {
  const out: FieldDiff = { before: {}, after: {} }
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const key of keys) {
    if (NOISE_KEYS.has(key)) continue
    const b = before?.[key]
    const a = after?.[key]
    if (same(b, a)) continue
    out.before[key] = shown(b)
    out.after[key] = shown(a)
  }
  return out
}

/** The slice of a bundle a post-invoice change can move: shipment, order, load and the charge lines. */
export interface BundleSnapshot { shipment: Row | null; order: Row | null; load: Row | null; charges: Row[] }

export function snapshotOf(bundle: { shipment?: Row; orders?: Row[]; loads?: Row[]; charges?: Row[] }): BundleSnapshot {
  return {
    shipment: bundle.shipment ?? null,
    order: bundle.orders?.[0] ?? null,
    load: bundle.loads?.[0] ?? null,
    charges: bundle.charges ?? [],
  }
}

const chargeKey = (row: Row): string => String(row.id ?? '')

/** Before/after of everything that moved, keyed by the record it belongs to. Empty record = nothing moved. */
export function diffSnapshots(before: BundleSnapshot, after: BundleSnapshot): FieldDiff {
  const result: FieldDiff = { before: {}, after: {} }
  const put = (scope: string, d: FieldDiff): void => {
    if (Object.keys(d.before).length === 0 && Object.keys(d.after).length === 0) return
    result.before[scope] = d.before
    result.after[scope] = d.after
  }
  put('shipment', diffRow(before.shipment, after.shipment))
  put('order', diffRow(before.order, after.order))
  put('load', diffRow(before.load, after.load))
  const beforeCharges = new Map(before.charges.map((c) => [chargeKey(c), c]))
  const afterCharges = new Map(after.charges.map((c) => [chargeKey(c), c]))
  const chargeBefore: Record<string, unknown> = {}
  const chargeAfter: Record<string, unknown> = {}
  for (const id of new Set([...beforeCharges.keys(), ...afterCharges.keys()])) {
    const d = diffRow(beforeCharges.get(id), afterCharges.get(id))
    if (Object.keys(d.before).length === 0 && Object.keys(d.after).length === 0) continue
    chargeBefore[id] = beforeCharges.has(id) ? d.before : null
    chargeAfter[id] = afterCharges.has(id) ? d.after : null
  }
  if (Object.keys(chargeBefore).length > 0) {
    result.before.charges = chargeBefore
    result.after.charges = chargeAfter
  }
  return result
}

export interface PostInvoiceEntry {
  action: typeof POST_INVOICE_ACTION
  reason: string
  sourceAction: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  user: string
  at: string
  invoiceId: string | null
  invoiceNumber: string | null
  shipmentId: string
}

/** The one audit payload written, identically, on the Shipment, the Order and the Invoice. */
export function buildPostInvoiceEntry(args: {
  reason: string
  sourceAction: string
  diff: FieldDiff
  user: string
  at: string
  order: Row | null
  shipmentId: string
}): PostInvoiceEntry {
  const invoiceId = typeof args.order?.invoiceId === 'string' && args.order.invoiceId ? args.order.invoiceId : null
  const invoiceNumber = typeof args.order?.invoiceNumber === 'string' && args.order.invoiceNumber ? args.order.invoiceNumber : null
  return {
    action: POST_INVOICE_ACTION,
    reason: args.reason,
    sourceAction: args.sourceAction,
    before: args.diff.before,
    after: args.diff.after,
    user: args.user,
    at: args.at,
    invoiceId,
    invoiceNumber,
    shipmentId: args.shipmentId,
  }
}
