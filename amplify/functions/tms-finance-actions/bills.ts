/**
 * Recording, approving and voiding a carrier's bill.
 *
 * The AP ladder lives on the assignment (`LoadCarrier.apStatus`) and every rung is
 * moved by exactly one action here, inside the transaction that writes the money
 * record it belongs to. AWAITING_INVOICE → IN_REVIEW happens only in RECORD_BILL,
 * in the same `TransactWriteItems` that puts the `CarrierBill` and stamps the
 * assignment's `chargesFinalizedAt`; IN_REVIEW → TO_BE_PAID only in APPROVE_BILL
 * (or in that same RECORD transaction when the caller asked for both at once);
 * TO_BE_PAID → PAID only in `apPayments.ts`. There is deliberately no SET_AP_STATUS:
 * a hand-set rung is a rung nothing is responsible for.
 *
 * A bill is a SNAPSHOT — lines, quick-pay fee, terms, payee and remit-to are taken
 * once, at Record, and nothing re-reads them. A mistake is voided and re-recorded.
 *
 * Own-fleet legs never reach any of this: they are paid through driver settlements,
 * and `billReadiness` refuses them by name.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  assertArrayOf,
  assertString,
  optionalBoolean,
  optionalInteger,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import {
  approvalReadiness,
  billDueDate,
  billLinesFor,
  billPayee,
  billReadiness,
  billTermsDays,
  billTotals,
} from '../../../src/lib/carrierBill'
import { evaluateDocGate } from '../../../src/lib/shipmentDocuments'
import type { DocGateResult } from '../../../src/types/tms'
import type {
  CarrierBillRecord,
  CarrierPaymentMethodRecord,
  CarrierRecord,
  Division,
  LoadCarrierRecord,
  LoadChargeRecord,
  ShipmentDocumentRecord,
  ShipmentLoad,
  ShipmentRecord,
  TmsSettings,
} from '../../../src/types/tms'
import {
  CARRIER_BILL_TABLE_NAME,
  CARRIER_PAYMENT_METHOD_TABLE_NAME,
  CARRIER_TABLE_NAME,
  IDX_BILLS_BY_CARRIER,
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_CHARGES_BY_SHIPMENT,
  IDX_DOCUMENTS_BY_SHIPMENT,
  IDX_LOADS_BY_SHIPMENT,
  IDX_PAYMENT_METHODS_BY_CARRIER,
  LOAD_CARRIER_TABLE_NAME,
  LOAD_CHARGE_TABLE_NAME,
  LOAD_TABLE_NAME,
  NULL_TYPE_VALUE,
  SETTINGS_ID,
  SETTINGS_TABLE_NAME,
  SHIPMENT_DOCUMENT_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  getById,
  getDivision,
  getSettings,
  nowIso,
  numberOrNull,
  putTx,
  queryIndex,
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { runCommissionsForOrder } from './commissions'

const MAX_NOTE = 2000

/** Every row one bill needs, read once. */
export interface AssignmentContext {
  loadCarrier: LoadCarrierRecord
  load: ShipmentLoad | null
  shipment: ShipmentRecord
  loadCarriers: LoadCarrierRecord[]
  charges: LoadChargeRecord[]
  documents: ShipmentDocumentRecord[]
  carrier: CarrierRecord | null
  methods: CarrierPaymentMethodRecord[]
  division: Division | null
  settings: TmsSettings
  existingBills: CarrierBillRecord[]
}

