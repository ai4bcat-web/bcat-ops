/**
 * Aljex-exit DECIDED-1: PRO numbers continue the Aljex numeric scheme.
 *
 * `TmsSettings.proScheme` is `DERIVED` (today: `S000123`, PRO `S000123-1`) or `NUMERIC`
 * (shipment number = PRO = the plain counter value; later legs `<n>-2`, `<n>-3`). The counter
 * itself is "last issued" in both: `ADD 1`, then read.
 *
 * Pure, so the numbering rules are tested without DynamoDB.
 */
import type { ProScheme } from '../../../src/types/tms'

export const DEFAULT_SHIPMENT_PREFIX = 'S'

/** How many already-claimed numbers the counter may skip before CREATE gives up. */
export const MAX_COUNTER_SKIPS = 25

interface SchemeSettings {
  proScheme?: unknown
  shipmentPrefix?: unknown
}

export function proSchemeOf(settings: SchemeSettings | null | undefined): ProScheme {
  return settings?.proScheme === 'NUMERIC' ? 'NUMERIC' : 'DERIVED'
}

export function shipmentPrefixOf(settings: SchemeSettings | null | undefined): string {
  const prefix = typeof settings?.shipmentPrefix === 'string' ? settings.shipmentPrefix.trim() : ''
  return prefix || DEFAULT_SHIPMENT_PREFIX
}

/** The shipment number a counter value stands for. */
export function formatShipmentNumber(settings: SchemeSettings | null | undefined, counter: number): string {
  if (proSchemeOf(settings) === 'NUMERIC') return String(counter)
  return `${shipmentPrefixOf(settings)}${String(counter).padStart(6, '0')}`
}

/** The PRO / load number a shipment number derives for its Nth leg. */
export function derivedLegPro(settings: SchemeSettings | null | undefined, number: string, leg: number): string {
  if (proSchemeOf(settings) === 'NUMERIC' && leg === 1) return number
  return `${number}-${leg}`
}

/**
 * The refusal for a typed PRO that would pre-empt the counter, or null.
 * DERIVED (and NUMERIC too, because old shapes may still be claimed): `S000123-1` and its claim key.
 * NUMERIC only: an all-digit PRO at or above the counter — the counter would walk into it.
 * Lower unclaimed digits stay allowed (the old Aljex numbers and gaps).
 */
export function derivedProRefusal(
  pro: string,
  settings: SchemeSettings | null | undefined,
  counter: number | null | undefined,
  normalized: string | null,
): string | null {
  const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prefix = escapeRe(shipmentPrefixOf(settings))
  // The claim key keeps only alphanumerics, so the prefix is reduced the same way
  // before it is matched against one: a dashed prefix never appears in a key.
  const keyPrefix = escapeRe(shipmentPrefixOf(settings).replace(/[^A-Za-z0-9]/g, '').toUpperCase())
  const derived =
    new RegExp(`^${prefix}\\d{6}-\\d+$`, 'i').test(pro.trim())
    || (normalized != null && new RegExp(`^${keyPrefix}\\d{7,}$`).test(normalized))
  if (derived) {
    return `${pro.trim()} is the shape this system issues on its own; pick a different PRO or let it derive one`
  }
  if (proSchemeOf(settings) === 'NUMERIC' && normalized != null && /^\d+$/.test(normalized)) {
    const value = Number(normalized)
    const issued = typeof counter === 'number' ? counter : 0
    if (value >= issued) {
      return `${pro.trim()} is a number this system will issue itself (the counter is at ${issued}); pick a lower PRO or let it derive one`
    }
  }
  return null
}

/**
 * Switching to NUMERIC is only safe once the counter is at or above every numeric PRO
 * already claimed, otherwise the counter walks into old numbers.
 */
export function numericSchemeSwitchError(counter: number | null | undefined, maxClaimedNumeric: number | null): string | null {
  const issued = typeof counter === 'number' ? counter : 0
  if (maxClaimedNumeric != null && issued < maxClaimedNumeric) {
    return `The shipment counter is at ${issued} but PRO ${maxClaimedNumeric} is already claimed; raise the counter to at least ${maxClaimedNumeric} before switching to numeric PROs`
  }
  // A PRO needs three characters (`normalizePro`), so a numeric counter below 99 would mint numbers nobody can claim.
  if (issued < 99) return 'Raise the shipment counter to at least 99 before switching to numeric PROs; a PRO needs three digits'
  return null
}
