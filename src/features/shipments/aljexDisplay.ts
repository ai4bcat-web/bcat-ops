/**
 * Display helpers for what the Aljex import stores on a shipment: labelled references, the
 * flag set (OSD + special requirements) and the verbatim Aljex staff codes. Pure: no I/O.
 */
import { ALJEX_REFERENCE_CODES } from '@/types/tms'
import type { AljexFormExtras, OrderReference, ShipmentRecord, SpecialRequirements } from '@/types/tms'

const REFERENCE_LABELS: Record<string, string> = {
  [ALJEX_REFERENCE_CODES.quote]: 'Quote #',
  [ALJEX_REFERENCE_CODES.manifest]: 'Manifest',
  [ALJEX_REFERENCE_CODES.container]: 'Container #',
  [ALJEX_REFERENCE_CODES.customerRef]: 'Customer ref #',
  [ALJEX_REFERENCE_CODES.pickupRef]: 'Pickup ref #',
  [ALJEX_REFERENCE_CODES.consigneeRef]: 'Consignee ref #',
  [ALJEX_REFERENCE_CODES.typeOfShipment]: 'Aljex type',
  [ALJEX_REFERENCE_CODES.revenueType]: 'Aljex revenue type',
}

/** The text a reference badge prints: its own label, else the Aljex name for its code, else the raw code. */
export function referenceLabel(ref: Pick<OrderReference, 'code' | 'label'>): string {
  if (ref.label) return ref.label
  const known = REFERENCE_LABELS[ref.code]
  if (known) return known
  const additional = ref.code.startsWith(ALJEX_REFERENCE_CODES.additionalPrefix)
    ? ref.code.slice(ALJEX_REFERENCE_CODES.additionalPrefix.length)
    : null
  return additional && /^\d+$/.test(additional) ? `Additional ref ${additional}` : ref.code
}

/** Flags worth a badge: only what is set, in a stable order. */
export function shipmentFlagLabels(osd: ShipmentRecord['osd'], sr: SpecialRequirements | null | undefined): string[] {
  const out: string[] = []
  if (osd === true) out.push('OSD')
  if (!sr) return out
  const on: Array<[boolean | null | undefined, string]> = [
    [sr.team, 'Team'], [sr.hazmat, 'Hazmat'], [sr.tarps, 'Tarps'], [sr.escort, 'Escort'],
    [sr.oversize, 'Oversize'], [sr.permit, 'Permit'], [sr.blind, 'Blind'],
    [sr.sealRequired, 'Seal required'], [sr.tempControl, 'Temp control'],
    [sr.fsma, 'FSMA'], [sr.noBroker, 'No broker'], [sr.labor, 'Labor'], [sr.highRisk, 'High risk'],
    [sr.massRelease, 'Mass release'], [sr.palletExchange, 'Pallet exchange'], [sr.inside, 'Inside delivery'],
  ]
  for (const [flag, label] of on) if (flag === true) out.push(label)
  if (sr.customsBond) out.push(`Customs bond ${sr.customsBond}`)
  if (sr.palletsIn != null) out.push(`Pallets in ${sr.palletsIn}`)
  if (sr.palletsOut != null) out.push(`Pallets out ${sr.palletsOut}`)
  return out
}

/**
 * Step AH extras the form stores under `specialRequirements.form` that nothing else on the detail shows:
 * only what is set, labelled in Aljex's words. Pure.
 */
export function shippingRequirementRows(extras: AljexFormExtras | null | undefined): Array<{ label: string; value: string }> {
  if (!extras) return []
  const rows: Array<[string, string | number | null | undefined]> = []
  const ship = extras.ship
  const temp = ship?.temp
  const degrees = (n: number | undefined) => (n == null ? '' : `${n}°${temp?.unit ?? 'F'}`)
  rows.push(
    ['Truck miles', ship?.truckMiles],
    ['Footage', ship?.footage],
    ['Billable weight', ship?.billableWeightLbs != null ? `${ship.billableWeightLbs} lb` : null],
    ['Freight class', ship?.freightClass],
    ['Tarp size', ship?.tarpSize],
    ['Temperature', temp && (temp.min != null || temp.max != null) ? [degrees(temp.min), degrees(temp.max)].filter(Boolean).join(' – ') : null],
    ['PreCool', temp?.preCool != null ? degrees(temp.preCool) : null],
    ['Customer hours', extras.customer?.hours],
    ['Customer e-mails', extras.customer?.emails?.length ? String(extras.customer.emails.length) : null],
    ['Tariff', extras.roles?.tariff],
    ['Special instructions', extras.instructions?.special],
  )
  return rows.filter((r): r is [string, string | number] => r[1] != null && r[1] !== '').map(([label, value]) => ({ label, value: String(value) }))
}

/** `Aljex codes` rows: only codes that are present. */
export function aljexCodeItems(s: Pick<ShipmentRecord, 'salesRepCode' | 'createdByCode' | 'serviceRepCode' | 'dispatcherCode'>): Array<{ label: string; value: string }> {
  const rows: Array<[string, string | null | undefined]> = [
    ['Aljex sales rep', s.salesRepCode], ['Aljex created by', s.createdByCode],
    ['Aljex service rep', s.serviceRepCode], ['Aljex dispatcher', s.dispatcherCode],
  ]
  return rows.filter((r): r is [string, string] => !!r[1]).map(([label, value]) => ({ label, value }))
}
