/**
 * The AP ledger: pay a carrier, hold a credit against one, reverse a mistake, and
 * send the remittance advice that says what the money was for.
 *
 * Three rules make this different from the AR side, and they live here rather than
 * in the shared planner:
 *
 *  1. **A payment must be fully allocated.** We do not send money we cannot say the
 *     purpose of, so `unappliedCents > 0` is refused on a PAYMENT. Only a CREDIT_MEMO
 *     carries money that is not yet against anything.
 *  2. **A bill is settled for its `netCents`** — gross less the quick-pay fee that was
 *     applied once, at RECORD_BILL. Neither the planner nor the dialog ever touches
 *     the fee again.
 *  3. **The payee is the carrier; the factor is only where the cheque goes.** One
 *     payment per carrier, whatever its remit-to says.
 *
 * Every write that depends on what it read carries the condition that closes the
 * race: a bill moves only if its `paidCents`/`creditedCents` are still what the plan
 * saw and it has not been voided underneath us, an assignment moves only if it still
 * owns the bill, a credit is spent with a conditional ADD, and a reversal zeroes the
 * credit it takes back under its own CAS.
 */
import { randomUUID } from 'crypto'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  assertArrayOf,
  assertRecord,
  assertString,
  optionalEnum,
  optionalInteger,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import { deliverNotice } from '../_shared/shipmentNotices'
