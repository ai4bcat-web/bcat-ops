/**
 * The one bridge from the legacy load drawer into the shipment layer.
 *
 * `Load.rate` is a mirror once a load belongs to a shipment: the real number is the
 * CUSTOMER LINEHAUL charge line, and `LoadFinancials` is derived from it. Writing the
 * mirror directly would leave the order's cached revenue and the financials behind, so
 * the drawer's rate field routes through `RECALC_CHARGES` instead and lets the server
 * rewrite the mirror.
 */
import { getShipmentBundle, recalcCharges } from '@/lib/apiClient'
import type { LoadChargeInput } from '@/types/tms'

/**
 * Point the shipment's customer linehaul at `rateCents`. Returns false when the shipment
 * could not be read, so the caller can fall back to the legacy write.
 */
export async function syncLoadRateToShipment(shipmentId: string, loadId: string, rateCents: number): Promise<boolean> {
  const bundle = await getShipmentBundle(shipmentId)
  if (!bundle) return false

  const orderId = bundle.loads.find((l) => l.id === loadId)?.orderId ?? bundle.orders[0]?.id ?? null
  const charges: LoadChargeInput[] = bundle.charges.map((c) => ({
    id: c.id,
    side: c.side,
    orderId: c.orderId ?? null,
    loadId: c.loadId ?? null,
    loadCarrierId: c.loadCarrierId ?? null,
    code: c.code,
    label: c.label ?? null,
    calculatedBy: c.calculatedBy,
    rateCents: c.rateCents,
    count: c.count ?? 1,
    isRate: c.isRate,
    release: c.release ?? null,
    sortOrder: c.sortOrder,
    note: c.note ?? null,
  }))

  const linehaul = charges.find((c) => c.side === 'CUSTOMER' && c.code.toUpperCase() === 'LINEHAUL')
  if (linehaul) {
    linehaul.rateCents = rateCents
    linehaul.calculatedBy = 'FLAT'
    linehaul.count = 1
  } else {
    charges.push({
      side: 'CUSTOMER', orderId, loadId, loadCarrierId: null, code: 'LINEHAUL', label: 'Linehaul',
      calculatedBy: 'FLAT', rateCents, count: 1, isRate: true, release: null,
      sortOrder: charges.filter((c) => c.side === 'CUSTOMER').length, note: null,
    })
  }

  await recalcCharges({
    shipmentId,
    expectedVersion: bundle.shipment.version ?? 0,
    charges,
  })
  return true
}