export async function readAssignmentContext(loadCarrierId: string): Promise<AssignmentContext> {
  const row = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!row) throw new Error(`Carrier assignment not found: ${loadCarrierId}`)
  const loadCarrier = row as unknown as LoadCarrierRecord

  const shipmentRow = await getById(SHIPMENT_TABLE_NAME, loadCarrier.shipmentId)
  if (!shipmentRow) throw new Error(`Shipment not found: ${loadCarrier.shipmentId}`)

  const [loadRows, carrierRows, chargeRows, documentRows, carrierRow, settings] = await Promise.all([
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', loadCarrier.shipmentId),
    queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', loadCarrier.shipmentId),
    queryIndex(LOAD_CHARGE_TABLE_NAME, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', loadCarrier.shipmentId),
    queryIndex(SHIPMENT_DOCUMENT_TABLE_NAME, IDX_DOCUMENTS_BY_SHIPMENT, 'shipmentId', loadCarrier.shipmentId),
    loadCarrier.carrierId ? getById(CARRIER_TABLE_NAME, loadCarrier.carrierId) : Promise.resolve(null),
    getSettings(),
  ])

  const loads = loadRows as unknown as ShipmentLoad[]
  const load = loads.find((item) => item.id === loadCarrier.loadId) ?? null
  const divisionKey = load?.divisionKey ?? loads.find((item) => item.divisionKey)?.divisionKey ?? null

  const [division, methodRows, billRows] = await Promise.all([
    divisionKey ? getDivision(divisionKey) : Promise.resolve(null),
    loadCarrier.carrierId
      ? queryIndex(CARRIER_PAYMENT_METHOD_TABLE_NAME, IDX_PAYMENT_METHODS_BY_CARRIER, 'carrierId', loadCarrier.carrierId)
      : Promise.resolve([] as Row[]),
    loadCarrier.carrierId
      ? queryIndex(CARRIER_BILL_TABLE_NAME, IDX_BILLS_BY_CARRIER, 'carrierId', loadCarrier.carrierId)
      : Promise.resolve([] as Row[]),
  ])

  const bills = (billRows as unknown as CarrierBillRecord[]).filter(
    (bill) => bill.loadCarrierId === loadCarrierId,
  )

  return {
    loadCarrier,
    load,
    shipment: shipmentRow as unknown as ShipmentRecord,
    loadCarriers: carrierRows as unknown as LoadCarrierRecord[],
    charges: chargeRows as unknown as LoadChargeRecord[],
    documents: documentRows as unknown as ShipmentDocumentRecord[],
    carrier: (carrierRow as unknown as CarrierRecord) ?? null,
    methods: methodRows as unknown as CarrierPaymentMethodRecord[],
    division: (division as unknown as Division) ?? null,
    settings: settings as unknown as TmsSettings,
    existingBills: bills,
  }
}

/**
 * The carrier-scope paperwork gate, evaluated LIVE rather than read off the cached
 * `LoadCarrier.docsMissing`.
 *
 * Step E only recaches the gate for ACTIVE rows (`documents.ts:245`), so a TONU'd
 * assignment's cache is stale forever — and a TONU'd assignment is exactly one we
 * still owe money on. The cache stays the board's colour; this is the decision.
 */
export function carrierGateFor(context: AssignmentContext): DocGateResult {
  return evaluateDocGate({
    scope: 'CARRIER',
    documents: context.documents,
    loadIds: context.loadCarrier.loadId ? [context.loadCarrier.loadId] : [],
    loadCarriers: context.loadCarriers,
    loadCarrierId: context.loadCarrier.id,
    settings: {
      ...context.settings,
      // The AP gate may demand more (or less) than the upload portal asks for.
      requiredCarrierUploadTypes:
        context.settings.apBillDocsRequired ?? context.settings.requiredCarrierUploadTypes,
    },
  })
}

