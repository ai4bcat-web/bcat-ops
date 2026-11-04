import type { AljexProfile, StatusMapEntry } from './profile'

/** The key a Dispatch Status is looked up by: trimmed, whitespace-collapsed, upper-cased. */
export function statusKeyOf(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toUpperCase()
}

/** The profile's mapping for a status, or null when unmapped (the engine must surface it, never default to OPEN). */
export function mapStatus(statusKey: string, profile: AljexProfile): StatusMapEntry | null {
  return Object.prototype.hasOwnProperty.call(profile.statusMap, statusKey) ? profile.statusMap[statusKey] : null
}
