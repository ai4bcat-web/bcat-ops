import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MoneyField } from './MoneyField'
import type { Division } from '@/types/tms'
import type { CustomerFormValue } from './useCustomerForm'
import { APPT_WORKFLOW_OPTIONS } from './useCustomerForm'

export function CustomerForm({
  value,
  set,
  errors,
  divisions,
}: {
  value: CustomerFormValue
  set: <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => void
  errors: Record<string, string>
  divisions: Division[]
}) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer name *</Label>
        <Input
          value={value.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="BATORY FOODS"
          className="h-9 text-sm"
        />
        {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">MC #</Label>
          <Input value={value.mcNumber} onChange={(e) => set('mcNumber', e.target.value)} className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">DOT #</Label>
          <Input value={value.dotNumber} onChange={(e) => set('dotNumber', e.target.value)} className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Appt workflow</Label>
          <Select value={value.apptWorkflow} onValueChange={(v) => set('apptWorkflow', v as 'UNSET' | 'NONE' | 'BATORY')}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {APPT_WORKFLOW_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Contact name</Label>
          <Input value={value.contactName} onChange={(e) => set('contactName', e.target.value)} className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Contact phone</Label>
          <Input value={value.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Contact email</Label>
          <Input value={value.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} className="h-9 text-sm" />
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Billing contact</Label>
        <div className="grid grid-cols-3 gap-3 mt-1.5">
          <Input value={value.billingContactName} onChange={(e) => set('billingContactName', e.target.value)} placeholder="Name" className="h-9 text-sm" />
          <Input value={value.billingPhone} onChange={(e) => set('billingPhone', e.target.value)} placeholder="Phone" className="h-9 text-sm" />
          <Input value={value.billingEmail} onChange={(e) => set('billingEmail', e.target.value)} placeholder="Email" className="h-9 text-sm" />
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Billing address</Label>
        <div className="grid grid-cols-2 gap-3 mt-1.5">
          <Input value={value.billingAddressStreet} onChange={(e) => set('billingAddressStreet', e.target.value)} placeholder="Street" className="h-9 text-sm" />
          <Input value={value.billingAddressCity} onChange={(e) => set('billingAddressCity', e.target.value)} placeholder="City" className="h-9 text-sm" />
          <Input value={value.billingAddressState} onChange={(e) => set('billingAddressState', e.target.value)} placeholder="State" className="h-9 text-sm" />
          <Input value={value.billingAddressZip} onChange={(e) => set('billingAddressZip', e.target.value)} placeholder="ZIP" className="h-9 text-sm" />
          <Input value={value.billingAddressCountry} onChange={(e) => set('billingAddressCountry', e.target.value)} placeholder="Country" className="h-9 text-sm" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Payment terms (days)</Label>
          <Input type="number" min={0} value={value.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} className="h-9 text-sm" />
          {errors.paymentTermsDays && <p className="text-xs text-destructive mt-1">{errors.paymentTermsDays}</p>}
        </div>
        <MoneyField label="Credit limit ($)" value={value.creditLimitCents} onChange={(cents) => set('creditLimitCents', cents)} />
        <div className="flex items-end pb-2 gap-2">
          <Switch checked={value.creditHoldFlag} onCheckedChange={(checked) => set('creditHoldFlag', checked)} />
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer">Credit hold</Label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Default division</Label>
          <Select value={value.defaultDivisionKey || '__UNSET__'} onValueChange={(v) => set('defaultDivisionKey', v === '__UNSET__' ? '' : v)}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select division" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__UNSET__">— unset —</SelectItem>
              {divisions.map((d) => <SelectItem key={d.key} value={d.key}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Default sales rep</Label>
          <Input value={value.defaultSalesRepId} onChange={(e) => set('defaultSalesRepId', e.target.value)} className="h-9 text-sm" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Aliases (one per line)</Label>
          <Textarea value={value.aliasesText} onChange={(e) => set('aliasesText', e.target.value)} rows={3} className="text-sm" />
        </div>
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Required invoice docs</Label>
          <Textarea value={value.requiredDocsText} onChange={(e) => set('requiredDocsText', e.target.value)} placeholder="POD&#10;BOL&#10;LUMPER_RECEIPT" rows={3} className="text-sm" />
        </div>
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
