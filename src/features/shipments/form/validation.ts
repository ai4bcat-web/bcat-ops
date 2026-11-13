/**
 * Required-field rules per action (AH-plan §9.1). The server stays authoritative and its text
 * is shown verbatim; this mirrors it so the form can say what is missing before a round trip.
 *
 *   draft  — Save draft:   only a customer blocks; everything else is advisory.
 *   create — Create:       Aljex's red fields + customer's required references block.
 *   submit — Submit for Review on a draft (the order submit): create + the org/customer required-field list + stop format rules.
 */
import { validateCarrierAdd, validateLegs } from '@/lib/carrierLegs'
import { fromDateTimeInput } from '@/lib/date'
import { stopsOutOfOrder, type StopOrderInput } from '@/lib/stopOrder'
import {
  hasBillToParties, missingRequiredFields, requiredFieldLabel, resolveRequiredFields, type RequiredFieldSubject,
} from '@/lib/flowDefaults'
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import { TRUCKLOAD_MODES } from '../orderDraft'
import { LABEL, SECTION_TITLE } from './labels'
import { MAX } from './constants'
import { carrierLinehaulLine, financialPreview, firstPickupIndex, lastDeliveryIndex } from './mapping'
import { isShipmentTypeKey } from '@/lib/shipmentTypes'
import { carrierSlotsOf, parseInteger, type CarrierSlot, type FormStop, type ShipmentFormValues } from './model'
import type { FormIssue, SectionKey } from './sectionProps'

export type ValidationLevel = 'draft' | 'create' | 'submit'

