import { useMemo, useState, type ReactNode } from 'react'
import { TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { SEED_DIVISIONS } from '@/lib/ownership'
import { BILLING_METHOD_CHOICES } from '@/lib/newCustomerRules'
import { MoneyField } from './MoneyField'
import type { CustomerFormValue } from './useCustomerForm'
import { CustomerMcLookup } from './NewCustomerGuard'

const RED = 'var(--tms-badge-red)'

/** Label text, a red asterisk and the word "Required": the three things Ryne asked to see on every required field. */
export function RequiredLabel({ children }: { children: ReactNode }) {
  return (
    <>
      {children}{' '}
      <span aria-hidden="true" style={{ color: RED, fontWeight: 700 }}>*</span>{' '}
      <span data-testid="required-tag" style={{ color: RED, fontSize: 11, fontWeight: 500 }}>Required</span>
    </>
  )
}

/** The top-level divisions, in tree order; the seeds stand in until the table is read (or seeded). */
function useTopLevelDivisionOptions(): Array<{ value: string; label: string }> {
  const { divisions } = useOwnershipDivisions()
  return useMemo(() => {
    const rows = divisions && divisions.length > 0 ? divisions : SEED_DIVISIONS
    return rows
      .filter((d) => !d.parentId && d.active !== false)
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((d) => ({ value: d.code, label: d.name }))
  }, [divisions])
}

type SetFn = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => void

/**
 * The fields a new customer cannot be saved without. An inline error shows under a field once it has been
 * visited; the dialog's Save stays disabled, with the "Missing: ..." list, until all of them are valid.
 */
export function NewCustomerRequiredFields({ value, set, errors }: { value: CustomerFormValue; set: SetFn; errors: Record<string, string> }) {
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const touch = (key: string) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }))
  const shown = (key: string): string | undefined => (touched[key] ? errors[key] : undefined)
  const divisions = useTopLevelDivisionOptions()
  const isFactor = value.billingMethod === 'FACTOR'

  return (
    <div style={{ display: 'grid', gap: 12 }} data-testid="new-customer-required">
      <CustomerMcLookup value={value} set={set} />
      <TmsField label={<RequiredLabel>Name</RequiredLabel>} error={shown('name')}>
        <TmsInput value={value.name} aria-label="Name" aria-required="true" onBlur={() => touch('name')} onChange={(e) => set('name', e.target.value)} />
      </TmsField>

      <div role="group" aria-label="Address" style={{ display: 'grid', gap: 6 }}>
        <div className="tms-field-label"><RequiredLabel>Address</RequiredLabel></div>
        <div className="tms-grid tms-grid-2">
          <TmsInput value={value.billingAddressStreet} placeholder="Street" aria-label="Street" aria-required="true" onBlur={() => touch('address')} onChange={(e) => set('billingAddressStreet', e.target.value)} />
          <TmsInput value={value.billingAddressCity} placeholder="City" aria-label="City" aria-required="true" onBlur={() => touch('address')} onChange={(e) => set('billingAddressCity', e.target.value)} />
          <TmsInput value={value.billingAddressState} placeholder="State" aria-label="State" aria-required="true" onBlur={() => touch('address')} onChange={(e) => set('billingAddressState', e.target.value)} />
          <TmsInput value={value.billingAddressZip} placeholder="ZIP" aria-label="ZIP" aria-required="true" onBlur={() => touch('address')} onChange={(e) => set('billingAddressZip', e.target.value)} />
        </div>
        {shown('address') && <span className="tms-field-error">{shown('address')}</span>}
      </div>

      <div className="tms-grid tms-grid-2">
        <TmsField label={<RequiredLabel>Active</RequiredLabel>}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" aria-label="Active" checked={value.active} onChange={(e) => set('active', e.target.checked)} />
            {value.active ? 'Active' : 'Inactive'}
          </label>
        </TmsField>
        <TmsField label={<RequiredLabel>Default rev division</RequiredLabel>} error={shown('defaultDivisionKey')}>
          <TmsSelect
            value={value.defaultDivisionKey}
            aria-label="Default rev division"
            aria-required="true"
            placeholder="— choose —"
            options={divisions}
            onBlur={() => touch('defaultDivisionKey')}
            onChange={(e) => set('defaultDivisionKey', e.target.value)}
          />
        </TmsField>
      </div>

      <div className="tms-grid tms-grid-2">
        <TmsField label={<RequiredLabel>Billing method</RequiredLabel>} error={shown('billingMethod')}>
          <TmsSelect
            value={value.billingMethod}
            aria-label="Billing method"
            aria-required="true"
            placeholder="— choose —"
            options={BILLING_METHOD_CHOICES.map((m) => ({ value: m.value, label: m.label }))}
            onBlur={() => touch('billingMethod')}
            onChange={(e) => set('billingMethod', e.target.value as CustomerFormValue['billingMethod'])}
          />
        </TmsField>
        <TmsField label={<RequiredLabel>Accounts payable e-mail 1</RequiredLabel>} error={shown('apEmail')}>
          <TmsInput value={value.apEmail} aria-label="Accounts payable e-mail 1" aria-required="true" placeholder="ap@customer.com" onBlur={() => touch('apEmail')} onChange={(e) => set('apEmail', e.target.value)} />
        </TmsField>
      </div>
      {isFactor && <div style={{ fontSize: 13 }}>Factored invoices go to the factor. The AP e-mail is still kept on the customer.</div>}

      <TmsField
        label="Accounts payable copy-to e-mail"
        hint="Every invoice is copied here. invoices@bcatcorp.com is always included; add more addresses, one per line."
        error={shown('invoiceCopyEmails')}
      >
        <TmsTextarea value={value.invoiceCopyText} aria-label="Accounts payable copy-to e-mail" onBlur={() => touch('invoiceCopyEmails')} onChange={(e) => set('invoiceCopyText', e.target.value)} />
      </TmsField>

      <MoneyField label="Credit limit ($)" value={value.creditLimitCents} onChange={(cents) => set('creditLimitCents', cents)} grouped prefix="$" />
    </div>
  )
}
