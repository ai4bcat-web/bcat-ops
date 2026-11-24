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
import { assertBillsPayable } from './paymentInfoGate'
import { autoApproveBill } from './bills'
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
  renderRemittanceTableEmail,
} from '../../../src/lib/shipmentNotices'
import { buildRemittancePdf, remittanceData, remittanceFilename } from '../../../src/lib/remittancePdf'
import { normalizeCcList, remittanceCcFor } from '../../../src/lib/remittanceCc'
import {
  effectivePayeeEmail,
  payeeEmailFor,
  factorKeyOf,
  isRemitEmail,
  parseFactorRemitMap,
  paysThroughFactor,
  type FactorRemitMap,
} from '../../../src/lib/factorRemit'
import { marshallRow } from '../_shared/shipmentStore'
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
  SETTINGS_ID,
  SETTINGS_TABLE_NAME,
  SHIPMENT_NOTICE_TABLE_NAME,
  assignmentOwnedBy,
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

const METHODS: readonly ApPaymentMethod[] = ['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT', 'CARD', 'OTHER']
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
          invoiceId: planned.id,
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
          // The assignment is only moved if it still belongs to this bill (or to none yet, as
          // on Aljex carry-over bills): a void and re-record between the read and the write
          // must not repaint the new one.
          ...assignmentOwnedBy(planned.id),
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

const HISTORICAL_NOTE = 'Historical payment recorded outside the app, no remittance sent'

/**
 * A payment that already went out of the bank outside the app (Ryne 2026-11-19) is recorded without telling the
 * carrier again; the note on the row says so. Only a literal `true` suppresses: anything else still e-mails.
 */
export function remittanceOptions(flag: unknown, typedNote: string | null | undefined): { suppressRemittance: boolean; note: string | null | undefined } {
  const suppressRemittance = flag === true
  if (!suppressRemittance) return { suppressRemittance, note: typedNote }
  return { suppressRemittance, note: [HISTORICAL_NOTE, typedNote].filter(Boolean).join(' — ').slice(0, MAX_NOTE) }
}

