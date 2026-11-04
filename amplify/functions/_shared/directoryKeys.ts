/**
 * Directory index-key helpers: the single definition of the keys the Customer, Location and
 * Carrier writers store in their `normalizedName` / `normalizedAddress` GSI attributes.
 *
 * Moved verbatim out of `tms-directory-actions/handler.ts` (customers, locations) so the Aljex
 * import engine and the UPSERT_* actions can never disagree about a record's key. Carriers keep
 * the (different) `src/lib/tmsDirectory.normalizeName` that `tms-carrier-actions` writes with;
 * `carrierKey` re-exports it under an explicit name. A golden-corpus test pins each helper to its
 * historical output.
 */
import { normalizeName as carrierNormalizeName } from '../../../src/lib/tmsDirectory'

export interface AddressShape {
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
}

/** Customer and Location name key (strips llc/inc/ltd/llp/corp/co/company/enterprises anywhere). */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(llc|inc|ltd|llp|corp|co|company|enterprises)\b/g, '')
    .trim()
}

/** Location address key. A bare string is normalised as free text. */
export function normalizeAddress(value: AddressShape | string): string {
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
  }
  const parts = [value.street, value.city, value.state, value.zip, value.country]
  return parts
    .map((p) => (typeof p === 'string' ? p.toLowerCase().replace(/[^a-z0-9]/g, ' ') : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const customerKey = normalizeName
export const locationKey = normalizeName
export const locationAddressKey = normalizeAddress
/** Carrier `normalizedName` as `tms-carrier-actions` writes it (NFKD, trailing suffix only). */
export const carrierKey = carrierNormalizeName