/** The snapshot RECORD_BILL would write, without writing it. */
function buildSnapshot(
  context: AssignmentContext,
  args: {
    id: string
    billNumber: string | null
    billDate: string
    billedCents: number | null
    dueAt: string | null
    documentId: string | null
    note: string | null
  },
  caller: Caller,
  now: string,
): CarrierBillRecord {
  const { loadCarrier, load, carrier, settings } = context
  const { lines, grossCents } = billLinesFor(context.charges, loadCarrier.id)
  const payee = billPayee(carrier, context.methods)
  const { quickPayFeeCents, netCents } = billTotals({ grossCents, loadCarrier, payeeKind: payee.kind })
  const termsDays = billTermsDays(loadCarrier, carrier, settings)
  const dueAt = args.dueAt ?? billDueDate(args.billDate, termsDays)
  const billedCents = args.billedCents ?? grossCents

  return {
    id: args.id,
    loadCarrierId: loadCarrier.id,
    loadId: loadCarrier.loadId,
    shipmentId: loadCarrier.shipmentId,
    shipmentNumber: context.shipment.number ?? null,
    loadNumber: load?.loadNumber ?? null,
    carrierId: loadCarrier.carrierId ?? '',
    carrierName: loadCarrier.carrierName ?? carrier?.name ?? null,
    carrierMc: loadCarrier.carrierMc ?? carrier?.mcNumber ?? null,
    payeeKind: payee.kind,
    paymentMethodId: payee.paymentMethodId,
    remitTo: payee.remitTo,
    divisionKey: load?.divisionKey ?? null,
    status: 'IN_REVIEW',
    billNumber: args.billNumber,
    billDate: args.billDate,
    billMonth: args.billDate.slice(0, 7),
    recordedAt: now,
    recordedBy: caller.email,
    // Recorded before the truck delivered. Approval says so out loud rather than
    // silently paying for freight that has not landed.
    recordedEarly: load?.status !== 'DELIVERED' && loadCarrier.status !== 'TONU',
    dueAt,
    termsDays,
    quickPay: loadCarrier.quickPay ?? false,
    quickPayDays: loadCarrier.quickPayDays ?? null,
    quickPayFeeBps: loadCarrier.quickPayFeeBps ?? null,
    lines,
    grossCents,
    quickPayFeeCents,
    netCents,
    billedCents,
    varianceCents: billedCents - grossCents,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: netCents,
    apOpen: 'OPEN',
    documentId: args.documentId,
    approvalWarnings: [],
    note: args.note,
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
  }
}

/** `cb:<loadCarrierId>:<n>` — n counts the bills this assignment has already had. */
function billIdFor(loadCarrierId: string, priorBills: number): string {
  return `cb:${loadCarrierId}:${priorBills + 1}`
}

