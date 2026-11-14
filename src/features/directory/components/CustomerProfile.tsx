import { InvoiceEmailBadge } from './EmailReadinessBadge'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { isCrmManager } from '@/features/crm/format'
import { useCrmAccount } from '@/features/crm/useCrmAccount'
import { CrmStrip } from './CrmStrip'
import { ActivityTab } from './ActivityTab'
import { ContactsUnion } from './ContactsUnion'
import { RepPicker, TeamPicker } from '@/components/RepPicker'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsDialog,
  TmsField,
  TmsEmptyState,
  TmsInput,
  TmsMetaList,
  TmsProfileHeader,
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
import { BillingMethodFields } from './BillingMethodFields'
import { PossibleDuplicateBadge } from './PossibleDuplicateBadge'
import { buildDuplicateIndex } from '@/lib/customerDuplicates'
import { ContactsEditor } from './ContactsEditor'
import { BillToEditor } from './BillToEditor'
import { ReferencesEditor } from './ReferencesEditor'
import { PricingDefaultsForm } from './PricingDefaultsForm'
import { QuotingDefaultsForm } from './QuotingDefaultsForm'
import { CreditLimitCard } from './CreditLimitCard'
import { ReviewRequirementsField } from './ReviewRequirementsField'
import { CustomerArTab } from './CustomerArTab'
import { CustomerHistoryTab } from './CustomerHistoryTab'
import { changeNeedsReason, diffCustomer } from '@/lib/customerAudit'
import { StatusActionDialog } from './StatusActionDialog'
import { FlowDefaultsCard } from './FlowDefaultsCard'
import { TrackingPrefsFields } from './TrackingPrefsFields'
import { TrackingAutomationEditor } from '@/features/settings/automation/TrackingAutomationEditor'
import { resolveAutomation } from '@/lib/trackingAutomation'
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
  onSave: (current: CustomerRecord, next: Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'> & { changeReason?: string }) => Promise<void>
  onStatusChange: (current: CustomerRecord, input: { status: CustomerStatus; reason?: string; replacementCustomerId?: string }) => Promise<void>
  /** Admins: open delete / merge / archive for this customer. */
  onRemove?: () => void
}

