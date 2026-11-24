/**
 * Who sees what on the Profiles page (Ryne 2026-11-24): Jason sees Assets and Drivers there, and nothing else under
 * Profiles (Customers, Carriers, Locations, Pay to and Remit e-mails, vendors).
 *
 * One rule, shared by the screens (nav, route guards) and the Lambdas that return directory data, so hiding a tab and
 * refusing its data cannot drift apart. The owner and the Cognito ADMIN group are never limited, whoever is listed.
 *
 * Pure: relative imports only, because the Lambdas bundle this by path.
 */
import { OWNER_EMAIL } from './auth/admin'

/** People whose Profiles access is limited to Assets and Drivers. */
export const FLEET_PROFILES_ONLY_EMAILS = ['jason@bcatcorp.com'] as const

/** True for someone limited to the fleet profiles (Assets and Drivers). The owner and ADMIN never are. */
export function isFleetProfilesOnly(email: string | null | undefined, groups?: readonly string[] | null): boolean {
  const who = (email ?? '').trim().toLowerCase()
  if (!who || who === OWNER_EMAIL || (groups ?? []).includes('ADMIN')) return false
  return (FLEET_PROFILES_ONLY_EMAILS as readonly string[]).includes(who)
}

/** The Profiles tabs that stay open to a fleet-profiles-only person. */
export const FLEET_PROFILE_PATHS = ['/profiles/drivers', '/profiles/assets'] as const

/** The refusal a directory Lambda throws for them. */
export const FLEET_PROFILES_ONLY_MESSAGE = 'Forbidden: your Profiles access is limited to Assets and Drivers'

/**
 * Creating a customer, location or carrier is closed to them too (Ryne 2026-11-24): they use the records that exist while a
 * load is built, and the office adds a new one. The owner and ADMIN never are limited.
 */
export function canCreateDirectoryRecords(email: string | null | undefined, groups?: readonly string[] | null): boolean {
  return !isFleetProfilesOnly(email, groups)
}

/** What the screens say where an "add new" would be, and the refusal the Lambdas throw. */
export const FLEET_PROFILES_NO_CREATE_HINT = 'Ask the office to add this'
export const FLEET_PROFILES_NO_CREATE_MESSAGE = 'Forbidden: ask the office to add this. Your access does not include adding customers, locations or carriers'