function dateOf(value: unknown, label: string, fallback: string): string {
  const raw = optionalString(value, 10)
  if (!raw) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${label} must be a date as YYYY-MM-DD`)
  return raw
}

export async function previewBill(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const context = await readAssignmentContext(loadCarrierId)
  const readiness = billReadiness({
    loadCarrier: context.loadCarrier,
    load: context.load,
    carrier: context.carrier,
    shipment: context.shipment,
    charges: context.charges,
    existingBills: context.existingBills,
  })
  const gate = carrierGateFor(context)
  const now = nowIso()
  const snapshot = buildSnapshot(
    context,
    {
      id: billIdFor(loadCarrierId, context.existingBills.length),
      billNumber: null,
      billDate: now.slice(0, 10),
      billedCents: null,
      dueAt: null,
      documentId: null,
      note: null,
    },
    caller,
    now,
  )
  return {
    readiness: readiness as unknown as Row,
    snapshot: snapshot as unknown as Row,
    payee: billPayee(context.carrier, context.methods) as unknown as Row,
    gate: gate as unknown as Row,
    // Only accepted carrier invoices can be linked, so only those are offered.
    documents: context.documents.filter(
      (doc) =>
        doc.type === 'CARRIER_INVOICE' &&
        doc.status === 'ACTIVE' &&
        doc.reviewStatus !== 'PENDING' &&
        doc.reviewStatus !== 'REJECTED',
    ) as unknown as Row[],
  }
}

/**
 * Record one bill.
 *
 * The transaction is the whole point: the `CarrierBill` row, the assignment's rung,
 * and `chargesFinalizedAt` — which is what stops the carrier-side charges moving
 * under a bill somebody is about to pay — either all land or none do. The condition
 * on the assignment closes the double-record race: `invoiceId` must still be unset,
 * and it is written as NULL by every booking path, so the test has to be
 * `unsetCondition`, not a bare `attribute_not_exists` (the Step F review's finding).
 */
export async function recordBill(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const now = nowIso()
  const billNumber = optionalString(input.billNumber, 64)
  const billDate = dateOf(input.billDate, 'billDate', now.slice(0, 10))
  const billedCents = optionalInteger(input.billedCents, { min: 0, label: 'billedCents' })
  const dueAtInput = optionalString(input.dueAt, 10)
  const documentId = optionalString(input.documentId, 64)
  const note = optionalString(input.note, MAX_NOTE)
  const approve = optionalBoolean(input.approve) ?? false
  const acknowledged = input.acknowledgeWarnings == null
    ? []
    : assertArrayOf<string>(input.acknowledgeWarnings, 'acknowledgeWarnings', (item, index) =>
        assertString(item, `acknowledgeWarnings[${index}]`), 20)

  const context = await readAssignmentContext(loadCarrierId)
  const readiness = billReadiness({
    loadCarrier: context.loadCarrier,
    load: context.load,
    carrier: context.carrier,
    shipment: context.shipment,
    charges: context.charges,
    existingBills: context.existingBills,
  })
  if (!readiness.ready) throw new Error(readiness.reasons.join(' '))

  if (documentId) {
    const doc = context.documents.find((row) => row.id === documentId)
    if (!doc) throw new Error('That document does not belong to this shipment')
    if (doc.type !== 'CARRIER_INVOICE') throw new Error(`${doc.name} is not a carrier invoice`)
    if (doc.status !== 'ACTIVE') throw new Error(`${doc.name} is void`)
    if (doc.reviewStatus === 'PENDING' || doc.reviewStatus === 'REJECTED') {
      throw new Error(`${doc.name} has not been accepted yet`)
    }
  }

  const id = billIdFor(loadCarrierId, context.existingBills.length)
  const bill = buildSnapshot(
    context,
    { id, billNumber, billDate, billedCents, dueAt: dueAtInput ?? null, documentId, note },
    caller,
    now,
  )
  if (bill.dueAt < bill.billDate) throw new Error('The due date cannot be before the bill date')

  const gate = carrierGateFor(context)

  if (approve) {
    // "Record and approve" is still an approval: the same capability, the same
    // acknowledgements. The router cannot gate it, because RECORD_BILL itself is
    // open to any AP user, so the second half of the press is checked here.
    if (!caller.isAdmin && context.settings.apApprovalAdminOnly !== false) {
      throw new Error('Forbidden: approving a bill requires owner or ADMIN')
    }
    const check = approvalReadiness({
      bill,
      loadCarrier: context.loadCarrier,
      load: context.load,
      carrier: context.carrier,
      gate,
      payee: { kind: bill.payeeKind, paymentMethodId: bill.paymentMethodId ?? null, remitTo: bill.remitTo ?? null },
      settings: context.settings,
      isAdmin: caller.isAdmin,
    })
    if (check.blocks.length > 0) throw new Error(check.blocks.join(' '))
    const unacknowledged = check.warnings.filter((warning) => !acknowledged.includes(warning.key))
    if (unacknowledged.length > 0) {
      throw new Error(
        `Acknowledge before approving: ${unacknowledged.map((w) => w.message).join(' ')} Record the bill and approve it from the bill itself.`,
      )
    }
    bill.status = 'TO_BE_PAID'
    bill.approvedAt = now
    bill.approvedBy = caller.email
    bill.approvalWarnings = check.warnings.map((warning) => warning.key)
  }

  const writes: TransactWriteItem[] = [
    putTx(CARRIER_BILL_TABLE_NAME, { ...(bill as unknown as Row), __typename: 'CarrierBill', createdAt: now, updatedAt: now }),
    updateTx(
      LOAD_CARRIER_TABLE_NAME,
      loadCarrierId,
      {
        apStatus: bill.status === 'TO_BE_PAID' ? 'TO_BE_PAID' : 'IN_REVIEW',
        invoiceId: id,
        chargesFinalizedAt: now,
        apStatusChangedAt: now,
        apOpen: 'OPEN',
        apBalanceCents: bill.netCents,
        updatedAt: now,
        updatedBy: caller.email,
      },
      {
        condition: `#kind = :carrier AND #apStatus = :awaiting AND ${unsetCondition('invoiceId')}`,
        extraValues: {
          ':carrier': { S: 'CARRIER' },
          ':awaiting': { S: 'AWAITING_INVOICE' },
          ':nullType': NULL_TYPE_VALUE,
        },
      },
    ),
  ]
  const update = writes[1].Update
  if (update?.ExpressionAttributeNames) {
    update.ExpressionAttributeNames['#kind'] = 'kind'
    update.ExpressionAttributeNames['#apStatus'] = 'apStatus'
  }

  await transact(writes, 'carrier bill')
  await writeAudit('CarrierBill', id, 'RECORD_BILL', caller, {
    loadCarrierId,
    carrierId: bill.carrierId,
    grossCents: bill.grossCents,
    netCents: bill.netCents,
    billedCents: bill.billedCents,
    approved: bill.status === 'TO_BE_PAID',
  })
  // Step I. Billing a carrier finalizes that leg's charges, which is the cost
  // half of every percent-of-profit commission on the order.
  await runCommissionsForOrder(context.load?.orderId ?? null, caller, 'RERUN')
  return { bill: (await getById(CARRIER_BILL_TABLE_NAME, id)) ?? {}, gate: gate as unknown as Row }
}

