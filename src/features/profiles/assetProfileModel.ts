/**
 * The pure side of the Asset profiles (trucks and trailers): what the list shows, how an asset's
 * documents and dates are read, and what the new-asset wizard checks. Every value comes from the
 * Equipment record, its ComplianceDocuments and the drivers, the same sources the Trucks page and
 * Asset documents page read, so the profile and those pages can never disagree.
 */
import type { Driver } from '@/types'
import type { ComplianceDocument } from '@/types'
import type { Equipment, EquipmentType, FleetGroup } from '@/types/equipment'
import { effectiveExpiration, TRUCK_DOC_SPECS } from '@/lib/truckDocs'
import { readyScore, slotsForAsset, truckSlotState, visibleSlots, type FileSlot, type SlotState } from '@/lib/fileHub'
import { driverForTruck } from '@/lib/assignments'
import { driversHoldingTrailer } from '@/lib/fleetActive'
import { summarizeScore, type DocsSummary } from './driverProfileModel'

export type AssetTab = 'truck' | 'trailer'

/** Equipment keeps the fleets its profitability grouping uses; Amazon stays Amazon here. */
export const ASSET_FLEET_OPTIONS: Array<{ value: FleetGroup; label: string }> = [
  { value: 'LOCAL', label: 'Local' },
  { value: 'BOX_TRUCK', label: 'Box truck' },
  { value: 'AMAZON', label: 'Amazon' },
]

export function assetFleetLabel(fleet: string | null | undefined): string {
  if (!fleet) return 'Unassigned'
  return ASSET_FLEET_OPTIONS.find((o) => o.value === fleet)?.label ?? fleet
}

export const OWNERSHIP_LABEL: Record<string, string> = { owned: 'Owned', leased: 'Leased', rented: 'Rented', financed: 'Financed' }

export const assetNoun = (type: EquipmentType) => (type === 'trailer' ? 'Trailer' : 'Truck')
export const assetTitle = (e: Pick<Equipment, 'type' | 'unitNumber'>) => `${assetNoun(e.type)} ${e.unitNumber}`
export const makeModel = (e: Pick<Equipment, 'year' | 'make' | 'model'>) => [e.year, e.make, e.model].filter(Boolean).join(' ')

export interface AssetDates { dot?: string; ins?: string; ifta?: string; irp?: string; bobtail?: string }

type DocFor = (entityType: 'TRUCK', entityId: string, documentType: string) => ComplianceDocument | undefined

/** The dated items an asset carries, resolved across the uploaded certificate and the date typed on the record. */
export function assetDates(e: Equipment, docFor: DocFor): AssetDates {
  return {
    dot: e.dotInspectionDate ?? undefined,
    ins: effectiveExpiration(docFor('TRUCK', e.id, 'insurance_cert'), e.insuranceExpirationDate).date,
    ifta: e.type === 'truck' ? effectiveExpiration(docFor('TRUCK', e.id, 'ifta_decals'), e.iftaExpirationDate).date : undefined,
    irp: e.type === 'truck' ? effectiveExpiration(docFor('TRUCK', e.id, 'irp_cab_card'), e.irpExpirationDate).date : undefined,
    bobtail: e.bobtailInsuranceDate,
  }
}

/** The slots one asset must have on file (the same catalog Asset documents and Files use). */
export const assetSlots = (type: EquipmentType, fleet: FleetGroup | null | undefined, canSeePrivate: boolean): readonly FileSlot[] =>
  visibleSlots(slotsForAsset(type, fleet), canSeePrivate)

/** An asset's document status, from the same slots and rules the Asset documents page uses. */
export function assetDocsSummary(e: Equipment, docFor: DocFor, canSeePrivate: boolean): DocsSummary {
  return summarizeScore(readyScore(assetSlots(e.type, e.fleetGroup, canSeePrivate), (key) => truckSlotState(e, key, docFor('TRUCK', e.id, key))))
}

export const assetSlotState = (e: Equipment, docFor: DocFor) => (key: string): SlotState => truckSlotState(e, key, docFor('TRUCK', e.id, key))

/** DOT's date lives on the record, never on the document, so an upload does not ask for it. */
export const slotAsksExpiry = (slot: FileSlot): boolean => Boolean(slot.expires) && !TRUCK_DOC_SPECS.find((s) => s.key === slot.key)?.dot

/** Who has this asset: a truck's driver, or the drivers pulling this trailer. */
export function assignedTo(e: Equipment, drivers: readonly Driver[]): Driver[] {
  if (e.type === 'truck') {
    const d = driverForTruck(e.id, drivers as Driver[])
    return d ? [d] : []
  }
  return driversHoldingTrailer(e.id, drivers)
}

/** The next PM is due 25,000 miles after the last one (the Trucks page's rule). */
export const PM_INTERVAL_MILES = 25000
export const nextPmMileage = (e: Pick<Equipment, 'lastPmMileage'>): number | null => (e.lastPmMileage != null ? e.lastPmMileage + PM_INTERVAL_MILES : null)

// ── New-asset wizard ───────────────────────────────────────────────────────────

export interface AssetBasicsInput {
  unitNumber: string; make: string; model: string; year: string; vin: string; plate: string
  dotInspectionDate?: string; insuranceExpirationDate?: string; iftaExpirationDate?: string; irpExpirationDate?: string
}

/** What blocks "Next" on the Basics step: a field → message map, empty when fine. */
export function assetBasicsErrors(b: AssetBasicsInput, existingUnits: readonly string[]): Partial<Record<keyof AssetBasicsInput, string>> {
  const errors: Partial<Record<keyof AssetBasicsInput, string>> = {}
  const unit = b.unitNumber.trim()
  if (!unit) errors.unitNumber = 'Enter the unit number.'
  else if (existingUnits.some((u) => u.trim().toLowerCase() === unit.toLowerCase())) errors.unitNumber = 'That unit number is already in use.'
  if (b.year.trim() && !/^\d{4}$/.test(b.year.trim())) errors.year = 'Use a 4-digit year.'
  const vin = b.vin.replace(/\s/g, '')
  if (vin && vin.length !== 17) errors.vin = 'A VIN is 17 characters.'
  for (const key of ['dotInspectionDate', 'insuranceExpirationDate', 'iftaExpirationDate', 'irpExpirationDate'] as const) {
    const v = (b[key] ?? '').trim()
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[key] = 'Pick a date.'
  }
  return errors
}