export async function recordApPayment(input: Row, caller: Caller): Promise<PostedRow> {
  const carrierId = assertString(input.carrierId, 'carrierId')
  const paidAt = paidAtOf(input.paidAt)
  const method = optionalEnum(input.method, METHODS, 'method') ?? 'OTHER'
  const reference = optionalString(input.reference, 120)
  const amountCents = optionalInteger(input.amountCents, { min: 0, label: 'amountCents' }) ?? 0
  const applications = assertApplications(input.applications, 'applications')
  const creditApplications = assertCreditApplications(input.creditApplications, 'creditApplications')
  const { suppressRemittance, note } = remittanceOptions(input.suppressRemittance, optionalString(input.note, MAX_NOTE))
  const clientRequestId = optionalString(input.clientRequestId, 64)
  // A payment posted as one leg of a pay-to group does not e-mail on its own: the group sends one remittance for all of them.
  const deferRemittance = input.deferRemittance === true

  const id = paymentId('app', carrierId, clientRequestId)
  const existing = await getById(AP_PAYMENT_TABLE_NAME, id)
  if (existing) {
    const ids = (existing.applications as ApPaymentApplication[] | undefined)?.map((a) => a.billId) ?? []
    return readBack(id, ids, true)
  }

  // There is no review step (Ryne 2026-11-19): a dated bill still stored as IN_REVIEW is approved here before it is paid.
  for (const application of applications) await autoApproveBill(application.billId, caller)

  // Nobody pays a payee that has no bank info (Ryne 2026-11-19). A credit-only application moves no money, so it
  // is not held to this; a replay of an already-posted payment returned above.
  if (amountCents > 0) {
    await assertBillsPayable(applications.filter((application) => application.amountCents > 0).map((application) => application.billId))
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
      ...(suppressRemittance ? { remittanceSuppressed: true } : {}),
      ...(deferRemittance ? { remittanceDeferredToGroup: true } : {}),
    })
    // The advice is rendered after the money is recorded, never before: a renderer
    // that throws must not stop a payment that has already gone out of the bank.
    await storeRemittance(id, caller)
    // Then the carrier is told, once. A failure here never touches the payment (see autoSendRemittance).
    // A historical payment recorded with `suppressRemittance` tells nobody.
    if (!suppressRemittance && !deferRemittance) await autoSendRemittance(id, caller)
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
  /** Each factoring company's one remittance address (`TmsSettings.factorRemitEmails`). */
  factorEmails: FactorRemitMap
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
  const factorEmails = parseFactorRemitMap((await getSettings()).factorRemitEmails)

  return {
    payment,
    bills,
    carrier: (carrierRow as unknown as CarrierRecord) ?? null,
    methods: methodRows as unknown as CarrierPaymentMethodRecord[],
    contacts: contactRows as unknown as CarrierContactRecord[],
    division,
    factorEmails,
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

/**
 * The payee's remit address, the way the Remit to column reads it. A carrier paid through a factor goes to
 * the factor's one address; otherwise the address snapshotted on the bill, then the payment method the bill
 * names, then the carrier's preferred (or any) active method, and only then the carrier's accounting
 * contacts and own address.
 */
export function remitRecipientsFor(context: {
  payment: Row
  bills: CarrierBillRecord[]
  carrier: CarrierRecord | null
  contacts: CarrierContactRecord[]
  methods: CarrierPaymentMethodRecord[]
  factorEmails?: FactorRemitMap
}): string[] {
  const named = context.methods.find((row) => row.id === context.bills[0]?.paymentMethodId)
  const active = context.methods.filter((row) => row.status !== 'INACTIVE')
  const method = named ?? active.find((row) => row.isPreferred) ?? active[0] ?? null
  // The address belongs to the PAY TO: the one filed for that name wins, for a factor and for a direct payee alike.
  const filed = payeeEmailFor(context.factorEmails, payToNameOfContext(context, method))
  if (filed.includes('@')) return [filed]
  if (paysThroughFactor(method)) {
    const shared = effectivePayeeEmail(method, context.factorEmails)
    if (shared.includes('@')) return [shared]
  }
  const snapshot = [
    (context.payment.remitTo as { payeeEmail?: string | null } | null | undefined)?.payeeEmail,
    ...context.bills.map((bill) => bill.remitTo?.payeeEmail),
  ].map((email) => (email ?? '').trim()).find((email) => email.includes('@'))
  if (snapshot) return [snapshot]
  return remittanceRecipients(context.carrier, context.contacts, method)
}

/**
 * The name the payment is paid to, the way the Pay to column reads it: the factor for a carrier paid through
 * one (the method's, else the one frozen on the bill), otherwise the payee frozen on the bill, else the carrier.
 */
export function payToNameOfContext(
  context: { payment: Row; bills: CarrierBillRecord[]; carrier: CarrierRecord | null },
  method: CarrierPaymentMethodRecord | null,
): string {
  if (paysThroughFactor(method)) return String(method?.factorName ?? '').trim()
  const lead = context.bills[0]
  if (lead?.payeeKind === 'FACTOR') return (lead.remitTo?.factorName ?? lead.remitTo?.name ?? '').trim()
  const frozen = (context.payment.remitTo as { name?: string | null; factorName?: string | null } | null | undefined)
  return (lead?.remitTo?.name ?? frozen?.factorName ?? frozen?.name ?? lead?.carrierName ?? context.carrier?.name ?? '').trim()
}

export type AutoRemittanceDecision =
  | { action: 'SEND'; to: string[] }
  | { action: 'SKIP'; reason: 'NOT_A_PAYMENT' | 'REVERSED' | 'NO_BILLS' | 'ALREADY_HANDLED' | 'NO_REMIT_EMAIL' | 'TURNED_OFF' }

/**
 * Whether a payment that was just recorded sends its own remittance. Only a fresh PAYMENT does, once: any
 * earlier attempt, hand-marked send or sent stamp means a person or an earlier run already dealt with it.
 */
export function autoRemittanceDecision(
  context: Parameters<typeof remitRecipientsFor>[0],
  env: string | undefined = process.env.AP_AUTO_REMITTANCE,
): AutoRemittanceDecision {
  const payment = context.payment
  if (String(env ?? '').toLowerCase() === 'off') return { action: 'SKIP', reason: 'TURNED_OFF' }
  if (payment.kind !== 'PAYMENT') return { action: 'SKIP', reason: 'NOT_A_PAYMENT' }
  if (typeof payment.reversedByPaymentId === 'string' && payment.reversedByPaymentId) return { action: 'SKIP', reason: 'REVERSED' }
  if (context.bills.length === 0) return { action: 'SKIP', reason: 'NO_BILLS' }
  if ((numberOrNull(payment.remittanceAttempts) ?? 0) > 0 || payment.remittanceSentAt || payment.markedSentAt) {
    return { action: 'SKIP', reason: 'ALREADY_HANDLED' }
  }
  const to = remitRecipientsFor(context)
  return to.length === 0 ? { action: 'SKIP', reason: 'NO_REMIT_EMAIL' } : { action: 'SEND', to }
}

/**
 * Runs right after a payment posts. It never throws: the money is already out, so a payee with no address,
 * a refused send or a bug here is logged and left for the Paid view to show, and the manual Send remittance
 * button still works.
 */
async function autoSendRemittance(paymentRowId: string, caller: Caller): Promise<void> {
  try {
    const context = await readRemittanceContext(paymentRowId)
    const decision = autoRemittanceDecision(context)
    if (decision.action === 'SKIP') {
      if (decision.reason === 'NO_REMIT_EMAIL') {
        await writeAudit('ApPayment', paymentRowId, 'AUTO_REMITTANCE_SKIPPED', caller, { reason: decision.reason })
      }
      return
    }
    await sendRemittance({ paymentId: paymentRowId, layout: 'TABLE', to: decision.to }, caller)
  } catch (err) {
    console.error('[tms-finance-actions] automatic remittance failed', paymentRowId, String(err))
  }
}

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/**
 * Save the address a payee's remittance goes to, from the Remit to column. It is filed under the PAY TO name
 * (`TmsSettings.factorRemitEmails`, which holds every payee, not only factors), so each carrier paid to that
 * name uses it; a direct payee's own payment method keeps a matching copy for the carrier profile.
 * A carrier with no payment info at all is sent to the profile instead: inventing a method here would
 * invent a way to pay them.
 */
export async function setPayeeRemitEmail(input: Row, caller: Caller): Promise<Row> {
  const email = assertString(input.email, 'email').trim()
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) throw new Error('Enter one valid e-mail address')

  // A bill names the exact method it is paid under; a carrier row (Aging by carrier) takes the preferred one.
  const billId = optionalString(input.billId, 128)
  const bill = billId ? await getById(CARRIER_BILL_TABLE_NAME, billId) : null
  if (billId && !bill) throw new Error(`Bill not found: ${billId}`)
  const carrierId = bill ? String(bill.carrierId ?? '') : assertString(input.carrierId, 'carrierId')
  const methods = (await queryIndex(
    CARRIER_PAYMENT_METHOD_TABLE_NAME,
    IDX_PAYMENT_METHODS_BY_CARRIER,
    'carrierId',
    carrierId,
  )) as unknown as CarrierPaymentMethodRecord[]
  const active = methods.filter((row) => row.status !== 'INACTIVE')
  const method =
    methods.find((row) => row.id === bill?.paymentMethodId) ??
    active.find((row) => row.isPreferred) ??
    active[0] ??
    null
  if (!method) {
    throw new Error('This carrier has no payment info on file. Add it on the carrier profile, then the remit e-mail can be saved there.')
  }

  // The address belongs to the PAY TO, so it is filed once under that name: the factor for a carrier paid
  // through one (every carrier it funds and the automatic remittance read it), otherwise the payee itself.
  if (paysThroughFactor(method)) {
    const saved = await writeFactorRemitEmail(String(method.factorName), email, caller)
    return { paymentMethodId: method.id, carrierId, email: saved.email, factorName: saved.name, payeeName: saved.name }
  }
  const carrierRow = await getById(CARRIER_TABLE_NAME, carrierId)
  const payTo = (bill?.payeeKind === 'FACTOR' ? '' : (bill?.remitTo as { name?: string | null } | null | undefined)?.name)
    || String(bill?.carrierName ?? '') || String(carrierRow?.name ?? '')
  const saved = await writeFactorRemitEmail(payTo.trim(), email, caller)

  // The carrier's own copy follows, so the carrier profile shows the same address as the Remit to column.
  const now = nowIso()
  await transact(
    [updateTx(CARRIER_PAYMENT_METHOD_TABLE_NAME, method.id, { payeeEmail: email, updatedAt: now, updatedBy: caller.email })],
    'remit e-mail',
  )
  await writeAudit('CARRIER_PAYMENT_METHOD', method.id, 'SET_REMIT_EMAIL', caller, {
    carrierId,
    billId,
    payTo: saved.name,
    previous: method.payeeEmail ?? null,
    email,
  })
  return { paymentMethodId: method.id, carrierId, email, payeeName: saved.name }
}

