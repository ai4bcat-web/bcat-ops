// Step AQ: an Ivan Cartage (own fleet) load never takes a typed driver.
//
// Pure helpers shared by the TMS UI (the one OwnFleetDriverPicker) and the tms-shipment-actions
// Lambda (bundled by path: relative imports only). The roster is our own Driver table: active,
// real people (no broker placeholders), sorted by name, each carrying the phone, truck # and
// trailer # that selecting the driver fills in. Phone follows Step AK: the truck's work phone,
// else the driver's own number.
import { driverProblem, isBrokerDriver, type RosterDriverFacts } from './ownAssetDriver'
import { prettyPhone } from './dispatch'
import { workPhoneFor, type TruckPhoneRecord } from './workPhone'

/** The carrier name that means "our own fleet". Same test the server uses for typed names. */
export function isIvanCartageName(name: string | null | undefined): boolean {
  return /\bivan\s*cartage\b/i.test(name ?? '')
}

export interface OwnFleetDriverSource extends RosterDriverFacts {
  phone?: string | null
  email?: string | null
  assignedTruckId?: string | null
  assignedTrailerId?: string | null
}
export interface OwnFleetUnit { id: string; unitNumber: string; active?: boolean | null }

export interface OwnFleetDriverOption {
  id: string
  name: string
  email: string
  truckId: string | null
  truckNumber: string
  trailerId: string | null
  trailerNumber: string
  /** E.164 truck work phone (Step AK), '' when the truck has none. */
  workPhone: string
  /** What goes in the driver phone field: the work phone, else the driver's own number, else ''. */
  phone: string
}

/** Active units only: a parked truck or trailer is not offered, so it is never filled in. */
const liveUnit = (units: readonly OwnFleetUnit[], id: string | null | undefined): OwnFleetUnit | null =>
  id ? units.find((u) => u.id === id && u.active !== false) ?? null : null

/** Active, non-broker drivers by name, each with their resolved truck, trailer and phone. */
export function buildOwnFleetRoster(i: {
  drivers: readonly OwnFleetDriverSource[]
  trucks: readonly OwnFleetUnit[]
  trailers: readonly OwnFleetUnit[]
  truckConfig?: (truckId: string) => TruckPhoneRecord | null | undefined
}): OwnFleetDriverOption[] {
  return i.drivers
    .filter((d) => d.active !== false && !isBrokerDriver(d))
    .map((d): OwnFleetDriverOption => {
      const truck = liveUnit(i.trucks, d.assignedTruckId)
      const trailer = liveUnit(i.trailers, d.assignedTrailerId)
      const phones = workPhoneFor({
        driver: { phone: d.phone, assignedTruckId: truck?.id ?? null },
        truck: (id) => i.truckConfig?.(id),
        unitNumber: truck?.unitNumber ?? null,
      })
      return {
        id: d.id,
        name: d.name ?? d.id,
        email: d.email ?? '',
        truckId: truck?.id ?? null,
        truckNumber: truck ? phones.truckNumber ?? truck.unitNumber : '',
        trailerId: trailer?.id ?? null,
        trailerNumber: trailer?.unitNumber ?? '',
        workPhone: phones.work?.number ?? '',
        phone: phones.work?.number ?? phones.personal ?? phones.personalRaw ?? '',
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** "Name · Truck 12 · Trailer 7 · (312) 555-0100": only the parts the record has. */
export function ownFleetOptionLabel(o: OwnFleetDriverOption): string {
  return [
    o.name,
    o.truckNumber && `Truck ${o.truckNumber}`,
    o.trailerNumber && `Trailer ${o.trailerNumber}`,
    o.phone && prettyPhone(o.phone),
  ].filter(Boolean).join(' · ')
}

/** The four driver-info fields (plus ids) a selection fills in. */
export function ownFleetFill(o: OwnFleetDriverOption): {
  driverId: string; driverName: string; driverPhone: string
  truckId: string | null; truckNumber: string; trailerId: string | null; trailerNumber: string
} {
  return {
    driverId: o.id, driverName: o.name, driverPhone: o.phone,
    truckId: o.truckId, truckNumber: o.truckNumber, trailerId: o.trailerId, trailerNumber: o.trailerNumber,
  }
}

/** The roster driver a stored name stands for, only when exactly one active driver has it. */
export function ownFleetDriverByName(roster: readonly OwnFleetDriverOption[], name: string | null | undefined): OwnFleetDriverOption | null {
  const wanted = (name ?? '').trim().toLowerCase()
  if (!wanted) return null
  const hits = roster.filter((d) => d.name.trim().toLowerCase() === wanted)
  return hits.length === 1 ? hits[0] : null
}

// ── Server side ─────────────────────────────────────────────────────────────

export interface ResolvedOwnFleetDriver {
  driverId: string
  driverName: string
  driverPhone: string | null
  truckId: string | null
  truckNumber: string | null
  trailerId: string | null
  trailerNumber: string | null
}

/**
 * The truth for an own-fleet driver: the Driver record, never what the client typed.
 * `asked` is what the caller sent (ids and numbers, all optional): an id or number the caller
 * sent wins over the record's assignment (a one-off swap of truck), a blank is filled from
 * the record. `units` resolves an Equipment id to its unit number (null = unknown).
 * Throws the refusal sentence when the driver is missing, a broker placeholder or inactive.
 */
export function resolveOwnFleetDriver(
  driverId: string,
  driver: (OwnFleetDriverSource & { name?: string | null }) | null | undefined,
  asked: { driverPhone?: string | null; truckId?: string | null; truckNumber?: string | null; trailerId?: string | null; trailerNumber?: string | null },
  units: (equipmentId: string) => string | null,
): ResolvedOwnFleetDriver {
  const problem = driverProblem(driverId, driver)
  if (problem) throw new Error(problem)
  const clean = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null)
  const truckId = clean(asked.truckId) ?? clean(driver!.assignedTruckId)
  const trailerId = clean(asked.trailerId) ?? clean(driver!.assignedTrailerId)
  return {
    driverId,
    driverName: clean(driver!.name) ?? driverId,
    driverPhone: clean(asked.driverPhone) ?? clean(driver!.phone),
    truckId,
    truckNumber: clean(asked.truckNumber) ?? (truckId ? units(truckId) : null),
    trailerId,
    trailerNumber: clean(asked.trailerNumber) ?? (trailerId ? units(trailerId) : null),
  }
}
