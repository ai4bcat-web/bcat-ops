import type { BookingRequiredField, CarrierDocumentType, RateConRequiredField } from '@/types/tms'

/** The document types a broker can demand before a carrier is bookable. */
export const CARRIER_DOC_TYPES: readonly CarrierDocumentType[] = [
  'COI_CARGO',
  'COI_AUTO',
  'COI_GENERAL',
  'W9',
  'CARRIER_AGREEMENT',
  'AUTHORITY',
  'FACTOR_NOA',
  'CDL',
  'OTHER',
]

export const CARRIER_DOC_LABELS: Record<CarrierDocumentType, string> = {
  AUTHORITY: 'Authority letter',
  COI_AUTO: 'COI — auto liability',
  COI_CARGO: 'COI — cargo',
  COI_GENERAL: 'COI — general liability',
  W9: 'W-9',
  CARRIER_AGREEMENT: 'Carrier agreement',
  FACTOR_NOA: 'Factor NOA',
  CDL: 'CDL',
  RATE_CON: 'Rate confirmation',
  OTHER: 'Other',
}

export const BOOKING_FIELDS: readonly BookingRequiredField[] = ['COMMODITY', 'DESCRIPTION', 'VALUE', 'WEIGHT']

export const BOOKING_FIELD_LABELS: Record<BookingRequiredField, string> = {
  COMMODITY: 'Commodity',
  DESCRIPTION: 'Freight description',
  VALUE: 'Cargo value',
  WEIGHT: 'Weight',
}

export const RATE_CON_FIELDS: readonly RateConRequiredField[] = [
  'DRIVER_NAME',
  'DRIVER_PHONE',
  'TRUCK_NUMBER',
  'TRAILER_NUMBER',
  'PICKUP_ETA',
  'PLATES',
  'VIN',
]

export const RATE_CON_FIELD_LABELS: Record<RateConRequiredField, string> = {
  DRIVER_NAME: 'Driver name',
  DRIVER_PHONE: 'Driver phone',
  TRUCK_NUMBER: 'Truck number',
  TRAILER_NUMBER: 'Trailer number',
  PICKUP_ETA: 'Pickup ETA',
  PLATES: 'Plates',
  VIN: 'VIN',
}
