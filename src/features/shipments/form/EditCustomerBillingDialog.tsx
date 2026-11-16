/**
 * Edit the customer's billing settings without leaving the load (Ryne 2026-11-16: What's missing items that live on the
 * customer, a billing method or an AP e-mail, open here). Saves through the same patch the Load Review rail uses
 * (patchCustomer), so the name and every field not shown here keep what is stored.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { EmailChipsInput } from '@/features/directory/components/EmailChipsInput'
import { apEmailList, apEmailTokens } from '@/lib/apEmails'
import { patchCustomer, plainSaveError } from '@/lib/apiClient'
import type { CustomerRecord } from '@/types/tms'

type Billing = NonNullable<CustomerRecord['billingMethod']> | ''

export function EditCustomerBillingDialog({ customer, onClose, onSaved }: {
  customer: CustomerRecord
  onClose: () => void
  /** After a successful save: the page re-reads the customers and the load's REQS. */
  onSaved: () => void
}) {
  const [billing, setBilling] = useState<Billing>((customer.billingMethod ?? (customer.factored ? 'FACTOR' : '')) as Billing)
  const [emails, setEmails] = useState<string[]>(() => apEmailTokens({ apEmail: customer.apEmail, apEmailsExtra: customer.apEmailsExtra }))
  const [mc, setMc] = useState(customer.mcNumber ?? '')
  const [terms, setTerms] = useState(customer.paymentTermsDays == null ? '' : String(customer.paymentTermsDays))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await patchCustomer(customer.id, {
        billingMethod: (billing || null) as CustomerRecord['billingMethod'],
        apEmail: emails[0] ?? null,
        apEmailsExtra: emails.length > 1 ? emails.slice(1) : null,
        mcNumber: mc.trim() || null,
        paymentTermsDays: terms.trim() === '' ? null : Number(terms),
        changeReason: 'Fixed from the shipment (What\'s missing)',
        changeSource: 'SHIPMENT_EDITOR',
      } as Parameters<typeof patchCustomer>[1], customer.updatedAt ?? '')
      toast.success(`Saved ${customer.name}`)
      onSaved()
      onClose()
    } catch (err) {
      setError(plainSaveError(err, 'Could not save the customer'))
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open onOpenChange={(v) => { if (!v && !busy) onClose() }} title={`Edit ${customer.name}`}
      description="This changes the customer for all of its loads."
      footer={(
        <>
          <TmsButton variant="ghost" data-testid="edit-customer-cancel" disabled={busy} onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="edit-customer-save" disabled={busy} onClick={() => { void save() }}>{busy ? 'Saving…' : 'Save customer'}</TmsButton>
        </>
      )}
    >
      <div data-testid="edit-customer-dialog" style={{ display: 'grid', gap: 12 }}>
        <TmsField label="Billing method" htmlFor="edit-customer-billing">
          <TmsSelect
            id="edit-customer-billing" data-testid="edit-customer-billing" value={billing} disabled={busy}
            onChange={(e) => setBilling(e.target.value as Billing)}
            options={[{ value: '', label: 'Not set' }, { value: 'FACTOR', label: 'Factor (OTR)' }, { value: 'MANUAL', label: 'Manual invoice' }]}
          />
        </TmsField>
        <TmsField label="AP / invoice e-mails" hint={apEmailList({ apEmail: emails[0], apEmailsExtra: emails.slice(1) }).length === 0 ? 'Add at least one address.' : 'Every address receives the invoice.'}>
          <EmailChipsInput value={emails} label="AP e-mail" disabled={busy} placeholder="ap@customer.com — paste or type several" onChange={setEmails} />
        </TmsField>
        <div className="tms-grid tms-grid-2">
          <TmsField label="MC #" htmlFor="edit-customer-mc">
            <TmsInput id="edit-customer-mc" data-testid="edit-customer-mc" value={mc} disabled={busy} onChange={(e) => setMc(e.target.value)} />
          </TmsField>
          <TmsField label="Payment terms (days)" htmlFor="edit-customer-terms">
            <TmsInput id="edit-customer-terms" data-testid="edit-customer-terms" type="number" min={0} value={terms} disabled={busy} onChange={(e) => setTerms(e.target.value)} />
          </TmsField>
        </div>
        {error ? <p role="alert" className="tms-field-hint">{error}</p> : null}
      </div>
    </TmsDialog>
  )
}
