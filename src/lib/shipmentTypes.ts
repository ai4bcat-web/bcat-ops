/**
 * The shipment-type list (Ryne's feedback 7, Step AR). One constant read by the create
 * form's Freight card, the Shipments board column and filter, the Intake extractor and
 * the quote → shipment path, so a type added here shows up in all four.
 *
 * `Order.mode` stays the coarse stored `ShipmentMode`; the fine type lives in
 * `Order.specialRequirements.form.shipmentType` (a key from this list). `legacyModeOf`
 * and `typeOfLegacyMode` convert between the two. Pure, no imports beyond types, so the
 * Lambda can import it too.
 */
import type { ShipmentMode } from '../types/tms'
import type { FlagKey } from '../features/shipments/form/model'

/** A chip on the Freight card: a requirement flag, or one of the chips with their own field. */
export type TypeChipKey = FlagKey | 'tarps' | 'liftgate' | 'inside' | 'tempControl' | 'palletExchange'

export type ShipmentTypeGroup = 'Truckload' | 'Less than truckload' | 'Intermodal and international' | 'Specialized' | 'Other'

export interface ShipmentTypeDef {
  /** Stable key stored in `specialRequirements.form.shipmentType`. Never rename one. */
  key: string
  label: string
  group: ShipmentTypeGroup
  /** Equipment picked when the type is chosen; the user can change it. */
  defaultEquipment?: string
  /** Requirement chips switched on when the type is chosen; the user can change them. */
  defaultChips?: readonly TypeChipKey[]
  /** The stored `ShipmentMode` this type is saved under. */
  mode: ShipmentMode
}

export const SHIPMENT_TYPES: readonly ShipmentTypeDef[] = [
  { key: 'FTL', label: 'Truckload (FTL)', group: 'Truckload', mode: 'FTL' },
  { key: 'LTL', label: 'LTL', group: 'Less than truckload', mode: 'LTL' },
  { key: 'PARTIAL', label: 'Partial / Volume', group: 'Less than truckload', mode: 'PTL' },
  { key: 'EXPEDITED', label: 'Expedited', group: 'Truckload', mode: 'FTL', defaultChips: ['hot'] },
  { key: 'HOT_SHOT', label: 'Hot shot', group: 'Truckload', mode: 'FTL', defaultEquipment: 'Hotshot', defaultChips: ['hot'] },
  { key: 'TEAM', label: 'Team', group: 'Truckload', mode: 'FTL', defaultChips: ['team'] },
  { key: 'POWER_ONLY', label: 'Power only', group: 'Truckload', mode: 'FTL', defaultEquipment: 'Power Only' },
  { key: 'DRAYAGE', label: 'Drayage', group: 'Intermodal and international', mode: 'DRAYAGE', defaultEquipment: 'Container' },
  { key: 'INTERMODAL', label: 'Intermodal (rail)', group: 'Intermodal and international', mode: 'INTERMODAL', defaultEquipment: 'Container' },
  { key: 'RAIL_CARLOAD', label: 'Rail carload', group: 'Intermodal and international', mode: 'RAIL' },
  { key: 'AIR', label: 'Air freight', group: 'Intermodal and international', mode: 'AIR' },
  { key: 'OCEAN_FCL', label: 'Ocean FCL', group: 'Intermodal and international', mode: 'OCEAN', defaultEquipment: 'Container' },
  { key: 'OCEAN_LCL', label: 'Ocean LCL', group: 'Intermodal and international', mode: 'OCEAN' },
  { key: 'AUTO_OPEN', label: 'Auto transport (open)', group: 'Specialized', mode: 'FTL', defaultEquipment: 'Auto carrier' },
  { key: 'AUTO_ENCLOSED', label: 'Auto transport (enclosed)', group: 'Specialized', mode: 'FTL', defaultEquipment: 'Enclosed auto carrier' },
  { key: 'HEAVY_HAUL', label: 'Heavy haul / Oversize', group: 'Specialized', mode: 'FTL', defaultEquipment: 'Step Deck', defaultChips: ['oversized', 'permits'] },
  { key: 'FLATBED_SPECIALIZED', label: 'Flatbed specialized', group: 'Specialized', mode: 'FTL', defaultEquipment: 'Flatbed', defaultChips: ['tarps', 'strapsChains'] },
  { key: 'REEFER', label: 'Refrigerated / Reefer', group: 'Specialized', mode: 'FTL', defaultEquipment: 'Reefer', defaultChips: ['tempControl'] },
  { key: 'HAZMAT', label: 'Hazmat', group: 'Specialized', mode: 'FTL', defaultChips: ['hazmat'] },
  { key: 'FINAL_MILE', label: 'Final mile', group: 'Less than truckload', mode: 'LTL', defaultEquipment: 'Box Truck', defaultChips: ['liftgate', 'inside'] },
  { key: 'DEDICATED', label: 'Dedicated', group: 'Truckload', mode: 'FTL' },
  { key: 'XBORDER_MX', label: 'Cross-border (Mexico)', group: 'Intermodal and international', mode: 'FTL', defaultChips: ['customsBonded'] },
  { key: 'XBORDER_CA', label: 'Cross-border (Canada)', group: 'Intermodal and international', mode: 'FTL', defaultChips: ['customsBonded'] },
  { key: 'COURIER', label: 'Courier / Parcel', group: 'Less than truckload', mode: 'LTL' },
  { key: 'OTHER', label: 'Other', group: 'Other', mode: 'FTL' },
]

