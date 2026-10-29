import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { RepPicker, TeamPicker } from '@/components/RepPicker'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsDialog,
  TmsField,
  TmsInput,
  TmsSelect,
  TmsTabs,
  TmsTextarea,
} from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'
import { PartyAiMemoryTab } from '@/features/tms/settings/AiAgentsPage'
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
  AiAgentKey,
  CustomerRecord,
  Division,
  LocationRecord,
  PartyAiMemory,
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
  { key: 'account', label: 'Account' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'documents', label: 'Documents' },
  { key: 'locations', label: 'Shipping locations' },
  { key: 'settings', label: 'Settings' },
  { key: 'quoting', label: 'Quoting' },
  { key: 'aiAgents', label: 'AI Agents' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'quotes', label: 'Quotes' },
  { key: 'ar', label: 'AR' },
]

/** The two agents that ever read a customer: their mail is quotes and tenders. */
const CUSTOMER_AGENTS: readonly AiAgentKey[] = ['QUOTE', 'TENDER']

const statusTones: Record<CustomerStatus, TmsTone> = {
  NEW: 'gray',
  CONTACTED: 'blue',
  QUALIFIED: 'turquoise',
  QUOTED: 'purple',
  NURTURING: 'pink',
  PENDING: 'orange',
  ACTIVE: 'green',
  DORMANT: 'orange',
  CLOSED: 'gray',
  BLOCKED: 'red',
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
  const accountOwnerIds = value.accountOwnerIdsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  /**
   * Exposure now spans both eras: shipments carry it from booking to paid, and the loads
   * no shipment covers keep the Aljex-era rule. The oldest open invoice is what lets
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

  /**
   * The notes ride the profile's one write door — `UPSERT_CUSTOMER` through `onSave` —
   * rather than a second path of their own, so a save from this tab is the same save
   * the footer button makes, with `aiMemory` added.
   */
  const saveAiMemory = async (aiMemory: PartyAiMemory) => {
    await onSave(customer, { ...stripRecord(toRecord({ includeStatus: false })), aiMemory })
  }

  return (
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      className="tms-dialog-xl"
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {customer.name}
          {customer.status && <TmsBadge tone={statusTones[customer.status]}>{customer.status}</TmsBadge>}
        </span>
      }
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={save} disabled={saving || Object.keys(errors).length > 0}>{saving ? 'Saving…' : 'Save'}</TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>
            Board: {boardTab(effectiveStatus)} · effective status {effectiveStatus}
          </p>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {canActivate && (
              <TmsButton variant="primary" size="sm" onClick={() => setStatusAction('activate')}>
                {customer.status === 'PENDING' ? 'Approve' : 'Activate'}
              </TmsButton>
            )}
            {canClose && <TmsButton size="sm" onClick={() => setStatusAction('close')}>Close lead</TmsButton>}
            <TmsButton size="sm" onClick={() => setStatusAction('deactivate')}>Deactivate</TmsButton>
          </div>
        </div>

        <TmsTabs tabs={tabs} active={tab} onSelect={setTab} />

        {tab === 'account' && (
          <div style={{ display: 'grid', gap: 16 }}>
            <TmsCard title="Account">
              <div style={{ display: 'grid', gap: 16 }}>
                <div className="tms-grid tms-grid-3">
                  <TmsField label="Customer name">
                    <TmsInput value={value.name} onChange={(e) => set('name', e.target.value)} />
                  </TmsField>
                  <TmsField label="MC #">
                    <TmsInput value={value.mcNumber} onChange={(e) => set('mcNumber', e.target.value)} />
                  </TmsField>
                  <TmsField label="DOT #">
                    <TmsInput value={value.dotNumber} onChange={(e) => set('dotNumber', e.target.value)} />
                  </TmsField>
                </div>
                <div className="tms-grid tms-grid-4">
                  <TmsField label="Lead source">
                    <TmsInput value={value.leadSource} onChange={(e) => set('leadSource', e.target.value)} />
                  </TmsField>
                  <TmsField label="Industry">
                    <TmsInput value={value.industry} onChange={(e) => set('industry', e.target.value)} />
                  </TmsField>
                  <TmsField label="Service tier">
                    <TmsInput value={value.serviceTier} onChange={(e) => set('serviceTier', e.target.value)} />
                  </TmsField>
                  <TmsField label="Website">
                    <TmsInput value={value.website} onChange={(e) => set('website', e.target.value)} />
                  </TmsField>
                </div>
                <div className="tms-grid tms-grid-2">
                  <TmsField label="Payment terms (days)">
                    <TmsInput type="number" min={0} value={value.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} />
                  </TmsField>
                  <TmsField label="Default division">
                    <TmsSelect
                      value={value.defaultDivisionKey || ''}
                      onChange={(e) => set('defaultDivisionKey', e.target.value)}
                      placeholder="— unset —"
                      options={divisions.map((d) => ({ value: d.key, label: d.name }))}
                    />
                  </TmsField>
                </div>
                <TmsField label="Notes">
                  <TmsTextarea value={value.notes} onChange={(e) => set('notes', e.target.value)} />
                </TmsField>
              </div>
            </TmsCard>
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
          <div style={{ display: 'grid', gap: 16 }}>
            <TmsCard title="Contacts">
              <ContactsEditor
                contacts={value.contacts}
                billToPartyIds={value.billToParties.map((p) => p.id)}
                onChange={(contacts) => set('contacts', contacts)}
              />
            </TmsCard>
            <TmsCard title="Bill-to parties">
              <BillToEditor parties={value.billToParties} onChange={(parties) => set('billToParties', parties)} />
            </TmsCard>
          </div>
        )}

        {tab === 'documents' && (
          <div style={{ display: 'grid', gap: 16 }}>
            <TmsCard title="Required for accounting release">
              <DocumentTypesField
                label="Required documents"
                value={value.requiredDocs}
                onChange={(next) => set('requiredDocs', next)}
                help="What must be on file before this customer's shipments can be released to accounting and invoiced. Leave every box clear to use the organization default; document upload is managed per shipment."
              />
            </TmsCard>
            <TmsCard title="Required references">
              <ReferencesEditor references={value.requiredReferences} onChange={(refs) => set('requiredReferences', refs)} />
            </TmsCard>
          </div>
        )}

        {tab === 'locations' && (
          <div style={{ display: 'grid', gap: 8 }}>
            {matchedLocations.length === 0 && <p className="tms-muted" style={{ fontSize: 13 }}>No linked locations.</p>}
            {matchedLocations.map((l) => (
              <div key={l.id} className="tms-card">
                <div className="tms-card-body">
                  <div style={{ fontWeight: 600 }}>{l.name}</div>
                  <div className="tms-muted" style={{ fontSize: 12 }}>
                    {[l.street, [l.city, l.state].filter(Boolean).join(', '), l.zip, l.country].filter(Boolean).join(' · ')}
                  </div>
                  {l.facilityType && <div style={{ marginTop: 4 }}><TmsBadge tone="blue">{l.facilityType}</TmsBadge></div>}
                  {l.apptContactEmail && (
                    <div className="tms-muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Appt: {[l.apptContactName, l.apptContactEmail, l.apptContactPhone].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'settings' && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div className="tms-grid tms-grid-3">
              <TmsField label="Invoice frequency">
                <TmsSelect
                  value={value.invoiceFrequency || ''}
                  onChange={(e) => set('invoiceFrequency', e.target.value as InvoiceFrequency | '')}
                  placeholder="— unset —"
                  options={INVOICE_FREQUENCY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </TmsField>
              <TmsField label="GP split (bps)">
                <TmsInput type="number" min={0} max={10000} value={value.gpSplitBps ?? ''} onChange={(e) => set('gpSplitBps', e.target.value ? Number(e.target.value) : null)} />
              </TmsField>
              <div className="tms-field">
                <span className="tms-field-label">Team key</span>
                <TeamPicker
                  value={value.teamKey}
                  onChange={(v) => set('teamKey', v)}
                  teams={settings?.teams}
                  allowEmpty
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <div className="tms-grid tms-grid-2">
              <div className="tms-field">
                <span className="tms-field-label">Operated by</span>
                <RepPicker
                  role="CUSTOMER_REP"
                  allowUnknown
                  value={value.operatedById}
                  onChange={(v) => set('operatedById', v)}
                  placeholder="Pick who operates it…"
                />
              </div>
              <div className="tms-field">
                <span className="tms-field-label">Account owners</span>
                <RepPicker
                  multiple
                  role="CUSTOMER_REP"
                  allowUnknown
                  value={accountOwnerIds}
                  onChange={(next) => set('accountOwnerIdsText', next.join('\n'))}
                  placeholder="Add an account owner…"
                />
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <span className="tms-field-label">Visibility preferences</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={value.visibilityPrefs.milestoneEmails} onChange={(e) => setPartial({ visibilityPrefs: { ...value.visibilityPrefs, milestoneEmails: e.target.checked } })} />
                  Milestone emails
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={value.visibilityPrefs.sharedTrackingLink} onChange={(e) => setPartial({ visibilityPrefs: { ...value.visibilityPrefs, sharedTrackingLink: e.target.checked } })} />
                  Shared tracking link
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={value.visibilityPrefs.shipperPortal} onChange={(e) => setPartial({ visibilityPrefs: { ...value.visibilityPrefs, shipperPortal: e.target.checked } })} />
                  Shipper portal
                </label>
              </div>
            </div>
          </div>
        )}

        {tab === 'quoting' && (
          <div style={{ display: 'grid', gap: 16 }}>
            <TmsCard title="Pricing defaults">
              <PricingDefaultsForm value={value.pricingDefaults} catalog={catalog} onChange={(pricingDefaults) => set('pricingDefaults', pricingDefaults)} />
            </TmsCard>
            <TmsCard title="Quoting defaults">
              <QuotingDefaultsForm value={value.quotingDefaults} onChange={(quotingDefaults) => set('quotingDefaults', quotingDefaults)} />
            </TmsCard>
            <TmsCard title="Rate con terms override">
              <TmsTextarea value={value.rateConTerms} onChange={(e) => set('rateConTerms', e.target.value)} aria-label="Rate con terms override" />
            </TmsCard>
          </div>
        )}

        {tab === 'aiAgents' && (
          <PartyAiMemoryTab
            partyId={customer.id}
            partyWord="customer"
            agents={CUSTOMER_AGENTS}
            memory={customer.aiMemory}
            onSave={saveAiMemory}
          />
        )}

        {tab === 'shipments' && (
          <div style={{ display: 'grid', gap: 8 }}>
            {loadsLoading ? <p className="tms-muted" style={{ fontSize: 13 }}>Loading shipments…</p>
              : loads.length === 0 ? <p className="tms-muted" style={{ fontSize: 13 }}>No matching shipments.</p>
              : loads.map((load) => (
                <div key={load.id} className="tms-card">
                  <div className="tms-card-body">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontWeight: 600 }}>{load.tmsId || load.aljexId || load.id}</div>
                      <TmsBadge>{loadStatus(load)}</TmsBadge>
                    </div>
                    <div className="tms-muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {load.originCity} → {load.destinationCity} · {new Date(load.pickupAppt).toLocaleDateString()}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }} className={load.rate == null ? 'tms-muted' : undefined}>
                      {load.rate != null ? formatCents(load.rate) : 'No rate'}
                    </div>
                  </div>
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
    </TmsDialog>
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
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{decided > 0 ? `${Math.round((won / decided) * 100)}%` : '—'}</span>
          <span className="tms-muted"> win rate · {won} of {decided} decided</span>
        </div>
        <Link to={`/tms/rates/new?customerId=${encodeURIComponent(customerId)}`} className="tms-btn tms-btn-primary tms-btn-sm" style={{ marginLeft: 'auto' }}>
          New quote
        </Link>
      </div>

      {error && <p className="tms-field-error">{error}</p>}

      {loading && sell.length === 0 ? <p className="tms-muted" style={{ fontSize: 13 }}>Loading quotes…</p>
        : sell.length === 0 ? <p className="tms-muted" style={{ fontSize: 13 }}>No quotes for this customer yet.</p>
        : sell.map((quote) => (
          <Link key={quote.id} to={`/tms/rates/${quote.id}`} className="tms-card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
            <div className="tms-card-body">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>{quote.id}</div>
                <TmsBadge>{QUOTE_STATUS_LABEL[quote.status]}</TmsBadge>
              </div>
              <div className="tms-muted" style={{ fontSize: 12, marginTop: 4 }}>
                {laneLabelFor(quote.laneKey)} · {quote.quoteDate}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>{formatQuoteCents(quote.amountCents)}</div>
            </div>
          </Link>
        ))}
    </div>
  )
}
