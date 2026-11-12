/**
 * Moving a factoring-queue row onto the manual path, and back.
 *
 * Pure of AWS: the handler hands in a MoveStore, the tests hand in a fake. What this owns
 * is the ORDER of the writes and what each one is allowed to leave behind:
 *
 *   1. checks that need no write (permission, customer, AP e-mail, OTR-submitted guard)
 *   2. ONE conditional transaction: FactoringItem -> MANUAL_INVOICE (condition: status is
 *      still what was read) together with Invoice.factored = false
 *   3. the Customer update (condition: billingMethod / apEmail still what was read)
 *   4. if 3 fails, the compensation: the same transaction in reverse, then an audit row
 *
 * so a failure can never leave the customer changed with the invoice still queued, and a
 * repeat click finds nothing to do and writes nothing (no audit, no second change).
 * Nothing here sends e-mail: posting and sending stay the separate release/send step.
 */
import { isValidEmail, type BillingMethod } from '../../../src/lib/billingMethod'
import { otrStatusMeta } from '../../../src/lib/otrInvoiceStatus'

export type Row = Record<string, unknown>

/** A conditional write lost to someone else's change. */
export class StaleError extends Error {}

export interface ItemInvoiceWrite {
  itemId: string
  /** Status the row must still have. */
  expectItemStatus: string
  itemPatch: Row
  invoice: { id: string; version: number; factored: boolean } | null
}

export interface MoveStore {
  getItem(id: string): Promise<Row | null>
  getInvoice(id: string): Promise<Row | null>
  getCustomer(id: string): Promise<Row | null>
  /** Load.customerId for a queue row that does not remember its customer itself. */
  getLoadCustomerId(loadId: string): Promise<string | null>
  /** FactoringItem patch (when itemPatch is non-empty) and Invoice.factored, atomically. Throws StaleError. */
  writeItemAndInvoice(w: ItemInvoiceWrite): Promise<void>
  /** Customer billingMethod/apEmail, conditional on the values read. Throws StaleError. */
  writeCustomer(w: {
    id: string
    expectMethod: BillingMethod | null
    expectApEmail: string | null
    method: BillingMethod
    apEmail: string | null
  }): Promise<void>
  audit(entityType: string, entityId: string, action: string, user: string, changes: Row): Promise<void>
  now(): string
}

export interface Caller {
  email: string
  groups: string[]
}

export const BILLING_RELEASE_GROUP = 'page-billingRelease'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const isAdminCaller = (c: Caller) => c.groups.includes('ADMIN') || c.email.trim().toLowerCase() === OWNER_EMAIL

type Result = { ok: true; data: Row } | { ok: false; error: string }
const fail = (error: string): Result => ({ ok: false, error })
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const MANUAL_STATUSES = ['MANUAL_INVOICE', 'INVOICED_MANUALLY']

/** The human-readable reason OTR refused, as the queue shows it. */
export function noBuyReasonFor(item: Row, actor: string): string {
  const existing = str(item.otrError)
  if (existing) return existing
  const meta = otrStatusMeta(item.otrStatus as number | string | null | undefined)
  const mc = str(item.brokerMcChecked)
  return `OTR will not buy${mc ? ` from MC ${mc}` : ' this invoice'} (No Buy${meta ? `; OTR status ${meta.label}` : ''}), flagged by ${actor}`
}

/** Who the invoice is billed to: the row's own customer, else the invoice's, else the load's. */
async function customerFor(store: MoveStore, item: Row, invoice: Row | null): Promise<Row | null> {
  const id = str(item.customerId) || str(invoice?.customerId) || (item.loadId ? (await store.getLoadCustomerId(String(item.loadId))) ?? '' : '')
  return id ? store.getCustomer(id) : null
}

export interface ManualMoveInput {
  id: string
  reason?: string
  /** Change the customer's default billing method FACTOR -> MANUAL as well. */
  changeCustomerDefault?: boolean
  /** The customer's AP e-mail, used (and saved) only when the customer has no valid one. */
  customerApEmail?: string
  /** Row-level AP e-mail (the manual steps' To). */
  apEmail?: string
  /** The person confirmed moving an invoice already submitted to OTR and not terminal. */
  confirmSubmitted?: boolean
}

