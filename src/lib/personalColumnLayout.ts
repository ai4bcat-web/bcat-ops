/**
 * Personal column layouts for the Shipments lists (Active, All, Voided).
 *
 * Everybody on the team can keep their own layout next to the team default an admin sets
 * (teamColumnLayout.ts). A personal layout is a ShipmentColumnTemplate row whose id names the list
 * and the person: only that person's login may write it, so nobody can create (squat) or change
 * somebody else's. Pure and relative-import only: tms-directory-actions bundles this by path to
 * enforce the id rule, and the board uses the same function to find its own row.
 */

export const PERSONAL_LAYOUT_PREFIX = 'shipments-user-'

export type PersonalLayoutList = 'active' | 'all' | 'voided'

const LISTS: readonly PersonalLayoutList[] = ['active', 'all', 'voided']

/** cyrb53: a small, stable 53-bit string hash. It only has to tell this team's logins apart. */
function hashEmail(email: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < email.length; i++) {
    const ch = email.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** The row id holding `email`'s own layout for `list`. */
export function personalTemplateId(list: PersonalLayoutList, email: string): string {
  return `${PERSONAL_LAYOUT_PREFIX}${list}-${hashEmail(email.trim().toLowerCase())}`
}

export function isPersonalTemplateId(id: string): boolean {
  return id.startsWith(PERSONAL_LAYOUT_PREFIX)
}

/** True when `id` is exactly the personal layout row `email` owns for one of the lists. */
export function isOwnPersonalTemplateId(id: string, email: string): boolean {
  return LISTS.some((list) => personalTemplateId(list, email) === id)
}
