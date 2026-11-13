/**
 * Needs review (Ryne 2026-11-13): a shipment AR/AP should look at before trusting its numbers,
 * with the reason. The flag lives on the Shipment (`financeReviewAt` + `financeReviewReason`, and
 * `financeReviewApNote` for carrier detail the AP page alone shows). Raising one is an import or an
 * office decision; this action is how the office clears it once the shipment is sorted out.
 */
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { SHIPMENT_TABLE_NAME, getById, nowIso, transact, updateTx, writeAudit, type Row } from './store'

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
