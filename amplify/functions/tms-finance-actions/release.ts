/**
 * Step AW stage D.3: release to billing, send invoice, and the factoring-queue change sync.
 *
 * One press of Release does what the customer's billing method says and nothing else:
 *  - FACTOR: invoice the order, push the bill straight into the existing factoring queue
 *    with the same row the e-mail bridge writes (`sendToFactor` -> `factoringRowFor`),
 *    audit it, and send the customer NOTHING.
 *  - MANUAL: invoice the order and stop at "Ready to send" (an ISSUED invoice with no
 *    `sentAt`). `SEND_INVOICE` is the separate act that mails it.
 *
 * Every refusal is a thrown Error whose message starts with a stable code so the UI and
 * the tests can tell them apart. Re-releasing never double-invoices or double-queues: the
 * order already pointing at an invoice is the idempotency key. Over the credit limit is a
 * warning and an audit line, never a refusal.
 *
 * The grant (`page-billingRelease`, no role bypass) is enforced by the router before any
 * function here runs.
 */
import { assertString, optionalString, assertRecord, type Caller } from '../_shared/actionInputs'
import { assertNotSquareInvoiced } from '../../../src/lib/invoiceDelivery'
import { emailInvoice, generateInvoice, assertCustomerResolved, readOrderContext } from './invoices'
import { sendToFactor } from './factor'
import type { CustomerRecord, InvoiceRecord, OrderRecord } from '../../../src/types/tms'
import {
  CARRIED_OVER_MESSAGE,
  CUSTOMER_TABLE_NAME,
  FACTORING_ITEM_TABLE_NAME,
  INVOICE_TABLE_NAME,
  LOAD_CHARGE_TABLE_NAME,
  ORDER_TABLE_NAME,
  getById,
  getSettings,
  isCarriedOver,
  normalizeEmailList,
  nowIso,
  numberOrNull,
  queryIndex,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'

const IDX_INVOICES_BY_CUSTOMER = 'invoicesByCustomerIdAndIssuedAt'

export const RELEASE_REFUSALS = {
  BILLING_METHOD_UNSET: 'BILLING_METHOD_UNSET',
  AP_EMAIL_MISSING: 'AP_EMAIL_MISSING',
  CARRIED_OVER: 'CARRIED_OVER',
} as const

function refuse(code: string, message: string): never {
  throw new Error(`${code}: ${message}`)
}

function methodOf(customer: CustomerRecord | null): 'FACTOR' | 'MANUAL' | null {
  const method = (customer as unknown as Row | null)?.billingMethod
  return method === 'FACTOR' || method === 'MANUAL' ? method : null
}

function apEmailOf(customer: CustomerRecord | null): string | null {
  const raw = (customer as unknown as Row | null)?.apEmail
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return email || null
}

/** Over-limit is a flag: any failure reading the book simply yields no flag. */
async function overCreditLimit(customerId: string, customer: CustomerRecord | null): Promise<{ over: boolean; openCents: number; limitCents: number } | null> {
  try {
    const settings = await getSettings()
    const limit = numberOrNull(customer?.creditLimitCents) ?? numberOrNull(settings.defaultCreditLimitCents)
    if (limit == null || limit <= 0) return null
    const rows = await queryIndex(INVOICE_TABLE_NAME, IDX_INVOICES_BY_CUSTOMER, 'customerId', customerId)
    const openCents = rows
      .filter((row) => row.status !== 'VOID' && row.arOpen === 'OPEN')
      .reduce((sum, row) => sum + (numberOrNull(row.balanceCents) ?? 0), 0)
    return { over: openCents > limit, openCents, limitCents: limit }
  } catch (err) {
    console.warn('[tms-finance-actions] credit limit check skipped:', String(err))
    return null
  }
}

async function loadFactoringItem(invoice: Row): Promise<Row | null> {
  const id = typeof invoice.factoringItemId === 'string' ? invoice.factoringItemId : null
  return id ? getById(FACTORING_ITEM_TABLE_NAME, id) : null
}

export async function releaseToBilling(input: Row, caller: Caller): Promise<Row> {
  const orderId = assertString(input.orderId, 'orderId')
  const clientRequestId = optionalString(input.clientRequestId, 128)

  const context = await readOrderContext(orderId)
  assertNotSquareInvoiced(context.shipment, 'releasing it to billing')
  assertCustomerResolved(context, 'releasing it to billing')
  const { order, shipment, customer } = context
  const method = methodOf(customer)

  if (shipment.legacyImported === true || order.invoiceId && (await isInvoiceCarriedOver(String(order.invoiceId)))) {
    refuse(RELEASE_REFUSALS.CARRIED_OVER, CARRIED_OVER_MESSAGE)
  }

  // Idempotent re-release: the order already holds its invoice.
  if (order.invoiceId) {
    const existing = await getById(INVOICE_TABLE_NAME, String(order.invoiceId))
    if (existing && existing.status !== 'VOID') {
      const queued = await loadFactoringItem(existing)
      if (method !== 'FACTOR' || queued) {
        return {
          invoice: existing,
          factoringItem: queued,
          billingMethod: method,
          alreadyReleased: true,
          readyToSend: method === 'MANUAL' && !existing.sentAt,
          warnings: [],
        }
      }
      // FACTOR, invoiced but never queued (an earlier queue push failed): finish the job below.
    }
  }

  if (!method) {
    refuse(RELEASE_REFUSALS.BILLING_METHOD_UNSET, `${customer?.name ?? 'This customer'} has no billing method; set Factor or Manual on the customer first.`)
  }
  if (method === 'MANUAL' && !apEmailOf(customer)) {
    refuse(RELEASE_REFUSALS.AP_EMAIL_MISSING, `${customer?.name ?? 'This customer'} is billed manually but has no AP e-mail; add one on the customer first.`)
  }

  let invoice: InvoiceRecord
  let alreadyReleased = false
  if (order.invoiceId) {
    invoice = (await getById(INVOICE_TABLE_NAME, String(order.invoiceId))) as unknown as InvoiceRecord
    alreadyReleased = true
  } else {
    try {
      invoice = (await generateInvoice({ orderId }, caller)).invoice as unknown as InvoiceRecord
    } catch (err) {
      // Two presses racing: the loser's transaction is refused; the winner's invoice is the answer.
      const fresh = await getById(ORDER_TABLE_NAME, orderId)
      const winner = fresh?.invoiceId ? await getById(INVOICE_TABLE_NAME, String(fresh.invoiceId)) : null
      if (!winner) throw err
      return {
        invoice: winner,
        factoringItem: await loadFactoringItem(winner),
        billingMethod: method,
        alreadyReleased: true,
        readyToSend: method === 'MANUAL' && !winner.sentAt,
        warnings: [],
      }
    }
  }

  const warnings: string[] = []
  const credit = await overCreditLimit(invoice.customerId, customer)
  if (credit?.over) {
    warnings.push('OVER_CREDIT_LIMIT')
    await writeAudit('Invoice', invoice.id, 'OVER_CREDIT_LIMIT', caller, credit)
  }

  const releaseChanges = { orderId, shipmentId: invoice.shipmentId, billingMethod: method, clientRequestId, alreadyReleased }
  let factoringItem: Row | null = null
  if (method === 'FACTOR') {
    try {
      const sent = await sendToFactor({ invoiceId: invoice.id }, caller)
      factoringItem = sent.factoringItem as Row
      invoice = sent.invoice as unknown as InvoiceRecord
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw Object.assign(new Error(`Invoice ${invoice.number} was created but could not be pushed to the factoring queue: ${reason} Fix that and release again; it will not invoice twice.`), { cause: err })
    }
    const queuedChanges = { ...releaseChanges, factoringItemId: factoringItem.id, proNumber: factoringItem.proNumber, customerEmailed: false }
    await writeAudit('Invoice', invoice.id, 'PUSHED_TO_FACTORING_QUEUE_ON_RELEASE', caller, queuedChanges)
    await writeAudit('SHIPMENT', invoice.shipmentId, 'PUSHED_TO_FACTORING_QUEUE_ON_RELEASE', caller, { ...queuedChanges, invoiceId: invoice.id, note: 'Pushed to factoring queue on release' })
  }
  await writeAudit('Invoice', invoice.id, 'RELEASE_TO_BILLING', caller, { ...releaseChanges, warnings })
  await writeAudit('SHIPMENT', invoice.shipmentId, 'RELEASE_TO_BILLING', caller, { ...releaseChanges, invoiceId: invoice.id, warnings })

  return {
    invoice: (await getById(INVOICE_TABLE_NAME, invoice.id)) ?? (invoice as unknown as Row),
    factoringItem,
    billingMethod: method,
    alreadyReleased,
    readyToSend: method === 'MANUAL',
    warnings,
  }
}

async function isInvoiceCarriedOver(invoiceId: string): Promise<boolean> {
  const row = await getById(INVOICE_TABLE_NAME, invoiceId)
  return row != null && isCarriedOver(row)
}

/** The e-mail set for one manual send: To = AP address plus any extra To addresses; Cc = per-customer list + company always-copy, de-duplicated. */
export function manualInvoiceRecipients(
  customer: CustomerRecord | null,
  alwaysCopy: unknown,
): { to: string[]; cc: string[] } {
  const ap = apEmailOf(customer)
  const extra = normalizeEmailList((customer as unknown as Row | null)?.apEmailsExtra ?? [], 'apEmailsExtra')
  const to = [...(ap ? [ap] : []), ...extra].filter((email, index, all) => all.indexOf(email) === index)
  const own = normalizeEmailList((customer as unknown as Row | null)?.invoiceCopyEmails ?? [], 'invoiceCopyEmails')
  const company = normalizeEmailList(alwaysCopy ?? [], 'invoiceAlwaysCopyEmails')
  const cc = [...own, ...company].filter((email, index, all) => all.indexOf(email) === index && !to.includes(email))
  return { to, cc }
}

export async function sendInvoice(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const message = optionalString(input.message, 2000)

  const row = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!row) throw new Error(`Invoice not found: ${invoiceId}`)
  if (row.status === 'VOID') throw new Error('That invoice is void; it cannot be sent')
  if (isCarriedOver(row)) refuse(RELEASE_REFUSALS.CARRIED_OVER, CARRIED_OVER_MESSAGE)
  const invoice = row as unknown as InvoiceRecord

  const customerRow = invoice.customerId ? await getById(CUSTOMER_TABLE_NAME, invoice.customerId) : null
  const customer = customerRow as unknown as CustomerRecord | null
  const method = methodOf(customer)
  if (!method) refuse(RELEASE_REFUSALS.BILLING_METHOD_UNSET, `${invoice.customerName ?? 'This customer'} has no billing method.`)
  if (method === 'FACTOR') {
    throw new Error('FACTOR_NOT_EMAILED: A factored customer is never e-mailed; the bill goes through the factoring queue.')
  }
  const settings = await getSettings()
  const { to, cc } = manualInvoiceRecipients(customer, settings.invoiceAlwaysCopyEmails)
  if (to.length === 0) refuse(RELEASE_REFUSALS.AP_EMAIL_MISSING, `${invoice.customerName ?? 'This customer'} has no AP e-mail; add one on the customer first.`)

  const sent = await emailInvoice({ invoiceId, to, cc, ...(message ? { message } : {}) }, caller)
  await writeAudit('SHIPMENT', invoice.shipmentId, 'INVOICE_SENT', caller, {
    invoiceId,
    number: invoice.number,
    to,
    cc,
    status: sent.emailStatus,
  })
  return sent
}

