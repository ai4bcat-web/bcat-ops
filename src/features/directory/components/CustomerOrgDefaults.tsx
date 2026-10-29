import { useState } from 'react'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import type { TmsSettings } from '@/types/tms'
import { MoneyField } from './MoneyField'
import { ReferencesEditor } from './ReferencesEditor'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'

type Defaults = Pick<TmsSettings, 'defaultCreditLimitCents' | 'defaultFreeCreditRequired' | 'defaultCreditUsageWarningBps' | 'defaultMaxDaysLate' | 'requireCustomerApproval' | 'defaultRequiredDocs' | 'defaultRequiredReferences' | 'rateConTerms'>

export function CustomerOrgDefaults({ settings, onSave, onClose }: {
  settings: TmsSettings | null
  onSave: (patch: Defaults) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Defaults>({
    defaultCreditLimitCents: settings?.defaultCreditLimitCents ?? null,
    defaultFreeCreditRequired: settings?.defaultFreeCreditRequired ?? false,
    defaultCreditUsageWarningBps: settings?.defaultCreditUsageWarningBps ?? null,
    defaultMaxDaysLate: settings?.defaultMaxDaysLate ?? null,
    requireCustomerApproval: settings?.requireCustomerApproval ?? false,
    defaultRequiredDocs: settings?.defaultRequiredDocs ?? [],
    defaultRequiredReferences: settings?.defaultRequiredReferences ?? [],
    rateConTerms: settings?.rateConTerms ?? null,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try { await onSave(draft); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose() }}
      title="Customer organization defaults"
      description="Used when a customer has no override. Changes do not rewrite customer records."
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton onClick={onClose} disabled={saving}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save defaults'}</TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="tms-grid tms-grid-2">
          <MoneyField label="Default credit limit" value={draft.defaultCreditLimitCents} onChange={(value) => setDraft({ ...draft, defaultCreditLimitCents: value })} disabled={saving} />
          <TmsField label="Credit warning %">
            <TmsInput
              aria-label="Default credit warning percent"
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={draft.defaultCreditUsageWarningBps == null ? '' : draft.defaultCreditUsageWarningBps / 100}
              onChange={(e) => setDraft({ ...draft, defaultCreditUsageWarningBps: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })}
              disabled={saving}
            />
          </TmsField>
          <TmsField label="Maximum days late">
            <TmsInput
              aria-label="Default maximum days late"
              type="number"
              min={0}
              step={1}
              value={draft.defaultMaxDaysLate ?? ''}
              onChange={(e) => setDraft({ ...draft, defaultMaxDaysLate: e.target.value === '' ? null : Number(e.target.value) })}
              disabled={saving}
            />
          </TmsField>
          <div style={{ display: 'grid', gap: 10, alignContent: 'center' }}>
            <label style={{ display: 'flex', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={draft.defaultFreeCreditRequired === true} onChange={(e) => setDraft({ ...draft, defaultFreeCreditRequired: e.target.checked })} disabled={saving} />
              Require free credit
            </label>
            <label style={{ display: 'flex', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={draft.requireCustomerApproval === true} onChange={(e) => setDraft({ ...draft, requireCustomerApproval: e.target.checked })} disabled={saving} />
              Require customer approval
            </label>
          </div>
        </div>
        <DocumentTypesField
          label="Required for accounting release"
          value={draft.defaultRequiredDocs}
          onChange={(next) => setDraft({ ...draft, defaultRequiredDocs: next })}
          disabled={saving}
          help="What every customer needs on file before a shipment can be released to accounting and invoiced, unless that customer asks for its own list."
        />
        <div>
          <h3 style={{ marginBottom: 8 }}>Required references</h3>
          <ReferencesEditor references={draft.defaultRequiredReferences ?? []} onChange={(refs) => setDraft({ ...draft, defaultRequiredReferences: refs })} disabled={saving} />
        </div>
        <TmsField label="Default rate confirmation terms">
          <TmsTextarea
            aria-label="Default rate confirmation terms"
            value={draft.rateConTerms ?? ''}
            onChange={(e) => setDraft({ ...draft, rateConTerms: e.target.value || null })}
            disabled={saving}
          />
        </TmsField>
        {error && <p role="alert" className="tms-field-error">{error}</p>}
      </div>
    </TmsDialog>
  )
}
