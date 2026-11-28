import { isFleetProfilesOnly } from '@/lib/profileAccess'

/**
 * Who gets the Capacity board, on the Calendar and on the Book page's Assets tab: it carries the rates the office is asking for,
 * so someone limited to the fleet profiles (Jason) does not. The server refuses them too; this keeps the tab out of their sight.
 */
export function capacityAllowedFor(email: string | null | undefined, groups?: readonly string[] | null): boolean {
  return !isFleetProfilesOnly(email, groups)
}