export async function manualInvoiceMove(store: MoveStore, input: ManualMoveInput, caller: Caller): Promise<Result> {
  const item = await store.getItem(input.id)
  if (!item) return fail('factoring item not found')
  if (item.status === 'FACTORED') return fail('OTR has already paid this invoice')

  const wantReason: 'NO_BUY' | 'MANUAL' = input.reason === 'NO_BUY' || item.manualReason === 'NO_BUY' ? 'NO_BUY' : 'MANUAL'
  const invoice = str(item.invoiceId) ? await store.getInvoice(String(item.invoiceId)) : null
  const alreadyManual = MANUAL_STATUSES.includes(String(item.status))

  // ── 1. checks that write nothing ──────────────────────────────────────────
  // Invoice manually is the answer to No buy. A Dead invoice or an OTR error is OTR's to
  // sort out, so only an admin may take such a row out of the queue by hand.
  const isNoBuy = wantReason === 'NO_BUY' || item.brokerCheckResult === 'NO_BUY'
  if (!alreadyManual && !isNoBuy && !isAdminCaller(caller)) {
    const meta = otrStatusMeta(item.otrStatus as number | string | null | undefined)
    return fail(
      `OTR has not said No buy${meta ? ` (OTR status ${meta.label})` : ''}, so this invoice stays in the factoring queue. ` +
        'Resolve it with OTR, or ask an admin to invoice it manually.',
    )
  }
  if (!alreadyManual && item.otrInvoiceId && wantReason !== 'NO_BUY' && !input.confirmSubmitted) {
    const meta = otrStatusMeta(item.otrStatus as number | string | null | undefined)
    if (!meta?.terminal) {
      return fail(
        `This invoice is already submitted to OTR${meta ? ` (status ${meta.label})` : ''} and OTR has not finished with it. ` +
          'Confirm that you want to take it back from OTR and invoice manually.',
      )
    }
  }

  let customer: Row | null = null
  let customerPlan: { method: BillingMethod | null; apEmail: string | null; setApEmail: string | null } | null = null
  if (input.changeCustomerDefault) {
    // The billing-release permission: admins (ADMIN group, the owner) or the per-user grant.
    if (!isAdminCaller(caller) && !caller.groups.includes(BILLING_RELEASE_GROUP)) {
      return fail('Changing a customer\'s default billing method needs the billing release permission (Release to billing / Send invoice).')
    }
    customer = await customerFor(store, item, invoice)
    if (!customer) return fail('This row has no customer on file, so its default billing method cannot be changed. Link the customer first.')
    const method = (customer.billingMethod as BillingMethod | null | undefined) ?? null
    const onFile = str(customer.apEmail)
    const typed = str(input.customerApEmail)
    let setApEmail: string | null = null
    if (!isValidEmail(onFile)) {
      if (!typed) {
        return fail(`${str(customer.name) || 'This customer'} has no valid AP e-mail, so its invoices cannot be e-mailed. Enter the AP e-mail to continue.`)
      }
      if (!isValidEmail(typed)) return fail('That does not look like an e-mail address. Enter the customer\'s AP e-mail.')
      setApEmail = typed.toLowerCase()
    }
    customerPlan = { method, apEmail: onFile || null, setApEmail }
  }

  const now = store.now()
  const reason = wantReason === 'NO_BUY' ? noBuyReasonFor(item, caller.email) : null

  // ── 2. the invoice leaves the queue (+ Invoice.factored = false), one transaction ──
  const prevStatus = String(item.status)
  const itemPatch: Row = alreadyManual
    ? {}
    : {
        status: 'MANUAL_INVOICE',
        manualReason: wantReason,
        ...(wantReason === 'NO_BUY' ? { brokerCheckResult: 'NO_BUY', brokerCheckedAt: now, otrError: reason } : { otrError: null }),
        ...(str(input.apEmail) ? { apEmail: str(input.apEmail) } : {}),
      }
  const invoiceNeedsFlip = Boolean(invoice && invoice.status !== 'VOID' && invoice.factored !== false)
  let moved = false
  if (Object.keys(itemPatch).length || invoiceNeedsFlip) {
    try {
      await store.writeItemAndInvoice({
        itemId: String(item.id),
        expectItemStatus: prevStatus,
        itemPatch,
        invoice: invoiceNeedsFlip && invoice ? { id: String(invoice.id), version: Number(invoice.version ?? 1), factored: false } : null,
      })
      moved = true
    } catch (e) {
      if (e instanceof StaleError) {
        const again = await store.getItem(input.id)
        if (again && MANUAL_STATUSES.includes(String(again.status))) return { ok: true, data: { status: again.status, reason: again.manualReason ?? wantReason, alreadyDone: true } }
        return fail('This row was changed by someone else while you were working. Refresh the queue and try again.')
      }
      throw e
    }
    await store.audit('FactoringItem', String(item.id), 'MANUAL_INVOICE', caller.email, {
      by: caller.email,
      at: now,
      invoiceId: invoice ? String(invoice.id) : (str(item.invoiceId) || null),
      proNumber: item.proNumber ?? null,
      previousStatus: prevStatus,
      status: itemPatch.status ?? prevStatus,
      reason: wantReason,
      otrReason: reason ?? (str(item.otrError) || null),
      otrStatus: item.otrStatus ?? null,
      customerId: str(item.customerId) || str(invoice?.customerId) || null,
      invoiceFactoredBefore: invoice ? invoice.factored ?? null : null,
      invoiceFactoredAfter: invoiceNeedsFlip ? false : invoice ? invoice.factored ?? null : null,
    })
  }

  // ── 3. the customer's default, only after the invoice is out of the queue ──
  let customerChanged = false
  if (customer && customerPlan) {
    const needsMethod = customerPlan.method !== 'MANUAL'
    if (needsMethod || customerPlan.setApEmail) {
      try {
        await store.writeCustomer({
          id: String(customer.id),
          expectMethod: customerPlan.method,
          expectApEmail: customerPlan.apEmail,
          method: 'MANUAL',
          apEmail: customerPlan.setApEmail ?? customerPlan.apEmail,
        })
        customerChanged = true
      } catch (e) {
        // ── 4. compensation: put the invoice back where it was ──
        let rolledBack = false
        if (moved) {
          try {
            await store.writeItemAndInvoice({
              itemId: String(item.id),
              expectItemStatus: alreadyManual ? prevStatus : 'MANUAL_INVOICE',
              itemPatch: alreadyManual
                ? {}
                : {
                    status: prevStatus,
                    manualReason: (item.manualReason as string | null | undefined) ?? null,
                    brokerCheckResult: (item.brokerCheckResult as string | null | undefined) ?? null,
                    brokerCheckedAt: (item.brokerCheckedAt as string | null | undefined) ?? null,
                    otrError: (item.otrError as string | null | undefined) ?? null,
                    apEmail: (item.apEmail as string | null | undefined) ?? null,
                  },
              invoice: invoiceNeedsFlip && invoice ? { id: String(invoice.id), version: Number(invoice.version ?? 1) + 1, factored: true } : null,
            })
            rolledBack = true
          } catch {
            rolledBack = false
          }
        }
        const why = e instanceof StaleError ? 'the customer was changed by someone else meanwhile' : e instanceof Error ? e.message : String(e)
        await store.audit('FactoringItem', String(item.id), rolledBack || !moved ? 'MANUAL_INVOICE_ROLLED_BACK' : 'MANUAL_INVOICE_ROLLBACK_FAILED', caller.email, {
          by: caller.email, at: store.now(), customerId: String(customer.id), why,
        })
        return fail(
          rolledBack || !moved
            ? `The customer's billing method was not changed (${why}); the invoice was left where it was. Refresh and try again.`
            : `The customer's billing method was not changed (${why}) and the invoice could not be put back in the queue: it is now Invoice manually. Check it.`,
        )
      }
      await store.audit('Customer', String(customer.id), 'BILLING_METHOD_CHANGED', caller.email, {
        by: caller.email,
        at: store.now(),
        customerName: customer.name ?? null,
        oldMethod: customerPlan.method,
        newMethod: 'MANUAL',
        invoiceId: invoice ? String(invoice.id) : (str(item.invoiceId) || null),
        factoringItemId: String(item.id),
        proNumber: item.proNumber ?? null,
        otrReason: reason ?? (str(item.otrError) || null),
      })
      if (customerPlan.setApEmail) {
        await store.audit('Customer', String(customer.id), 'AP_EMAIL_SET', caller.email, {
          by: caller.email, at: store.now(), customerName: customer.name ?? null, oldApEmail: customerPlan.apEmail, newApEmail: customerPlan.setApEmail,
          factoringItemId: String(item.id),
        })
      }
    }
  }

  return {
    ok: true,
    data: {
      status: itemPatch.status ?? prevStatus,
      reason: wantReason,
      alreadyDone: !moved && !customerChanged,
      customerChanged,
      ...(customer && customerPlan ? { customer: { id: customer.id, name: customer.name ?? null, oldMethod: customerPlan.method, newMethod: 'MANUAL' } } : {}),
    },
  }
}