const BY_KEY: ReadonlyMap<string, ShipmentTypeDef> = new Map(SHIPMENT_TYPES.map((t) => [t.key, t]))

export const SHIPMENT_TYPE_KEYS: readonly string[] = SHIPMENT_TYPES.map((t) => t.key)

export function isShipmentTypeKey(value: unknown): value is string {
  return typeof value === 'string' && BY_KEY.has(value)
}

export function shipmentTypeOf(key: string | null | undefined): ShipmentTypeDef | null {
  return key ? BY_KEY.get(key) ?? null : null
}

/** The label for a key; an unknown or empty key reads as the key itself (or '' when empty). */
export function shipmentTypeLabel(key: string | null | undefined): string {
  return shipmentTypeOf(key)?.label ?? key ?? ''
}

/**
 * The type a new shipment starts in, per division. Owner operators start in Power only
 * (spec); every other division, including an unknown or empty one, starts in FTL.
 */
export function defaultTypeForDivision(divisionCode: string | null | undefined): string {
  switch (divisionCode) {
    case 'CAR_SHIPPING': return 'AUTO_OPEN'
    case 'OWNER_OPERATOR': return 'POWER_ONLY'
    default: return 'FTL' // BROKERAGE, ASSETS (Ivan Cartage), anything else
  }
}

/** The stored `Order.mode` for a type key. An unknown key falls back to FTL. */
export function legacyModeOf(typeKey: string | null | undefined): ShipmentMode {
  return shipmentTypeOf(typeKey)?.mode ?? 'FTL'
}

/** First type per stored mode: the type to show for an order that has no explicit type. */
const TYPE_OF_MODE: Readonly<Record<ShipmentMode, string>> = {
  FTL: 'FTL',
  PTL: 'PARTIAL',
  BULK: 'OTHER',
  DRAYAGE: 'DRAYAGE',
  INTERMODAL: 'INTERMODAL',
  RLTL: 'LTL',
  LTL: 'LTL',
  AIR: 'AIR',
  OCEAN: 'OCEAN_FCL',
  RAIL: 'RAIL_CARLOAD',
}

/** The type key for a stored mode (no explicit type chosen). Unknown / empty mode → FTL. */
export function typeOfLegacyMode(mode: string | null | undefined): string {
  return (mode && (TYPE_OF_MODE as Record<string, string>)[mode]) || 'FTL'
}

/** The explicit type if it is a known key, else the one derived from the stored mode. */
export function effectiveShipmentType(typeKey: string | null | undefined, mode: string | null | undefined): string {
  return isShipmentTypeKey(typeKey) ? typeKey : typeOfLegacyMode(mode)
}
