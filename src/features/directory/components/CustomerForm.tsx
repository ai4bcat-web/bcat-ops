import { useEffect, useState } from 'react'
import { RepPicker, TeamPicker } from '@/components/RepPicker'
import { TmsField, TmsInput, TmsSelect, TmsTabs, TmsTextarea } from '@/features/tms/kit'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'
import { MoneyField } from './MoneyField'
import { getTmsSettings } from '@/lib/apiClient'
import type { Division, CustomerStatus, Team } from '@/types/tms'
import type { CustomerFormValue } from './useCustomerForm'
import { APPT_WORKFLOW_OPTIONS, INVOICE_FREQUENCY_OPTIONS } from './useCustomerForm'

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
  const [teams, setTeams] = useState<Team[]>([])
  const accountOwnerIds = value.accountOwnerIdsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  // The dialog that hosts this form has no settings of its own, and threading one read
  // down through the directory page would buy nothing: the teams list is tiny and cached.
  useEffect(() => {
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setTeams(s?.teams ?? []) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <TmsTabs tabs={tabs.map((t) => ({ key: t, label: t }))} active={tab} onSelect={setTab} />

      {tab === 'Overview' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <TmsField label="Customer name *" error={errors.name}>
            <TmsInput value={value.name} onChange={(e) => set('name', e.target.value)} />
          </TmsField>
          <div className="tms-grid tms-grid-3">
            <TmsField label="Status">
              <TmsSelect
                value={value.status || ''}
                onChange={(e) => set('status', e.target.value as CustomerStatus | '')}
                placeholder="— unset —"
                options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
              />
            </TmsField>
            <TmsField label="Lead source">
              <TmsInput value={value.leadSource} onChange={(e) => set('leadSource', e.target.value)} />
            </TmsField>
            <TmsField label="Industry">
              <TmsInput value={value.industry} onChange={(e) => set('industry', e.target.value)} />
            </TmsField>
          </div>
          <div className="tms-grid tms-grid-3">
            <TmsField label="Service tier">
              <TmsInput value={value.serviceTier} onChange={(e) => set('serviceTier', e.target.value)} />
            </TmsField>
            <TmsField label="Website">
              <TmsInput value={value.website} onChange={(e) => set('website', e.target.value)} />
            </TmsField>
            <TmsField label="Appt workflow">
              <TmsSelect
                value={value.apptWorkflow}
                onChange={(e) => set('apptWorkflow', e.target.value as 'UNSET' | 'NONE' | 'BATORY')}
                options={APPT_WORKFLOW_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </TmsField>
          </div>
          <div className="tms-grid tms-grid-3">
            <TmsField label="MC #">
              <TmsInput value={value.mcNumber} onChange={(e) => set('mcNumber', e.target.value)} />
            </TmsField>
            <TmsField label="DOT #">
              <TmsInput value={value.dotNumber} onChange={(e) => set('dotNumber', e.target.value)} />
            </TmsField>
            <TmsField label="Payment terms (days)" error={errors.paymentTermsDays}>
              <TmsInput type="number" min={0} value={value.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} />
            </TmsField>
          </div>
          <div className="tms-grid tms-grid-3">
            <TmsField label="Contact name">
              <TmsInput value={value.contactName} onChange={(e) => set('contactName', e.target.value)} />
            </TmsField>
            <TmsField label="Contact phone">
              <TmsInput value={value.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
            </TmsField>
            <TmsField label="Contact email">
              <TmsInput value={value.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
            </TmsField>
          </div>
          <TmsField label="Notes">
            <TmsTextarea value={value.notes} onChange={(e) => set('notes', e.target.value)} />
          </TmsField>
          <TmsField label="Aliases">
            <TmsTextarea value={value.aliasesText} onChange={(e) => set('aliasesText', e.target.value)} placeholder="One per line" />
          </TmsField>
        </div>
      )}

      {tab === 'Billing' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div>
            <div className="tms-field-label">Billing contact</div>
            <div className="tms-grid tms-grid-3" style={{ marginTop: 6 }}>
              <TmsInput value={value.billingContactName} onChange={(e) => set('billingContactName', e.target.value)} placeholder="Name" aria-label="Billing contact name" />
              <TmsInput value={value.billingPhone} onChange={(e) => set('billingPhone', e.target.value)} placeholder="Phone" aria-label="Billing phone" />
              <TmsInput value={value.billingEmail} onChange={(e) => set('billingEmail', e.target.value)} placeholder="Email" aria-label="Billing email" />
            </div>
          </div>
          <div>
            <div className="tms-field-label">Billing address</div>
            <div className="tms-grid tms-grid-2" style={{ marginTop: 6 }}>
              <TmsInput value={value.billingAddressStreet} onChange={(e) => set('billingAddressStreet', e.target.value)} placeholder="Street" aria-label="Billing street" />
              <TmsInput value={value.billingAddressCity} onChange={(e) => set('billingAddressCity', e.target.value)} placeholder="City" aria-label="Billing city" />
              <TmsInput value={value.billingAddressState} onChange={(e) => set('billingAddressState', e.target.value)} placeholder="State" aria-label="Billing state" />
              <TmsInput value={value.billingAddressZip} onChange={(e) => set('billingAddressZip', e.target.value)} placeholder="ZIP" aria-label="Billing ZIP" />
              <TmsInput value={value.billingAddressCountry} onChange={(e) => set('billingAddressCountry', e.target.value)} placeholder="Country" aria-label="Billing country" />
            </div>
          </div>
          <div className="tms-grid tms-grid-2">
            <TmsField label="Default division">
              <TmsSelect
                value={value.defaultDivisionKey || ''}
                onChange={(e) => set('defaultDivisionKey', e.target.value)}
                placeholder="— unset —"
                options={divisions.map((d) => ({ value: d.key, label: d.name }))}
              />
            </TmsField>
            <TmsField label="Default sales rep">
              <TmsInput value={value.defaultSalesRepId} onChange={(e) => set('defaultSalesRepId', e.target.value)} />
            </TmsField>
          </div>
          <DocumentTypesField
            label="Required for accounting release"
            value={value.requiredDocs}
            onChange={(next) => set('requiredDocs', next)}
            help="Leave every box clear to use the organization default."
          />
        </div>
      )}

      {tab === 'Credit & pricing' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="tms-grid tms-grid-3">
            <MoneyField label="Credit limit ($)" value={value.creditLimitCents} onChange={(cents) => set('creditLimitCents', cents)} />
            <TmsField label="Usage warning (bps)" error={errors.creditUsageWarningBps}>
              <TmsInput type="number" min={0} max={10000} value={value.creditUsageWarningBps ?? ''} onChange={(e) => set('creditUsageWarningBps', e.target.value ? Number(e.target.value) : null)} />
            </TmsField>
            <TmsField label="Max days late" error={errors.maxDaysLate}>
              <TmsInput type="number" min={0} value={value.maxDaysLate ?? ''} onChange={(e) => set('maxDaysLate', e.target.value ? Number(e.target.value) : null)} />
            </TmsField>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={value.freeCreditRequired === true} onChange={(e) => set('freeCreditRequired', e.target.checked)} />
              Free credit required
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={value.creditHoldFlag} onChange={(e) => set('creditHoldFlag', e.target.checked)} />
              Credit hold
            </label>
          </div>
          <TmsField label="GP split (bps)" error={errors.gpSplitBps}>
            <TmsInput type="number" min={0} max={10000} value={value.gpSplitBps ?? ''} onChange={(e) => set('gpSplitBps', e.target.value ? Number(e.target.value) : null)} />
          </TmsField>
          <TmsField label="Rate con terms override">
            <TmsTextarea value={value.rateConTerms} onChange={(e) => set('rateConTerms', e.target.value)} />
          </TmsField>
        </div>
      )}

      {tab === 'Settings' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="tms-grid tms-grid-2">
            <TmsField label="Invoice frequency">
              <TmsSelect
                value={value.invoiceFrequency || ''}
                onChange={(e) => set('invoiceFrequency', e.target.value as typeof INVOICE_FREQUENCY_OPTIONS[number]['value'] | '')}
                placeholder="— unset —"
                options={INVOICE_FREQUENCY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </TmsField>
            <div className="tms-field">
              <span className="tms-field-label">Team key</span>
              <TeamPicker
                value={value.teamKey}
                onChange={(v) => set('teamKey', v)}
                teams={teams}
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
                <input type="checkbox" checked={value.visibilityPrefs.milestoneEmails} onChange={(e) => set('visibilityPrefs', { ...value.visibilityPrefs, milestoneEmails: e.target.checked })} />
                Milestone emails
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={value.visibilityPrefs.sharedTrackingLink} onChange={(e) => set('visibilityPrefs', { ...value.visibilityPrefs, sharedTrackingLink: e.target.checked })} />
                Shared tracking link
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={value.visibilityPrefs.shipperPortal} onChange={(e) => set('visibilityPrefs', { ...value.visibilityPrefs, shipperPortal: e.target.checked })} />
                Shipper portal
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