async function readBill(billId: string): Promise<CarrierBillRecord> {
  const row = await getById(CARRIER_BILL_TABLE_NAME, billId)
  if (!row) throw new Error(`Bill not found: ${billId}`)
  return row as unknown as CarrierBillRecord
}

export async function approveBill(input: Row, caller: Caller): Promise<Row> {
  const billId = assertString(input.billId, 'billId')
  const acknowledged = input.acknowledgeWarnings == null
    ? []
    : assertArrayOf<string>(input.acknowledgeWarnings, 'acknowledgeWarnings', (item, index) =>
        assertString(item, `acknowledgeWarnings[${index}]`), 20)
  const docsOverrideNote = optionalString(input.docsOverrideNote, MAX_NOTE)

  const bill = await readBill(billId)
  if (bill.status === 'VOID') throw new Error('That bill is void')
  if (bill.status !== 'IN_REVIEW') throw new Error('Only a bill in review can be approved')

  const context = await readAssignmentContext(bill.loadCarrierId)
  const gate = carrierGateFor(context)
  const now = nowIso()

  // A paperwork override is an admin act with a reason on it, and it is applied to
  // the bill BEFORE the gate is judged — otherwise the override could never clear
  // the block it exists for.
  const overriding = Boolean(docsOverrideNote) && gate.missing.length > 0
  if (overriding && !caller.isAdmin) throw new Error('Overriding the paperwork gate requires owner or ADMIN')
  const judged: CarrierBillRecord = overriding ? { ...bill, docsOverrideAt: now } : bill

  const check = approvalReadiness({
    bill: judged,
    loadCarrier: context.loadCarrier,
    load: context.load,
    carrier: context.carrier,
    gate,
    payee: { kind: bill.payeeKind, paymentMethodId: bill.paymentMethodId ?? null, remitTo: bill.remitTo ?? null },
    settings: context.settings,
    isAdmin: caller.isAdmin,
  })
  if (check.blocks.length > 0) throw new Error(check.blocks.join(' '))
  const unacknowledged = check.warnings.filter((warning) => !acknowledged.includes(warning.key))
  if (unacknowledged.length > 0) {
    throw new Error(`Acknowledge before approving: ${unacknowledged.map((w) => w.message).join(' ')}`)
  }

  await transact(
    [
      updateTx(
        CARRIER_BILL_TABLE_NAME,
        billId,
        {
          status: 'TO_BE_PAID',
          approvedAt: now,
          approvedBy: caller.email,
          approvalWarnings: check.warnings.map((warning) => warning.key),
          ...(overriding
            ? { docsOverrideAt: now, docsOverrideBy: caller.email, docsOverrideNote }
            : {}),
          updatedAt: now,
          updatedBy: caller.email,
          version: (bill.version ?? 1) + 1,
        },
        {
          // Somebody voiding or paying this bill between the read and the write loses
          // here rather than approving a row that has moved on.
          condition: 'attribute_exists(id) AND version = :expectedVersion AND #status = :inReview',
          extraValues: { ':expectedVersion': { N: String(bill.version ?? 1) }, ':inReview': { S: 'IN_REVIEW' } },
        },
      ),
      updateTx(
        LOAD_CARRIER_TABLE_NAME,
        bill.loadCarrierId,
        { apStatus: 'TO_BE_PAID', apStatusChangedAt: now, updatedAt: now, updatedBy: caller.email },
        {
          condition: 'invoiceId = :billId',
          extraValues: { ':billId': { S: billId } },
        },
      ),
    ],
    'bill approval',
  )
  await writeAudit('CarrierBill', billId, 'APPROVE_BILL', caller, {
    acknowledged,
    docsOverrideNote,
    netCents: bill.netCents,
  })
  // Step I. Approving the bill is the last word on this leg's cost.
  await runCommissionsForOrder(context.load?.orderId ?? null, caller, 'RERUN')
  return { bill: (await getById(CARRIER_BILL_TABLE_NAME, billId)) ?? {} }
}