import { apFundingSplit, billStatusAfter } from '../../../src/lib/carrierBill'
import {
  planPayment,
  reversalPlan,
  type PlanApplication,
  type PlanCredit,
  type PlanDocument,
  type PaymentPlan,
} from '../../../src/lib/paymentApply'
import {
  DEFAULT_REMITTANCE_EMAIL_TEMPLATE,
  remittanceRecipients,
  renderRemittanceEmail,
} from '../../../src/lib/shipmentNotices'
import { buildRemittancePdf, remittanceData, remittanceFilename } from '../../../src/lib/remittancePdf'
import type {
  ApPaymentApplication,
  ApPaymentKind,
  ApPaymentMethod,
  CarrierBillRecord,
  CarrierContactRecord,
  CarrierPaymentMethodRecord,
  CarrierRecord,
  CreditApplication,
  Division,
} from '../../../src/types/tms'
import {
  AP_PAYMENT_TABLE_NAME,
  CARRIER_BILL_TABLE_NAME,
  CARRIER_CONTACT_TABLE_NAME,
  CARRIER_PAYMENT_METHOD_TABLE_NAME,
  CARRIER_TABLE_NAME,
  FROM_ADDRESS,
  IDX_CONTACTS_BY_CARRIER,
  IDX_PAYMENT_METHODS_BY_CARRIER,
  LOAD_CARRIER_TABLE_NAME,
  NULL_TYPE_VALUE,
  SHIPMENT_NOTICE_TABLE_NAME,
  dynamo,
  getById,
  getDivision,
  getSettings,
  nowIso,
  numberOrNull,
  paymentId,
  postOnce,
  putPdf,
  putTx,
  queryIndex,
  remittancePdfKey,
  s3Bytes,
  ses,
  signedDownload,
  spendCreditTx,
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'

const METHODS: readonly ApPaymentMethod[] = ['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT', 'OTHER']
const MAX_NOTE = 2000
/** The AP half of the planner speaks about bills and carriers, not invoices and customers. */
const AP_VOCABULARY = { party: 'carrier', document: 'bill' } as const

/** One AP row of the ledger, as the dialogs and the detail page read it back. */
interface PostedRow {
  payment: Row
  bills: Row[]
  duplicate: boolean
}

/**
 * The bill as the planner sees it: ONE settled column.
 *
 * AP keeps cash and credit apart on the row, but the planner only knows "how much of
 * this document is already settled" — and a reversal checks that the row it is taking
 * back is still there. Handing it the cash column alone made a credit-funded payment
 * impossible to reverse, which in an immutable ledger means impossible to correct.
 * The split is reapplied in `apLedgerWrites` from the numbers the bill actually
 * carries, which `BillBefore` keeps beside this.
 */
function planDocumentOf(row: Row): PlanDocument {
  return {
    id: String(row.id),
    partyId: String(row.carrierId ?? ''),
    // A bill is settled for its net — the quick-pay fee was already taken at Record.
    totalCents: numberOrNull(row.netCents) ?? 0,
    paidCents: (numberOrNull(row.paidCents) ?? 0) + (numberOrNull(row.creditedCents) ?? 0),
    offsetCents: 0,
    balanceCents: numberOrNull(row.balanceCents) ?? 0,
    voided: row.status === 'VOID',
    number: typeof row.billNumber === 'string' ? row.billNumber : String(row.id),
  }
}

/** What the bill carried when the plan was made — the two columns, and their sum. */
interface BillBefore {
  paidCents: number
  creditedCents: number
  settledCents: number
}

function billBeforeOf(row: Row): BillBefore {
  const paidCents = numberOrNull(row.paidCents) ?? 0
  const creditedCents = numberOrNull(row.creditedCents) ?? 0
  return { paidCents, creditedCents, settledCents: paidCents + creditedCents }
}

function planCreditOf(row: Row): PlanCredit {
  return {
    id: String(row.id),
    partyId: String(row.carrierId ?? ''),
    kind: (row.kind as PlanCredit['kind']) ?? 'PAYMENT',
    unappliedCents: numberOrNull(row.unappliedCents) ?? 0,
    reference: typeof row.reference === 'string' ? row.reference : null,
    reversed: typeof row.reversedByPaymentId === 'string' && row.reversedByPaymentId.length > 0,
  }
}

function assertApplications(value: unknown, label: string): ApPaymentApplication[] {
  if (value == null) return []
  return assertArrayOf<ApPaymentApplication>(value, label, (item, index) => {
    const row = assertRecord(item, `${label}[${index}]`)
    return {
      billId: assertString(row.billId, `${label}[${index}].billId`),
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
 * The day the money left, pinned to noon UTC.
 *
 * A payment typed as "the 31st" in Chicago must not land in the next month's book
 * because midnight UTC is six hours earlier.
 */
function paidAtOf(value: unknown, label = 'paidAt'): string {
  const raw = assertString(value, label)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T12:00:00.000Z`
  if (Number.isNaN(Date.parse(raw))) throw new Error(`${label} must be a date or an ISO timestamp`)
  return new Date(raw).toISOString()
}

function toPlanApplications(applications: ApPaymentApplication[]): PlanApplication[] {
  return applications.map((application) => ({
    documentId: application.billId,
    amountCents: application.amountCents,
  }))
}

async function readPlanInputs(
  applications: ApPaymentApplication[],
  creditApplications: CreditApplication[],
): Promise<{ documents: PlanDocument[]; credits: PlanCredit[]; before: Record<string, BillBefore> }> {
  const billRows = await Promise.all(
    applications.map((application) => getById(CARRIER_BILL_TABLE_NAME, application.billId)),
  )
  const creditRows = await Promise.all(
    creditApplications.map((use) => getById(AP_PAYMENT_TABLE_NAME, use.paymentId)),
  )
  const documents: PlanDocument[] = []
  const before: Record<string, BillBefore> = {}
  for (const row of billRows) {
    if (!row) continue
    const plan = planDocumentOf(row)
    documents.push(plan)
    before[plan.id] = billBeforeOf(row)
  }
  const credits = creditRows.filter((row): row is Row => row != null).map(planCreditOf)
  return { documents, credits, before }
}

/**
 * Everything a plan implies for the bills and their assignments, as transaction items.
 *
 * `creditSplit` says how much of each application came out of a credit rather than
 * out of the bank, so the bill can show the two apart and a reversal can give back
 * exactly what it took.
 */
async function apLedgerWrites(
  plan: PaymentPlan,
  before: Record<string, BillBefore>,
  creditSplit: Record<string, number>,
  caller: Caller,
  now: string,
  direction: 'APPLY' | 'REVERSE',
): Promise<{ writes: TransactWriteItem[]; billIds: string[] }> {
  const writes: TransactWriteItem[] = []
  const billIds: string[] = []

  for (const planned of plan.documents) {
    const prior = before[planned.id]
    const row = await getById(CARRIER_BILL_TABLE_NAME, planned.id)
    if (!row) throw new Error(`Bill ${planned.id} was not found`)
    const bill = row as unknown as CarrierBillRecord

    // The planner speaks one currency — how much of the bill is settled — because it
    // does not know AP holds cash and credit apart. Its delta is the whole movement;
    // the recorded split says how much of that came out of a credit, and that slice
    // lands in `creditedCents` instead. On a reversal both flip together, so the bill
    // returns to exactly the two numbers it left.
    const sign = direction === 'REVERSE' ? -1 : 1
    const movedCents = planned.paidCents - prior.settledCents
    const creditCents = (creditSplit[planned.id] ?? 0) * sign
    const paidCents = prior.paidCents + movedCents - creditCents
    const creditedCents = prior.creditedCents + creditCents
    const balanceCents = bill.netCents - paidCents - creditedCents
    // With the money gone the bill is owed again, so the status it falls back to is
    // the one its approval says it is — PAID is where it came FROM, not where a
    // reversal leaves it.
    const unpaidStatus = bill.approvedAt ? 'TO_BE_PAID' : 'IN_REVIEW'
    const status = billStatusAfter(bill.netCents, paidCents, creditedCents, unpaidStatus)
    const settled = balanceCents <= 0

    writes.push(
      updateTx(
        CARRIER_BILL_TABLE_NAME,
        planned.id,
        {
          paidCents,
          creditedCents,
          balanceCents,
          status,
          ...(settled ? { paidAt: now } : {}),
          ...(settled ? {} : { apOpen: 'OPEN' }),
          updatedAt: now,
          updatedBy: caller.email,
          version: (bill.version ?? 1) + 1,
        },
        {
          // `apOpen` must LEAVE the row, never become null: a NULL in an index key is
          // rejected outright (step C, BUILD_LOG 32d3eec).
          remove: settled ? ['apOpen'] : direction === 'REVERSE' ? ['paidAt'] : [],
          // A payment may only land on a bill that is still approved for payment: an
          // UNAPPROVE between the pre-flight read and this write moves none of the
          // money fields, so without this the cash would go out against a bill a
          // reviewer had just pulled back.
          condition:
            direction === 'APPLY'
              ? 'attribute_exists(id) AND paidCents = :priorPaid AND creditedCents = :priorCredited AND (#status = :toBePaid OR #status = :partial)'
              : 'attribute_exists(id) AND paidCents = :priorPaid AND creditedCents = :priorCredited AND #status <> :void',
          extraValues: {
            ':priorPaid': { N: String(prior.paidCents) },
            ':priorCredited': { N: String(prior.creditedCents) },
            ...(direction === 'APPLY'
              ? { ':toBePaid': { S: 'TO_BE_PAID' }, ':partial': { S: 'PARTIAL' } }
              : { ':void': { S: 'VOID' } }),
          },
        },
      ),
    )

    writes.push(
      updateTx(
        LOAD_CARRIER_TABLE_NAME,
        bill.loadCarrierId,
        {
          apStatus: settled ? 'PAID' : 'TO_BE_PAID',
          apBalanceCents: balanceCents,
          apStatusChangedAt: now,
          ...(settled ? { apPaidAt: now } : { apOpen: 'OPEN' }),
          updatedAt: now,
          updatedBy: caller.email,
        },
        {
          // `apOpen` must LEAVE the row on PAID and come back when a reversal reopens
          // it; it is never written as null, which an index key refuses outright.
          remove: settled ? ['apOpen'] : direction === 'REVERSE' ? ['apPaidAt'] : [],
          // The assignment is only moved if it still belongs to this bill: a void and
          // re-record between the read and the write must not repaint the new one.
          condition: 'invoiceId = :billId',
          extraValues: { ':billId': { S: planned.id } },
        },
      ),
    )
    billIds.push(planned.id)
  }

  for (const credit of plan.credits) {
    writes.push(spendCreditTx(AP_PAYMENT_TABLE_NAME, credit.id, credit.usedCents, now, caller.email))
  }

  return { writes, billIds }
}

async function readBack(paymentRowId: string, billIds: string[], duplicate: boolean): Promise<PostedRow> {
  const [payment, ...bills] = await Promise.all([
    getById(AP_PAYMENT_TABLE_NAME, paymentRowId),
    ...billIds.map((id) => getById(CARRIER_BILL_TABLE_NAME, id)),
  ])
  return {
    payment: payment ?? {},
    bills: bills.filter((row): row is Row => row != null),
    duplicate,
  }
}

/** The remit-to that was in force when the payment went out, snapshotted onto the row. */
function remitToOf(bills: Row[]): Row | null {
  for (const bill of bills) {
    if (bill.remitTo && typeof bill.remitTo === 'object') return bill.remitTo as Row
  }
  return null
}

export async function recordApPayment(input: Row, caller: Caller): Promise<PostedRow> {
  const carrierId = assertString(input.carrierId, 'carrierId')
  const paidAt = paidAtOf(input.paidAt)
  const method = optionalEnum(input.method, METHODS, 'method') ?? 'OTHER'
  const reference = optionalString(input.reference, 120)
  const amountCents = optionalInteger(input.amountCents, { min: 0, label: 'amountCents' }) ?? 0
  const applications = assertApplications(input.applications, 'applications')
  const creditApplications = assertCreditApplications(input.creditApplications, 'creditApplications')
  const note = optionalString(input.note, MAX_NOTE)
  const clientRequestId = optionalString(input.clientRequestId, 64)

  const id = paymentId('app', carrierId, clientRequestId)
  const existing = await getById(AP_PAYMENT_TABLE_NAME, id)
  if (existing) {
    const ids = (existing.applications as ApPaymentApplication[] | undefined)?.map((a) => a.billId) ?? []
    return readBack(id, ids, true)
  }

  const { documents, credits, before } = await readPlanInputs(applications, creditApplications)
  const plan = planPayment({
    kind: 'PAYMENT',
    partyId: carrierId,
    amountCents,
    applications: toPlanApplications(applications),
    creditApplications,
    documents,
    credits,
    vocabulary: AP_VOCABULARY,
  })
  if (!plan.ok) throw new Error(plan.errors.join('; '))
  // Money that leaves the bank without a bill against it is money nobody can explain
  // later. An overpayment on the AP side is a credit we have to chase, not a record.
  if (plan.unappliedCents > 0) {
    throw new Error('An AP payment must be allocated in full; reduce the amount or add a bill')
  }
  for (const document of documents) {
    const row = await getById(CARRIER_BILL_TABLE_NAME, document.id)
    const status = String(row?.status ?? '')
    if (status !== 'TO_BE_PAID' && status !== 'PARTIAL') {
      throw new Error(`Bill ${document.number ?? document.id} has not been approved for payment`)
    }
  }

  const creditSplit = apFundingSplit(toPlanApplications(applications), plan.fromCreditsCents)
  const now = nowIso()
  const { writes, billIds } = await apLedgerWrites(plan, before, creditSplit, caller, now, 'APPLY')
  const billRows = await Promise.all(billIds.map((billId) => getById(CARRIER_BILL_TABLE_NAME, billId)))
  const stored: ApPaymentApplication[] = applications.map((application) => ({
    billId: application.billId,
    amountCents: application.amountCents,
    creditCents: creditSplit[application.billId] ?? 0,
  }))

  writes.unshift(
    putTx(AP_PAYMENT_TABLE_NAME, {
      id,
      __typename: 'ApPayment',
      carrierId,
      payeeKind: String(billRows.find((row) => row?.payeeKind)?.payeeKind ?? 'CARRIER'),
      kind: 'PAYMENT' satisfies ApPaymentKind,
      paidAt,
      method,
      reference,
      amountCents,
      appliedCents: plan.appliedCents,
      unappliedCents: plan.unappliedCents,
      applications: stored,
      creditApplications,
      remitTo: remitToOf(billRows.filter((row): row is Row => row != null)),
      remittanceCount: 0,
      note,
      createdBy: caller.email,
      createdAt: now,
      updatedAt: now,
    }),
  )

  const duplicate = await postOnce(AP_PAYMENT_TABLE_NAME, writes, 'ap payment', id, clientRequestId != null)
  if (!duplicate) {
    await writeAudit('ApPayment', id, 'RECORD_AP_PAYMENT', caller, {
      carrierId,
      amountCents,
      appliedCents: plan.appliedCents,
      applications: stored,
      creditApplications,
    })
    // The advice is rendered after the money is recorded, never before: a renderer
    // that throws must not stop a payment that has already gone out of the bank.
    await storeRemittance(id, caller)
  }
  return readBack(id, billIds, duplicate)
}

export async function createApCredit(input: Row, caller: Caller): Promise<PostedRow> {
  const carrierId = assertString(input.carrierId, 'carrierId')
  const paidAt = paidAtOf(input.memoDate ?? input.paidAt, 'memoDate')
  const reference = optionalString(input.reference, 120)
  const amountCents = optionalInteger(input.amountCents, { min: 1, label: 'amountCents' }) ?? 0
  const reason = optionalString(input.reason ?? input.note, MAX_NOTE)
  const loadCarrierId = optionalString(input.loadCarrierId, 64)
  const clientRequestId = optionalString(input.clientRequestId, 64)
  if (!reason) throw new Error('An AP credit needs a reason saying what it is for')

  const plan = planPayment({
    kind: 'CREDIT_MEMO',
    partyId: carrierId,
    amountCents,
    applications: [],
    creditApplications: [],
    documents: [],
    credits: [],
    vocabulary: AP_VOCABULARY,
  })
  if (!plan.ok) throw new Error(plan.errors.join('; '))

  const id = paymentId('apcm', carrierId, clientRequestId)
  const existing = await getById(AP_PAYMENT_TABLE_NAME, id)
  if (existing) return readBack(id, [], true)

  const now = nowIso()
  const duplicate = await postOnce(
    AP_PAYMENT_TABLE_NAME,
    [
      putTx(AP_PAYMENT_TABLE_NAME, {
        id,
        __typename: 'ApPayment',
        carrierId,
        kind: 'CREDIT_MEMO' satisfies ApPaymentKind,
        paidAt,
        reference,
        amountCents,
        appliedCents: 0,
        unappliedCents: amountCents,
        applications: [],
        creditApplications: [],
        loadCarrierId,
        note: reason,
        createdBy: caller.email,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    'ap credit',
    id,
    clientRequestId != null,
  )
  if (!duplicate) await writeAudit('ApPayment', id, 'CREATE_AP_CREDIT', caller, { carrierId, amountCents, reason })
  return readBack(id, [], duplicate)
}

export async function reverseApPayment(input: Row, caller: Caller): Promise<PostedRow> {
  const paymentRowId = assertString(input.paymentId, 'paymentId')
  const reason = optionalString(input.reason, MAX_NOTE)
  if (!reason) throw new Error('A reversal needs a reason')

  const original = await getById(AP_PAYMENT_TABLE_NAME, paymentRowId)
  if (!original) throw new Error(`Payment not found: ${paymentRowId}`)

  const applications = (original.applications as ApPaymentApplication[] | undefined) ?? []
  const creditApplications = (original.creditApplications as CreditApplication[] | undefined) ?? []
  const { documents, credits, before } = await readPlanInputs(applications, creditApplications)

  const plan = reversalPlan(
    {
      id: String(original.id),
      partyId: String(original.carrierId ?? ''),
      kind: (original.kind as PlanCredit['kind']) ?? 'PAYMENT',
      amountCents: numberOrNull(original.amountCents) ?? 0,
      appliedCents: numberOrNull(original.appliedCents) ?? 0,
      unappliedCents: numberOrNull(original.unappliedCents) ?? 0,
      applications: toPlanApplications(applications),
      creditApplications,
      reversedByPaymentId: typeof original.reversedByPaymentId === 'string' ? original.reversedByPaymentId : null,
    },
    documents,
    credits,
    AP_VOCABULARY,
  )
  if (!plan.ok) throw new Error(plan.errors.join('; '))

  // The split the payment recorded is what the reversal gives back — recomputing it
  // from today's credit balances would hand back a different shape of money.
  const creditSplit: Record<string, number> = {}
  for (const application of applications) creditSplit[application.billId] = application.creditCents ?? 0

  const id = `aprev-${randomUUID()}`
  const now = nowIso()
  const { writes, billIds } = await apLedgerWrites(plan, before, creditSplit, caller, now, 'REVERSE')
  writes.unshift(
    putTx(AP_PAYMENT_TABLE_NAME, {
      id,
      __typename: 'ApPayment',
      carrierId: String(original.carrierId ?? ''),
      kind: 'REVERSAL' satisfies ApPaymentKind,
      paidAt: now,
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
  // `unappliedCents` in the same statement stops a reversed credit from being spent
  // afterwards. The condition pins the remainder to what the plan saw.
  const unappliedNow = numberOrNull(original.unappliedCents) ?? 0
  writes.push(
    updateTx(
      AP_PAYMENT_TABLE_NAME,
      paymentRowId,
      { reversedByPaymentId: id, unappliedCents: 0, updatedAt: now, updatedBy: caller.email },
      {
        condition: `${unsetCondition('reversedByPaymentId')} AND unappliedCents = :unappliedNow`,
        extraValues: { ':unappliedNow': { N: String(unappliedNow) }, ':nullType': NULL_TYPE_VALUE },
      },
    ),
  )

  await transact(writes, 'ap reversal')
  await writeAudit('ApPayment', paymentRowId, 'REVERSE_AP_PAYMENT', caller, { reversalId: id, reason })
  return readBack(id, billIds, false)
}

// ── remittance ──────────────────────────────────────────────────────────────

interface RemittanceContext {
  payment: Row
  bills: CarrierBillRecord[]
  carrier: CarrierRecord | null
  methods: CarrierPaymentMethodRecord[]
  contacts: CarrierContactRecord[]
  division: Division | null
}

async function readRemittanceContext(paymentRowId: string): Promise<RemittanceContext> {
  const payment = await getById(AP_PAYMENT_TABLE_NAME, paymentRowId)
  if (!payment) throw new Error(`Payment not found: ${paymentRowId}`)
  const carrierId = String(payment.carrierId ?? '')
  const applications = (payment.applications as ApPaymentApplication[] | undefined) ?? []

  const [billRows, carrierRow, methodRows, contactRows] = await Promise.all([
    Promise.all(applications.map((application) => getById(CARRIER_BILL_TABLE_NAME, application.billId))),
    carrierId ? getById(CARRIER_TABLE_NAME, carrierId) : Promise.resolve(null),
    carrierId
      ? queryIndex(CARRIER_PAYMENT_METHOD_TABLE_NAME, IDX_PAYMENT_METHODS_BY_CARRIER, 'carrierId', carrierId)
      : Promise.resolve([] as Row[]),
    carrierId
      ? queryIndex(CARRIER_CONTACT_TABLE_NAME, IDX_CONTACTS_BY_CARRIER, 'carrierId', carrierId)
      : Promise.resolve([] as Row[]),
  ])
  const bills = billRows.filter((row): row is Row => row != null) as unknown as CarrierBillRecord[]
  const divisionKey = bills.find((bill) => bill.divisionKey)?.divisionKey ?? null
  const division = divisionKey ? ((await getDivision(divisionKey)) as unknown as Division) : null

  return {
    payment,
    bills,
    carrier: (carrierRow as unknown as CarrierRecord) ?? null,
    methods: methodRows as unknown as CarrierPaymentMethodRecord[],
    contacts: contactRows as unknown as CarrierContactRecord[],
    division,
  }
}

/** Render the advice and put the bytes. A failure leaves `pdfKey` null and says so. */
async function storeRemittance(paymentRowId: string, caller: Caller): Promise<Row | null> {
  try {
    const context = await readRemittanceContext(paymentRowId)
    const payment = context.payment as unknown as Parameters<typeof remittanceData>[0]['payment']
    const version = (numberOrNull(context.payment.pdfVersion) ?? 0) + 1
    const bytes = await buildRemittancePdf(
      remittanceData({
        payment,
        bills: context.bills,
        carrier: context.carrier,
        division: context.division,
      }),
    )
    const key = remittancePdfKey(String(context.payment.carrierId ?? ''), paymentRowId, version)
    await putPdf(key, bytes)
    const now = nowIso()
    await transact(
      [updateTx(AP_PAYMENT_TABLE_NAME, paymentRowId, {
        pdfKey: key,
        pdfVersion: version,
        updatedAt: now,
        updatedBy: caller.email,
      })],
      'remittance pdf',
    )
    return { pdfKey: key, pdfVersion: version }
  } catch (err) {
    console.error('[tms-finance-actions] remittance render failed', paymentRowId, String(err))
    return null
  }
}

export async function renderRemittancePdf(input: Row, caller: Caller): Promise<Row> {
  const paymentRowId = assertString(input.paymentId, 'paymentId')
  const stored = await storeRemittance(paymentRowId, caller)
  if (!stored) throw new Error('The remittance advice could not be rendered')
  return { payment: (await getById(AP_PAYMENT_TABLE_NAME, paymentRowId)) ?? {} }
}

function emailList(value: unknown, label: string): string[] {
  if (value == null) return []
  return assertArrayOf<string>(value, label, (item, index) => assertString(item, `${label}[${index}]`), 20)
}

export async function sendRemittance(input: Row, caller: Caller): Promise<Row> {
  const paymentRowId = assertString(input.paymentId, 'paymentId')
  const copyOnly = optionalString(input.via, 16) === 'COPY'
  const message = optionalString(input.message, MAX_NOTE)

  const context = await readRemittanceContext(paymentRowId)
  if (typeof context.payment.reversedByPaymentId === 'string' && context.payment.reversedByPaymentId) {
    throw new Error('That payment has been reversed; it has no remittance to send')
  }
  if (context.bills.length === 0) throw new Error('That payment has no bills to advise on')

  const settings = await getSettings()
  const method = context.methods.find((row) => row.id === context.bills[0]?.paymentMethodId) ?? null
  const to = emailList(input.to, 'to').length > 0
    ? emailList(input.to, 'to')
    : remittanceRecipients(context.carrier, context.contacts, method)
  const cc = emailList(input.cc, 'cc')
  if (to.length === 0 && !copyOnly) {
    throw new Error('Nobody is listed to receive this remittance; add an accounting contact or type an address')
  }

  const rendered = renderRemittanceEmail({
    payment: context.payment as unknown as Parameters<typeof renderRemittanceEmail>[0]['payment'],
    bills: context.bills,
    carrierName: context.carrier?.name ?? String(context.payment.carrierId ?? ''),
    brokerName: context.division?.name ?? 'BCAT',
    template: (settings.remittanceEmailTemplate as string | undefined) ?? DEFAULT_REMITTANCE_EMAIL_TEMPLATE,
  })
  const body = message ? `${message}\n\n${rendered.body}` : rendered.body

  const pdfKey = typeof context.payment.pdfKey === 'string' ? context.payment.pdfKey : null
  const reference = String(context.payment.reference ?? paymentRowId)
  const filename = remittanceFilename(reference, numberOrNull(context.payment.pdfVersion) ?? 1)
  const attachments = pdfKey
    ? [{ filename, bytes: (await s3Bytes(pdfKey)).bytes, contentType: 'application/pdf' }]
    : []

  // The notice id is deterministic, so it has to advance on every ATTEMPT. Numbering
  // it by the sends SES accepted would reuse `remit:<payment>:1` after a refused one
  // — and `claimNotice` would answer "already sent" to a send nobody ever made.
  const attempt = (numberOrNull(context.payment.remittanceAttempts) ?? 0) + 1
  const remittanceCount = (numberOrNull(context.payment.remittanceCount) ?? 0) + 1
  const noticeId = `remit:${paymentRowId}:${attempt}`
  const delivered = await deliverNotice({
    db: dynamo,
    ses,
    tableName: SHIPMENT_NOTICE_TABLE_NAME,
    from: FROM_ADDRESS,
    attachments,
    draft: {
      id: noticeId,
      // A carrier's e-mail history lives on the payment; the notice log is keyed by
      // shipment, so it is filed against the first bill's shipment and leg.
      shipmentId: context.bills[0].shipmentId,
      loadId: context.bills[0].loadId,
      loadCarrierId: context.bills[0].loadCarrierId,
      kind: 'REMITTANCE',
      channel: copyOnly ? 'COPY' : 'EMAIL',
      to,
      cc,
      subject: rendered.subject,
      body,
      attachments: attachments.map((a) => ({ documentId: a.filename, name: a.filename, sizeBytes: a.bytes.byteLength })),
      createdBy: caller.email,
    },
  })

  const now = nowIso()
  await transact(
    [updateTx(AP_PAYMENT_TABLE_NAME, paymentRowId, {
      remittanceAttempts: attempt,
      ...(delivered.status === 'SENT'
        ? {
            remittanceSentAt: now,
            remittanceSentTo: to.join(', '),
            remittanceCount,
            lastNoticeId: noticeId,
          }
        : {}),
      updatedAt: now,
      updatedBy: caller.email,
    })],
    'remittance send',
  )

  // SES is denied on dev and the carrier still needs their advice, so a refused send
  // hands back the exact bytes that would have gone out.
  const downloads = delivered.status === 'SENT' || !pdfKey
    ? []
    : [{ name: filename, url: await signedDownload(pdfKey) }]

  await writeAudit('ApPayment', paymentRowId, 'SEND_REMITTANCE', caller, { to, cc, status: delivered.status })
  return {
    payment: (await getById(AP_PAYMENT_TABLE_NAME, paymentRowId)) ?? {},
    notice: delivered.notice as unknown as Row,
    emailStatus: delivered.status,
    emailError: delivered.error,
    subject: rendered.subject,
    body,
    to,
    cc,
    downloads,
  }
}

export async function markRemittanceSent(input: Row, caller: Caller): Promise<Row> {
  const paymentRowId = assertString(input.paymentId, 'paymentId')
  const note = optionalString(input.note, MAX_NOTE)
  if (!note) throw new Error('Marking a remittance sent needs a note saying how it went out')

  const payment = await getById(AP_PAYMENT_TABLE_NAME, paymentRowId)
  if (!payment) throw new Error(`Payment not found: ${paymentRowId}`)

  const now = nowIso()
  // `remittanceSentAt` means SES accepted the message. Marking one sent by hand
  // records that a person sent it some other way — stamping the same field would
  // make the card claim an e-mail this system never sent.
  await transact(
    [updateTx(AP_PAYMENT_TABLE_NAME, paymentRowId, {
      markedSentAt: now,
      markedSentBy: caller.email,
      markedSentNote: note,
      updatedAt: now,
      updatedBy: caller.email,
    })],
    'remittance mark sent',
  )
  await writeAudit('ApPayment', paymentRowId, 'MARK_REMITTANCE_SENT', caller, { note })
  return { payment: (await getById(AP_PAYMENT_TABLE_NAME, paymentRowId)) ?? {} }
}
