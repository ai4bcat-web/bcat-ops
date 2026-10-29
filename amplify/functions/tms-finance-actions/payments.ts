/**
 * The cash ledger: receive a payment, issue a credit, write one off, reverse a mistake.
 *
 * Three rules shape every function here.
 *
 * 1. **The plan decides, the transaction executes.** `planPayment` / `writeOffPlan` /
 *    `reversalPlan` (src/lib/paymentApply.ts) do all of the arithmetic and all of the
 *    refusing, against rows read a moment earlier. Nothing below re-derives a balance.
 * 2. **Every write that depends on what it read says so in a condition.** An invoice is
 *    updated only if its `paidCents` and `writtenOffCents` are still what the plan saw;
 *    an order is updated only if it still points at the invoice being paid; a credit is
 *    spent with an atomic ADD conditioned on there being enough left. Two people
 *    allocating the same credit, or paying the same invoice, in the same second lose
 *    the transaction rather than the money.
 * 3. **Nothing is edited or deleted.** A mistake gets a REVERSAL row that restores the
 *    balances the original took, and the original keeps `reversedByPaymentId` so it can
 *    never be reversed twice.
 */
import { randomUUID } from 'crypto'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  assertArrayOf,
  assertEnum,
  assertRecord,
  assertString,
  optionalEnum,
  optionalInteger,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import {
  invoiceStatusAfter,
  planPayment,
  reversalPlan,
  writeOffPlan,
  type PlanApplication,
  type PlanCredit,
  type PlanDocument,
  type PaymentPlan,
} from '../../../src/lib/paymentApply'
import type {
  ArPaymentKind,
  ArPaymentMethod,
  CreditApplication,
  PaymentApplication,
} from '../../../src/types/tms'
import {
  AR_PAYMENT_TABLE_NAME,
  INVOICE_TABLE_NAME,
  ORDER_TABLE_NAME,
  getById,
  NULL_TYPE_VALUE,
  nowIso,
  numberOrNull,
  paymentId,
  postOnce,
  putTx,
  spendCreditTx,
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { runCommissionsAfter } from './commissions'

const METHODS: readonly ArPaymentMethod[] = ['CHECK', 'ACH', 'WIRE', 'CARD', 'FACTOR', 'OTHER']
const MAX_NOTE = 2000

/** One row of the ledger, as the dialogs and the detail page read it back. */
interface PostedRow {
  payment: Row
  invoices: Row[]
  duplicate: boolean
}

function planInvoiceOf(row: Row): PlanDocument {
  const totalCents = numberOrNull(row.totalCents) ?? 0
  const paidCents = numberOrNull(row.paidCents) ?? 0
  const writtenOffCents = numberOrNull(row.writtenOffCents) ?? 0
  return {
    id: String(row.id),
    partyId: String(row.customerId ?? ''),
    totalCents,
    paidCents,
    offsetCents: writtenOffCents,
    balanceCents: numberOrNull(row.balanceCents) ?? totalCents - paidCents - writtenOffCents,
    voided: row.status === 'VOID',
    number: typeof row.number === 'string' ? row.number : null,
  }
}

function planCreditOf(row: Row): PlanCredit {
  return {
    id: String(row.id),
    partyId: String(row.customerId ?? ''),
    kind: (row.kind as ArPaymentKind) ?? 'PAYMENT',
    unappliedCents: numberOrNull(row.unappliedCents) ?? 0,
    reference: typeof row.reference === 'string' ? row.reference : null,
    reversed: row.reversedByPaymentId != null,
  }
}

/**
 * The persisted AR shape, as the planner wants it.
 *
 * `applications` on an ArPayment row stays `{ invoiceId, amountCents }` — the planner
 * is the only thing that speaks `documentId`, and it speaks it to both ledgers.
 */
function planApplicationsOf(applications: PaymentApplication[]): PlanApplication[] {
  return applications.map((application) => ({
    documentId: application.invoiceId,
    amountCents: application.amountCents,
  }))
}

function assertApplications(value: unknown, label: string): PaymentApplication[] {
  if (value == null) return []
  return assertArrayOf<PaymentApplication>(value, label, (item, index) => {
    const row = assertRecord(item, `${label}[${index}]`)
    return {
      invoiceId: assertString(row.invoiceId, `${label}[${index}].invoiceId`),
      amountCents: optionalInteger(row.amountCents, { min: 1, label: `${label}[${index}].amountCents` }) ?? 0,
    }
  }, 40)
}

function assertCreditApplications(value: unknown, label: string): CreditApplication[] {
  if (value == null) return []
  return assertArrayOf<CreditApplication>(value, label, (item, index) => {
    const row = assertRecord(item, `${label}[${index}]`)
    return {
      paymentId: assertString(row.paymentId, `${label}[${index}].paymentId`),
      amountCents: optionalInteger(row.amountCents, { min: 1, label: `${label}[${index}].amountCents` }) ?? 0,
    }
  }, 10)
}

/**
 * The day the money arrived, pinned to noon UTC.
 *
 * A receipt typed as "the 31st" in Chicago must not land in the next month's book
 * because midnight UTC is six hours earlier; noon is far enough from both edges that
 * no timezone a user of this system sits in can move the date.
 */
function receivedAtOf(value: unknown): string {
  const raw = assertString(value, 'receivedAt')
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T12:00:00.000Z`
  if (Number.isNaN(Date.parse(raw))) throw new Error('receivedAt must be a date or an ISO timestamp')
  return new Date(raw).toISOString()
}

async function alreadyPosted(id: string): Promise<Row | null> {
  return getById(AR_PAYMENT_TABLE_NAME, id)
}

/** Everything a plan implies for the invoices and their orders, as transaction items. */
async function ledgerWrites(
  plan: PaymentPlan,
  before: Record<string, PlanDocument>,
  caller: Caller,
  now: string,
  direction: 'APPLY' | 'REVERSE',
): Promise<{ writes: TransactWriteItem[]; invoiceIds: string[] }> {
  const writes: TransactWriteItem[] = []
  const invoiceIds: string[] = []

  for (const planned of plan.documents) {
    const prior = before[planned.id]
    const row = await getById(INVOICE_TABLE_NAME, planned.id)
    if (!row) throw new Error(`Invoice ${planned.id} was not found`)
    const settled = planned.settled
    writes.push(
      updateTx(
        INVOICE_TABLE_NAME,
        planned.id,
        {
          paidCents: planned.paidCents,
          writtenOffCents: planned.offsetCents,
          balanceCents: planned.balanceCents,
          status: invoiceStatusAfter(prior.totalCents, planned.paidCents, planned.offsetCents),
          ...(settled ? { paidAt: now } : {}),
          ...(settled ? {} : { arOpen: 'OPEN' }),
          updatedAt: now,
          updatedBy: caller.email,
          version: (numberOrNull(row.version) ?? 1) + 1,
        },
        {
          // `arOpen` must LEAVE the row, never become null: a NULL in an index key is
          // rejected outright (step C, BUILD_LOG 32d3eec).
          remove: settled ? ['arOpen'] : direction === 'REVERSE' ? ['paidAt'] : [],
          condition: 'attribute_exists(id) AND paidCents = :priorPaid AND writtenOffCents = :priorWritten AND #st <> :void',
          extraValues: {
            ':priorPaid': { N: String(prior.paidCents) },
            ':priorWritten': { N: String(prior.offsetCents) },
            ':void': { S: 'VOID' },
          },
        },
      ),
    )
    // `#st` has to be declared as a name; `status` is a DynamoDB reserved word.
    const update = writes[writes.length - 1].Update
    if (update?.ExpressionAttributeNames) update.ExpressionAttributeNames['#st'] = 'status'

    const orderId = String(row.orderId ?? '')
    if (orderId) {
      const order = await getById(ORDER_TABLE_NAME, orderId)
      writes.push(
        updateTx(
          ORDER_TABLE_NAME,
          orderId,
          {
            arStatus: settled ? 'PAID' : 'UNPAID',
            arBalanceCents: planned.balanceCents,
            arStatusChangedAt: now,
            ...(settled ? { paidAt: now } : {}),
            updatedAt: now,
            updatedBy: caller.email,
            version: (numberOrNull(order?.version) ?? 1) + 1,
          },
          {
            remove: settled ? [] : ['paidAt'],
            // The order is only moved if it still belongs to this invoice: a void and
            // re-issue between the read and the write must not repaint the new one.
            condition: 'invoiceId = :invoiceId',
            extraValues: { ':invoiceId': { S: planned.id } },
          },
        ),
      )
    }
    invoiceIds.push(planned.id)
  }

  for (const credit of plan.credits) {
    writes.push(spendCreditTx(AR_PAYMENT_TABLE_NAME, credit.id, credit.usedCents, now, caller.email))
  }

  return { writes, invoiceIds }
}