export async function unapproveBill(input: Row, caller: Caller): Promise<Row> {
  const billId = assertString(input.billId, 'billId')
  const reason = optionalString(input.reason, MAX_NOTE)
  if (!reason) throw new Error('Taking a bill back to review needs a reason')

  const bill = await readBill(billId)
  if (bill.status !== 'TO_BE_PAID') throw new Error('Only an approved, unpaid bill can be taken back to review')
  if ((bill.paidCents ?? 0) + (bill.creditedCents ?? 0) > 0) {
    throw new Error('Money has already been applied to this bill; reverse the payment first')
  }

  const now = nowIso()
  await transact(
    [
      updateTx(
        CARRIER_BILL_TABLE_NAME,
        billId,
        {
          status: 'IN_REVIEW',
          note: reason,
          updatedAt: now,
          updatedBy: caller.email,
          version: (bill.version ?? 1) + 1,
        },
        {
          remove: ['approvedAt', 'approvedBy'],
          condition: 'version = :expectedVersion AND paidCents = :paid AND creditedCents = :credited',
          extraValues: {
            ':expectedVersion': { N: String(bill.version ?? 1) },
            ':paid': { N: String(bill.paidCents ?? 0) },
            ':credited': { N: String(bill.creditedCents ?? 0) },
          },
        },
      ),
      updateTx(
        LOAD_CARRIER_TABLE_NAME,
        bill.loadCarrierId,
        { apStatus: 'IN_REVIEW', apStatusChangedAt: now, updatedAt: now, updatedBy: caller.email },
        { condition: 'invoiceId = :billId', extraValues: { ':billId': { S: billId } } },
      ),
    ],
    'bill unapproval',
  )
  await writeAudit('CarrierBill', billId, 'UNAPPROVE_BILL', caller, { reason })
  return { bill: (await getById(CARRIER_BILL_TABLE_NAME, billId)) ?? {} }
}

/**
 * The only way back out of a recorded bill.
 *
 * The row is kept, marked VOID — an immutable ledger does not forget what it was
 * told — and the assignment is released: AWAITING_INVOICE again, `invoiceId` cleared,
 * `chargesFinalizedAt` REMOVEd so the carrier-side charges can be corrected and the
 * bill re-recorded. Refused the moment any money has touched it.
 */