export interface ValidateOpts {
  level: ValidationLevel
  mode: 'create' | 'edit'
  customer: CustomerRecord | null
  settings: TmsSettings | null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isTruckload = (v: ShipmentFormValues): boolean => (TRUCKLOAD_MODES as string[]).includes(v.mode)
const empty = (s: string | null | undefined): boolean => !(s ?? '').trim()

const carrierIsSet = (s: CarrierSlot): boolean => Boolean(s.carrierId || (s.useTyped && s.typedName.trim()) || s.loadCarrierId)
const slotName = (s: CarrierSlot, i: number): string => s.carrierName.trim() || s.typedName.trim() || `Carrier ${i + 1}`

/** Which section and control a required-list key belongs to. */
const REQUIRED_KEY_TARGET: Record<string, { section: SectionKey; fieldKey: string }> = {
  pickupAddress: { section: 'pickup', fieldKey: 'f-pickup-city' },
  pickupAppt: { section: 'pickup', fieldKey: LABEL.pickup.ready.testId },
  deliveryAddress: { section: 'consignee', fieldKey: 'f-consignee-city' },
  deliveryAppt: { section: 'consignee', fieldKey: 'f-consignee-appt' },
  billTo: { section: 'customer', fieldKey: LABEL.customer.billTo.testId },
  salesRep: { section: 'roles', fieldKey: LABEL.roles.salesRepId.testId },
  revenueDivision: { section: 'shipping', fieldKey: LABEL.shipping.revDivision.testId },
  carrierRep: { section: 'roles', fieldKey: LABEL.roles.dispatcherAssignedId.testId },
  customerRate: { section: 'rates', fieldKey: LABEL.rates.customerLhRate.testId },
  equipmentType: { section: 'shipping', fieldKey: LABEL.shipping.equipmentType.testId },
  commodity: { section: 'shipping', fieldKey: LABEL.shipping.description.testId },
  weight: { section: 'shipping', fieldKey: LABEL.shipping.weightLbs.testId },
  poNumber: { section: 'customer', fieldKey: LABEL.customer.refNo.testId },
  pickupNumber: { section: 'pickup', fieldKey: 'f-pickup-refNo' },
  deliveryNumber: { section: 'consignee', fieldKey: 'f-consignee-refNo' },
  bolNumber: { section: 'more', fieldKey: LABEL.more.references.testId },
}

/** The form seen as the Built / Intake gate sees a shipment, so `missingRequiredFields` can judge it. */
export function toRequiredFieldSubject(values: ShipmentFormValues, customer: CustomerRecord | null): RequiredFieldSubject {
  const iso = (s: FormStop): string => {
    const local = s.appt || s.ready || (s.type === 'delivery' ? s.mustDeliver : '')
    return local ? fromDateTimeInput(local) : ''
  }
  const fp = values.stops[firstPickupIndex(values.stops)]
  const ld = values.stops[lastDeliveryIndex(values.stops)]
  const bol = values.more.references.find((r) => r.code.trim().toLowerCase() === 'bol')?.value
  const preview = financialPreview(values, customer, null)
  return {
    stops: values.stops.map((s) => ({
      type: s.type, address: { city: s.city, state: s.state }, city: s.city, state: s.state, appt: iso(s),
    })),
    billToId: values.customer.billToId,
    billToApplicable: customer ? hasBillToParties(customer.billToParties) : undefined,
    salesRepId: values.roles.salesRepId,
    revDivision: values.ship.revDivision,
    carrierRepId: values.roles.dispatcherAssignedId,
    customerRateCents: preview.totals.customerRateCents,
    equipmentType: values.ship.equipmentType,
    references: {
      po: values.customer.refNo, pickup: fp?.refNo ?? '', delivery: ld?.refNo ?? '', bol: bol ?? '',
    },
    freight: { commodity: values.ship.description, weightLbs: Number(values.ship.weightLbs) || 0 },
  }
}

export function validateForm(values: ShipmentFormValues, o: ValidateOpts): FormIssue[] {
  const issues: FormIssue[] = []
  const strictRed = o.level !== 'draft'
  const submit = o.level === 'submit'
  const push = (
    section: SectionKey, field: string, fieldKey: string, label: string, message: string,
    severity: 'error' | 'warn' = 'error',
  ) => { issues.push({ id: `${section}:${field}`, section, fieldKey, label, message, severity }) }
  const red = (section: SectionKey, field: string, def: { testId: string; text: string }, message: string) =>
    push(section, field, def.testId, def.text, message, strictRed ? 'error' : 'warn')

  // Customer: a record or typed text — the only thing a draft needs.
  const typed = values.customer.useTyped || !values.customer.id
  if (typed ? empty(values.customer.typedName) : empty(values.customer.id)) {
    push('customer', 'name', LABEL.customer.name.testId, LABEL.customer.name.text, 'Pick a customer, or record the name you typed.')
  } else if (submit && typed) {
    push('customer', 'name', LABEL.customer.name.testId, LABEL.customer.name.text, 'Submit needs a customer from the directory; link the typed name first.')
  }

  const truckload = isTruckload(values)
  if (!isShipmentTypeKey(values.shipmentType)) red('shipping', 'shipmentType', LABEL.shipping.shipmentType, 'Pick a shipment type.')
  if (truckload && empty(values.ship.equipmentType)) red('shipping', 'equipmentType', LABEL.shipping.equipmentType, 'A truckload order needs an equipment type.')
  if (empty(values.ship.revDivision)) red('shipping', 'revDivision', LABEL.shipping.revDivision, 'Pick a division.')
  if (!(Number(values.ship.weightLbs) > 0)) red('shipping', 'weightLbs', LABEL.shipping.weightLbs, 'Weight must be greater than zero.')
  if (empty(values.ship.description)) red('shipping', 'description', LABEL.shipping.description, 'Describe what is on the truck.')

  const fp = firstPickupIndex(values.stops)
  const ld = lastDeliveryIndex(values.stops)
  if (fp < 0) push('picks', 'pickup', LABEL.picks.insertPick.testId, 'Pick Up', 'A shipment needs at least one pick up.', strictRed ? 'error' : 'warn')
  if (ld < 0) push('picks', 'delivery', LABEL.picks.insertStop.testId, 'Consignee', 'A shipment needs at least one delivery.', submit ? 'error' : 'warn')
  if (fp >= 0 && empty(values.stops[fp].name)) red('pickup', 'name', LABEL.pickup.name, 'Pick Up needs a name.')
  if (fp >= 0 && empty(values.stops[fp].ready) && empty(values.stops[fp].appt)) red('pickup', 'ready', LABEL.pickup.ready, 'Pick Up needs a Ready date and time.')
  if (submit && ld >= 0 && empty(values.stops[ld].name)) push('consignee', 'name', 'f-consignee-name', LABEL.stop.name.text, 'Consignee needs a name before Submit.')

  // Stop format rules (intakeProblems): city + two-letter state, zip 5/9, chronological.
  let prev: StopOrderInput | null = null
  values.stops.forEach((s, i) => {
    const kind: SectionKey = i === fp ? 'pickup' : i === ld ? 'consignee' : 'picks'
    const prefix = kind === 'picks' ? `f-stop-${i}` : `f-${kind === 'pickup' ? 'pickup' : 'consignee'}`
    const where = `${s.type === 'pickup' ? 'Pick Up' : 'Consignee'}${kind === 'picks' ? ` (stop ${i + 1})` : ''}`
    const severity: 'error' | 'warn' = submit || (o.level === 'create' && i === fp) ? 'error' : 'warn'
    if (!empty(s.name) || !empty(s.city) || !empty(s.state) || !empty(s.address1) || submit) {
      if (empty(s.city)) push(kind, `city:${i}`, `${prefix}-city`, LABEL.stop.city.text, `${where} needs a city.`, severity)
      if (!/^[A-Za-z]{2}$/.test(s.state.trim())) push(kind, `state:${i}`, `${prefix}-state`, LABEL.stop.state.text, `${where} needs a two-letter state.`, severity)
    }
    if (!empty(s.zip) && !/^\d{5}(\d{4}|-\d{4})?$/.test(s.zip.trim())) push(kind, `zip:${i}`, `${prefix}-zip`, LABEL.stop.zip.text, `${where} zip must be 5 or 9 digits.`, severity)
    if (!empty(s.email) && !EMAIL.test(s.email.trim())) push(kind, `email:${i}`, `${prefix}-email`, LABEL.stop.email.text, `${where} email is not valid.`, 'warn')
    const when = s.appt || s.ready
    if (when) {
      // FCFS windows may overlap on the same day (src/lib/stopOrder); an earlier day still warns.
      const cur: StopOrderInput = { appt: when, hours: s.hours }
      if (prev && stopsOutOfOrder(prev, cur)) push(kind, `order:${i}`, `${prefix}-appt`, LABEL.stop.appt.text, `${where} is scheduled before the stop ahead of it. Check the dates.`, 'warn')
      prev = cur
    }
    if (s.mustDeliver && s.type === 'delivery' && fp >= 0) {
      const start = values.stops[fp].appt || values.stops[fp].ready
      if (start && s.mustDeliver < start) push(kind, `must:${i}`, `${prefix}-mustDeliver`, LABEL.stop.mustDeliver.text, 'Must Deliver is before the pick up.', 'warn')
    }
  })

  // Carrier origin: required once a carrier is set.
  const carrierSet = Boolean(values.carrier.carrierId || (values.carrier.useTyped && values.carrier.typedName.trim()) || values.carrier.loadCarrierId)
  if (carrierSet) {
    if (empty(values.carrier.originCity)) red('carrier', 'originCity', LABEL.carrier.originCity, 'A carrier needs an origin city.')
    if (empty(values.carrier.originState)) red('carrier', 'originState', LABEL.carrier.originState, 'A carrier needs an origin state.')
  }

  // Rates / extras.
  if (values.rates.customer.rateType === 'PER_HOUR' && !(Number(values.rates.customer.hours) > 0) && values.rates.customer.lhRate.trim()) {
    push('rates', 'customerHours', LABEL.rates.customerHours.testId, LABEL.rates.customerHours.text, 'Hours must be greater than zero for a per-hour rate.')
  }
  if (values.rates.carrier.rateType === 'PER_HOUR' && !(Number(values.rates.carrier.hours) > 0) && values.rates.carrier.lhRate.trim()) {
    push('rates', 'carrierHours', LABEL.rates.carrierHours.testId, LABEL.rates.carrierHours.text, 'Hours must be greater than zero for a per-hour rate.')
  }
  if (values.rates.fscPercent.trim() && values.rates.fscPerMile.trim()) {
    push('rates', 'fsc', LABEL.rates.fscPerMile.testId, LABEL.rates.fscPerMile.text, 'Use FSC % or FSC/Mile, not both. FSC/Mile wins.', 'warn')
  }
  if (values.rates.carrier.rateType === 'PCT_OF_CUSTOMER') {
    const pct = Number(values.rates.carrier.payPct)
    if (values.rates.carrier.payPct.trim() && !(pct >= 0 && pct <= 100)) push('rates', 'payPct', LABEL.rates.payPct.testId, LABEL.rates.payPct.text, 'Pay % must be between 0 and 100.')
  }

  // Carriers beyond the first (AT-plan): each has its own rate row, the stops it covers, and the same caps the server holds.
  const slots = carrierSlotsOf(values)
  slots.forEach((s, i) => {
    if (i === 0) return
    const name = slotName(s, i)
    if (carrierIsSet(s)) {
      if (empty(s.originCity) || empty(s.originState)) push('carrier', `origin:${s.slot}`, `carrier-${s.slot}-originCity`, `${name} origin`, `${name} needs an origin city and state.`, 'warn')
    }
    if (s.rate.rateType === 'PER_HOUR' && !(Number(s.rate.hours) > 0) && s.rate.lhRate.trim()) {
      push('rates', `carrierHours:${s.slot}`, `rates-carrier-${s.slot}-hours`, `${name} Hours`, 'Hours must be greater than zero for a per-hour rate.')
    }
    if (s.rate.rateType === 'PCT_OF_CUSTOMER') {
      const pct = Number(s.rate.payPct)
      if (s.rate.payPct.trim() && !(pct >= 0 && pct <= 100)) push('rates', `payPct:${s.slot}`, `rates-carrier-${s.slot}-payPct`, `${name} Pay %`, 'Pay % must be between 0 and 100.')
    }
  })
  const carriersSet = slots.filter(carrierIsSet)
  if (carriersSet.length >= 2) {
    carriersSet.forEach((s, k) => {
      if (k === 0) return
      const problem = validateCarrierAdd(
        carriersSet.slice(0, k).map((o) => ({ id: o.slot, legStopIds: o.legStopIds, kind: o.isOwnFleet ? 'OWN_ASSET' as const : 'CARRIER' as const, carrierId: o.carrierId || null })),
        { kind: s.isOwnFleet ? 'OWN_ASSET' : 'CARRIER', carrierId: s.carrierId || null, legStopIds: s.legStopIds },
      )
      if (problem) push('carrier', `add:${s.slot}`, 'section-carrier-tracking', slotName(s, slots.indexOf(s)), problem)
    })
    carriersSet.forEach((s) => {
      const i = slots.indexOf(s)
      const line = carrierLinehaulLine(values, s.rate)
      if (line && line.rateCents > 0) return
      push('rates', `carrierRate:${s.slot}`, `rates-carrier-${s.slot}-rate`, `${slotName(s, i)} rate`, `${slotName(s, i)} needs a rate before the order is submitted.`, submit ? 'error' : 'warn')
    })
    const known = new Set(values.stops.map((st) => st.id))
    const legCarriers = carriersSet.map((s) => ({ id: s.slot, legStopIds: s.legStopIds.filter((id) => known.has(id)), carrierName: slotName(s, slots.indexOf(s)) }))
    carriersSet.forEach((s) => {
      if (s.legStopIds.some((id) => !known.has(id))) push('carrier', `legs:${s.slot}`, 'section-carrier-tracking', slotName(s, slots.indexOf(s)), `${slotName(s, slots.indexOf(s))} covers a stop that was removed; pick its stops again.`)
    })
    validateLegs(legCarriers, values.stops.map((st, i) => ({ id: st.id, sequence: i }))).warnings
      .forEach((w, n) => push('carrier', `legs:uncovered:${n}`, 'section-carrier-tracking', 'Stops', w, 'warn'))
  }
  const pctSum = slots.reduce((sum, s) => sum + (s.rate.rateType === 'PCT_OF_CUSTOMER' && Number(s.rate.payPct) > 0 ? Number(s.rate.payPct) : 0), 0)
  if (pctSum > 100) push('rates', 'pctOver100', LABEL.rates.payPct.testId, LABEL.rates.payPct.text, `Carrier pay percentages add up to ${pctSum}% of the customer linehaul.`, 'warn')
  if (values.ship.temp.on) {
    const min = parseInteger(values.ship.temp.min)
    const max = parseInteger(values.ship.temp.max)
    if (min !== undefined && max !== undefined && min > max) push('shipping', 'temp', LABEL.shipping.tempMin.testId, LABEL.shipping.tempMin.text, 'Min Temp is above Max Temp.')
  }
  values.customer.emails.forEach((e, i) => {
    if (!empty(e) && !EMAIL.test(e.trim())) push('customer', `email:${i}`, LABEL.customer.email(i + 1).testId, `Email ${i + 1}`, 'Not a valid e-mail address.')
  })
  if (values.more.specialInstructions.length > MAX.specialInstructions) push('more', 'specialInstructions', LABEL.more.specialInstructions.testId, LABEL.more.specialInstructions.text, `${values.more.specialInstructions.length - MAX.specialInstructions} over the ${MAX.specialInstructions} character limit.`)
  if (values.more.bolNotes.length > MAX.bolNotes) push('more', 'bolNotes', LABEL.more.bolNotes.testId, LABEL.more.bolNotes.text, `${values.more.bolNotes.length - MAX.bolNotes} over the ${MAX.bolNotes} character limit.`, 'warn')
  if (values.more.rateConNotes.length > MAX.rateConNotes) push('more', 'rateConNotes', LABEL.more.rateConNotes.testId, LABEL.more.rateConNotes.text, `${values.more.rateConNotes.length - MAX.rateConNotes} over the ${MAX.rateConNotes} character limit.`)

  // Customer's required references (skipped by draftSave).
  if (strictRed && o.customer) {
    for (const req of o.customer.requiredReferences ?? []) {
      if (req.countOnNewOrder < 1) continue
      const code = req.code.trim().toLowerCase()
      const n = (code === 'po' && !empty(values.customer.refNo) ? 1 : 0)
        + (code === 'pickup' && fp >= 0 && !empty(values.stops[fp].refNo) ? 1 : 0)
        + (code === 'delivery' && ld >= 0 && !empty(values.stops[ld].refNo) ? 1 : 0)
        + values.more.references.filter((r) => r.code.trim().toLowerCase() === code && !empty(r.value)).length
      if (n < req.countOnNewOrder) {
        const target = code === 'po' ? LABEL.customer.refNo : null
        push(code === 'po' ? 'customer' : 'more', `ref:${code}`, target?.testId ?? LABEL.more.references.testId, code === 'po' ? LABEL.customer.refNo.text : req.label || req.code, `This customer requires ${req.countOnNewOrder} ${req.label || req.code} reference${req.countOnNewOrder === 1 ? '' : 's'}.`)
      }
    }
  }

  // Every shipment needs its customer ref (PO) before Create, whatever the customer's own settings say. A draft save skips it.
  if (strictRed && empty(values.customer.refNo) && !issues.some((i) => i.id === 'customer:ref:po')) {
    push('customer', 'ref:po', LABEL.customer.refNo.testId, LABEL.customer.refNo.text, 'Enter the customer ref (PO / reference number).')
  }

  // Truckload only for Submit.
  if (submit && !truckload) push('shipping', 'shipmentType:submit', LABEL.shipping.shipmentType.testId, LABEL.shipping.shipmentType.text, 'Only truckload modes can be submitted yet; this one is saved as a draft.')

  // The org + customer required-field list: informational until Submit.
  const required = resolveRequiredFields(o.settings, o.customer)
  const known = new Set(issues.filter((i) => i.severity === 'error').map((i) => `${i.section}:${i.fieldKey}`))
  for (const key of missingRequiredFields(toRequiredFieldSubject(values, o.customer), required)) {
    const t = REQUIRED_KEY_TARGET[key] ?? { section: 'shipping' as SectionKey, fieldKey: LABEL.shipping.shipmentType.testId }
    if (known.has(`${t.section}:${t.fieldKey}`)) continue
    push(t.section, `needs:${key}`, t.fieldKey, requiredFieldLabel(key), `Needs: ${requiredFieldLabel(key)}`, submit ? 'error' : 'warn')
  }
  return issues
}

export const blockingIssues = (issues: readonly FormIssue[]): FormIssue[] => issues.filter((i) => i.severity === 'error')

export function issuesForSection(issues: readonly FormIssue[], key: SectionKey): FormIssue[] {
  return issues.filter((i) => i.section === key)
}

/** "3 required fields missing — Equipment, Weight, Description"; empty when nothing blocks. */
export function issueSummary(issues: readonly FormIssue[]): string {
  const blocking = blockingIssues(issues)
  if (blocking.length === 0) return ''
  const labels = [...new Set(blocking.map((i) => i.label))]
  return `${blocking.length} required field${blocking.length === 1 ? '' : 's'} missing — ${labels.join(', ')}`
}

export { SECTION_TITLE }