/**
 * Back into the OTR queue — the reversal. Refused once the invoice has gone out: by the
 * e-mailed step on the row, a finished INVOICED_MANUALLY row, or Invoice.sentAt.
 */
export async function returnToFactoring(store: MoveStore, input: { id: string }, caller: Caller): Promise<Result> {
  const item = await store.getItem(input.id)
  if (!item) return fail('factoring item not found')
  if (!MANUAL_STATUSES.includes(String(item.status))) {
    // A repeat click on a row that already went back is not an error.
    if (item.status === 'NEED_TO_FACTOR' || item.status === 'PENDING_WITH_OTR') return { ok: true, data: { status: item.status, alreadyDone: true } }
    return fail('this row is not being invoiced manually')
  }
  const invoice = str(item.invoiceId) ? await store.getInvoice(String(item.invoiceId)) : null
  const steps = (typeof item.manualSteps === 'string' ? safeJson(item.manualSteps) : item.manualSteps) as { emailed?: unknown } | null
  if (item.status === 'INVOICED_MANUALLY' || steps?.emailed || invoice?.sentAt) {
    return fail('This invoice has already been sent to the customer, so it cannot go back to factoring.')
  }
  const prevStatus = String(item.status)
  // An invoice OTR already holds goes back to waiting on OTR, not to "send it again".
  const status = item.otrInvoiceId ? 'PENDING_WITH_OTR' : 'NEED_TO_FACTOR'
  const flip = Boolean(invoice && invoice.status !== 'VOID' && invoice.factored !== true)
  try {
    await store.writeItemAndInvoice({
      itemId: String(item.id),
      expectItemStatus: prevStatus,
      itemPatch: { status, manualReason: null, manualInvoicedAt: null },
      invoice: flip && invoice ? { id: String(invoice.id), version: Number(invoice.version ?? 1), factored: true } : null,
    })
  } catch (e) {
    if (e instanceof StaleError) return fail('This row was changed by someone else while you were working. Refresh the queue and try again.')
    throw e
  }
  await store.audit('FactoringItem', String(item.id), 'RETURN_TO_FACTORING', caller.email, {
    by: caller.email,
    at: store.now(),
    invoiceId: invoice ? String(invoice.id) : (str(item.invoiceId) || null),
    proNumber: item.proNumber ?? null,
    previousStatus: prevStatus,
    status,
    previousReason: item.manualReason ?? null,
    invoiceFactoredBefore: invoice ? invoice.factored ?? null : null,
    invoiceFactoredAfter: flip ? true : invoice ? invoice.factored ?? null : null,
  })
  return { ok: true, data: { status } }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}
