import { useState } from 'react'
import type { LocationRecord, LocationContact, GeocodeResult } from '@/types/tms'

const linesToArray = (value: string): string[] => value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
const arrayToLines = (value: string[] | null | undefined): string => (value ?? []).join('\n')

export interface LocationFormValue {
  name: string
  address: Partial<GeocodeResult> | null
  customerName: string
  apptContactName: string
  apptContactEmail: string
  apptContactPhone: string
  notes: string
  facilityType: LocationRecord['facilityType']
  hours: string
  apptRule: LocationRecord['apptRule']
  apptLeadTimeHours: string
  dockNotes: string
  lumperNotes: string
  detentionNotes: string
  contacts: LocationContact[]
  customerIds: string[]
  aliasesText: string
  active: boolean
}

const emptyContact = (): LocationContact => ({ name: '', role: '', email: '', phone: '' })

function emptyLocationForm(initial?: LocationRecord | null): LocationFormValue {
  return {
    name: initial?.name ?? '',
    address: initial ? {
      street: initial.street ?? '',
      city: initial.city ?? '',
      state: initial.state ?? '',
      zip: initial.zip ?? '',
      country: initial.country ?? '',
      lat: initial.lat ?? undefined,
      lng: initial.lng ?? undefined,
      timezone: initial.timezone ?? '',
      placeId: initial.placeId ?? '',
      formattedAddress: [initial.street, initial.city, initial.state, initial.zip, initial.country].filter(Boolean).join(', '),
      geocodedAt: initial.geocodedAt ?? '',
      geocodeExpiresAt: initial.geocodeExpiresAt ?? '',
      geocodeToken: '',
    } : null,
    customerIds: initial?.customerIds ?? [],
    aliasesText: arrayToLines(initial?.aliases),
    contacts: initial?.contacts?.map((c) => ({ ...c })) ?? [],
    customerName: initial?.customerName ?? '',
    apptContactName: initial?.apptContactName ?? '',
    apptContactEmail: initial?.apptContactEmail ?? '',
    apptContactPhone: initial?.apptContactPhone ?? '',
    notes: initial?.notes ?? '',
    facilityType: initial?.facilityType ?? null,
    hours: initial?.hours ?? '',
    apptRule: initial?.apptRule ?? null,
    apptLeadTimeHours: initial?.apptLeadTimeHours != null ? String(initial.apptLeadTimeHours) : '',
    dockNotes: initial?.dockNotes ?? '',
    lumperNotes: initial?.lumperNotes ?? '',
    detentionNotes: initial?.detentionNotes ?? '',
    active: initial?.active ?? true,
  }
}

function validateLocationForm(v: LocationFormValue): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!v.name.trim()) errors.name = 'Facility name is required'
  if (v.apptLeadTimeHours.trim() && (Number.isNaN(Number(v.apptLeadTimeHours)) || Number(v.apptLeadTimeHours) < 0)) {
    errors.apptLeadTimeHours = 'Enter hours as a number'
  }
  return errors
}

export function useLocationForm(initial?: LocationRecord | null) {
  const [value, setValue] = useState<LocationFormValue>(() => emptyLocationForm(initial))

  const set = <K extends keyof LocationFormValue>(key: K, v: LocationFormValue[K]) => {
    setValue((p) => ({ ...p, [key]: v }))
  }

  /** Hand-typed postal address: the Google pin no longer describes it, so it is dropped. */
  const setAddressField = (key: 'street' | 'city' | 'state' | 'zip' | 'country', v: string) => {
    setValue((p) => ({
      ...p,
      address: {
        street: p.address?.street ?? '', city: p.address?.city ?? '', state: p.address?.state ?? '',
        zip: p.address?.zip ?? '', country: p.address?.country ?? '',
        [key]: v,
      },
    }))
  }

  const toRecord = (): LocationRecord => ({
    id: initial?.id ?? '',
    createdAt: initial?.createdAt ?? new Date().toISOString(),
    updatedAt: initial?.updatedAt ?? new Date().toISOString(),
    name: value.name.trim(),
    street: value.address?.street?.trim() || null,
    city: value.address?.city?.trim() || null,
    state: value.address?.state?.trim() || null,
    zip: value.address?.zip?.trim() || null,
    country: value.address?.country?.trim() || null,
    lat: value.address?.lat ?? null,
    lng: value.address?.lng ?? null,
    timezone: value.address?.timezone?.trim() || null,
    placeId: value.address?.placeId?.trim() || null,
    geocodedAt: value.address?.geocodedAt?.trim() || null,
    geocodeExpiresAt: value.address?.geocodeExpiresAt?.trim() || null,
    customerName: value.customerName.trim() || null,
    apptContactName: value.apptContactName.trim() || null,
    apptContactEmail: value.apptContactEmail.trim() || null,
    apptContactPhone: value.apptContactPhone.trim() || null,
    notes: value.notes.trim() || null,
    facilityType: value.facilityType ?? null,
    hours: value.hours.trim() || null,
    apptRule: value.apptRule ?? null,
    apptLeadTimeHours: value.apptLeadTimeHours.trim() ? Number(value.apptLeadTimeHours) : null,
    dockNotes: value.dockNotes.trim() || null,
    lumperNotes: value.lumperNotes.trim() || null,
    detentionNotes: value.detentionNotes.trim() || null,
    contacts: value.contacts.length ? value.contacts.map((c) => ({ name: c.name || null, role: c.role || null, email: c.email || null, phone: c.phone || null })) : null,
    customerIds: value.customerIds.length ? value.customerIds : null,
    aliases: linesToArray(value.aliasesText),
    active: value.active,
  })

  const getGeocodeToken = (): string | null => value.address?.geocodeToken?.trim() || null
  const errors = validateLocationForm(value)
  return { value, set, setAddressField, toRecord, getGeocodeToken, errors }
}

export { emptyContact }