async function readPlanInputs(
  applications: PaymentApplication[],
  creditApplications: CreditApplication[],
): Promise<{ documents: PlanDocument[]; credits: PlanCredit[]; before: Record<string, PlanDocument> }> {
  const invoiceRows = await Promise.all(
    applications.map((application) => getById(INVOICE_TABLE_NAME, application.invoiceId)),
  )
  const creditRows = await Promise.all(
    creditApplications.map((use) => getById(AR_PAYMENT_TABLE_NAME, use.paymentId)),
  )
  const documents: PlanDocument[] = []
  const before: Record<string, PlanDocument> = {}
  for (const row of invoiceRows) {
    if (!row) continue
    const plan = planInvoiceOf(row)
    documents.push(plan)
    before[plan.id] = plan
  }
  const credits = creditRows.filter((row): row is Row => row != null).map(planCreditOf)
  return { documents, credits, before }
}

async function readBack(paymentRowId: string, invoiceIds: string[], duplicate: boolean): Promise<PostedRow> {
  const [payment, ...invoices] = await Promise.all([
    getById(AR_PAYMENT_TABLE_NAME, paymentRowId),
    ...invoiceIds.map((id) => getById(INVOICE_TABLE_NAME, id)),
  ])
  return {
    payment: payment ?? {},
    invoices: invoices.filter((row): row is Row => row != null),
    duplicate,
  }
}

