/**
 * The mapping profile: every categorical decision the import makes, as data. Persisted per layout
 * (AljexMappingProfile, plan §4.2), pre-filled from DEFAULT_ALJEX_PROFILE (ALJEX_MAPPING.md D1..D19
 * defaults), editable in the UI. Pure types + defaults + `findUnmapped`; no I/O.
 */
import type { LoadWorkflowStatus, ShipmentMode, ShipmentStatus } from '../../types/tms'
import { LAYOUT_V1_ID } from './layout'

export type RevDivisionCode = 'ASSETS' | 'BROKERAGE' | 'CAR_SHIPPING' | 'OWNER_OPERATOR'

export interface StatusMapEntry {
  shipment: ShipmentStatus
  load: LoadWorkflowStatus
  /** Voided in Aljex: imported as CANCELED history with void marker. */
  void?: boolean
  /** The file says the freight was delivered. */
  delivered?: boolean
  /** A live movement status (OPEN..CONSIGNEE): promotes its carrier past the activity window. */
  inFlight?: boolean
}

export interface TypeMapEntry {
  mode: ShipmentMode
  /** Division the type code picks (divisionRules rule 2); undefined = falls through. */
  division?: RevDivisionCode
  /** `Type of Shipment` that means a truck-ordered-not-used. */
  tonu?: boolean
}

export interface ChargeMapEntry {
  code: string
  isRate: boolean
  label?: string
}

export interface DivisionRule {
  /** `ownAsset` = carrier is the own-asset carrier; `typeCodes` = Type of Shipment in list; `carrierIds` = carrier id in list; `revType` = the Aljex Rev Type letter equals `revType` (B/I/A/O); `default`. */
  when: 'ownAsset' | 'typeCodes' | 'carrierIds' | 'revType' | 'default'
  division: RevDivisionCode
  typeCodes?: string[]
  carrierIds?: string[]
  revType?: string
}

export interface AljexProfile {
  layoutId: string
  version: number
  /** Upper-cased trimmed Dispatch Status -> mapping. Unmapped values block APPLY. */
  statusMap: Record<string, StatusMapEntry>
  /** Upper-cased `Type of Shipment` -> mode (+ division). Unmapped values block APPLY. */
  typeMap: Record<string, TypeMapEntry>
  /** Aljex Salesrep ID -> Cognito username. Unmapped: field stays null, listed. */
  repMap: Record<string, string>
  /** Aljex dispatcher id -> UserProfile/Cognito id. Unmapped: null, listed. */
  dispatcherMap: Record<string, string>
  /** Normalized charge description (see normalizeLabel) -> BCAT charge code. */
  chargeDescriptionMap: Record<string, ChargeMapEntry>
  /** Regex source: a description matching it is the fuel surcharge (FSC). */
  fuelPattern: string
  /** Projected-expense `Type n` code -> BCAT charge code. */
  projectedTypeMap: Record<string, ChargeMapEntry>
  /** Carrier Safety Rating text -> Carrier.safetyRating enum. */
  safetyRatingMap: Record<string, 'SATISFACTORY' | 'CONDITIONAL' | 'UNSATISFACTORY' | 'NONE' | 'UNKNOWN'>
  /** Stop-block marker -> stop type (D4). */
  stopMarkerMap: Record<string, 'pickup' | 'delivery'>
  /** Payment method by check-number shape (D12). */
  paymentMethodByCheckShape: { numeric: string; alpha: string; blank: string }
  /** Plausible date window (YYYY-MM-DD); null = derive from the file (min/max Created Date +- 1 year). */
  window: { start: string; end: string } | null
  /** Case-insensitive substring of the normalized carrier name that marks an own-asset (Ivan Cartage) leg (D1). */
  ownAssetCarrierMatch: string
  /** Carrier ids/MCs that mean Owner Operators (rule 3), empty until Ryne supplies it. */
  ownerOperatorCarrierIds: string[]
  divisionRules: DivisionRule[]
  /** Carrier activity window (DECIDED-7): months before the anchor; anchor null = newest plausible ship date in the file. */
  carrierWindowMonths: number
  carrierCutoffDate: string | null
  /** Optional: delivered, un-invoiced freight shipped before this date goes to LEGACY. No date assumed (DECIDED-3). */
  unbilledLegacyBefore: string | null
}

const S = (shipment: ShipmentStatus, load: LoadWorkflowStatus, rest: Partial<StatusMapEntry> = {}): StatusMapEntry => ({
  shipment,
  load,
  ...rest,
})

