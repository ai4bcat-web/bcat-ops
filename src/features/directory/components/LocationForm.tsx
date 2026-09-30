import { Plus, Trash2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
    <div className="space-y-4">
      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Facility name *</Label>
        <Input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder="BATORY'S OAKLEY CHICAGO" className="h-9 text-sm" />
        {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
      </div>

      <AddressAutocomplete
        label="Address (Google search — sets the map pin)"
        address={value.address ?? null}
        onChange={(res) => set('address', res)}
      />
      <div className="grid grid-cols-2 gap-3">
        {POSTAL_FIELDS.map((f) => (
          <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{f.label}</Label>
            <Input value={value.address?.[f.key] ?? ''} onChange={(e) => setAddressField(f.key, e.target.value)} className="h-9 text-sm" />
          </div>
        ))}
        <p className="col-span-2 text-xs text-muted-foreground">
          {value.address?.lat != null && value.address?.lng != null
            ? `Pin: ${value.address.lat}, ${value.address.lng}${value.address.timezone ? ` · ${value.address.timezone}` : ''} — typing here drops the pin until the address is searched again.`
            : 'No map pin: saved as a postal address only until the address is searched.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Facility type</Label>
          <Select value={value.facilityType ?? UNSET} onValueChange={(v) => set('facilityType', v === UNSET ? null : v as NonNullable<LocationRecord['facilityType']>)}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FACILITY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Appointment rule</Label>
          <Select value={value.apptRule ?? UNSET} onValueChange={(v) => set('apptRule', v === UNSET ? null : v as NonNullable<LocationRecord['apptRule']>)}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RULE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Hours</Label>
          <Input value={value.hours} onChange={(e) => set('hours', e.target.value)} placeholder="Mon-Fri 08:00-16:00" className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Lead time (hours)</Label>
          <Input type="number" min={0} value={value.apptLeadTimeHours} onChange={(e) => set('apptLeadTimeHours', e.target.value)} className="h-9 text-sm" />
          {errors.apptLeadTimeHours && <p className="text-xs text-destructive mt-1">{errors.apptLeadTimeHours}</p>}
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Appointment contact</Label>
        <div className="grid grid-cols-2 gap-3 mt-1.5">
          <Input value={value.apptContactName} onChange={(e) => set('apptContactName', e.target.value)} placeholder="Name" className="h-9 text-sm" />
          <Input value={value.apptContactPhone} onChange={(e) => set('apptContactPhone', e.target.value)} placeholder="Phone" className="h-9 text-sm" />
          <Input value={value.apptContactEmail} onChange={(e) => set('apptContactEmail', e.target.value)} placeholder="Email" className="h-9 text-sm" />
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Contacts</Label>
        <div className="space-y-2 mt-1.5">
          {value.contacts.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end">
              <Input value={c.name ?? ''} onChange={(e) => updateContact(i, { name: e.target.value })} placeholder="Name" className="h-9 text-sm" />
              <Input value={c.role ?? ''} onChange={(e) => updateContact(i, { role: e.target.value })} placeholder="Role" className="h-9 text-sm" />
              <Input value={c.email ?? ''} onChange={(e) => updateContact(i, { email: e.target.value })} placeholder="Email" className="h-9 text-sm" />
              <Input value={c.phone ?? ''} onChange={(e) => updateContact(i, { phone: e.target.value })} placeholder="Phone" className="h-9 text-sm" />
              <Button type="button" variant="ghost" size="sm" className="h-9 px-2 text-destructive" onClick={() => removeContact(i)}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1" onClick={addContact}>
            <Plus className="size-3.5" /> Add contact
          </Button>
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Linked customers</Label>
        <div className="mt-1.5 space-y-1 max-h-32 overflow-y-auto border rounded-md p-2">
          {activeCustomers.length === 0 && <p className="text-xs text-muted-foreground">No active customers</p>}
          {activeCustomers.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={value.customerIds.includes(c.id)}
                onChange={() => toggleCustomer(c.id)}
                className="size-4"
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes / dock / lumper / detention</Label>
        <div className="space-y-2 mt-1.5">
          <Textarea value={value.dockNotes} onChange={(e) => set('dockNotes', e.target.value)} placeholder="Dock notes" rows={2} className="text-sm" />
          <Textarea value={value.lumperNotes} onChange={(e) => set('lumperNotes', e.target.value)} placeholder="Lumper notes" rows={2} className="text-sm" />
          <Textarea value={value.detentionNotes} onChange={(e) => set('detentionNotes', e.target.value)} placeholder="Detention notes" rows={2} className="text-sm" />
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Aliases (one per line)</Label>
        <Textarea value={value.aliasesText} onChange={(e) => set('aliasesText', e.target.value)} rows={3} className="text-sm" />
      </div>

      <div className="flex items-center gap-2">
        <Switch checked={value.active} onCheckedChange={(checked) => set('active', checked)} />
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer">Active</Label>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes</Label>
        <Textarea value={value.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className="text-sm" />
      </div>
    </div>
  )
}