export async function recordPayment(input: Row, caller: Caller): Promise<PostedRow> {
  const customerId = assertString(input.customerId, 'customerId')
  const receivedAt = receivedAtOf(input.receivedAt)
  const method = optionalEnum(input.method, METHODS, 'method') ?? 'OTHER'
  const reference = optionalString(input.reference, 120)
  const amountCents = optionalInteger(input.amountCents, { min: 0, label: 'amountCents' }) ?? 0
  const applications = assertApplications(input.applications, 'applications')
  const creditApplications = assertCreditApplications(input.creditApplications, 'creditApplications')
  const note = optionalString(input.note, MAX_NOTE)
  const clientRequestId = optionalString(input.clientRequestId, 64)

  const id = paymentId('pay', customerId, clientRequestId)
  const existing = await alreadyPosted(id)
  if (existing) {
    const ids = (existing.applications as PaymentApplication[] | undefined)?.map((a) => a.invoiceId) ?? []
    return readBack(id, ids, true)
  }

  const { documents, credits, before } = await readPlanInputs(applications, creditApplications)
  const plan = planPayment({
    kind: 'PAYMENT',
    partyId: customerId,
    amountCents,
    applications: planApplicationsOf(applications),
    creditApplications,
    documents,
    credits,
  })
  if (!plan.ok) throw new Error(plan.errors.join('; '))

  const now = nowIso()
  const { writes, invoiceIds } = await ledgerWrites(plan, before, caller, now, 'APPLY')
  writes.unshift(
    putTx(AR_PAYMENT_TABLE_NAME, {
      id,
      __typename: 'ArPayment',
      customerId,
      kind: 'PAYMENT',
      receivedAt,
      method,
      reference,
      amountCents,
      appliedCents: plan.appliedCents,
      unappliedCents: plan.unappliedCents,
      applications,
      creditApplications,
      note,
      createdBy: caller.email,
      createdAt: now,
      updatedAt: now,
    }),
  )

  const duplicate = await postOnce(AR_PAYMENT_TABLE_NAME, writes, 'payment', id, clientRequestId != null)
  if (!duplicate) {
    await writeAudit('ArPayment', id, 'RECORD_PAYMENT', caller, {
      customerId,
      amountCents,
      appliedCents: plan.appliedCents,
      unappliedCents: plan.unappliedCents,
      applications,
      creditApplications,
    })
  }
  // Step I. A settled invoice is the second trigger a commission plan may use,
  // and a part payment can still move an invoice's balance, so the run decides
  // for itself whether anything is owed yet.
  for (const invoiceId of invoiceIds) await runCommissionsAfter(invoiceId, caller, 'RUN')
  return readBack(id, invoiceIds, duplicate)
}