// ── SYNC_FACTORING_CHANGE ───────────────────────────────────────────────────

/**
 * A change made in the factoring queue (amount, PO, OTR fields) propagated to the
 * invoice, the order and the charge in ONE transaction, with a required reason and the
 * same POST_INVOICE_CHANGE audit on the shipment, the invoice and the queue row.
 * Refuses a row already submitted to OTR: the factor holds the old numbers.
 */
export async function syncFactoringChange(input: Row, caller: Caller): Promise<Row> {
  const proNumber = assertString(input.proNumber, 'proNumber').trim()
  const reason = optionalString(input.changeReason, 2000)
  if (!reason) throw new Error('REASON_REQUIRED: A change to a billed shipment needs a reason.')
  const changes = assertRecord(input.changes, 'changes')

  const item = await getById(FACTORING_ITEM_TABLE_NAME, proNumber)
  if (!item) throw new Error(`Factoring row not found: ${proNumber}`)
  if (item.otrInvoiceId) throw new Error(`PRO ${proNumber} was already submitted to OTR as invoice ${String(item.otrInvoiceId)}; it cannot be changed here.`)
  const invoiceId = typeof item.invoiceId === 'string' ? item.invoiceId : null
  if (!invoiceId) throw new Error(`PRO ${proNumber} is not tied to a TMS invoice, so there is nothing to sync.`)
  const invoiceRow = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!invoiceRow) throw new Error(`Invoice not found: ${invoiceId}`)
  const invoice = invoiceRow as unknown as InvoiceRecord
  if (invoice.status === 'VOID') throw new Error('That invoice is void; it cannot be changed')
  if ((invoice.paidCents ?? 0) > 0 || (invoice.writtenOffCents ?? 0) > 0) {
    throw new Error('Money has been applied to this invoice; reverse the payment before changing its amount')
  }
  const orderRow = await getById(ORDER_TABLE_NAME, invoice.orderId)
  if (!orderRow) throw new Error(`Order not found: ${invoice.orderId}`)
  const order = orderRow as unknown as OrderRecord

  const now = nowIso()
  const before: Row = {}
  const after: Row = {}
  const changed: string[] = []
  const writes: ReturnType<typeof updateTx>[] = []
  const invoicePatch: Row = {}
  const itemPatch: Row = {}

  if (changes.invoiceAmountCents !== undefined) {
    const cents = changes.invoiceAmountCents
    if (typeof cents !== 'number' || !Number.isInteger(cents) || cents <= 0) {
      throw new Error('invoiceAmountCents must be a positive whole number of cents')
    }
    if (cents !== invoice.totalCents) {
      const lines = invoice.lines ?? []
      if (lines.length !== 1) {
        throw new Error('This invoice has more than one charge line; change the amount from the shipment, not the factoring queue.')
      }
      const line = lines[0]
      const count = line.count > 0 ? line.count : 1
      before.invoiceAmountCents = invoice.totalCents
      after.invoiceAmountCents = cents
      changed.push('invoiceAmountCents')
      invoicePatch.lines = [{ ...line, amountCents: cents, rateCents: Math.round(cents / count) }]
      invoicePatch.subtotalCents = cents
      invoicePatch.totalCents = cents
      invoicePatch.balanceCents = cents
      itemPatch.otrManualFields = { ...(item.otrManualFields as Row | undefined), InvoiceAmount: (cents / 100).toFixed(2) }
      writes.push(
        updateTx(ORDER_TABLE_NAME, order.id, {
          revenueCents: cents,
          arBalanceCents: cents,
          updatedAt: now,
          updatedBy: caller.email,
          version: (order.version ?? 1) + 1,
        }, { condition: 'invoiceId = :invoiceId', extraValues: { ':invoiceId': { S: invoiceId } } }),
      )
      if (line.chargeId) {
        writes.push(updateTx(
          LOAD_CHARGE_TABLE_NAME,
          String(line.chargeId),
          { amountCents: cents, rateCents: Math.round(cents / count), updatedAt: now, updatedBy: caller.email },
          { condition: 'attribute_exists(id)' },
        ))
      }
    }
  }
  if (changes.poNumber !== undefined) {
    const po = typeof changes.poNumber === 'string' ? changes.poNumber.trim() : ''
    const fields = { ...((itemPatch.otrManualFields ?? item.otrManualFields) as Row | undefined) }
    before.poNumber = fields.PoNumber ?? null
    after.poNumber = po || null
    if (po) fields.PoNumber = po
    else delete fields.PoNumber
    itemPatch.otrManualFields = fields
    changed.push('poNumber')
  }
  if (changes.otrManualFields !== undefined) {
    const extra = assertRecord(changes.otrManualFields, 'otrManualFields')
    const fields = { ...((itemPatch.otrManualFields ?? item.otrManualFields) as Row | undefined) }
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value !== 'string') throw new Error(`otrManualFields.${key} must be text`)
      before[`otrManualFields.${key}`] = fields[key] ?? null
      after[`otrManualFields.${key}`] = value
      fields[key] = value
      changed.push(`otrManualFields.${key}`)
    }
    itemPatch.otrManualFields = fields
  }
  if (changed.length === 0) return { invoice: invoiceRow, factoringItem: item, order: orderRow, changed }

  writes.unshift(updateTx(INVOICE_TABLE_NAME, invoiceId, {
    ...invoicePatch, updatedAt: now, updatedBy: caller.email, version: (invoice.version ?? 1) + 1,
  }, { condition: 'paidCents = :zero AND writtenOffCents = :zero', extraValues: { ':zero': { N: '0' } } }))
  writes.push(updateTx(FACTORING_ITEM_TABLE_NAME, proNumber, { ...itemPatch, updatedAt: now }))
  await transact(writes, 'sync factoring change')

  const audit = { reason, before, after, user: caller.email, at: now, proNumber }
  await writeAudit('SHIPMENT', invoice.shipmentId, 'POST_INVOICE_CHANGE', caller, audit)
  await writeAudit('Invoice', invoiceId, 'POST_INVOICE_CHANGE', caller, audit)
  await writeAudit('FactoringItem', proNumber, 'POST_INVOICE_CHANGE', caller, audit)
  return {
    invoice: (await getById(INVOICE_TABLE_NAME, invoiceId)) ?? {},
    factoringItem: (await getById(FACTORING_ITEM_TABLE_NAME, proNumber)) ?? {},
    order: (await getById(ORDER_TABLE_NAME, order.id)) ?? {},
    changed,
  }
}