/**
 * Set (or clear, with an empty address) the one remittance e-mail a PAY TO is paid at: a factoring company or a
 * direct payee. It is kept on the settings row, keyed by the normalized pay-to name, and read in front of every
 * carrier's own copy.
 * Written against the map as it was read, so two people saving different factors at once cannot lose one.
 */
async function writeFactorRemitEmail(
  factorName: string,
  email: string,
  caller: Caller,
): Promise<{ key: string; name: string; email: string }> {
  const key = factorKeyOf(factorName)
  if (!key) throw new Error('Name who is paid')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const settings = await getSettings()
    const current = parseFactorRemitMap(settings.factorRemitEmails)
    const previous = current[key] ?? null
    const next: FactorRemitMap = { ...current }
    if (email) {
      next[key] = { name: previous?.name ?? factorName.trim(), email, updatedAt: nowIso(), updatedBy: caller.email }
    } else {
      delete next[key]
    }
    const hadMap = settings.factorRemitEmails != null
    try {
      await transact(
        [updateTx(
          SETTINGS_TABLE_NAME,
          SETTINGS_ID,
          { __typename: 'TmsSettings', factorRemitEmails: next },
          hadMap
            ? { condition: '#factorRemitEmails = :before', extraValues: { ':before': marshallRow({ before: settings.factorRemitEmails }).before } }
            : { condition: 'attribute_not_exists(#factorRemitEmails)' },
        )],
        'factor remit e-mail',
      )
    } catch (err) {
      if (attempt < 2 && /cancel|conditional/i.test(String(err))) continue
      throw err
    }
    await writeAudit('FACTOR_REMIT_EMAIL', key, 'SET_FACTOR_REMIT_EMAIL', caller, {
      factorName,
      previous: previous?.email ?? null,
      email: email || null,
    })
    return { key, name: previous?.name ?? factorName.trim(), email }
  }
  throw new Error('Could not save: the factor list changed while saving. Try again.')
}

