import { useMemo, useState } from 'react'
import { X, Building2, MapPin, FileText, FileSpreadsheet, Settings, Phone, DollarSign, Truck, Banknote } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'
import { useCustomerOrders } from '@/hooks/useCustomerOrders'
import { useCustomerQuotes } from '@/hooks/useCustomerQuotes'
import { creditSummaryForCustomer, effectiveCustomerStatus, boardTab } from '@/lib/customerCredit'
import { oldestOpenInvoiceDays } from '@/lib/arAging'
import { useCustomerAr } from '@/hooks/useCustomerAr'
import { loadStatus } from '@/lib/loadStatus'
import { laneLabelFor } from '@/lib/laneKey'
import { QUOTE_STATUS_LABEL } from '@/lib/quotes'
import { formatCents as formatQuoteCents } from '@/lib/invoiceBuild'
import { formatCents } from '@/lib/tmsDirectory'
import { cn } from '@/lib/utils'
import { useCustomerForm } from './useCustomerForm'
import { INVOICE_FREQUENCY_OPTIONS } from './useCustomerForm'
import { ContactsEditor } from './ContactsEditor'
import { BillToEditor } from './BillToEditor'
import { ReferencesEditor } from './ReferencesEditor'
import { PricingDefaultsForm } from './PricingDefaultsForm'
import { QuotingDefaultsForm } from './QuotingDefaultsForm'
import { CreditLimitCard } from './CreditLimitCard'
import { CustomerArTab } from './CustomerArTab'
import { StatusActionDialog } from './StatusActionDialog'
import type {
  CustomerRecord,
  Division,
  LocationRecord,
  TmsSettings,
  ChargeCodeDef,
  CustomerStatus,
  InvoiceFrequency,
} from '@/types/tms'

