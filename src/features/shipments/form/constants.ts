/**
 * Lists the Aljex-parity shipment form draws from. Where the Aljex screenshots do not show
 * the real list (check-call Message, EDI Reason) the seed below is [INFERENCE] and is meant
 * to be replaced here, in one place, once Ryne sends Aljex's own lists (AH-plan D9).
 */
import type { ShipmentMode } from '@/types/tms'

/** Mode select: Aljex's four. Any other `ShipmentMode` already on a record is preserved read-only. */
export const FORM_MODE_OPTIONS: { value: ShipmentMode; label: string }[] = [
  { value: 'FTL', label: 'Truckload' },
  { value: 'LTL', label: 'LTL' },
  { value: 'AIR', label: 'Air' },
  { value: 'OCEAN', label: 'Ocean' },
]

export const EQUIPMENT_SUGGESTIONS = [
  'Dry Van', 'Reefer', 'Flatbed', 'Step Deck', 'Power Only', 'Container', 'Box Truck', 'Hotshot', 'Conestoga',
] as const

/** NMFC freight classes, Aljex's select. */
export const FREIGHT_CLASSES = [
  '50', '55', '60', '65', '70', '77.5', '85', '92.5', '100', '110', '125', '150', '175', '200', '250', '300', '400', '500',
] as const

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
  'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'ON', 'PE', 'QC', 'SK', 'MX',
] as const

export const COUNTRIES = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'MX', label: 'Mexico' },
] as const

/** Customer / carrier Rate Type select. `PCT_OF_CUSTOMER` is carrier-only ([INFERENCE]: the reading that makes Pay % meaningful). */
export const RATE_KIND_OPTIONS = [
  { value: 'FLAT', label: 'Flat Rate' },
  { value: 'PER_MILE', label: 'Per Mile' },
  { value: 'PER_HOUR', label: 'Per Hour' },
  { value: 'PER_CWT', label: 'Per CWT' },
] as const
export const CARRIER_RATE_KIND_OPTIONS = [
  ...RATE_KIND_OPTIONS,
  { value: 'PCT_OF_CUSTOMER', label: '% of Customer' },
] as const

export const TRI_STATE_OPTIONS = [
  { value: 'na', label: 'N/A' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
] as const

/** Max lengths (Aljex's own counters on the Instructions tab, then the column limits). */
export const MAX = {
  specialInstructions: 420,
  bolNotes: 260,
  rateConNotes: 2000,
  notes: 8000,
  description: 200,
  equipment: 80,
  stopNote: 2000,
  tariff: 60,
  checkCallNote: 1500,
  checkCallNoteTotal: 2000,
  customerEmails: 6,
  shortText: 40,
} as const

/**
 * Check-call Message → what it logs (AH-plan §4.12). `code` is what the note marker carries,
 * `type` is the LoadCheckCall.type, `at` says which stop an ARRIVED/DEPARTED belongs to.
 * [INFERENCE] only "On Time" is visible in the screenshot; the rest is the minimum list that
 * maps onto MANUALLY_LOGGABLE_TYPES. Confirm with Ryne (D9).
 */
export interface CheckCallMessageDef {
  code: string
  label: string
  type: 'LOCATION_UPDATE' | 'ARRIVED' | 'DEPARTED' | 'INCIDENT' | 'NOTE'
  incidentType?: 'ACCIDENT' | 'BREAKDOWN' | 'DELAY'
  stop?: 'first-pickup' | 'last-delivery'
}
export const CHECK_CALL_MESSAGES: readonly CheckCallMessageDef[] = [
  { code: 'ON_TIME', label: 'On Time', type: 'LOCATION_UPDATE' },
  { code: 'EARLY', label: 'Early', type: 'LOCATION_UPDATE' },
  { code: 'LATE', label: 'Late', type: 'LOCATION_UPDATE' },
  { code: 'CHECK_CALL', label: 'Check Call', type: 'LOCATION_UPDATE' },
  { code: 'AT_PICKUP', label: 'At Pickup', type: 'ARRIVED', stop: 'first-pickup' },
  { code: 'LOADED', label: 'Loaded', type: 'DEPARTED', stop: 'first-pickup' },
  { code: 'AT_DELIVERY', label: 'At Delivery', type: 'ARRIVED', stop: 'last-delivery' },
  { code: 'EMPTY', label: 'Empty', type: 'DEPARTED', stop: 'last-delivery' },
  { code: 'DELAY', label: 'Delay', type: 'INCIDENT', incidentType: 'DELAY' },
  { code: 'BREAKDOWN', label: 'Breakdown', type: 'INCIDENT', incidentType: 'BREAKDOWN' },
  { code: 'ACCIDENT', label: 'Accident', type: 'INCIDENT', incidentType: 'ACCIDENT' },
  { code: 'REMARK', label: 'Remark', type: 'NOTE' },
] as const

/** EDI Reason seed: only NS is known from the screenshot (D9). */
export const EDI_REASONS: readonly { code: string; label: string }[] = [
  { code: 'NS', label: 'NORMAL STATUS - NS' },
] as const
