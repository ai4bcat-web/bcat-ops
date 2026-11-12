import { TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { parseEmailList, type BillingMethod } from '@/lib/billingMethod'
import type { RemitTo } from '@/types/tms'
import { EmailListField } from './EmailListField'
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
      </div>
      {!isFactor && (
        <TmsField
          label="AP e-mails (invoices go here)"
          hint="The first address is the main one. Every address listed here receives the invoice."
          error={errors.apEmail ?? errors.apEmailsExtra}
        >
          <EmailListField
            initial={[value.apEmail, ...parseEmailList(value.apEmailsExtraText)]}
            label="AP e-mail"
            placeholder="ap@customer.com"
            onChange={(rows) => {
              set('apEmail', rows[0] ?? '')
              set('apEmailsExtraText', rows.slice(1).join('\n'))
            }}
          />
        </TmsField>
      )}
      {isFactor && (
        <div style={{ fontSize: 13 }} data-testid="factor-remit">
          Invoices go to the factor, never to the customer.{' '}
          {factor?.name ? <>Factor: <strong>{factor.name}</strong>{factor.email ? ` (${factor.email})` : ''}.</> : 'No factor is set in Settings yet.'}
        </div>
      )}
      {(isFactor || !value.billingMethod || value.noaEmail.trim() !== '') && (
        <TmsField
          label="Notice of assignment email"
          hint="Where this customer's notice of assignment goes. Not used to send invoices."
          error={errors.noaEmail}
        >
          <TmsInput
            type="email"
            value={value.noaEmail}
            onChange={(e) => set('noaEmail', e.target.value)}
            placeholder="noa@factor.com"
            aria-label="Notice of assignment email"
            data-testid="billing-noa-email"
          />
        </TmsField>
      )}
      {!isFactor && (
        <TmsField label="Copy on invoices" error={errors.invoiceCopyEmails}>
          <EmailListField
            initial={parseEmailList(value.invoiceCopyText)}
            label="Copy on invoices"
            placeholder="copy@customer.com"
            addLabel="+ Add copy address"
            onChange={(rows) => set('invoiceCopyText', rows.join('\n'))}
          />
        </TmsField>
      )}
    </div>
  )
}