export async function createCredit(input: Row, caller: Caller): Promise<PostedRow> {
  const customerId = assertString(input.customerId, 'customerId')
  const receivedAt = receivedAtOf(input.memoDate ?? input.receivedAt)
  const reference = optionalString(input.reference, 120)
  const amountCents = optionalInteger(input.amountCents, { min: 1, label: 'amountCents' }) ?? 0
  const note = optionalString(input.note, MAX_NOTE)
  const clientRequestId = optionalString(input.clientRequestId, 64)

  const plan = planPayment({
    kind: 'CREDIT_MEMO',
    partyId: customerId,
    amountCents,
    applications: [],
    creditApplications: [],
    documents: [],
    credits: [],
  })
  if (!plan.ok) throw new Error(plan.errors.join('; '))
  if (!note) throw new Error('A credit memo needs a note saying what it is for')

  const id = paymentId('cm', customerId, clientRequestId)
  const existing = await alreadyPosted(id)
  if (existing) return readBack(id, [], true)

  const now = nowIso()
  const duplicate = await postOnce(
    AR_PAYMENT_TABLE_NAME,
    [
      putTx(AR_PAYMENT_TABLE_NAME, {
        id,
        __typename: 'ArPayment',
        customerId,
        kind: 'CREDIT_MEMO',
        receivedAt,
        reference,
        amountCents,
        appliedCents: 0,
        unappliedCents: amountCents,
        applications: [],
        creditApplications: [],
        note,
        createdBy: caller.email,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    'credit memo',
    id,
    clientRequestId != null,
  )
  if (!duplicate) await writeAudit('ArPayment', id, 'CREATE_CREDIT', caller, { customerId, amountCents, note })
  return readBack(id, [], duplicate)
}

export async function writeOffInvoice(input: Row, caller: Caller): Promise<PostedRow> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const amountCents = optionalInteger(input.amountCents, { min: 1, label: 'amountCents' }) ?? 0
  const reason = optionalString(input.reason, MAX_NOTE)
  if (!reason) throw new Error('A write-off needs a reason')
  const clientRequestId = optionalString(input.clientRequestId, 64)

  const row = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!row) throw new Error(`Invoice not found: ${invoiceId}`)
  const invoice = planInvoiceOf(row)

  // The duplicate check comes BEFORE the plan: a retry of a write-off that already
  // posted would otherwise be refused as "already settled" — the plan is right about
  // the invoice and wrong about the request, and the user would see an error for a
  // write-off that went through.
  const id = paymentId('wo', invoice.partyId, clientRequestId)
  const existing = await alreadyPosted(id)
  if (existing) return readBack(id, [invoiceId], true)

  const plan = writeOffPlan(invoice, amountCents)
  if (!plan.ok) throw new Error(plan.errors.join('; '))

  const now = nowIso()
  const { writes, invoiceIds } = await ledgerWrites(plan, { [invoice.id]: invoice }, caller, now, 'APPLY')
  writes.unshift(
    putTx(AR_PAYMENT_TABLE_NAME, {
      id,
      __typename: 'ArPayment',
      customerId: invoice.partyId,
      kind: 'WRITE_OFF',
      receivedAt: now,
      amountCents,
      appliedCents: amountCents,
      unappliedCents: 0,
      applications: [{ invoiceId, amountCents }],
      creditApplications: [],
      invoiceId,
      note: reason,
      createdBy: caller.email,
      createdAt: now,
      updatedAt: now,
    }),
  )

  const duplicate = await postOnce(AR_PAYMENT_TABLE_NAME, writes, 'write-off', id, clientRequestId != null)
  if (!duplicate) await writeAudit('Invoice', invoiceId, 'WRITE_OFF', caller, { amountCents, reason })
  // Step I. A write-off lowers the basis: the commission on revenue we decided
  // not to collect is recomputed, or adjusted when it was already approved.
  await runCommissionsAfter(invoiceId, caller, 'WRITE_OFF')
  return readBack(id, invoiceIds, duplicate)
}

export async function reversePayment(input: Row, caller: Caller): Promise<PostedRow> {
  const paymentRowId = assertString(input.paymentId, 'paymentId')
  const reason = optionalString(input.reason, MAX_NOTE)
  if (!reason) throw new Error('A reversal needs a reason')

  const original = await getById(AR_PAYMENT_TABLE_NAME, paymentRowId)
  if (!original) throw new Error(`Payment not found: ${paymentRowId}`)

  const applications = (original.applications as PaymentApplication[] | undefined) ?? []
  const creditApplications = (original.creditApplications as CreditApplication[] | undefined) ?? []
  const { documents, credits, before } = await readPlanInputs(applications, creditApplications)

  const plan = reversalPlan(
    {
      id: String(original.id),
      partyId: String(original.customerId ?? ''),
      kind: (original.kind as ArPaymentKind) ?? 'PAYMENT',
      amountCents: numberOrNull(original.amountCents) ?? 0,
      appliedCents: numberOrNull(original.appliedCents) ?? 0,
      unappliedCents: numberOrNull(original.unappliedCents) ?? 0,
      applications: planApplicationsOf(applications),
      creditApplications,
      reversedByPaymentId: typeof original.reversedByPaymentId === 'string' ? original.reversedByPaymentId : null,
    },
    documents,
    credits,
  )
  if (!plan.ok) throw new Error(plan.errors.join('; '))

  const id = `rev-${randomUUID()}`
  const now = nowIso()
  const { writes, invoiceIds } = await ledgerWrites(plan, before, caller, now, 'REVERSE')
  writes.unshift(
    putTx(AR_PAYMENT_TABLE_NAME, {
      id,
      __typename: 'ArPayment',
      customerId: String(original.customerId ?? ''),
      kind: 'REVERSAL',
      receivedAt: now,
      amountCents: numberOrNull(original.amountCents) ?? 0,
      appliedCents: 0,
      unappliedCents: 0,
      applications: [],
      creditApplications: [],
      reversesPaymentId: paymentRowId,
      note: reason,
      createdBy: caller.email,
      createdAt: now,
      updatedAt: now,
    }),
  )
  // Stamping the original is what makes a second reversal impossible, and zeroing its
  // `unappliedCents` in the same statement is what stops a reversed credit memo — or
  // the credit left behind by a reversed overpayment — from being spent afterwards.
  // The condition pins the remainder to what the plan saw, so a payment spending that
  // credit concurrently loses to the reversal rather than committing beside it.
  const unappliedNow = numberOrNull(original.unappliedCents) ?? 0
  writes.push(
    updateTx(
      AR_PAYMENT_TABLE_NAME,
      paymentRowId,
      { reversedByPaymentId: id, unappliedCents: 0, updatedAt: now, updatedBy: caller.email },
      {
        condition: `${unsetCondition('reversedByPaymentId')} AND unappliedCents = :unappliedNow`,
        extraValues: { ':unappliedNow': { N: String(unappliedNow) }, ':nullType': NULL_TYPE_VALUE },
      },
    ),
  )

  await transact(writes, 'reversal')
  await writeAudit('ArPayment', paymentRowId, 'REVERSE_PAYMENT', caller, { reversalId: id, reason })
  return readBack(id, invoiceIds, false)
}

export { invoiceStatusAfter, assertEnum }
