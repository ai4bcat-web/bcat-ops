/**
 * United States census regions for the Aljex-style From/To region filters.
 *
 * The table is plain and complete so the board can map any state suffix a user
 * might type ("Dallas, TX" → TX → SOUTHWEST) without calling a geocoder. Regions
 * follow the Census Bureau grouping; DC is included in NORTHEAST.
 */

export type Region = 'NORTHEAST' | 'SOUTHEAST' | 'MIDWEST' | 'SOUTHWEST' | 'WEST'

export const REGIONS: Region[] = ['NORTHEAST', 'SOUTHEAST', 'MIDWEST', 'SOUTHWEST', 'WEST']

const STATE_TO_REGION: Record<string, Region> = {
  // NORTHEAST
  CT: 'NORTHEAST',
  ME: 'NORTHEAST',
  MA: 'NORTHEAST',
  NH: 'NORTHEAST',
  NJ: 'NORTHEAST',
  NY: 'NORTHEAST',
  PA: 'NORTHEAST',
  RI: 'NORTHEAST',
  VT: 'NORTHEAST',
  DC: 'NORTHEAST',
  // SOUTHEAST
  AL: 'SOUTHEAST',
  AR: 'SOUTHEAST',
  DE: 'SOUTHEAST',
  FL: 'SOUTHEAST',
  GA: 'SOUTHEAST',
  KY: 'SOUTHEAST',
  LA: 'SOUTHEAST',
  MD: 'SOUTHEAST',
  MS: 'SOUTHEAST',
  NC: 'SOUTHEAST',
  SC: 'SOUTHEAST',
  TN: 'SOUTHEAST',
  VA: 'SOUTHEAST',
  WV: 'SOUTHEAST',
  // MIDWEST
  IL: 'MIDWEST',
  IN: 'MIDWEST',
  IA: 'MIDWEST',
  KS: 'MIDWEST',
  MI: 'MIDWEST',
  MN: 'MIDWEST',
  MO: 'MIDWEST',
  NE: 'MIDWEST',
  ND: 'MIDWEST',
  OH: 'MIDWEST',
  SD: 'MIDWEST',
  WI: 'MIDWEST',
  // SOUTHWEST
  AZ: 'SOUTHWEST',
  NM: 'SOUTHWEST',
  OK: 'SOUTHWEST',
  TX: 'SOUTHWEST',
  // WEST
  AK: 'WEST',
  CA: 'WEST',
  CO: 'WEST',
  HI: 'WEST',
  ID: 'WEST',
  MT: 'WEST',
  NV: 'WEST',
  OR: 'WEST',
  UT: 'WEST',
  WA: 'WEST',
  WY: 'WEST',
}

/**
 * Extract a two-letter state code from free text like "Chicago, IL" or "tx",
 * then map it to a census region. Returns null when the input is blank or the
 * state is not recognised.
 */
export function regionOfState(state: string | null | undefined): Region | null {
  if (!state) return null
  const trimmed = state.trim()
  if (!trimmed) return null
  const upper = trimmed.toUpperCase()
  // Direct two-letter code, e.g. "IL" or "tx".
  if (upper.length === 2) return STATE_TO_REGION[upper] ?? null
  // Try to pull a two-letter suffix after a comma or the last word, e.g. "Dallas, TX".
  const afterComma = upper.split(',').pop()?.trim() ?? ''
  if (afterComma.length === 2) return STATE_TO_REGION[afterComma] ?? null
  const lastWord = upper.split(/\s+/).pop()?.trim() ?? ''
  if (lastWord.length === 2) return STATE_TO_REGION[lastWord] ?? null
  return null
}
