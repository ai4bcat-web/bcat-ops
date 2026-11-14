/**
 * Who covers an Ivan Cartage (own fleet) load, for the "Covered by" card in Carrier & Tracking (Ryne 2026-11-14:
 * "make it a cool ui that shows covered by ivan local drivers or covered by owner operators").
 *
 * The driver's own record decides, through `driverOwnershipKind` (fleet group first, then the older driverType), so
 * this never disagrees with the calendar, the settlements pages or the ownership resolver. When the driver says
 * nothing (no fleet, no type) or no driver is picked yet, the shipment's revenue division stands in: a load tagged
 * Owner Operators / Box Trucks / Local Drivers is covered by that group. ASSETS ("Ivan Cartage") names no group.
 *
 * Pure: no store, no clock.
 */
import { driverOwnershipKind, type DriverOwnershipInputs } from './driverOwnership'
import { sundayOf } from './odometerWeek'

export type OwnFleetCoverKind = 'OWNER_OPERATOR' | 'LOCAL' | 'BOX_TRUCK'

export const OWN_FLEET_COVER_LABEL: Record<OwnFleetCoverKind, string> = {
  OWNER_OPERATOR: 'Owner Operator',
  LOCAL: 'Local Driver',
  BOX_TRUCK: 'Box Truck',
}

/** Revenue division codes (OwnershipDivision.code) that name one of the groups. */
const DIVISION_KIND: Record<string, OwnFleetCoverKind> = {
  OWNER_OPERATOR: 'OWNER_OPERATOR',
  LOCAL: 'LOCAL',
  BOX_TRUCK: 'BOX_TRUCK',
}

export function ownFleetCoverKind(
  driver: DriverOwnershipInputs | null | undefined,
  revDivision?: string | null,
): OwnFleetCoverKind | null {
  const kind = driver ? driverOwnershipKind(driver) : null
  if (kind === 'OWNER_OPERATOR' || kind === 'BOX_TRUCK' || kind === 'LOCAL') return kind
  // COMPANY is the old driverType for an Ivan employee: a local driver.
  if (kind === 'COMPANY') return 'LOCAL'
  return DIVISION_KIND[(revDivision ?? '').trim().toUpperCase()] ?? null
}

/** "Covered by Ivan Cartage · Owner Operator", or just "Covered by Ivan Cartage" when the group is unknown. */
export function ownFleetCoverTitle(kind: OwnFleetCoverKind | null): string {
  return kind ? `Covered by Ivan Cartage · ${OWN_FLEET_COVER_LABEL[kind]}` : 'Covered by Ivan Cartage'
}

/** "CS" from "Chad Salerno"; one letter for a one-word name; '' for none. */
export function driverInitials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase()
}

/** "14 min ago" / "3 h ago" / "2 d ago"; null when unknown. */
export function pingAgeText(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes)) return null
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / (24 * 60))} d ago`
}

/**
 * The owner-operator settlement week that pays this load: the Sun–Sat week of its delivery appointment, the same
 * date `ownerOpTripsFor` files the trip under. Null without a driver or a delivery date.
 */
export function driverSettlementHref(driverId: string | null | undefined, deliveryAppt: string | null | undefined): string | null {
  const date = (deliveryAppt ?? '').slice(0, 10)
  if (!driverId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const p = new URLSearchParams({ week: sundayOf(date), driver: driverId })
  return `/owner-operator-pay?${p.toString()}`
}