export async function voidBill(input: Row, caller: Caller): Promise<Row> {
  const billId = assertString(input.billId, 'billId')
  const reason = optionalString(input.reason, MAX_NOTE)
  if (!reason) throw new Error('Voiding a bill needs a reason')

  const bill = await readBill(billId)
  if (bill.status === 'VOID') throw new Error('That bill is already void')
  if ((bill.paidCents ?? 0) + (bill.creditedCents ?? 0) > 0) {
    throw new Error('Money has already been applied to this bill; reverse the payment first')
  }

  const now = nowIso()
  await transact(
    [
      updateTx(
        CARRIER_BILL_TABLE_NAME,
        billId,
        {
          status: 'VOID',
          voidedAt: now,
          voidedBy: caller.email,
          voidReason: reason,
          balanceCents: 0,
          updatedAt: now,
          updatedBy: caller.email,
          version: (bill.version ?? 1) + 1,
        },
        {
          // `apOpen` must LEAVE the row, never become null: a NULL in an index key is
          // rejected outright (step C, BUILD_LOG 32d3eec).
          remove: ['apOpen'],
          condition: 'version = :expectedVersion AND paidCents = :paid AND creditedCents = :credited',
          extraValues: {
            ':expectedVersion': { N: String(bill.version ?? 1) },
            ':paid': { N: String(bill.paidCents ?? 0) },
            ':credited': { N: String(bill.creditedCents ?? 0) },
          },
        },
      ),
      updateTx(
        LOAD_CARRIER_TABLE_NAME,
        bill.loadCarrierId,
        {
          apStatus: 'AWAITING_INVOICE',
          apStatusChangedAt: now,
          invoiceId: null,
          apBalanceCents: null,
          updatedAt: now,
          updatedBy: caller.email,
        },
        {
          remove: ['chargesFinalizedAt'],
          condition: 'invoiceId = :billId',
          extraValues: { ':billId': { S: billId } },
        },
      ),
    ],
    'bill void',
  )
  await writeAudit('CarrierBill', billId, 'VOID_BILL', caller, { reason, netCents: bill.netCents })
  return { bill: (await getById(CARRIER_BILL_TABLE_NAME, billId)) ?? {} }
}

export async function saveApSettings(input: Row, caller: Caller): Promise<Row> {
  const template = optionalString(input.remittanceEmailTemplate, 4000)
  if (template && !template.includes('{reference}')) {
    throw new Error('The remittance e-mail template must contain {reference}')
  }
  const docsRequired = input.apBillDocsRequired == null
    ? null
    : assertArrayOf<string>(input.apBillDocsRequired, 'apBillDocsRequired', (item, index) =>
        assertString(item, `apBillDocsRequired[${index}]`), 20)

  const now = nowIso()
  const patch: Row = { __typename: 'TmsSettings', updatedAt: now, updatedBy: caller.email }
  if (template) patch.remittanceEmailTemplate = template
  if (docsRequired) patch.apBillDocsRequired = docsRequired
  const approvalAdminOnly = optionalBoolean(input.apApprovalAdminOnly)
  if (approvalAdminOnly != null) patch.apApprovalAdminOnly = approvalAdminOnly
  const postingAdminOnly = optionalBoolean(input.apPostingAdminOnly)
  if (postingAdminOnly != null) patch.apPostingAdminOnly = postingAdminOnly
  const requireRateCon = optionalBoolean(input.apRequireSignedRateCon)
  if (requireRateCon != null) patch.apRequireSignedRateCon = requireRateCon
  const termsDays = optionalInteger(input.defaultCarrierTermsDays, { min: 0, max: 365, label: 'defaultCarrierTermsDays' })
  if (termsDays != null) patch.defaultCarrierTermsDays = termsDays

  await transact([updateTx(SETTINGS_TABLE_NAME, SETTINGS_ID, patch)], 'AP settings')
  await writeAudit('TmsSettings', SETTINGS_ID, 'SAVE_AP_SETTINGS', caller, patch)
  return { settings: await getSettings() }
}

export { numberOrNull }
