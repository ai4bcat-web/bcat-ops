/**
 * REPOINT_INVOICED_CUSTOMER — credit every open invoice, repoint the shipment,
 * orders and loads, and put each credited order back on the invoicing gate.
 *
 * Owner/ADMIN only, idempotent on the caller-supplied `idempotencyKey`.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { assertString, type Caller } from '../_shared/actionInputs'
import type { PaymentPlan, PlanDocument, PlannedDocument } from '../../../src/lib/paymentApply'
import { ledgerWrites, planInvoiceOf } from './payments'
import { resolveCreditPolicy } from '../../../src/lib/customerCredit'
import { runCommissionsAfter } from './commissions'
import type { CustomerRecord, TmsSettings as TmsSettingsRecord } from '../../../src/types/tms'
import {
  AR_PAYMENT_TABLE_NAME,
  CUSTOMER_TABLE_NAME,
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  INVOICE_TABLE_NAME,
  LOAD_TABLE_NAME,
  ORDER_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  getById,
  getSettings,
  nowIso,
  numberOrNull,
  paymentId,
  putTx,
  queryIndex,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'

/**
 * The subset of the result the test assertions read.
 *
 * Wrapping in an object so an unexpected extra field in the handler response does
 * not accidentally pass a shallow comparison.
 */
interface RepointResult {
  shipmentId: string
  duplicate: boolean
  creditedInvoiceIds: string[]
  creditedCents: number
}

function repointResult(shipmentId: string, payment: Row, duplicate: boolean): RepointResult {
  const applications = Array.isArray(payment.applications) ? (payment.applications as Row[]) : []
  return {
    shipmentId,
    duplicate,
    creditedInvoiceIds: applications.map((a) => String(a.invoiceId)),
    creditedCents: numberOrNull(payment.appliedCents) ?? 0,
  }
}

