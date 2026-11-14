/**
 * Needs review (Ryne 2026-11-13): a shipment AR/AP should look at before trusting its numbers,
 * with the reason. The flag lives on the Shipment (`financeReviewAt` + `financeReviewReason`, and
 * `financeReviewApNote` for carrier detail the AP page alone shows). Raising one is an import or an
 * office decision; this action is how the office clears it once the shipment is sorted out.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { CAR_SHIPPING_CARRIER_TERMS_DAYS, carShippingBillDates } from '../_shared/pendingCarrierBill'
import {
  CARRIER_BILL_TABLE_NAME, IDX_BILLS_BY_CARRIER, IDX_CARRIERS_BY_SHIPMENT, IDX_LOADS_BY_SHIPMENT, LOAD_CARRIER_TABLE_NAME, LOAD_TABLE_NAME,
  SHIPMENT_TABLE_NAME, getById, nowIso, queryIndex, transact, updateTx, writeAudit, type Row,
} from './store'

export const FINANCE_REVIEW_FIELDS = ['financeReviewAt', 'financeReviewReason', 'financeReviewApNote'] as const

export async function clearFinanceReview(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const note = optionalString(input.note, 500)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (!shipment.financeReviewAt) return { shipmentId, cleared: false }
  await transact([
    updateTx(SHIPMENT_TABLE_NAME, shipmentId, { updatedAt: nowIso(), updatedBy: caller.email }, {
      remove: [...FINANCE_REVIEW_FIELDS],
      condition: 'attribute_exists(id)',
    }),
  ], 'needs-review clear')
  await writeAudit('SHIPMENT', shipmentId, 'CLEAR_FINANCE_REVIEW', caller, {
    reason: shipment.financeReviewReason ?? null,
    note: note ?? null,
  })
  return { shipmentId, cleared: true }
}

/** A reason the delivered date answers ("Missing delivered date", "No delivered date; …"). */
const DELIVERED_REASON = /deliver/i

/** What is left of a Needs review reason once its delivered-date part is answered; '' when nothing is. */
export function reasonWithoutDelivered(reason: string | null | undefined): string {
  return String(reason ?? '').split(/\s*;\s*/).map((part) => part.trim()).filter((part) => part && !DELIVERED_REASON.test(part)).join('; ')
}

/** `YYYY-MM-DD` → noon in Chicago (17:00Z), so the delivered day reads the same in every US time zone. */
export function deliveredStamp(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error('The delivered date must be YYYY-MM-DD')
  return `${day}T17:00:00.000Z`
}

/**
 * Set when a shipment delivered (Ryne 2026-11-13: "give me the ability to edit them"), from the Needs
 * review list. Writes `Shipment.deliveredAt`, answers the delivered-date part of the review flag (the
 * whole flag when that was all of it), and re-dates any car-shipping carrier bill still in review with
 * no money on it to the delivered day + 2, which moves it to Aging.
 */
export async function setDeliveredDate(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const deliveredAt = deliveredStamp(assertString(input.deliveredDate, 'deliveredDate'))
  if (deliveredAt.slice(0, 10) > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) throw new Error('The delivered date cannot be in the future')
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)

  const now = nowIso()
  const hadFlag = !!shipment.financeReviewAt
  const rest = hadFlag ? reasonWithoutDelivered(shipment.financeReviewReason as string | null) : ''
  const answered = hadFlag && rest !== String(shipment.financeReviewReason ?? '').trim()
  const clearFlag = answered && !rest && !String(shipment.financeReviewApNote ?? '').trim()
  const updated: Row = { ...shipment, deliveredAt }
  const writes: TransactWriteItem[] = [
    updateTx(SHIPMENT_TABLE_NAME, shipmentId, {
      deliveredAt,
      ...(answered && !clearFlag ? { financeReviewReason: rest || null } : {}),
      updatedAt: now,
      updatedBy: caller.email,
    }, {
      ...(clearFlag ? { remove: [...FINANCE_REVIEW_FIELDS] } : {}),
      condition: 'attribute_exists(id)',
    }),
  ]

  // Car-shipping bills follow the delivered day; any other bill keeps the dates AP gave it.
  const [loads, assignments] = await Promise.all([
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId),
  ])
  const carrierIds = [...new Set(assignments.map((a) => String(a.carrierId ?? '')).filter(Boolean))]
  const bills = (await Promise.all(carrierIds.map((id) => queryIndex(CARRIER_BILL_TABLE_NAME, IDX_BILLS_BY_CARRIER, 'carrierId', id))))
    .flat().filter((bill) => bill.shipmentId === shipmentId)
  const redated: Row[] = []
  for (const bill of bills) {
    if (bill.status !== 'IN_REVIEW' || Number(bill.paidCents ?? 0) + Number(bill.creditedCents ?? 0) > 0) continue
    const load = loads.find((l) => l.id === bill.loadId) ?? loads[0] ?? null
    const dates = carShippingBillDates(updated, load)
    if (!dates || (dates.billDate === bill.billDate && dates.dueAt === bill.dueAt && bill.datesPending !== true)) continue
    writes.push(updateTx(CARRIER_BILL_TABLE_NAME, String(bill.id), {
      billDate: dates.billDate,
      billMonth: dates.billDate.slice(0, 7),
      dueAt: dates.dueAt,
      termsDays: CAR_SHIPPING_CARRIER_TERMS_DAYS,
      datesPending: false,
      status: 'IN_REVIEW',
      updatedAt: now,
      updatedBy: caller.email,
      version: Number(bill.version ?? 1) + 1,
    }, {
      condition: '#status = :status AND version = :expectedVersion',
      extraValues: { ':expectedVersion': { N: String(bill.version ?? 1) } },
    }))
    redated.push({ billId: bill.id, from: { billDate: bill.billDate, dueAt: bill.dueAt, datesPending: bill.datesPending === true }, to: dates })
  }

  await transact(writes, 'set delivered date')
  await writeAudit('SHIPMENT', shipmentId, 'SET_DELIVERED_DATE', caller, {
    from: { deliveredAt: shipment.deliveredAt ?? null, financeReviewReason: shipment.financeReviewReason ?? null },
    to: { deliveredAt, financeReviewReason: clearFlag ? null : answered ? rest : shipment.financeReviewReason ?? null },
    redatedBills: redated,
  })
  for (const r of redated) await writeAudit('CarrierBill', String(r.billId), 'SET_BILL_DATES', caller, { from: r.from, to: r.to, reason: 'car shipping: delivered + 2' })
  return { shipmentId, deliveredAt, reviewCleared: clearFlag, reviewReason: clearFlag ? null : answered ? rest : shipment.financeReviewReason ?? null, redatedBills: redated.length }
}
