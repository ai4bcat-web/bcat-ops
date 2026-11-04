/**
 * The rules the Spot inbox enforces in the browser, kept apart from the components: what
 * blocks Create, what the auto-send dialog has to say, and how an edited field form becomes
 * a patch. (The server re-checks all of it.)
 */
import type { SpotEquipmentCode, SpotExtraction, SpotRequestMode, SpotStop } from '@/lib/spot/types'
import type { SpotPricing } from './useSpotPricing'
import { dollarsToCents, spotEnds } from './spotHelpers'

export interface RateBlock {
  rateCents: number | null
  belowFloor: boolean
  needsStubAck: boolean
  /** Why Create is disabled, or null when the rep may go ahead. */
  reason: string | null
}

export function rateBlock(pricing: SpotPricing, rateText: string, isManager: boolean, stubAck: boolean): RateBlock {
  const rateCents = dollarsToCents(rateText)
  const s = pricing.suggestion
  const belowFloor = !!s && rateCents != null && rateCents < s.floorSellCents
  const needsStubAck = !!(s?.stub || pricing.market?.answer.stub)
  let reason: string | null = null
  if (rateCents == null) reason = 'Enter the rate you are quoting.'
  else if (belowFloor && !isManager) reason = 'That rate is below the floor margin; a manager has to quote it.'
  else if (needsStubAck && !stubAck) reason = 'Tick the box: the market number is a stub and you are pricing this yourself.'
  return { rateCents, belowFloor, needsStubAck, reason }
}

/** Every condition that must hold before a reply leaves without a person (plan §4.7), in plain words. */
export const AUTO_SEND_GATES: readonly string[] = [
  'An admin has allowed auto-send for the whole company, and you have switched it on.',
  'The sender is an existing, active customer, matched by their exact e-mail address — never a prospect, never a guess from the domain.',
  'You own the account, and the customer has agreed to automatic replies.',
  'Every required field was read with high confidence, it is a full truckload, with no accessorials or special handling.',
  'The price comes from live DAT data, or from at least five of our own loads on that lane — never from a simulated market price — and is at or above the floor.',
  'The sender’s e-mail passes SPF and DKIM checks, and it is a brand-new thread with a reply address.',
  'You have not reached the daily limit per rep or per customer.',
  'It is never sent from the dev stack: there the reply becomes a draft instead.',
]

/** The first word of the rep's address: `jane.doe@…` → `jane`. */
export const firstNameOf = (email: string): string => (email.split('@')[0] ?? '').split(/[._+-]/)[0] ?? ''


export interface Form {
  oCity: string; oState: string; oZip: string; pickupDate: string
  dCity: string; dState: string; dZip: string; deliveryDate: string
  equipmentType: string; lengthFt: string; weightLbs: string; commodity: string; mode: string
  accessorials: string[]
}

export function formFrom(e: SpotExtraction | null | undefined): Form {
  const { origin, destination } = spotEnds(e)
  return {
    oCity: origin?.city ?? '', oState: origin?.state ?? '', oZip: origin?.zip ?? '', pickupDate: e?.pickupDate ?? '',
    dCity: destination?.city ?? '', dState: destination?.state ?? '', dZip: destination?.zip ?? '', deliveryDate: e?.deliveryDate ?? '',
    equipmentType: e?.equipmentType ?? '', lengthFt: e?.lengthFt != null ? String(e.lengthFt) : '',
    weightLbs: e?.weightLbs != null ? String(e.weightLbs) : '', commodity: e?.commodity ?? '', mode: e?.mode ?? '',
    accessorials: e?.accessorials ?? [],
  }
}

const blank = (v: string): string | null => (v.trim() === '' ? null : v.trim())
const num = (v: string): number | null => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

/** Only the fields the rep actually changed, in the shape `SPOT_UPDATE_FIELDS` takes. */
export function patchFromForm(e: SpotExtraction | null | undefined, form: Form): Partial<SpotExtraction> {
  const before = formFrom(e)
  const patch: Partial<SpotExtraction> = {}
  const laneChanged = (['oCity', 'oState', 'oZip', 'dCity', 'dState', 'dZip'] as const).some((k) => form[k] !== before[k])
  if (laneChanged) {
    const stops: SpotStop[] = [...(e?.stops ?? [])]
    const edit = (type: 'PICKUP' | 'DELIVERY', city: string, state: string, zip: string) => {
      const idx = type === 'PICKUP'
        ? stops.findIndex((s) => s.type === 'PICKUP')
        : stops.map((s) => s.type).lastIndexOf('DELIVERY')
      const next = { city: blank(city), state: blank(state)?.toUpperCase() ?? null, zip: blank(zip) }
      if (idx >= 0) stops[idx] = { ...stops[idx], ...next }
      else stops.push({ type, name: null, dateStr: null, time: null, ...next })
    }
    edit('PICKUP', form.oCity, form.oState, form.oZip)
    edit('DELIVERY', form.dCity, form.dState, form.dZip)
    patch.stops = stops
  }
  if (form.pickupDate !== before.pickupDate) patch.pickupDate = blank(form.pickupDate)
  if (form.deliveryDate !== before.deliveryDate) patch.deliveryDate = blank(form.deliveryDate)
  if (form.equipmentType !== before.equipmentType) patch.equipmentType = (blank(form.equipmentType) as SpotEquipmentCode | null)
  if (form.lengthFt !== before.lengthFt) patch.lengthFt = num(form.lengthFt)
  if (form.weightLbs !== before.weightLbs) patch.weightLbs = num(form.weightLbs)
  if (form.commodity !== before.commodity) patch.commodity = blank(form.commodity)
  if (form.mode !== before.mode) patch.mode = blank(form.mode) as SpotRequestMode | null
  if (form.accessorials.join('|') !== before.accessorials.join('|')) patch.accessorials = form.accessorials
  return patch
}

