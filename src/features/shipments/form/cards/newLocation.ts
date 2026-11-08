/**
 * Pure rules of the stop card's inline "new location" form (feedback 14): the draft, its
 * validation, the duplicate guard, what gets sent to the directory (UPSERT_LOCATION) and what a
 * "Use once" leaves on the stop. No React, no I/O.
 */
import { normalizeAddress, normalizeName } from '@/lib/tmsDirectory'
import type { LocationRecord } from '@/types/tms'
import type { FormStop } from '../model'

export type FacilityKind = 'SHIPPER' | 'RECEIVER' | 'BOTH'

export interface LocationDraft {
  name: string
  street: string
  street2: string
  city: string
  state: string
  zip: string
  country: string
  contact: string
  phone: string
  email: string
  hours: string
  apptRequired: boolean
  facilityType: FacilityKind
  notes: string
}

/** A stop's own fields prefill the form (typed name, an extracted address); the type follows the stop. */
export function draftFromStop(stop: Pick<FormStop, 'type' | 'name' | 'address1' | 'address2' | 'city' | 'state' | 'zip' | 'country' | 'contact' | 'phone' | 'email' | 'hours'>, typed?: string): LocationDraft {
  return {
    name: (typed ?? stop.name).trim(), street: stop.address1, street2: stop.address2, city: stop.city, state: stop.state, zip: stop.zip,
    country: stop.country || 'US', contact: stop.contact, phone: stop.phone, email: stop.email, hours: stop.hours,
    apptRequired: false, facilityType: stop.type === 'delivery' ? 'RECEIVER' : 'SHIPPER', notes: '',
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type DraftErrors = Partial<Record<'name' | 'city' | 'state' | 'zip' | 'email', string>>

/** Name, city, a two-letter state and a 5/9-digit zip are required; the e-mail must look like one. */
export function validateDraft(d: LocationDraft): DraftErrors {
  const e: DraftErrors = {}
  if (!d.name.trim()) e.name = 'Name is required'
  if (!d.city.trim()) e.city = 'City is required'
  if (!/^[A-Za-z]{2}$/.test(d.state.trim())) e.state = 'Two-letter state'
  if (!/^\d{5}(\d{4}|-\d{4})?$/.test(d.zip.trim())) e.zip = '5 or 9 digit zip'
  if (d.email.trim() && !EMAIL.test(d.email.trim())) e.email = 'Not a valid e-mail'
  return e
}

export interface DuplicateHit { location: LocationRecord; why: 'name' | 'address' }

/**
 * The directory's own collision rules, checked before the round trip so the person can pick the
 * existing row: the same normalised name in the same zip, or the same normalised address + zip.
 * (The server repeats its stricter name+city / address check.)
 */
export function findDuplicate(d: LocationDraft, locations: readonly LocationRecord[]): DuplicateHit | null {
  const zip = d.zip.trim().slice(0, 5)
  const name = normalizeName(d.name)
  const addr = d.street.trim() ? normalizeAddress({ street: d.street, city: d.city, state: d.state, zip: d.zip, country: d.country }) : ''
  for (const l of locations) {
    if (l.active === false || l.mergedIntoId) continue
    if ((l.zip ?? '').trim().slice(0, 5) !== zip) continue
    if (name && [l.name, ...(l.aliases ?? [])].some((n) => normalizeName(n) === name)) return { location: l, why: 'name' }
    if (addr && normalizeAddress(l) === addr) return { location: l, why: 'address' }
  }
  return null
}

/** The `UPSERT_LOCATION` input for a new directory row. `createdFrom` is audited by the handler. */
export function upsertInputOf(d: LocationDraft, createdFrom: 'shipment-form' | 'intake') {
  return {
    name: d.name.trim(),
    street: [d.street.trim(), d.street2.trim()].filter(Boolean).join(', ') || null, city: d.city.trim(), state: d.state.trim().toUpperCase(), zip: d.zip.trim(),
    country: d.country.trim() || 'US',
    apptContactName: d.contact.trim() || null, apptContactPhone: d.phone.trim() || null, apptContactEmail: d.email.trim() || null,
    hours: d.hours.trim() || null, apptRule: d.apptRequired ? ('APPT' as const) : null, facilityType: d.facilityType,
    notes: d.notes.trim() || null, createdFrom,
  }
}

/** "Use once": the typed name and address stay on the stop; no directory row, no location id. */
export function onceStopPatch(d: LocationDraft): Partial<FormStop> {
  return {
    name: d.name.trim(), locationId: '', geo: null,
    address1: d.street.trim(), address2: d.street2.trim(), city: d.city.trim(), state: d.state.trim().toUpperCase(), zip: d.zip.trim(),
    country: d.country.trim() || 'US', contact: d.contact.trim(), phone: d.phone.trim(), email: d.email.trim(), hours: d.hours.trim(),
  }
}
