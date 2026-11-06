/**
 * The inline "new location" form inside a stop card (feedback 14), on the shared field grid.
 * Save location: zip auto-fills city / state (tmsGeocode), the row is created through the directory's
 * UPSERT_LOCATION (geocoded, `createdFrom` audited) and selected for the stop. Use once: the address
 * stays on the stop with no directory row. A duplicate (same name + zip, or address + zip) offers
 * "Use existing". Without the directory create permission only Use once is offered.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { createLocation, geocodeAddress } from '@/lib/apiClient'
import type { LocationRecord } from '@/types/tms'
import { COUNTRIES, US_STATES } from '../constants'
import { FieldGrid } from '../fieldGrid'
import { Field } from '../fieldGrid'
import { digitsOnly, maskPhone } from '../sections/fieldUtil'
import { findDuplicate, upsertInputOf, validateDraft, type FacilityKind, type LocationDraft } from './newLocation'

export interface NewLocationFormProps {
  initial: LocationDraft
  locations: readonly LocationRecord[]
  canSave: boolean
  createdFrom: 'shipment-form' | 'intake'
  prefix: string
  onSaved: (loc: LocationRecord) => void
  onUseExisting: (loc: LocationRecord) => void
  onUseOnce: (d: LocationDraft) => void
  onCancel: () => void
}

export function NewLocationForm({ initial, locations, canSave, createdFrom, prefix, onSaved, onUseExisting, onUseOnce, onCancel }: NewLocationFormProps) {
  const [d, setD] = useState<LocationDraft>(initial)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<LocationDraft>) => setD((p) => ({ ...p, ...patch }))
  const errors = useMemo(() => validateDraft(d), [d])
  const dup = useMemo(() => (Object.keys(errors).length === 0 ? findDuplicate(d, locations) : null), [d, errors, locations])
  const t = (key: string) => `f-${prefix}-new-${key}`

  // Zip autofill: a complete zip fills city / state when they are still blank (never over typed text).
  const looked = useRef('')
  useEffect(() => {
    const zip = d.zip.trim()
    if (!/^\d{5}$/.test(zip) || looked.current === zip || (d.city.trim() && d.state.trim())) return
    looked.current = zip
    let live = true
    geocodeAddress(zip).then((g) => {
      if (!live) return
      setD((p) => ({ ...p, city: p.city.trim() ? p.city : (g.city ?? ''), state: p.state.trim() ? p.state : (g.state ?? '').toUpperCase() }))
    }).catch(() => { /* the person types them */ })
    return () => { live = false }
  }, [d.zip, d.city, d.state])

  const save = async () => {
    setTried(true)
    if (Object.keys(errors).length > 0 || dup) return
    setBusy(true)
    try {
      // Geocode first: the directory only stores coordinates it signed; a failed geocode still saves the postal address.
      let geo: Partial<Awaited<ReturnType<typeof geocodeAddress>>> = {}
      try { geo = await geocodeAddress([d.street, d.city, `${d.state} ${d.zip}`].filter((x) => x.trim()).join(', ')) } catch { /* saved without a pin */ }
      const input = upsertInputOf(d, createdFrom)
      const row = await createLocation({
        ...input,
        ...(geo.geocodeToken ? { lat: geo.lat, lng: geo.lng, placeId: geo.placeId, timezone: geo.timezone, geocodedAt: geo.geocodedAt, geocodeExpiresAt: geo.geocodeExpiresAt, geocodeToken: geo.geocodeToken } : {}),
      } as Parameters<typeof createLocation>[0])
      toast.success('Location added')
      onSaved(row)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the location')
    } finally { setBusy(false) }
  }
  const err = (k: keyof typeof errors) => (tried ? errors[k] : undefined)

  return (
    <div className="tms-card-newloc" role="group" aria-label="New location" data-testid={`f-${prefix}-newLocation`}>
      <FieldGrid>
        <Field span={6} narrow={12} label="Name" required error={err('name')}>
          <TmsInput data-testid={t('name')} aria-label="Location name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field span={6} narrow={12} label="Type">
          <TmsSelect data-testid={t('type')} aria-label="Location type" value={d.facilityType} onChange={(e) => set({ facilityType: e.target.value as FacilityKind })}>
            <option value="SHIPPER">Shipper</option><option value="RECEIVER">Receiver</option><option value="BOTH">Both</option>
          </TmsSelect>
        </Field>
        <Field span={6} narrow={12} label="Address"><TmsInput data-testid={t('street')} aria-label="Address" value={d.street} onChange={(e) => set({ street: e.target.value })} /></Field>
        <Field span={6} narrow={12} label="Address 2"><TmsInput data-testid={t('street2')} aria-label="Address 2" value={d.street2} onChange={(e) => set({ street2: e.target.value })} /></Field>
        <Field span={3} narrow={6} label="Zip" required error={err('zip')}>
          <TmsInput data-testid={t('zip')} aria-label="Zip" inputMode="numeric" value={d.zip} onChange={(e) => set({ zip: digitsOnly(e.target.value).slice(0, 9) })} />
        </Field>
        <Field span={3} narrow={6} label="City" required error={err('city')}><TmsInput data-testid={t('city')} aria-label="City" value={d.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field span={3} narrow={6} label="State" required error={err('state')}>
          <TmsSelect data-testid={t('state')} aria-label="State" value={d.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="" />
            {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </TmsSelect>
        </Field>
        <Field span={3} narrow={6} label="Country">
          <TmsSelect data-testid={t('country')} aria-label="Country" value={d.country} onChange={(e) => set({ country: e.target.value })}>
            {COUNTRIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </TmsSelect>
        </Field>
        <Field span={4} narrow={12} label="Contact"><TmsInput data-testid={t('contact')} aria-label="Contact" value={d.contact} onChange={(e) => set({ contact: e.target.value })} /></Field>
        <Field span={4} narrow={6} label="Phone"><TmsInput data-testid={t('phone')} aria-label="Phone" type="tel" value={d.phone} onChange={(e) => set({ phone: maskPhone(e.target.value) })} /></Field>
        <Field span={4} narrow={6} label="E-mail" error={err('email')}><TmsInput data-testid={t('email')} aria-label="E-mail" type="email" value={d.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field span={6} narrow={12} label="Hours"><TmsInput data-testid={t('hours')} aria-label="Hours" value={d.hours} onChange={(e) => set({ hours: e.target.value })} /></Field>
        <Field span={6} narrow={12} label="Appointment required">
          <TmsSelect data-testid={t('appt')} aria-label="Appointment required" value={d.apptRequired ? 'yes' : 'no'} onChange={(e) => set({ apptRequired: e.target.value === 'yes' })}>
            <option value="no">No</option><option value="yes">Yes</option>
          </TmsSelect>
        </Field>
        <Field span={12} label="Notes"><TmsTextarea data-testid={t('notes')} aria-label="Notes" rows={1} className="tms-fg-oneline" value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </FieldGrid>
      {dup ? (
        <div className="tms-card-newloc-dup" role="alert" data-testid={t('duplicate')}>
          <span>{dup.why === 'name' ? 'A location with this name and zip already exists' : 'A location at this address already exists'}: {dup.location.name}</span>
          <TmsButton size="sm" variant="primary" data-testid={t('useExisting')} onClick={() => onUseExisting(dup.location)}>Use existing</TmsButton>
        </div>
      ) : null}
      <div className="tms-fg-toolbar">
        <TmsButton size="sm" variant="ghost" data-testid={t('cancel')} onClick={onCancel}>Cancel</TmsButton>
        <TmsButton size="sm" data-testid={t('once')} onClick={() => { setTried(true); if (Object.keys(errors).length === 0) onUseOnce(d) }}>Use once</TmsButton>
        {canSave ? <TmsButton size="sm" variant="primary" data-testid={t('save')} disabled={busy || dup !== null} onClick={() => void save()}>{busy ? 'Saving…' : 'Save location'}</TmsButton> : null}
      </div>
    </div>
  )
}
