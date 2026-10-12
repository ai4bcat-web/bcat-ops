/**
 * Where a load's paperwork physically is at the end of the driver's day.
 *
 * A pickup leaves a BOL in somebody's hands. Before an Ivan driver clocks out, the app asks
 * where it went: the passenger seat of a truck, the shed, or the trailer, so the office
 * (and the next driver) can find it. Pure rules here; the driver API writes the answer on
 * the Load, and the app and the load drawer read it back.
 */

export type PaperworkPlace = 'TRUCK' | 'SHED' | 'TRAILER' | 'UNKNOWN'

export interface PaperworkLocation {
  /** UNKNOWN only when a driver confirmed or lost paperwork nobody had filed a place for. */
  kind: PaperworkPlace
  /** Truck or trailer unit number, when it applies. */
  unit?: string | null
  at: string
  byDriverId?: string | null
  byName?: string | null
  /** Start of the next day: the delivering driver confirmed they have it in hand. */
  inHandAt?: string | null
  inHandBy?: string | null
  /** …or said they could not find it. */
  missingAt?: string | null
  missingBy?: string | null
}

export const PAPERWORK_PLACE_LABEL: Record<Exclude<PaperworkPlace, 'UNKNOWN'>, string> = {
  TRUCK: 'Passenger seat',
  SHED: 'In the shed',
  TRAILER: 'In the trailer',
}

/** "Passenger seat of truck 3114" / "In the shed" / "In trailer 5302". */
export function paperworkLocationLabel(loc: Pick<PaperworkLocation, 'kind' | 'unit'> | null | undefined): string {
  if (!loc) return ''
  const unit = (loc.unit ?? '').trim()
  switch (loc.kind) {
    case 'TRUCK': return unit ? `Passenger seat of truck ${unit}` : 'Passenger seat'
    case 'TRAILER': return unit ? `In trailer ${unit}` : 'In the trailer'
    case 'SHED': return 'In the shed'
    default: return 'Not recorded'
  }
}

/** "Picked up by Jason this morning" / "Jason could not find it" / the place, for cards. */
export function paperworkStatusLine(loc: PaperworkLocation | null | undefined): string | null {
  if (!loc) return null
  if (loc.missingAt && (!loc.inHandAt || loc.missingAt > loc.inHandAt)) return `${loc.missingBy ?? 'Driver'} could not find it`
  if (loc.inHandAt) return `${loc.inHandBy ?? 'Driver'} has it${loc.kind !== 'UNKNOWN' ? ` (was: ${paperworkLocationLabel(loc).toLowerCase()})` : ''}`
  return paperworkLocationLabel(loc)
}

/**
 * The place in a few characters, for a column: "Seat 3114" / "Shed" / "Trailer 5302",
 * then "In hand" once the next driver confirmed it and "Missing" if they could not find it.
 * Null when nothing has been filed. The long form (paperworkStatusLine) goes in the title.
 */
export function paperworkShortLabel(loc: PaperworkLocation | null | undefined): string | null {
  if (!loc) return null
  if (loc.missingAt && (!loc.inHandAt || loc.missingAt > loc.inHandAt)) return 'Missing'
  if (loc.inHandAt) return 'In hand'
  const unit = (loc.unit ?? '').trim()
  switch (loc.kind) {
    case 'TRUCK': return unit ? `Seat ${unit}` : 'Seat'
    case 'TRAILER': return unit ? `Trailer ${unit}` : 'Trailer'
    case 'SHED': return 'Shed'
    default: return 'Not recorded'
  }
}

/** Clean what the app sent; null when it is not a usable answer. */
export function normalizePaperworkLocation(input: { kind?: unknown; unit?: unknown }): { kind: PaperworkPlace; unit: string | null } | null {
  const kind = String(input.kind ?? '').toUpperCase()
  if (kind !== 'TRUCK' && kind !== 'SHED' && kind !== 'TRAILER') return null
  const unit = typeof input.unit === 'string' ? input.unit.trim().slice(0, 20) : ''
  if (kind === 'SHED') return { kind, unit: null }
  if (!unit) return null   // a truck or trailer without a number is not a place
  return { kind, unit }
}

export interface PickupLike {
  id: string
  reference: string
  trailerNumber?: string | null
  paperworkLocation?: PaperworkLocation | null
  /** A POD on file means the trip is done and the paperwork went with it. */
  pod?: { present: boolean } | null
  stops: Array<{ type: string; date: string | null; yours: boolean; name: string | null; arrivedAt?: string | null; departedAt?: string | null }>
}

/** Delivered: every delivery stop departed, or a POD on file. Nothing about its paperwork is still a question. */
export function tripDelivered(load: Pick<PickupLike, 'pod' | 'stops'>): boolean {
  if (load.pod?.present) return true
  const deliveries = load.stops.filter((s) => s.type.toLowerCase() === 'delivery')
  return deliveries.length > 0 && deliveries.every((s) => !!s.departedAt)
}

/**
 * Start of day: the loads this driver delivers today whose pickup already happened on an
 * earlier day, and which nobody has confirmed as in hand today. The driver says "I have
 * it" (or "can't find it") before clocking in, so a BOL left in the shed is not discovered
 * missing at the customer's dock.
 */
export function deliveriesNeedingPaperworkConfirm<L extends PickupLike>(loads: readonly L[], today: string): Array<{ load: L; deliveryName: string | null; where: string | null }> {
  const out: Array<{ load: L; deliveryName: string | null; where: string | null }> = []
  for (const load of loads) {
    const delivery = load.stops.find((s) => s.type.toLowerCase() === 'delivery' && s.yours && s.date === today && !s.arrivedAt && !s.departedAt)
    if (!delivery) continue
    const pickedUpToday = load.stops.some((s) => s.type.toLowerCase() === 'pickup' && (s.date === today || (s.departedAt ?? '').startsWith(today)))
    if (pickedUpToday) continue   // the end-of-day question covers it
    const pl = load.paperworkLocation
    if (pl?.inHandAt?.startsWith(today) || pl?.missingAt?.startsWith(today)) continue
    out.push({ load, deliveryName: delivery.name, where: pl && pl.kind !== 'UNKNOWN' ? paperworkLocationLabel(pl) : null })
  }
  return out
}

/**
 * The loads this driver picked up today that still have no paperwork answer. "Picked up"
 * means a pickup of theirs dated today, or one they actually arrived at today whatever
 * the appointment said. A load already delivered (POD in, or the delivery departed) is
 * not asked about: its paperwork went to the consignee, and asking where it is kept
 * drivers from clocking out.
 */
export function pickupsNeedingPaperworkLocation<L extends PickupLike>(loads: readonly L[], today: string): Array<{ load: L; pickupName: string | null }> {
  const out: Array<{ load: L; pickupName: string | null }> = []
  for (const load of loads) {
    if (load.paperworkLocation) continue
    if (tripDelivered(load)) continue
    const pickup = load.stops.find((s) => s.type.toLowerCase() === 'pickup' && s.yours && (s.date === today || (s.arrivedAt ?? '').startsWith(today) || (s.departedAt ?? '').startsWith(today)))
    if (pickup) out.push({ load, pickupName: pickup.name })
  }
  return out
}