export async function repointInvoicedCustomer(input: Row, caller: Caller): Promise<RepointResult> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const customerId = assertString(input.customerId, 'customerId')
  const reason = assertString(input.reason, 'reason')
  const idempotencyKey = assertString(input.idempotencyKey, 'idempotencyKey')

  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)

  // ── idempotency ──────────────────────────────────────────────────────────
  // The operation row is keyed by shipment + key, so a retry after a successful
  // repoint finds it even though the shipment now names the new customer.
  const operationId = paymentId('rcm', shipmentId, idempotencyKey)
  const existing = await getById(AR_PAYMENT_TABLE_NAME, operationId)
  if (existing) return repointResult(shipmentId, existing, true)

  if (shipment.voidedAt != null) throw new Error('Cannot repoint a voided shipment')

  // Guard same-customer so nobody moves the paper twice.
  if (String(shipment.customerId ?? '') === customerId) {
    throw new Error('The shipment already belongs to this customer')
  }

  const target = await getById(CUSTOMER_TABLE_NAME, customerId)
  if (!target) throw new Error(`Customer not found: ${customerId}`)
  if (target.mergedIntoId) throw new Error('That customer has been merged into another record')
  if (target.active === false || target.status === 'BLOCKED') {
    throw new Error(`Customer ${String(target.name ?? customerId)} is inactive`)
  }
  const settings = await getSettings()
  const policy = resolveCreditPolicy(target as unknown as CustomerRecord, settings as unknown as TmsSettingsRecord | null)
  if (policy.freeCreditRequired && policy.creditLimitCents == null) {
    throw new Error(`${String(target.name ?? customerId)} requires an approved credit limit before an order can be built`)
  }
  const targetName = String(target.name ?? customerId)

  // ── read orders and their invoices ───────────────────────────────────────
  const orders = await queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const invoiceRows: Row[] = []
  for (const order of orders) {
    const invoiceId = order.invoiceId
    if (typeof invoiceId === 'string' && invoiceId) {
      const invoice = await getById(INVOICE_TABLE_NAME, invoiceId)
      if (invoice) invoiceRows.push(invoice)
    }
  }

  if (invoiceRows.some((inv) => inv.status === 'VOID')) {
    throw new Error('This shipment has a void invoice; it cannot be repointed')
  }

  const touchedByMoney = invoiceRows.some(
    (inv) => (numberOrNull(inv.paidCents) ?? 0) > 0 || (numberOrNull(inv.writtenOffCents) ?? 0) > 0,
  )
  if (touchedByMoney) {
    throw new Error('This shipment has an invoice with a payment or write-off; reverse the payment before repointing')
  }

  const openInvoices = invoiceRows.filter((inv) => inv.status === 'ISSUED')

  // The customer who is being credited comes from the first open invoice (which is
  // the party the AR system always bills). Fall back to the shipment customer for
  // the edge case of a fully-paid-or-void remix where no credits are being posted.
  const creditCustomerId =
    String(openInvoices[0]?.customerId ?? shipment.customerId ?? '')

  const now = nowIso()
  const documents: PlannedDocument[] = []
  const before: Record<string, PlanDocument> = {}
  const applications: { invoiceId: string; amountCents: number }[] = []
  let totalCreditedCents = 0
  const creditedOrderIds = new Set<string>()

  for (const invoice of openInvoices) {
    const prior = planInvoiceOf(invoice)
    // A PARTIAL row that was settled between the read and now, as remote as that is,
    // has nothing left to credit — skip rather than build a 0-application entry.
    if (prior.balanceCents <= 0) continue
    const amount = prior.balanceCents
    totalCreditedCents += amount
    documents.push({
      id: prior.id,
      appliedCents: amount,
      paidCents: prior.paidCents + amount,
      offsetCents: prior.offsetCents,
      balanceCents: 0,
      settled: true,
      becamePaid: true,
    })
    before[prior.id] = prior
    applications.push({ invoiceId: prior.id, amountCents: amount })
    const orderId = String(invoice.orderId ?? '')
    if (orderId) creditedOrderIds.add(orderId)
  }

  // ── build the plan and get the invoice ledger writes ────────────────────
  // Re-use the same transaction items every other cash move uses, so the money
  // math is in one place. Order updates are skipped — we write our own below.
  const plan: PaymentPlan = {
    ok: true,
    errors: [],
    appliedCents: totalCreditedCents,
    fromCreditsCents: 0,
    unappliedCents: 0,
    documents,
    credits: [],
  }

  const { writes: invoiceWrites } = await ledgerWrites(plan, before, caller, now, 'APPLY', {
    skipOrderUpdates: true,
  })

  // ── assemble the transaction ─────────────────────────────────────────────
  const writes: TransactWriteItem[] = []

  // The operation row is the idempotency marker. Only post one when money
  // actually moved — a zero-credit repoint needs no AR record.
  if (totalCreditedCents > 0) {
    writes.push(
      putTx(AR_PAYMENT_TABLE_NAME, {
        id: operationId,
        __typename: 'ArPayment',
        customerId: creditCustomerId,
        kind: 'CREDIT_MEMO',
        receivedAt: now,
        reference: idempotencyKey,
        amountCents: totalCreditedCents,
        appliedCents: totalCreditedCents,
        unappliedCents: 0,
        applications,
        creditApplications: [],
        note: `${reason} (repoint key: ${idempotencyKey})`,
        createdBy: caller.email,
        createdAt: now,
        updatedAt: now,
      }),
    )
  }
  writes.push(...invoiceWrites)

  // Orders: repoint every order; the ones whose invoice was credited go back to
  // the gate so the new customer is billed through GENERATE_INVOICE.
  for (const order of orders) {
    const credited = creditedOrderIds.has(String(order.id))
    const patch: Row = {
      customerId,
      customerName: targetName,
      updatedAt: now,
      updatedBy: caller.email,
      version: (numberOrNull(order.version) ?? 1) + 1,
    }
    const remove: string[] = []
    if (credited) {
      patch.arStatus = 'UNBILLED'
      patch.arStatusChangedAt = now
      patch.arBalanceCents = 0
      remove.push('invoiceId', 'invoiceNumber', 'invoicedAt', 'paidAt', 'factoringItemId')
    }
    writes.push(
      updateTx(ORDER_TABLE_NAME, String(order.id), patch, {
        remove,
        condition: 'version = :priorVersion',
        extraValues: { ':priorVersion': { N: String(numberOrNull(order.version) ?? 1) } },
      }),
    )
  }

  // Loads: mirror the customer so the calendar, settlements and dashboards agree.
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  for (const load of loads) {
    writes.push(
      updateTx(
        LOAD_TABLE_NAME,
        String(load.id),
        {
          customerId,
          customer: targetName,
          updatedAt: now,
          updatedBy: caller.email,
        },
        { condition: 'attribute_exists(id)' },
      ),
    )
  }

  const shipmentVersion = numberOrNull(shipment.version)
  const shipmentCondition = shipmentVersion != null
    ? 'version = :priorVersion'
    : 'attribute_exists(id)'
  const shipmentExtraValues = shipmentVersion != null
    ? { ':priorVersion': { N: String(shipmentVersion) } }
    : undefined

  writes.push(
    updateTx(
      SHIPMENT_TABLE_NAME,
      shipmentId,
      {
        customerId,
        customerName: targetName,
        updatedAt: now,
        updatedBy: caller.email,
        version: (shipmentVersion ?? 1) + 1,
      },
      {
        condition: shipmentCondition,
        extraValues: shipmentExtraValues,
      },
    ),
  )

  // ── post ─────────────────────────────────────────────────────────────────
  try {
    await transact(writes, 'repoint invoiced customer')
  } catch (err) {
    // A concurrent retry with the same key already posted; answer with its result
    // rather than surfacing a TransactionCanceledException the user would retry.
    const winner = await getById(AR_PAYMENT_TABLE_NAME, operationId)
    if (winner) return repointResult(shipmentId, winner, true)
    const failure = new Error(`Repoint failed: ${String((err as Error).message ?? err)}`)
    ;(failure as Error & { cause?: unknown }).cause = err
    throw failure
  }

  const creditedInvoiceIds = openInvoices.map((inv) => String(inv.id))
  for (const invoiceId of creditedInvoiceIds) {
    await runCommissionsAfter(invoiceId, caller, 'WRITE_OFF')
  }

  await writeAudit('Shipment', shipmentId, 'REPOINT_INVOICED_CUSTOMER', caller, {
    fromCustomerId: String(shipment.customerId ?? ''),
    fromCustomerName: shipment.customerName ?? null,
    customerId,
    customerName: targetName,
    reason,
    idempotencyKey,
    creditedInvoiceIds,
    creditedCents: totalCreditedCents,
    ordersRebilled: [...creditedOrderIds],
  })

  const posted = await getById(AR_PAYMENT_TABLE_NAME, operationId)
  return repointResult(shipmentId, posted ?? {}, false)
}