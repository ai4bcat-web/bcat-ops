/**
 * The carrier's AP record, created when a shipment moves from Load Review to billing.
 *
 * Moving a load to billing used to be refused until somebody had recorded the carrier's bill by hand
 * ("Carrier charges not settled"). The rule is now the other way round: the move creates the bill,
 * and AP fills in the invoice date and due date from the carrier's invoice afterwards. The bill is
 * the same `CarrierBill` RECORD_BILL writes — same lines, terms, fee and payee snapshot, same rung
 * (IN_REVIEW), same transaction with the assignment's `invoiceId` / `chargesFinalizedAt` — with
 * `datesPending` set, `billNumber` empty, and the bill date and due date holding placeholders
 * (today, and today plus the carrier's terms) that approval refuses to pay on.
 *
 * Idempotent: an assignment that already has a bill (`invoiceId` set, or past AWAITING_INVOICE) is
 * skipped, and the write is conditioned on exactly that, so two releases racing cannot both bill it.
 *
 * Own-fleet legs are never billed here; they are paid through driver settlements.
 */
import { TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import {
  billDueDate,
  billLinesFor,
  billPayee,
  billReadiness,
  billTermsDays,
  billTotals,
} from '../../../src/lib/carrierBill'
import type {
  CarrierBillRecord,
  CarrierPaymentMethodRecord,
  CarrierRecord,
  LoadCarrierRecord,
  LoadChargeRecord,
  ShipmentLoad,
  ShipmentRecord,
  TmsSettings,
} from '../../../src/types/tms'
import { getById, isConflict, queryIndex, putItem, type Row } from './shipmentStore'

export const IDX_PAYMENT_METHODS_BY_CARRIER = 'carrierPaymentMethodsByCarrierId'

export interface PendingBillInput {
  shipment: Row
  loads: Row[]
  loadCarriers: Row[]
  charges: Row[]
  carriersById: ReadonlyMap<string, Row>
  methodsByCarrierId: ReadonlyMap<string, Row[]>
  settings: Row | null
  /** YYYY-MM-DD, the day of the move; the placeholder bill date. */
  today: string
  now: string
  actorEmail: string
}

export interface PendingBillPlan {
  loadCarrierId: string
  carrierName: string
  grossCents: number
  bill: CarrierBillRecord
}

export interface PendingBillSkip {
  loadCarrierId: string
  carrierName: string
  /** `ALREADY_BILLED` is normal on a second pass; `NOT_BILLABLE` carries the reasons. */
  kind: 'ALREADY_BILLED' | 'NOT_BILLABLE'
  reasons: string[]
}

export interface PendingBillPlanResult {
  create: PendingBillPlan[]
  skipped: PendingBillSkip[]
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** `cb:<loadCarrierId>:1` — the first bill an assignment ever has; RECORD_BILL numbers later ones from the count. */
export function pendingBillId(loadCarrierId: string): string {
  return `cb:${loadCarrierId}:1`
}

/** Which assignments get a pending bill, and what each bill says. Pure; nothing is read or written here. */
export function planPendingCarrierBills(input: PendingBillInput): PendingBillPlanResult {
  const create: PendingBillPlan[] = []
  const skipped: PendingBillSkip[] = []
  const shipment = input.shipment as unknown as ShipmentRecord
  const loads = input.loads as unknown as ShipmentLoad[]
  const charges = input.charges as unknown as LoadChargeRecord[]
  const settings = input.settings as unknown as TmsSettings | null

  for (const row of input.loadCarriers) {
    const loadCarrier = row as unknown as LoadCarrierRecord
    if (loadCarrier.kind !== 'CARRIER' || loadCarrier.status !== 'ACTIVE') continue
    const carrierName = trimmed(loadCarrier.carrierName) || 'the carrier'
    const apStatus = row.apStatus == null ? null : String(row.apStatus)
    if (trimmed(loadCarrier.invoiceId) || (apStatus != null && apStatus !== 'AWAITING_INVOICE')) {
      skipped.push({ loadCarrierId: loadCarrier.id, carrierName, kind: 'ALREADY_BILLED', reasons: [] })
      continue
    }

    const load = loads.find((item) => item.id === loadCarrier.loadId) ?? null
    const carrierRow = loadCarrier.carrierId ? input.carriersById.get(loadCarrier.carrierId) ?? null : null
    const carrier = carrierRow as unknown as CarrierRecord | null
    const readiness = billReadiness({ loadCarrier, load, carrier, shipment, charges, existingBills: [] })
    if (!readiness.ready) {
      skipped.push({ loadCarrierId: loadCarrier.id, carrierName, kind: 'NOT_BILLABLE', reasons: readiness.reasons })
      continue
    }

    const methods = (input.methodsByCarrierId.get(loadCarrier.carrierId ?? '') ?? []) as unknown as CarrierPaymentMethodRecord[]
    const { lines, grossCents } = billLinesFor(charges, loadCarrier.id)
    const payee = billPayee(carrier, methods)
    const { quickPayFeeCents, netCents } = billTotals({ grossCents, loadCarrier, payeeKind: payee.kind })
    const termsDays = billTermsDays(loadCarrier, carrier, settings)
    const id = pendingBillId(loadCarrier.id)

    create.push({
      loadCarrierId: loadCarrier.id,
      carrierName,
      grossCents,
      bill: {
        id,
        loadCarrierId: loadCarrier.id,
        loadId: loadCarrier.loadId,
        shipmentId: loadCarrier.shipmentId,
        shipmentNumber: shipment.number ?? null,
        loadNumber: load?.loadNumber ?? null,
        carrierId: loadCarrier.carrierId ?? '',
        carrierName: loadCarrier.carrierName ?? carrier?.name ?? null,
        carrierMc: loadCarrier.carrierMc ?? carrier?.mcNumber ?? null,
        payeeKind: payee.kind,
        paymentMethodId: payee.paymentMethodId,
        remitTo: payee.remitTo,
        divisionKey: load?.divisionKey ?? null,
        status: 'IN_REVIEW',
        billNumber: null,
        billDate: input.today,
        billMonth: input.today.slice(0, 7),
        recordedAt: input.now,
        recordedBy: input.actorEmail,
        recordedEarly: load?.status !== 'DELIVERED',
        datesPending: true,
        dueAt: billDueDate(input.today, termsDays),
        termsDays,
        quickPay: loadCarrier.quickPay ?? false,
        quickPayDays: loadCarrier.quickPayDays ?? null,
        quickPayFeeBps: loadCarrier.quickPayFeeBps ?? null,
        lines,
        grossCents,
        quickPayFeeCents,
        netCents,
        // The carrier's invoice has not arrived: the bill starts at what the lines say, so there is no variance to chase.
        billedCents: grossCents,
        varianceCents: 0,
        paidCents: 0,
        creditedCents: 0,
        balanceCents: netCents,
        apOpen: 'OPEN',
        documentId: null,
        approvalWarnings: [],
        note: 'Created when the load moved to billing. Set the invoice date and due date from the carrier’s invoice.',
        createdBy: input.actorEmail,
        updatedBy: input.actorEmail,
        version: 1,
      },
    })
  }
  return { create, skipped }
}

export interface PendingBillTables {
  carrier: string
  carrierPaymentMethod: string
  carrierBill: string
  loadCarrier: string
}

/** The two table reads the plan needs beyond the shipment bundle. */
export async function readPendingBillContext(
  db: DynamoDBClient,
  tables: PendingBillTables,
  loadCarriers: Row[],
): Promise<{ carriersById: Map<string, Row>; methodsByCarrierId: Map<string, Row[]> }> {
  const carriersById = new Map<string, Row>()
  const methodsByCarrierId = new Map<string, Row[]>()
  const ids = [...new Set(
    loadCarriers
      .filter((lc) => lc.kind === 'CARRIER' && lc.status === 'ACTIVE' && trimmed(lc.carrierId))
      .map((lc) => String(lc.carrierId)),
  )]
  await Promise.all(ids.map(async (carrierId) => {
    const [carrier, methods] = await Promise.all([
      getById(db, tables.carrier, carrierId),
      queryIndex(db, tables.carrierPaymentMethod, IDX_PAYMENT_METHODS_BY_CARRIER, 'carrierId', carrierId),
    ])
    if (carrier) carriersById.set(carrierId, carrier)
    methodsByCarrierId.set(carrierId, methods)
  }))
  return { carriersById, methodsByCarrierId }
}

const MAX_BILL_NUMBERING = 5

/**
 * Write one bill and move its assignment to IN_REVIEW, in one transaction (RECORD_BILL's shape).
 * Returns false when the assignment was billed by somebody else in the meantime. A voided earlier bill
 * leaves its id taken (`cb:<lc>:1`), so a released assignment that was voided and is billed again takes
 * the next number, the way RECORD_BILL numbers it.
 */
export async function writePendingBill(
  db: DynamoDBClient,
  tables: PendingBillTables,
  plan: PendingBillPlan,
  now: string,
  actorEmail: string,
): Promise<boolean> {
  for (let n = 1; n <= MAX_BILL_NUMBERING; n++) {
    const bill = n === 1 ? plan.bill : { ...plan.bill, id: `cb:${plan.loadCarrierId}:${n}` }
    if (await tryWritePendingBill(db, tables, { ...plan, bill }, now, actorEmail)) return true
    // The transaction failed a condition: either the assignment is billed (stop) or this id is taken (next).
    const row = await getById(db, tables.loadCarrier, plan.loadCarrierId)
    const billed = !row
      || (typeof row.invoiceId === 'string' && row.invoiceId.trim() !== '')
      || (row.apStatus != null && row.apStatus !== 'AWAITING_INVOICE')
    if (billed) return false
  }
  throw new Error(`${plan.carrierName} already has ${MAX_BILL_NUMBERING} voided bills on this assignment; record the bill from AP`)
}

async function tryWritePendingBill(
  db: DynamoDBClient,
  tables: PendingBillTables,
  plan: PendingBillPlan,
  now: string,
  actorEmail: string,
): Promise<boolean> {
  const { bill } = plan
  const names: Record<string, string> = {
    '#kind': 'kind',
    '#apStatus': 'apStatus',
    '#chargesFinalizedAt': 'chargesFinalizedAt',
    '#invoiceId': 'invoiceId',
    '#apStatusChangedAt': 'apStatusChangedAt',
    '#apOpen': 'apOpen',
    '#apBalanceCents': 'apBalanceCents',
    '#updatedAt': 'updatedAt',
    '#updatedBy': 'updatedBy',
  }
  const values: Record<string, AttributeValue> = {
    ':carrier': { S: 'CARRIER' },
    ':awaiting': { S: 'AWAITING_INVOICE' },
    ':nullType': { S: 'NULL' },
    ':inReview': { S: 'IN_REVIEW' },
    ':invoiceId': { S: bill.id },
    ':now': { S: now },
    ':open': { S: 'OPEN' },
    ':balance': { N: String(bill.netCents) },
    ':by': { S: actorEmail },
  }
  const update: TransactWriteItem = {
    Update: {
      TableName: tables.loadCarrier,
      Key: marshall({ id: plan.loadCarrierId }),
      UpdateExpression:
        'SET #apStatus = :inReview, #invoiceId = :invoiceId, #chargesFinalizedAt = :now, #apStatusChangedAt = :now, #apOpen = :open, #apBalanceCents = :balance, #updatedAt = :now, #updatedBy = :by',
      ConditionExpression:
        '#kind = :carrier AND (attribute_not_exists(#apStatus) OR attribute_type(#apStatus, :nullType) OR #apStatus = :awaiting) AND (attribute_not_exists(#invoiceId) OR attribute_type(#invoiceId, :nullType))',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  }
  const put = putItem(tables.carrierBill, { ...(bill as unknown as Row), __typename: 'CarrierBill', createdAt: now, updatedAt: now })
  try {
    await db.send(new TransactWriteItemsCommand({ TransactItems: [put, update] }))
    return true
  } catch (err) {
    if (isConflict(err)) return false
    throw err
  }
}