interface CustomerProfileProps {
  customer: CustomerRecord
  divisions: Division[]
  locations: LocationRecord[]
  settings: TmsSettings | null
  catalog: ChargeCodeDef[]
  isAdmin: boolean
  currentUser: string
  activeCustomers: CustomerRecord[]
  onClose: () => void
  onSave: (current: CustomerRecord, next: Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onStatusChange: (current: CustomerRecord, input: { status: CustomerStatus; reason?: string; replacementCustomerId?: string }) => Promise<void>
}

const tabs = [
  { key: 'account', label: 'Account', icon: Building2 },
  { key: 'contacts', label: 'Contacts', icon: Phone },
  { key: 'documents', label: 'Documents', icon: FileText },
  { key: 'locations', label: 'Shipping locations', icon: MapPin },
  { key: 'settings', label: 'Settings', icon: Settings },
  { key: 'quoting', label: 'Quoting', icon: DollarSign },
  { key: 'orders', label: 'Orders', icon: Truck },
  { key: 'quotes', label: 'Quotes', icon: FileSpreadsheet },
  { key: 'ar', label: 'AR', icon: Banknote },
]

const statusColors: Record<CustomerStatus, string> = {
  NEW: 'bg-slate-100 text-slate-700',
  CONTACTED: 'bg-blue-100 text-blue-700',
  QUALIFIED: 'bg-indigo-100 text-indigo-700',
  QUOTED: 'bg-purple-100 text-purple-700',
  NURTURING: 'bg-pink-100 text-pink-700',
  PENDING: 'bg-amber-100 text-amber-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  DORMANT: 'bg-orange-100 text-orange-700',
  CLOSED: 'bg-gray-100 text-gray-700',
  BLOCKED: 'bg-red-100 text-red-700',
}

function stripRecord<T extends { id: string; createdAt: string; updatedAt: string }>(record: T): Omit<T, 'id' | 'createdAt' | 'updatedAt'> {
  const { id, createdAt, updatedAt, ...rest } = record
  return rest as Omit<T, 'id' | 'createdAt' | 'updatedAt'>
}

export function CustomerProfile({
  customer,
  divisions,
  locations,
  settings,
  catalog,
  isAdmin,
  activeCustomers,
  onClose,
  onSave,
  onStatusChange,
}: CustomerProfileProps) {
  const { value, set, setPartial, toRecord, errors } = useCustomerForm(customer)
  const [tab, setTab] = useState('account')
  const [saving, setSaving] = useState(false)
  const [statusAction, setStatusAction] = useState<'activate' | 'deactivate' | 'close' | null>(null)
  const { loads, orders, shipments, lastLoadAt, loading: loadsLoading } = useCustomerOrders(customer.id, customer)
  const ar = useCustomerAr(customer.id)

  /**
   * Exposure now spans both eras: orders carry it from booking to paid, and the loads
   * no order covers keep the Aljex-era rule. The oldest open invoice is what lets
   * `INVOICE_PAST_MAX_DAYS_LATE` fire at all — without a real invoice date the block
   * reason could never be reached, which is why it is read here rather than guessed.
   */
  const creditSummary = useMemo(() => creditSummaryForCustomer(
    customer,
    settings,
    { orders, shipments, loads },
    { oldestOpenInvoiceDays: oldestOpenInvoiceDays(ar.invoices, new Date().toISOString()) },
  ), [customer, settings, orders, shipments, loads, ar.invoices])

  const effectiveStatus = useMemo(
    () => effectiveCustomerStatus(customer, lastLoadAt, new Date().toISOString()),
    [customer, lastLoadAt],
  )

  const matchedLocations = useMemo(() => {
    const names = new Set<string>([customer.name.toLowerCase(), (customer.normalizedName ?? '').toLowerCase()])
    for (const a of customer.aliases ?? []) names.add(a.toLowerCase())
    return locations.filter(
      (l) =>
        l.customerIds?.includes(customer.id) ||
        (l.customerName && names.has(l.customerName.toLowerCase())),
    )
  }, [locations, customer])

  const canActivate = isAdmin || (customer.status === 'PENDING' && isAdmin) || ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING', 'BLOCKED', 'DORMANT'].includes(customer.status ?? '')
  const canClose = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING'].includes(customer.status ?? '')

  const save = async () => {
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    try {
      await onSave(customer, stripRecord(toRecord({ includeStatus: false })))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent className="w-full sm:max-w-4xl flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <SheetTitle className="flex items-center gap-2 text-base">
                {customer.name}
                {customer.status && (
                  <Badge variant="secondary" className={cn('text-[10px]', statusColors[customer.status])}>
                    {customer.status}
                  </Badge>
                )}
              </SheetTitle>
              <p className="text-xs text-muted-foreground">
                Board: {boardTab(effectiveStatus)} · effective status {effectiveStatus}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {canActivate && (
                <Button size="sm" onClick={() => setStatusAction('activate')}>
                  {customer.status === 'PENDING' ? 'Approve' : 'Activate'}
                </Button>
              )}
              {canClose && (
                <Button size="sm" variant="outline" onClick={() => setStatusAction('close')}>Close lead</Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setStatusAction('deactivate')}>Deactivate</Button>
              <Button size="icon" variant="ghost" onClick={onClose}><X size={16} /></Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1 pt-2">
            {tabs.map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md',
                    tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                  )}
                >
                  <Icon size={13} /> {t.label}
                </button>
              )
            })}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-6 py-4">
          {tab === 'account' && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Customer name</Label>
                  <Input value={value.name} onChange={(e) => set('name', e.target.value)} className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">MC #</Label>
                  <Input value={value.mcNumber} onChange={(e) => set('mcNumber', e.target.value)} className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">DOT #</Label>
                  <Input value={value.dotNumber} onChange={(e) => set('dotNumber', e.target.value)} className="h-9 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Lead source</Label>
                  <Input value={value.leadSource} onChange={(e) => set('leadSource', e.target.value)} className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Industry</Label>
                  <Input value={value.industry} onChange={(e) => set('industry', e.target.value)} className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Service tier</Label>
                  <Input value={value.serviceTier} onChange={(e) => set('serviceTier', e.target.value)} className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Website</Label>
                  <Input value={value.website} onChange={(e) => set('website', e.target.value)} className="h-9 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Payment terms (days)</Label>
                  <Input type="number" min={0} value={value.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} className="h-9 text-sm" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Default division</Label>
                  <Select value={value.defaultDivisionKey || '__UNSET__'} onValueChange={(v) => set('defaultDivisionKey', v === '__UNSET__' ? '' : v)}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__UNSET__">— unset —</SelectItem>
                      {divisions.map((d) => <SelectItem key={d.key} value={d.key}>{d.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Notes</Label>
                <Textarea value={value.notes} onChange={(e) => set('notes', e.target.value)} className="text-sm" />
              </div>
              <CreditLimitCard
                policy={creditSummary.policy}
                summary={creditSummary}
                editable={isAdmin}
                onChange={(patch) => {
                  if (patch.creditLimitCents !== undefined) set('creditLimitCents', patch.creditLimitCents)
                  if (patch.freeCreditRequired !== undefined) set('freeCreditRequired', patch.freeCreditRequired)
                  if (patch.creditUsageWarningBps !== undefined) set('creditUsageWarningBps', patch.creditUsageWarningBps)
                  if (patch.maxDaysLate !== undefined) set('maxDaysLate', patch.maxDaysLate)
                }}
              />
            </div>
          )}

          {tab === 'contacts' && (
            <div className="space-y-6">
              <section>
                <h3 className="text-sm font-semibold mb-3">Contacts</h3>
                <ContactsEditor
                  contacts={value.contacts}
                  billToPartyIds={value.billToParties.map((p) => p.id)}
                  onChange={(contacts) => set('contacts', contacts)}
                />
              </section>
              <section>
                <h3 className="text-sm font-semibold mb-3">Bill-to parties</h3>
                <BillToEditor parties={value.billToParties} onChange={(parties) => set('billToParties', parties)} />
              </section>
            </div>
          )}

          {tab === 'documents' && (
            <div className="space-y-6">
              <section>
                <DocumentTypesField
                  label="Required documents for invoice"
                  value={value.requiredDocs}
                  onChange={(next) => set('requiredDocs', next)}
                  help="What must be on file before this customer's orders can be invoiced. Leave every box clear to use the organization default; document upload is managed per shipment."
                />
              </section>
              <section>
                <h3 className="text-sm font-semibold mb-3">Required references</h3>
                <ReferencesEditor references={value.requiredReferences} onChange={(refs) => set('requiredReferences', refs)} />
              </section>
            </div>
          )}

          {tab === 'locations' && (
            <div className="space-y-3">
              {matchedLocations.length === 0 && <p className="text-sm text-muted-foreground">No linked locations.</p>}
              {matchedLocations.map((l) => (
                <div key={l.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start gap-3">
                    <MapPin size={16} className="mt-0.5 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{l.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[l.street, [l.city, l.state].filter(Boolean).join(', '), l.zip, l.country].filter(Boolean).join(' · ')}
                      </div>
                      {l.facilityType && <Badge variant="outline" className="mt-1 text-[10px]">{l.facilityType}</Badge>}
                      {l.apptContactEmail && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Appt: {[l.apptContactName, l.apptContactEmail, l.apptContactPhone].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'settings' && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Invoice frequency</Label>
                  <Select value={value.invoiceFrequency || '__UNSET__'} onValueChange={(v) => set('invoiceFrequency', v === '__UNSET__' ? '' : (v as InvoiceFrequency))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__UNSET__">— unset —</SelectItem>
                      {INVOICE_FREQUENCY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">GP split (bps)</Label>
                  <Input type="number" min={0} max={10000} value={value.gpSplitBps ?? ''} onChange={(e) => set('gpSplitBps', e.target.value ? Number(e.target.value) : null)} className="h-9 text-sm" />
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
                    <Switch checked={value.visibilityPrefs.milestoneEmails} onCheckedChange={(checked) => setPartial({ visibilityPrefs: { ...value.visibilityPrefs, milestoneEmails: checked } })} />
                    Milestone emails
                  </Label>
                  <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={value.visibilityPrefs.sharedTrackingLink} onCheckedChange={(checked) => setPartial({ visibilityPrefs: { ...value.visibilityPrefs, sharedTrackingLink: checked } })} />
                    Shared tracking link
                  </Label>
                  <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={value.visibilityPrefs.shipperPortal} onCheckedChange={(checked) => setPartial({ visibilityPrefs: { ...value.visibilityPrefs, shipperPortal: checked } })} />
                    Shipper portal
                  </Label>
                </div>
              </div>
            </div>
          )}

          {tab === 'quoting' && (
            <div className="space-y-6">
              <section>
                <h3 className="text-sm font-semibold mb-3">Pricing defaults</h3>
                <PricingDefaultsForm value={value.pricingDefaults} catalog={catalog} onChange={(pricingDefaults) => set('pricingDefaults', pricingDefaults)} />
              </section>
              <section>
                <h3 className="text-sm font-semibold mb-3">Quoting defaults</h3>
                <QuotingDefaultsForm value={value.quotingDefaults} onChange={(quotingDefaults) => set('quotingDefaults', quotingDefaults)} />
              </section>
              <section>
                <h3 className="text-sm font-semibold mb-3">Rate con terms override</h3>
                <Textarea value={value.rateConTerms} onChange={(e) => set('rateConTerms', e.target.value)} className="text-sm" />
              </section>
            </div>
          )}

          {tab === 'orders' && (
            <div className="space-y-3">
              {loadsLoading ? <p className="text-sm text-muted-foreground">Loading orders…</p>
                : loads.length === 0 ? <p className="text-sm text-muted-foreground">No matching loads.</p>
                : loads.map((load) => (
                  <div key={load.id} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">{load.tmsId || load.aljexId || load.id}</div>
                      <Badge variant="outline" className="text-[10px]">{loadStatus(load)}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {load.originCity} → {load.destinationCity} · {new Date(load.pickupAppt).toLocaleDateString()}
                    </div>
                    {load.rate != null && <div className="text-xs font-medium mt-1">{formatCents(load.rate)}</div>}
                    {load.rate == null && <div className="text-xs text-muted-foreground mt-1">No rate</div>}
                  </div>
                ))}
            </div>
          )}

          {tab === 'quotes' && <CustomerQuotesTab customerId={customer.id} />}

          {tab === 'ar' && (
            <CustomerArTab
              customerId={customer.id}
              customerName={customer.name}
              invoices={ar.invoices}
              payments={ar.payments}
              openCents={ar.openCents}
              unappliedCents={ar.unappliedCents}
              loading={ar.loading}
              error={ar.error}
              onRefresh={ar.refresh}
            />
          )}
        </ScrollArea>

        <div className="border-t px-6 py-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || Object.keys(errors).length > 0}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>

        <StatusActionDialog
          open={statusAction !== null}
          customer={customer}
          action={statusAction}
          activeCustomers={activeCustomers}
          onClose={() => setStatusAction(null)}
          onConfirm={(input) => {
            void onStatusChange(customer, input)
            setStatusAction(null)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}

/**
 * This customer's quotes, newest first, with the one number that says whether we are
 * pricing them well: the share of the quotes they actually decided that we won. Quotes
 * we withdrew are not a decision and are left out of the denominator, so cancelling a
 * duplicate cannot flatter or dent the rate.
 *
 * Its own component so the read only happens when somebody opens the tab.
 */
function CustomerQuotesTab({ customerId }: { customerId: string }) {
  const { quotes, loading, error } = useCustomerQuotes(customerId)

  const sell = useMemo(
    () => quotes.filter((q) => q.side === 'SELL')
      .slice()
      .sort((a, b) => (a.quoteDate < b.quoteDate ? 1 : a.quoteDate > b.quoteDate ? -1 : 0)),
    [quotes],
  )
  const won = sell.filter((q) => q.status === 'WON').length
  const decided = sell.filter((q) => q.status === 'WON' || q.status === 'LOST' || q.status === 'PASS').length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="text-sm">
          <span className="font-medium">{decided > 0 ? `${Math.round((won / decided) * 100)}%` : '—'}</span>
          <span className="text-muted-foreground"> win rate · {won} of {decided} decided</span>
        </div>
        <Button asChild size="sm" className="ml-auto h-8">
          <Link to={`/quotes/new?customerId=${encodeURIComponent(customerId)}`}>New quote</Link>
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {loading && sell.length === 0 ? <p className="text-sm text-muted-foreground">Loading quotes…</p>
        : sell.length === 0 ? <p className="text-sm text-muted-foreground">No quotes for this customer yet.</p>
        : sell.map((quote) => (
          <Link key={quote.id} to={`/quotes/${quote.id}`} className="block rounded-lg border border-border bg-card p-3 no-underline">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{quote.id}</div>
              <Badge variant="outline" className="text-[10px]">{QUOTE_STATUS_LABEL[quote.status]}</Badge>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {laneLabelFor(quote.laneKey)} · {quote.quoteDate}
            </div>
            <div className="mt-1 text-xs font-medium">{formatQuoteCents(quote.amountCents)}</div>
          </Link>
        ))}
    </div>
  )
}
