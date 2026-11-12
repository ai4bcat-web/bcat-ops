/**
 * Released-to-billing reconciliation: every order moved to billing from Load Review must
 * show up in AR (Ready to invoice, or an invoice), and every outside carrier with pay on it
 * must show up in AP (a carrier bill). This file decides, for one released order, what is
 * missing; the server reads the rows and the pages render the answer.
 *
 * Pure. The AP half takes the pending-bill plan (`planPendingCarrierBills`): an assignment
 * the plan would still create a bill for has no AP record, and one it cannot bill (no
 * charge lines, carrier not in the directory) is reported so somebody can fix it.
 */

/** Order.arStatus values an order can carry once it has been released. */
const RELEASED_AR = new Set(['UNBILLED', 'UNPAID', 'PAID'])

export interface ReconcileOrderInput {
  order: {
    id: string
    arStatus?: string | null
    invoiceId?: string | null
    readyToInvoiceAt?: string | null
  }
  /** Assignments the pending-bill plan would still create a bill for: no AP record yet. */
  apToCreate: { loadCarrierId: string; carrierName: string; grossCents: number }[]
  /** Assignments the plan cannot bill (reasons say why). */
  apUnbillable: { loadCarrierId: string; carrierName: string; reasons: string[] }[]
}

export interface ReconcileFinding {
  /** No AR item: released but neither waiting to invoice nor pointing at an invoice. */
  arMissing: boolean
  arReason: string | null
  apMissing: ReconcileOrderInput['apToCreate']
  apUnbillable: ReconcileOrderInput['apUnbillable']
}

/** True when this order was moved to billing through Load Review (not imported history). */
export function isReleasedOrder(order: ReconcileOrderInput['order']): boolean {
  return Boolean(order.readyToInvoiceAt) && RELEASED_AR.has(String(order.arStatus ?? ''))
}

export function reconcileReleasedOrder(input: ReconcileOrderInput): ReconcileFinding {
  const { order } = input
  let arReason: string | null = null
  // UNBILLED is the "Ready to invoice" row itself; UNPAID / PAID must point at an invoice.
  if (order.arStatus !== 'UNBILLED' && !(order.invoiceId ?? '').trim()) {
    arReason = `Order is ${String(order.arStatus ?? 'unset')} but has no invoice`
  }
  return {
    arMissing: arReason !== null,
    arReason,
    apMissing: input.apToCreate,
    apUnbillable: input.apUnbillable,
  }
}

export function hasGap(finding: ReconcileFinding): boolean {
  return finding.arMissing || finding.apMissing.length > 0 || finding.apUnbillable.length > 0
}