/** Save a pay-to's remittance e-mail (a factoring company's, or a direct payee's) from the Remit e-mails list. An empty address clears it. */
export async function setFactorRemitEmail(input: Row, caller: Caller): Promise<Row> {
  const factorName = assertString(input.payeeName ?? input.factorName, 'payeeName').trim()
  const raw = typeof input.email === 'string' ? input.email.trim() : ''
  if (raw && !isRemitEmail(raw)) throw new Error('Enter one valid e-mail address')
  const saved = await writeFactorRemitEmail(factorName, raw, caller)
  return { factorKey: saved.key, factorName: saved.name, email: saved.email || null }
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
  const to = emailList(input.to, 'to').length > 0
    ? emailList(input.to, 'to')
    : remitRecipientsFor(context)
  // A manual send names its own copy list (the dialog pre-fills the standing one and may edit it);
  // the automatic send names none, so it gets the standing list: billing@bcatcorp.com unless an admin changed it.
  const cc = input.cc != null
    ? normalizeCcList(emailList(input.cc, 'cc')).filter((email) => !to.some((t) => t.trim().toLowerCase() === email))
    : remittanceCcFor(settings.remittanceCcEmails as string[] | null | undefined, to)
  const tableLayout = optionalString(input.layout, 16) === 'TABLE'
  if (to.length === 0 && !copyOnly) {
    throw new Error('Nobody is listed to receive this remittance; add an accounting contact or type an address')
  }

  const brokerName = context.division?.name ?? 'BCAT'
  const table = tableLayout
    ? renderRemittanceTableEmail({
        payment: context.payment as unknown as Parameters<typeof renderRemittanceTableEmail>[0]['payment'],
        bills: context.bills,
        brokerName,
        carrierName: context.carrier?.name ?? null,
      })
    : null
  const rendered = table ?? renderRemittanceEmail({
    payment: context.payment as unknown as Parameters<typeof renderRemittanceEmail>[0]['payment'],
    bills: context.bills,
    carrierName: context.carrier?.name ?? String(context.payment.carrierId ?? ''),
    brokerName,
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
    htmlBody: table && !message ? table.html : null,
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
            remittanceSentCc: cc.length > 0 ? cc.join(', ') : null,
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

// ── paying one pay-to across several carriers ───────────────────────────────

/** Who a carrier's bills are paid to, and where the advice goes: what two carriers must share to be paid together. */
export interface PayToIdentity {
  carrierId: string
  payTo: string
  /** Normalized pay-to name; a carrier with no name on file keys to itself so it never groups by accident. */
  key: string
  to: string[]
}

export function payToIdentityOf(context: Omit<Parameters<typeof remitRecipientsFor>[0], 'payment'> & { carrierId: string }): PayToIdentity {
  const active = context.methods.filter((row) => row.status !== 'INACTIVE')
  const named = context.methods.find((row) => row.id === context.bills[0]?.paymentMethodId)
  const method = named ?? active.find((row) => row.isPreferred) ?? active[0] ?? null
  const withPayment = { ...context, payment: {} as Row }
  const payTo = payToNameOfContext(withPayment, method)
  return {
    carrierId: context.carrierId,
    payTo,
    key: factorKeyOf(payTo) || `CARRIER:${context.carrierId}`,
    to: remitRecipientsFor(withPayment),
  }
}

const addressKey = (to: readonly string[]) => [...to].map((email) => email.trim().toLowerCase()).sort().join(',')

/**
 * Bills of different carriers are paid together only when the money goes to the same pay-to and the advice to the
 * same address. The Pay selected button reads the same rule (`selectionPayTo`), and the server never trusts it.
 */
export function assertSamePayTo(identities: readonly PayToIdentity[]): void {
  if (identities.length < 2) return
  const names = new Map<string, string>()
  for (const identity of identities) if (!names.has(identity.key)) names.set(identity.key, identity.payTo || 'no pay-to on file')
  if (names.size > 1) {
    throw new Error(`These bills are paid to different payees (${[...names.values()].join('; ')}); pay each payee separately`)
  }
  const addresses = new Set(identities.map((identity) => addressKey(identity.to)))
  if (addresses.size > 1) {
    throw new Error(`These carriers are paid to ${identities[0].payTo} but have different remittance e-mail addresses; set one address for that pay-to first`)
  }
}

/**
 * Pay the full balance of bills that may belong to several carriers, all paid to the same pay-to. Each carrier
 * still gets its own payment row (a payment is one carrier's), then ONE remittance e-mail goes to the pay-to
 * listing every bill. Retrying with the same `clientRequestId` finishes whatever a failed attempt left undone.
 */
export async function recordApPaymentGroup(input: Row, caller: Caller): Promise<Row> {
  const billIds = [...new Set(assertArrayOf<string>(input.billIds, 'billIds', (item, index) => assertString(item, `billIds[${index}]`), 100))]
  if (billIds.length === 0) throw new Error('Pick at least one bill to pay')
  const paidAt = paidAtOf(input.paidAt)
  const method = optionalEnum(input.method, METHODS, 'method') ?? 'OTHER'
  const reference = optionalString(input.reference, 120)
  const note = optionalString(input.note, MAX_NOTE)
  const clientRequestId = assertString(input.clientRequestId, 'clientRequestId')
  const suppressRemittance = input.suppressRemittance === true

  // A retry finds the payments an earlier attempt already posted and leaves their bills alone.
  const requestIdFor = (carrierId: string) => `${clientRequestId.slice(0, 20)}-${carrierId.slice(0, 40)}`
  const rows: Row[] = []
  for (const billId of billIds) {
    const row = await getById(CARRIER_BILL_TABLE_NAME, billId)
    if (!row) throw new Error(`Bill not found: ${billId}`)
    if (!String(row.carrierId ?? '')) throw new Error(`Bill ${billId} has no carrier`)
    rows.push(row)
  }
  const posted0 = new Set<string>()
  for (const carrierId of new Set(rows.map((row) => String(row.carrierId)))) {
    if (await getById(AP_PAYMENT_TABLE_NAME, paymentId('app', carrierId, requestIdFor(carrierId)))) posted0.add(carrierId)
  }

  const byCarrier = new Map<string, { billId: string; cents: number }[]>()
  const billRows: CarrierBillRecord[] = []
  for (const row of rows) {
    const billId = String(row.id)
    const carrierId = String(row.carrierId)
    const label = String(row.billNumber ?? billId)
    let cents = numberOrNull(row.balanceCents) ?? 0
    if (posted0.has(carrierId)) {
      const stored = await getById(AP_PAYMENT_TABLE_NAME, paymentId('app', carrierId, requestIdFor(carrierId)))
      cents = ((stored?.applications as ApPaymentApplication[] | undefined) ?? []).find((a) => a.billId === billId)?.amountCents ?? cents
    } else {
      const status = String(row.status ?? '')
      if (status !== 'TO_BE_PAID' && status !== 'PARTIAL' && status !== 'IN_REVIEW') throw new Error(`Bill ${label} is not open for payment`)
      if (cents <= 0) throw new Error(`Bill ${label} has nothing left to pay`)
    }
    byCarrier.set(carrierId, [...(byCarrier.get(carrierId) ?? []), { billId, cents }])
    billRows.push(row as unknown as CarrierBillRecord)
  }
  for (const [carrierId, list] of byCarrier) {
    if (list.length > 40) throw new Error(`Too many bills for one carrier (${carrierId}); pay at most 40 at a time`)
  }

  const factorEmails = parseFactorRemitMap((await getSettings()).factorRemitEmails)
  const identities: PayToIdentity[] = []
  for (const carrierId of byCarrier.keys()) {
    const [carrier, methods, contacts] = await Promise.all([
      getById(CARRIER_TABLE_NAME, carrierId),
      queryIndex(CARRIER_PAYMENT_METHOD_TABLE_NAME, IDX_PAYMENT_METHODS_BY_CARRIER, 'carrierId', carrierId),
      queryIndex(CARRIER_CONTACT_TABLE_NAME, IDX_CONTACTS_BY_CARRIER, 'carrierId', carrierId),
    ])
    identities.push(payToIdentityOf({
      carrierId,
      bills: billRows.filter((bill) => bill.carrierId === carrierId),
      carrier: carrier as unknown as CarrierRecord | null,
      methods: methods as unknown as CarrierPaymentMethodRecord[],
      contacts: contacts as unknown as CarrierContactRecord[],
      factorEmails,
    }))
  }
  assertSamePayTo(identities)
  // Every payee is checked before any money is recorded, so a group never half-posts for want of bank info.
  await assertBillsPayable(billIds)

  const posted: PostedRow[] = []
  for (const [carrierId, list] of byCarrier) {
    posted.push(await recordApPayment({
      carrierId,
      paidAt,
      method,
      reference,
      amountCents: list.reduce((sum, item) => sum + item.cents, 0),
      applications: list.map((item) => ({ billId: item.billId, amountCents: item.cents })),
      creditApplications: [],
      note,
      clientRequestId: requestIdFor(carrierId),
      suppressRemittance,
      deferRemittance: true,
    }, caller))
  }

  const paymentIds = posted.map((row) => String(row.payment.id))
  const remittance = suppressRemittance || posted.every((row) => row.duplicate)
    ? { status: 'SKIPPED' as const, to: [] as string[] }
    : await sendGroupedRemittance(paymentIds, identities[0].to, caller)
  return { payments: posted.map((row) => row.payment), bills: posted.flatMap((row) => row.bills), duplicate: posted.every((row) => row.duplicate), remittance }
}

/**
 * The one e-mail for a pay-to group: every bill of every payment in a single table, the advice PDFs attached.
 * Never throws (the money is already out): a refused send is logged and left on each payment as an attempt.
 */
async function sendGroupedRemittance(paymentIds: string[], recipients: string[], caller: Caller): Promise<{ status: string; to: string[] }> {
  try {
    if (String(process.env.AP_AUTO_REMITTANCE ?? '').toLowerCase() === 'off') return { status: 'SKIPPED', to: [] }
    const contexts = await Promise.all(paymentIds.map((id) => readRemittanceContext(id)))
    const sendable = contexts.every((context) => (
      context.payment.kind === 'PAYMENT'
      && !context.payment.reversedByPaymentId
      && context.bills.length > 0
      && !((numberOrNull(context.payment.remittanceAttempts) ?? 0) > 0 || context.payment.remittanceSentAt || context.payment.markedSentAt)
    ))
    if (!sendable) return { status: 'SKIPPED', to: [] }
    if (recipients.length === 0) {
      for (const id of paymentIds) await writeAudit('ApPayment', id, 'AUTO_REMITTANCE_SKIPPED', caller, { reason: 'NO_REMIT_EMAIL', grouped: true })
      return { status: 'SKIPPED', to: [] }
    }

    const settings = await getSettings()
    const to = recipients
    const cc = remittanceCcFor(settings.remittanceCcEmails as string[] | null | undefined, to)
    const first = contexts[0]
    const bills = contexts.flatMap((context) => context.bills)
    const applications = contexts.flatMap((context) => (context.payment.applications as ApPaymentApplication[] | undefined) ?? [])
    const reference = String(first.payment.reference ?? first.payment.id)
    const brokerName = first.division?.name ?? 'BCAT'
    const table = renderRemittanceTableEmail({
      payment: {
        id: String(first.payment.id),
        reference: String(first.payment.reference ?? '') || null,
        paidAt: String(first.payment.paidAt ?? ''),
        amountCents: contexts.reduce((sum, context) => sum + (numberOrNull(context.payment.amountCents) ?? 0), 0),
        applications,
        remitTo: null,
      } as unknown as Parameters<typeof renderRemittanceTableEmail>[0]['payment'],
      bills,
      brokerName,
      carrierName: null,
    })

    const attachments: { filename: string; bytes: Uint8Array; contentType: string }[] = []
    for (const [index, context] of contexts.entries()) {
      const key = typeof context.payment.pdfKey === 'string' ? context.payment.pdfKey : null
      if (!key) continue
      const name = contexts.length > 1 ? `${reference}-${index + 1}` : reference
      attachments.push({
        filename: remittanceFilename(name, numberOrNull(context.payment.pdfVersion) ?? 1),
        bytes: (await s3Bytes(key)).bytes,
        contentType: 'application/pdf',
      })
    }

    const attempt = Math.max(...contexts.map((context) => numberOrNull(context.payment.remittanceAttempts) ?? 0)) + 1
    const noticeId = `remit:${paymentIds[0]}:${attempt}`
    const delivered = await deliverNotice({
      db: dynamo,
      ses,
      tableName: SHIPMENT_NOTICE_TABLE_NAME,
      from: FROM_ADDRESS,
      attachments,
      htmlBody: table.html,
      draft: {
        id: noticeId,
        shipmentId: bills[0].shipmentId,
        loadId: bills[0].loadId,
        loadCarrierId: bills[0].loadCarrierId,
        kind: 'REMITTANCE',
        channel: 'EMAIL',
        to,
        cc,
        subject: table.subject,
        body: table.body,
        attachments: attachments.map((a) => ({ documentId: a.filename, name: a.filename, sizeBytes: a.bytes.byteLength })),
        createdBy: caller.email,
      },
    })

    const now = nowIso()
    await transact(
      contexts.map((context) => updateTx(AP_PAYMENT_TABLE_NAME, String(context.payment.id), {
        remittanceAttempts: attempt,
        ...(delivered.status === 'SENT'
          ? {
              remittanceSentAt: now,
              remittanceSentTo: to.join(', '),
              remittanceSentCc: cc.length > 0 ? cc.join(', ') : null,
              remittanceCount: (numberOrNull(context.payment.remittanceCount) ?? 0) + 1,
              lastNoticeId: noticeId,
            }
          : {}),
        updatedAt: now,
        updatedBy: caller.email,
      })),
      'grouped remittance send',
    )
    for (const id of paymentIds) await writeAudit('ApPayment', id, 'SEND_REMITTANCE', caller, { to, cc, status: delivered.status, grouped: true, paymentIds })
    return { status: delivered.status, to }
  } catch (err) {
    console.error('[tms-finance-actions] grouped remittance failed', paymentIds.join(','), String(err))
    return { status: 'FAILED', to: [] }
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
