/**
 * Company identity for anything that leaves the building — PDFs sent to drivers,
 * insurers, brokers and auditors.
 *
 * One constant because it was already drifting: both pay statements said IVAN CARTAGE
 * while the file packet said BCAT, so two documents about the same driver carried two
 * different carrier names.
 */
export const COMPANY_NAME = 'IVAN CARTAGE'

/** Sits under the company name on a document header, naming the document itself. */
export const documentSubtitles = {
  driverFile: 'Driver File',
  truckFile:  'Vehicle File',
} as const

/** Header band — black bar, white type, matching the pay statements. */
export const BRAND_BAND = {
  height: 92,
  background: { r: 0, g: 0, b: 0 },
  text:       { r: 1, g: 1, b: 1 },
  muted:      { r: 0.85, g: 0.85, b: 0.85 },
} as const
