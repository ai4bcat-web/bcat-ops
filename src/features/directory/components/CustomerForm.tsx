import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MoneyField } from './MoneyField'
import type { Division, CustomerStatus } from '@/types/tms'
import type { CustomerFormValue } from './useCustomerForm'
import { APPT_WORKFLOW_OPTIONS, INVOICE_FREQUENCY_OPTIONS } from './useCustomerForm'
import { cn } from '@/lib/utils'

const STATUS_OPTIONS: CustomerStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING', 'PENDING', 'ACTIVE']

const tabs = ['Overview', 'Billing', 'Credit & pricing', 'Settings']

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
  const [tab, setTab] = useState('Overview')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b pb-1">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md',
              tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="space-y-4">
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer name *</Label>
            <Input value={value.name} onChange={(e) => set('name', e.target.value)} className="h-9 text-sm" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Status</Label>
              <Select value={value.status || '__UNSET__'} onValueChange={(v) => set('status', v === '__UNSET__' ? '' : (v as CustomerStatus))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__UNSET__">— unset —</SelectItem>
                  {STATUS_OPTIONS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Lead source</Label>
              <Input value={value.leadSource} onChange={(e) => set('leadSource', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Industry</Label>
              <Input value={value.industry} onChange={(e) => set('industry', e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Service tier</Label>
              <Input value={value.serviceTier} onChange={(e) => set('serviceTier', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Website</Label>
              <Input value={value.website} onChange={(e) => set('website', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Appt workflow</Label>
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
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">MC #</Label>
              <Input value={value.mcNumber} onChange={(e) => set('mcNumber', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">DOT #</Label>
              <Input value={value.dotNumber} onChange={(e) => set('dotNumber', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Payment terms (days)</Label>
              <Input type="number" min={0} value={value.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} className="h-9 text-sm" />
              {errors.paymentTermsDays && <p className="text-xs text-destructive mt-1">{errors.paymentTermsDays}</p>}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Contact name</Label>
              <Input value={value.contactName} onChange={(e) => set('contactName', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Contact phone</Label>
              <Input value={value.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Contact email</Label>
              <Input value={value.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Notes</Label>
            <Textarea value={value.notes} onChange={(e) => set('notes', e.target.value)} className="text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Aliases</Label>
            <Textarea value={value.aliasesText} onChange={(e) => set('aliasesText', e.target.value)} className="text-sm" placeholder="One per line" />
          </div>
        </div>
      )}

      {tab === 'Billing' && (
        <div className="space-y-4">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Billing contact</Label>
            <div className="grid grid-cols-3 gap-3 mt-1.5">
              <Input value={value.billingContactName} onChange={(e) => set('billingContactName', e.target.value)} placeholder="Name" className="h-9 text-sm" />
              <Input value={value.billingPhone} onChange={(e) => set('billingPhone', e.target.value)} placeholder="Phone" className="h-9 text-sm" />
              <Input value={value.billingEmail} onChange={(e) => set('billingEmail', e.target.value)} placeholder="Email" className="h-9 text-sm" />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Billing address</Label>
            <div className="grid grid-cols-2 gap-3 mt-1.5">
              <Input value={value.billingAddressStreet} onChange={(e) => set('billingAddressStreet', e.target.value)} placeholder="Street" className="h-9 text-sm" />
              <Input value={value.billingAddressCity} onChange={(e) => set('billingAddressCity', e.target.value)} placeholder="City" className="h-9 text-sm" />
              <Input value={value.billingAddressState} onChange={(e) => set('billingAddressState', e.target.value)} placeholder="State" className="h-9 text-sm" />
              <Input value={value.billingAddressZip} onChange={(e) => set('billingAddressZip', e.target.value)} placeholder="ZIP" className="h-9 text-sm" />
              <Input value={value.billingAddressCountry} onChange={(e) => set('billingAddressCountry', e.target.value)} placeholder="Country" className="h-9 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Default division</Label>
              <Select value={value.defaultDivisionKey || '__UNSET__'} onValueChange={(v) => set('defaultDivisionKey', v === '__UNSET__' ? '' : v)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select division" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__UNSET__">— unset —</SelectItem>
                  {divisions.map((d) => <SelectItem key={d.key} value={d.key}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Default sales rep</Label>
              <Input value={value.defaultSalesRepId} onChange={(e) => set('defaultSalesRepId', e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Required docs for invoice</Label>
            <Textarea value={value.requiredDocsText} onChange={(e) => set('requiredDocsText', e.target.value)} className="text-sm" placeholder="One per line" />
          </div>
        </div>
      )}

      {tab === 'Credit & pricing' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <MoneyField label="Credit limit ($)" value={value.creditLimitCents} onChange={(cents) => set('creditLimitCents', cents)} />
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Usage warning (bps)</Label>
              <Input type="number" min={0} max={10000} value={value.creditUsageWarningBps ?? ''} onChange={(e) => set('creditUsageWarningBps', e.target.value ? Number(e.target.value) : null)} className="h-9 text-sm" />
              {errors.creditUsageWarningBps && <p className="text-xs text-destructive mt-1">{errors.creditUsageWarningBps}</p>}
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Max days late</Label>
              <Input type="number" min={0} value={value.maxDaysLate ?? ''} onChange={(e) => set('maxDaysLate', e.target.value ? Number(e.target.value) : null)} className="h-9 text-sm" />
              {errors.maxDaysLate && <p className="text-xs text-destructive mt-1">{errors.maxDaysLate}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={value.freeCreditRequired === true} onCheckedChange={(checked) => set('freeCreditRequired', checked)} />
            <Label className="text-xs uppercase tracking-wider text-muted-foreground cursor-pointer">Free credit required</Label>
            <Switch checked={value.creditHoldFlag} onCheckedChange={(checked) => set('creditHoldFlag', checked)} />
            <Label className="text-xs uppercase tracking-wider text-muted-foreground cursor-pointer">Credit hold</Label>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">GP split (bps)</Label>
            <Input type="number" min={0} max={10000} value={value.gpSplitBps ?? ''} onChange={(e) => set('gpSplitBps', e.target.value ? Number(e.target.value) : null)} className="h-9 text-sm" />
            {errors.gpSplitBps && <p className="text-xs text-destructive mt-1">{errors.gpSplitBps}</p>}
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Rate con terms override</Label>
            <Textarea value={value.rateConTerms} onChange={(e) => set('rateConTerms', e.target.value)} className="text-sm" />
          </div>
        </div>
      )}

      {tab === 'Settings' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Invoice frequency</Label>
              <Select value={value.invoiceFrequency || '__UNSET__'} onValueChange={(v) => set('invoiceFrequency', v === '__UNSET__' ? '' : (v as typeof INVOICE_FREQUENCY_OPTIONS[number]['value']))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__UNSET__">— unset —</SelectItem>
                  {INVOICE_FREQUENCY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Team key</Label>
              <Input value={value.teamKey} onChange={(e) => set('teamKey', e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Operated by</Label>
              <Input value={value.operatedById} onChange={(e) => set('operatedById', e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Account owners</Label>
              <Textarea value={value.accountOwnerIdsText} onChange={(e) => set('accountOwnerIdsText', e.target.value)} className="text-sm" placeholder="One username per line" />
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Visibility preferences</p>
            <div className="flex flex-wrap gap-4">
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={value.visibilityPrefs.milestoneEmails} onCheckedChange={(checked) => set('visibilityPrefs', { ...value.visibilityPrefs, milestoneEmails: checked })} />
                Milestone emails
              </Label>
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={value.visibilityPrefs.sharedTrackingLink} onCheckedChange={(checked) => set('visibilityPrefs', { ...value.visibilityPrefs, sharedTrackingLink: checked })} />
                Shared tracking link
              </Label>
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={value.visibilityPrefs.shipperPortal} onCheckedChange={(checked) => set('visibilityPrefs', { ...value.visibilityPrefs, shipperPortal: checked })} />
                Shipper portal
              </Label>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
