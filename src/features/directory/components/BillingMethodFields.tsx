import { TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import type { BillingMethod } from '@/lib/billingMethod'
import type { RemitTo } from '@/types/tms'
import type { CustomerFormValue } from './useCustomerForm'

const BILLING_METHOD_OPTIONS: { value: BillingMethod | ''; label: string }[] = [
  { value: '', label: 'Not set (cannot be released to billing)' },
  { value: 'FACTOR', label: 'Factor' },
  { value: 'MANUAL', label: 'Manual (e-mail to AP)' },
]

/**
 * Step AW stage D: how this customer is billed. Shared by the add form and the profile so the two
 * cannot drift. A FACTOR customer shows the single factor record read-only and never an AP e-mail.
 */
export function BillingMethodFields({
  value,
  set,
  errors,
  factor,
}: {
  value: CustomerFormValue
  set: <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => void
  errors: Record<string, string>
  factor: RemitTo | null
}) {
  const isFactor = value.billingMethod === 'FACTOR'
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="billing-method-section">
      <div className="tms-field-label">How this customer is billed</div>
      {value.billingNeedsReview && <div role="status" style={{ fontSize: 13 }}>Needs review: {value.billingNeedsReview}</div>}
      <div className="tms-grid tms-grid-3">
        <TmsField label="Billing method" error={errors.billingMethod}>
          <TmsSelect
            value={value.billingMethod}
            onChange={(e) => set('billingMethod', e.target.value as CustomerFormValue['billingMethod'])}
            options={BILLING_METHOD_OPTIONS}
            aria-label="Billing method"
          />
        </TmsField>
        {!isFactor && (
          <TmsField label="AP e-mail (invoices go here)" error={errors.apEmail}>
            <TmsInput value={value.apEmail} onChange={(e) => set('apEmail', e.target.value)} placeholder="ap@customer.com" aria-label="AP e-mail" />
          </TmsField>
        )}
      </div>
      {isFactor && (
        <div style={{ fontSize: 13 }} data-testid="factor-remit">
          Invoices go to the factor, never to the customer.{' '}
          {factor?.name ? <>Factor: <strong>{factor.name}</strong>{factor.email ? ` (${factor.email})` : ''}.</> : 'No factor is set in Settings yet.'}
        </div>
      )}
      {!isFactor && (
        <TmsField label="Copy on invoices" error={errors.invoiceCopyEmails}>
          <TmsTextarea
            value={value.invoiceCopyText}
            onChange={(e) => set('invoiceCopyText', e.target.value)}
            placeholder="One address per line. The company-wide always-copy address is added automatically."
            aria-label="Copy on invoices"
          />
        </TmsField>
      )}
    </div>
  )
}
