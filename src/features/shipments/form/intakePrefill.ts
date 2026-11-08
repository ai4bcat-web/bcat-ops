/**
 * Intake load → create-form values (Step AH, Ryne's feedback 7). Pure: the extraction on an
 * `IntakeLoadRecord.fields` (customer, stops, dates, equipment, weight, commodity, refs, rate) becomes a
 * `ShipmentFormValues`, plus the list of control test ids that carry extracted text so the form can mark them.
 */
import { isShipmentTypeKey } from '@/lib/shipmentTypes'
import { applyShipmentType, typeForDivisionChange } from './shipmentType'
import { applyCustomerDefaults, emptyStop, emptyValues, type FormStop, type ShipmentFormValues } from './model'
import type { IntakeLoadRecord, IntakeStop } from '@/types/intake'
import type { CustomerRecord } from '@/types/tms'

const text = (v: unknown): string => (v == null ? '' : String(v).trim())

/** Stop controls are `f-pickup-*` (first), `f-consignee-*` (last) and `f-stop-<i>-*` between. */
export const stopPrefix = (index: number, count: number): string =>
  index === 0 ? 'pickup' : index === count - 1 ? 'consignee' : `stop-${index}`

function formStop(s: IntakeStop, ref: string): { stop: FormStop; keys: Array<keyof FormStop> } {
  const stop = emptyStop(s.type)
  const keys: Array<keyof FormStop> = []
  const set = (key: 'name' | 'address1' | 'city' | 'state' | 'zip' | 'note' | 'refNo', value: unknown) => {
    const v = text(value)
    if (!v) return
    stop[key] = key === 'state' ? v.toUpperCase() : v
    keys.push(key)
  }
  set('name', s.name); set('address1', s.street); set('city', s.city); set('state', s.state); set('zip', s.zip)
  set('note', s.instructions); set('refNo', ref)
  const date = text(s.date)
  if (date) {
    const time = text(s.time)
    // A booked time is an exact appointment (the board and calendar read `appt`); a bare date is only Ready.
    const at = `${date}T${time || '00:00'}`
    if (s.type === 'pickup') { stop.ready = at; keys.push('ready') }
    if (time || s.type === 'delivery') { stop.appt = at; keys.push('appt') }
  }
  return { stop, keys }
}

export interface IntakePrefill {
  values: ShipmentFormValues
  /** `data-testid`s of the controls that now hold extracted text. */
  fromEmail: string[]
}

export function intakePrefill(row: Pick<IntakeLoadRecord, 'fields'>, customer: CustomerRecord | null): IntakePrefill {
  const f = row.fields
  const marks: string[] = []
  const mark = (id: string) => { marks.push(id) }
  let v = applyCustomerDefaults(emptyValues(), customer)

  if (customer) mark('f-customer-name')
  else if (text(f.customerName)) {
    v = { ...v, customer: { ...v.customer, typedName: text(f.customerName), useTyped: true } }
  }
  if (text(f.billToId)) { v = { ...v, customer: { ...v.customer, billToId: text(f.billToId) } }; mark('f-customer-billTo') }
  if (text(f.reference)) { v = { ...v, customer: { ...v.customer, refNo: text(f.reference) } }; mark('f-customer-refNo') }
  if (text(f.salesRepId)) { v = { ...v, roles: { ...v.roles, salesRepId: text(f.salesRepId) } }; mark('f-roles-salesRepId') }
  if (text(f.divisionCode)) {
    v = typeForDivisionChange(v, { ...v, ship: { ...v.ship, revDivision: text(f.divisionCode) } })
    mark('f-shipping-revDivision')
  }
  // The extractor's type goes in before its equipment so an e-mailed equipment wins over the type's default.
  if (isShipmentTypeKey(f.shipmentType)) { v = applyShipmentType(v, f.shipmentType); mark('f-shipping-shipmentType') }
  if (text(f.equipmentType)) { v = { ...v, ship: { ...v.ship, equipmentType: text(f.equipmentType) } }; mark('f-shipping-equipmentType') }
  if (text(f.commodity)) { v = { ...v, ship: { ...v.ship, description: text(f.commodity) } }; mark('f-shipping-description') }
  if (typeof f.weightLb === 'number' && f.weightLb > 0) {
    v = { ...v, ship: { ...v.ship, weightLbs: String(Math.round(f.weightLb)) } }
    mark('f-shipping-weightLbs')
  }
  if (typeof f.customerRateCents === 'number' && f.customerRateCents >= 0) {
    v = { ...v, rates: { ...v.rates, customer: { ...v.rates.customer, rateType: 'FLAT', lhRate: (f.customerRateCents / 100).toFixed(2) } } }
    mark('f-rates-customerLhRate')
  }

  // Pickups then deliveries, the order `toCreateShipmentInput` books them; first/last are Pick Up / Consignee.
  const ordered = [...f.stops.filter((s) => s.type === 'pickup'), ...f.stops.filter((s) => s.type === 'delivery')]
  if (ordered.length > 0) {
    const firstPickup = ordered.findIndex((s) => s.type === 'pickup')
    const lastDelivery = ordered.length - 1 - [...ordered].reverse().findIndex((s) => s.type === 'delivery')
    const built = ordered.map((s, i) => formStop(s, i === firstPickup ? f.pickupNumber ?? '' : i === lastDelivery && s.type === 'delivery' ? f.deliveryNumber ?? '' : ''))
    const stops = built.map((b) => b.stop)
    // The form always has a Pick Up first and a Consignee last.
    if (stops[0].type !== 'pickup') { stops.unshift(emptyStop('pickup')); built.unshift({ stop: stops[0], keys: [] }) }
    if (stops.length < 2 || stops[stops.length - 1].type !== 'delivery') { const e = emptyStop('delivery'); stops.push(e); built.push({ stop: e, keys: [] }) }
    v = { ...v, stops }
    built.forEach((b, i) => { for (const k of b.keys) mark(`f-${stopPrefix(i, built.length)}-${k}`) })
  }
  return { values: v, fromEmail: marks }
}
