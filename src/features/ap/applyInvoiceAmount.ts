/**
 * Record the amount on a carrier's invoice against its bill in Expected.
 *
 * The bill's amount is the total of the assignment's carrier lines, so a different invoice amount is a change to
 * those lines: this reads the shipment, moves the rate line (`repriceToInvoiceAmount`), saves through
 * UPDATE_CARRIER_CHARGES (which re-snapshots the bill in the same write, so the shipment's cost, its margin and the
 * bill all move together) and then checks the bill's lines add up to what was typed. The dates are saved by the caller afterwards.
 */
import { getShipmentBundle, updateCarrierCharges } from '@/lib/apiClient'
import { billLinesFor } from '@/lib/carrierBill'
import { repriceToInvoiceAmount } from '@/lib/carrierInvoiceAmount'
import { formatCents } from '@/lib/invoiceBuild'
import type { CarrierBillRecord } from '@/types/tms'

export const INVOICE_AMOUNT_REASONS = ['Carrier invoice differs', 'Accessorial', 'Detention', 'Lumper', 'Other'] as const

export async function applyInvoiceAmount(input: {
  bill: Pick<CarrierBillRecord, 'shipmentId' | 'loadCarrierId'>
  targetCents: number
  /** The reason as AP chose it: one of the options, or `Other: …`. */
  reason: string
}): Promise<{ fromCents: number; toCents: number }> {
  const { bill, targetCents, reason } = input
  const loadCarrierId = bill.loadCarrierId
  if (!bill.shipmentId || !loadCarrierId) throw new Error('This bill is not tied to a shipment, so its amount cannot be changed here.')
  const bundle = await getShipmentBundle(bill.shipmentId)
  const assignment = bundle.loadCarriers.find((row) => row.id === loadCarrierId)
  if (!assignment || assignment.kind !== 'CARRIER') throw new Error('That carrier is no longer on the shipment.')
  const mine = bundle.charges.filter((row) => row.side === 'CARRIER' && String(row.loadCarrierId ?? '') === loadCarrierId)
  const leg = bundle.loads.find((row) => row.id === assignment.loadId)
  const result = repriceToInvoiceAmount(mine, targetCents, { miles: leg?.miles ?? null })
  if (!result.ok) throw new Error(result.message)
  if (result.fromCents === result.toCents) return { fromCents: result.fromCents, toCents: result.toCents }

  const why = `${reason}: carrier invoice ${formatCents(result.toCents)}, was ${formatCents(result.fromCents)}`.slice(0, 200)
  const saved = await updateCarrierCharges({
    loadCarrierId,
    expectedVersion: bundle.shipment.version ?? 1,
    charges: result.charges.map((line) => ({ ...line, loadCarrierId, loadId: assignment.loadId ?? line.loadId ?? null })),
    changeReason: why,
    amountReason: why,
  })
  const after = billLinesFor(saved.charges, loadCarrierId).grossCents
  if (after !== targetCents) {
    throw new Error(`The carrier charges now add up to ${formatCents(after)}, not ${formatCents(targetCents)}. Use Adjust carrier pay to finish.`)
  }
  return { fromCents: result.fromCents, toCents: result.toCents }
}