const tabs = [
  { key: 'account', label: 'Account' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'activity', label: 'Activity' },
  { key: 'history', label: 'History' },
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
  onRemove,
}: CustomerProfileProps) {
  const { value, set, setPartial, toRecord, errors } = useCustomerForm(customer)
  const duplicates = useMemo(
    () => buildDuplicateIndex(activeCustomers.some((c) => c.id === customer.id) ? activeCustomers : [...activeCustomers, customer]),
    [activeCustomers, customer],
  )
  const [tab, setTab] = useState('account')
  const [saving, setSaving] = useState(false)
  const [statusAction, setStatusAction] = useState<'activate' | 'deactivate' | 'close' | null>(null)
  const { loads, orders, shipments, lastLoadAt, loading: loadsLoading } = useCustomerOrders(customer.id, customer)
  const ar = useCustomerAr(customer.id)
  const crm = useCrmAccount(customer.id)
  const auth = useAuth()
  const isManager = isCrmManager(auth)
  const accountOwnerIds = value.accountOwnerIdsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  // The layers above the customer: org defaults only (a profile knows no division).
  const inheritedAutomation = useMemo(
    () => resolveAutomation({ settings, customer: null, load: null, revDivision: null }).policy,
    [settings],
  )

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

  // Ryne 2026-11-14: every change is recorded with why; payment method, terms, factoring and
  // billing/invoice e-mails cannot be changed without one (the server refuses too).
  const [changeReason, setChangeReason] = useState('')
  const reasonRequired = useMemo(
    () => changeNeedsReason(diffCustomer(customer as unknown as Record<string, unknown>, stripRecord(toRecord({ includeStatus: false })) as unknown as Record<string, unknown>)),
    // toRecord reads `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customer, value],
  )
  const reasonMissing = reasonRequired && changeReason.trim() === ''

  const save = async () => {
    if (Object.keys(errors).length > 0 || reasonMissing) return
    setSaving(true)
    try {
      const reason = changeReason.trim()
      await onSave(customer, { ...stripRecord(toRecord({ includeStatus: false })), ...(reason ? { changeReason: reason } : {}) })
      setChangeReason('')
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
    await onSave(customer, { ...stripRecord(toRecord({ includeStatus: false })), aiMemory, ...(changeReason.trim() ? { changeReason: changeReason.trim() } : {}) })
  }

  return (
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      className="tms-dialog-xl"
      title="Customer profile"
      footer={
        <>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <TmsInput
              id="customer-change-reason"
              data-testid="customer-change-reason"
              aria-label="Reason for change"
              placeholder={reasonRequired ? 'Reason for change (required for billing changes)' : 'Reason for change (optional)'}
              value={changeReason}
              maxLength={500}
              onChange={(e) => setChangeReason(e.target.value)}
              aria-invalid={reasonMissing || undefined}
            />
            {reasonMissing && <p className="mt-0.5 text-xs text-[color:var(--tms-badge-red)]">Say why the payment method, terms, factoring or billing e-mail is changing.</p>}
          </div>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={save} disabled={saving || Object.keys(errors).length > 0 || reasonMissing}>{saving ? 'Saving…' : 'Save'}</TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <TmsProfileHeader
          name={customer.name}
          as="h3"
          subtitle={`Board: ${boardTab(effectiveStatus)} · effective status ${effectiveStatus}`}
          chips={
            <>
              {customer.status ? <TmsBadge tone={statusTones[customer.status]}>{customer.status}</TmsBadge> : null}
              <PossibleDuplicateBadge info={duplicates.get(customer.id)} />
              <InvoiceEmailBadge customer={customer} />
            </>
          }
          actions={
            <>
              {canActivate && (
                <TmsButton variant="primary" size="sm" onClick={() => setStatusAction('activate')}>
                  {customer.status === 'PENDING' ? 'Approve' : 'Activate'}
                </TmsButton>
              )}
              {canClose && <TmsButton size="sm" onClick={() => setStatusAction('close')}>Close lead</TmsButton>}
              <TmsButton size="sm" onClick={() => setStatusAction('deactivate')}>Deactivate</TmsButton>
              {onRemove && <TmsButton size="sm" variant="destructive" data-testid="customer-profile-remove" onClick={onRemove}>Delete / merge…</TmsButton>}
            </>
          }
          columns={[
            { title: 'MC', rows: [{ label: 'MC #', value: customer.mcNumber || '—' }, { label: 'DOT #', value: customer.dotNumber || '—' }] },
            { title: 'Billing', rows: [{ label: 'Terms', value: customer.paymentTermsDays != null ? `Net ${customer.paymentTermsDays}` : '—' }, { label: 'Method', value: customer.billingMethod === 'FACTOR' ? 'Factor' : customer.billingMethod === 'MANUAL' ? 'Manual' : 'Not set' }] },
            { title: 'Account owner', rows: [{ value: accountOwnerIds.length ? `${accountOwnerIds.length} assigned` : 'Unassigned' }] },
          ]}
        />

        <CrmStrip
          customer={customer}
          view={crm.view}
          loading={crm.loading}
          error={crm.error}
          isManager={isManager}
          tone={customer.status ? statusTones[customer.status] : undefined}
          onSetNextStep={crm.setNextStep}
          onReleaseDomain={crm.releaseDomain}
        />

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
            <TmsCard title="Billing method">
              <BillingMethodFields value={value} set={set} errors={errors} factor={settings?.factorRemitTo ?? null} />
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

        {tab === 'activity' && (
          <ActivityTab
            view={crm.view}
            loading={crm.loading}
            error={crm.error}
            onAddActivity={crm.addActivity}
            onAddTask={crm.addTask}
            onCompleteTask={crm.completeTask}
          />
        )}

        {tab === 'contacts' && (
          <div style={{ display: 'grid', gap: 16 }}>
            {crm.view?.visible && (
              <TmsCard title="People on this account">
                <ContactsUnion view={crm.view} onAdd={crm.addContact} />
              </TmsCard>
            )}
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
            <TmsCard title="Required for Load Review">
              <ReviewRequirementsField
                value={value.reviewRequirements}
                inheritFrom={settings?.reviewRequirements ?? null}
                onChange={(next) => set('reviewRequirements', next)}
              />
            </TmsCard>
            <TmsCard title="Required references">
              <ReferencesEditor references={value.requiredReferences} onChange={(refs) => set('requiredReferences', refs)} />
            </TmsCard>
          </div>
        )}

        {tab === 'locations' && (
          <div style={{ display: 'grid', gap: 8 }}>
            {matchedLocations.length === 0 && <TmsEmptyState compact title="No linked locations." message="" />}
            {matchedLocations.map((l) => (
              <TmsCard key={l.id} title={l.name}>
                <TmsMetaList
                  columns={2}
                  dense
                  items={[
                    { label: 'Address', value: [l.street, [l.city, l.state].filter(Boolean).join(', '), l.zip, l.country].filter(Boolean).join(' · '), wide: true },
                    { label: 'Facility', value: l.facilityType ? <TmsBadge tone="blue">{l.facilityType}</TmsBadge> : null, hidden: !l.facilityType },
                    { label: 'Appt', value: [l.apptContactName, l.apptContactEmail, l.apptContactPhone].filter(Boolean).join(' · '), hidden: !l.apptContactEmail },
                  ]}
                />
              </TmsCard>
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
            <FlowDefaultsCard
              settings={settings}
              value={{
                defaultCarrierTeamKey: value.defaultCarrierTeamKey,
                defaultCarrierRepId: value.defaultCarrierRepId,
                defaultTrackerId: value.defaultTrackerId,
                marginTargetBps: value.marginTargetBps,
                marginFloorBps: value.marginFloorBps,
                quoteAutoReply: value.quoteAutoReply,
                requiredLoadFields: value.requiredLoadFields,
                checkCallPlan: value.checkCallPlan,
              }}
              onChange={(patch) => setPartial(patch)}
            />
            <TmsCard title="Tracking">
              <TrackingPrefsFields value={value} onChange={(patch) => setPartial(patch)} legacyHint />
            </TmsCard>
            <TmsCard title="Tracking automation">
              <p className="tms-muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
                Overrides the org defaults for this customer. Division overrides apply per shipment.
              </p>
              <TrackingAutomationEditor
                scope="CUSTOMER"
                value={value.trackingAutomation ?? {}}
                inherited={inheritedAutomation}
                onChange={(next) => set('trackingAutomation', Object.keys(next).length ? next : null)}
              />
            </TmsCard>
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

        {tab === 'history' && <CustomerHistoryTab customerId={customer.id} refreshKey={customer.updatedAt} />}

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
