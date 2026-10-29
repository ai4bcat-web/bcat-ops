import { Plus, Trash2 } from 'lucide-react'
import { TmsButton, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { AddressAutocomplete } from './AddressAutocomplete'
import type { CustomerRecord, LocationRecord, LocationContact } from '@/types/tms'
import type { LocationFormValue } from './useLocationForm'
import { emptyContact } from './useLocationForm'

const UNSET = 'UNSET'
const FACILITY_OPTIONS: { value: NonNullable<LocationRecord['facilityType']> | typeof UNSET; label: string }[] = [
  { value: UNSET, label: 'Not set' },
  { value: 'SHIPPER', label: 'Shipper' },
  { value: 'RECEIVER', label: 'Receiver' },
  { value: 'BOTH', label: 'Both' },
  { value: 'YARD', label: 'Yard' },
  { value: 'TRUCK_STOP', label: 'Truck stop' },
  { value: 'OTHER', label: 'Other' },
]

const RULE_OPTIONS: { value: NonNullable<LocationRecord['apptRule']> | typeof UNSET; label: string }[] = [
  { value: UNSET, label: 'Not set' },
  { value: 'FCFS', label: 'FCFS' },
  { value: 'APPT', label: 'Appointment required' },
  { value: 'EITHER', label: 'Either' },
]

const POSTAL_FIELDS: { key: 'street' | 'city' | 'state' | 'zip' | 'country'; label: string; span?: number }[] = [
  { key: 'street', label: 'Street', span: 2 }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' }, { key: 'country', label: 'Country' },
]

export function LocationForm({
  value,
  set,
  setAddressField,
  errors,
  customers,
}: {
  value: LocationFormValue
  set: <K extends keyof LocationFormValue>(key: K, v: LocationFormValue[K]) => void
  setAddressField: (key: 'street' | 'city' | 'state' | 'zip' | 'country', v: string) => void
  errors: Record<string, string>
  customers: CustomerRecord[]
}) {
  const activeCustomers = customers.filter((c) => c.active !== false)

  const toggleCustomer = (id: string) => {
    set('customerIds', value.customerIds.includes(id) ? value.customerIds.filter((x) => x !== id) : [...value.customerIds, id])
  }

  const updateContact = (i: number, patch: Partial<LocationContact>) => {
    set('contacts', value.contacts.map((c, idx) => idx === i ? { ...c, ...patch } : c))
  }

  const removeContact = (i: number) => set('contacts', value.contacts.filter((_, idx) => idx !== i))
  const addContact = () => set('contacts', [...value.contacts, emptyContact()])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <TmsField label="Facility name *" error={errors.name}>
        <TmsInput value={value.name} onChange={(e) => set('name', e.target.value)} placeholder="BATORY'S OAKLEY CHICAGO" />
      </TmsField>

      <AddressAutocomplete
        label="Address (Google search — sets the map pin)"
        address={value.address ?? null}
        onChange={(res) => set('address', res)}
      />
      <div className="tms-grid tms-grid-2">
        {POSTAL_FIELDS.map((f) => (
          <div key={f.key} style={f.span === 2 ? { gridColumn: 'span 2' } : undefined}>
            <TmsField label={f.label}>
              <TmsInput value={value.address?.[f.key] ?? ''} onChange={(e) => setAddressField(f.key, e.target.value)} />
            </TmsField>
          </div>
        ))}
        <p className="tms-muted" style={{ gridColumn: 'span 2', fontSize: 12 }}>
          {value.address?.lat != null && value.address?.lng != null
            ? `Pin: ${value.address.lat}, ${value.address.lng}${value.address.timezone ? ` · ${value.address.timezone}` : ''} — typing here drops the pin until the address is searched again.`
            : 'No map pin: saved as a postal address only until the address is searched.'}
        </p>
      </div>

      <div className="tms-grid tms-grid-2">
        <TmsField label="Facility type">
          <TmsSelect
            value={value.facilityType ?? UNSET}
            onChange={(e) => set('facilityType', e.target.value === UNSET ? null : e.target.value as NonNullable<LocationRecord['facilityType']>)}
            options={FACILITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </TmsField>
        <TmsField label="Appointment rule">
          <TmsSelect
            value={value.apptRule ?? UNSET}
            onChange={(e) => set('apptRule', e.target.value === UNSET ? null : e.target.value as NonNullable<LocationRecord['apptRule']>)}
            options={RULE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </TmsField>
      </div>

      <div className="tms-grid tms-grid-2">
        <TmsField label="Hours">
          <TmsInput value={value.hours} onChange={(e) => set('hours', e.target.value)} placeholder="Mon-Fri 08:00-16:00" />
        </TmsField>
        <TmsField label="Lead time (hours)" error={errors.apptLeadTimeHours}>
          <TmsInput type="number" min={0} value={value.apptLeadTimeHours} onChange={(e) => set('apptLeadTimeHours', e.target.value)} />
        </TmsField>
      </div>

      <div>
        <div className="tms-field-label">Appointment contact</div>
        <div className="tms-grid tms-grid-2" style={{ marginTop: 6 }}>
          <TmsInput value={value.apptContactName} onChange={(e) => set('apptContactName', e.target.value)} placeholder="Name" aria-label="Appointment contact name" />
          <TmsInput value={value.apptContactPhone} onChange={(e) => set('apptContactPhone', e.target.value)} placeholder="Phone" aria-label="Appointment contact phone" />
          <TmsInput value={value.apptContactEmail} onChange={(e) => set('apptContactEmail', e.target.value)} placeholder="Email" aria-label="Appointment contact email" />
        </div>
      </div>

      <div>
        <div className="tms-field-label">Contacts</div>
        <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
          {value.contacts.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <TmsInput value={c.name ?? ''} onChange={(e) => updateContact(i, { name: e.target.value })} placeholder="Name" />
              <TmsInput value={c.role ?? ''} onChange={(e) => updateContact(i, { role: e.target.value })} placeholder="Role" />
              <TmsInput value={c.email ?? ''} onChange={(e) => updateContact(i, { email: e.target.value })} placeholder="Email" />
              <TmsInput value={c.phone ?? ''} onChange={(e) => updateContact(i, { phone: e.target.value })} placeholder="Phone" />
              <TmsButton variant="ghost" size="sm" aria-label="Remove contact" onClick={() => removeContact(i)}>
                <Trash2 size={14} />
              </TmsButton>
            </div>
          ))}
          <div>
            <TmsButton size="sm" onClick={addContact}><Plus size={14} /> Add contact</TmsButton>
          </div>
        </div>
      </div>

      <div>
        <div className="tms-field-label">Linked customers</div>
        <div style={{ marginTop: 6, display: 'grid', gap: 4, maxHeight: 128, overflowY: 'auto', border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 8 }}>
          {activeCustomers.length === 0 && <p className="tms-muted" style={{ fontSize: 12 }}>No active customers</p>}
          {activeCustomers.map((c) => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={value.customerIds.includes(c.id)}
                onChange={() => toggleCustomer(c.id)}
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="tms-field-label">Notes / dock / lumper / detention</div>
        <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
          <TmsTextarea value={value.dockNotes} onChange={(e) => set('dockNotes', e.target.value)} placeholder="Dock notes" rows={2} aria-label="Dock notes" />
          <TmsTextarea value={value.lumperNotes} onChange={(e) => set('lumperNotes', e.target.value)} placeholder="Lumper notes" rows={2} aria-label="Lumper notes" />
          <TmsTextarea value={value.detentionNotes} onChange={(e) => set('detentionNotes', e.target.value)} placeholder="Detention notes" rows={2} aria-label="Detention notes" />
        </div>
      </div>

      <TmsField label="Aliases (one per line)">
        <TmsTextarea value={value.aliasesText} onChange={(e) => set('aliasesText', e.target.value)} rows={3} />
      </TmsField>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={value.active} onChange={(e) => set('active', e.target.checked)} />
        Active
      </label>

      <TmsField label="Notes">
        <TmsTextarea value={value.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
      </TmsField>
    </div>
  )
}