const ft = (mode: ShipmentMode, division?: RevDivisionCode, tonu?: boolean): TypeMapEntry => ({
  mode,
  ...(division ? { division } : {}),
  ...(tonu ? { tonu } : {}),
})

const C = (code: string, isRate = false, label?: string): ChargeMapEntry => ({ code, isRate, ...(label ? { label } : {}) })

/** Lower-case, collapse non-alphanumerics: the key of chargeDescriptionMap / label comparisons. */
export function normalizeLabel(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export const DEFAULT_ALJEX_PROFILE: AljexProfile = {
  layoutId: LAYOUT_V1_ID,
  version: 1,
  statusMap: {
    OPEN: S('OPEN', 'SOURCING', { inFlight: true }),
    COVERED: S('BOOKED', 'BOOKED', { inFlight: true }),
    DISPATCHED: S('DISPATCHED', 'DISPATCHED', { inFlight: true }),
    LOADED: S('PICKED_UP', 'PICKED_UP', { inFlight: true }),
    PICKUP: S('PICKED_UP', 'PICKED_UP', { inFlight: true }), // 1 row in the 2026-11-07 export (PRO 14917): picked up, not delivered
    CONSIGNEE: S('UNLOADING', 'UNLOADING', { inFlight: true }),
    DELIVERED: S('DELIVERED', 'DELIVERED', { delivered: true }),
    VOID: S('CANCELED', 'CANCELED', { void: true }),
    'VOID WEB': S('CANCELED', 'CANCELED', { void: true }),
  },
  typeMap: {
    FTL: ft('FTL'),
    TL: ft('FTL'),
    FT: ft('FTL'),
    LTL: ft('LTL'),
    AIR: ft('AIR'),
    OCN: ft('OCEAN'),
    R: ft('RAIL'),
    // Vehicle-transport guess (plan §5.6 rule 2, proposed, Ryne to confirm O-5/O-7).
    V: ft('FTL', 'CAR_SHIPPING'),
    VA: ft('FTL', 'CAR_SHIPPING'),
    VH: ft('FTL', 'CAR_SHIPPING'),
    VM: ft('FTL', 'CAR_SHIPPING'),
    VZ: ft('FTL', 'CAR_SHIPPING'),
    // Meaning unknown: FTL, the code is preserved as an order reference (D4b).
    STRA: ft('FTL'),
    ZAK: ft('FTL'),
    F: ft('FTL'),
    PO: ft('FTL'),
    CRGO: ft('FTL'),
    W2W: ft('FTL'),
    W2H: ft('FTL'),
    SD: ft('FTL'),
    DD: ft('FTL'),
    CONE: ft('FTL'),
    HAND: ft('FTL'),
    TORD: ft('FTL', undefined, true),
    // A blank type is an ordinary FTL (9 rows, all unusual: voids/no-customer).
    '': ft('FTL'),
  },
  repMap: {},
  dispatcherMap: {},
  chargeDescriptionMap: {
    'fuel surcharge': C('FSC', true, 'Fuel surcharge'),
    'fuel charge': C('FSC', true, 'Fuel surcharge'),
    fuel: C('FSC', true, 'Fuel surcharge'),
    detention: C('DETENTION'),
    'detention loading': C('DETENTION'),
    'detention unloading': C('DETENTION'),
    layover: C('LAYOVER'),
    'truck ordered not used': C('TONU'),
    'stop off charge': C('STOPOFF'),
    'lumper fee': C('LUMPER'),
    miscellaneous: C('ACCESSORIAL'),
    accessorial: C('ACCESSORIAL'),
    chassis: C('CHASSIS'),
    'storage charges': C('STORAGE'),
    storage: C('STORAGE'),
    'rail storage': C('STORAGE'),
    prepull: C('PREPULL'),
    demurrage: C('DEMURRAGE'),
    warehousing: C('WAREHOUSING'),
    'macropoint acceptance': C('MACROPOINT'),
    'late delivery charge': C('LATE_DELIVERY'),
    labor: C('LABOR'),
    'return product': C('RETURN_PRODUCT'),
    'gate fee': C('GATE_FEE'),
    'inside delivery': C('INSIDE_DELIVERY'),
    'linehaul service': C('LINEHAUL_SERVICE'),
    truckload: C('LINEHAUL_SERVICE'),
  },
  fuelPattern: '^fuel',
  projectedTypeMap: {
    LINE: C('LINEHAUL', true, 'Line haul'),
    FUEL: C('FSC', true, 'Fuel surcharge'),
    FUE: C('FSC', true, 'Fuel surcharge'),
    MAC: C('MACROPOINT'),
    CHAS: C('CHASSIS'),
    STOR: C('STORAGE'),
    DETN: C('DETENTION'),
    DTL: C('DETENTION'),
    PRPL: C('PREPULL'),
    LHS: C('LINEHAUL_SERVICE'),
    MISC: C('ACCESSORIAL'),
    WRHS: C('WAREHOUSING'),
    TORD: C('TONU'),
    STOP: C('STOPOFF'),
    LATE: C('LATE_DELIVERY'),
    LAYO: C('LAYOVER'),
  },
  safetyRatingMap: {
    SATISFACTORY: 'SATISFACTORY',
    CONDITIONAL: 'CONDITIONAL',
    UNSATISFACTORY: 'UNSATISFACTORY',
    NONE: 'NONE',
    '': 'UNKNOWN',
  },
  stopMarkerMap: { P: 'pickup', S: 'delivery' },
  paymentMethodByCheckShape: { numeric: 'CHECK', alpha: 'OTHER', blank: 'CHECK' },
  window: null,
  ownAssetCarrierMatch: 'ivan cartage',
  ownerOperatorCarrierIds: [],
  divisionRules: [
    { when: 'ownAsset', division: 'ASSETS' },
    { when: 'typeCodes', division: 'CAR_SHIPPING', typeCodes: ['V', 'VA', 'VH', 'VM', 'VZ'] },
    { when: 'carrierIds', division: 'OWNER_OPERATOR', carrierIds: [] },
    // Aljex Rev Type (AW-CDE-plan C.5): behind every specific rule above, ahead of the default.
    { when: 'revType', division: 'BROKERAGE', revType: 'B' },
    { when: 'revType', division: 'ASSETS', revType: 'I' },
    { when: 'revType', division: 'CAR_SHIPPING', revType: 'A' },
    { when: 'revType', division: 'OWNER_OPERATOR', revType: 'O' },
    { when: 'default', division: 'BROKERAGE' },
  ],
  carrierWindowMonths: 12,
  carrierCutoffDate: null,
  unbilledLegacyBefore: null,
}

/** Distinct categorical values found while staging, per profile-mapped column. */
export interface DistinctValues {
  /** Upper-cased statusKey values. */
  status: string[]
  /** Upper-cased trimmed Type of Shipment values. */
  typeOfShipment: string[]
  /** Raw Carrier Safety Rating values. */
  safetyRating: string[]
  /** Stop-block markers. */
  stopMarkers: string[]
  /** Salesrep ids / dispatcher ids seen (reported as unmapped, never blocking). */
  salesreps: string[]
  dispatchers: string[]
}

export interface UnmappedValue {
  column: 'status' | 'typeOfShipment' | 'safetyRating' | 'stopMarker' | 'salesrep' | 'dispatcher'
  value: string
  /** Blocking values stop APPLY until mapped; the rest are only listed. */
  blocking: boolean
}

/** Every value the profile has no answer for. Status/type/rating/marker gaps block APPLY; rep/dispatcher gaps are listed. */
export function findUnmapped(profile: AljexProfile, d: DistinctValues): UnmappedValue[] {
  const out: UnmappedValue[] = []
  for (const v of d.status) if (v !== '' && !(v in profile.statusMap)) out.push({ column: 'status', value: v, blocking: true })
  for (const v of d.typeOfShipment) {
    if (isMemoType(v)) continue
    if (!(v in profile.typeMap)) out.push({ column: 'typeOfShipment', value: v, blocking: true })
  }
  for (const v of d.safetyRating) if (!(v.trim().toUpperCase() in profile.safetyRatingMap)) out.push({ column: 'safetyRating', value: v, blocking: false })
  for (const v of d.stopMarkers) if (v !== '' && !(v.trim().toUpperCase() in profile.stopMarkerMap)) out.push({ column: 'stopMarker', value: v, blocking: true })
  for (const v of d.salesreps) if (v !== '' && !(v in profile.repMap)) out.push({ column: 'salesrep', value: v, blocking: false })
  for (const v of d.dispatchers) if (v !== '' && !(v in profile.dispatcherMap)) out.push({ column: 'dispatcher', value: v, blocking: false })
  return out
}

/** `Type of Shipment` values that mark a DEBT/CRED memo row rather than a load. */
export function isMemoType(typeOfShipment: string): boolean {
  const t = typeOfShipment.trim().toUpperCase()
  return t === 'DEBT' || t === 'CRED'
}
